// Leak heuristics over one attributed snapshot. Deliberately dumb and
// explainable: every finding carries the evidence so the UI (and the user)
// can judge before killing anything.

import { normalizeCmdline, pluginHint, PROTECTED_PROCESS_NAMES } from './shared.js'

/** System-critical names that must never appear as kill targets. */
export const PROTECTED_NAMES = PROTECTED_PROCESS_NAMES

/**
 * Heuristic 1 — duplicates: the same normalized command line alive N+ times.
 * (The Codex case: five full MCP sets from one host.) Grouping ignores pid,
 * ordering and whitespace so cmd-vs-bash invocations of the same npx chain
 * compare equal.
 */
export function findDuplicates(procs, { minCopies = 3 } = {}) {
  const groups = new Map()
  for (const p of procs) {
    if (!p.cmdline) continue
    const key = normalizeCmdline(p.cmdline)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(p)
  }
  const findings = []
  for (const [key, list] of groups) {
    if (list.length < minCopies) continue
    findings.push({
      type: 'duplicate',
      key,
      pids: list.map((p) => p.pid),
      detail: `${list.length} processes share one command line`,
      evidence: { minCopies, sample: list[0].cmdline.slice(0, 200) }
    })
  }
  findings.sort((a, b) => b.pids.length - a.pids.length)
  return findings
}

/**
 * Heuristic 2 — orphans: a process whose recorded parent pid is absent from
 * the current snapshot. Normal for short-lived parents, suspicious when the
 * survivor is a long-running worker (the leaked-MCP shape after its npx
 * chain died).
 */
export function findOrphans(procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const findings = []
  for (const p of procs) {
    if (!p.ppid) continue
    if (byPid.has(p.ppid)) continue
    findings.push({
      type: 'orphan',
      key: `pid:${p.pid}`,
      pids: [p.pid],
      detail: `parent ${p.ppid} is gone but ${p.name || 'process'} ${p.pid} is alive`,
      evidence: { parentPid: p.ppid, name: p.name }
    })
  }
  return findings
}

/**
 * Heuristic 3 — long-lived plugin children: processes attributed (via the
 * cmdline hint) to a plugin package that have been alive longer than the
 * threshold. Persistent MCP servers are normal; the point is to make them
 * *visible and countable*, not to call them broken.
 */
export function findLongLived(procs, { olderThanMs = 30 * 60 * 1000 } = {}) {
  const now = Date.now()
  const findings = []
  for (const p of procs) {
    if (!p.createdMs) continue
    const hint = pluginHint(p.cmdline)
    if (!hint) continue
    const age = now - p.createdMs
    if (age < olderThanMs) continue
    findings.push({
      type: 'longlived',
      key: `pid:${p.pid}`,
      pids: [p.pid],
      detail: `${hint.plugin} child alive for ${Math.round(age / 60000)} min`,
      evidence: { plugin: hint.plugin, ageMs: age, viaNpx: hint.viaNpx }
    })
  }
  findings.sort((a, b) => b.evidence.ageMs - a.evidence.ageMs)
  return findings
}

/**
 * Run all heuristics over one snapshot. `attribution` is the output of
 * attribute(); protected processes are never reported as kill candidates.
 */
export function collectFindings(procs, attribution, opts = {}) {
  // A process outside the current DSH host's descendant tree is evidence for
  // the investigation bucket, not evidence that DSH leaked it. Running
  // duplicate/orphan rules across the full machine turns routine Windows
  // services into hundreds of false alarms.
  const attributable = procs.filter((proc) => attribution.attributed.has(proc.pid))
  const killable = attributable.filter((p) => !PROTECTED_NAMES.has(String(p.name || '').toLowerCase()))
  const findings = [
    ...findDuplicates(killable, opts),
    ...findOrphans(killable),
    ...findLongLived(killable, opts)
  ]
  for (const f of findings) {
    const first = attribution.byPid.get(f.pids[0])
    f.attribution = first ? attribution.attributed.get(first.pid) || null : null
  }
  return findings
}
