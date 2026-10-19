// 受守卫的树杀。检查顺序：
//   1. 受保护后代 —— 快照里整棵树都不能包含受保护的 pid，否则 /T 会连带结束它。
//   2. 平台与身份 —— 只在 Windows 上执行；重新查询 pid 的创建时间，与快照记录
//      不一致说明系统已经复用了这个 pid，此时绝不执行终止。
//   3. 策略 —— 受保护的系统进程名、宿主自身、启动链和用户登记的 pid 一律拒绝。
// 全部通过后才执行 `taskkill /PID <pid> /T /F`，随后复查进程是否仍然存活。
// 人的确认由客户端完成；宿主把这次操作写入历史记录。

import { execFile } from 'node:child_process'
import { hasVerifiedCreationTime, parseCimDate, PROTECTED_PROCESS_NAMES } from './shared.js'
import { subtreeOf } from './attribute.js'

/** 进程边界本身：一个隐藏的子进程，受超时限制。 */
const defaultExec = (cmd, args, options) => new Promise((resolve) => {
  execFile(cmd, args, options, (err, stdout, stderr) => {
    resolve({ err, stdout, stderr })
  })
})

/**
 * 本模块的操作系统接缝。它们让终止策略在没有真实进程可结束时也能被断言：
 * 测试注入 `exec` 来记录 argv 与执行选项，注入 `platform` 站到 Windows 门的两
 * 侧，注入 `sleep` 让终止后的复查不必真的等待。默认值就是未注入时的真实行为；
 * 这些接缝不会扩大可终止的范围。
 */
const DEFAULT_DEPS = {
  exec: defaultExec,
  platform: () => process.platform,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

const resolveDeps = (deps = {}) => ({ ...DEFAULT_DEPS, ...deps })

/**
 * 本模块启动的每个子进程都带 `windowsHide`，因为受守卫的终止不该在用户桌面上
 * 闪出控制台窗口；同时带超时，卡住的 PowerShell 不能一直占着请求。两项设置都
 * 可以通过 `exec` 接缝断言。
 */
function run(deps, cmd, args, timeoutMs = 8000) {
  return deps.exec(cmd, args, { windowsHide: true, timeout: timeoutMs })
}

/**
 * taskkill 的确切 argv 只在这里写一次，测试可以断言这个形状：`/T` 会取整棵
 * 子树，因此受保护后代检查必须先跑；`/F` 强制结束。走不到这里调用的 pid，
 * 也绝不会到达操作系统。
 */
export const TASKKILL_ARGS = (pid) => ['/PID', String(pid), '/T', '/F']

/** 一个 pid 的现场事实：是否存活，创建时间是什么。 */
async function pidFacts(pid, deps = DEFAULT_DEPS) {
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object CreationDate,Name | ConvertTo-Json -Compress)`
  const { err, stdout } = await run(deps, 'powershell.exe', ['-NoProfile', '-Command', script])
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

/** 发起操作系统查询之前使用的纯策略检查；无需结束进程即可覆盖。 */
export function validateKillTarget({ pid, seenCreatedMs, facts, whitelistPids = new Set(), selfPid = process.pid, allowKill = true }) {
  if (!allowKill) return { ok: false, code: 'disabled' }
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, code: 'bad_pid' }
  if (pid === selfPid) return { ok: false, code: 'self' }
  const whitelist = whitelistPids instanceof Set ? whitelistPids : new Set(whitelistPids)
  if (whitelist.has(pid)) return { ok: false, code: 'whitelisted' }
  if (!Number.isFinite(seenCreatedMs)) return { ok: false, code: 'missing_creation_time' }
  // 查询失败不能证明任何事：这里的 `alive: false` 可能是进程已消失，也可能是
  // PowerShell 没跑起来。只有干净的“查无此进程”才算已经结束；查询本身出错时
  // 必须拒绝，否则一个仍在运行的目标碰上偶发故障，会被报成成功的空操作。
  if (facts.error) return { ok: false, code: 'verify_failed', detail: facts.error }
  if (!facts.alive) return { ok: true, code: 'already_gone' }
  if (!hasVerifiedCreationTime(seenCreatedMs, facts.createdMs)) return { ok: false, code: 'pid_identity_unverified' }

  const baseName = String(facts.name || '').replace(/\.exe$/i, '').toLowerCase()
  if (PROTECTED_PROCESS_NAMES.has(baseName)) return { ok: false, code: 'protected', detail: baseName }
  return { ok: true, code: 'verified' }
}

/**
 * 终止目标的归属检查：pid 必须归因到 DSH 宿主树本身。宿主树之外的进程属于
 * 界面只读展示的 `unknown` 集合，绝不能进入 taskkill，否则 TreeKeeper 会结束
 * 与本次工作无关的应用。
 *
 * 用户登记的 pid 只是排查用的归因根。授权它们的后代等于把设置反过来用：
 * 保护一个 pid 会扩大可终止范围，而 `taskkill /T` 无法在向下遍历时排除它们。
 * 因此授权只看 `rootLabel === 'harness'`，这也是“只动 DSH 宿主树”的实际含义。
 *
 * 终端会话的 pty 根（`rootLabel === 'pty'`）同样不可终止，而且值得单独一条：
 * 终端里跑着的 dev server 与 watcher 正被一个活着的 PTY 合法拥有，把它们当成
 * 宿主树的残留去结束，等于结束用户正在用的东西。终端归属树里的每一行都因此
 * 不可终止——它整棵子树都由那个 pty 拥有。
 *
 * 纯函数，不访问操作系统，单元测试可以直接断言。`attribution` 是序列化后的
 * `lastSnapshot.attribution`（pid -> 归因信息）。
 */
export function validateKillOwnership(attribution, pid) {
  const entry = attribution && typeof attribution === 'object' ? attribution[pid] : null
  if (!entry) return { ok: false, code: 'unattributed' }
  // pty 单独一条而不是并进 non_harness_root：它是「有人合法拥有它」，与「它不属于
  // 本宿主」是两回事，将来放宽归因判据时也不该顺带把它放开。
  if (entry.rootLabel === 'pty') return { ok: false, code: 'pty_owned' }
  if (entry.rootLabel !== 'harness') return { ok: false, code: 'non_harness_root' }
  return { ok: true, code: 'attributed' }
}

/**
 * 读取终止后的探测结果。函数是纯的并对外导出，因此不需要真实的 Windows 进程
 * 就能覆盖判定：`killTree` 里的调用点受平台限制，判定本身不受限。
 *
 * `after.createdMs` 为 null 表示 pid 存在但读不到创建时间（CIM 的 JSON 解析
 * 失败时 `pidFacts` 回退为 null）。读不到时间不能证明换了进程，因此按存活处理；
 * 当成 pid 复用会把失败的终止报成成功。
 *
 * @param {number|null} beforeCreatedMs - 身份预检时读到的创建时间。
 * @param {{alive:boolean, createdMs:number|null, error?:string}} after - taskkill 之后取得的探测结果。
 * @returns {{ok:boolean, code:string, detail?:string}}
 */
export function classifyKillOutcome(beforeCreatedMs, after) {
  // 出错的探测无法证明 pid 的任何状态。当成已结束会报告一次可能没有发生的
  // 终止——taskkill 已经执行过，所以这里工具故障必须读作失败。
  if (after.error) return { ok: false, code: 'verify_failed', detail: after.error }
  if (!after.alive) return { ok: true, code: 'killed' }
  // 存活但可以证明是另一个进程：原进程已经结束，pid 在探测前被复用，这是一次
  // 成功的终止。
  if (after.createdMs !== null && after.createdMs !== beforeCreatedMs) {
    return { ok: true, code: 'gone_reused' }
  }
  return { ok: false, code: 'still_alive', detail: 'process survived taskkill /T /F' }
}

/**
 * 终止路由的第一道判定：以客户端看到的快照为准，这个请求能否继续？函数是纯的
 * 并对外导出，因此每种拒绝路径在任何平台上都能被覆盖；`lib/index.js` 只负责
 * 收集事实。
 *
 * 三种情况都表示“先刷新”：没有可用快照、快照超出新鲜度窗口、pid 的创建时间与
 * 客户端声明的不一致。通过之后再由归属决定目标是否够格。
 *
 * @param {object} facts
 * @param {number} facts.pid
 * @param {number} facts.seenCreatedMs
 * @param {{procs:Array, degraded:boolean}|null} facts.snapshot
 * @param {number} facts.takenAt - 快照时间；没有快照时为 0。
 * @param {number} facts.now
 * @param {number} facts.maxAgeMs
 * @param {object|null} facts.attribution - pid -> { rootLabel }，来自同一份快照。
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
 * 终止前的最后一道判定：在即将执行前取的快照里，目标必须仍是同一个进程。
 * 过期或降级的采样无法证明这一点，因此拒绝，不做假设。
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
 * 在全部检查之后终止一棵进程树。
 * @param {object} opts
 * @param {number} opts.pid - 要终止的树根。
 * @param {number|null} [opts.seenCreatedMs] - 上一份快照记录的创建时间。
 * @param {Set<number>|number[]} [opts.whitelistPids] - 永不终止的 pid（宿主自身、启动链、用户登记）。
 * @param {object} [opts.config] - { allowKill?: boolean }
 * @param {object} [opts.deps] - 供测试替换的操作系统接缝：{ exec, platform, sleep }。
 * @returns {Promise<{ok:boolean, code:string, detail?:string}>}
 */
export async function killTree(opts) {
  const { pid, seenCreatedMs = null, whitelistPids = new Set(), config = {}, procs = [], deps = {} } = opts
  const os = resolveDeps(deps)

  // `taskkill /T` 会无条件结束整棵后代树。树里任何位置只要有受保护的 pid
  // （宿主、启动链、用户登记），终止根就会连带结束受保护的进程，破坏白名单
  // 承诺——即使根本身通过了策略。所以动任何东西之前先在快照里枚举整棵树；
  // 这是纯快照检查，任何平台都会执行。
  const protectedSet = whitelistPids instanceof Set ? whitelistPids : new Set(whitelistPids)
  if (Array.isArray(procs) && procs.length) {
    const protectedHit = subtreeOf(procs, pid).find((node) => node.pid !== pid && protectedSet.has(node.pid))
    if (protectedHit) return { ok: false, code: 'protected_descendant', detail: String(protectedHit.pid) }
  }

  if (os.platform() !== 'win32') return { ok: false, code: 'unsupported_platform' }
  // 身份预检：防止 pid 已被系统复用。
  const facts = await pidFacts(pid, os)
  const validation = validateKillTarget({
    pid,
    seenCreatedMs,
    facts,
    whitelistPids,
    allowKill: config.allowKill !== false
  })
  if (!validation.ok || validation.code === 'already_gone') return validation

  // 人的确认已经在客户端完成；身份与受保护进程的策略检查通过后才执行。
  const { err, stderr } = await run(os, 'taskkill', TASKKILL_ARGS(pid))
  if (err && !/not found/i.test(stderr || '')) {
    return { ok: false, code: 'taskkill_failed', detail: String((stderr || err.message || '')).slice(0, 300) }
  }
  // 等系统回收进程后复查。判定放在 classifyKillOutcome 里，因此不依赖真实的
  // Windows 进程也能被测试覆盖。
  await os.sleep(700)
  return classifyKillOutcome(facts.createdMs, await pidFacts(pid, os))
}
