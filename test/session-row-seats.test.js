// DTK-M3: the two ambient Session-row seats DSH 0.1.7-rc.2 declares on the
// sidebar (`sidebar.session.row.leading` / `sidebar.session.row.hover`).
//
// The leading cell mounts on every idle Session row, so the hard constraint is
// that neither occupant may cause host work: both read only the module-level
// fact cache the panel fills when it loads a snapshot. This file boots the
// client bundle through the fake-React renderer and asserts four things — the
// seats are registered on the right names with this plugin's id, the cache
// builder attributes only genuinely per-session host facts, the leading
// occupant is blank without a cached fact and paints the 12px glyph with one,
// and the hover occupant lines up the cached facts while its action focuses the
// panel on the row's own sessionId even with an empty cache.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// --- harness --------------------------------------------------------------

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

// Fake React sufficient for the row occupants and for mounting the panel once.
// `runEffects` lets the integration test drive the panel's open effect, which is
// the only place a snapshot is requested; the seat tests leave it off so a
// render can never start a request.
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

// Mount one registered occupant with props, exactly as the slot owner does.
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

// --- one host snapshot body, shaped like lib/index.js answers -------------

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
    // The only rows the host attributes to a specific session: the focused
    // root's own descendant records.
    subagents: [
      { kind: 'subagent', id: 'child-1', depth: 1, mode: 'continuable', label: 'worker', activity: 'running', hasChildren: false },
      { kind: 'subagent', id: 'child-2', depth: 1, mode: 'continuable', label: 'idle worker', activity: 'inactive', hasChildren: false },
      { kind: 'diagnostic', id: 'broken', depth: 1, reason: 'cycle' }
    ],
    // Session attribution here comes from the ledger join, not from the host
    // process list.
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
    // No session field exists on a host process row: this list is never cached.
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
    inject(services, mount) { mount({ slots }) },
    on() {}
  })
  return { plugin, react, registered, injected, fetches }
}

function seat(registered, name) {
  const entry = registered.find((candidate) => candidate.options.name === name)
  assert.ok(entry, name + ' must be registered')
  return entry
}

// --- (a) the two seats are registered on the right names ------------------

test('both Session-row seats are registered with this plugin id and a free order', () => {
  const { registered, injected } = boot()
  for (const name of ['sidebar.session.row.leading', 'sidebar.session.row.hover']) {
    const entry = seat(registered, name)
    assert.equal(entry.options.name, name)
    assert.equal(entry.options.id, 'treekeeper')
    // The shipped ui-schedule occupants sit at order 10 on both seats.
    assert.equal(entry.options.order, 20)
    assert.equal(typeof entry.options.label, 'function')
    assert.equal(entry.options.label(), 'TreeKeeper')
    assert.equal(typeof entry.render, 'function')
    assert.ok(injected.includes(name))
  }
  // The pre-existing contributions are untouched.
  assert.deepEqual(registered.map((entry) => entry.options.id),
    ['treekeeper', 'utility-launcher', 'treekeeper-panel', 'treekeeper-open', 'treekeeper', 'treekeeper'])
})

// --- the cache only holds what the host attributes to one session ---------

test('the fact cache keeps only host facts attributed to a specific session', () => {
  const { plugin } = boot()
  const facts = plugin._tkTest.sessionFactsFrom(snapshot())

  // session-a is named by the subagent root, by its ledger-owned job and by one
  // finding's ledger join; the unattributed finding, the ownerless job, the
  // OS-attributed row and every host process row are not attributable and are
  // therefore absent.
  assert.deepEqual([...facts.keys()], ['session-a'])
  // The map lives in the bundle's realm, so compare a copy of the fact.
  assert.deepEqual({ ...facts.get('session-a') }, { descendants: 2, running: 1, diagnostics: 1, jobs: 1, findings: 1 })
  assert.equal(plugin._tkTest.sessionFactIds().length, 0, 'building facts must not touch the store')

  // Before a session is focused the host answers with no root and no
  // session-owned ledger rows, so nothing at all is cached.
  const anonymous = snapshot()
  anonymous.subagentRoot = null
  anonymous.subagents = []
  anonymous.findings = []
  anonymous.reconcile.rows = [{ source: 'job', id: 'job-2', ownerSession: null, status: 'running', pids: [9] }]
  assert.equal(plugin._tkTest.sessionFactsFrom(anonymous).size, 0)
})

// --- (b) the leading occupant ---------------------------------------------

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

  // A row the cache does not mention, and a missing sessionId, stay blank.
  assert.equal(mountOccupant(leading, { sessionId: 'session-b' }, react), null)
  assert.equal(mountOccupant(leading, {}, react), null)
})

// --- (c) the hover occupant and its focus action --------------------------

test('the hover seat shows the cached facts and focuses the panel on its row session', () => {
  const { plugin, react, registered, fetches } = boot()
  const hover = seat(registered, 'sidebar.session.row.hover')

  // Empty cache: no fact line, but the discovery action is present and works.
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
  assert.equal(textOf(line[0]), 'Descendants 2 (1 running) · Job ledger 1 · Findings 1 · 1 read issues')
  const action = allNodes(filled, (node) => node.type === 'button')[0]
  assert.equal(textOf(action), 'View this session in TreeKeeper')
  action.props.onClick()
  assert.equal(plugin._tkTest.getFocusSessionId(), 'session-a')

  // Nothing either seat did reached the host.
  assert.deepEqual(fetches, [])
})

// --- the panel load is what fills the cache, and nothing per row does ------

test('the panel load fills the cache the row seats read, with one request for the focused root', async () => {
  const { plugin, react, registered, fetches } = boot({ runEffects: true })
  // Focus first, the way the session-header entry does, then mount the panel.
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
