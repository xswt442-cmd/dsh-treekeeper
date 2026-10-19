// 面板的失败行。宿主异常的原文包含命令、Windows 错误串与路径，属于控制台和宿主
// 日志；浏览器拿到的是本插件公布的稳定错误码。这里按 `client-entry.test.js` 的
// 方式启动包——vm 里的经典脚本加上假 React——并通过包提供给测试的 `_tkTest`
// 辅助函数与面板自己的按钮两条路径驱动，让一次失败真的走完调用链：
// fetch -> hostFailure -> failureLine -> setError -> 渲染出来的那一行。

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

// 面板挂载

/**
 * 足够挂载 TreeKeeperSurface 并读回其状态的 React：面板的 hook 槽位（0 useRef、
 * 1 open tick、2 data、3 error、4 loading、5 armed、6 focus revision）放在一个
 * 数组里，测试可以直接写入。
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
    // 测试通过标题栏按钮驱动 `refresh`，不经过 effect。
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
 * 用一个假的 `fetch` 挂载打开的面板，返回重新渲染的函数。
 * 面板通过 `focusSession` 打开，与会话标题栏入口是同一次调用：渲染启动器行会先
 * 消耗掉面板的 hook 槽位。
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

/** 标题栏的刷新按钮：面板自己的快照调用点。 */
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
  // 本应携带宿主原文的那一行仍然记录它，写在控制台里——README 让需要原文的读者
  // 去那里找。
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

  // 面板没有对应文案的错误码会被说出来，不会被吞掉：用户可以把它抄下来，其余
  // 细节在日志里。
  assert.equal(failureLine(t, hostFailure({ ok: false, code: 'brand_new' }, 409)), 'request failed: brand_new')
})

test('a reply that is not JSON at all still lands as one line', () => {
  const { plugin } = bootClient()
  const { hostFailure, failureLine } = plugin._tkTest

  // 宿主前面的某个组件返回的 HTML 错误页，或者一个空的 502。
  assert.equal(failureLine(t, hostFailure(null, 502)), 'request failed: unknown_error')
  assert.equal(failureLine(t, hostFailure({}, 500)), 'request failed: unknown_error')
  // 传输层的失败也没有响应体与错误码。
  assert.equal(failureLine(t, new TypeError('Failed to fetch')), 'request failed: unknown_error')
})

/** 面板在错误槽位里渲染的那一行。 */
function errLine(tree) {
  const nodes = allNodes(tree, (n) => n.props?.className === 'tk-err')
  assert.equal(nodes.length, 1, 'the panel renders one error line')
  return textOf(nodes[0])
}

// 一份宿主原文，两个 fetch 调用点都会用到：抛错的路由写进自己 500 响应体的内容，
// 以及被拒绝的传输写进 Error 的内容。
const HOST_RAW = 'spawn powershell.exe EACCES: permission denied C:\\Users\\dev\\.dsh\\treekeeper'

/** 面板会提供终止按钮的发现：等级确证、单个 pid、归因根是 harness。 */
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

/** 两次 await 的 fetch 往返所需的全部微任务，不依赖定时器。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('a host exception text never reaches the rendered panel line', async () => {
  // 1. 快照调用点，面对一个响应体带着原文的宿主 500。
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

  // 2. 同一个调用点，传输层直接以异常原文拒绝。
  const rejected = bootPanel(async () => { throw new Error(HOST_RAW) })
  await refreshButton(rejected.render())[0].props.onClick()
  const rejectedTree = rejected.render()
  assert.equal(errLine(rejectedTree), 'request failed: unknown_error')
  assert.ok(!textOf(rejectedTree).includes(HOST_RAW), 'a rejected Error message is not panel text either')
  // 控制台保留面板丢掉的内容，README 让读者去那里找。
  assert.ok(rejected.logged.some((line) => line.includes(HOST_RAW)), 'the raw text is still reachable')

  // 3. 终止调用点：同样的响应体形状，另一个 fetch。
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
