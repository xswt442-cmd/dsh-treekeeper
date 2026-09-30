import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcile } from '../lib/reconcile.js'

const procs = [
  { pid: 10, ppid: 1, name: 'node', cmdline: 'node worker.js --port 3000', createdMs: 100, wsBytes: 0 },
  { pid: 20, ppid: 1, name: 'node', cmdline: 'node orphan.js', createdMs: 200, wsBytes: 0 },
  // A stranger that still reads as DSH: the row the panel used to bury under
  // twenty Windows services.
  { pid: 30, ppid: 1, name: 'node', cmdline: 'node C:\\Users\\dev\\.dsh\\profiles\\web\\node_modules\\some-mcp\\index.js', createdMs: 300, wsBytes: 0 }
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
  // Two scopes, two numbers: one stranger is DSH-adjacent, two are not.
  assert.equal(result.summary.unattributed, 1)
  assert.equal(result.summary.unattributedTotal, 2)
})

test('reconciliation keeps unattributed OS processes out of the DSH ledger rows', () => {
  const result = reconcile(null, procs, new Map())

  assert.equal(result.summary.jobs, 0)
  assert.equal(result.summary.osOnly, 0)
  // The count in the panel's summary line is the DSH-related head of the
  // machine-wide bucket, and the bucket total is reported beside it.
  assert.equal(result.summary.unattributed, 1)
  assert.equal(result.summary.unattributedTotal, 3)
})

test('a machine-wide bucket of unrelated processes reports zero DSH-related strangers', () => {
  const strangers = [
    { pid: 4, ppid: 0, name: 'System', cmdline: '', createdMs: 1, wsBytes: 0 },
    { pid: 700, ppid: 4, name: 'svchost', cmdline: 'C:\\Windows\\system32\\svchost.exe -k netsvcs', createdMs: 2, wsBytes: 0 },
    { pid: 800, ppid: 4, name: 'csrss', cmdline: 'C:\\Windows\\system32\\csrss.exe', createdMs: 3, wsBytes: 0 }
  ]
  const result = reconcile(null, strangers, new Map())
  assert.equal(result.summary.unattributed, 0)
  assert.equal(result.summary.unattributedTotal, 3)
})
