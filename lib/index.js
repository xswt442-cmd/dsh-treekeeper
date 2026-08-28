// dsh-treekeeper host half.
//
// JSON endpoint on the webserver (same-origin guarded, the
// dsh-instance-manager pattern):
//
//   GET  /dsh-treekeeper/api?action=snapshot   full OS sample + attribution
//                                              + leaks + ledger + reconcile
//   GET  /dsh-treekeeper/api?action=jobs       ledger rows only
//   GET  /dsh-treekeeper/api?action=history    recent leak findings
//   POST /dsh-treekeeper/api?action=kill       { pid, seenCreatedMs } guarded tree kill
//
// Security model mirrors dim: Fetch Metadata + Origin + loopback Host guard
// on every request, mutating actions POST-only. The kill path adds its own
// gates in lib/act.js (creation-time precheck, whitelist, protected names).
//
// Layer map (testplace/dsh-treekeeper-what-to-do.md §4):
//   Layer 1 ledger   → lib/ledger.js   (jobs registry, subagent genealogy)
//   Layer 2 OS       → lib/sampler.js + lib/attribute.js + lib/leak.js
//   Layer 3 actions  → lib/act.js      (guarded tree kill)
//   join             → lib/reconcile.js

import fs from 'node:fs'
import path from 'node:path'
import { sample } from './sampler.js'
import { attribute, subtreeOf } from './attribute.js'
import { findAncestorPids, processRows } from './roots.js'
import { collectFindings } from './leak.js'
import { listJobs } from './ledger.js'
import { reconcile } from './reconcile.js'
import { killTree } from './act.js'
import { HistoryStore } from './store.js'
import { VERSION, sendJson, requirePost, createGuard } from './shared.js'

export default {
  inject: ['webServer'],
  apply(ctx) {
    const ws = ctx.webServer
    if (ws === undefined) return

    const startedAt = Date.now()
    const KILL_SNAPSHOT_MAX_AGE_MS = 15 * 1000
    const config = {
      pollMs: 0,             // 0 = sample on request only; >0 enables background polling
      duplicateMinCopies: 3,
      longLivedMs: 30 * 60 * 1000,
      allowKill: true,
      extraWhitelistPids: []
    }

    const dshHome = () => {
      const h = process.env.DSH_HOME
      if (h && fs.existsSync(h)) return h
      return path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
    }
    const history = new HistoryStore(dshHome())

    // Known roots: the harness process itself plus everything above it up to
    // the launcher (electron/node chain), so dim-spawned instances and this
    // process's own children land in attributed buckets. The pid walk up is
    // done per snapshot via the parent chain of process.pid.
    let launchChain = new Set()

    let lastSnapshot = null
    async function takeSnapshot() {
      const { procs, degraded, cimError } = await sample()
      // Ancestors are protected but never attribution roots: using Electron or
      // a launcher as a root would claim its unrelated sibling processes.
      launchChain = findAncestorPids(procs, process.pid)
      const roots = new Map()
      roots.set(process.pid, 'harness')
      for (const pid of config.extraWhitelistPids) roots.set(Number(pid), 'whitelisted')
      const attribution = attribute(procs, roots, {
        pluginHint: (cmdline) => {
          // local copy avoids a circular import; keep in sync with shared.js
          if (typeof cmdline !== 'string') return null
          const viaNpx = /[\\/]_npx[\\/]/.test(cmdline)
          const re = /[\\/]node_modules[\\/]+(@[^\\/]+[\\/][^\\/]+|[^\\/]*)[\\/]/g
          let m, hit = null
          while ((m = re.exec(cmdline)) !== null) {
            const name = m[1].replace(/\\/g, '/')
            if (name === '.bin' || name === 'npm' || name === '.store') continue
            hit = name
            break
          }
          return hit ? { plugin: hit, viaNpx } : null
        }
      })
      const findings = collectFindings(procs, attribution, {
        minCopies: config.duplicateMinCopies,
        olderThanMs: config.longLivedMs
      })
      if (findings.length > 0) {
        history.append({ kind: 'findings', count: findings.length, types: findings.map((f) => f.type) })
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
      if (Number.isFinite(ms) && ms >= 2000) {
        config.pollMs = ms
        pollTimer = setInterval(() => { takeSnapshot().catch(() => {}) }, ms)
      } else {
        config.pollMs = 0
      }
    }

    const guard = createGuard()
    const apiRoute = {
      kind: 'exact',
      path: '/dsh-treekeeper/api',
      handler: async (req, res) => {
        try {
          if (!guard(req, res)) return
          const u = new URL(req.url || '/', 'http://x')
          const action = u.searchParams.get('action') || 'snapshot'

          if (action === 'snapshot') {
            const snap = lastSnapshot && (Date.now() - lastSnapshot.takenAt < 2000)
              ? lastSnapshot
              : await takeSnapshot()
            const jobs = listJobs(ctx)
            const rec = reconcile(jobs, snap.procs, attributionOf(snap).attributed)
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
              ledgerAvailability: jobs === null ? 'unavailable' : 'unowned-only',
              jobs,
              reconcile: rec
            })
            return
          }
          if (action === 'jobs') {
            sendJson(res, 200, { ok: true, jobs: listJobs(ctx) })
            return
          }
          if (action === 'subtree') {
            const pid = Number(u.searchParams.get('pid') || 0)
            if (!(pid > 0)) { sendJson(res, 400, { ok: false, code: 'bad_pid' }); return }
            const { procs } = await sample()
            sendJson(res, 200, { ok: true, pid, subtree: subtreeOf(procs, pid) })
            return
          }
          if (action === 'history') {
            sendJson(res, 200, { ok: true, rows: history.last(100) })
            return
          }
          if (action === 'config') {
            if (requirePost(req, res, 'config')) {
              // Minimal runtime knobs; persisted config comes with M2.
              const body = await readBody(req)
              if (body.pollMs !== undefined) setPoll(Number(body.pollMs) || 0)
              if (body.allowKill !== undefined) config.allowKill = !!body.allowKill
              if (Array.isArray(body.extraWhitelistPids)) config.extraWhitelistPids = body.extraWhitelistPids.map(Number).filter(Number.isInteger)
              sendJson(res, 200, { ok: true, config })
            }
            return
          }
          if (action === 'kill') {
            if (!requirePost(req, res, 'kill')) return
            const body = await readBody(req)
            const pid = Number(body.pid)
            const seenCreatedMs = Number(body.seenCreatedMs)
            const sampledProcess = lastSnapshot && !lastSnapshot.degraded &&
              Date.now() - lastSnapshot.takenAt <= KILL_SNAPSHOT_MAX_AGE_MS
              ? lastSnapshot.procs.find((proc) => proc.pid === pid)
              : null
            if (!sampledProcess || !Number.isFinite(seenCreatedMs) || sampledProcess.createdMs !== seenCreatedMs) {
              sendJson(res, 409, { ok: false, code: 'snapshot_required', error: 'refresh a complete process snapshot before terminating' })
              return
            }
            const result = await killTree({
              pid,
              seenCreatedMs,
              whitelistPids: new Set([process.pid, ...launchChain, ...config.extraWhitelistPids.map(Number)]),
              config
            })
            history.append({ kind: 'kill', ...result, pid })
            sendJson(res, result.ok ? 200 : 409, { ok: result.ok, ...result })
            return
          }
          sendJson(res, 400, { ok: false, code: 'bad_action', error: `unknown action "${action}"` })
        } catch (e) {
          sendJson(res, 500, { ok: false, code: 'error', error: String((e && e.message) || e) })
        }
      }
    }
    const disposeRoute = ws.register(apiRoute)

    ctx.on('dispose', () => {
      if (pollTimer) clearInterval(pollTimer)
      if (typeof disposeRoute === 'function') disposeRoute()
    })
  }
}

function attributionOf(snap) {
  // Rebuild the Map shape reconcile() expects from the serialized snapshot.
  const attributed = new Map()
  for (const [pid, info] of Object.entries(snap.attribution || {})) {
    attributed.set(Number(pid), info)
  }
  return { attributed }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 65536) req.destroy() })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}
