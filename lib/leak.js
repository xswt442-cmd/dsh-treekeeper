// 在已归因的快照上运行的泄漏启发式规则。规则保持简单且可解释：每条发现都
// 带上证据，界面与用户可以先判断，再决定是否终止进程。

import {
  normalizeCmdline, pluginHint, PROTECTED_PROCESS_NAMES, FINDING_RULE_DESCRIPTION,
  hasPreviousHostSignal, dshSignals
} from './shared.js'

/** 终止后可能导致 Windows 不可用的进程名，永远不作为终止目标。 */
export const PROTECTED_NAMES = PROTECTED_PROCESS_NAMES

/**
 * 一条发现的出处：由哪条检查产生，规则 id 加一句给人看的说明。每个查找函数
 * 都会写上这个字段，因此单独调用规则时该字段也存在，不只经由
 * collectFindings() 才出现。
 */
export function findingProvenance(rule) {
  return { rule, description: FINDING_RULE_DESCRIPTION[rule] ?? null }
}

/**
 * 一条结论的证据等级。判断依据是归因而不是规则：与宿主树有真实链条的进程
 * 可信度高；没有链条的只是推断；降级采样（缺父进程链）会把已归因的行降为
 * 指示性。
 */
export function findingConfidence({ attributed = false, degraded = null } = {}) {
  if (!attributed) return 'inferred'
  return degraded ? 'indicative' : 'exact'
}

/**
 * 一条发现的归因链：进程声称属于谁（scope），以及这个结论怎么得来的（via）。
 * `session` / `job` 来自账本对账，在 applyLedgerOwnership() 填入之前为 null。
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
 * 给 collectFindings() 已写好的发现补上账本链接：pid 匹配到运行中的任务时，
 * 该发现属于这个任务；任务带 ownerSession 时也属于那个会话。重复调用结果
 * 相同：ownership 每次从保存的归因重新构建，上一份快照的旧行不会残留。
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
 * 规则一 —— 重复副本：同一条规范化命令行同时存活 N 份以上。分组忽略 pid、
 * 顺序与空白，所以同一条 npx 链由 cmd 或 bash 启动都算同一组。
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
 * 规则二 —— 孤儿：记录里的父 pid 已不在当前快照中。父进程短命是正常现象；
 * 存活很久的工作进程才可疑（npx 链结束后仍在运行的 MCP 进程就是这种形状）。
 *
 * `livePids` 是整份快照的 pid 集合，不是候选列表的集合。这里的候选已经收窄
 * 为已归因的宿主后代，若拿同一份收窄列表判断父进程，会把父进程只是位于树外
 * 的进程（例如仍存活的 Electron 主进程、未归因的启动器）全部报成孤儿，而且
 * 排在最前面。
 */
export function findOrphans(procs, livePids = null) {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const alive = livePids instanceof Set ? livePids : byPid
  const findings = []
  for (const p of procs) {
    if (!p.ppid) continue
    if (alive.has(p.ppid)) continue
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
 * 规则二之二 —— 上一个宿主的幸存进程。归因只从活着的根向下走，被直接结束的
 * 宿主会留下未归因的子进程，缺少这条规则时它们与机器上其他陌生进程无法区分。
 * 因此本规则只检查未归因集合，要求父进程不在整份快照中，并要求镜像名或命令行
 * 带有 DSH 部署路径。证据是真的，但与当前宿主没有链条，所以调用方把它标为
 * `indicative`，它永远不会成为终止候选。
 */
export function findPreviousHostOrphans(procs, livePids = null) {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const alive = livePids instanceof Set ? livePids : byPid
  const findings = []
  for (const p of procs) {
    if (!p.ppid) continue
    if (alive.has(p.ppid)) continue
    if (!hasPreviousHostSignal(p)) continue
    findings.push({
      type: 'orphan',
      rule: 'orphan.previous-host',
      provenance: findingProvenance('orphan.previous-host'),
      key: `pid:${p.pid}`,
      pids: [p.pid],
      detail: `parent ${p.ppid} is gone and ${p.name || 'process'} ${p.pid} still carries a DSH path`,
      evidence: { parentPid: p.ppid, name: p.name, signals: dshSignals(p).signals }
    })
  }
  return findings
}

/**
 * 规则三 —— 长时间存活的插件子进程：通过命令行提示归因到某个插件包、存活时间
 * 超过阈值的进程。常驻的 MCP 服务是正常状态；这条规则的作用是让它们可见、
 * 可计数，而不是判定它们出了问题。
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
 * 在一份快照上运行全部规则。`attribution` 是 attribute() 的输出；受保护的进程
 * 不会被报成终止候选。
 */
export function collectFindings(procs, attribution, opts = {}) {
  const { degraded = null } = opts
  // 当前 DSH 宿主后代树之外的进程只能作为排查线索，不能当作 DSH 泄漏的证据。
  // 在整台机器上跑重复与孤儿规则，会把日常的 Windows 服务变成成百上千条误报。
  const attributable = procs.filter((proc) => attribution.attributed.has(proc.pid))
  const killable = attributable.filter((p) => !PROTECTED_NAMES.has(String(p.name || '').toLowerCase()))
  const strangers = procs.filter((proc) => !attribution.attributed.has(proc.pid))
  // 父进程是否存活是整台机器的事实，与候选列表的范围无关。
  const livePids = new Set(procs.map((p) => p.pid))
  const findings = [
    ...findDuplicates(killable, opts),
    ...findOrphans(killable, livePids),
    ...findLongLived(killable, opts),
    // 唯一允许查看未归因集合的规则，而且只看被结束的宿主留下的 DSH 路径形状。
    ...findPreviousHostOrphans(strangers, livePids)
  ]
  for (const f of findings) {
    const first = attribution.byPid.get(f.pids[0])
    const info = first ? attribution.attributed.get(first.pid) || null : null
    f.attribution = info
    // 结论作为数据输出：evidence 保留规则各自的载荷（界面读 evidence.sample），
    // confidence 与 ownership 紧挨着它，描述证据等级和归属链。
    // 上一个宿主的幸存进程是例外：它有真实证据却完全没有链条，归因推不出等级，
    // 由规则自己声明为 indicative，低于活链条能得到的 exact。
    f.confidence = f.rule === 'orphan.previous-host'
      ? 'indicative'
      : findingConfidence({ attributed: !!info, degraded })
    f.ownership = findingOwnership({ info })
  }
  return findings
}
