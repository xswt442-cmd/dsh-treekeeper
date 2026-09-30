// dsh-treekeeper shared helpers: version, same-origin guard, JSON replies,
// post gate, CIM datetime parsing, cmdline normalization.
//
// The loopback predicates are not written here. They are embedded from
// dsh-mini-utility-dock at build time (see the marked block below) because a
// hand-maintained copy of them drifts, and this one drifted twice — once
// rejecting IPv6 loopback everywhere, once disagreeing on which Host spellings
// count as loopback. Edit the dock fragment, then run `npm run loopback:sync`.
//
// The response glue (`sendJson`, the POST gate, the browser authorizer,
// `optionalSessionId`) is embedded the same way by `npm run http:sync`; the local
// copies of those lines are gone, because the same two-line reply helper existed
// here in more than one shape and only some shapes carried
// `cache-control: no-store`.

import os from 'node:os'
import path from 'node:path'

export const VERSION = '0.3.6'

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

// Keep one policy list for findings and the destructive path. These are not
// merely noisy findings: terminating them can make Windows unusable.
export const PROTECTED_PROCESS_NAMES = new Set([
  'system', 'idle', 'smss', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'svchost', 'explorer', 'dwm', 'fontdrvhost', 'sihost'
])

/**
 * Finding vocabulary (DTK-M1). Every finding carries three *enumerated*
 * fields so the noise policy is data, not taste — M2 (session entry) and M3
 * (finer alerting) filter on these instead of re-deriving their own rules.
 *
 *   rule       which heuristic fired. Namespaced so new rules can join
 *              without colliding with the legacy flat `type` tag.
 *   confidence how hard the conclusion is — NOT how urgent it looks:
 *                exact      attributed into the host tree through a live
 *                           parent chain, sampled at full fidelity
 *                indicative degraded sample (no parent chain): the evidence
 *                           is real, the link is softer
 *                inferred   no attribution at all; the rule fired on a
 *                           heuristic alone, never a kill candidate
 *   provenance which check produced the finding: { rule, description }.
 *              `rule` mirrors the flat `rule` field; `description` is the
 *              human-readable sentence a reviewer reads first.
 *   ownership  who the process claims to belong to and how that was derived:
 *                scope  host-descendant | session | job | unattributed
 *                via    ppid-chain | root-itself | job-label | none
 *              `session` / `job` are filled by the ledger join, which is
 *              indicative (job label ≈ cmdline) and never raises confidence.
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

/** Human-readable sentence for each rule; shown before the raw id. */
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
 * Three-state contract for the subagent tree section (DTK-M2). The client
 * panel lives on the root `shell.overlay` slot, so it must say what it is
 * missing instead of guessing:
 *
 *   available    a root session was resolved and the mounted DSH seam can
 *                enumerate its descendants
 *   root-required the caller supplied no root session (no session selected)
 *   unavailable  the mounted DSH build lacks the subagents seam
 *
 * `listDescendants` result `null` means the capability is absent; the empty
 * array (no root supplied) is not a capability failure. Host and client keep
 * this one ordering so a stale panel and a fresh request can never disagree.
 */
export function subagentAvailability(rootSessionId, subagentsResult) {
  if (subagentsResult === null) return 'unavailable'
  if (rootSessionId == null) return 'root-required'
  return 'available'
}

/**
 * Resolve the harness home with the same precedence as
 * @deepseek-ai/dsh-home-paths: a non-blank $DSH_HOME, otherwise ~/.dsh.
 *
 * This is the fallback for a host that offers no accessor of its own; plugin
 * code calls hostDshHome() so a DSH host answers with the harness's own rule.
 *
 * Existence is deliberately NOT a criterion — the harness accepts a home that
 * does not exist yet and creates it on demand, so requiring the directory here
 * made this plugin fall back elsewhere on a first run with a fresh $DSH_HOME,
 * splitting its history away from the very host it was watching. A blank
 * override counts as unset, so a stray DSH_HOME=" " can never collapse the
 * home onto the current directory.
 */
export function resolveDshHome(env = process.env, homeDir = os.homedir()) {
  const raw = env.DSH_HOME
  const selected = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
  const value = selected === null ? path.join(homeDir, '.dsh') : selected
  // resolve() last, exactly like dshHomePath: the result is absolute on every
  // platform whether it came from the environment, the OS home, or a tilde.
  if (value === '~') return path.resolve(homeDir)
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.resolve(path.join(homeDir, value.slice(2)))
  return path.resolve(value)
}

/**
 * Resolve the harness home for the host this plugin is mounted in, preferring
 * the host's own answer.
 *
 * The boot layer provides `dshHomePath` before the plugin tree mounts, and the
 * harness owns that rule alone: history written under a home this file derives
 * slightly differently lands where the host will never look, which is the
 * failure the existence note above records hitting once already. The accessor
 * is a plain function rather than a service and the generated Cordis catalog
 * excludes it, so it is read with `ctx.get` and its absence is ordinary, not
 * exceptional: a bare Cordis embedder mounting this plugin without the boot
 * layer falls back to resolveDshHome().
 *
 * Re-read per call, like the environment read it replaces, so a home switched
 * between calls is observed rather than frozen at mount.
 */
export function hostDshHome(ctx) {
  // A real Cordis context always carries `get`; the route suites mount apply()
  // with a two-key stub, and this probe is not worth a new mount requirement.
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

// treekeeper's rejection vocabulary. Only `unknown_peer` differs from the shared
// default: this plugin has always answered `non_loopback_peer` for a peer it
// cannot identify as well as for one that is off-loopback, and `non_loopback`
// for a Host it will not admit.
const TREEKEEPER_POLICY = {
  unknown_peer: { code: 'non_loopback_peer', error: 'non-loopback peer rejected' },
  non_loopback_host: { code: 'non_loopback', error: 'non-loopback host rejected' }
}

/**
 * treekeeper's same-origin guard for the /api route.
 *
 * The enforcement lives in the shared fragment; this binds only this plugin's
 * rejection vocabulary and its `sendJson` sink. It passes no `allowRemoteHost`,
 * so for treekeeper the peer and Host criteria stay absolute. A caller may extend
 * `policy`; an unknown key still reaches the shared factory's validation rather
 * than being dropped here.
 */
export const treekeeperGuard = ({ policy, ...options } = {}) => bindGuard({
  ...options,
  respond: sendJson,
  policy: { ...(policy || {}), ...TREEKEEPER_POLICY }
})

/**
 * treekeeper's POST gate. The enforcement and the default vocabulary come from
 * the host-HTTP fragment above; this plugin's published code is `method`, which
 * is exactly the shared default, so no policy override is bound here.
 */
export const requirePost = createRequirePost()

// Untrusted numeric input, accepted in exactly one shape: an integer or
// a whitespace-padded digit string survives, everything else is null. `Number()`
// would have quietly turned `''` into 0, `'1e9'` into 1000000000, `'0x10'` into 16
// and `'8.5'` into a fractional pid. Here the value names a process the plugin may
// terminate and a cadence that samples the whole machine, so a value the client
// never actually sent must be a refusal the route answers, never a coercion it
// acts on.

/** Accept only plain integers, as a number or a digit string. */
const asInteger = (raw) => {
  const n = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN)
  return Number.isInteger(n) ? n : null
}

/** Windows pid range (a pid is a positive integer the OS hands out). */
export const PID_MAX = 4294967295

/** One untrusted pid, or null. Never a coerced number. */
export const normalizePidInput = (raw) => {
  const n = asInteger(raw)
  return n !== null && n >= 1 && n <= PID_MAX ? n : null
}

/** One untrusted creation time in epoch ms, or null. */
export const normalizeCreatedMsInput = (raw) => {
  const n = asInteger(raw)
  return n !== null && n >= 1 ? n : null
}

/**
 * Bounds for the background sample cadence. `0` keeps meaning "sample on request
 * only"; a running poll stays inside the range so one misconfigured number cannot
 * schedule a whole-machine PowerShell query on every tick of the event loop, and
 * anything else is a refusal rather than a silent 0.
 */
export const POLL_INTERVAL_MIN_MS = 2000
export const POLL_INTERVAL_MAX_MS = 600000
export const POLL_INTERVAL_OFF = 0

/** One untrusted poll interval: `0` (off) or inside the range, else null. */
export const normalizePollIntervalMs = (raw) => {
  const n = asInteger(raw)
  if (n === null) return null
  if (n === POLL_INTERVAL_OFF) return POLL_INTERVAL_OFF
  return n >= POLL_INTERVAL_MIN_MS && n <= POLL_INTERVAL_MAX_MS ? n : null
}

/**
 * Parse a CIM datetime like `20260825162958.5+480` into epoch ms.
 * Returns null when the value is missing or unparseable.
 *
 * Windows PowerShell 5.1 does not serialize a CIM datetime as a string at
 * all: `ConvertTo-Json` renders the .NET `DateTime` as `\/Date(1790745392422)\/`,
 * which arrives here as `/Date(1790745392422)/`. That form is neither CIM nor
 * ISO, so it is read before the ordered-date pattern. Digits only, so the
 * .NET floor `\/Date(-62135596800000)\/` that a refused property can carry is
 * not read as a real creation time. Windows PowerShell 7 emits the ISO form,
 * which the `Date.parse` fallback below already covered.
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
 * Normalize a command line for duplicate detection: collapse whitespace and
 * unify separators so `npx -y pkg` from cmd vs bash compares equal.
 */
export function normalizeCmdline(cmdline) {
  if (typeof cmdline !== 'string') return ''
  return cmdline.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Plugin attribution hint: extract a package name from a node_modules path
 * inside the command line. `.../node_modules/@scope/pkg/...` → `@scope/pkg`,
 * `.../node_modules/pkg/...` → `pkg`. Detects npx cache runs separately.
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
 * What makes a process recognizable as part of a DSH deployment even when this
 * host cannot claim it through a parent chain: the desktop launcher's image
 * name, the internals flag the desktop host is spawned with, the `app.asar`
 * path read out of the Electron bundle, the per-profile plugin tree under
 * `$DSH_HOME`, an `_npx` cache run, or a plain `node_modules` dependency.
 *
 * `previousHost` marks the three path signals that are DSH-specific enough to
 * accuse a leftover of belonging to a host that died. The other three are
 * ranking signals only: `node_modules` and `_npx` describe a package manager,
 * not DSH, so they may order a list but never raise a survivor finding.
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
 * DSH-relatedness of one process as `{ score, signals }`. Score 0 means none of
 * the signals matched. The unattributed bucket is machine-wide, so this is what
 * lets a panel order it: the top of the list becomes the DSH-adjacent rows and
 * the Windows services fall below the fold.
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

/** True when a process carries one of the DSH-path signals a dead host leaves behind. */
export function hasPreviousHostSignal(proc) {
  const { signals } = dshSignals(proc)
  return signals.some((id) => DSH_PROCESS_SIGNALS.find((signal) => signal.id === id)?.previousHost === true)
}

/**
 * Order an unattributed process list by DSH-relatedness, highest first, ties
 * broken by ascending pid so the same snapshot always renders in the same
 * order. Sorting, never filtering: the bucket stays whole, only its head is
 * what a panel shows.
 */
export function rankUnattributed(procs) {
  return (Array.isArray(procs) ? procs.slice() : []).sort((a, b) => {
    const diff = dshSignals(b).score - dshSignals(a).score
    if (diff !== 0) return diff
    return (Number(a.pid) || 0) - (Number(b.pid) || 0)
  })
}

/**
 * The signal that names the desktop application's own executable. Membership
 * below reads it from the signal table rather than naming the literal, so the
 * vocabulary stays in one place.
 */
const DESKTOP_APP_SIGNAL = DSH_PROCESS_SIGNALS.find((signal) => signal.id === 'image')

/**
 * The two kinds of DSH host this plugin can be loaded into. A host answers one of
 * these in its `hostKind` field, and the panel shows the desktop one as a label
 * on the host identity row.
 */
export const HOST_KIND_DESKTOP = 'desktop'
export const HOST_KIND_WEB = 'web'

/**
 * Which kind of DSH host this process is, read from the process facts
 * themselves. The desktop host runs the Electron bundle, so either its
 * executable points into `app.asar` or the bundle is launched with
 * `--expose-internals`; a `dsh web` host runs under node.exe and carries
 * neither.
 *
 * Node moves the options it recognizes out of `argv` and into `execArgv`, so the
 * flag is looked for in both lists: a live host shows it in `execArgv`, while a
 * process row the sampler read from the operating system still shows it inside
 * the recorded command line.
 *
 * The environment is not evidence here. The desktop application exports
 * ELECTRON_RUN_AS_NODE for the processes it starts, so a `dsh web` host that
 * inherits the variable would be read as a desktop one by any match on it.
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
 * Unattributed rows as the panel reads them: ranked, each stamped with the
 * desktop-application membership derived from its DSH signals. The browser half
 * is a standalone classic script and cannot reach this module, so the fact
 * crosses the boundary on the rows the host already sends — the client renders
 * the rows it is handed instead of matching the machine's command lines a second
 * time. The signal ids themselves stay here: they select the membership and no
 * reader consumes them.
 *
 * Membership is the application's own process set: the rows whose image name
 * matches the desktop application, plus every row whose parent chain inside this
 * list reaches one of them. The renderer, the GPU process and the network
 * utility all carry that image name as well, but only the main process is a
 * parent, so the parent chain is what identifies the set and the signal alone is
 * its fallback. The closure runs to a fixed point, so membership does not depend
 * on the order the rows arrive in. The bucket is not filtered here: the rows keep
 * their rank and their count, and each carries one more boolean the way every row
 * in `processes` already carries its attribution.
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
