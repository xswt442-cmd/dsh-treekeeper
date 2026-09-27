// The panel's failure line. A host exception's text names commands, Windows
// error strings and paths; it belongs in the console and the host log, and the
// browser gets the stable code this plugin publishes. Booted the way
// `client-entry.test.js` boots the bundle — a classic script in a vm with a fake
// React — and driven both through the `_tkTest` helpers the bundle exposes for
// tests and through the panel's own buttons, so a failure travels a real call
// site: fetch -> hostFailure -> failureLine -> setError -> the rendered line.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function bootClient() {
  const logged = []
  let definition = null
  const context = {
    console: { warn() {}, error: (...args) => logged.push(args.join(' ')) },
    navigator: { language: 'en-US' },
    document: {
      body: { appendChild() {} },
      documentElement: { dataset: {}, style: { setProperty() {} } },
      head: { appendChild(value) { context.__style = value } },
      createElement: () => ({ style: { setProperty() {} }, dataset: {}, setAttribute() {}, appendChild() {} }),
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
  const plugin = definition.factory(() => ({ createElement() {} }))
  return { plugin, logged }
}

// --- panel mounting -------------------------------------------------------

/**
 * Enough React to mount TreeKeeperSurface and read its state back: the panel's
 * hook slots (0 useRef, 1 open tick, 2 data, 3 error, 4 loading, 5 armed, 6
 * focus revision) live in one array a test can seed.
 */
function makeFakeReact() {
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
    // The test drives `refresh` through the header button instead of an effect.
    useEffect() {},
    _seed(index, value) { hookStates[index] = value },
    _reset() { hookIndex = 0 }
  }
}

function renderNode(el, react) {
  if (el === null || el === undefined || el === false || el === true) return null
  if (typeof el !== 'object') return { text: String(el), children: [] }
  if (typeof el.type === 'function') {
    react._reset()
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

/**
 * Mount the open panel against one fake `fetch`, and hand back a re-render.
 * The panel opens through `focusSession`, the same call the session header entry
 * makes: rendering the launcher row would spend the surface's hook slots first.
 */
function bootPanel(fetchImpl, data = null) {
  const react = makeFakeReact()
  const logged = []
  let definition = null
  const registered = []
  const context = {
    console: { warn() {}, error: (...args) => logged.push(args.join(' ')) },
    navigator: { language: 'en-US' },
    setTimeout: () => 0,
    AbortController: class {
      constructor() { this.signal = { aborted: false } }
      abort() { this.signal.aborted = true }
    },
    fetch: fetchImpl,
    document: {
      body: { appendChild() {} },
      documentElement: { dataset: {}, style: { setProperty() {} } },
      head: { appendChild() {} },
      createElement: () => ({ style: { setProperty() {} }, dataset: {}, setAttribute() {}, appendChild() {} }),
      querySelector() { return null },
      querySelectorAll() { return [] }
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      confirm: () => true,
      __ModuleLoader__: { load(value) { definition = value } }
    }
  }
  vm.runInNewContext(SOURCE, context, { filename: 'lib/client.js' })
  const plugin = definition.factory(() => react)
  const slots = {
    inject(name, mount) { mount() },
    register(options, render) { registered.push({ options, render }) }
  }
  plugin.apply({ get() {}, inject(services, mount) { mount({ slots, on() {} }) }, on() {} })
  plugin._tkTest.focusSession('root-1')

  if (data !== null) react._seed(2, data)
  const surface = registered.find((entry) => entry.options.id === 'treekeeper-panel')
  assert.ok(surface, 'the panel must register on the overlay layer')
  const render = () => renderNode(surface.render(), react)
  return { plugin, logged, render }
}

/** The header Refresh button: the panel's own snapshot call site. */
const refreshButton = (node) => allNodes(node, (n) => n.type === 'button' && n.props?.className === 'tk-headbtn')

const t = {
  closed: 'request failed',
  reasonStale: 'the snapshot is stale or degraded; resample before terminating',
  reasonUnsupported: 'process sampling is only implemented on Windows',
  reasonInternal: 'the host could not complete the request; see the host log',
  reasonAuth: 'an authorized browser session is required',
  reasonUnattributed: 'target is outside the DSH host tree and cannot be terminated',
  reasonBadBody: 'the request body is not usable'
}

test('a refusal is shown as this plugin states it, in the current language', () => {
  const { plugin, logged } = bootClient()
  const { hostFailure, failureLine } = plugin._tkTest

  const stale = hostFailure({ ok: false, code: 'snapshot_required', error: 'refresh a complete process snapshot before terminating' }, 409)
  assert.equal(stale.code, 'snapshot_required')
  assert.equal(failureLine(t, stale), t.reasonStale)
  assert.equal(failureLine(t, hostFailure({ ok: false, code: 'unsupported_platform' }, 500)), t.reasonUnsupported)
  assert.equal(failureLine(t, hostFailure({ ok: false, code: 'unauthorized' }, 401)), t.reasonAuth)
  assert.equal(failureLine(t, hostFailure({ ok: false, code: 'non_harness_root' }, 409)), t.reasonUnattributed)
  assert.equal(failureLine(t, hostFailure({ ok: false, code: 'bad_json' }, 400)), t.reasonBadBody)
  // The line that would have carried the host's raw text still records it, in the
  // console, which is where the README points a reader who needs it.
  assert.ok(logged.length >= 5, 'every failure logs')
  assert.ok(logged.some((line) => line.includes('snapshot_required')))
})

test('an unexpected host failure names its code and nothing else', () => {
  const { plugin, logged } = bootClient()
  const { hostFailure, failureLine } = plugin._tkTest

  const boom = hostFailure({ ok: false, code: 'internal_error', error: 'spawn powershell.exe EACCES C:\\Users\\dev\\.dsh' }, 500)
  const line = failureLine(t, boom)
  assert.equal(line, t.reasonInternal)
  assert.ok(!line.includes('powershell'), 'the panel line is not a place for a command line')
  assert.ok(logged.some((entry) => entry.includes('internal_error')))

  // A code the panel has no line for is stated, not swallowed: the user can quote
  // it and the log has the rest.
  assert.equal(failureLine(t, hostFailure({ ok: false, code: 'brand_new' }, 409)), 'request failed: brand_new')
})

test('a reply that is not JSON at all still lands as one line', () => {
  const { plugin } = bootClient()
  const { hostFailure, failureLine } = plugin._tkTest

  // An HTML error page from something in front of the host, or an empty 502.
  assert.equal(failureLine(t, hostFailure(null, 502)), 'request failed: unknown_error')
  assert.equal(failureLine(t, hostFailure({}, 500)), 'request failed: unknown_error')
  // And a transport-level failure has no body and no code either.
  assert.equal(failureLine(t, new TypeError('Failed to fetch')), 'request failed: unknown_error')
})

/** The one line the panel renders in its error slot. */
function errLine(tree) {
  const nodes = allNodes(tree, (n) => n.props?.className === 'tk-err')
  assert.equal(nodes.length, 1, 'the panel renders one error line')
  return textOf(nodes[0])
}

// One snapshot of host text, used on both fetch call sites: what a route that
// threw writes into its own 500 body, and what a rejected transport writes into
// its Error.
const HOST_RAW = 'spawn powershell.exe EACCES: permission denied C:\\Users\\dev\\.dsh\\treekeeper'

/** A finding the panel offers a kill button for: hard, one pid, harness-rooted. */
function killableData() {
  const created = 1780000000000
  return {
    ok: true,
    pid: 100,
    takenAt: created,
    degraded: null,
    findings: [{
      type: 'longlived', rule: 'longlived.plugin-child', key: 'pid:2', pids: [2],
      detail: 'a plugin child outlived the age threshold', confidence: 'exact',
      ownership: { scope: 'host', via: 'tree', rootLabel: 'harness', depth: 1 },
      evidence: { sample: 'node worker.js', ageMs: 45 * 60000, viaNpx: false }
    }],
    processes: [{
      pid: 2, ppid: 100, name: 'node', cmdline: 'node worker.js', createdMs: created,
      wsBytes: 0, evidence: 'exact', attribution: { rootId: 100, rootLabel: 'harness', depth: 1, pluginHint: null }
    }],
    attribution: { 2: { rootLabel: 'harness' } },
    unknown: [], jobs: [], subagents: [],
    reconcile: { rows: [], summary: { jobs: 0, jobsMatched: 0, osOnly: 0, unattributed: 0 } }
  }
}

/** Every microtask the two awaited fetch hops need, without a timer. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('a host exception text never reaches the rendered panel line', async () => {
  // 1. The snapshot call site, against a host 500 whose body carries the text.
  const answered = bootPanel(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, code: 'internal_error', error: HOST_RAW })
  }))
  const answeredButton = refreshButton(answered.render())
  assert.equal(answeredButton.length, 1, 'the panel header exposes one refresh action')
  await answeredButton[0].props.onClick()
  const answeredTree = answered.render()
  assert.equal(errLine(answeredTree), t.reasonInternal)
  assert.ok(!textOf(answeredTree).includes(HOST_RAW), 'the host sentence is not panel text')
  assert.ok(!textOf(answeredTree).includes('powershell'), 'nor is the command it names')

  // 2. The same call site when the transport itself rejects with exception text.
  const rejected = bootPanel(async () => { throw new Error(HOST_RAW) })
  await refreshButton(rejected.render())[0].props.onClick()
  const rejectedTree = rejected.render()
  assert.equal(errLine(rejectedTree), 'request failed: unknown_error')
  assert.ok(!textOf(rejectedTree).includes(HOST_RAW), 'a rejected Error message is not panel text either')
  // The console keeps what the panel drops, which is where the README points.
  assert.ok(rejected.logged.some((line) => line.includes(HOST_RAW)), 'the raw text is still reachable')

  // 3. The kill call site: the same body shape, a different fetch.
  const killing = bootPanel(async (url, options) => (options && options.method === 'POST'
    ? { ok: false, status: 500, json: async () => ({ ok: false, code: 'taskkill_failed', error: HOST_RAW }) }
    : { ok: true, status: 200, json: async () => ({ ok: true, ...killableData() }) }), killableData())
  const killButtons = allNodes(killing.render(), (n) => n.type === 'button' && n.props?.className === 'tk-btn')
  assert.ok(killButtons.length > 0, 'a harness-attributed target offers its kill button')
  killButtons[0].props.onClick()
  const armed = allNodes(killing.render(), (n) => n.type === 'button' && String(n.props?.className).includes('tk-btn-arm'))
  assert.ok(armed.length > 0, 'the first click arms it')
  armed[0].props.onClick()
  await flush()
  const killedTree = killing.render()
  assert.equal(
    errLine(killedTree),
    'request failed: taskkill_failed',
    'a code the panel has no line for is stated, and only that'
  )
  assert.ok(!textOf(killedTree).includes(HOST_RAW), 'no kill path pastes host text into the panel')
})
