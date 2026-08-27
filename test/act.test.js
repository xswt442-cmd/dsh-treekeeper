import test from 'node:test'
import assert from 'node:assert/strict'
import { validateKillTarget } from '../lib/act.js'

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
