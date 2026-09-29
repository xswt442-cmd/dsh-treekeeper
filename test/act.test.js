import test from 'node:test'
import assert from 'node:assert/strict'
import { validateKillTarget, validateKillOwnership, killTree, classifyKillOutcome, decideKillEntry, decideKillConfirm, TASKKILL_ARGS } from '../lib/act.js'
import { attribute } from '../lib/attribute.js'
import { parseCimDate } from '../lib/shared.js'

const liveNode = { alive: true, createdMs: 1000, name: 'node.exe' }

/**
 * The OS seams of `killTree`: `exec` records every command, argv and exec option
 * instead of spawning one, `platform` stands on either side of the Windows gate,
 * and `sleep` means a test does not wait 700 ms for a recheck of a process that
 * never existed. Together they let the suite assert the two properties that
 * matter most: a refused kill never reaches taskkill, and an allowed kill passes
 * exactly the argv the guards were written for.
 */
function fakeOs({ platform = 'win32', probes = [], taskkill = { err: null, stdout: '', stderr: '' } } = {}) {
  const calls = []
  const sleeps = []
  let probe = 0
  const exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    if (cmd === 'taskkill') return taskkill
    return probes[probe++] ?? { err: null, stdout: '', stderr: '' }
  }
  return {
    calls,
    sleeps,
    deps: { exec, platform: () => platform, sleep: async (ms) => { sleeps.push(ms) } },
    taskkillCalls: () => calls.filter((c) => c.cmd === 'taskkill')
  }
}

const CREATED = '20260825162958.5+480'
const CREATED_MS = parseCimDate(CREATED)
const aliveProbe = (name = 'node.exe') => ({ err: null, stdout: JSON.stringify({ CreationDate: CREATED, Name: name }), stderr: '' })
const goneProbe = () => ({ err: null, stdout: '', stderr: '' })
const brokenProbe = () => ({ err: Object.assign(new Error('spawn powershell.exe EACCES'), { code: 'EACCES' }), stdout: '', stderr: '' })


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

test('a failed probe must refuse, never read as already-gone or killed', () => {
  // pidFacts reports query failures as { alive:false, error } — the same shape
  // as a clean "not found" except for the error field. The policy gate must
  // tell them apart: a transient PowerShell failure on a live target may not
  // read as a successful no-op.
  const facts = { alive: false, createdMs: null, name: null, error: 'spawn blocked' }
  assert.equal(
    validateKillTarget({ pid: 200, seenCreatedMs: 100, facts, whitelistPids: new Set() }).code,
    'verify_failed'
  )

  // Same for the post-kill probe: taskkill has already run, so a failed
  // recheck must read as failure, never as `killed`.
  assert.deepEqual(
    classifyKillOutcome(100, { alive: false, createdMs: null, error: 'spawn blocked' }),
    { ok: false, code: 'verify_failed', detail: 'spawn blocked' }
  )
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
  const os = fakeOs()
  const result = await killTree({
    pid: 200,
    seenCreatedMs: 100,
    whitelistPids: new Set([201]),
    config: { allowKill: true },
    procs,
    deps: os.deps
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'protected_descendant')
  assert.equal(result.detail, '201')
  assert.deepEqual(os.calls, [], 'the tree gate runs before a single process is spawned')
})

test('a non-Windows host reports unsupported_platform and spawns nothing', async () => {
  // The non-Windows branch: the gates pass, the OS says no, and `taskkill`
  // must still never be attempted.
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }
  for (const platform of ['linux', 'darwin']) {
    const os = fakeOs({ platform, probes: [aliveProbe(), aliveProbe()] })
    const result = await killTree({
      pid: 200,
      seenCreatedMs: CREATED_MS,
      whitelistPids: new Set([1]),
      config: { allowKill: true },
      procs: [target],
      deps: os.deps
    })
    assert.deepEqual(result, { ok: false, code: 'unsupported_platform' }, platform)
    assert.deepEqual(os.calls, [], platform + ' must not reach for powershell or taskkill')
  }

  // Same facts on Windows do reach the OS, so the negative above is the platform
  // gate and not a broken fixture.
  const onWindows = fakeOs({ probes: [aliveProbe(), goneProbe()] })
  const allowed = await killTree({
    pid: 200, seenCreatedMs: CREATED_MS, whitelistPids: new Set([1]),
    config: { allowKill: true }, procs: [target], deps: onWindows.deps
  })
  assert.deepEqual(allowed, { ok: true, code: 'killed' })
})

test('an allowed kill runs exactly taskkill /PID <pid> /T /F, once', async () => {
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }
  const os = fakeOs({ probes: [aliveProbe(), goneProbe()] })
  const result = await killTree({
    pid: 200, seenCreatedMs: CREATED_MS, whitelistPids: new Set(), config: {}, procs: [target], deps: os.deps
  })

  assert.deepEqual(result, { ok: true, code: 'killed' })
  assert.deepEqual(os.calls.map((c) => c.cmd), ['powershell.exe', 'taskkill', 'powershell.exe'],
    'identity precheck, one kill, one liveness recheck')
  const [kill] = os.taskkillCalls()
  assert.deepEqual(kill.args, TASKKILL_ARGS(200))
  assert.deepEqual(kill.args, ['/PID', '200', '/T', '/F'])
  assert.equal(kill.options.windowsHide, true, 'no console window for a guarded kill')
  // The recheck waits for the OS to reap the tree; the wait is the seam's, so the
  // suite sees it without spending it.
  assert.deepEqual(os.sleeps, [700])
})

test('every pre-trigger refusal means taskkill is never called', async () => {
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }
  // `self` is asserted on the pure gate below: driving it through killTree would
  // mean handing the runner's own pid to a gate that a regression could let through.
  const cases = [
    ['disabled', { config: { allowKill: false }, probes: [aliveProbe()] }],
    ['whitelisted', { whitelistPids: new Set([200]), probes: [aliveProbe()] }],
    ['missing_creation_time', { seenCreatedMs: null, probes: [aliveProbe()] }],
    ['pid_identity_unverified', { seenCreatedMs: CREATED_MS + 5000, probes: [aliveProbe()] }],
    ['protected', { probes: [aliveProbe('lsass.exe')] }],
    ['verify_failed', { probes: [brokenProbe()] }]
  ]

  for (const [code, over] of cases) {
    const os = fakeOs({ probes: over.probes })
    const result = await killTree({
      pid: 200,
      // `??` would turn an explicit null into a valid time, so the field is read
      // by presence: `missing_creation_time` really has to arrive as null.
      seenCreatedMs: 'seenCreatedMs' in over ? over.seenCreatedMs : CREATED_MS,
      whitelistPids: over.whitelistPids ?? new Set(),
      config: over.config ?? {},
      procs: [target],
      deps: os.deps
    })
    assert.equal(result.ok, false, code)
    assert.equal(result.code, code)
    assert.deepEqual(os.taskkillCalls(), [], `${code} must not reach taskkill`)
    // The post-kill recheck must not run either: there was nothing to recheck.
    assert.deepEqual(os.sleeps, [], code)
  }

  // The self gate, on the pure function that decides it.
  assert.deepEqual(validateKillTarget({ pid: 4242, seenCreatedMs: 1000, facts: liveNode, selfPid: 4242 }), { ok: false, code: 'self' })
})

test('a target that is already gone is reported without pulling the trigger', async () => {
  const os = fakeOs({ probes: [goneProbe()] })
  const result = await killTree({
    pid: 200, seenCreatedMs: CREATED_MS, config: {}, procs: [], deps: os.deps
  })
  assert.deepEqual(result, { ok: true, code: 'already_gone' })
  assert.deepEqual(os.taskkillCalls(), [])
})

test('a taskkill that fails says so, and a clean "not found" is still a death', async () => {
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }

  const failed = fakeOs({
    probes: [aliveProbe(), goneProbe()],
    taskkill: { err: Object.assign(new Error('access denied'), { code: 'EPERM' }), stdout: '', stderr: 'ERROR: Access is denied.' }
  })
  const result = await killTree({ pid: 200, seenCreatedMs: CREATED_MS, config: {}, procs: [target], deps: failed.deps })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'taskkill_failed')
  assert.match(result.detail, /Access is denied/)
  assert.deepEqual(failed.sleeps, [], 'a failed kill does not recheck')

  // taskkill's own "no such process" is the target already being gone, which the
  // recheck then confirms; it is not a failure of the guard.
  const notFound = fakeOs({
    probes: [aliveProbe(), goneProbe()],
    taskkill: { err: new Error('exit 128'), stdout: '', stderr: 'ERROR: The process "200" not found.' }
  })
  const survived = await killTree({ pid: 200, seenCreatedMs: CREATED_MS, config: {}, procs: [target], deps: notFound.deps })
  assert.deepEqual(survived, { ok: true, code: 'killed' })
})

test('a survivor of taskkill is reported as one, never as success', async () => {
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }
  const os = fakeOs({ probes: [aliveProbe(), aliveProbe()] })
  const result = await killTree({ pid: 200, seenCreatedMs: CREATED_MS, config: {}, procs: [target], deps: os.deps })
  assert.deepEqual(result, { ok: false, code: 'still_alive', detail: 'process survived taskkill /T /F' })
  assert.equal(os.taskkillCalls().length, 1)
})

