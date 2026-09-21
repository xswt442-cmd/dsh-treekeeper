import test from 'node:test'
import assert from 'node:assert/strict'
import { validateKillTarget, validateKillOwnership, killTree, classifyKillOutcome, decideKillEntry, decideKillConfirm } from '../lib/act.js'
import { attribute } from '../lib/attribute.js'

const liveNode = { alive: true, createdMs: 1000, name: 'node.exe' }

test('kill outcome treats an unreadable creation time as a survivor, not a reuse', () => {
  // pidFacts falls back to createdMs:null when the CIM JSON does not parse. The
  // pid is alive and we cannot prove it is a different process, so the kill must
  // not be reported as successful.
  assert.deepEqual(classifyKillOutcome(100, { alive: true, createdMs: null }), {
    ok: false,
    code: 'still_alive',
    detail: 'process survived taskkill /T /F'
  })
  // Alive with the creation time we verified: still the same process.
  assert.equal(classifyKillOutcome(100, { alive: true, createdMs: 100 }).ok, false)
  // Gone.
  assert.deepEqual(classifyKillOutcome(100, { alive: false, createdMs: null }), { ok: true, code: 'killed' })
  // Alive at the same pid but provably a different process: the pid was reused
  // before the probe, which is what a successful tree kill looks like.
  assert.deepEqual(classifyKillOutcome(100, { alive: true, createdMs: 999 }), { ok: true, code: 'gone_reused' })
})

test('kill entry refuses anything the snapshot cannot vouch for', () => {
  const procs = [{ pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: 100, wsBytes: 0 }]
  const snapshot = { procs, degraded: false }
  const attribution = { 200: { rootLabel: 'harness' } }
  const base = { pid: 200, seenCreatedMs: 100, snapshot, takenAt: 1000, now: 1100, maxAgeMs: 15000, attribution }

  // The only path that may proceed: fresh snapshot, matching creation time, and
  // a pid the host tree owns.
  assert.deepEqual(decideKillEntry(base), { ok: true })

  // Every way to be refused. None of them may reach taskkill, and all of them
  // are covered here rather than only on Windows.
  const refused = (over, code) => {
    assert.equal(decideKillEntry({ ...base, ...over }).code, code)
  }
  refused({ snapshot: null }, 'snapshot_required')
  refused({ snapshot: { procs, degraded: true } }, 'snapshot_required')
  refused({ now: 1000 + 15001 }, 'snapshot_required')
  refused({ pid: 999 }, 'snapshot_required')
  refused({ seenCreatedMs: Number.NaN }, 'snapshot_required')
  refused({ seenCreatedMs: 999 }, 'snapshot_required')
  // Present in the snapshot but outside the host tree (the `unknown` bucket),
  // or owned by something that is not the harness.
  refused({ attribution: {} }, 'unattributed')
  refused({ attribution: { 200: { rootLabel: 'unknown' } } }, 'non_harness_root')
})

test('kill confirm refuses a target the pre-pull sample cannot re-identify', () => {
  const fresh = { procs: [{ pid: 200, createdMs: 100 }], degraded: false }
  assert.deepEqual(decideKillConfirm({ pid: 200, seenCreatedMs: 100, fresh }), { ok: true })
  assert.equal(decideKillConfirm({ pid: 200, seenCreatedMs: 100, fresh: null }).code, 'snapshot_required')
  assert.equal(decideKillConfirm({ pid: 200, seenCreatedMs: 100, fresh: { procs: [], degraded: true } }).code, 'snapshot_required')
  assert.equal(decideKillConfirm({ pid: 999, seenCreatedMs: 100, fresh }).code, 'snapshot_required')
  assert.equal(decideKillConfirm({ pid: 200, seenCreatedMs: 999, fresh }).code, 'snapshot_required')
})

test('kill policy rejects a target without a verifiable creation time', () => {
  const result = validateKillTarget({ pid: 42, seenCreatedMs: null, facts: liveNode, selfPid: 1 })
  assert.deepEqual(result, { ok: false, code: 'missing_creation_time' })
})

test('kill policy rejects reused or unqueryable process identities', () => {
  const reused = validateKillTarget({ pid: 42, seenCreatedMs: 2000, facts: liveNode, selfPid: 1 })
  const unqueryable = validateKillTarget({ pid: 42, seenCreatedMs: 1000, facts: { ...liveNode, createdMs: null }, selfPid: 1 })

  assert.equal(reused.code, 'pid_identity_unverified')
  assert.equal(unqueryable.code, 'pid_identity_unverified')
})

test('kill policy protects Windows critical process names and configured pids', () => {
  const protectedProcess = validateKillTarget({ pid: 42, seenCreatedMs: 1000, facts: { ...liveNode, name: 'svchost.exe' }, selfPid: 1 })
  const whitelisted = validateKillTarget({ pid: 42, seenCreatedMs: 1000, facts: liveNode, whitelistPids: new Set([42]), selfPid: 1 })

  assert.equal(protectedProcess.code, 'protected')
  assert.equal(whitelisted.code, 'whitelisted')
})

test('kill policy permits only a verified non-protected process', () => {
  const result = validateKillTarget({ pid: 42, seenCreatedMs: 1000, facts: liveNode, selfPid: 1 })
  assert.deepEqual(result, { ok: true, code: 'verified' })
})

test('kill ownership rejects a process outside the DSH host tree', () => {
  const attribution = { 1000: { rootLabel: 'harness', depth: 1 } }
  assert.deepEqual(validateKillOwnership(attribution, 9999), { ok: false, code: 'unattributed' })
  assert.deepEqual(validateKillOwnership(attribution, 1000), { ok: true, code: 'attributed' })
  // A missing attribution object must never let a kill through.
  assert.deepEqual(validateKillOwnership(null, 1000), { ok: false, code: 'unattributed' })
})

test('kill ownership rejects descendants of a whitelisted root (REVIEW-0904 P1)', () => {
  // `extraWhitelistPids` registers pinned pids as attribution roots so the
  // panel can label them. Authorizing those buckets would invert the setting:
  // protecting a pid would widen the kill scope instead of narrowing it.
  const procs = [
    { pid: 1, ppid: 0, name: 'dsh', cmdline: 'dsh host', createdMs: 1, wsBytes: 0 },
    { pid: 500, ppid: 1, name: 'pinned', cmdline: 'pinned root', createdMs: 1, wsBytes: 0 },
    { pid: 501, ppid: 500, name: 'child', cmdline: 'child of pinned', createdMs: 1, wsBytes: 0 }
  ]
  const attribution = Object.fromEntries(
    attribute(procs, new Map([[1, 'harness'], [500, 'whitelisted']])).attributed
  )

  // The pinned root's child is "attributed", but not to the harness.
  assert.equal(validateKillOwnership(attribution, 501).ok, false)
  assert.equal(validateKillOwnership(attribution, 501).code, 'non_harness_root')
  // The pinned pid itself stays refused too.
  assert.equal(validateKillOwnership(attribution, 500).code, 'non_harness_root')
  // Harness descendants keep working.
  assert.deepEqual(validateKillOwnership(attribution, 1), { ok: true, code: 'attributed' })
})

test('killTree refuses when a protected pid is a descendant (Problem 3)', async () => {
  const procs = [
    { pid: 200, ppid: 1, name: 'node', cmdline: 'node parent', createdMs: 100, wsBytes: 0 },
    { pid: 201, ppid: 200, name: 'node', cmdline: 'node child', createdMs: 100, wsBytes: 0 }
  ]
  // pid 200 is verified and killable, but its tree contains the protected
  // pid 201; /T would take 201 down, so the whole kill is refused before any
  // OS call. This is a pure snapshot check, so it runs off Windows too.
  const result = await killTree({
    pid: 200,
    seenCreatedMs: 100,
    whitelistPids: new Set([201]),
    config: { allowKill: true },
    procs
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'protected_descendant')
  assert.equal(result.detail, '201')
})
