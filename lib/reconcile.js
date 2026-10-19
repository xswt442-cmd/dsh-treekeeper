// 账本与操作系统的对账：把任务注册表的记录与已归因的实时快照放在一起，
// 报告两者的差异。任务行与进程的匹配只是指示性的（用 label 近似命令行），
// 因为任务快照不携带 pid，界面必须把这一点说出来。

import { normalizeCmdline, pluginHint, dshSignals } from './shared.js'

/**
 * @param {Array|null} jobs - listJobs() 返回的账本行（null 表示服务缺失）
 * @param {Array} procs - 操作系统快照行
 * @param {Map} attributed - attribute() 的输出
 * @returns {{ rows: Array, summary: { jobs, jobsMatched, osOnly, unattributed, unattributedTotal } }}
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

  // 只列操作系统里已确认属于本宿主的后代进程。未归属进程归入单独的排查集合；
  // 把整个 Windows 进程表都列进来，会让对账摘要读起来像一份 DSH 泄漏报告。
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

  // 未归属集合覆盖整台机器（其中数百个是 Windows 服务），所以摘要给两个数字：
  // 这些陌生进程里仍然带有 DSH 部署特征的数量，以及它出自的整集合总数。
  const unattributedProcs = procs.filter((proc) => !attributed.has(proc.pid))
  const unattributed = unattributedProcs.filter((proc) => dshSignals(proc).score > 0).length
  const runningJobs = rows.filter((r) => r.source === 'job')
  return {
    rows,
    summary: {
      jobs: runningJobs.length,
      jobsMatched: runningJobs.filter((r) => r.pids.length > 0).length,
      osOnly: rows.filter((r) => r.source.startsWith('os-')).length,
      unattributed,
      unattributedTotal: unattributedProcs.length
    }
  }
}
