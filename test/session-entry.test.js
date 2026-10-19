// 确定性的会话入口。会话作用域的标题栏操作把槽位契约保证存在的 sessionId 交给
// 面板；这个 id 优先于可能为空的 `sessions.list.getSnapshot().current` 决定根。
// 三种状态（available / root-required / unavailable）在根作用域的面板里表达。
//
// 本文件启动两次客户端包：一次只针对插件暴露为 _tkTest 的纯判定函数，一次通过
// 假 React 渲染器断言面板的三态界面。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { subagentAvailability } from '../lib/shared.js'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const MCP = 'cmd /c npx -y @upstash/context7-mcp'

// 共用辅助函数

function makeElement() {
  return {
    style: { setProperty() {} },
    dataset: {},
    children: [],
    hidden: false,
    innerHTML: '',
    title: '',
    type: '',
    className: '',
    listeners: {},
    setAttribute() {},
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    appendChild(value) { this.children.push(value) },
    replaceChildren() { this.children = [] },
    remove() {}
  }
}

function boot(bundle, context) {
  let definition = null
  context.window.__ModuleLoader__ = { load(value) { definition = value } }
  vm.runInNewContext(SOURCE, context, { filename: 'lib/client.js' })
  return definition
}

// 足以渲染 Panel 树的假 React：hook 槽位在每次组件调用时重置，对这个包是准确的，
// 因为只有 TreeKeeperSurface 使用 hook。
function makeFakeReact() {
  const hookStates = []
  let hookIndex = 0
  const react = {
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
    useEffect() { /* effects are out of scope: no fetch, no listeners */ },
    _resetHooks() { hookIndex = 0 },
    // TreeKeeperSurface 的 hook 槽位：0 useRef、1 useOpen tick、2 data、
    // 3 error、4 loading、5 armed、6 focus revision。
    _seed(index, value) { hookStates[index] = value }
  }
  return react
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

function findButton(node) {
  return allNodes(node, (n) => n.type === 'button' && n.props?.className === 'tk-session-entry')
}

// 宿主：三态辅助函数

test('host derives the three subagent states from the same ordering as the panel', () => {
  assert.equal(subagentAvailability('root-1', [{ id: 'child' }]), 'available')
  assert.equal(subagentAvailability('root-1', []), 'available')
  assert.equal(subagentAvailability('root-1', null), 'unavailable')
  assert.equal(subagentAvailability(null, []), 'root-required')
  assert.equal(subagentAvailability(undefined, []), 'root-required')
})

// 客户端：纯判定函数

test('the client exposes the three-state decision and root resolution for the panel', async () => {
  const fetched = []
  const context = {
    navigator: { language: 'en-US' },
    document: {
      body: { appendChild() {} },
      documentElement: { dataset: {}, style: { setProperty() {} } },
      head: { appendChild() {} },
      createElement: makeElement,
      querySelector() { return null },
      querySelectorAll() { return [] }
    },
    window: { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load() {} } },
    fetch: async (url) => { fetched.push(url); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
  }
  const definition = boot(SOURCE, context)
  const plugin = definition.factory(() => ({ createElement: () => null }))
  plugin.apply({
    get() {},
    inject(services, mount) { mount({ slots: { inject() {}, register() {} }, on() {} }) },
    on() {}
  })

  const helpers = plugin._tkTest
  assert.equal(helpers.subagentState({ subagentAvailability: 'unavailable' }, 'root-1'), 'unavailable')
  assert.equal(helpers.subagentState({ subagentAvailability: 'root-required' }, null), 'root-required')
  assert.equal(helpers.subagentState(null, null), 'root-required')
  assert.equal(helpers.subagentState({ subagentAvailability: 'available' }, 'root-1'), 'available')

  // 槽位值优先于猜测的当前选中项；两者都没有时得到 null。
  assert.equal(helpers.resolveRootSessionId('focused-session', 'guessed-session'), 'focused-session')
  assert.equal(helpers.resolveRootSessionId(null, 'guessed-session'), 'guessed-session')
  assert.equal(helpers.resolveRootSessionId(null, null), null)
  assert.equal(helpers.resolveRootSessionId('', 'guessed-session'), 'guessed-session')

  assert.equal(helpers.snapshotQuery('session-xyz'), '?action=snapshot&rootSessionId=session-xyz')
  assert.equal(helpers.snapshotQuery(null), '?action=snapshot')

  // 唯一的请求路径确实把解析出的根发给宿主接口。
  helpers.focusSession('session-xyz')
  const resolved = helpers.resolveRootSessionId(helpers.getFocusSessionId(), 'guessed-session')
  await helpers.fetchSnapshot(resolved)
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0], '/dsh-treekeeper/api?action=snapshot&rootSessionId=session-xyz')
})

// 客户端：槽位值经标题栏操作流向宿主接口

test('the session header action hands the slot sessionId to the panel and the host API', async () => {
  const fetched = []
  const react = makeFakeReact()
  const registered = []
  const dockRoot = { appendChild() {} }
  const context = {
    navigator: { language: 'en-US' },
    document: {
      body: { appendChild(value) { dockRoot.children ??= []; dockRoot.children.push(value) } },
      documentElement: { dataset: {}, style: { setProperty() {} } },
      head: { appendChild() {} },
      createElement: makeElement,
      querySelector() { return null },
      querySelectorAll() { return [] }
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: { load() {} }
    },
    fetch: async (url) => { fetched.push(url); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
  }
  const definition = boot(SOURCE, context)
  const plugin = definition.factory((name) => {
    assert.equal(name, 'react')
    return react
  })
  const slots = {
    inject(name, mount) { mount() },
    register(options, render) { registered.push({ options, render }) }
  }
  plugin.apply({
    get() {},
    inject(services, mount) { mount({ slots, on() {} }) },
    on() {}
  })

  const headerEntry = registered.find((entry) => entry.options.name === 'conversation.session.header.actions')
  assert.ok(headerEntry, 'session header entry is registered')
  assert.equal(headerEntry.options.id, 'treekeeper-open')
  assert.equal(headerEntry.options.order, 30)

  // 槽位契约：框架总会传入一个确定的 sessionId。
  const entryElement = renderNode(headerEntry.render({ sessionId: 'session-abc' }), react)
  const button = findButton(entryElement)
  assert.equal(button.length, 1)
  button[0].props.onClick()

  // 槽位值现在是面板确定性的根。
  assert.equal(plugin._tkTest.getFocusSessionId(), 'session-abc')
  const resolved = plugin._tkTest.resolveRootSessionId(plugin._tkTest.getFocusSessionId(), null)
  await plugin._tkTest.fetchSnapshot(resolved)
  assert.deepEqual(fetched, ['/dsh-treekeeper/api?action=snapshot&rootSessionId=session-abc'])
})

// 客户端：根作用域面板表达全部三种状态

function panelBoot(data, focusSessionId) {
  const react = makeFakeReact()
  const registered = []
  const context = {
    console: { warn() {} },
    navigator: { language: 'en-US' },
    document: {
      body: { appendChild() {} },
      documentElement: { dataset: {}, style: { setProperty() {} } },
      head: { appendChild() {} },
      createElement: makeElement,
      querySelector() { return null },
      querySelectorAll() { return [] }
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: { load() {} }
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, subagentAvailability: 'unavailable' }) })
  }
  const definition = boot(SOURCE, context)
  const plugin = definition.factory((name) => {
    assert.equal(name, 'react')
    return react
  })
  const slots = {
    inject(name, mount) { mount() },
    register(options, render) { registered.push({ options, render }) }
  }
  plugin.apply({
    get() {},
    inject(services, mount) { mount({ slots, on() {} }) },
    on() {}
  })

  // 按标题栏入口的方式聚焦面板：入口本身会打开面板，因此只有“没有聚焦”的情形
  // 需要经过启动器。面板已打开时再点启动器会把它关掉，这就是真实开关行为。
  if (focusSessionId) {
    plugin._tkTest.focusSession(focusSessionId)
  } else {
    const launcher = registered.find((entry) => entry.options.id === 'utility-launcher')
    assert.ok(launcher, 'the shared launcher must register on the shell overlay layer')
    const launcherButton = allNodes(renderNode(launcher.render({ wide: true }), react), (node) => node.type === 'button')[0]
    assert.ok(launcherButton, 'the launcher must render a button')
    launcherButton.props.onClick()
    const item = registered.find((entry) => entry.options.id === 'treekeeper')
    assert.ok(item, 'this plugin must contribute a row to the launcher menu')
    const menuRow = allNodes(renderNode(item.render({ wide: true }), react), (node) => node.type === 'button')[0]
    assert.ok(menuRow, 'the row must render a button')
    menuRow.props.onClick()
  }
  react._seed(2, data)
  react._seed(4, false)
  const panelEntry = registered.find((entry) => entry.options.id === 'treekeeper-panel')
  assert.ok(panelEntry, 'the panel must register on the overlay layer')
  const panel = allNodes(renderNode(panelEntry.render(), react), (node) => node.props?.className === 'tk-panel')
  assert.equal(panel.length, 1)
  return panel[0]
}

function subagentsSection(panel) {
  const section = allNodes(panel, (node) => node.type === 'details' && textOf(node).includes('Subagent tree'))
  assert.equal(section.length, 1)
  return section[0]
}

function baseData() {
  return {
    ok: true,
    takenAt: Date.now(),
    pid: 100,
    degraded: false,
    attributedCount: 1,
    findings: [],
    unknown: [],
    processes: [],
    reconcile: { summary: {}, rows: [] },
    subagents: [],
    subagentAvailability: 'root-required'
  }
}

test('panel shows root-required when no session is focused', () => {
  const panel = panelBoot(baseData(), null)
  const section = subagentsSection(panel)
  assert.match(textOf(section), /No session selected/)
  assert.doesNotMatch(textOf(section), /This DSH build/)
})

test('panel reports unavailable when the build lacks the subagents seam', () => {
  const data = baseData()
  data.subagentAvailability = 'unavailable'
  const panel = panelBoot(data, 'session-rooted')
  const section = subagentsSection(panel)
  assert.match(textOf(section), /This DSH build does not provide the capability/)
})

test('panel is available and names the focused session once a root exists', () => {
  const data = baseData()
  data.subagentAvailability = 'available'
  data.subagents = [
    { kind: 'subagent', id: 'child-1', depth: 1, mode: 'continuable', label: 'worker', activity: 'running', hasChildren: false }
  ]
  const panel = panelBoot(data, 'session-rooted')
  const section = subagentsSection(panel)
  assert.match(textOf(section), /session session-rooted/)
  assert.match(textOf(section), /running/)
  assert.match(textOf(section), /worker/)
})
