// DTK-M2: the deterministic session entry. The panel previously guessed the
// current session from `sessions.list.getSnapshot().current`, which can be
// empty. A session-scope header action now hands the panel a sessionId the
// slot contract guarantees; the three states (available / root-required /
// unavailable) are expressed inside the root-scoped panel.
//
// This file boots the client bundle twice: once against the plugin's pure
// decision helpers (exposed as _tkTest) and once through the fake-React
// renderer to assert the panel's three-state UI.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { subagentAvailability } from '../lib/shared.js'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const MCP = 'cmd /c npx -y @upstash/context7-mcp'

// --- shared helpers -------------------------------------------------------

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

// Fake React sufficient to render the Panel tree: hook slots are reset per
// component invocation, which is exact for this bundle because only
// TreeKeeperSurface uses hooks.
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
    // TreeKeeperSurface hook slots: 0 useRef, 1 useOpen tick, 2 data,
    // 3 error, 4 loading, 5 armed, 6 focus revision.
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

// --- host: three-state helper ---------------------------------------------

test('host derives the three subagent states from the same ordering as the panel', () => {
  assert.equal(subagentAvailability('root-1', [{ id: 'child' }]), 'available')
  assert.equal(subagentAvailability('root-1', []), 'available')
  assert.equal(subagentAvailability('root-1', null), 'unavailable')
  assert.equal(subagentAvailability(null, []), 'root-required')
  assert.equal(subagentAvailability(undefined, []), 'root-required')
})

// --- client: pure decision helpers ----------------------------------------

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
    inject(services, mount) { mount({ slots: { inject() {}, register() {} } }) },
    on() {}
  })

  const helpers = plugin._tkTest
  assert.equal(helpers.subagentState({ subagentAvailability: 'unavailable' }, 'root-1'), 'unavailable')
  assert.equal(helpers.subagentState({ subagentAvailability: 'root-required' }, null), 'root-required')
  assert.equal(helpers.subagentState(null, null), 'root-required')
  assert.equal(helpers.subagentState({ subagentAvailability: 'available' }, 'root-1'), 'available')

  // The slot value wins over the guessed selection; absence resolves to null.
  assert.equal(helpers.resolveRootSessionId('focused-session', 'guessed-session'), 'focused-session')
  assert.equal(helpers.resolveRootSessionId(null, 'guessed-session'), 'guessed-session')
  assert.equal(helpers.resolveRootSessionId(null, null), null)
  assert.equal(helpers.resolveRootSessionId('', 'guessed-session'), 'guessed-session')

  assert.equal(helpers.snapshotQuery('session-xyz'), '?action=snapshot&rootSessionId=session-xyz')
  assert.equal(helpers.snapshotQuery(null), '?action=snapshot')

  // The one request path really sends the resolved root to the host API.
  helpers.focusSession('session-xyz')
  const resolved = helpers.resolveRootSessionId(helpers.getFocusSessionId(), 'guessed-session')
  await helpers.fetchSnapshot(resolved)
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0], '/dsh-treekeeper/api?action=snapshot&rootSessionId=session-xyz')
})

// --- client: slot value flows to the host API through the header action ---

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
    inject(services, mount) { mount({ slots }) },
    on() {}
  })

  const headerEntry = registered.find((entry) => entry.options.name === 'conversation.session.header.actions')
  assert.ok(headerEntry, 'session header entry is registered')
  assert.equal(headerEntry.options.id, 'treekeeper-open')
  assert.equal(headerEntry.options.order, 30)

  // Slot contract: the framework always passes a definite sessionId.
  const entryElement = renderNode(headerEntry.render({ sessionId: 'session-abc' }), react)
  const button = findButton(entryElement)
  assert.equal(button.length, 1)
  button[0].props.onClick()

  // The slot value is now the panel's deterministic root.
  assert.equal(plugin._tkTest.getFocusSessionId(), 'session-abc')
  const resolved = plugin._tkTest.resolveRootSessionId(plugin._tkTest.getFocusSessionId(), null)
  await plugin._tkTest.fetchSnapshot(resolved)
  assert.deepEqual(fetched, ['/dsh-treekeeper/api?action=snapshot&rootSessionId=session-abc'])
})

// --- client: the root-scoped panel expresses all three states --------------

function panelBoot(data, focusSessionId) {
  const react = makeFakeReact()
  const registered = []
  let dockRoot = null
  const context = {
    console: { warn() {} },
    navigator: { language: 'en-US' },
    document: {
      body: { appendChild(value) { dockRoot = value } },
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
    inject(services, mount) { mount({ slots }) },
    on() {}
  })

  // Focus the panel the way the header entry does: the entry itself opens the
  // panel, so only the no-focus case needs the dock button. Clicking the dock
  // while the panel is already open would close it, which is the real toggle.
  if (focusSessionId) {
    plugin._tkTest.focusSession(focusSessionId)
  } else {
    const dockButton = dockRoot.children.find((child) => child.dataset.createhelperDockItem === 'treekeeper')
    dockButton.listeners.click[0]()
  }
  react._seed(2, data)
  react._seed(4, false)
  const panel = allNodes(renderNode(registered[0].render(), react), (node) => node.props?.className === 'tk-panel')
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
