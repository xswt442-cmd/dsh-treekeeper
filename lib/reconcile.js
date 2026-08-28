// Ledger × OS reconciliation: join JobRegistry/subagent facts with the live
// attributed snapshot and report the drift. The join on jobs is INDICATIVE
// (label ≈ cmdline) because JobSnapshot carries no pid — the UI must say so.

import { normalizeCmdline, pluginHint } from './shared.js'

/**
 * @param {Array|null} jobs - ledger rows from listJobs() (null = seam absent)
 * @param {Array} procs - OS snapshot rows
 * @param {Map} attributed - attribute() output
 * @returns {{ rows: Array, summary: { jobs, jobsMatched, osOnly, unattributed } }}
 */
export function reconcile(jobs, procs, attributed) {
  const rows = []
  const matchedPids = new Set()

  if (Array.isArray(jobs)) {
    for (const job of jobs) {
      if (job.status !== 'running' && job.status !== 'stopping') continue
      const needle = normalizeCmdline(job.label)
      const pids = []
      if (needle) {
        for (const p of procs) {
          if (matchedPids.has(p.pid)) continue
          const hay = normalizeCmdline(p.cmdline)
          if (hay && (hay.includes(needle) || needle.includes(hay))) {
            pids.push(p.pid)
            matchedPids.add(p.pid)
          }
        }
      }
      rows.push({
        source: 'job',
        id: job.id,
        label: job.label,
        ownerSession: job.ownerSession ?? null,
        status: job.status,
        startedAt: job.startedAt ?? null,
        pids,
        indicative: true
      })
    }
  }

  // OS-only rows are only known descendants of this DSH host. Unattributed
  // rows belong to the separate investigation bucket; listing all of Windows
  // here makes the reconciliation summary look like a DSH leak report.
  for (const p of procs) {
    if (matchedPids.has(p.pid)) continue
    const attr = attributed.get(p.pid)
    if (!attr) continue
    const hint = pluginHint(p.cmdline)
    rows.push({
      source: 'os-attributed',
      id: `pid:${p.pid}`,
      label: p.cmdline ? p.cmdline.slice(0, 160) : (p.name || `pid ${p.pid}`),
      ownerSession: null,
      status: 'running',
      startedAt: p.createdMs,
      pids: [p.pid],
      indicative: false,
      rootLabel: attr.rootLabel,
      depth: attr.depth,
      pluginHint: hint
    })
  }

  const unattributed = procs.filter((proc) => !attributed.has(proc.pid)).length
  const runningJobs = rows.filter((r) => r.source === 'job')
  return {
    rows,
    summary: {
      jobs: runningJobs.length,
      jobsMatched: runningJobs.filter((r) => r.pids.length > 0).length,
      osOnly: rows.filter((r) => r.source.startsWith('os-')).length,
      unattributed
    }
  }
}
