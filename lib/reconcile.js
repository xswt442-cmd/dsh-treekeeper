// 账本与操作系统的对账：把任务注册表的记录与已归因的实时快照放在一起，
// 报告两者的差异。任务行与进程的匹配默认是指示性的（用 label 近似命令行），
// 因为任务快照不携带 pid，界面必须把这一点说出来。
//
// 唯一的例外是终端会话：宿主愿意把 PTY 的顶层 pid 交给插件，因此命中那个 pid
// 的行是精确的，不再标 `indicative`。本宿主不提供终端会话清单时，这条路径不
// 出现，形态与之前完全一致。

import { normalizeCmdline, pluginHint, dshSignals } from './shared.js'

/**
 * @param {Array|null} jobs - listJobs() 返回的账本行（null 表示服务缺失）
 * @param {Array} procs - 操作系统快照行
 * @param {Map} attributed - attribute() 的输出
 * @param {{ptyPids?: Set<number>|null}} [opts] - ptyRoots() 的 pid 集合；null 表示本宿主不提供
 * @returns {{ rows: Array, summary: { jobs, jobsMatched, osOnly, unattributed, unattributedTotal, ptySessions } }}
 */
export function reconcile(jobs, procs, attributed, { ptyPids = null } = {}) {
  const rows = []
  const matchedPids = new Set()
  const exact = ptyPids instanceof Set ? ptyPids : null

  if (Array.isArray(jobs)) {
    for (const job of jobs) {
      if (job.status !== 'running' && job.status !== 'stopping') continue
      const needle = normalizeCmdline(job.label)
      const pids = []
      // 精确命中的 pid：label 匹配之外的第二条证据，且更强。任务行与进程之间
      // 没有稳定映射，但终端会话的顶层 pid 是宿主自己报告的。
      let exactPid = null
      if (needle) {
        for (const p of procs) {
          if (matchedPids.has(p.pid)) continue
          const hay = normalizeCmdline(p.cmdline)
          if (hay && (hay.includes(needle) || needle.includes(hay))) {
            pids.push(p.pid)
            matchedPids.add(p.pid)
            if (exact !== null && exact.has(p.pid)) exactPid = p.pid
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
        // 没有精确 pid 就仍是指示性的：label 匹配是文本近似，不是身份。
        indicative: exactPid === null,
        via: exactPid === null ? 'job-label' : 'pty-pid',
        ...(exactPid === null ? {} : { ptyPid: exactPid })
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
      unattributedTotal: unattributedProcs.length,
      // 精确 join 命中的任务行数；本宿主不提供终端会话清单时恒为 0，界面因此
      // 不必分辨「没有精确命中」与「没有这项能力」。
      jobsExact: runningJobs.filter((r) => r.via === 'pty-pid').length,
      // 归因到 pty 根的进程数：终端会话合法拥有的那一批。
      ptyProcesses: rows.filter((r) => r.rootLabel === 'pty').length
    }
  }
}
