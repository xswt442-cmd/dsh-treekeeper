// DTK-M1 UI noise policy, asserted against the real Panel tree: findings with
// an attribution chain (hard) render expanded with kill buttons, heuristic-only
// findings (inferred) collapse behind a closed <details> and never get one.
// Payloads from older builds (no confidence field) must stay visible as hard.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const MCP = 'cmd /c npx -y @upstash/context7-mcp'

/**
 * Minimal fake React: enough hooks for TreeKeeperSurface plus an element
 * walker, so the Panel tree can be inspected without a DOM. Hook slots are
 * reset per component invocation, which is exact for this bundle because only
 * the surface component uses hooks.
 */
let fakeReact = null
function makeFakeReact() {
  const hookStates = []
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
    // TreeKeeperSurface fetches inside an effect; tests seed its useState
    // slots directly (0 useRef, 1 tick, 2 data, 3 error, 4 loading, 5 armed).
    _seed(index, value) { hookStates[index] = value }
  }
  fakeReact = react
  return react
}

let hookIndex = 0

function renderNode(el) {
  if (el === null || el === undefined || el === false || el === true) return null
  if (typeof el !== 'object') return { text: String(el), children: [] }
  if (typeof el.type === 'function') {
    fakeReact?._resetHooks()
    return renderNode(el.type(el.props))
  }
  return { type: el.type, props: el.props || {}, children: (el.children || []).map(renderNode).filter(Boolean) }
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

function boot(data) {
  const react = makeFakeReact()
  let definition = null
  let dockRoot = null
  const registered = []
  const makeElement = () => ({
    style: { setProperty() {} },
    dataset: {},
    children: [],
    hidden: false,
    innerHTML: '',
    title: '',
    listeners: {},
    setAttribute() {},
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    appendChild(value) { this.children.push(value) },
    replaceChildren() { this.children = [] },
    remove() {}
  })
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
      __ModuleLoader__: { load(value) { definition = value } }
    }
  }

  vm.runInNewContext(SOURCE, context, { filename: 'lib/client.js' })
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

  // Open the panel the way a user does: click the dock item, then render the
  // slot surface by hand (effects are skipped, so no fetch happens).
  react._seed(2, data)
  react._seed(4, false)
  const dockButton = dockRoot.children.find((child) => child.dataset.createhelperDockItem === 'treekeeper')
  dockButton.listeners.click[0]()
  const surface = () => renderNode(registered[0].render())
  return { surface }
}

function fixtureData() {
  const now = Date.now()
  const hostAttribution = (depth) => ({ rootId: 100, rootLabel: 'harness', depth, pluginHint: null })
  const ownership = (scope, via) => ({ scope, via, rootLabel: scope === 'unattributed' ? null : 'harness', depth: scope === 'unattributed' ? null : 1, session: null, job: null })
  return {
    ok: true,
    takenAt: now,
    pid: 100,
    degraded: false,
    attributedCount: 5,
    findings: [
      {
        type: 'longlived', rule: 'longlived.plugin-child', key: 'pid:2', pids: [2],
        detail: 'some-mcp child alive for 45 min',
        confidence: 'exact', ownership: ownership('host-descendant', 'ppid-chain'),
        provenance: { rule: 'longlived.plugin-child', description: 'a process attributed to a plugin package outlived the age threshold' },
        evidence: { plugin: 'some-mcp', ageMs: 45 * 60000, viaNpx: false }
      },
      {
        type: 'duplicate', rule: 'duplicate.cmdline', key: 'mcp-set', pids: [2, 3, 4],
        detail: '3 processes share one command line',
        confidence: 'exact', ownership: ownership('host-descendant', 'ppid-chain'),
        provenance: { rule: 'duplicate.cmdline', description: 'the same normalized command line is alive in several copies at once' },
        evidence: { minCopies: 3, sample: MCP }
      },
      {
        type: 'orphan', rule: 'orphan.dead-parent', key: 'pid:5', pids: [5],
        detail: 'parent 4242 is gone but node 5 is alive',
        confidence: 'inferred', ownership: ownership('unattributed', 'none'),
        provenance: { rule: 'orphan.dead-parent', description: 'the recorded parent pid is missing from the current snapshot' },
        evidence: { parentPid: 4242, name: 'node' }
      },
      {
        // Pre-M1 payload shape: no confidence / ownership / provenance.
        type: 'duplicate', key: 'legacy:1', pids: [6], detail: 'payload from an older build',
        evidence: { sample: 'legacy cmd' }
      }
    ],
    unknown: [],
    // Rows carry `attribution` because `processRows()` attaches it; kill
    // authorization is derived from it, so a fixture without it would test a
    // payload the host never produces.
    processes: [
      { pid: 2, ppid: 100, name: 'node', cmdline: MCP, createdMs: now - 60000, wsBytes: 0, evidence: 'exact', attribution: hostAttribution(1) },
      { pid: 5, ppid: 0, name: 'node', cmdline: 'node mcp.js', createdMs: now - 60000, wsBytes: 0, evidence: 'unattributed', attribution: null },
      { pid: 6, ppid: 100, name: 'node', cmdline: 'legacy cmd', createdMs: now - 60000, wsBytes: 0, evidence: 'exact', attribution: hostAttribution(1) }
    ],
    reconcile: { summary: {}, rows: [] },
    subagents: [],
    subagentAvailability: 'root-required'
  }
}

function panelOf(surface, data) {
  const panel = allNodes(surface(), (node) => node.props?.className === 'tk-panel')
  assert.equal(panel.length, 1)
  return panel[0]
}

test('hard findings stay expanded with kill buttons; inferred collapse without one', () => {
  const data = fixtureData()
  const { surface } = boot(data)
  const panel = panelOf(surface, data)

  // The inferred bucket is exactly one closed <details> disclosure.
  const disclosures = allNodes(panel, (node) => node.type === 'details' && node.props.className === 'tk-disclosure')
  const inferred = disclosures.find((node) => textOf(node).includes('Inferred findings'))
  assert.ok(inferred, 'an inferred disclosure exists')
  assert.equal(inferred.props.open, undefined, 'inferred tier is collapsed by default')
  assert.match(textOf(inferred), /orphan\.dead-parent/)
  assert.match(textOf(inferred), /unattributed/)
  assert.equal(allNodes(inferred, (node) => node.props?.className === 'tk-row').length, 1)
  assert.equal(allNodes(inferred, (node) => node.props?.className === 'tk-btn').length, 0,
    'an inferred finding is never a kill candidate, even with a known createdMs')

  // Hard rows live outside that disclosure and keep their kill buttons.
  const rows = allNodes(panel, (node) => node.props?.className === 'tk-row')
  assert.match(textOf(panel), /hard longlived/)
  assert.match(textOf(panel), /longlived\.plugin-child · host-descendant/)
  assert.match(textOf(panel), /hard duplicate/)
  assert.match(textOf(panel), /payload from an older build/, 'a pre-M1 payload without confidence stays visible as hard')

  // Every killable hard finding row (single pid, known createdMs) carries its
  // own button; the inferred row never does even with createdMs available.
  for (const label of ['hard longlived', 'payload from an older build']) {
    const row = rows.find((node) => !containsNode(inferred, node) && textOf(node).includes(label))
    assert.ok(row, 'hard finding row visible: ' + label)
    assert.equal(allNodes(row, (node) => node.props?.className === 'tk-btn').length, 1, label)
  }
})

test('kill buttons follow harness attribution, not evidence alone (REVIEW-0904 P1)', () => {
  const data = fixtureData()
  // A whitelisted root's descendant is attributed, so `evidence` says 'exact',
  // but it is not the DSH host tree: offering a kill button there would both
  // lie about what the server accepts and turn a protection into an expansion.
  data.processes.push({
    pid: 7, ppid: 100, name: 'node', cmdline: 'pinned child', createdMs: Date.now() - 60000, wsBytes: 0,
    evidence: 'exact', attribution: { rootId: 500, rootLabel: 'whitelisted', depth: 1, pluginHint: null }
  })
  const { surface } = boot(data)
  const panel = panelOf(surface, data)
  const rows = allNodes(panel, (node) => node.props?.className === 'tk-row')

  const pinned = rows.find((node) => textOf(node).includes('pinned child'))
  assert.ok(pinned, 'the whitelisted-root descendant row is rendered')
  assert.equal(allNodes(pinned, (node) => node.props?.className === 'tk-btn').length, 0,
    'a whitelisted-root descendant exposes no tree-kill button')

  // Match on the row's own pid line: the duplicate finding renders the same
  // command line as its evidence sample, so the cmdline alone is ambiguous.
  const host = rows.find((node) => textOf(node).includes('pid 2 ·'))
  assert.ok(host, 'the harness-attributed row is rendered')
  assert.equal(allNodes(host, (node) => node.props?.className === 'tk-btn').length, 1,
    'a harness-attributed row keeps its kill button')
})

test('the summary splits findings by tier', () => {
  const data = fixtureData()
  const { surface } = boot(data)
  const panel = panelOf(surface, data)
  const summary = allNodes(panel, (node) => node.props?.className === 'tk-summary')
  assert.equal(summary.length, 1)
  assert.match(textOf(summary[0]), /hard 3 · inferred 1/)
})

function containsNode(outer, inner) {
  if (outer === inner) return true
  for (const child of outer.children || []) {
    if (containsNode(child, inner)) return true
  }
  return false
}
