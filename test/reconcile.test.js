import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcile } from '../lib/reconcile.js'

const procs = [
  { pid: 10, ppid: 1, name: 'node', cmdline: 'node worker.js --port 3000', createdMs: 100, wsBytes: 0 },
  { pid: 20, ppid: 1, name: 'node', cmdline: 'node orphan.js', createdMs: 200, wsBytes: 0 },
  // 一个仍然带有 DSH 路径的陌生进程：整机集合里正是这类行值得排到前面。
  { pid: 30, ppid: 1, name: 'node', cmdline: 'node C:\\Users\\dev\\.dsh\\profiles\\web\\node_modules\\some-mcp\\index.js', createdMs: 300, wsBytes: 0 }
]

test('reconciliation labels command-line joins as indicative evidence', () => {
  const result = reconcile([
    { id: 'bash-1', label: 'node worker.js', status: 'running', ownerSession: 'session-1', startedAt: 50 }
  ], procs, new Map([[10, { rootLabel: 'harness', depth: 1 }]]))

  assert.deepEqual(result.rows[0], {
    source: 'job', id: 'bash-1', label: 'node worker.js', ownerSession: 'session-1',
    status: 'running', startedAt: 50, pids: [10],
    // 没有精确 pid 就仍是指示性的：label 匹配是文本近似，不是身份。
    indicative: true, via: 'job-label'
  })
  assert.equal(result.rows.length, 1, 'unattributed processes stay in the separate investigation bucket')
  assert.equal(result.summary.jobsMatched, 1)
  assert.equal(result.summary.jobsExact, 0)
  assert.equal(result.summary.osOnly, 0)
  // 两个范围，两个数字：一个陌生进程与 DSH 相关，两个不相关。
  assert.equal(result.summary.unattributed, 1)
  assert.equal(result.summary.unattributedTotal, 2)
})

test('a job backed by a reported pty pid joins exactly instead of indicatively', () => {
  // pid 10 既是任务 label 命中的进程，也是一个活着的终端会话报告的顶层 pid。
  // 后者是 DSH 自己给出的身份，因此这一行不再标 indicative。
  const result = reconcile([
    { id: 'pty-send-1', label: 'node worker.js', status: 'running', ownerSession: 'session-1', startedAt: 50 }
  ], procs, new Map([[10, { rootLabel: 'pty', depth: 0 }]]), { ptyPids: new Set([10]) })

  assert.deepEqual(result.rows[0], {
    source: 'job', id: 'pty-send-1', label: 'node worker.js', ownerSession: 'session-1',
    status: 'running', startedAt: 50, pids: [10],
    indicative: false, via: 'pty-pid', ptyPid: 10
  })
  assert.equal(result.summary.jobsExact, 1)
  assert.equal(result.summary.ptyProcesses, 0, 'the matched pid is not listed again as an os-only row')
})

test('a host without terminal sessions keeps the pre-anchor shape', () => {
  // 服务缺失时 ptyPids 为 null：FINDING_VIA 里不会出现 pty-pid，形态与之前一致。
  const result = reconcile([
    { id: 'bash-1', label: 'node worker.js', status: 'running', ownerSession: 'session-1', startedAt: 50 }
  ], procs, new Map([[10, { rootLabel: 'harness', depth: 1 }]]), { ptyPids: null })

  assert.equal(result.rows[0].via, 'job-label')
  assert.equal(result.rows[0].indicative, true)
  assert.ok(!('ptyPid' in result.rows[0]))
  assert.equal(result.summary.jobsExact, 0)
})

test('pty-attributed rows are counted apart from the harness subtree', () => {
  // 终端会话的整棵后代子树都带 rootLabel: 'pty'，因此摘要能单独报出这一批。
  const result = reconcile(null, procs, new Map([
    [10, { rootLabel: 'pty', depth: 0 }],
    [20, { rootLabel: 'pty', depth: 1 }]
  ]), { ptyPids: new Set([10]) })

  assert.equal(result.summary.ptyProcesses, 2)
  assert.deepEqual(result.rows.map((row) => row.rootLabel), ['pty', 'pty'])
})

test('reconciliation keeps unattributed OS processes out of the DSH ledger rows', () => {
  const result = reconcile(null, procs, new Map())

  assert.equal(result.summary.jobs, 0)
  assert.equal(result.summary.osOnly, 0)
  // 面板摘要行里的数量是整机集合中与 DSH 相关的那一部分，旁边给出集合总数。
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
