// dsh-treekeeper 的宿主侧。
//
// webserver 上的 JSON 接口，采用 DSH 插件路由的同源守卫模式：
//
//   GET  /dsh-treekeeper/api?action=snapshot   完整操作系统采样、归因、泄漏、
//                                              账本与对账
//   GET  /dsh-treekeeper/api?action=jobs       仅账本行
//   GET  /dsh-treekeeper/api?action=history    最近的泄漏发现
//   GET  /dsh-treekeeper/api?action=subagents  指定根会话的子代理树
//   GET  /dsh-treekeeper/api?action=subtree    指定 pid 的进程子树（树杀确认）
//   POST /dsh-treekeeper/api?action=kill       { pid, seenCreatedMs } 受守卫的树杀
//   POST /dsh-treekeeper/api?action=config     运行时开关：轮询间隔、是否允许终止、登记的 pid
//
// 安全模型：每个请求都经过同源守卫（Fetch Metadata、Origin、Host 与 TCP 对端
// 地址），会改变状态的 action 只接受 POST。终止路径另有 lib/act.js 里的检查
// （创建时间预检、白名单、受保护进程名）。
//
// 文件分工：
//   账本     → lib/ledger.js（任务注册表、子代理谱系）
//   操作系统 → lib/sampler.js + lib/attribute.js + lib/leak.js
//   动作     → lib/act.js（受守卫的树杀）
//   对账     → lib/reconcile.js

import { sample, SAMPLER_UNSUPPORTED_PLATFORM } from './sampler.js'
import { attribute, subtreeOf } from './attribute.js'
import { findAncestorPids, processRows } from './roots.js'
import { collectFindings, applyLedgerOwnership } from './leak.js'
import { createJobLedger, createSubagentTree } from './ledger.js'
import { reconcile } from './reconcile.js'
import { killTree, decideKillEntry, decideKillConfirm } from './act.js'
import { HistoryStore } from './store.js'
// `sendJson`、`requirePost` 与 `optionalSessionId` 来自内嵌在 lib/shared.js 里的
// 宿主 HTTP 片段，不使用本地副本：只有一处定义响应形状，`cache-control:
// no-store` 才不会在某个副本里漏掉。
import {
  VERSION, sendJson, requirePost, optionalSessionId, createBrowserAuthorizer,
  treekeeperGuard, pluginHint, subagentAvailability, hostDshHome,
  normalizePidInput, normalizeCreatedMsInput, normalizePollIntervalMs,
  POLL_INTERVAL_OFF, POLL_INTERVAL_MIN_MS, POLL_INTERVAL_MAX_MS,
  unattributedRows, hostKind
} from './shared.js'

// 导出可调用的默认入口：在常规与重载加载器路径上，这是最不含糊的 Cordis 插件
// 形状。具名导出让需要检查模块命名空间的工具也能读到同样的内容。
export const inject = ['webServer']

/**
 * 每个 POST 路由在读取字段之前都要做的两项请求体检查。响应已经写出时返回
 * false：
 *
 *   413 `body_too_large`  到达的字节数超过读取预算。
 *   400 `bad_json`       请求体不是一个 JSON 对象。被截断的终止请求体会解析成
 *                        `{}`，各道检查会把它读成“没有指定 pid”的请求并回答
 *                        409 `snapshot_required`，让调用方去刷新一个从未被
 *                        指定目标的快照。
 */
function readBodyGuard(body, res) {
  if (body.tooLarge) {
    sendJson(res, 413, { ok: false, code: 'body_too_large', error: 'request body too large' })
    return false
  }
  if (body.parseError) {
    sendJson(res, 400, { ok: false, code: 'bad_json', error: 'request body must be a JSON object' })
    return false
  }
  return true
}

/**
 * `detail` 是 pid 或进程名的终止错误码，这些文本由本插件自己写入。其余的
 * 拒绝带有 taskkill / PowerShell 的原始输出；那段文字对读宿主日志或
 * `history.jsonl` 的人有用，但不能交给浏览器。
 */
const SAFE_KILL_DETAIL_CODES = new Set(['protected', 'protected_descendant'])

/**
 * 把不可信的请求文本变成适合一行宿主日志的内容。
 *
 * `action` 由调用方选择，其中的换行会凭空开始第二行日志，读起来像是本插件写
 * 的；过长的值会让日志变成请求内容的副本。这里把换行折成空格并截断：本插件的
 * action 名称最长九个字符，合法请求永远不会被截到。
 */
function logField(value, max = 80) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max)
}

/**
 * 挂载宿主侧。
 *
 * @param ctx DSH 插件上下文（只有 `webServer` 是必需的）。
 * @param [overrides] 两个会接触操作系统的协作者的测试接缝：`sample` 与
 *   `killTree`。Cordis 调用 `apply(ctx)`；默认值就是真实的采样器与真实的受守卫
 *   终止，因此线上行为完全由默认值决定。测试可以借此驱动每种路由结果，包括
 *   降级采样与失败的 taskkill，而不用在机器上留下真实进程。
 */
export function apply(ctx, overrides = {}) {
    const deps = { sample, killTree, ...overrides }
    const ws = ctx.webServer
    if (ws === undefined) return

    const startedAt = Date.now()
    const KILL_SNAPSHOT_MAX_AGE_MS = 15 * 1000
    // 两道终止检查各自给出的说明：快照过期时该做什么，以及目标根本不属于
    // 本插件可以终止的范围。
    const killRefusalText = (code) => code === 'snapshot_required'
      ? 'refresh a complete process snapshot before terminating'
      : 'target is not part of the DSH host tree'
    const config = {
      pollMs: 0, // 0 表示只在请求时采样；大于 0 时按该间隔后台轮询
      allowKill: true,
      extraWhitelistPids: []
    }

    const history = new HistoryStore(hostDshHome(ctx))
    // `$DSH_HOME/treekeeper/history.jsonl` 每台机器只有一份，桌面宿主与
    // `dsh web` 宿主会写进同一个文件。记录里不带写入方时，事后无法区分两个宿主
    // 的发现与终止；文件名一旦改动就需要迁移，因此区分信息只能放在记录里。
    // 记录只用 pid 与端口指明写入方，不加 `hostKind`：这样已经读取这个追加文件
    // 的程序保持原有形状，宿主类型在需要的地方（快照响应）实时读取。
    const hostFields = () => ({ hostPid: process.pid, port: ws.port ?? null })
    const ownHostKind = hostKind()
    const jobLedger = createJobLedger(ctx)
    const subagentTree = createSubagentTree(ctx)

    // 已知根是宿主进程自己；它上方的进程（electron/node 启动链）只作为保护链，
    // 让管理器启动的实例和本进程自己的子进程归入宿主桶。向上遍历在每次采样时
    // 沿 process.pid 的父链重新完成。
    let launchChain = new Set()

    let lastSnapshot = null
    async function takeSnapshot() {
      const { procs, degraded, cimError } = await deps.sample()
      // 祖先进程受保护，但从不作为归因根：拿 Electron 或启动器当根，会把它们
      // 无关的兄弟进程也认领进来。
      launchChain = findAncestorPids(procs, process.pid)
      const roots = new Map()
      roots.set(process.pid, 'harness')
      for (const pid of config.extraWhitelistPids) roots.set(Number(pid), 'whitelisted')
      const attribution = attribute(procs, roots, {
        pluginHint
      })
      // 重复副本数与长驻时长的阈值取 lib/leak.js 中各规则的默认值。降级采样
      // 没有父进程链，因此它产生的每条发现都停在 `indicative`，不冒充 `exact`。
      const findings = collectFindings(procs, attribution, { degraded })
      if (findings.length > 0) {
        await history.append({ kind: 'findings', ...hostFields(), count: findings.length, types: findings.map((f) => f.type) })
      }
      lastSnapshot = {
        takenAt: Date.now(),
        procs,
        degraded,
        cimError: cimError ?? null,
        attribution: Object.fromEntries([...attribution.attributed].map(([pid, info]) => [pid, info])),
        processes: processRows(procs, attribution),
        // 离开宿主之前先排好序：客户端只渲染这个列表的开头，未经排序的整机集合
        // 会把 Windows 服务放在那个位置，而真正值得看的 DSH 相关行沉到后面。
        // 每行带上命中的 DSH 信号 id，因为客户端够不到计算它们的匹配器；客户端
        // 只对行分组，不处理整个集合。
        unknown: unattributedRows(attribution.unknown),
        findings
      }
      return lastSnapshot
    }

    // 可选的后台轮询（供历史记录使用）。默认关闭：面板在打开时采样，轮询节奏
    // 属于设置项。
    let pollTimer = null
    function setPoll(ms) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      // 这里再检查一次边界，防止进程内部的调用方绕过校验：路由请求不会带着
      // 越界值走到这里，normalizePollIntervalMs 已经用 400 `bad_poll_ms` 回答
      // 过了。既不是 `0` 也不在范围内的值不会启动定时器，`pollMs` 记为 0，
      // 这是安全的读法。
      if (Number.isFinite(ms) && ms >= POLL_INTERVAL_MIN_MS && ms <= POLL_INTERVAL_MAX_MS) {
        config.pollMs = ms
        pollTimer = setInterval(() => {
          takeSnapshot().catch((e) => {
            // 后台采样失败不能悄无声息：lastSnapshot 会悄悄变旧，面板继续渲染
            // 旧数据，却不给出任何原因。每次失败写一行 stderr 是最便宜的可靠
            // 信号；轮询本身会继续重试。
            console.error('treekeeper: background sample failed:', String((e && e.message) || e))
          })
        }, ms)
      } else {
        config.pollMs = 0
      }
    }

    const guard = treekeeperGuard({ currentPort: () => ws.port })
    let connection = null
    let connectionSeen = false
    let connectionGeneration = 0
    if (typeof ctx.inject === 'function') {
      ctx.inject(['connection'], (connectionCtx) => {
        if (!connectionCtx.connection) return
        const mine = ++connectionGeneration
        connectionSeen = true
        connection = connectionCtx.connection
        if (typeof connectionCtx.on === 'function') {
          connectionCtx.on('dispose', () => {
            if (mine !== connectionGeneration) return
            connectionGeneration += 1
            connection = null
          })
        }
      })
    }
    // 判定顺序由 `dsh-host-http` 片段固定下来，见 `createBrowserAuthorizer`。
    const authorizeBrowser = createBrowserAuthorizer({
      getConnection: () => connection,
      getConnectionSeen: () => connectionSeen,
      guard
    })
    const apiRoute = {
      kind: 'exact',
      path: '/dsh-treekeeper/api',
      handler: async (req, res) => {
        const requestController = new AbortController()
        const abortRequest = () => requestController.abort()
        if (typeof req.once === 'function') req.once('aborted', abortRequest)
        if (typeof res.once === 'function') res.once('close', abortRequest)
        // 提到 try 之外，catch 才知道是哪个 action 失败；写在 try 里的 `const`
        // 在需要它的日志行处正好不在作用域内。
        let action = 'unknown'
        try {
          if (!authorizeBrowser(req, res)) return
          const u = new URL(req.url || '/', 'http://x')
          action = u.searchParams.get('action') || 'snapshot'

          if (action === 'snapshot') {
            const rootSessionId = optionalSessionId(u.searchParams.get('rootSessionId'))
            const snap = lastSnapshot && (Date.now() - lastSnapshot.takenAt < 2000)
              ? lastSnapshot
              : await takeSnapshot()
            const jobs = jobLedger.list()
            const subagents = rootSessionId === null ? [] : await subagentTree.list(rootSessionId, requestController.signal)
            const rec = reconcile(jobs, snap.procs, attributionOf(snap).attributed)
            // 发现离开宿主之前，用本次请求的账本对账结果填上 ownership 的
            // session/job 部分。
            applyLedgerOwnership(snap.findings, rec.rows)
            sendJson(res, 200, {
              ok: true,
              version: VERSION,
              pid: process.pid,
              port: ws.port,
              hostKind: ownHostKind,
              startedAt,
              degraded: snap.degraded,
              cimError: snap.cimError,
              takenAt: snap.takenAt,
              findings: snap.findings,
              unknown: snap.unknown,
              processes: snap.processes,
              attributedCount: Object.keys(snap.attribution).length,
              ledgerAvailability: jobLedger.availability(),
              jobs,
              subagentRoot: rootSessionId,
              subagentAvailability: subagentAvailability(rootSessionId, subagents),
              subagents,
              reconcile: rec
            })
            return
          }
          if (action === 'jobs') {
            sendJson(res, 200, {
              ok: true,
              ledgerAvailability: jobLedger.availability(),
              jobs: jobLedger.list()
            })
            return
          }
          if (action === 'subagents') {
            const rootSessionId = optionalSessionId(u.searchParams.get('rootSessionId'))
            if (rootSessionId === null) {
              sendJson(res, 400, { ok: false, code: 'root_required', error: 'rootSessionId is required' })
              return
            }
            const subagents = await subagentTree.list(rootSessionId, requestController.signal)
            sendJson(res, 200, {
              ok: true,
              rootSessionId,
              availability: subagents === null ? 'unavailable' : 'available',
              subagents
            })
            return
          }
          if (action === 'subtree') {
            // 用 normalizePidInput 而不是 Number()：`Number('') || 0` 会把缺失或
            // 无意义的 pid 折成 0，读者就分不清是没给 pid 还是被强转成了 0。
            // 两种情况都归一为 null，返回同一种拒绝。
            const pid = normalizePidInput(u.searchParams.get('pid'))
            if (pid === null) { sendJson(res, 400, { ok: false, code: 'bad_pid', error: 'pid must be a positive integer' }); return }
            const { procs } = await deps.sample()
            sendJson(res, 200, { ok: true, pid, subtree: subtreeOf(procs, pid) })
            return
          }
          if (action === 'history') {
            // `degraded` 把“还没有历史”和“审计记录没有被写入”分开：只看空的
            // 行列表，读这个接口的人无法区分两者。
            sendJson(res, 200, { ok: true, rows: await history.last(100), degraded: history.degraded })
            return
          }
          if (action === 'config') {
            if (requirePost(req, res, 'config')) {
              // 运行时开关：只影响本次宿主进程，不写入磁盘。
              const body = await readBody(req)
              if (!readBodyGuard(body, res)) return
              if (body.pollMs !== undefined) {
                const pollMs = normalizePollIntervalMs(body.pollMs)
                if (pollMs === null) {
                  sendJson(res, 400, {
                    ok: false,
                    code: 'bad_poll_ms',
                    error: `pollMs must be ${POLL_INTERVAL_OFF} or between ${POLL_INTERVAL_MIN_MS} and ${POLL_INTERVAL_MAX_MS}`
                  })
                  return
                }
                setPoll(pollMs)
              }
              if (body.allowKill !== undefined) config.allowKill = !!body.allowKill
              if (Array.isArray(body.extraWhitelistPids)) {
                config.extraWhitelistPids = body.extraWhitelistPids.map(normalizePidInput).filter((p) => p !== null)
              }
              sendJson(res, 200, { ok: true, config })
            }
            return
          }
          if (action === 'kill') {
            if (!requirePost(req, res, 'kill')) return
            const body = await readBody(req)
            if (!readBodyGuard(body, res)) return
            const pid = normalizePidInput(body.pid)
            const seenCreatedMs = normalizeCreatedMsInput(body.seenCreatedMs)
            // 没有指明目标或目标格式不合法属于请求错误，不是快照过期：让调用方
            // 去刷新快照，只会把他们送去唯一帮不上忙的操作。
            if (pid === null) { sendJson(res, 400, { ok: false, code: 'bad_pid', error: 'pid must be a positive integer' }); return }
            if (seenCreatedMs === null) { sendJson(res, 400, { ok: false, code: 'bad_created_ms', error: 'seenCreatedMs must be a creation time in epoch milliseconds' }); return }
            // 各项拒绝判定放在 act.js 里，都是纯函数，因此在任何平台上都能覆盖；
            // 这条路由只负责收集事实，并执行检查允许的操作。
            const entry = decideKillEntry({
              pid,
              seenCreatedMs,
              snapshot: lastSnapshot,
              takenAt: lastSnapshot ? lastSnapshot.takenAt : 0,
              now: Date.now(),
              maxAgeMs: KILL_SNAPSHOT_MAX_AGE_MS,
              attribution: lastSnapshot ? lastSnapshot.attribution : null
            })
            if (!entry.ok) {
              sendJson(res, 409, { ok: false, code: entry.code, error: killRefusalText(entry.code) })
              return
            }
            // 受保护后代检查必须基于实时数据：最多 15 秒前的快照看不到此后出现的
            // 受保护 pid，而 `taskkill /T` 会把它一起结束。因此执行前重新采样，
            // 并重新确认目标身份。剩下的是这次采样与系统调用之间的窗口，用户态
            // 检查无法消除它，承诺只能是“与最后一次采样一样新”。同一份采样也交给
            // 下面 killTree 的受保护后代扫描。
            const fresh = await deps.sample()
            const identity = decideKillConfirm({ pid, seenCreatedMs, fresh })
            if (!identity.ok) {
              sendJson(res, 409, { ok: false, code: identity.code, error: killRefusalText(identity.code) })
              return
            }
            const result = await deps.killTree({
              pid,
              seenCreatedMs,
              whitelistPids: new Set([process.pid, ...launchChain, ...config.extraWhitelistPids]),
              config,
              procs: fresh.procs
            })
            // 完整记录（包含操作系统原文）写入历史文件，那是审计轨迹。响应只带
            // 错误码；`detail` 是 pid 或进程名的两个错误码才附带 detail；
            // `taskkill_failed` / `verify_failed` 的 detail 是 PowerShell 或
            // taskkill 的原始输出，不交给浏览器。
            await history.append({ kind: 'kill', ...result, ...hostFields(), pid })
            sendJson(res, result.ok ? 200 : 409, { ok: result.ok, code: result.code, ...(SAFE_KILL_DETAIL_CODES.has(result.code) ? { detail: result.detail } : {}) })
            return
          }
          // 回显的 action 要截断：它是攻击者可控、又被反射进响应体的文本，与会话
          // id 一样需要长度上限。
          sendJson(res, 400, { ok: false, code: 'bad_action', error: `unknown action "${action.slice(0, 64)}"` })
        } catch (e) {
          if (requestController.signal.aborted) return
          // 固定的错误码、一句固定说明，真实原因只进宿主日志：异常原文里有路径、
          // 命令与 Windows 错误串，那些内容在面板里没有意义，在日志里却有。
          const code = e && e.code === SAMPLER_UNSUPPORTED_PLATFORM ? SAMPLER_UNSUPPORTED_PLATFORM : 'internal_error'
          console.error(`treekeeper: ${code} while handling ${logField(action)}:`, String((e && e.message) || e))
          sendJson(res, 500, {
            ok: false,
            code,
            error: code === SAMPLER_UNSUPPORTED_PLATFORM
              ? 'process sampling is only implemented on Windows'
              : 'treekeeper request failed; see the host log'
          })
        } finally {
          if (typeof req.off === 'function') req.off('aborted', abortRequest)
          if (typeof res.off === 'function') res.off('close', abortRequest)
        }
      }
    }
    const disposeRoute = ws.register(apiRoute)

    // 用 effect 注册清理，与宿主自身插件一致：插件卸载时停掉轮询并释放路由。
    ctx.effect(() => () => {
      if (pollTimer) clearInterval(pollTimer)
      if (typeof disposeRoute === 'function') disposeRoute()
    })
}

apply.inject = inject

export default apply

function attributionOf(snap) {
  // 从序列化的快照还原 reconcile() 需要的 Map 形状。
  const attributed = new Map()
  for (const [pid, info] of Object.entries(snap.attribution || {})) {
    attributed.set(Number(pid), info)
  }
  return { attributed }
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 三种可区分的结果，因为路由要用不同的状态码回答：
 *
 *   `{ tooLarge: true }`   到达的字节数超过 65536。越过上限的瞬间就定下结果，
 *                          但不销毁请求：响应已经在路上，重置套接字会让调用方
 *                          看不到它。
 *   `{ parseError: true }` 请求体不是 JSON 对象。它与 `{}` 保持区别，这样
 *                          `readBodyGuard` 会回答 400 `bad_json`，被截断的终止
 *                          请求不会被当成“没有请求体”继续往下走。
 *   `{}`                   完全没有请求体，或流在 `end` 之前关闭/出错。仍然是一个
 *                          合法的“没有可执行的内容”。
 */
export function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    let settled = false
    const finish = (body) => { if (!settled) { settled = true; resolve(body) } }
    req.on('data', (c) => {
      if (settled) return
      data += c
      if (data.length > 65536) {
        finish({ tooLarge: true })
      }
    })
    req.on('end', () => {
      if (!data) { finish({}); return }
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        finish({ parseError: true })
        return
      }
      // 裸字符串、数字或数组都是合法 JSON，但不是这个接口能读取字段的请求体，
      // 因此归入解析失败，不作为一个空对象送到检查处。
      finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { parseError: true })
    })
    req.on('error', () => finish({}))
    req.on('close', () => finish({}))
  })
}
