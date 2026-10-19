// 界面的噪音策略，针对真实的 Panel 树断言：带归因链的发现展开显示并提供终止
// 按钮；没有链条的发现收进默认关闭的 <details>，永远拿不到按钮。宿主的三个置信
// 等级分别计数、分别显示。来自旧负载的数据（没有 confidence 字段）必须仍然以
// `exact` 等级可见。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const MCP = 'cmd /c npx -y @upstash/context7-mcp'

/**
 * 最小假 React：够 TreeKeeperSurface 使用，再加一个元素遍历器，没有 DOM 也能
 * 检查 Panel 树。hook 槽位在每次组件调用时重置，启动器的 hook 与面板的互不干扰。
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
    useEffect() { /* 不执行 effect：没有请求，也没有监听器 */ },
    _resetHooks() { hookIndex = 0 },
    // TreeKeeperSurface 在 effect 里取数据；测试直接写入它的 useState 槽位
    // （0 useRef，1 tick，2 data，3 error，4 loading，5 armed）。
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
    inject(services, mount) { mount({ slots, on() {} }) },
    on() {}
  })

  // 按用户的操作打开面板：渲染启动器、点击它，再手动渲染面板表面（effect 被跳过，
  // 因此不会发生请求）。
  react._seed(2, data)
  react._seed(4, false)
  const launcher = registered.find((entry) => entry.options.id === 'utility-launcher')
  assert.ok(launcher, 'the shared launcher must register on the shell overlay layer')
  const launcherButton = allNodes(renderNode(launcher.render({ wide: true })), (node) => node.type === 'button')[0]
  assert.ok(launcherButton, 'the launcher must render a button')
  launcherButton.props.onClick()
  const item = registered.find((entry) => entry.options.id === 'treekeeper')
  assert.ok(item, 'this plugin must contribute a row to the launcher menu')
  const menuRow = allNodes(renderNode(item.render({ wide: true })), (node) => node.type === 'button')[0]
  assert.ok(menuRow, 'the row must render a button')
  menuRow.props.onClick()
  const panel = registered.find((entry) => entry.options.id === 'treekeeper-panel')
  assert.ok(panel, 'the panel must register on the overlay layer')
  const surface = () => renderNode(panel.render())
  return { surface, plugin }
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
        // 没有 confidence / ownership / provenance 的旧负载形状。
        type: 'duplicate', key: 'legacy:1', pids: [6], detail: 'payload from an older build',
        evidence: { sample: 'legacy cmd' }
      }
    ],
    unknown: [],
    // 行带上 `attribution`，因为 `processRows()` 会附带它；终止授权由它推出，
    // 缺了它的夹具测的就不是宿主真实产生的负载。
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

test('attributed findings stay expanded with kill buttons; chainless ones collapse without one', () => {
  const data = fixtureData()
  const { surface } = boot(data)
  const panel = panelOf(surface, data)

  // 收起的分区正好是一个默认关闭的 <details> 披露区。
  const disclosures = allNodes(panel, (node) => node.type === 'details' && node.props.className === 'tk-disclosure')
  const inferred = disclosures.find((node) => textOf(node).includes('Findings without an attribution chain'))
  assert.ok(inferred, 'the investigation disclosure exists')
  assert.equal(inferred.props.open, undefined, 'the collapsed bucket is closed by default')
  assert.match(textOf(inferred), /orphan\.dead-parent/)
  assert.match(textOf(inferred), /unattributed/)
  assert.equal(allNodes(inferred, (node) => node.props?.className === 'tk-row').length, 1)
  assert.equal(allNodes(inferred, (node) => node.props?.className === 'tk-btn').length, 0,
    'a collapsed finding is never a kill candidate, even with a known createdMs')

  // 已归因的行位于那个披露区之外，保留自己的终止按钮。
  const rows = allNodes(panel, (node) => node.props?.className === 'tk-row')
  assert.match(textOf(panel), /exact longlived/)
  assert.match(textOf(panel), /longlived\.plugin-child · host-descendant/)
  assert.match(textOf(panel), /exact duplicate/)
  assert.match(textOf(panel), /payload from an older build/, 'a payload without confidence stays visible at the exact level')

  // 每条可终止的已归因发现行（单个 pid、创建时间已知）都带自己的按钮；收起的那
  // 一行即使有创建时间也永远不带。
  for (const label of ['exact longlived', 'payload from an older build']) {
    const row = rows.find((node) => !containsNode(inferred, node) && textOf(node).includes(label))
    assert.ok(row, 'attributed finding row visible: ' + label)
    assert.equal(allNodes(row, (node) => node.props?.className === 'tk-btn').length, 1, label)
  }
})

test('kill buttons follow harness attribution, not evidence alone (REVIEW-0904 P1)', () => {
  const data = fixtureData()
  // 登记根的后代是“已归因”的，`evidence` 会说 'exact'，但它不属于 DSH 宿主树：
  // 在那里提供终止按钮既谎报服务器会接受，也把保护变成了扩大范围。
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

  // 按行自己的 pid 行匹配：重复发现渲染的命令行与它的证据样本相同，只看命令行
  // 无法区分。
  const host = rows.find((node) => textOf(node).includes('pid 2 ·'))
  assert.ok(host, 'the harness-attributed row is rendered')
  assert.equal(allNodes(host, (node) => node.props?.className === 'tk-btn').length, 1,
    'a harness-attributed row keeps its kill button')
})

// 宿主给每条发现盖三个等级之一，摘要同时给出三个计数。只读一个等级的桶也会
// 渲染出一行，因此每个计数单独验证，并检查 `indicative` 不会推高它不应影响的
// `exact` 计数。
test('the summary counts each confidence level separately', () => {
  const data = fixtureData()
  const { surface } = boot(data)
  const panel = panelOf(surface, data)
  const summary = allNodes(panel, (node) => node.props?.className === 'tk-summary')
  assert.equal(summary.length, 1)
  // 3 条 exact（两条已归因，一条是带不出 confidence 字段的旧负载）、0 条
  // indicative、1 条 inferred——按宿主自己的顺序。
  assert.match(textOf(summary[0]), /exact 3 · indicative 0 · inferred 1/)

  // 中间等级是降级采样产生的：宿主把它自己的等级封顶在 `indicative`，发现仍然
  // 保留归因链。
  const indicative = {
    type: 'duplicate', rule: 'duplicate.cmdline', key: 'mcp-degraded', pids: [2, 3, 4],
    detail: '3 processes share one command line, sampled degraded',
    confidence: 'indicative',
    ownership: { scope: 'host-descendant', via: 'ppid-chain', rootLabel: 'harness', depth: 1, session: null, job: null },
    provenance: { rule: 'duplicate.cmdline', description: 'the same normalized command line is alive in several copies at once' },
    evidence: { minCopies: 3, sample: MCP }
  }
  data.findings = [indicative, ...data.findings]
  const panelWithBoth = panelOf(boot(data).surface, data)
  const split = allNodes(panelWithBoth, (node) => node.props?.className === 'tk-summary')
  assert.match(textOf(split[0]), /exact 3 · indicative 1 · inferred 1/)
  assert.equal(countOf(split[0], 'exact'), 3, '一条 indicative 发现永远不会推高 exact 计数')
  assert.equal(countOf(split[0], 'indicative'), 1, '中间等级单独计数')
  assert.equal(countOf(split[0], 'inferred'), 1, 'inferred 计数不受中间等级影响')

  // 两个等级也分开显示：中间等级的行带 `indicative` 徽标，同一行不会被读成
  // `exact`，也不在那个徽标下的行里。它的链条完整，因此与其余已归因发现一起
  // 保持展开。
  const rows = allNodes(panelWithBoth, (node) => node.props?.className === 'tk-row')
  const middle = rows.find((node) => textOf(node).includes('sampled degraded'))
  assert.ok(middle, 'indicative 发现渲染自己的行')
  assert.match(textOf(middle), /^indicative duplicate/)
  assert.ok(!textOf(middle).includes('exact'), '中间等级永远不会读成 exact')
  const exactRows = rows.filter((node) => textOf(node).startsWith('exact '))
  assert.equal(exactRows.length, 3, 'exact 行就是盖了 exact 的三条发现，没有别的')
  assert.ok(!exactRows.includes(middle), 'indicative 发现不会落在任何 exact 行里')
})

/**
 * 摘要在一个等级旁边显示的数字。遍历器把各个 span 拼接起来，等级词可能紧跟数字
 * （`Findings 4exact 3`），自身没有词边界。
 */
function countOf(node, level) {
  const match = textOf(node).match(new RegExp('(^|[^a-z])' + level + ' (\\d+)'))
  assert.ok(match, 'the summary states ' + level)
  return Number(match[2])
}

// 宿主的摘要行报告两个范围，因为一个数字读不出信息：机器上有数百个未归属进程，
// 其中只有少数与 DSH 相关，因此面板同时给出相关的开头数量与它出自的整个集合。
test('the summary names the unattributed scope and its machine-wide total', () => {
  const data = fixtureData()
  data.reconcile = { summary: { jobs: 1, jobsMatched: 1, osOnly: 0, unattributed: 3, unattributedTotal: 386 }, rows: [] }
  const { surface } = boot(data)
  const panel = panelOf(surface, data)
  const head = allNodes(panel, (node) => node.props?.className === 'tk-sechead')
  assert.match(textOf(head[0]), /jobs 1 · matched 1 · os-only 0 · DSH-related unattributed 3 \/ machine-wide unattributed 386/)
})

// 未归属列表被截断到二十行，因此披露区必须说明徽标统计的是什么、排序是什么含义。
test('the unattributed disclosure states the scope of its badge', () => {
  const data = fixtureData()
  data.unknown = [
    { pid: 37224, ppid: 40376, name: 'DeepSeek Harness', cmdline: 'host', createdMs: Date.now() - 60000, wsBytes: 0, evidence: 'unattributed', attribution: null },
    { pid: 4, ppid: 0, name: 'System', cmdline: '', createdMs: null, wsBytes: 0, evidence: 'unattributed', attribution: null }
  ]
  const { surface } = boot(data)
  const panel = panelOf(surface, data)
  const disclosures = allNodes(panel, (node) => node.type === 'details' && node.props.className === 'tk-disclosure')
  const unknown = disclosures.find((node) => textOf(node).includes('Unattributed (ranked by DSH relevance)'))
  assert.ok(unknown, 'the unattributed disclosure exists')
  const unknownSummary = allNodes(unknown, (node) => node.type === 'summary')[0]
  assert.match(textOf(unknownSummary), /^Unattributed \(ranked by DSH relevance\)2$/, 'the badge counts the whole bucket, not the rows shown')
  assert.match(textOf(unknown), /2 unattributed processes machine-wide; ranked by DSH relevance, with the desktop application processes listed apart and the first 20 of the rest shown\./)
})

// 标题栏要回答“这是哪一棵树”。`$DSH_HOME/treekeeper` 与进程表是共享的，同一时刻
// 的桌面宿主与 `dsh web` 宿主会渲染出几乎相同的面板；所属 pid、端口与类型把它们
// 分开。
test('the panel header names the owning host by pid, port and kind', () => {
  const web = fixtureData()
  web.port = 3080
  web.hostKind = 'web'
  const desktop = { ...web, hostKind: 'desktop' }

  for (const [kind, label] of [['web', 'this host pid 100 · port 3080'], ['desktop', 'this host pid 100 · port 3080 · desktop host']]) {
    const data = { ...web, hostKind: kind }
    const { surface } = boot(data)
    const panel = panelOf(surface, data)
    const head = allNodes(panel, (node) => node.props?.className === 'tk-head')
    assert.equal(head.length, 1)
    const identity = allNodes(head[0], (node) => node.props?.className === 'tk-dim' && textOf(node).startsWith('this host'))
    assert.equal(identity.length, 1)
    assert.equal(textOf(identity[0]), label, kind)
  }
})

test('the header states an unknown port rather than dropping it', () => {
  const data = fixtureData()
  const { surface } = boot(data)
  const panel = panelOf(surface, data)
  const head = allNodes(panel, (node) => node.props?.className === 'tk-head')
  assert.match(textOf(head[0]), /this host pid 100 · port \?/)
})

// 被直接结束的宿主留下的残留有真实证据，却完全没有链条：置信等级
// `indicative`，作用域 `unattributed`。它收进排查区，徽标写的是宿主盖下的等级，
// 不是它所在的分区。
test('an indicative previous-host lead is investigated, never offered for kill', () => {
  const data = fixtureData()
  data.findings = data.findings.filter((finding) => finding.rule !== 'orphan.dead-parent')
  data.findings.push({
    type: 'orphan', rule: 'orphan.previous-host', key: 'pid:99', pids: [99],
    detail: 'parent 8888 is gone and node 99 still carries a DSH path',
    confidence: 'indicative',
    ownership: { scope: 'unattributed', via: 'none', rootLabel: null, depth: null, session: null, job: null },
    provenance: { rule: 'orphan.previous-host', description: 'an unattributed process outlived its parent and still carries a DSH deployment path' },
    evidence: { parentPid: 8888, name: 'node', signals: ['asar'] }
  })
  data.processes.push({ pid: 99, ppid: 0, name: 'node', cmdline: 'node app.asar index.js', createdMs: Date.now() - 60000, wsBytes: 0, evidence: 'unattributed', attribution: null })
  const { surface } = boot(data)
  const panel = panelOf(surface, data)

  const disclosures = allNodes(panel, (node) => node.type === 'details' && node.props.className === 'tk-disclosure')
  const leads = disclosures.find((node) => textOf(node).includes('Findings without an attribution chain'))
  assert.ok(leads, 'the lead lands in the investigation section')
  assert.match(textOf(leads), /indicative orphan/)
  assert.match(textOf(leads), /orphan\.previous-host/)
  assert.ok(!textOf(leads).includes('inferred orphan'), 'an indicative lead never reads as inferred')
  assert.equal(allNodes(leads, (node) => node.props?.className === 'tk-btn').length, 0,
    'a previous host survivor is a lead, not a kill candidate')
  // 语气跟随等级，而不是所在分区：建立在进程事实上的线索即使收起显示，也用
  // 警示色。
  const leadRow = allNodes(leads, (node) => node.props?.className === 'tk-row')[0]
  assert.equal(allNodes(leadRow, (node) => node.props?.className === 'tk-badge tk-warn').length, 1)
  // 等级与分区是两个问题：这条线索按中间等级计数，徽标写的是宿主盖下的等级。
  const summary = allNodes(panel, (node) => node.props?.className === 'tk-summary')
  assert.match(textOf(summary[0]), /exact 3 · indicative 1 · inferred 0/)
})

function containsNode(outer, inner) {
  if (outer === inner) return true
  for (const child of outer.children || []) {
    if (containsNode(child, inner)) return true
  }
  return false
}

// 桌面应用的 Electron 进程组排在整机集合的前面，因为它的进程是宿主的兄弟而不是
// 后代。宿主给属于它的行打上标记，面板把这些行显示成集合内一个带标签的组，组内
// 每一行保留普通行的各个列。
test("the desktop application's own processes render as one labelled group", () => {
  const data = fixtureData()
  const now = Date.now()
  const row = (pid, ppid, cmdline, desktopApp) => ({
    pid, ppid, name: 'DeepSeek Harness', cmdline, desktopApp,
    createdMs: now - 60000, wsBytes: 8 * 1024 * 1024,
    evidence: 'unattributed', attribution: null
  })
  data.unknown = [
    row(40376, 13784, '"E:\\DSH\\DeepSeek Harness.exe"', true),
    row(26928, 40376, '"E:\\DSH\\DeepSeek Harness.exe" --type=gpu-process', true),
    row(27240, 40376, '"E:\\DSH\\DeepSeek Harness.exe" --type=utility', true),
    row(9480, 40376, '"E:\\DSH\\DeepSeek Harness.exe" --type=renderer --standard-schemes=dsh-app', true),
    { pid: 4, ppid: 0, name: 'System', cmdline: '', desktopApp: false, createdMs: null, wsBytes: 0, evidence: 'unattributed', attribution: null }
  ]
  const { surface } = boot(data)
  const panel = panelOf(surface, data)

  const disclosures = allNodes(panel, (node) => node.type === 'details' && node.props.className === 'tk-disclosure')
  const bucket = disclosures.find((node) => textOf(node).includes('Unattributed (ranked by DSH relevance)'))
  assert.ok(bucket, 'the unattributed disclosure exists')
  const summary = allNodes(bucket, (node) => node.type === 'summary').map(textOf)
  assert.match(summary[0], /^Unattributed \(ranked by DSH relevance\)5$/, 'the badge counts the whole bucket, grouped rows included')

  const group = disclosures.find((node) => node !== bucket && textOf(node).includes('desktop application processes'))
  assert.ok(group, 'the group names the application it holds')
  const groupSummary = allNodes(group, (node) => node.type === 'summary')[0]
  assert.match(textOf(groupSummary), /^desktop application processes4$/)

  // 组内每一行都是普通行：它匹配到的命令行、pid、工作集与存活时长都能读到。
  const rows = allNodes(group, (node) => node.props?.className === 'tk-row')
  assert.equal(rows.length, 4)
  for (const pid of [40376, 26928, 27240, 9480]) {
    const row = rows.find((node) => textOf(node).includes('pid ' + pid + ' ·'))
    assert.ok(row, 'grouped row for pid ' + pid)
    assert.match(textOf(row), /8 MB · 1 min/)
    assert.match(textOf(row), /^unattributed/, 'a member keeps its evidence badge')
    assert.match(textOf(row), /DeepSeek Harness\.exe/)
  }
  assert.match(textOf(rows[1]), /--type=gpu-process/)
  assert.match(textOf(rows[3]), /--standard-schemes=dsh-app/)
  assert.equal(allNodes(group, (node) => node.props?.className === 'tk-btn').length, 0,
    'a grouped row is unattributed, so it exposes no tree-kill button')

  // 不属于任何组的行仍然是同一集合里的普通行。
  const loose = allNodes(bucket, (node) => node.props?.className === 'tk-row')
  assert.equal(loose.length, 5, 'the bucket renders every row exactly once')
  assert.ok(!containsNode(group, loose.find((node) => textOf(node).includes('pid 4 ·'))))
})

// 宿主把桌面应用成员标记盖在每一行上，因此面板只划分拿到的数据：每一行恰好回来
// 一次，顺序与到达时一致；完全没有这个标记的负载什么也不分组，也不会抛错。包在
// 自己的 realm 里运行，因此把它返回的数组按 pid 读取，不整体比较。
test('the panel partitions the bucket on the flag the host stamped', () => {
  const row = (pid, desktopApp) => ({ pid, ppid: 0, name: 'proc', cmdline: '', desktopApp })
  const { splitDesktopApp } = boot(fixtureData()).plugin._tkTest
  const pids = (rows) => rows.map((proc) => proc.pid)

  const { group, rest } = splitDesktopApp([row(40376, true), row(4, false), row(9480, true)])
  assert.deepEqual(pids(group), [40376, 9480])
  assert.deepEqual(pids(rest), [4])
  assert.equal(group.length + rest.length, 3, 'the bucket is partitioned, nothing is dropped')

  // 没有这个标记的行不属于任何组，排序顺序保持不变。
  const unstamped = splitDesktopApp([{ pid: 9480 }, row(40376, true)])
  assert.deepEqual(pids(unstamped.group), [40376])
  assert.deepEqual(pids(unstamped.rest), [9480])

  assert.equal(splitDesktopApp([]).group.length, 0)
  assert.equal(splitDesktopApp(null).group.length, 0)
  assert.equal(splitDesktopApp(undefined).rest.length, 0)
})
