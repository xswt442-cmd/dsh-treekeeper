// dsh-treekeeper shared helpers: version, same-origin guard, JSON replies,
// post gate, CIM datetime parsing, cmdline normalization.
//
// The loopback predicates are not written here. They are embedded from
// dsh-mini-utility-dock at build time (see the marked block below) because three
// plugins kept three hand-maintained copies and they drifted twice — once
// rejecting IPv6 loopback everywhere, once disagreeing on which Host spellings
// count as loopback. Edit the dock fragment, then run `npm run loopback:sync`.

import os from 'node:os'
import path from 'node:path'

export const VERSION = '0.3.2'

// <dsh-loopback-helpers>
// Loopback predicates shared by the host halves of the DSH plugins.
//
// This fragment has ONE source of truth: dsh-mini-utility-dock/dist/loopback.js.
// DSH plugin host halves are plain Node ESM that each package ships standalone,
// so the fragment is embedded into `lib/shared.js` at build time by
//   npm run loopback:sync    (write it)
//   npm run loopback:check   (fail on drift)
// instead of being imported: a bare `import 'dsh-mini-utility-dock/...'` would
// put a runtime dependency on the dock into every plugin, and the whole point of
// the dock is that a plugin ships standalone, with nothing else required.
//
// Why it is shared at all: these predicates were copy-pasted per repo and
// drifted twice. The first drift rejected IPv6 loopback everywhere; the second
// is that consumers disagreed on which Host spellings count as loopback
// (see the parity bin this package ships, which compares this block across repositories).
//
// "Loopback" is decided in exactly one place — LOOPBACK_HOSTNAMES plus the
// IPv4-mapped IPv6 form of each entry — and both the name and the address
// predicate route through it, so the Host path and the peer path cannot drift
// apart again.
//
// Kept a separate fragment from the host guard on purpose: the predicates are
// stable facts about what an address is, while the guard is a policy about who
// may call an API. `dist/guard.js` imports this module, so the guard depends on
// this block and never the other way round.

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
// Host-side request guard shared by the DSH plugins.
//
// This fragment has ONE source of truth: dsh-mini-utility-dock/dist/guard.js.
// DSH plugin host halves are plain Node ESM that each package ships standalone,
// so the fragment is embedded into `lib/shared.js` at build time by
//   npm run guard:sync    (write it)
//   npm run guard:check   (fail on drift)
// instead of being imported: a bare `import 'dsh-mini-utility-dock/...'` would
// put a runtime dependency on the dock into every plugin, and the whole point of
// the dock is that a plugin ships standalone, with nothing else required.
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
// Why the guard is shared rather than reimplemented per plugin: each consumer
// carried its own `createGuard`, and the copies diverged repeatedly. The
// parts that differed were never the *decisions* — they were the error codes and
// message strings welded into the same function, which forced every repo to keep
// its own copy and made drift possible. Here the enforcement order and every
// decision are fixed, and the wording is supplied as data by the caller
// (`policy`), so a plugin customizes its vocabulary without forking the logic.

// Default ports each scheme normalises away, so an Origin carrying no explicit
// port (for example `http://127.0.0.1`) compares equal to a server on 80/443.
// `new URL('http://127.0.0.1:80').port` is '', which compared unequal to "80"
// and turned a legitimate same-origin request into a rejection.
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' }
export const portOf = (url) => url.port || DEFAULT_PORTS[url.protocol] || ''

// The reasons this guard can reject. Each is a stable, guard-owned name for one
// decision; the *reason* is fixed here, while the machine-readable `code` a
// plugin's API exposes and the human wording are policy.
//
// An unidentifiable peer and an off-loopback peer are deliberately distinct
// decisions. Two plugins answer `non_loopback_peer` for both; one distinguishes
// them. Both distinctions are correct for their own API, and a plugin that
// collapses them names the same `code` for each — nothing widens either way,
// because every reason rejects.
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
 * bound to its own error vocabulary, so the name it exports — usually
 * `createGuard`, matching its previous API — is its own to declare. This is the
 * one factory every plugin calls.
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
  'longlived.plugin-child'
])

/** Human-readable sentence for each rule; shown before the raw id. */
export const FINDING_RULE_DESCRIPTION = Object.freeze({
  'duplicate.cmdline': 'the same normalized command line is alive in several copies at once',
  'orphan.dead-parent': 'the recorded parent pid is missing from the current snapshot',
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

/** Send a JSON reply and end the response. */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(text)
}

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

/** Gate a mutating action behind POST; replies 405 on mismatch. */
export function requirePost(req, res, action) {
  if ((req.method || 'GET').toUpperCase() === 'POST') return true
  sendJson(res, 405, { ok: false, code: 'method', error: `action "${action}" requires POST` })
  return false
}

/**
 * Parse a CIM datetime like `20260825162958.5+480` into epoch ms.
 * Returns null when the value is missing or unparseable.
 */
export function parseCimDate(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?\s*([+\-]\d{3,4})?$/.exec(value.trim())
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
