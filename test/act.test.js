import test from 'node:test'
import assert from 'node:assert/strict'
import { validateKillTarget, validateKillOwnership, killTree } from '../lib/act.js'

const liveNode = { alive: true, createdMs: 1000, name: 'node.exe' }

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
