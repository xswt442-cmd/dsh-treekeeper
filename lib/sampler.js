// 宿主侧以 Windows 为先的进程采样。
//
// 主路径每次采样执行一次 CIM 查询（Get-CimInstance Win32_Process），由短命的
// powershell 子进程完成。插件运行在宿主进程里（不在工具沙箱的受限令牌下），
// CIM 读取按预期可用；查询失败时退到 `tasklist /fo csv /nh`（只有名称、pid 与
// 内存，没有 ppid），并把快照标记为 `degraded: 'no-ppid'`，让界面说明归因已
// 停用，不假装数据完整。
//
// lib/act.js 的每个终止门都读取本模块的 `degraded` 标记，它才是与安全相关的
// 输出。下面的接缝（`deps.runExec`、`deps.platform`、`deps.now`）让测试可以
// 喂入真实的 PowerShell 与 tasklist 输出、一条失败命令以及一个可推进的时钟，
// 既不需要 Windows 机器，也不用真的等 8 秒：直接验证生产者，才能确认消费者
// 拿到的结论成立。

import { execFile } from 'node:child_process'
import { parseCimDate } from './shared.js'

const CIM_SCRIPT =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize | ' +
  'ConvertTo-Json -Compress -Depth 3'

/**
 * 每次采样共用一个实际耗时预算，CIM 阶段与降级阶段都从中取用。预算是每个
 * 阶段开始时还能拿到的时长，不是整个采样的总时长：`MIN_PHASE_TIMEOUT_MS`
 * 保证降级阶段可用，因此最坏情况是预算加上这个下限。
 */
export const SAMPLE_TIMEOUT_MS = 8000
/**
 * 任何阶段的超时都不低于这个值。没有下限时，用完预算的 CIM 调用会让降级阶段
 * 一点时间都拿不到，采样就会报告彻底失败，而不是交出一份可用的无 ppid 快照。
 * 代价是采样可能超出 `SAMPLE_TIMEOUT_MS`。
 */
export const MIN_PHASE_TIMEOUT_MS = 1000
/** 只有 tasklist 的快照所带的标记；每个终止门都读它。 */
export const DEGRADED_NO_PPID = 'no-ppid'
/**
 * 非 Windows 分支报告的错误码。路由按这个码回答，因此“此平台未实现”可以脱离
 * 原始错误文本被读出。
 */
export const SAMPLER_UNSUPPORTED_PLATFORM = 'unsupported_platform'

const defaultRunExec = (cmd, args, options) => new Promise((resolve, reject) => {
  execFile(cmd, args, options, (err, stdout) => {
    if (err) reject(err)
    else resolve(stdout)
  })
})

const DEFAULT_DEPS = {
  runExec: defaultRunExec,
  platform: () => process.platform,
  now: () => Date.now()
}

const resolveDeps = (deps = {}) => ({ ...DEFAULT_DEPS, ...deps })

/**
 * 本阶段还能使用的采样预算：截止时间剩下的时长；调用方没有给截止时间时是
 * 整个预算；结果不低于下限。
 */
function phaseTimeout(deadline, deps, timeoutMs) {
  const now = deps.now()
  const floor = Math.min(MIN_PHASE_TIMEOUT_MS, timeoutMs)
  return Math.max(floor, (deadline ?? (now + timeoutMs)) - now)
}

/** CIM 行 -> 进程记录。无法满足约定的行直接丢弃，不猜测。 */
export function toProc(row) {
  if (!row || typeof row !== 'object') return null
  const pid = Number(row.ProcessId)
  const ppid = Number(row.ParentProcessId)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return {
    pid,
    ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
    name: String(row.Name || '').replace(/\.exe$/i, ''),
    cmdline: typeof row.CommandLine === 'string' ? row.CommandLine : '',
    createdMs: parseCimDate(row.CreationDate),
    wsBytes: Number(row.WorkingSetSize) || 0
  }
}

/**
 * 解析 `ConvertTo-Json -Compress` 的回复。单个进程序列化成对象而不是数组，
 * 两种形状都接受；空回复是空列表；截断或损坏的回复抛出错误，让调用方降级，
 * 而不是把半棵进程树当成整台机器。
 */
export function parseCimRows(stdout) {
  if (!stdout || !stdout.trim()) return []
  const parsed = JSON.parse(stdout)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const out = []
  for (const row of rows) {
    const proc = toProc(row)
    if (proc) out.push(proc)
  }
  return out
}

/**
 * 解析 `tasklist /fo csv /nh`。五个带引号的列是文档规定的默认布局（映像名、
 * PID、会话名、会话号、内存占用）；不匹配的行不是进程行——表头、换行续行或
 * 截断的尾部——直接跳过，不会变成半条记录。
 */
export function parseTasklistRows(stdout) {
  const out = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const cols = /^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/.exec(line)
    if (!cols) continue
    const pid = Number(cols[2])
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({
      pid,
      ppid: 0,
      name: cols[1].replace(/\.exe$/i, ''),
      cmdline: '',
      createdMs: null,
      wsBytes: parseKb(cols[3])
    })
  }
  return out
}

function parseKb(text) {
  const m = /([\d,]+)\s*K/.exec(String(text || '').replace(/"/g, ''))
  return m ? Number(m[1].replace(/,/g, '')) * 1024 : 0
}

/** 完整采样的 CIM 查询：pid、父子关系、命令行、创建时间与内存。 */
export async function sampleWindowsCim({ timeoutMs = SAMPLE_TIMEOUT_MS, deps = {}, deadline } = {}) {
  const d = resolveDeps(deps)
  const stdout = await d.runExec('powershell.exe', ['-NoProfile', '-Command', CIM_SCRIPT], {
    windowsHide: true,
    timeout: phaseTimeout(deadline, d, timeoutMs),
    maxBuffer: 32 * 1024 * 1024
  })
  return parseCimRows(stdout)
}

/** 降级采样：tasklist 没有 ppid，也没有命令行。 */
export async function sampleWindowsTasklist({ timeoutMs = SAMPLE_TIMEOUT_MS, deps = {}, deadline } = {}) {
  const d = resolveDeps(deps)
  const stdout = await d.runExec('tasklist', ['/fo', 'csv', '/nh'], {
    windowsHide: true,
    timeout: phaseTimeout(deadline, d, timeoutMs),
    maxBuffer: 16 * 1024 * 1024
  })
  return parseTasklistRows(stdout)
}

/** 非 Windows 平台的判定：明确的错误码，不做猜测。 */
function unsupportedPlatformError(platform) {
  const error = new Error(`treekeeper: only Windows sampling is implemented in this skeleton (saw platform ${platform})`)
  error.code = SAMPLER_UNSUPPORTED_PLATFORM
  return error
}

/**
 * 一份平台快照，结果为 `{ procs, degraded }`。
 * 非 Windows 上以 `SAMPLER_UNSUPPORTED_PLATFORM` 拒绝并交给调用方，由它给出
 * 配置提示，不假装能工作。
 */
export async function sample({ timeoutMs = SAMPLE_TIMEOUT_MS, deps = {} } = {}) {
  const d = resolveDeps(deps)
  const platform = d.platform()
  if (platform !== 'win32') throw unsupportedPlatformError(platform)
  const deadline = d.now() + timeoutMs
  try {
    const procs = await sampleWindowsCim({ timeoutMs, deps: d, deadline })
    // 运行中的 Windows 机器不会采样出零个进程。空 CIM 回复意味着读取被截断或
    // 过滤，而不是机器空闲，因此不能当作健康快照：转入降级路径，由面板说明
    // 降级，终止门保持拒绝。
    if (!procs.length) throw new Error('CIM returned no processes')
    return { procs, degraded: null }
  } catch (cimErr) {
    try {
      return { procs: await sampleWindowsTasklist({ timeoutMs, deps: d, deadline }), degraded: DEGRADED_NO_PPID, cimError: String(cimErr && cimErr.message || cimErr) }
    } catch (tlErr) {
      throw new Error('treekeeper: both CIM and tasklist sampling failed: ' + String(tlErr && tlErr.message || tlErr))
    }
  }
}
