// Guarded tree kill. Three gates, in order:
//   1. identity  — re-query the pid's creation time; a mismatch means the OS
//                  reused the pid since our snapshot and we MUST NOT pull the
//                  trigger (SubprocessHandle's own docs warn about reuse).
//   2. policy    — protected system names, the harness's own pid tree, the
//                  launcher chain, and user whitelisted pids are refused.
//   3. consent   — the client already double-confirms; the host logs the act.
// Only then: `taskkill /PID <pid> /T /F`, followed by a liveness recheck.

import { execFile } from 'node:child_process'
import { hasVerifiedCreationTime, parseCimDate, PROTECTED_PROCESS_NAMES } from './shared.js'
import { subtreeOf } from './attribute.js'

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr })
    })
  })
}

/** One live fact for a pid: does it exist, and when was it created? */
async function pidFacts(pid) {
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object CreationDate,Name | ConvertTo-Json -Compress)`
  const { err, stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script])
  if (err) return { alive: false, createdMs: null, name: null, error: String(err.message || err) }
  const text = (stdout || '').trim()
  if (!text) return { alive: false, createdMs: null, name: null }
  try {
    const row = JSON.parse(text)
    return { alive: true, createdMs: parseCimDate(row.CreationDate), name: row.Name || null }
  } catch {
    return { alive: true, createdMs: null, name: null }
  }
}

/** Pure policy gate used before the OS query and covered without killing. */
export function validateKillTarget({ pid, seenCreatedMs, facts, whitelistPids = new Set(), selfPid = process.pid, allowKill = true }) {
  if (!allowKill) return { ok: false, code: 'disabled' }
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, code: 'bad_pid' }
  if (pid === selfPid) return { ok: false, code: 'self' }
  const whitelist = whitelistPids instanceof Set ? whitelistPids : new Set(whitelistPids)
  if (whitelist.has(pid)) return { ok: false, code: 'whitelisted' }
  if (!Number.isFinite(seenCreatedMs)) return { ok: false, code: 'missing_creation_time' }
  if (!facts.alive) return { ok: true, code: 'already_gone' }
  if (!hasVerifiedCreationTime(seenCreatedMs, facts.createdMs)) return { ok: false, code: 'pid_identity_unverified' }

  const baseName = String(facts.name || '').replace(/\.exe$/i, '').toLowerCase()
  if (PROTECTED_PROCESS_NAMES.has(baseName)) return { ok: false, code: 'protected', detail: baseName }
  return { ok: true, code: 'verified' }
}

/**
 * Ownership gate for a kill target: the pid must be attributed to the DSH
 * host tree itself. A process outside that tree — the `unknown` bucket the UI
 * shows read-only — must never reach taskkill, otherwise TreeKeeper could
 * terminate unrelated applications.
 *
 * Whitelisted pids are attribution roots for *investigation* only. Authorizing
 * their descendants would invert the setting: protecting a pid would widen
 * the kill scope instead of narrowing it, and `taskkill /T` cannot exclude
 * them on the way down. So authorization keys off `rootLabel === 'harness'`,
 * which is what the "only the DSH host tree" guarantee actually means.
 *
 * Pure: no OS access, easy to unit test. `attribution` is the serialized
 * `lastSnapshot.attribution` object (pid -> info).
 */
export function validateKillOwnership(attribution, pid) {
  const entry = attribution && typeof attribution === 'object' ? attribution[pid] : null
  if (!entry) return { ok: false, code: 'unattributed' }
  if (entry.rootLabel !== 'harness') return { ok: false, code: 'non_harness_root' }
  return { ok: true, code: 'attributed' }
}

/**
 * Read the post-kill probe. Pure and exported so the decision is covered without
 * a Windows process to terminate: the call site inside `killTree` is
 * platform-gated, the decision is not.
 *
 * `after.createdMs` is null when the pid exists but its creation time could not
 * be read (`pidFacts` falls back to null when the CIM JSON does not parse). An
 * unreadable time is not evidence of a different process, so it counts as a
 * survivor — treating it as reuse would report a failed kill as success.
 *
 * @param {number|null} beforeCreatedMs - creation time read during the identity precheck.
 * @param {{alive:boolean, createdMs:number|null}} after - probe taken after taskkill.
 * @returns {{ok:boolean, code:string, detail?:string}}
 */
export function classifyKillOutcome(beforeCreatedMs, after) {
  if (!after.alive) return { ok: true, code: 'killed' }
  // Alive and provably a different process: the original is gone and the pid was
  // reused before the probe. That is a successful kill.
  if (after.createdMs !== null && after.createdMs !== beforeCreatedMs) {
    return { ok: true, code: 'gone_reused' }
  }
  return { ok: false, code: 'still_alive', detail: 'process survived taskkill /T /F' }
}

/**
 * Gate 1 of the kill route: may this request proceed at all, given the snapshot
 * the client was looking at? Pure and exported so every refusal path is covered
 * on any platform — `lib/index.js` keeps only the job of gathering the facts.
 *
 * Three ways to be refused, all meaning "refresh first": no usable snapshot, one
 * older than the freshness window, or a pid whose creation time does not match
 * what the client claims. Past that, ownership decides whether the target is
 * even eligible.
 *
 * @param {object} facts
 * @param {number} facts.pid
 * @param {number} facts.seenCreatedMs
 * @param {{procs:Array, degraded:boolean}|null} facts.snapshot
 * @param {number} facts.takenAt - snapshot timestamp, 0 when there is none.
 * @param {number} facts.now
 * @param {number} facts.maxAgeMs
 * @param {object|null} facts.attribution - pid -> { rootLabel }, from the same snapshot.
 * @returns {{ok:boolean, code:string}}
 */
export function decideKillEntry({ pid, seenCreatedMs, snapshot, takenAt, now, maxAgeMs, attribution }) {
  const usable = Boolean(snapshot) && !snapshot.degraded && now - takenAt <= maxAgeMs
  const sampled = usable ? snapshot.procs.find((proc) => proc.pid === pid) : null
  if (!sampled || !Number.isFinite(seenCreatedMs) || sampled.createdMs !== seenCreatedMs) {
    return { ok: false, code: 'snapshot_required' }
  }
  const ownership = validateKillOwnership(attribution, pid)
  if (!ownership.ok) return { ok: false, code: ownership.code }
  return { ok: true }
}

/**
 * Gate 3 of the kill route: the target must still be the same process in a
 * snapshot taken immediately before the pull. A stale or degraded sample cannot
 * prove that, so it refuses rather than assume.
 *
 * @param {object} facts
 * @param {number} facts.pid
 * @param {number} facts.seenCreatedMs
 * @param {{procs:Array, degraded:boolean}|null} facts.fresh
 * @returns {{ok:boolean, code:string}}
 */
export function decideKillConfirm({ pid, seenCreatedMs, fresh }) {
  const proc = fresh && !fresh.degraded ? fresh.procs.find((p) => p.pid === pid) : null
  if (!proc || proc.createdMs !== seenCreatedMs) return { ok: false, code: 'snapshot_required' }
  return { ok: true }
}

/**
 * Kill a process tree behind the guards.
 * @param {object} opts
 * @param {number} opts.pid - tree root to kill.
 * @param {number|null} [opts.seenCreatedMs] - creation time recorded by the last snapshot.
 * @param {Set<number>|number[]} [opts.whitelistPids] - never-kill pids (self tree, launch chain, user pins).
 * @param {object} [opts.config] - { allowKill?: boolean }
 * @returns {Promise<{ok:boolean, code:string, detail?:string}>}
 */
export async function killTree(opts) {
  const { pid, seenCreatedMs = null, whitelistPids = new Set(), config = {}, procs = [] } = opts

  // Gate 2 (tree): `taskkill /T` kills the entire descendant tree
  // unconditionally. If any protected pid (harness, launcher chain, user pin)
  // sits anywhere in that tree, killing the root would also terminate the
  // protected process and break the whitelist guarantee — even when the root
  // itself passed policy. Enumerate the live snapshot tree before touching
  // anything; this is a pure snapshot check, so it runs on every platform.
  const protectedSet = whitelistPids instanceof Set ? whitelistPids : new Set(whitelistPids)
  if (Array.isArray(procs) && procs.length) {
    const protectedHit = subtreeOf(procs, pid).find((node) => node.pid !== pid && protectedSet.has(node.pid))
    if (protectedHit) return { ok: false, code: 'protected_descendant', detail: String(protectedHit.pid) }
  }

  if (process.platform !== 'win32') return { ok: false, code: 'unsupported_platform' }
  // Gate 1: identity precheck (pid reuse guard).
  const facts = await pidFacts(pid)
  const validation = validateKillTarget({
    pid,
    seenCreatedMs,
    facts,
    whitelistPids,
    allowKill: config.allowKill !== false
  })
  if (!validation.ok || validation.code === 'already_gone') return validation

  // The client has already completed the human confirmation; execute only
  // after identity and protected-process policy have passed here.
  const { err, stderr } = await run('taskkill', ['/PID', String(pid), '/T', '/F'])
  if (err && !/not found/i.test(stderr || '')) {
    return { ok: false, code: 'taskkill_failed', detail: String((stderr || err.message || '')).slice(0, 300) }
  }
  // Verify. The decision lives in classifyKillOutcome so it stays covered
  // without a live Windows process to terminate.
  await new Promise((r) => setTimeout(r, 700))
  return classifyKillOutcome(facts.createdMs, await pidFacts(pid))
}
