import test from 'node:test'
import assert from 'node:assert/strict'
import { createJobLedger, jobLedgerAvailability, listJobs, listSubagentTree } from '../lib/ledger.js'

test('job adapter prefers the mounted DSH jobs service', () => {
  const jobs = [{ id: 'bash-1', kind: 'bash', label: 'node worker.js', status: 'running', ownerSession: undefined }]
  const rows = listJobs({ jobs: { list: () => jobs } })

  assert.deepEqual(rows, [{
    id: 'bash-1', kind: 'bash', label: 'node worker.js', ownerSession: null,
    status: 'running', detail: null, startedAt: null, finishedAt: null
  }])
})

test('job adapter enumerates every live owner through the public ownership fence', () => {
  const unowned = { id: 'bash-1', kind: 'bash', label: 'shared', status: 'running' }
  const ownedA = { id: 'bash-2', kind: 'bash', label: 'alpha', status: 'running', ownerSession: 'session-a' }
  const ownedB = { id: 'subagent-1', kind: 'subagent', label: 'beta', status: 'done', ownerSession: 'session-b' }
  const a = { id: 'session-a' }
  const b = { id: 'session-b' }
  const calls = []
  const rows = listJobs({
    agents: { list: () => [a, b] },
    jobs: {
      list(owner) {
        calls.push(owner && owner.id)
        if (owner === a) return [unowned, ownedA]
        if (owner === b) return [unowned, ownedB]
        return [unowned]
      }
    }
  })

  assert.deepEqual(calls, [undefined, 'session-a', 'session-b'])
  assert.deepEqual(rows.map(row => row.id), ['bash-1', 'bash-2', 'subagent-1'])
  assert.equal(rows[1].ownerSession, 'session-a')
  assert.equal(rows[2].ownerSession, 'session-b')
})

test('job ledger reports whether owner-aware enumeration is available', () => {
  assert.equal(jobLedgerAvailability({}), 'unavailable')
  assert.equal(jobLedgerAvailability({ jobs: { list() {} } }), 'unowned-only')
  assert.equal(jobLedgerAvailability({ jobs: { list() {} }, agents: { list() { return [] } } }), 'live-sessions')
})

test('job ledger mirror refreshes from onJobsChanged and ignores stale rows after disposal', () => {
  let changed = null
  let disposed = null
  let rows = [{ id: 'bash-1', kind: 'bash', label: 'first', status: 'running' }]
  const jobs = {
    list() { return rows },
    onJobsChanged(listener) { changed = listener }
  }
  const agents = { list() { return [] } }
  const ctx = {
    jobs,
    agents,
    inject(services, mount) {
      assert.deepEqual(services, ['jobs', 'agents'])
      mount({ jobs, agents, on(event, listener) { assert.equal(event, 'dispose'); disposed = listener } })
    }
  }
  const ledger = createJobLedger(ctx)
  assert.deepEqual(ledger.list().map(row => row.id), ['bash-1'])
  assert.equal(ledger.availability(), 'live-sessions')

  rows = [{ id: 'bash-2', kind: 'bash', label: 'second', status: 'done' }]
  changed()
  assert.deepEqual(ledger.list().map(row => row.id), ['bash-2'])

  disposed()
  rows = [{ id: 'bash-3', kind: 'bash', label: 'fallback', status: 'running' }]
  assert.deepEqual(ledger.list().map(row => row.id), ['bash-3'])
})

test('subagent adapter calls the mounted runtime with an explicit root', async () => {
  const calls = []
  const result = await listSubagentTree({
    subagents: { listDescendants: async (root) => { calls.push(root); return [{ id: 'child-1' }] } }
  }, 'root-1')

  assert.deepEqual(calls, ['root-1'])
  assert.deepEqual(result, [{ id: 'child-1' }])
})

test('subagent adapter makes absent capabilities visible', async () => {
  assert.equal(await listSubagentTree({}, 'root-1'), null)
})
