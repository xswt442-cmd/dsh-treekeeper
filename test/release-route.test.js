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
function bootHost({ home, agents = [], noAgents = false, subagents = null, deps = {} } = {}) {
  let route = null
  let disposeCleanup = null
  const live = new Map(agents.map((agent) => [agent.id, agent]))
  const drained = []
  const agentService = noAgents ? undefined : {
    list: () => agents,
    get: (id) => live.get(id)
  }
  const subagentService = subagents || {
    async drainChildren(parent, childIds) { drained.push({ parent: parent.id, childIds }) }
  }
  apply({
    webServer: { port: 3080, register(value) { route = value; return () => {} } },
    ...(agentService ? { agents: agentService } : {}),
    subagents: subagentService,
    inject(names, mount) {
      if (names.includes('agents') && names.includes('subagents')) {
        mount({ ...(agentService ? { agents: agentService } : {}), subagents: subagentService, on() {} })
      }
    },
    effect(fn) { disposeCleanup = fn() }
  }, { sample: async () => ({ procs: [], degraded: null }), ...deps })
  return { route, drained, dispose: () => disposeCleanup() }
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