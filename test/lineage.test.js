import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLineage, createAgentLineage, parentOf, isDirectChild } from '../lib/lineage.js'
import { decideReleaseEntry, RELEASE_REFUSAL_TEXT } from '../lib/release.js'

/**
 * 一个 Agent。谱系只读 header 的 `parentSession` / `origin` 与 `status`，因此
 * 夹具也只提供这三样——多给一个 `session.events` 才能证明读面边界没有被越过。
 */
function agent(id, { parent = null, origin = null, status = 'idle', events } = {}) {
  const header = { id }
  if (parent) header.parentSession = parent
  if (origin) header.origin = origin
  return { id, status, session: { header, events } }
}

const ROOT = agent('root-1')
const CHILD_A = agent('child-a', { parent: 'root-1', origin: 'subagent' })
const CHILD_B = agent('child-b', { parent: 'root-1', origin: 'subagent' })
const GRANDCHILD = agent('grandchild', { parent: 'child-a', origin: 'subagent' })
const OTHER_ROOT = agent('root-2')
const FORK = agent('fork-1', { parent: 'root-1' })

test('lineage records the parent edge only for subagent-origin children', () => {
  const lineage = buildLineage([ROOT, CHILD_A, CHILD_B, GRANDCHILD, OTHER_ROOT, FORK])

  assert.deepEqual(lineage.childrenOf.get('root-1').map((row) => row.id), ['child-a', 'child-b'])
  // fork 共享 lineage 字段却没有 subagent origin，因此不持有它的父会话。
  assert.equal(lineage.childrenOf.has('fork-1'), false)
  assert.equal(parentOf(lineage, 'fork-1'), null)
  // 顶层的会话没有父，因此不是任何人的子代理行。
  assert.equal(parentOf(lineage, 'root-1'), null)
  assert.equal(parentOf(lineage, 'other-root'), null)
})

test('lineage walks descendants of any depth and visits a cyclic header once', () => {
  const lineage = buildLineage([ROOT, CHILD_A, CHILD_B, GRANDCHILD])
  assert.deepEqual(lineage.descendantsOf('root-1').map((row) => row.id), ['child-a', 'child-b', 'grandchild'])

  // header 链成环时遍历必须终止：两个子代理互指父会话。谱系按数据读取，因此
  // 成环的 header 只是被访问一次，而不是把遍历卡住。
  const loopA = agent('loop-a', { parent: 'loop-b', origin: 'subagent' })
  const loopB = agent('loop-b', { parent: 'loop-a', origin: 'subagent' })
  const cyclic = buildLineage([ROOT, loopA, loopB])
  assert.deepEqual(cyclic.descendantsOf('loop-a').map((row) => row.id), ['loop-b', 'loop-a'])
})

test('lineage reads headers and status only, never session content', () => {
  // 一个会在被读取时留下痕迹的 events 数组：谱系构造之后它必须仍是空的。
  const events = []
  const lineage = buildLineage([ROOT, agent('child-a', { parent: 'root-1', origin: 'subagent', events })])

  assert.deepEqual(events, [], 'lineage must not touch the session log')
  assert.equal(lineage.byId.get('child-a').status, 'idle')
  assert.equal(buildLineage([agent('child-a', { parent: 'root-1', origin: 'subagent', status: 'running' })])
    .byId.get('child-a').status, 'running')
})

test('lineage rejects unusable rows instead of inventing a parent', () => {
  const lineage = buildLineage([null, {}, { id: '' }, { id: 'no-header' }])

  assert.deepEqual(lineage.rows, [{ id: 'no-header', parentId: null, origin: null, status: 'idle', depth: null }])
  assert.deepEqual(buildLineage(null).rows, [])
})

test('release is refused unless its own switch is on', () => {
  const lineage = buildLineage([ROOT, CHILD_A])

  // 默认关。一个都不传就是关，因此默认配置下释放无从发生。
  assert.deepEqual(decideReleaseEntry({ childId: 'child-a' }), { ok: false, code: 'disabled' })
  assert.deepEqual(decideReleaseEntry({ childId: 'child-a', allowRelease: false, lineage }), { ok: false, code: 'disabled' })
  // 只有严格 true 才算开：`'false'` 是请求体里的字符串，读成真会让开关形同虚设。
  assert.deepEqual(decideReleaseEntry({ childId: 'child-a', allowRelease: 'true', lineage }), { ok: false, code: 'disabled' })
  assert.deepEqual(decideReleaseEntry({ childId: 'child-a', allowRelease: true, lineage }), {
    ok: true, code: 'verified', parentId: 'root-1', childId: 'child-a'
  })
})

test('release names the parent itself and refuses everything else', () => {
  const lineage = buildLineage([ROOT, CHILD_A, CHILD_B, GRANDCHILD, OTHER_ROOT, FORK])
  const release = (childId) => decideReleaseEntry({ childId, allowRelease: true, lineage })

  // 格式不对的目标是请求错误；其余是宿主事实的拒绝。
  assert.equal(release('').code, 'bad_child_id')
  assert.equal(release(null).code, 'bad_child_id')
  assert.equal(release('no-such-child').code, 'child_not_found')
  // 顶层会话不是任何人的子代理行，因此没有可释放的父。
  assert.equal(release('root-1').code, 'child_not_found')
  assert.equal(release('other-root').code, 'child_not_found')
  // fork 不是子代理行。
  assert.equal(release('fork-1').code, 'child_not_found')
  // 谱系不可读时不能猜父。
  assert.equal(decideReleaseEntry({ childId: 'child-a', allowRelease: true, lineage: null }).code, 'lineage_unavailable')
})

test('release resolves the parent from the lineage, never from the request', () => {
  const lineage = buildLineage([ROOT, CHILD_A, GRANDCHILD])

  // grandchild 的父是 child-a，因此反查出的授权者是 child-a 而不是它的祖父。
  assert.equal(decideReleaseEntry({ childId: 'grandchild', allowRelease: true, lineage }).parentId, 'child-a')
  // 请求体即便带上 parentId 也不参与判定：判定函数根本没有这个参数。
  assert.equal(Object.keys(decideReleaseEntry({ childId: 'grandchild', allowRelease: true, lineage })).includes('parentId'), true)
  assert.equal(decideReleaseEntry({ childId: 'child-a', allowRelease: true, lineage }).parentId, 'root-1')
})

test('a direct child check that disagrees with the reverse lookup blocks the release', () => {
  const lineage = buildLineage([ROOT, CHILD_A, GRANDCHILD])

  // 反查与直接子代核是两条独立的判定，因此每条都能单独拒绝。
  assert.equal(isDirectChild(lineage, 'root-1', 'child-a'), true)
  assert.equal(isDirectChild(lineage, 'root-1', 'grandchild'), false, 'a grandchild is not a direct child')
  assert.equal(isDirectChild(lineage, 'child-a', 'grandchild'), true)
  assert.equal(isDirectChild(lineage, 'child-a', 'child-a'), false, 'the parent is not its own child')
  assert.equal(isDirectChild(null, 'root-1', 'child-a'), false)
  assert.equal(isDirectChild(lineage, null, 'child-a'), false)
  assert.equal(isDirectChild(lineage, 'root-1', null), false)
})

test('every release refusal has a line a reader can act on', () => {
  for (const code of ['disabled', 'bad_child_id', 'lineage_unavailable', 'child_not_found', 'not_direct_child', 'parent_not_live', 'release_unavailable']) {
    assert.equal(typeof RELEASE_REFUSAL_TEXT[code], 'string', code)
    assert.ok(RELEASE_REFUSAL_TEXT[code].length > 0, code)
  }
})

test('release hands the exact live parent and the selected child ids to drainChildren', async () => {
  const drained = []
  const lineage = createAgentLineage({
    agents: { list: () => [ROOT, CHILD_A, CHILD_B], get: (id) => [ROOT, CHILD_A, CHILD_B].find((a) => a.id === id) },
    subagents: { drainChildren: async (parent, childIds) => { drained.push({ parent: parent.id, childIds }) } }
  })

  assert.deepEqual(await lineage.release('root-1', ['child-a']), { ok: true, code: 'released' })
  // 传给原语的是注册表里那个 Agent 对象，不是同名的字符串；`drainChildren`
  // 内部正是这样核对的。
  assert.deepEqual(drained, [{ parent: 'root-1', childIds: ['child-a'] }])
})

test('release refuses a parent that is no longer live without reaching the primitive', async () => {
  const drained = []
  const lineage = createAgentLineage({
    agents: { list: () => [CHILD_A], get: () => undefined },
    subagents: { drainChildren: async (...args) => { drained.push(args) } }
  })

  assert.deepEqual(await lineage.release('root-1', ['child-a']), { ok: false, code: 'parent_not_live' })
  assert.deepEqual(drained, [], 'a stale parent must not reach drainChildren')
})

test('a parent that leaves the registry mid-release reads as a refusal, not a host failure', async () => {
  // 上游 drainChildren 对过期的父身份抛 UNAUTHORIZED。这是一个授权结论，因此
  // 翻译成一个可读的拒绝；其它异常照常上抛，那才是真的宿主故障。
  const unauthorized = Object.assign(new Error('subagent is not a direct child'), { code: 'UNAUTHORIZED' })
  const lineage = createAgentLineage({
    agents: { list: () => [ROOT, CHILD_A], get: () => ROOT },
    subagents: { drainChildren: async () => { throw unauthorized } }
  })
  assert.deepEqual(await lineage.release('root-1', ['child-a']), { ok: false, code: 'parent_not_live' })

  const broken = new Error('activation handle is closed')
  const failing = createAgentLineage({
    agents: { list: () => [ROOT, CHILD_A], get: () => ROOT },
    subagents: { drainChildren: async () => { throw broken } }
  })
  await assert.rejects(() => failing.release('root-1', ['child-a']), /activation handle is closed/)
})

test('release reports the missing capabilities instead of pretending to work', async () => {
  const noSubagents = createAgentLineage({ agents: { list: () => [], get: () => ROOT } })
  assert.deepEqual(await noSubagents.release('root-1', ['child-a']), { ok: false, code: 'release_unavailable' })

  const noAgents = createAgentLineage({ subagents: { drainChildren: async () => {} } })
  assert.deepEqual(await noAgents.release('root-1', ['child-a']), { ok: false, code: 'lineage_unavailable' })
  assert.equal(noAgents.census(), null, 'a missing lineage reads as unavailable, not as an empty host')
})

test('lineage captures the services through inject and drops them on disposal', async () => {
  let dispose = null
  const guarded = {
    get agents() { throw new Error('cannot get property "agents" without inject') },
    get subagents() { throw new Error('cannot get property "subagents" without inject') },
    inject(services, mount) {
      assert.deepEqual(Array.from(services), ['agents', 'subagents'])
      mount({
        agents: { list: () => [ROOT, CHILD_A], get: (id) => (id === 'root-1' ? ROOT : undefined) },
        subagents: { drainChildren: async () => {} },
        on(event, listener) { if (event === 'dispose') dispose = listener }
      })
    }
  }

  const lineage = createAgentLineage(guarded)
  assert.deepEqual(lineage.census().childrenOf.get('root-1').map((row) => row.id), ['child-a'])
  assert.deepEqual(await lineage.release('root-1', ['child-a']), { ok: true, code: 'released' })

  dispose()
  assert.equal(lineage.census(), null)
  assert.deepEqual(await lineage.release('root-1', ['child-a']), { ok: false, code: 'lineage_unavailable' })
})