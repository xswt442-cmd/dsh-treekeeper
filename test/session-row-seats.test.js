// 侧边栏会话行的两个常驻座位，槽位名为 `sidebar.session.row.leading` 与
// `sidebar.session.row.hover`。
//
// 前置单元格在每个空闲会话行上挂载，因此硬约束是两个座位都不能引起宿主工作：
// 它们只读面板加载快照时填好的模块级事实缓存。本文件通过假 React 渲染器启动
// 客户端包，断言四件事：座位以本插件的 id 注册在正确的槽位名上；缓存构建只收录
// 真正归到单个会话的宿主事实；前置座位没有缓存事实时不画，有事实时画 12px 图标；
// 悬停座位列出缓存事实，它的动作即使缓存为空也能把面板聚焦到该行自己的
// sessionId。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// 测试支架

function makeElement() {
  return {
    style: { setProperty() {} },
    dataset: {},
    children: [],
    setAttribute() {},
    addEventListener() {},
    appendChild(value) { this.children.push(value) },
    replaceChildren() { this.children = [] },
    remove() {}
  }
}

// 足以渲染行座位并挂载一次面板的假 React。`runEffects` 让集成测试驱动面板的打开
// effect，那是唯一会请求快照的地方；座位测试不开启它，因此一次渲染永远不会发起
// 请求。
function makeFakeReact({ runEffects = false } = {}) {
  const hookStates = []
  let hookIndex = 0
  return {
    createElement(type, props, ...children) {
      return { type, props, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useState(initial) {
      const i = hookIndex++
      if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial
      return [hookStates[i], (value) => { hookStates[i] = typeof value === 'function' ? value(hookStates[i]) : value }]
    },
    useRef(initial) {
      const i = hookIndex++
      if (!(i in hookStates)) hookStates[i] = { current: initial }
      return hookStates[i]
    },
    useEffect(fn) { if (runEffects) fn() },
    _resetHooks() { hookIndex = 0 }
  }
}

function renderNode(el, react) {
  if (el === null || el === undefined || el === false || el === true) return null
  if (typeof el !== 'object') return { text: String(el), children: [] }
  if (typeof el.type === 'function') {
    react._resetHooks()
    return renderNode(el.type(el.props), react)
  }
  return { type: el.type, props: el.props || {}, children: (el.children || []).map((c) => renderNode(c, react)).filter(Boolean) }
}

// 按槽位宿主的方式带上属性挂载一个已注册的座位。
function mountOccupant(entry, props, react) {
  return renderNode(react.createElement(entry.render, props), react)
}

function allNodes(node, predicate, out = []) {
  if (!node) return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) allNodes(child, predicate, out)
  return out
}

function textOf(node) {
  if (!node) return ''
  return (node.text ?? '') + (node.children || []).map(textOf).join('')
}

// 一份宿主快照响应体，形状与 lib/index.js 的答案一致

// GET /dsh-treekeeper/api?action=snapshot&rootSessionId=session-a
function snapshot() {
  return {
    ok: true,
    version: '0.3.0',
    pid: 100,
    takenAt: Date.now(),
    degraded: false,
    subagentRoot: 'session-a',
    subagentAvailability: 'available',
    // 宿主唯一归到具体会话的行：被聚焦的根自己的后代记录。
    subagents: [
      { kind: 'subagent', id: 'child-1', depth: 1, mode: 'continuable', label: 'worker', activity: 'running', hasChildren: false },
      { kind: 'subagent', id: 'child-2', depth: 1, mode: 'continuable', label: 'idle worker', activity: 'inactive', hasChildren: false },
      { kind: 'diagnostic', id: 'broken', depth: 1, reason: 'cycle' }
    ],
    // 这里的会话归属来自账本对账，不来自宿主进程列表。
    findings: [
      { type: 'duplicate', pids: [7], ownership: { scope: 'session', session: 'session-a', job: 'job-1' } },
      { type: 'orphan', pids: [8], ownership: { scope: 'unattributed', session: null, job: null } }
    ],
    reconcile: {
      summary: { jobs: 2, jobsMatched: 1, osOnly: 1, unattributed: 0 },
      rows: [
        { source: 'job', id: 'job-1', label: 'npx mcp', ownerSession: 'session-a', status: 'running', pids: [7], indicative: true },
        { source: 'job', id: 'job-2', label: 'unowned', ownerSession: null, status: 'running', pids: [9], indicative: true },
        { source: 'os-attributed', id: 'pid:7', label: 'node', ownerSession: null, status: 'running', pids: [7], indicative: false }
      ]
    },
    // 宿主进程行上没有会话字段：这个列表永远不会被缓存。
    processes: [{ pid: 7, cmdline: 'node server.js', evidence: 'exact', attribution: { rootLabel: 'harness' } }],
    unknown: [],
    attributedCount: 1
  }
}

function boot({ runEffects = false } = {}) {
  const react = makeFakeReact({ runEffects })
  const registered = []
  const injected = []
  const fetches = []
  const context = {
    AbortController,
    navigator: { language: 'en-US' },
    document: {
      body: { appendChild() {} },
      documentElement: { dataset: {}, style: { setProperty() {} } },
      head: { appendChild() {} },
      createElement: makeElement,
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null },
      querySelectorAll() { return [] }
    },
    window: { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load() {} } },
    fetch: async (url, options) => {
      fetches.push({ url, options })
      return { ok: true, status: 200, json: async () => snapshot() }
    }
  }
  let definition = null
  context.window.__ModuleLoader__ = { load(value) { definition = value } }
  vm.runInNewContext(SOURCE, context, { filename: 'lib/client.js' })
  const plugin = definition.factory((name) => {
    assert.equal(name, 'react')
    return react
  })
  const slots = {
    inject(name, mount) { injected.push(name); mount() },
    register(options, render) { registered.push({ options, render }) }
  }
  plugin.apply({
    get() { assert.fail('the client must wait for slots instead of probing it once') },
    inject(services, mount) { mount({ slots, on() {} }) },
    on() {}
  })
  return { plugin, react, registered, injected, fetches }
}

function seat(registered, name) {
  const entry = registered.find((candidate) => candidate.options.name === name)
  assert.ok(entry, name + ' must be registered')
  return entry
}

// （一）两个座位注册在正确的槽位名上

test('both Session-row seats are registered with this plugin id and a free order', () => {
  const { registered, injected } = boot()
  for (const name of ['sidebar.session.row.leading', 'sidebar.session.row.hover']) {
    const entry = seat(registered, name)
    assert.equal(entry.options.name, name)
    assert.equal(entry.options.id, 'treekeeper')
    // 已发布的日程座位在两个槽位上都占 order 10。
    assert.equal(entry.options.order, 20)
    assert.equal(typeof entry.options.label, 'function')
    assert.equal(entry.options.label(), 'TreeKeeper')
    assert.equal(typeof entry.render, 'function')
    assert.ok(injected.includes(name))
  }
  // 已有的贡献保持不变。
  assert.deepEqual(registered.map((entry) => entry.options.id),
    ['treekeeper', 'utility-launcher', 'treekeeper-panel', 'treekeeper-open', 'treekeeper', 'treekeeper'])
})

// 缓存只保留宿主归到某一个会话的事实

test('the fact cache keeps only host facts attributed to a specific session', () => {
  const { plugin } = boot()
  const facts = plugin._tkTest.sessionFactsFrom(snapshot())

  // session-a 被 subagent 根、它名下的账本任务以及一条发现的账本链接点名；
  // 未归属的发现、无主任务、OS 归因行与每一条宿主进程行都归不到会话，因此不在
  // 缓存里。
  assert.deepEqual([...facts.keys()], ['session-a'])
  // 这张表位于包自己的 realm 里，因此比较它的一份副本。
  assert.deepEqual({ ...facts.get('session-a') }, { descendants: 2, running: 1, diagnostics: 1, jobs: 1, findings: 1 })
  assert.equal(plugin._tkTest.sessionFactIds().length, 0, 'building facts must not touch the store')

  // 聚焦会话之前，宿主回答没有根，也没有归到会话的账本行，因此什么都不缓存。
  const anonymous = snapshot()
  anonymous.subagentRoot = null
  anonymous.subagents = []
  anonymous.findings = []
  anonymous.reconcile.rows = [{ source: 'job', id: 'job-2', ownerSession: null, status: 'running', pids: [9] }]
  assert.equal(plugin._tkTest.sessionFactsFrom(anonymous).size, 0)
})

// （二）前置座位

test('the leading seat renders nothing without a cached fact and the glyph with one', () => {
  const { plugin, react, registered } = boot()
  const leading = seat(registered, 'sidebar.session.row.leading')

  assert.equal(mountOccupant(leading, { sessionId: 'session-a' }, react), null)

  plugin._tkTest.publishSessionFacts(snapshot())
  const mark = mountOccupant(leading, { sessionId: 'session-a' }, react)
  assert.ok(mark, 'a cached fact must paint the mark')
  assert.equal(mark.type, 'span')
  assert.equal(mark.props.className, 'tk-row-mark')
  assert.equal(mark.props.role, 'img')
  assert.equal(mark.props.title, 'TreeKeeper holds cached facts for this session')
  assert.equal(mark.props['aria-label'], mark.props.title)
  const glyph = allNodes(mark, (node) => node.type === 'svg')
  assert.equal(glyph.length, 1)
  assert.equal(glyph[0].props.width, 12)
  assert.equal(glyph[0].props.height, 12)
  assert.equal(glyph[0].props.stroke, 'currentColor')

  // 缓存里没有提到的行，以及缺失的 sessionId，都保持空白。
  assert.equal(mountOccupant(leading, { sessionId: 'session-b' }, react), null)
  assert.equal(mountOccupant(leading, {}, react), null)
})

// （三）悬停座位与它的聚焦动作

test('the hover seat shows the cached facts and focuses the panel on its row session', () => {
  const { plugin, react, registered, fetches } = boot()
  const hover = seat(registered, 'sidebar.session.row.hover')

  // 空缓存：没有事实行，但发现动作仍然存在且可用。
  const blank = mountOccupant(hover, { sessionId: 'session-a' }, react)
  assert.equal(blank.type, 'div')
  assert.equal(blank.props.className, 'tk-row-hover')
  assert.equal(allNodes(blank, (node) => node.props?.className === 'tk-row-hover-line').length, 0)
  const blankAction = allNodes(blank, (node) => node.type === 'button')
  assert.equal(blankAction.length, 1)
  assert.equal(blankAction[0].props.className, 'tk-row-hover-action')
  assert.equal(blankAction[0].props.title, 'View this session in TreeKeeper')
  blankAction[0].props.onClick()
  assert.equal(plugin._tkTest.getFocusSessionId(), 'session-a')
  assert.equal(plugin._tkTest.isOpen(), true, 'the action opens the panel like the session header does')

  plugin._tkTest.publishSessionFacts(snapshot())
  const filled = mountOccupant(hover, { sessionId: 'session-a' }, react)
  const line = allNodes(filled, (node) => node.props?.className === 'tk-row-hover-line')
  assert.equal(line.length, 1)
  assert.equal(textOf(line[0]), 'Subagents 2 (1 running) · Job ledger 1 · Findings 1 · 1 read issues')
  const action = allNodes(filled, (node) => node.type === 'button')[0]
  assert.equal(textOf(action), 'View this session in TreeKeeper')
  action.props.onClick()
  assert.equal(plugin._tkTest.getFocusSessionId(), 'session-a')

  // 两个座位都没有向宿主发起任何请求。
  assert.deepEqual(fetches, [])
})

// 面板加载是填充缓存的唯一来源，逐行座位不发起请求

test('the panel load fills the cache the row seats read, with one request for the focused root', async () => {
  const { plugin, react, registered, fetches } = boot({ runEffects: true })
  // 先按标题栏入口的方式聚焦，再挂载面板。
  plugin._tkTest.focusSession('session-a')
  const panel = registered.find((entry) => entry.options.id === 'treekeeper-panel')
  renderNode(panel.render(), react)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(fetches.map((call) => call.url), ['/dsh-treekeeper/api?action=snapshot&rootSessionId=session-a'])
  assert.deepEqual([...plugin._tkTest.sessionFactIds()], ['session-a'])

  const leading = seat(registered, 'sidebar.session.row.leading')
  assert.ok(mountOccupant(leading, { sessionId: 'session-a' }, react))
  assert.equal(mountOccupant(leading, { sessionId: 'session-b' }, react), null)
  assert.equal(fetches.length, 1, 'the seats must not add a request per row')
})
