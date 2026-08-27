// Guarded tree kill. Three gates, in order:
//   1. identity  — re-query the pid's creation time; a mismatch means the OS
//                  reused the pid since our snapshot and we MUST NOT pull the
//                  trigger (SubprocessHandle's own docs warn about reuse).
//   2. policy    — protected system names, the harness's own pid tree, the
//                  launcher chain, and user whitelisted pids are refused.
//   3. consent   — the client already double-confirms; the host logs the act.
// Only then: `taskkill /PID <pid> /T /F`, followed by a liveness recheck.

import { execFile } from 'node:child_process'

const PROTECTED_NAMES = new Set(['system', 'idle', 'wininit', 'winlogon', 'csrss', 'smss', 'services', 'lsass'])

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
    const { parseCimDate } = await import('./shared.js')
    return { alive: true, createdMs: parseCimDate(row.CreationDate), name: row.Name || null }
  } catch {
    return { alive: true, createdMs: null, name: null }
  }
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
  const { pid, seenCreatedMs = null, whitelistPids = new Set(), config = {} } = opts
  if (process.platform !== 'win32') return { ok: false, code: 'unsupported_platform' }
  if (config.allowKill === false) return { ok: false, code: 'disabled' }
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, code: 'bad_pid' }
  if (pid === process.pid) return { ok: false, code: 'self' }
  const wl = whitelistPids instanceof Set ? whitelistPids : new Set(whitelistPids)
  if (wl.has(pid)) return { ok: false, code: 'whitelisted' }

  // Gate 1: identity precheck (pid reuse guard).
  const facts = await pidFacts(pid)
  if (!facts.alive) return { ok: true, code: 'already_gone' }
  if (seenCreatedMs && facts.createdMs && Math.abs(facts.createdMs - seenCreatedMs) > 750) {
    return { ok: false, code: 'pid_reused', detail: `creation time drifted: seen ${seenCreatedMs}, now ${facts.createdMs}` }
  }
  // Gate 2: policy.
  const baseName = String(facts.name || '').replace(/\.exe$/i, '').toLowerCase()
  if (PROTECTED_NAMES.has(baseName)) return { ok: false, code: 'protected', detail: baseName }

  // Gate 3 passed at the client; execute the tree kill.
  const { err, stderr } = await run('taskkill', ['/PID', String(pid), '/T', '/F'])
  if (err && !/not found/i.test(stderr || '')) {
    return { ok: false, code: 'taskkill_failed', detail: String((stderr || err.message || '')).slice(0, 300) }
  }
  // Verify.
  await new Promise((r) => setTimeout(r, 700))
  const after = await pidFacts(pid)
  if (after.alive && after.createdMs === facts.createdMs) {
    return { ok: false, code: 'still_alive', detail: 'process survived taskkill /T /F' }
  }
  return { ok: true, code: after.alive ? 'gone_reused' : 'killed' }
}
