// dsh-treekeeper shared helpers: version, same-origin guard, JSON replies,
// post gate, CIM datetime parsing, cmdline normalization.

export const VERSION = '0.2.0'

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
 * Origin, or a non-loopback Host header (also closes DNS rebinding).
 * Peer/host-side callers (plain node:http) carry none of these headers and
 * keep working.
 */
export function createGuard({ hostHostname } = {}) {
  const isLoopbackName = (name) => {
    const n = String(name || '').toLowerCase()
    return n === 'localhost' || n === '127.0.0.1' || n === '[::1]' || n === '::1' || n.endsWith('.localhost')
  }
  return function guard(req, res) {
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      sendJson(res, 403, { ok: false, code: 'cross_site', error: 'cross-site request rejected' })
      return false
    }
    const origin = req.headers.origin
    if (origin) {
      let host = ''
      try { host = new URL(origin).host } catch { host = '' }
      if (!host || !isLoopbackName(host.split(':')[0])) {
        sendJson(res, 403, { ok: false, code: 'foreign_origin', error: 'foreign origin rejected' })
        return false
      }
    }
    const reqHost = hostHostname
      ? hostHostname(req.headers.host || '')
      : String(req.headers.host || '').split(':')[0]
    if (reqHost && !isLoopbackName(reqHost)) {
      sendJson(res, 403, { ok: false, code: 'non_loopback', error: 'non-loopback host rejected' })
      return false
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
