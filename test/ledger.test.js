import test from 'node:test'
import assert from 'node:assert/strict'
import { listJobs, listSubagentTree } from '../lib/ledger.js'

test('job adapter prefers the mounted DSH jobs service', () => {
  const jobs = [{ id: 'bash-1', kind: 'bash', label: 'node worker.js', status: 'running', ownerSession: undefined }]
  const rows = listJobs({ jobs: { list: () => jobs } })

  assert.deepEqual(rows, [{
    id: 'bash-1', kind: 'bash', label: 'node worker.js', ownerSession: null,
    status: 'running', detail: null, startedAt: null, finishedAt: null
  }])
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
