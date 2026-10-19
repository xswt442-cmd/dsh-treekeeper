// dsh-treekeeper 的共用工具：版本、同源守卫、JSON 响应、POST 门、CIM 时间解析、
// 命令行规范化。
//
// 回环判断不写在这里，而是在构建时从 dsh-mini-utility-dock 内嵌（见下面的标记
// 块）：手抄一份会与来源不一致。需要修改时改 dock 里的片段，再运行
// `npm run loopback:sync`。
//
// 响应胶水（`sendJson`、POST 门、浏览器授权器、`optionalSessionId`）同样由
// `npm run http:sync` 内嵌：响应形状与 `cache-control: no-store` 只有一处定义，
// 才不会在某个副本里缺失。

import os from 'node:os'
import path from 'node:path'

export const VERSION = '0.4.1'

// <dsh-loopback-helpers>
// The loopback predicates: which Host names and which peer addresses count as
// loopback, for a plugin's host half that binds an API to the loopback interface.
//
// This fragment has ONE source of truth: dsh-mini-utility-dock/dist/loopback.js.
// A host half is plain Node ESM that its package ships standalone, so the
// fragment is embedded into `lib/shared.js` at build time by
//   npm run loopback:sync    (write it)
//   npm run loopback:check   (fail on drift)
// instead of being imported: a bare `import 'dsh-mini-utility-dock/...'` would
// put a runtime dependency on this package into the file that embeds it, and an
// embedding plugin ships standalone, with nothing else required.
//
// "Loopback" is decided in exactly one place — LOOPBACK_HOSTNAMES plus the
// IPv4-mapped IPv6 form of each entry — and both the name and the address
// predicate route through it, so the Host path and the peer path cannot
// disagree. Every spelling this file accepts is a documented one; anything
// unrecognised fails closed.
//
// Kept a separate fragment from the host guard on purpose: the predicates are
// stable facts about what an address is, while the guard is a policy about who
// may call an API. The guard block reads the names this block declares, so it
// depends on this block and never the other way round.

// Hostnames a request to a loopback-bound API may legitimately arrive with.
// Exact spellings only: `api.localhost` and `127.0.0.1.evil.example` must stay
// rejected, which is what keeps DNS rebinding out of the API surface.
export const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1']

// Canonicalize a Host-like value. Trims both ends and lowercases, so the
// allowlist match is case-insensitive and tolerates surrounding whitespace.
export const normalizeHostValue = (value) => String(value == null ? '' : value).trim().toLowerCase()

// Pull the hostname out of a Host header: "127.0.0.1:3080" -> "127.0.0.1",
// "[::1]:3080" -> "::1". A bracketed IPv6 literal carries its colons inside the
// brackets, so the brackets decide where the host ends, not the first colon.
export const hostHostname = (host) => {
  const value = normalizeHostValue(host)
  const bracketed = /^\[([^\]]+)\]/.exec(value)
  return bracketed ? bracketed[1] : value.split(':')[0]
}

// The IPv4 address inside an IPv4-mapped IPv6 literal, or null. Node reports a
// v4 peer on a dual-stack socket in the mapped form, so this is a routine input,
// not an exotic one. Two spellings reach us and both must work:
//
//   ::ffff:127.0.0.1   what Node puts in req.socket.remoteAddress, and what a
//                      client may legally write in a Host header
//   ::ffff:7f00:1      what the WHATWG URL parser normalises the above to, so
//                      this is the shape a browser's Origin header produces
//
// The v4 part is validated as four decimal octets, so `::ffff:1.2.3` and
// `::ffff:999.1.1.1` are not addresses and fail closed.
const mappedIpv4 = (value) => {
  if (!value.startsWith('::ffff:')) return null
  const rest = value.slice(7)
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(rest)) {
    return rest.split('.').every((octet) => Number(octet) <= 255) ? rest : null
  }
  // Hex form: ::ffff:7f00:1 -> 127.0.0.1. Exactly two groups, four hex digits
  // each, as the URL parser emits.
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
  if (!hex) return null
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/**
 * True when `name` is a loopback hostname — the Host-header side of the guard.
 * Accepts the documented spellings, the IPv4-mapped IPv6 form of 127.0.0.1, and
 * folds case. Fails closed on everything else, including a missing name.
 */
export const isLoopbackName = (name) => {
  const value = normalizeHostValue(name)
  if (!value) return false
  if (LOOPBACK_HOSTNAMES.indexOf(value) !== -1) return true
  const ipv4 = mappedIpv4(value)
  return ipv4 !== null && LOOPBACK_HOSTNAMES.indexOf(ipv4) !== -1
}

/**
 * True when `address` is a real loopback TCP peer address.
 * Headers cannot identify the network peer — a client sets `Host` freely — so
 * the socket address is the only trustworthy signal. Fail closed on anything
 * unrecognised, including a missing address.
 */
export const isLoopbackAddress = (address) => {
  const value = normalizeHostValue(address)
  if (!value) return false
  if (value === '::1') return true
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is how Node reports a v4 peer on a
  // dual-stack socket; fold it back before the 127/8 test.
  const mapped = mappedIpv4(value)
  if (mapped !== null) return /^127\./.test(mapped)
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}
// </dsh-loopback-helpers>

// <dsh-host-guard>
// Host-side same-origin request guard, for a plugin's host half that binds an
// API to loopback.
//
// This fragment has ONE source of truth: dsh-mini-utility-dock/dist/guard.js.
// A host half is plain Node ESM that its package ships standalone, so the
// fragment is embedded into `lib/shared.js` at build time by
//   npm run guard:sync    (write it)
//   npm run guard:check   (fail on drift)
// instead of being imported: a bare `import 'dsh-mini-utility-dock/...'` would
// put a runtime dependency on this package into the file that embeds it, and an
// embedding plugin ships standalone, with nothing else required.
//
// This file is the POLICY half. What counts as loopback is a separate fragment
// (`dist/loopback.js`, embedded under the `dsh-loopback-helpers` marker), and
// this module uses the predicates that block exports in the same file rather than
// restating them: `hostHostname`, `isLoopbackName` and `isLoopbackAddress` are
// module-scope names here, declared by the block above. That keeps one copy of
// them in a consumer, and makes the dependency one-way and visible — `guard:sync`
// needs `loopback:sync` to have produced a `lib/shared.js` that declares them.
//
// There is deliberately no `import` here. A consumer embeds both blocks into one
// file, so an import of another module would both break the standalone promise
// and collide with the exports the block above already declares.
//
// The enforcement order and every decision are fixed here, and the wording is
// supplied as data by the caller (`policy`): a plugin customizes the codes and
// messages its own API publishes without forking the checks. Keeping the
// vocabulary out of the decisions is what makes one copy of them enough.

// Default ports each scheme normalises away, so an Origin carrying no explicit
// port (for example `http://127.0.0.1`) compares equal to a server on 80/443.
// `new URL('http://127.0.0.1:80').port` is '', which would read as unequal to
// `80` and reject a legitimate same-origin request.
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' }
export const portOf = (url) => url.port || DEFAULT_PORTS[url.protocol] || ''

// The reasons this guard can reject. Each is a stable, guard-owned name for one
// decision; the *reason* is fixed here, while the machine-readable `code` a
// plugin's API exposes and the human wording are policy.
//
// An unidentifiable peer and an off-loopback peer are deliberately distinct
// decisions, because they are distinct facts about the request. A caller may map
// both to the same `code`: that is a vocabulary choice about its published API,
// and nothing widens either way, because every reason rejects.
export const GUARD_REASONS = Object.freeze([
  'non_loopback_peer',
  'cross_site',
  'unknown_peer',
  'foreign_origin',
  'non_loopback_host'
])

/** Default machine-readable codes and wording, in English, per reason. */
export const DEFAULT_GUARD_POLICY = Object.freeze({
  non_loopback_peer: { code: 'non_loopback_peer', error: 'non-loopback peer rejected' },
  cross_site: { code: 'cross_site', error: 'cross-site request rejected' },
  unknown_peer: { code: 'unknown_peer', error: 'peer address is not identifiable' },
  foreign_origin: { code: 'foreign_origin', error: 'foreign origin rejected' },
  non_loopback_host: { code: 'non_loopback_host', error: 'non-loopback host rejected' }
})

/**
 * Build the same-origin request guard for a loopback-bound API route.
 *
 * Not exported under a plugin-facing name: each plugin publishes its own guard
 * bound to its own error vocabulary, so the name it exports — `createGuard` is
 * the conventional one — is the plugin's own to declare. This is the one factory
 * every plugin that embeds this block calls.
 *
 * Enforces, in order: Fetch Metadata, an unparseable Host, the TCP peer address,
 * then the Host allowlist, then the Origin. Rejects by calling
 * `respond(res, 403, { ok: false, code, error })` and returning false; returns
 * true when the request may proceed.
 *
 * @param currentPort - the port this server listens on. A function is called per
 *   request so an Origin check follows a server whose port changes; a plain
 *   value is accepted for a fixed server.
 * @param respond - rejection sink, normally the plugin's `sendJson`. Kept
 *   injectable so tests can capture the rejection code instead of standing up a
 *   real ServerResponse.
 * @param allowRemoteHost - optional predicate. When it returns true, an
 *   off-loopback peer AND an off-loopback Host are admitted, because the caller
 *   has opted into verifying its own credential per request; the guard
 *   deliberately knows nothing about tokens. The Origin check still applies, so
 *   the exemption never widens the browser-facing boundary. A plugin that omits
 *   the predicate keeps absolute peer and Host criteria.
 * @param policy - optional per-reason `{ code, error }` overrides, keyed by
 *   `GUARD_REASONS`. A partial override merges with the default, so a plugin
 *   names only the reasons whose vocabulary differs. An unknown key throws: a
 *   typo would otherwise silently leave the default in place, and the plugin
 *   would expose a code no test expects.
 */
const bindGuard = ({ currentPort, respond, allowRemoteHost, policy } = {}) => {
  const port = typeof currentPort === 'function' ? currentPort : () => currentPort
  const overrides = policy || {}
  for (const key of Object.keys(overrides)) {
    if (!GUARD_REASONS.includes(key)) {
      throw new Error(`bindGuard: unknown policy key ${JSON.stringify(key)}; expected one of ${GUARD_REASONS.join(', ')}`)
    }
  }
  const say = Object.fromEntries(GUARD_REASONS.map((reason) => [
    reason,
    { ...DEFAULT_GUARD_POLICY[reason], ...(overrides[reason] || {}) }
  ]))
  const deny = (res, reason) => {
    respond(res, 403, { ok: false, code: say[reason].code, error: say[reason].error })
    return false
  }
  const fleetAllowed = () => typeof allowRemoteHost === 'function' && allowRemoteHost()

  return function guard(req, res) {
    const headers = (req && req.headers) || {}

    const site = headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return deny(res, 'cross_site')
    }

    const host = headers.host || ''
    const parsedHost = host ? hostHostname(host) : ''
    // An empty parse is not permission. A Host header that carries no usable
    // hostname — an unbracketed IPv6 literal such as `::1:3080`, which RFC 7230
    // forbids but a client can still send — parses to '', and reading that as a
    // pass would skip the allowlist. It is a Host problem, so it is reported as
    // one. An ABSENT Host stays loopback so host-side callers keep working.
    if (host && parsedHost === '') {
      return deny(res, 'non_loopback_host')
    }
    const peerAddress = req.socket ? req.socket.remoteAddress : undefined
    if (peerAddress == null || String(peerAddress).trim() === '') {
      return deny(res, 'unknown_peer')
    }
    // `allowRemoteHost` buys exactly one thing: an off-loopback peer AND an
    // off-loopback Host stop being *rejected* by this guard — both checks below
    // are skipped — because the caller has opted into verifying its own
    // credential per request. Everything else still applies: the Origin check
    // below rejects cross-site traffic in both modes, so the exemption never
    // widens the browser-facing boundary. A plugin that does not pass the
    // predicate never enters this mode, so for it the peer and Host criteria
    // are absolute.
    const remote = fleetAllowed()
    if (!remote && !isLoopbackAddress(peerAddress)) {
      return deny(res, 'non_loopback_peer')
    }
    const hostLoopback = host ? (parsedHost !== '' && isLoopbackName(parsedHost)) : true
    if (!remote && !hostLoopback) {
      return deny(res, 'non_loopback_host')
    }

    const origin = headers.origin
    if (origin) {
      let same = false
      try {
        const parsed = new URL(origin)
        same = isLoopbackName(hostHostname(parsed.hostname)) &&
          portOf(parsed) === String(port() || '')
      } catch {
        same = false
      }
      if (!same) return deny(res, 'foreign_origin')
    }

    return true
  }
}
// </dsh-host-guard>

// 发现与终止共用同一份策略名单。这些进程不只是告警噪音：结束它们可能让
// Windows 无法使用。
export const PROTECTED_PROCESS_NAMES = new Set([
  'system', 'idle', 'smss', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'svchost', 'explorer', 'dwm', 'fontdrvhost', 'sihost'
])

/**
 * 发现的词表。每条发现都带三个枚举字段，让噪音策略成为数据：
 *
 *   rule       触发的规则。带命名空间，新规则可以加入而不与旧的扁平 `type`
 *              标签冲突。
 *   confidence 结论的可靠程度，不是紧急程度：
 *                exact      通过活着的父进程链归入宿主树，且为完整采样
 *                indicative 降级采样（无父进程链）：证据是真的，链条更弱
 *                inferred   完全没有归因，仅凭启发式触发，永远不是终止候选
 *   provenance 哪条检查产生了这条发现：{ rule, description }。
 *              `rule` 与扁平的 `rule` 字段一致；`description` 是读者先看到的
 *              那句说明。
 *   ownership  进程声称属于谁，以及这个结论怎么得来：
 *                scope  host-descendant | session | job | unattributed
 *                via    ppid-chain | root-itself | job-label | none
 *              `session` / `job` 由账本对账填入；该对账是指示性的（任务 label
 *              近似命令行），不会提高 confidence。
 */
export const FINDING_CONFIDENCE = Object.freeze(['exact', 'indicative', 'inferred'])
export const FINDING_SCOPE = Object.freeze(['host-descendant', 'session', 'job', 'unattributed'])
export const FINDING_VIA = Object.freeze(['ppid-chain', 'root-itself', 'job-label', 'none'])
export const FINDING_RULE = Object.freeze([
  'duplicate.cmdline',
  'orphan.dead-parent',
  'orphan.previous-host',
  'longlived.plugin-child'
])

/** 每条规则的人读说明，显示在原始 id 之前。 */
export const FINDING_RULE_DESCRIPTION = Object.freeze({
  'duplicate.cmdline': 'the same normalized command line is alive in several copies at once',
  'orphan.dead-parent': 'the recorded parent pid is missing from the current snapshot',
  'orphan.previous-host': 'an unattributed process outlived its parent and still carries a DSH deployment path',
  'longlived.plugin-child': 'a process attributed to a plugin package outlived the age threshold'
})

export function hasVerifiedCreationTime(seenCreatedMs, actualCreatedMs) {
  if (!Number.isFinite(seenCreatedMs) || !Number.isFinite(actualCreatedMs)) return false
  return Math.abs(seenCreatedMs - actualCreatedMs) <= 750
}

/**
 * 子代理树区域的三种状态。客户端面板挂在根级 `shell.overlay` 槽位上，因此必须
 * 说出自己缺什么，不能猜：
 *
 *   available     已确定根会话，且挂载的 DSH 服务能枚举它的后代
 *   root-required 调用方没有提供根会话（没有选中会话）
 *   unavailable   挂载的 DSH 版本没有子代理服务
 *
 * `listDescendants` 返回 null 表示能力缺失；空数组（没有提供根）不算能力故障。
 * 宿主与客户端保持同一套顺序，旧面板与新请求的结论因此不会互相矛盾。
 */
export function subagentAvailability(rootSessionId, subagentsResult) {
  if (subagentsResult === null) return 'unavailable'
  if (rootSessionId == null) return 'root-required'
  return 'available'
}

/**
 * 解析宿主主目录，优先级与 @deepseek-ai/dsh-home-paths 一致：非空的
 * $DSH_HOME，否则 ~/.dsh。
 *
 * 这是宿主没有提供自己的访问器时的后备规则；插件代码调用 hostDshHome()，
 * 让 DSH 宿主用它自己的规则回答。
 *
 * 目录是否存在不作为判断条件：宿主接受一个尚不存在的主目录，并在需要时创建
 * 它。若在这里要求目录存在，首次运行、$DSH_HOME 刚设置的宿主就会把历史写到
 * 别处，离开它正在观察的那个宿主。空白的覆盖值按未设置处理，因此一个误写的
 * DSH_HOME=" " 不会把主目录折到当前目录。
 */
export function resolveDshHome(env = process.env, homeDir = os.homedir()) {
  const raw = env.DSH_HOME
  const selected = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
  const value = selected === null ? path.join(homeDir, '.dsh') : selected
  // resolve() 放在最后，与 dshHomePath 一致：无论值来自环境变量、系统主目录
  // 还是波浪号，结果在所有平台上都是绝对路径。
  if (value === '~') return path.resolve(homeDir)
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.resolve(path.join(homeDir, value.slice(2)))
  return path.resolve(value)
}

/**
 * 解析本插件所挂载宿主的主目录，优先采用宿主自己的回答。
 *
 * 启动层在插件树挂载之前提供 `dshHomePath`，这套规则只属于宿主：按本文件略有
 * 差异的推导写下的历史，会落在宿主永远不会查看的位置。该访问器是普通函数而
 * 不是服务，Cordis 生成的目录也不收录它，因此用 `ctx.get` 读取；它不存在属于
 * 正常情况：没有启动层的裸 Cordis 宿主挂载本插件时，退回 resolveDshHome()。
 *
 * 每次调用都重新读取，因此两次调用之间切换的主目录会被观察到，不会冻结在挂载
 * 时的值。
 */
export function hostDshHome(ctx) {
  // 真正的 Cordis 上下文一定带 `get`；路由测试用只有两个键的桩对象挂载
  // apply()，不值得为此增加挂载要求。
  const provided = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : null
  return typeof provided === 'function' ? provided() : resolveDshHome(process.env)
}

// <dsh-host-http>
// Host-side HTTP glue, for a plugin's host half that answers its own API.
//
// This fragment has ONE source of truth: dsh-mini-utility-dock/dist/host-http.js.
// A host half is plain Node ESM that its package ships standalone, so the
// fragment is embedded into `lib/shared.js` at build time by
//   npm run http:sync    (write it)
//   npm run http:check   (fail on drift)
// instead of being imported: a bare `import 'dsh-mini-utility-dock/...'` would
// put a runtime dependency on this package into the file that embeds it, and an
// embedding plugin ships standalone, with nothing else required.
//
// There is deliberately no `import` here. The block sits BELOW `dsh-host-guard`
// in the consumer's `lib/shared.js` and declares nothing the blocks above it
// already declared, so the three host-side blocks coexist in one file and a
// plugin that needs only this one can embed only this one.
//
// These lines are the response policy, so they are stated once here: every JSON
// reply carries `cache-control: no-store`, because a body naming instance ports,
// pids or session ids must never be servable from an intermediary cache — that
// header is a security posture, not cosmetics. The "browser authorization is
// unavailable" reply and the POST gate each have one definition, so a change to
// one reaches every file that embeds this block at the same time.
//
// What legitimately differs between plugins — a machine-readable `code`, the
// human wording, whether the rejected `action` is echoed — is supplied as data
// (`policy`), exactly the way `dist/guard.js` separates enforcement from
// vocabulary.

/**
 * Send a JSON reply and end the response.
 *
 * `cache-control: no-store` is part of this function rather than of each call
 * site: a route that reports live host facts (ports, pids, session data) must
 * not be servable from an intermediary cache, and a two-line helper that each
 * call site restates is where such a header goes missing.
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(text)
}

/**
 * The one reply for "browser authorization is unavailable right now". Exported
 * as data so a call site that cannot go through `connectionUnavailable()` — a
 * test, or a route that composes its own body — still states it once.
 */
export const CONNECTION_UNAVAILABLE = Object.freeze({
  ok: false,
  code: 'connection_unavailable',
  error: 'browser authentication unavailable'
})

/**
 * Answer `res` with 503 and the shared `connection_unavailable` payload, and
 * return false so a caller can hand its own verdict back in one statement.
 * `respond` has the same injectable sink shape as the guard block's `bindGuard`
 * — `(res, status, body)` — and it defaults to this block's `sendJson`, so the
 * no-store policy is not something a call site can drop.
 */
export const connectionUnavailable = (res, respond = sendJson) => {
  respond(res, 503, { ...CONNECTION_UNAVAILABLE })
  return false
}

/**
 * The reasons the POST gate can reject. One today; the table exists so the
 * wording is overridable by key and a typo in that key is an error rather than a
 * silent no-op — the same contract the guard block's `GUARD_REASONS` offers.
 */
export const REQUIRE_POST_REASONS = Object.freeze(['method_not_allowed'])

/** Default code and wording. `{action}` in `error` is substituted per call. */
export const DEFAULT_REQUIRE_POST_POLICY = Object.freeze({
  method_not_allowed: { code: 'method', error: 'action "{action}" requires POST' }
})

/**
 * Build the POST-only gate for a mutating action.
 *
 * Behavior is fixed: the method is read case-insensitively (an absent method
 * reads as `GET`, which is not POST), POST passes, anything else is answered
 * 405 and returns false. What a plugin publishes — the `code`, the language of
 * `error`, and whether the rejected `action` is echoed in the body — is policy:
 *
 *   createRequirePost()                                          // `{ code: 'method' }`
 *   createRequirePost({ policy: { method_not_allowed: {          // an established API keeps its shape
 *     code: 'need_post', error: '{action} 需要 POST 请求', includeAction: true
 *   } } })
 *
 * @param respond - rejection sink, defaults to this block's `sendJson`, so the
 *   `no-store` header is not a thing a caller can forget to pass.
 * @param policy - optional per-reason `{ code, error, includeAction }` overrides
 *   keyed by `REQUIRE_POST_REASONS`; a partial override merges with the default,
 *   and an unknown key throws.
 */
export const createRequirePost = ({ respond = sendJson, policy } = {}) => {
  const overrides = policy || {}
  for (const key of Object.keys(overrides)) {
    if (!REQUIRE_POST_REASONS.includes(key)) {
      throw new Error(`createRequirePost: unknown policy key ${JSON.stringify(key)}; expected one of ${REQUIRE_POST_REASONS.join(', ')}`)
    }
  }
  const say = Object.fromEntries(REQUIRE_POST_REASONS.map((reason) => [
    reason,
    { ...DEFAULT_REQUIRE_POST_POLICY[reason], ...(overrides[reason] || {}) }
  ]))
  const render = (template, action) => String(template).replace(/\{action\}/g, action == null ? '' : String(action))

  return function requirePost(req, res, action) {
    if (String((req && req.method) || 'GET').toUpperCase() === 'POST') return true
    const words = say.method_not_allowed
    respond(res, 405, {
      ok: false,
      code: words.code,
      error: render(words.error, action),
      ...(words.includeAction ? { action } : {})
    })
    return false
  }
}

/**
 * Build the browser authorizer for a route that is guarded by RC1's Connection
 * when the host provides one, and by the plugin's own same-origin guard when it
 * does not.
 *
 * @param getConnection - `() => connection`, an ACCESSOR, never the value. A host
 *   half keeps its Connection in a closure variable that service unload/reload
 *   reassigns to `null` and later back to a new instance; a captured value would
 *   keep authorizing against a disposed Connection forever.
 * @param getConnectionSeen - `() => connectionSeen`, an accessor for the latch
 *   that records "this host has had an RC1 Connection at least once". Same
 *   reason, same consequence: read it per request.
 * @param guard - the plugin's bound request guard, used only on a host that has
 *   never had a Connection (older hosts, where the guard IS the boundary).
 * @param respond - rejection sink, defaults to this block's `sendJson`.
 * @returns `(req, res) => boolean`, true when the request may proceed.
 *
 * The decision order is the security property, so it is fixed here:
 *
 *   1. A Connection that throws is not a Connection that permits. The request is
 *      rejected 503 and must never fall through to the route handler.
 *   2. A rejection code from the Connection is final: the status is that code,
 *      401 reads as `unauthorized`, anything else as `forbidden`.
 *   3. No Connection but a seen one: 503, and deliberately NOT the guard. Once
 *      the host has had an RC1 Connection, an unload gap must not reopen the
 *      route through the weaker loopback fence — a local socket peer is not the
 *      same statement as an authorized browser.
 *   4. No Connection and none ever seen: this is a pre-RC1 host, and the
 *      plugin's own guard is the whole boundary, so it decides.
 *
 * These two codes and their wording state the decision itself rather than a
 * plugin's published vocabulary, so they are not policy and are not injectable;
 * only wording that legitimately differs between plugins belongs in a table.
 */
export const createBrowserAuthorizer = ({ getConnection, getConnectionSeen, guard, respond = sendJson }) => {
  if (typeof getConnection !== 'function') {
    throw new Error('createBrowserAuthorizer: getConnection must be an accessor (`() => connection`); a Connection captured here is stale the first time the service reloads')
  }
  if (typeof getConnectionSeen !== 'function') {
    throw new Error('createBrowserAuthorizer: getConnectionSeen must be an accessor (`() => connectionSeen`); the latch is set once an RC1 Connection exists and must never be read from a captured copy')
  }
  if (typeof guard !== 'function') {
    throw new Error('createBrowserAuthorizer: guard is required; a host without an RC1 Connection falls back to the plugin request guard')
  }

  return function authorizeBrowser(req, res) {
    const connection = getConnection()
    if (connection) {
      let rejection
      try {
        rejection = connection.requestRejection(req)
      } catch {
        return connectionUnavailable(res, respond)
      }
      if (rejection !== undefined) {
        respond(res, rejection, {
          ok: false,
          code: rejection === 401 ? 'unauthorized' : 'forbidden',
          error: rejection === 401 ? 'browser authentication required' : 'request rejected'
        })
        return false
      }
      return true
    }
    // Once an RC1 Connection has existed, a reload gap answers 503 — it does not
    // downgrade to the guard fence.
    if (getConnectionSeen()) return connectionUnavailable(res, respond)
    return guard(req, res)
  }
}

/**
 * Accept only a bounded, plausible session id from query or body input.
 * Returns the trimmed value or null; `null` is the caller's "missing/invalid"
 * signal, so an empty string never reaches a lookup.
 */
export function optionalSessionId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 512) return null
  return trimmed
}
// </dsh-host-http>

// 本插件的拒绝词表。两处与共享默认不同：无法识别对端地址时也回答
// `non_loopback_peer`，与来自回环之外的对端同一个码；不接受的 Host 回答
// `non_loopback`。
const TREEKEEPER_POLICY = {
  unknown_peer: { code: 'non_loopback_peer', error: 'non-loopback peer rejected' },
  non_loopback_host: { code: 'non_loopback', error: 'non-loopback host rejected' }
}

/**
 * treekeeper 的 /api 同源守卫。
 *
 * 实际检查在共享片段里；这里只绑定本插件的拒绝词表与 `sendJson` 接收函数。
 * 不传 `allowRemoteHost`，因此 treekeeper 的对端与 Host 标准保持绝对。调用方
 * 可以扩展 `policy`；未知键仍会走到共享工厂的校验，不会在这里被悄悄丢掉。
 */
export const treekeeperGuard = ({ policy, ...options } = {}) => bindGuard({
  ...options,
  respond: sendJson,
  policy: { ...(policy || {}), ...TREEKEEPER_POLICY }
})

/**
 * treekeeper 的 POST 门。检查与默认词表来自上面的宿主 HTTP 片段；本插件对外
 * 公布的错误码是 `method`，正好等于共享默认值，因此这里不覆盖策略。
 */
export const requirePost = createRequirePost()

// 不可信数值输入只接受一种形状：整数，或带空白的纯数字字符串；其余都是 null。
// `Number()` 会把 `''` 变成 0、`'1e9'` 变成 1000000000、`'0x10'` 变成 16、
// `'8.5'` 变成小数 pid。这里的值决定插件可以终止哪个进程，以及整机采样的频率，
// 因此调用方从未真正发送过的值必须由路由回答拒绝，不能变成它据以行动的强转结果。

/** 只接受普通整数：数字或纯数字字符串。 */
const asInteger = (raw) => {
  const n = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN)
  return Number.isInteger(n) ? n : null
}

/** Windows 的 pid 范围：pid 是操作系统分配的正整数。 */
export const PID_MAX = 4294967295

/** 一个不可信的 pid，或 null。绝不返回强转出来的数字。 */
export const normalizePidInput = (raw) => {
  const n = asInteger(raw)
  return n !== null && n >= 1 && n <= PID_MAX ? n : null
}

/** 一个不可信的创建时间（epoch 毫秒），或 null。 */
export const normalizeCreatedMsInput = (raw) => {
  const n = asInteger(raw)
  return n !== null && n >= 1 ? n : null
}

/**
 * 后台采样间隔的边界。`0` 仍然表示“只在请求时采样”；运行中的轮询必须落在范围
 * 内，一个配错的数字不能变成每个事件循环周期都启动一次整机 PowerShell 查询；
 * 其他值一律拒绝，不会静默变成 0。
 */
export const POLL_INTERVAL_MIN_MS = 2000
export const POLL_INTERVAL_MAX_MS = 600000
export const POLL_INTERVAL_OFF = 0

/** 一个不可信的轮询间隔：`0`（关闭）或范围内，否则 null。 */
export const normalizePollIntervalMs = (raw) => {
  const n = asInteger(raw)
  if (n === null) return null
  if (n === POLL_INTERVAL_OFF) return POLL_INTERVAL_OFF
  return n >= POLL_INTERVAL_MIN_MS && n <= POLL_INTERVAL_MAX_MS ? n : null
}

/**
 * 把 `20260825162958.5+480` 这样的 CIM 时间解析成 epoch 毫秒。值缺失或无法解析
 * 时返回 null。
 *
 * Windows PowerShell 5.1 不会把 CIM 时间序列化成字符串：`ConvertTo-Json` 把
 * .NET 的 `DateTime` 渲染成 `\/Date(1790745392422)\/`，到达这里时是
 * `/Date(1790745392422)/`。这种形式既不是 CIM 也不是 ISO，因此先于有序日期
 * 模式读取。只用数字，属性被拒绝时携带的 .NET 下限
 * `\/Date(-62135596800000)\/` 不会被当成真实创建时间。Windows PowerShell 7
 * 输出 ISO 形式，由下面 `Date.parse` 的后备分支处理。
 */
export function parseCimDate(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const dotnet = /^\/Date\((\d+)\)\/$/.exec(trimmed)
  if (dotnet) {
    const dotnetMs = Number(dotnet[1])
    return Number.isFinite(dotnetMs) ? dotnetMs : null
  }
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?\s*([+\-]\d{3,4})?$/.exec(trimmed)
  if (!m) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  const [, y, mo, d, h, mi, s, frac, off] = m
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, frac ? Math.round(+('0.' + frac) * 1000) : 0)
  if (off) {
    const sign = off[0] === '-' ? -1 : 1
    const digits = off.slice(1)
    const minutes = digits.length === 4 ? (+digits.slice(0, 2)) * 60 + (+digits.slice(2)) : +digits
    ms -= sign * minutes * 60000
  }
  return Number.isFinite(ms) ? ms : null
}

/**
 * 为重复检测规范化命令行：折叠空白并转为小写，让 cmd 与 bash 启动的同一条
 * 命令比较相等。
 */
export function normalizeCmdline(cmdline) {
  if (typeof cmdline !== 'string') return ''
  return cmdline.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 插件归因提示：从命令行里的 node_modules 路径取出包名。
 * `.../node_modules/@scope/pkg/...` → `@scope/pkg`，
 * `.../node_modules/pkg/...` → `pkg`。npx 缓存运行单独识别。
 */
export function pluginHint(cmdline) {
  if (typeof cmdline !== 'string') return null
  const viaNpx = /[\\/]_npx[\\/]/.test(cmdline)
  const re = /[\\/]node_modules[\\/]+(@[^\\/]+[\\/][^\\/]+|[^^\\/][^\\/]*)[\\/]/g
  let m
  let hit = null
  while ((m = re.exec(cmdline)) !== null) {
    const name = m[1].replace(/\\/g, '/')
    if (name === '.bin' || name === 'npm' || name === '.store') continue
    hit = name
    break
  }
  if (!hit) return null
  return { plugin: hit, viaNpx }
}

/**
 * 即使本宿主无法通过父进程链认领，也能看出进程属于 DSH 部署的特征：桌面启动器的
 * 映像名、桌面宿主启动时带的 internals 标志、Electron 包里的 `app.asar` 路径、
 * `$DSH_HOME` 下按 profile 划分的插件树、`_npx` 缓存运行，以及普通的
 * `node_modules` 依赖。
 *
 * `previousHost` 标出三个 DSH 特征足够强的路径信号，可以让残留进程被判定为属于
 * 一个已经结束的宿主。另外三个只用于排序：`node_modules` 与 `_npx` 描述的是包
 * 管理器，不能指向 DSH，因此可以决定列表顺序，永远不会单独构成幸存发现。
 */
export const DSH_PROCESS_SIGNALS = Object.freeze([
  { id: 'image', score: 5, previousHost: false, source: 'name', re: /^deepseek harness(\.exe)?$/i },
  { id: 'expose-internals', score: 4, previousHost: true, source: 'cmdline', re: /--expose-internals\b/i },
  { id: 'asar', score: 3, previousHost: true, source: 'cmdline', re: /app\.asar/i },
  { id: 'profile', score: 2, previousHost: true, source: 'cmdline', re: /[\\/]\.dsh[\\/]profiles[\\/]/i },
  { id: 'npx', score: 1, previousHost: false, source: 'cmdline', re: /[\\/]_npx[\\/]/i },
  { id: 'node_modules', score: 1, previousHost: false, source: 'cmdline', re: /[\\/]node_modules[\\/]/i }
])

/**
 * 一个进程的 DSH 相关度，形状为 `{ score, signals }`。score 为 0 表示没有任何
 * 信号命中。未归属集合覆盖整台机器，这个分数让面板可以排序：列表开头是 DSH
 * 相关的行，Windows 服务沉到后面。
 */
export function dshSignals(proc) {
  const name = String((proc && proc.name) || '')
  const cmdline = String((proc && proc.cmdline) || '')
  const signals = []
  let score = 0
  for (const signal of DSH_PROCESS_SIGNALS) {
    const hay = signal.source === 'name' ? name : cmdline
    if (!signal.re.test(hay)) continue
    signals.push(signal.id)
    score += signal.score
  }
  return { score, signals }
}

/** 进程带有被结束的宿主留下的 DSH 路径信号时为 true。 */
export function hasPreviousHostSignal(proc) {
  const { signals } = dshSignals(proc)
  return signals.some((id) => DSH_PROCESS_SIGNALS.find((signal) => signal.id === id)?.previousHost === true)
}

/**
 * 按 DSH 相关度排序未归属进程列表，高的在前；分数相同时按 pid 升序，因此同一份
 * 快照总是渲染成同一顺序。这里只排序，不过滤：集合保持完整，面板只显示它的开头。
 */
export function rankUnattributed(procs) {
  return (Array.isArray(procs) ? procs.slice() : []).sort((a, b) => {
    const diff = dshSignals(b).score - dshSignals(a).score
    if (diff !== 0) return diff
    return (Number(a.pid) || 0) - (Number(b.pid) || 0)
  })
}

/**
 * 指向桌面应用自身可执行文件的信号。下面的成员判定从信号表读取它，不直接写
 * 字面量，词表因此只有一处。
 */
const DESKTOP_APP_SIGNAL = DSH_PROCESS_SIGNALS.find((signal) => signal.id === 'image')

/**
 * 本插件可能被加载的两种 DSH 宿主。宿主在 `hostKind` 字段里回答其中之一，面板
 * 在宿主标识行上把桌面宿主显示成标签。
 */
export const HOST_KIND_DESKTOP = 'desktop'
export const HOST_KIND_WEB = 'web'

/**
 * 本进程属于哪一种 DSH 宿主，从进程自身的事实读取。桌面宿主运行 Electron 包，
 * 因此它的可执行文件指向 `app.asar`，或者启动时带了 `--expose-internals`；
 * `dsh web` 宿主运行在 node.exe 下，两者都不具备。
 *
 * Node 会把识别出的选项从 `argv` 移到 `execArgv`，因此两个列表都要看：运行中的
 * 宿主把它放在 `execArgv`，而采样器从操作系统读到的进程行仍然把它留在记录的
 * 命令行里。
 *
 * 环境变量不能作为证据。桌面应用会为它启动的进程导出 ELECTRON_RUN_AS_NODE，
 * 继承了这个变量的 `dsh web` 宿主只要按它匹配就会被读成桌面宿主。
 */
export function hostKind(proc = process) {
  const execPath = typeof (proc && proc.execPath) === 'string' ? proc.execPath : ''
  if (/app\.asar|dsh-desktop-host/i.test(execPath)) return HOST_KIND_DESKTOP
  const options = [].concat(
    (proc && Array.isArray(proc.execArgv)) ? proc.execArgv : [],
    (proc && Array.isArray(proc.argv)) ? proc.argv : []
  )
  for (const entry of options) {
    if (typeof entry !== 'string') continue
    if (/--expose-internals\b/i.test(entry)) return HOST_KIND_DESKTOP
  }
  return HOST_KIND_WEB
}

/**
 * 面板读取的未归属行：已排序，每行再带上由 DSH 信号推出的桌面应用成员标记。
 * 浏览器侧是独立的经典脚本，够不到本模块，因此这个事实随宿主已经发送的行一起
 * 过去——客户端渲染拿到的行，不再对整机命令行做第二次匹配。信号 id 本身留在这
 * 里：它们只用于选出成员，没有其他读者。
 *
 * 成员判定得到的是桌面应用自己的进程集合：映像名匹配桌面应用的行，加上在这个
 * 列表内沿父链能走到这些行的行。渲染进程、GPU 进程和网络工具进程也带同一个
 * 映像名，但只有主进程会是别人的父进程，因此识别这个集合靠父链，映像名信号是
 * 它的补充。闭包一直算到不再增长，成员判定因此与行的到达顺序无关。这里不过滤
 * 集合：行保留原来的排序与总数，只是多带一个布尔值，就像 `processes` 里每行
 * 已经带着自己的归因。
 */
export function unattributedRows(procs) {
  const rows = rankUnattributed(procs)
  const signals = new Map(rows.map((proc) => [Number(proc.pid), dshSignals(proc).signals]))
  const inApp = (proc) => DESKTOP_APP_SIGNAL !== undefined
    && signals.get(Number(proc.pid)).includes(DESKTOP_APP_SIGNAL.id)
  const app = new Set(rows.filter(inApp).map((row) => Number(row.pid)))
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows) {
      if (app.has(Number(row.pid)) || !app.has(Number(row.ppid))) continue
      app.add(Number(row.pid))
      grew = true
    }
  }
  return rows.map((row) => ({ ...row, desktopApp: app.has(Number(row.pid)) }))
}
