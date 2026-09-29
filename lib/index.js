// dsh-treekeeper host half.
//
// JSON endpoint on the webserver (same-origin guarded, the standard DSH
// plugin-route pattern):
//
//   GET  /dsh-treekeeper/api?action=snapshot   full OS sample + attribution
//                                              + leaks + ledger + reconcile
//   GET  /dsh-treekeeper/api?action=jobs       ledger rows only
//   GET  /dsh-treekeeper/api?action=history    recent leak findings
//   POST /dsh-treekeeper/api?action=kill       { pid, seenCreatedMs } guarded tree kill
//
// Security model: Fetch Metadata + Origin + loopback Host guard on every
// request, mutating actions POST-only. The kill path adds its own gates in
// lib/act.js (creation-time precheck, whitelist, protected names).
//
// Layer map:
//   Layer 1 ledger   → lib/ledger.js   (jobs registry, subagent genealogy)
//   Layer 2 OS       → lib/sampler.js + lib/attribute.js + lib/leak.js
//   Layer 3 actions  → lib/act.js      (guarded tree kill)
//   join             → lib/reconcile.js

import { sample, SAMPLER_UNSUPPORTED_PLATFORM } from './sampler.js'
import { attribute, subtreeOf } from './attribute.js'
import { findAncestorPids, processRows } from './roots.js'
import { collectFindings, applyLedgerOwnership } from './leak.js'
import { createJobLedger, createSubagentTree } from './ledger.js'
import { reconcile } from './reconcile.js'
import { killTree, decideKillEntry, decideKillConfirm } from './act.js'
import { HistoryStore } from './store.js'
// `sendJson`, `requirePost` and `optionalSessionId` come from the dock's
// host-HTTP fragment embedded in lib/shared.js, not from local copies: one
// reply shape, written in one place, is what keeps `cache-control: no-store`
// from going missing again.
import {
  VERSION, sendJson, requirePost, optionalSessionId, createBrowserAuthorizer,
  treekeeperGuard, pluginHint, subagentAvailability, resolveDshHome,
  normalizePidInput, normalizeCreatedMsInput, normalizePollIntervalMs,
  POLL_INTERVAL_OFF, POLL_INTERVAL_MIN_MS, POLL_INTERVAL_MAX_MS
} from './shared.js'

// Export a callable default entry. This is the least ambiguous Cordis plugin
// shape across the normal and reload loader paths; named exports remain for
// tooling that inspects module namespaces.
export const inject = ['webServer']

/**
 * The two body-level refusals every POST route answers before it reads a field.
 * Returns false when the response has already been written:
 *
 *   413 `body_too_large`  more than the read budget arrived.
 *   400 `bad_json`        a body that is not a JSON object. A truncated kill body
 *                         parses to `{}`, which the gates would read as a request
 *                         that named no pid and answer 409 `snapshot_required` —
 *                         telling the caller to refresh a snapshot for a request
 *                         that never named one.
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
 * Kill codes whose `detail` is a pid or a process name, written by this plugin.
 * The remaining refusals carry raw taskkill / PowerShell text; that text is
 * useful to whoever reads the host log or `history.jsonl`, and is not something
 * to hand to a browser.
 */
const SAFE_KILL_DETAIL_CODES = new Set(['protected', 'protected_descendant'])

/**
 * Untrusted request text, made safe for one host log line.
 *
 * The caller picks `action`, so a line break inside it would start a second log
 * row that reads as though this plugin wrote it, and an unbounded value would
 * turn the log into a copy of whatever was sent. Fold breaks into spaces and
 * cut the value: the action vocabulary here is nine characters, so the bound is
 * never what clips a legitimate request.
 */
function logField(value, max = 80) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max)
}

/**
 * Mount the host half.
 *
 * @param ctx the DSH plugin context (only `webServer` is required).
 * @param [overrides] test seam for the two OS-touching collaborators, `sample`
 *   and `killTree`. Cordis calls `apply(ctx)`; the defaults are the real
 *   sampler and the real guarded kill, so nothing about the shipped behavior
 *   changes — but a test can drive every route outcome, including a degraded
 *   sample and a failed taskkill, without a process on the machine.
 */
export function apply(ctx, overrides = {}) {
    const deps = { sample, killTree, ...overrides }
    const ws = ctx.webServer
    if (ws === undefined) return

    const startedAt = Date.now()
    const KILL_SNAPSHOT_MAX_AGE_MS = 15 * 1000
    // Refusal text for the two kill gates: what to do about a stale snapshot,
    // versus a target that is simply not ours to terminate.
    const killRefusalText = (code) => code === 'snapshot_required'
      ? 'refresh a complete process snapshot before terminating'
      : 'target is not part of the DSH host tree'
    const config = {
      pollMs: 0,             // 0 = sample on request only; >0 enables background polling
      duplicateMinCopies: 3,
      longLivedMs: 30 * 60 * 1000,
      allowKill: true,
      extraWhitelistPids: []
    }

    const dshHome = () => resolveDshHome(process.env)
    const history = new HistoryStore(dshHome())
    const jobLedger = createJobLedger(ctx)
    const subagentTree = createSubagentTree(ctx)

    // Known roots: the harness process itself plus everything above it up to
    // the launcher (electron/node chain), so manager-spawned instances and this
    // process's own children land in attributed buckets. The pid walk up is
    // done per snapshot via the parent chain of process.pid.
    let launchChain = new Set()

    let lastSnapshot = null
    async function takeSnapshot() {
      const { procs, degraded, cimError } = await deps.sample()
      // Ancestors are protected but never attribution roots: using Electron or
      // a launcher as a root would claim its unrelated sibling processes.
      launchChain = findAncestorPids(procs, process.pid)
      const roots = new Map()
      roots.set(process.pid, 'harness')
      for (const pid of config.extraWhitelistPids) roots.set(Number(pid), 'whitelisted')
      const attribution = attribute(procs, roots, {
        pluginHint
      })
      const findings = collectFindings(procs, attribution, {
        minCopies: config.duplicateMinCopies,
        olderThanMs: config.longLivedMs,
        // A degraded sample has no parent chain, so every finding it does
        // produce stays at `indicative` instead of claiming `exact`.
        degraded
      })
      if (findings.length > 0) {
        await history.append({ kind: 'findings', count: findings.length, types: findings.map((f) => f.type) })
      }
      lastSnapshot = {
        takenAt: Date.now(),
        procs,
        degraded,
        cimError: cimError ?? null,
        attribution: Object.fromEntries([...attribution.attributed].map(([pid, info]) => [pid, info])),
        processes: processRows(procs, attribution),
        unknown: attribution.unknown,
        findings
      }
      return lastSnapshot
    }

    // Optional background polling (history feed). Off by default: the panel
    // samples on open, and a poll cadence is a settings decision.
    let pollTimer = null
    function setPoll(ms) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      // Both bounds, restated as a guard for a caller from inside the process: a
      // route request never reaches here out of range, because
      // normalizePollIntervalMs has already answered it 400 `bad_poll_ms`. A
      // value that is neither `0` nor inside the documented range arms no timer
      // and records `pollMs` as 0 — the fail-safe reading, never a silent pass.
      if (Number.isFinite(ms) && ms >= POLL_INTERVAL_MIN_MS && ms <= POLL_INTERVAL_MAX_MS) {
        config.pollMs = ms
        pollTimer = setInterval(() => {
          takeSnapshot().catch((e) => {
            // A background sample that fails must not vanish: lastSnapshot
            // silently goes stale and the panel keeps rendering old data with
            // no hint why. One stderr line per failure is the cheapest honest
            // signal; the poll keeps retrying either way.
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
    // The decision order is the `dsh-host-http` fragment's property; see `createBrowserAuthorizer`.
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
        // Hoisted so the catch can name what failed; `const` inside the try would
        // be out of scope exactly where the log line needs it.
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
            // Fill the session/job half of finding.ownership from this
            // request's ledger join before the findings go out.
            applyLedgerOwnership(snap.findings, rec.rows)
            sendJson(res, 200, {
              ok: true,
              version: VERSION,
              pid: process.pid,
              port: ws.port,
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
            // normalizePidInput, not Number(): `Number('') || 0` folds an absent
            // or nonsense pid into 0, so a reader cannot tell a missing pid from a
            // coerced one. Both normalize to null and answer the same refusal.
            const pid = normalizePidInput(u.searchParams.get('pid'))
            if (pid === null) { sendJson(res, 400, { ok: false, code: 'bad_pid', error: 'pid must be a positive integer' }); return }
            const { procs } = await deps.sample()
            sendJson(res, 200, { ok: true, pid, subtree: subtreeOf(procs, pid) })
            return
          }
          if (action === 'history') {
            // `degraded` separates "no history yet" from "the audit trail is not
            // being written" — a reader of this endpoint cannot tell them apart
            // from an empty row list alone.
            sendJson(res, 200, { ok: true, rows: await history.last(100), degraded: history.degraded })
            return
          }
          if (action === 'config') {
            if (requirePost(req, res, 'config')) {
              // Minimal runtime knobs; persisted config comes with M2.
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
            // An unnamed or malformed target is a bad request, not a stale
            // snapshot: telling the caller to refresh would send them to do the
            // one thing that cannot help.
            if (pid === null) { sendJson(res, 400, { ok: false, code: 'bad_pid', error: 'pid must be a positive integer' }); return }
            if (seenCreatedMs === null) { sendJson(res, 400, { ok: false, code: 'bad_created_ms', error: 'seenCreatedMs must be a creation time in epoch milliseconds' }); return }
            // The refusals live in act.js as pure functions, so every one of them
            // is covered on any platform; this route only gathers the facts and
            // executes what the gates allow.
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
            // The protected-descendant check has to run on live data: a
            // snapshot up to 15s old cannot see a protected pid that appeared
            // after it, and `taskkill /T` would take it down as collateral.
            // Re-sample and re-verify the target's identity immediately before
            // the pull. What remains is the window between this sample and the
            // OS call; no user-mode check can close it, so the guarantee is
            // "as fresh as the last sample", not "atomic". The same sample
            // feeds killTree's protected-descendant scan below.
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
            // The full record, including any OS text, goes to the history file —
            // that is the audit trail. The response carries the code and, for the
            // two codes whose detail is a pid or a process name, that detail; a
            // `taskkill_failed` / `verify_failed` detail is raw PowerShell or
            // taskkill output and stays out of the browser.
            await history.append({ kind: 'kill', ...result, pid })
            sendJson(res, result.ok ? 200 : 409, { ok: result.ok, code: result.code, ...(SAFE_KILL_DETAIL_CODES.has(result.code) ? { detail: result.detail } : {}) })
            return
          }
          // The echoed action is capped: it is attacker-controlled text reflected
          // into a response body, and the bounded-length rule the session id
          // follows applies here for the same reason.
          sendJson(res, 400, { ok: false, code: 'bad_action', error: `unknown action "${action.slice(0, 64)}"` })
        } catch (e) {
          if (requestController.signal.aborted) return
          // A stable code, one fixed sentence, and the real cause in the host log:
          // the raw exception text names paths, commands, and Windows error
          // strings that mean nothing in a panel and everything in a log file.
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

    // cordis idiom (matches the DSH host source). on('dispose') also works,
    // but effect() is what the upstream host uses.
    ctx.effect(() => () => {
      if (pollTimer) clearInterval(pollTimer)
      if (typeof disposeRoute === 'function') disposeRoute()
    })
}

apply.inject = inject

export default apply

function attributionOf(snap) {
  // Rebuild the Map shape reconcile() expects from the serialized snapshot.
  const attributed = new Map()
  for (const [pid, info] of Object.entries(snap.attribution || {})) {
    attributed.set(Number(pid), info)
  }
  return { attributed }
}

/**
 * Read and parse a JSON request body.
 *
 * Three distinguishable outcomes, because the routes have to answer them with
 * different codes:
 *
 *   `{ tooLarge: true }`   more than 65536 bytes arrived. Settled the moment the
 *                          limit passes, without destroying the request: the
 *                          response is already on its way and RST-ing the socket
 *                          would hide it.
 *   `{ parseError: true }` a body that is not a JSON object. It stays distinct from
 *                          `{}` so `readBodyGuard` answers 400 `bad_json`, rather
 *                          than reading a truncated kill request as a body that
 *                          is absent.
 *   `{}`                   no body at all, or a stream that closed/errored before
 *                          `end`. Still a legitimate "nothing to act on".
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
      // A bare string, number, or array is valid JSON but is not a request body
      // this API can read fields out of, so it joins the parse failure rather
      // than reaching a gate as an empty object.
      finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { parseError: true })
    })
    req.on('error', () => finish({}))
    req.on('close', () => finish({}))
  })
}
