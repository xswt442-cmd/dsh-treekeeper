import test from 'node:test'
import assert from 'node:assert/strict'
import { createJobLedger, createSubagentTree, jobLedgerAvailability, listJobs, listSubagentTree } from '../lib/ledger.js'
import { attribute } from '../lib/attribute.js'
import { collectFindings, applyLedgerOwnership } from '../lib/leak.js'
import { reconcile } from '../lib/reconcile.js'

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
  const ownedA = { id: 'bash-2', kind: 'bash', label: 'alpha', status: 'running', owner: 'session-a' }
  const ownedB = { id: 'subagent-1', kind: 'subagent', label: 'beta', status: 'done', owner: 'session-b' }
  const a = { id: 'session-a' }
  const b = { id: 'session-b' }
  const calls = []
  const rows = listJobs({
    agents: { list: () => [a, b] },
    jobs: {
      // 上游 0.2.x 的归属边界：`job.owner.id === caller`，caller 是 SessionId。
      // 传对象恒不等于字符串，于是有主的任务一条都列不出来。
      list(caller) {
        calls.push(caller)
        if (caller === 'session-a') return [unowned, ownedA]
        if (caller === 'session-b') return [unowned, ownedB]
        return [unowned]
      }
    }
  })

  // 会话 id 与 Agent 对象各查一次，两种 caller 形态的宿主都因此列得出有主任务。
  assert.deepEqual(calls, [undefined, 'session-a', a, 'session-b', b])
  assert.deepEqual(rows.map(row => row.id), ['bash-1', 'bash-2', 'subagent-1'])
  // `ownerSession` 在 0.1.5-rc.3 之后的名字是 `owner`；读旧名字会恒为 null。
  assert.equal(rows[1].ownerSession, 'session-a')
  assert.equal(rows[2].ownerSession, 'session-b')
})

test('job adapter reads the owner field name the 0.1.5 line still used', () => {
  // 声明的兼容下限是 0.1.5-rc.3，那一版的任务投影把这个字段叫 `ownerSession`。
  const unowned = { id: 'bash-1', kind: 'bash', label: 'shared', status: 'running' }
  const owned = { id: 'bash-2', kind: 'bash', label: 'alpha', status: 'running', ownerSession: 'session-a' }
  const agent = { id: 'session-a' }
  const rows = listJobs({
    agents: { list: () => [agent] },
    // 0.1.5-rc.3 的归属边界：`job.owner.id === caller?.id`，caller 是 Agent。
    jobs: { list: (caller) => (caller === agent ? [unowned, owned] : [unowned]) }
  })

  assert.deepEqual(rows.map(row => row.id), ['bash-1', 'bash-2'])
  assert.equal(rows[1].ownerSession, 'session-a')
})

test('an owner-less row stays null under either field name', () => {
  const rows = listJobs({ jobs: { list: () => [{ id: 'bash-1', kind: 'bash', label: 'shared', status: 'running' }] } })

  assert.equal(rows[0].ownerSession, null)
})

test('an owned job reaches a finding as ownership.session end to end', () => {
  // 侧栏的“运行中 job 数”与 finding 的会话归属都走这条链：账本行 → 对账 →
  // applyLedgerOwnership()。caller 形态与 owner 字段名任一处读错，这一行就停在
  // null，而面板仍然照常渲染——所以这里断言的是链条的终点。
  const agent = { id: 'session-a' }
  const jobs = listJobs({
    agents: { list: () => [agent] },
    jobs: {
      list(caller) {
        if (caller !== 'session-a' && caller !== agent) return []
        return [{ id: 'bash-2', kind: 'bash', label: 'node worker.js', status: 'running', owner: 'session-a' }]
      }
    }
  })
  const procs = [
    { pid: 1, ppid: 0, name: 'node', cmdline: 'node host.js', createdMs: 1, wsBytes: 0 },
    { pid: 2, ppid: 1, name: 'node', cmdline: 'node worker.js E:\\x\\node_modules\\some-mcp\\index.js', createdMs: Date.now() - 60 * 60 * 1000, wsBytes: 0 }
  ]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { olderThanMs: 30 * 60 * 1000 })

  const rec = reconcile(jobs, procs, attribution.attributed)
  assert.equal(rec.rows.find((row) => row.id === 'bash-2').ownerSession, 'session-a')

  applyLedgerOwnership(findings, rec.rows)
  const owned = findings.find((finding) => finding.rule === 'longlived.plugin-child')
  assert.equal(owned.ownership.session, 'session-a')
  assert.equal(owned.ownership.job, 'bash-2')
  assert.equal(owned.ownership.scope, 'session')
})

test('job ledger reports whether owner-aware enumeration is available', () => {
  assert.equal(jobLedgerAvailability({}), 'unavailable')
  assert.equal(jobLedgerAvailability({ jobs: { list() {} } }), 'unowned-only')
  assert.equal(jobLedgerAvailability({ jobs: { list() {} }, agents: { list() { return [] } } }), 'live-sessions')
})

test('job ledger mirror refreshes from onJobsChanged and ignores stale rows after disposal', () => {
  let changed = null
  let disposed = null
  let detached = false
  let rows = [{ id: 'bash-1', kind: 'bash', label: 'first', status: 'running' }]
  const jobs = {
    list() { return rows },
    // 真实服务把这个订阅绑在任务服务自己的上下文上，调用方的围栏消失时没有人
    // 解除它：helper 保存的解除函数是唯一会解除它的东西。
    onJobsChanged(listener) { changed = listener; return () => { detached = true } }
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
  assert.equal(detached, true, 'disposal must release the change subscription too')
  rows = [{ id: 'bash-3', kind: 'bash', label: 'fallback', status: 'running' }]
  assert.deepEqual(ledger.list().map(row => row.id), ['bash-3'])
})

test('subagent adapter calls the mounted runtime with an explicit root', async () => {
  const calls = []
  const controller = new AbortController()
  const result = await listSubagentTree({
    subagents: { listDescendants: async (root, signal) => { calls.push([root, signal]); return [{ id: 'child-1' }] } }
  }, 'root-1', controller.signal)

  assert.deepEqual(calls, [['root-1', controller.signal]])
  assert.deepEqual(result, [{ id: 'child-1' }])
})

test('subagent adapter propagates cancellation instead of hiding it as unavailability', async () => {
  const controller = new AbortController()
  const pending = listSubagentTree({
    subagents: {
      listDescendants: (_root, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
  }, 'root-1', controller.signal)
  controller.abort()
  await assert.rejects(pending, /aborted/)
})

test('subagent adapter makes absent capabilities visible', async () => {
  assert.equal(await listSubagentTree({}, 'root-1'), null)
})

test('subagent tree captures the service through inject and never probes the guarded root context', async () => {
  let dispose = null
  const roots = []
  const ctx = {
    get subagents() { throw new Error('cannot get property "subagents" without inject') },
    inject(services, mount) {
      assert.deepEqual(services, ['subagents'])
      mount({
        subagents: {
          async listDescendants(root) {
            roots.push(root)
            return [{ id: 'child-1' }]
          }
        },
        on(event, callback) {
          assert.equal(event, 'dispose')
          dispose = callback
        }
      })
    }
  }

  const tree = createSubagentTree(ctx)
  assert.deepEqual(await tree.list('root-1'), [{ id: 'child-1' }])
  assert.deepEqual(roots, ['root-1'])
  dispose()
  assert.equal(await tree.list('root-1'), null)
})

test('subagent adapter converts an unfenced service getter into capability unavailability', async () => {
  const guarded = {
    get subagents() { throw new Error('cannot get property "subagents" without inject') }
  }
  assert.equal(await listSubagentTree(guarded, 'root-1'), null)
})
