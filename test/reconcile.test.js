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
  assert.equal(result.rows[1].source, 'os-unattributed')
  assert.equal(result.summary.jobsMatched, 1)
})

test('reconciliation stays useful when the limited jobs seam is absent', () => {
  const result = reconcile(null, procs, new Map())

  assert.equal(result.summary.jobs, 0)
  assert.equal(result.summary.osOnly, 2)
  assert.equal(result.summary.unattributed, 2)
})
