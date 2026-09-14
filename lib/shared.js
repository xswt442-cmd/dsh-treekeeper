// dsh-treekeeper shared helpers: version, same-origin guard, JSON replies,
// post gate, CIM datetime parsing, cmdline normalization.
//
// The loopback predicates are not written here. They are embedded from
// dsh-mini-utility-dock at build time (see the marked block below) because three
// plugins kept three hand-maintained copies and they drifted twice — once
// rejecting IPv6 loopback everywhere, once disagreeing on which Host spellings
// count as loopback. Edit the dock fragment, then run `npm run loopback:sync`.

export const VERSION = '0.2.2'

// <dsh-loopback-helpers>
// Loopback predicates shared by the host halves of the DSH plugins.
//
// This fragment has ONE source of truth: dsh-mini-utility-dock/dist/loopback.js.
// DSH plugin host halves are plain Node ESM that each package ships standalone,
// so the fragment is embedded into `lib/shared.js` at build time by
//   npm run loopback:sync    (write it)
//   npm run loopback:check   (fail on drift)
// instead of being imported: a bare `import 'dsh-mini-utility-dock/...'` would
// put a runtime dependency on the dock into every plugin, and the whole point
// of the dock is that a plugin works with no sibling installed.
//
// Why it is shared at all: these predicates were copy-pasted per repo and
// drifted twice. The first drift rejected IPv6 loopback in all three plugins;
// the second made the three disagree on which Host spellings count as loopback
// (see scripts/guard-parity.mjs, which compares this block across repos).
//
// "Loopback" is decided in exactly one place — LOOPBACK_HOSTNAMES plus the
// IPv4-mapped IPv6 form of each entry — and both the name and the address
// predicate route through it, so the Host path and the peer path cannot drift
// apart again.

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
 * Accepts the documented spellings, the IPv4-mapped IPv6 form of any of them,
 * and folds case. Fails closed on everything else, including a missing name.
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

/** Send a JSON reply and end the response. */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(text)
}

/**
 * Same-origin guard for the /api route (the dsh-instance-manager pattern):
 * reject browser-initiated cross-site traffic via Fetch Metadata, a foreign
 * Origin, or a non-loopback Host header (also closes DNS rebinding). The
 * network peer is decided by the TCP peer address, never the Host header —
 * DSH may listen on 0.0.0.0, so a remote client can still send a loopback
 * Host. Peer/host-side callers (plain node:http) arrive over loopback and
 * keep working.
 *
 * Neither the hostname predicate nor the address predicate is defined here: both
 * come from the embedded loopback fragment. A private copy beside the shared one
 * is exactly how the three plugins drifted apart, so this guard branches only on
 * the shared helpers, and nothing about the Host parser is injectable.
 */
export function createGuard({ currentPort } = {}) {
  const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' }
  const portOf = (url) => url.port || DEFAULT_PORTS[url.protocol] || ''
  const isAllowedOrigin = (origin, expectedPort) => {
    try {
      const url = new URL(origin)
      return isLoopbackName(hostHostname(url.hostname)) &&
        (expectedPort === undefined || portOf(url) === String(expectedPort))
    } catch {
      return false
    }
  }
  return function guard(req, res) {
    const expectedPort = typeof currentPort === 'function' ? currentPort() : currentPort
    // The peer address, not the Host header, decides whether this is a local
    // request: DSH supports listening on 0.0.0.0, where any remote client can
    // send `Host: 127.0.0.1`.
    if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
      sendJson(res, 403, { ok: false, code: 'non_loopback_peer', error: 'non-loopback peer rejected' })
      return false
    }
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      sendJson(res, 403, { ok: false, code: 'cross_site', error: 'cross-site request rejected' })
      return false
    }
    const origin = req.headers.origin
    if (origin) {
      if (!isAllowedOrigin(origin, expectedPort)) {
        sendJson(res, 403, { ok: false, code: 'foreign_origin', error: 'foreign origin rejected' })
        return false
      }
    }
    const rawHost = req.headers.host
    if (rawHost) {
      const reqHost = hostHostname(rawHost)
      // An empty parse is not permission. A Host header that carries no usable
      // hostname — an unbracketed IPv6 literal such as `::1:3080`, which RFC 7230
      // forbids but a client can still send — parses to '', and a bare truthiness
      // test would skip the allowlist entirely. Fail closed instead.
      if (!reqHost || !isLoopbackName(reqHost)) {
        sendJson(res, 403, { ok: false, code: 'non_loopback', error: 'non-loopback host rejected' })
        return false
      }
    }
    return true
  }
}

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
