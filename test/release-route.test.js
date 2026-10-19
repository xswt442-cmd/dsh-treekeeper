import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

function responseCapture() {
  const writes = []
  return {
    writes,
    writeHead(status, headers) { writes.push({ status, headers }) },
    end(body) { writes.push({ body: JSON.parse(body) }) }
  }
}

function postRaw(text, url) {
  return {
    url,
    method: 'POST',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data') queueMicrotask(() => cb(Buffer.from(text)))
      if (event === 'end') queueMicrotask(() => cb())
      return this
    }
  }
}

const postWith = (body, url) => postRaw(JSON.stringify(body), url)

const get = (route, query) => {
  const res = responseCapture()
  return route.handler({
    url: '/dsh-treekeeper/api' + query,
    method: 'GET',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' }
  }, res).then(() => res)
}

/**
 * 挂载一份宿主。`agents` 给出谱系，`subagents` 记录 drainChildren 的每一次调用；
 * `sample` 永远返回空树，因此任何终止路径都拿不到可终止的目标。
 * `noAgents` 挂载一个没有 agents 服务的宿主，用来断言能力缺失时如实说出来。
 */
function bootHost({ home, agents = [], noAgents = false, noSessionQuery = false, terminals = null, subagents = null, deps = {} } = {}) {
  let route = null
  let disposeCleanup = null
  const live = new Map(agents.map((agent) => [agent.id, agent]))
  const drained = []
  const observed = []
  const agentService = noAgents ? undefined : {
    list: () => agents,
    get: (id) => live.get(id)
  }
  const subagentService = subagents || {
    async drainChildren(parent, childIds) { drained.push({ parent: parent.id, childIds }) }
  }
  // 一次投影观察的租约：读完必须释放，否则子会话的观察会留在宿主的准备缓存里。
  // 投影按子会话 id 给出固定形状，因此断言不依赖请求顺序。
  const leases = []
  const TIMINGS = {
    'child-idle': { settledMs: 7_200_000, lastTurnCompleted: true },
    'child-running': { settledMs: 1000, active: { since: 1000, through: 1000 } }
  }
  const sessionQuery = noSessionQuery ? undefined : {
    async observeSession(id, options) {
      observed.push({ id, options })
      let disposed = false
      const lease = {
        source: 'live',
        projections: { asOfSeq: 3, values: { subagentTiming: TIMINGS[id] ?? { settledMs: 0 } } },
        [Symbol.dispose]: () => { disposed = true }
      }
      leases.push({ id, disposed: () => disposed })
      return lease
    }
  }
  const terminalService = terminals ? { list: terminals } : null
  apply({
    webServer: { port: 3080, register(value) { route = value; return () => {} } },
    ...(agentService ? { agents: agentService } : {}),
    subagents: subagentService,
    ...(sessionQuery ? { sessionQuery } : {}),
    ...(terminalService ? { terminals: terminalService } : {}),
    inject(names, mount) {
      // 每个可选服务各自一个围栏；未挂载的服务不会出现在这里，因此插件读到的是
      // 能力缺失，而不是一个空对象。
      if (names.includes('agents') && names.includes('subagents')) {
        mount({
          ...(agentService ? { agents: agentService } : {}),
          subagents: subagentService,
          ...(sessionQuery ? { sessionQuery } : {}),
          on() {}
        })
      }
      if (names.includes('terminals') && terminalService) {
        mount({ terminals: terminalService, on() {} })
      }
    },
    effect(fn) { disposeCleanup = fn() }
  }, { sample: async () => ({ procs: [], degraded: null }), ...deps })
  return { route, drained, observed, leases, dispose: () => disposeCleanup() }
}

function agent(id, { parent = null, origin = null, status = 'idle' } = {}) {
  const header = { id }
  if (parent) header.parentSession = parent
  if (origin) header.origin = origin
  return { id, status, session: { header } }
}

const ROOT = agent('root-1')
const CHILD = agent('child-a', { parent: 'root-1', origin: 'subagent' })
const OTHER_ROOT = agent('root-2')
const OTHER_CHILD = agent('child-b', { parent: 'root-2', origin: 'subagent' })
const IDLE_CHILD = agent('child-idle', { parent: 'root-1', origin: 'subagent' })
const RUNNING_CHILD = agent('child-running', { parent: 'root-1', origin: 'subagent', status: 'running' })

function useDshHome(home) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('the census covers every session, not only the selected one', async (t) => {
  const { route, dispose } = bootHost({ agents: [ROOT, CHILD, OTHER_ROOT, OTHER_CHILD] })
  t.after(() => dispose())

  const res = await get(route, '?action=census')
  assert.equal(res.writes[0].status, 200)
  const body = res.writes[1].body
  assert.equal(body.availability, 'available')
  // 泄漏恰恰发生在你不在看的那个会话里，因此普查不带根。
  assert.deepEqual(body.parents.map((parent) => parent.parentId).sort(), ['root-1', 'root-2'])
  assert.deepEqual(body.parents.find((parent) => parent.parentId === 'root-1').children.map((child) => child.id), ['child-a'])
  // 释放默认关。
  assert.equal(body.releaseEnabled, false)
})

test('the census says so when this build does not expose the agents lineage', async (t) => {
  const { route, dispose } = bootHost({ noAgents: true })
  t.after(() => dispose())

  const res = await get(route, '?action=census')
  assert.equal(res.writes[1].body.availability, 'unavailable')
  assert.deepEqual(res.writes[1].body.parents, [])
})

test('release is refused outright while its own switch is off', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-release-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const restoreHome = useDshHome(home)
  t.after(restoreHome)

  const { route, drained, dispose } = bootHost({ home, agents: [ROOT, CHILD] })
  t.after(() => dispose())

  const res = responseCapture()
  await route.handler(postWith({ childId: 'child-a' }, '/dsh-treekeeper/api?action=release'), res)
  assert.equal(res.writes[0].status, 409)
  assert.deepEqual(res.writes[1].body, {
    ok: false,
    code: 'disabled',
    error: 'resident subagent release is disabled'
  })
  assert.deepEqual(drained, [], 'a disabled release must not reach the host primitive')

  // 终止开关不蕴含释放开关：打开 allowKill 之后释放仍然拒绝。
  await route.handler(postWith({ allowKill: true }, '/dsh-treekeeper/api?action=config'), responseCapture())
  const stillOff = responseCapture()
  await route.handler(postWith({ childId: 'child-a' }, '/dsh-treekeeper/api?action=release'), stillOff)
  assert.equal(stillOff.writes[1].body.code, 'disabled')
  assert.deepEqual(drained, [])
})

test('release requires POST like every other mutating action', async (t) => {
  const { route, dispose } = bootHost({ agents: [ROOT, CHILD] })
  t.after(() => dispose())

  const res = await get(route, '?action=release&childId=child-a')
  assert.equal(res.writes[0].status, 405)
  assert.equal(res.writes[1].body.code, 'method')
})

test('an enabled release hands the lineage-derived parent and the child to drainChildren', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-release-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const restoreHome = useDshHome(home)
  t.after(restoreHome)

  const { route, drained, dispose } = bootHost({ home, agents: [ROOT, CHILD, OTHER_ROOT, OTHER_CHILD] })
  t.after(() => dispose())

  const enabled = responseCapture()
  await route.handler(postWith({ allowRelease: true }, '/dsh-treekeeper/api?action=config'), enabled)
  assert.equal(enabled.writes[1].body.config.allowRelease, true)

  const res = responseCapture()
  await route.handler(postWith({ childId: 'child-a' }, '/dsh-treekeeper/api?action=release'), res)
  assert.equal(res.writes[0].status, 200)
  assert.deepEqual(res.writes[1].body, { ok: true, code: 'released' })
  // 只有被点名的那一个子代被释放，同一个父的兄弟与别的会话都不受影响。
  assert.deepEqual(drained, [{ parent: 'root-1', childIds: ['child-a'] }])

  const rows = await import('../lib/store.js').then(({ HistoryStore }) => new HistoryStore(home).last(10))
  const record = rows.find((row) => row.kind === 'release')
  assert.equal(record.code, 'released')
  assert.equal(record.childId, 'child-a')
  assert.equal(record.parentId, 'root-1')
})

test('a release cannot name a parent the lineage does not give it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-release-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const restoreHome = useDshHome(home)
  t.after(restoreHome)

  const { route, drained, dispose } = bootHost({ home, agents: [ROOT, CHILD, OTHER_ROOT, OTHER_CHILD] })
  t.after(() => dispose())
  await route.handler(postWith({ allowRelease: true }, '/dsh-treekeeper/api?action=config'), responseCapture())

  // 请求体里的 parentId 不参与判定：child-a 的父只能是 root-1，因此这条请求
  // 释放的仍然是 root-1 的 child-a，而不是「root-2 下的」什么。
  const res = responseCapture()
  await route.handler(postWith({ childId: 'child-a', parentId: 'root-2' }, '/dsh-treekeeper/api?action=release'), res)
  assert.deepEqual(drained, [{ parent: 'root-1', childIds: ['child-a'] }])

  // 不存在的子代、顶层会话、缺字段各自给出可读的拒绝，且都不触达原语。
  const cases = [
    [{ childId: 'no-such-child' }, 409, 'child_not_found'],
    [{ childId: 'root-1' }, 409, 'child_not_found'],
    [{ childId: '' }, 400, 'bad_child_id'],
    [{}, 400, 'bad_child_id']
  ]
  const before = drained.length
  for (const [body, status, code] of cases) {
    const refused = responseCapture()
    await route.handler(postWith(body, '/dsh-treekeeper/api?action=release'), refused)
    assert.equal(refused.writes[0].status, status, JSON.stringify(body))
    assert.equal(refused.writes[1].body.code, code, JSON.stringify(body))
  }
  assert.equal(drained.length, before, 'every refusal stops before the host primitive')
})

test('a malformed release body is a 400 before any guard reads a field', async (t) => {
  const { route, dispose } = bootHost({ agents: [ROOT, CHILD] })
  t.after(() => dispose())

  const res = responseCapture()
  await route.handler(postRaw('{"childId":', '/dsh-treekeeper/api?action=release'), res)
  assert.equal(res.writes[0].status, 400)
  assert.equal(res.writes[1].body.code, 'bad_json')
})

// 驻留级判定

test('residency levels come from the timing projection, and the lease is released', async (t) => {
  const { route, observed, leases, dispose } = bootHost({ agents: [ROOT, IDLE_CHILD, RUNNING_CHILD] })
  t.after(() => dispose())

  const res = await get(route, '?action=census')
  assert.equal(res.writes[0].status, 200)
  const rows = res.writes[1].body.residency.rows

  // 第一行：投影说 turn 已结算，Agent 仍存活——驻留且空闲。
  const idle = rows.find((row) => row.id === 'child-idle')
  assert.equal(idle.residency, 'idle-resident')
  assert.equal(idle.confidence, 'exact')
  assert.equal(idle.busyMs, 7_200_000)
  // 第二行：投影里有开放的 turn。
  const running = rows.find((row) => row.id === 'child-running')
  assert.equal(running.residency, 'running')

  // 摘要只报驻留与空闲，不报容量上限。
  assert.deepEqual(res.writes[1].body.residency.summary.resident, 2)
  assert.ok(!JSON.stringify(res.writes[1].body).includes('maxActiveSubagents'))

  // 观察只对谱系里活着的子代发起，且每次读都释放租约。
  assert.deepEqual(observed.map((row) => row.id).sort(), ['child-idle', 'child-running'])
  assert.deepEqual(leases.map((lease) => lease.disposed()), [true, true], 'every observation lease is released')
})

test('without sessionQuery a residency row carries no verdict', async (t) => {
  const { route, observed, dispose } = bootHost({ agents: [ROOT, IDLE_CHILD], noSessionQuery: true })
  t.after(() => dispose())

  const res = await get(route, '?action=census')
  const row = res.writes[1].body.residency.rows.find((entry) => entry.id === 'child-idle')

  // 读不到投影时不猜：驻留级是 unknown，置信度停在 indicative。
  assert.equal(row.residency, 'unknown')
  assert.equal(row.confidence, 'indicative')
  assert.equal(row.busyMs, null)
  assert.equal(res.writes[1].body.residency.summary.unknown, 1)
  assert.deepEqual(observed, [])
})

test('residency is promoted to a finding only past the user threshold', async (t) => {
  const { route, dispose } = bootHost({ agents: [ROOT, IDLE_CHILD] })
  t.after(() => dispose())

  // 默认关闭：判定照常显示，一块发现都没有。驻留本身是设计。
  const before = await get(route, '?action=census')
  assert.equal(before.writes[1].body.residency.findings.length, 0)
  assert.equal(before.writes[1].body.residency.thresholdMs, 0)

  // 打开到一个低于该行累计时长的阈值：这一行升级为发现。
  await route.handler(postWith({ residencyThresholdMs: 3_600_000 }, '/dsh-treekeeper/api?action=config'), responseCapture())
  const after = await get(route, '?action=census')
  const findings = after.writes[1].body.residency.findings
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'subagent.idle-resident')
  assert.equal(findings[0].confidence, 'exact')
  assert.match(findings[0].detail, /resident and idle/)
  assert.deepEqual(findings[0].pids, [], 'a residency finding never becomes a tree-kill target')
  assert.equal(after.writes[1].body.residency.thresholdMs, 3_600_000)

  // 阈值可以再关回去。
  await route.handler(postWith({ residencyThresholdMs: 0 }, '/dsh-treekeeper/api?action=config'), responseCapture())
  assert.equal((await get(route, '?action=census')).writes[1].body.residency.findings.length, 0)
})

test('the residency threshold is narrowed to 0 or a bounded interval', async (t) => {
  const { route, dispose } = bootHost({ agents: [ROOT, IDLE_CHILD] })
  t.after(() => dispose())

  for (const value of [1, 59999, 86400001, 'soon', {}, null, -1]) {
    const res = responseCapture()
    await route.handler(postWith({ residencyThresholdMs: value }, '/dsh-treekeeper/api?action=config'), res)
    assert.equal(res.writes[0].status, 400, JSON.stringify({ residencyThresholdMs: value }))
    assert.equal(res.writes[1].body.code, 'bad_residency_threshold_ms', JSON.stringify({ residencyThresholdMs: value }))
  }
  // 拒绝的值不会落进配置。
  assert.equal((await get(route, '?action=census')).writes[1].body.residency.thresholdMs, 0)

  for (const value of [0, 60000, 86400000]) {
    const res = responseCapture()
    await route.handler(postWith({ residencyThresholdMs: value }, '/dsh-treekeeper/api?action=config'), res)
    assert.equal(res.writes[0].status, 200, String(value))
    assert.equal(res.writes[1].body.config.residencyThresholdMs, value)
  }
})

// 终端会话的精确 pid 锚点

test('a reported pty pid labels its whole subtree and the kill route refuses it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-pty-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const restoreHome = useDshHome(home)
  t.after(restoreHome)

  // 终端会话的顶层 pid，以及它下面跑着的 dev server 与 watcher。
  const host = { pid: process.pid, ppid: 0, name: 'node', cmdline: 'dsh host', createdMs: 900, wsBytes: 0 }
  const pty = { pid: 900, ppid: process.pid, name: 'pwsh', cmdline: 'pwsh -NoLogo', createdMs: 900, wsBytes: 0 }
  const dev = { pid: 901, ppid: 900, name: 'node', cmdline: 'node C:\\app\\dev.js', createdMs: 900, wsBytes: 0 }
  const watcher = { pid: 902, ppid: 901, name: 'node', cmdline: 'node C:\\app\\watcher.js', createdMs: 900, wsBytes: 0 }

  const killed = []
  // 终端会话的顶层 pid 900 由宿主报告；它下面跑着 dev server 与 watcher。
  const { route, dispose } = bootHost({
    home,
    agents: [ROOT],
    terminals: () => [{ sessionId: 't1', type: 'pwsh', pid: 900, status: { kind: 'running' } }],
    deps: {
      sample: async () => ({ procs: [host, pty, dev, watcher], degraded: null }),
      killTree: async (opts) => { killed.push(opts); return { ok: true, code: 'killed' } }
    }
  })
  t.after(() => dispose())

  const snap = await get(route, '?action=snapshot')
  assert.equal(snap.writes[0].status, 200)
  const attribution = snap.writes[1].body.processes
    .reduce((acc, row) => Object.assign(acc, { [row.pid]: row.attribution }), {})

  // 整棵后代子树都带上 pty，不只是 pty 自己那一行。
  assert.equal(attribution[900].rootLabel, 'pty')
  assert.equal(attribution[901].rootLabel, 'pty')
  assert.equal(attribution[902].rootLabel, 'pty')
  assert.equal(attribution[process.pid].rootLabel, 'harness')
  assert.equal(snap.writes[1].body.reconcile.summary.ptyProcesses, 3)

  // 每一行都被入口检查拒绝，taskkill 一次也没有执行。
  for (const pid of [900, 901, 902]) {
    const res = responseCapture()
    await route.handler(postWith({ pid, seenCreatedMs: 900 }, '/dsh-treekeeper/api?action=kill'), res)
    assert.equal(res.writes[0].status, 409, `pid ${pid}`)
    assert.equal(res.writes[1].body.code, 'pty_owned', `pid ${pid}`)
    assert.match(res.writes[1].body.error, /terminal session/)
  }
  assert.deepEqual(killed, [], 'a terminal-owned tree must never reach taskkill')
})

test('a host without terminal sessions degrades to the previous shape', async (t) => {
  const host = { pid: process.pid, ppid: 0, name: 'node', cmdline: 'dsh host', createdMs: 900, wsBytes: 0 }
  const child = { pid: 901, ppid: process.pid, name: 'node', cmdline: 'node worker.js', createdMs: 900, wsBytes: 0 }
  const { route, dispose } = bootHost({ deps: { sample: async () => ({ procs: [host, child], degraded: null }) } })
  t.after(() => dispose())

  const snap = await get(route, '?action=snapshot')
  const body = snap.writes[1].body

  // 没有任何 pty 归属，摘要里也没有这一项的读数。
  assert.equal(body.reconcile.summary.ptyProcesses, 0)
  assert.equal(body.reconcile.summary.jobsExact, 0)
  assert.ok(!JSON.stringify(body).includes('pty-pid'), 'the absent capability leaves no pty-pid in the payload')
})

test('release never widens the kill scope: no taskkill, and every kill guard still holds', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-release-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const restoreHome = useDshHome(home)
  t.after(restoreHome)

  const killed = []
  const { route, drained, dispose } = bootHost({
    home,
    agents: [ROOT, CHILD],
    deps: { killTree: async (opts) => { killed.push(opts); return { ok: true, code: 'killed' } } }
  })
  t.after(() => dispose())
  await route.handler(postWith({ allowRelease: true, allowKill: true }, '/dsh-treekeeper/api?action=config'), responseCapture())

  await route.handler(postWith({ childId: 'child-a' }, '/dsh-treekeeper/api?action=release'), responseCapture())
  assert.deepEqual(killed, [], 'releasing a resident subagent must not terminate any process')

  // 树杀的入口检查一个字也没放松：仍然要求新鲜的完整快照。
  const kill = responseCapture()
  await route.handler(postWith({ pid: 999999, seenCreatedMs: 1 }, '/dsh-treekeeper/api?action=kill'), kill)
  assert.equal(kill.writes[0].status, 409)
  assert.equal(kill.writes[1].body.code, 'snapshot_required')
  assert.deepEqual(killed, [], 'the kill gates still refuse without a snapshot')
})