// Leak heuristics over one attributed snapshot. Deliberately dumb and
// explainable: every finding carries the evidence so the UI (and the user)
// can judge before killing anything.

import { normalizeCmdline, pluginHint, PROTECTED_PROCESS_NAMES, FINDING_RULE_DESCRIPTION } from './shared.js'

/** System-critical names that must never appear as kill targets. */
export const PROTECTED_NAMES = PROTECTED_PROCESS_NAMES

/**
 * Provenance of one finding: which check produced it, as rule id plus a
 * human-readable sentence. Stamped by every finder so the field exists even
 * when a rule is called on its own, not only through collectFindings().
 */
export function findingProvenance(rule) {
  return { rule, description: FINDING_RULE_DESCRIPTION[rule] ?? null }
}

/**
 * Evidence level of one conclusion. Attribution is what makes a finding
 * actionable, so it — not the rule — decides the level: a process with no
 * host-tree link is inference, and a degraded sample (no parent chain)
 * softens even a correctly attributed row.
 */
export function findingConfidence({ attributed = false, degraded = null } = {}) {
  if (!attributed) return 'inferred'
  return degraded ? 'indicative' : 'exact'
}

/**
 * Attribution chain of one finding: who the process claims to belong to
 * (scope) and how that claim was derived (via). `session` / `job` come from
 * the ledger join and are null until applyLedgerOwnership() fills them.
 */
export function findingOwnership({ info = null, session = null, job = null } = {}) {
  const ownership = {
    scope: info ? 'host-descendant' : 'unattributed',
    via: info ? (Number(info.depth) > 0 ? 'ppid-chain' : 'root-itself') : 'none',
    rootLabel: info ? (info.rootLabel ?? null) : null,
    depth: info ? (info.depth ?? null) : null,
    session: null,
    job: null
  }
  if (job) {
    ownership.scope = 'job'
    ownership.via = 'job-label'
    ownership.job = job
  }
  if (session) {
    ownership.scope = 'session'
    ownership.session = session
  }
  return ownership
}

/**
 * Add the ledger link to findings already stamped by collectFindings(): a pid
 * matched to a running job belongs to that job, and to its owner session when
 * the registry reports one. Idempotent — ownership is rebuilt from the stored
 * attribution, so stale rows from an earlier snapshot cannot stick.
 */
export function applyLedgerOwnership(findings, rows) {
  const owners = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.source !== 'job' || !Array.isArray(row.pids)) continue
    for (const pid of row.pids) {
      if (owners.has(pid)) continue
      owners.set(pid, { session: row.ownerSession ?? null, job: row.id ?? null })
    }
  }
  for (const finding of findings) {
    const owner = finding.pids.map((pid) => owners.get(pid)).find(Boolean) || null
    finding.ownership = findingOwnership({
      info: finding.attribution || null,
      session: owner && owner.session,
      job: owner && owner.job
    })
  }
  return findings
}

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
      rule: 'duplicate.cmdline',
      provenance: findingProvenance('duplicate.cmdline'),
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
      rule: 'orphan.dead-parent',
      provenance: findingProvenance('orphan.dead-parent'),
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
      rule: 'longlived.plugin-child',
      provenance: findingProvenance('longlived.plugin-child'),
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
  const { degraded = null } = opts
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
    const info = first ? attribution.attributed.get(first.pid) || null : null
    f.attribution = info
    // DTK-M1: the verdict is data. `evidence` keeps its rule-specific payload
    // (the UI reads `evidence.sample`); the enumerated level and chain that
    // M2/M3 will filter on live beside it.
    f.confidence = findingConfidence({ attributed: !!info, degraded })
    f.ownership = findingOwnership({ info })
  }
  return findings
}
