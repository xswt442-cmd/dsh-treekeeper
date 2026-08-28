import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcile } from '../lib/reconcile.js'

const procs = [
  { pid: 10, ppid: 1, name: 'node', cmdline: 'node worker.js --port 3000', createdMs: 100, wsBytes: 0 },
  { pid: 20, ppid: 1, name: 'node', cmdline: 'node orphan.js', createdMs: 200, wsBytes: 0 }
]

test('reconciliation labels command-line joins as indicative evidence', () => {
  const result = reconcile([
    { id: 'bash-1', label: 'node worker.js', status: 'running', ownerSession: 'session-1', startedAt: 50 }
  ], procs, new Map([[10, { rootLabel: 'harness', depth: 1 }]]))

  assert.deepEqual(result.rows[0], {
    source: 'job', id: 'bash-1', label: 'node worker.js', ownerSession: 'session-1',
    status: 'running', startedAt: 50, pids: [10], indicative: true
  })
  assert.equal(result.rows.length, 1, 'unattributed processes stay in the separate investigation bucket')
  assert.equal(result.summary.jobsMatched, 1)
  assert.equal(result.summary.osOnly, 0)
  assert.equal(result.summary.unattributed, 1)
})

test('reconciliation keeps unattributed OS processes out of the DSH ledger rows', () => {
  const result = reconcile(null, procs, new Map())

  assert.equal(result.summary.jobs, 0)
  assert.equal(result.summary.osOnly, 0)
  assert.equal(result.summary.unattributed, 2)
})
