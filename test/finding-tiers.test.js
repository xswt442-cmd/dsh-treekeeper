// DTK-M1 UI noise policy, asserted against the real Panel tree: findings with
// an attribution chain render expanded with kill buttons, findings without one
// collapse behind a closed <details> and never get one. The host's three
// confidence levels are counted and displayed separately, each in its own
// bucket. Payloads from older builds (no confidence field) must stay visible at
// the `exact` level.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const MCP = 'cmd /c npx -y @upstash/context7-mcp'

/**
 * Minimal fake React: enough hooks for TreeKeeperSurface plus an element
 * walker, so the Panel tree can be inspected without a DOM. Hook slots are
 * reset per component invocation, so the launcher's hooks stay separate from
 * the surface's.
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

  // Open the panel the way a user does: render the sidebar-footer launcher,
  // click it, then render the panel surface by hand (effects are skipped, so no
  // fetch happens).
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

test('attributed findings stay expanded with kill buttons; chainless ones collapse without one', () => {
  const data = fixtureData()
  const { surface } = boot(data)
  const panel = panelOf(surface, data)

  // The collapsed bucket is exactly one closed <details> disclosure.
  const disclosures = allNodes(panel, (node) => node.type === 'details' && node.props.className === 'tk-disclosure')
  const inferred = disclosures.find((node) => textOf(node).includes('Findings without an attribution chain'))
  assert.ok(inferred, 'the investigation disclosure exists')
  assert.equal(inferred.props.open, undefined, 'the collapsed bucket is closed by default')
  assert.match(textOf(inferred), /orphan\.dead-parent/)
  assert.match(textOf(inferred), /unattributed/)
  assert.equal(allNodes(inferred, (node) => node.props?.className === 'tk-row').length, 1)
  assert.equal(allNodes(inferred, (node) => node.props?.className === 'tk-btn').length, 0,
    'a collapsed finding is never a kill candidate, even with a known createdMs')

  // Attributed rows live outside that disclosure and keep their kill buttons.
  const rows = allNodes(panel, (node) => node.props?.className === 'tk-row')
  assert.match(textOf(panel), /exact longlived/)
  assert.match(textOf(panel), /longlived\.plugin-child · host-descendant/)
  assert.match(textOf(panel), /exact duplicate/)
  assert.match(textOf(panel), /payload from an older build/, 'a payload without confidence stays visible at the exact level')

  // Every killable attributed finding row (single pid, known createdMs) carries
  // its own button; the collapsed row never does even with createdMs available.
  for (const label of ['exact longlived', 'payload from an older build']) {
    const row = rows.find((node) => !containsNode(inferred, node) && textOf(node).includes(label))
    assert.ok(row, 'attributed finding row visible: ' + label)
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

// The host stamps one of three levels on every finding, and the summary states
// all three counts. A bucket that only ever reads one level would still render
// a line here, so each count is read on its own and an `indicative` finding is
// watched against the `exact` count it must not move.
test('the summary counts each confidence level separately', () => {
  const data = fixtureData()
  const { surface } = boot(data)
  const panel = panelOf(surface, data)
  const summary = allNodes(panel, (node) => node.props?.className === 'tk-summary')
  assert.equal(summary.length, 1)
  // 3 exact (two attributed, one an older payload that carries no confidence
  // field), no indicative, 1 inferred — in the host's own order.
  assert.match(textOf(summary[0]), /exact 3 · indicative 0 · inferred 1/)

  // The middle level is the one a degraded sample produces: the host caps its
  // own level at `indicative` and the finding keeps its attribution chain.
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
  assert.equal(countOf(split[0], 'exact'), 3, 'an indicative finding never raises the exact count')
  assert.equal(countOf(split[0], 'indicative'), 1, 'the middle level is counted on its own')
  assert.equal(countOf(split[0], 'inferred'), 1, 'the inferred level is unaffected by the middle level')

  // The two levels are also displayed apart: the middle-level row carries the
  // `indicative` badge, the same row does not read as `exact`, and it is not
  // among the rows counted under that badge. Its chain is intact, so it stays
  // expanded with the rest of the attributed findings.
  const rows = allNodes(panelWithBoth, (node) => node.props?.className === 'tk-row')
  const middle = rows.find((node) => textOf(node).includes('sampled degraded'))
  assert.ok(middle, 'the indicative finding renders its own row')
  assert.match(textOf(middle), /^indicative duplicate/)
  assert.ok(!textOf(middle).includes('exact'), 'the middle level never reads as exact')
  const exactRows = rows.filter((node) => textOf(node).startsWith('exact '))
  assert.equal(exactRows.length, 3, 'the exact rows are the three findings stamped exact, and no other')
  assert.ok(!exactRows.includes(middle), 'an indicative finding lands in no exact row')
})

/**
 * The number the summary renders next to one level. The walker concatenates the
 * spans, so the level word can follow a digit (`Findings 4exact 3`) and carry no
 * word boundary of its own.
 */
function countOf(node, level) {
  const match = textOf(node).match(new RegExp('(^|[^a-z])' + level + ' (\\d+)'))
  assert.ok(match, 'the summary states ' + level)
  return Number(match[2])
}

// The host's summary line reports two scopes, because one number could not be
// read: the machine has hundreds of unattributed processes and only a few are
// DSH-adjacent, so the panel states the related head and the bucket it came from.
test('the summary names the unattributed scope and its machine-wide total', () => {
  const data = fixtureData()
  data.reconcile = { summary: { jobs: 1, jobsMatched: 1, osOnly: 0, unattributed: 3, unattributedTotal: 386 }, rows: [] }
  const { surface } = boot(data)
  const panel = panelOf(surface, data)
  const head = allNodes(panel, (node) => node.props?.className === 'tk-sechead')
  assert.match(textOf(head[0]), /jobs 1 · matched 1 · os-only 0 · DSH-related unattributed 3 \/ machine-wide unattributed 386/)
})

// The unattributed list is truncated to twenty rows, so the disclosure has to
// say what the badge counts and what the order means.
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

// The header has to answer "which tree is this". `$DSH_HOME/treekeeper` and the
// process table are shared, so a desktop host and a `dsh web` host at the same
// time render nearly the same panel; the owning pid, port and kind separate them.
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

// A leftover of a host that was killed has real evidence and no chain at all:
// confidence `indicative`, scope `unattributed`. It collapses into the
// investigation section, and the badge names the level the host stamped rather
// than the section it sits in.
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
  // The tone follows the level rather than the section: a lead that rests on a
  // process fact wears the warn tone even though it renders collapsed.
  const leadRow = allNodes(leads, (node) => node.props?.className === 'tk-row')[0]
  assert.equal(allNodes(leadRow, (node) => node.props?.className === 'tk-badge tk-warn').length, 1)
  // A level and a section are separate questions: this lead is counted at the
  // middle level and the level the host stamped is the badge it wears.
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

// The desktop application's Electron set heads the machine-wide bucket because
// its processes are siblings of the host rather than its descendants. The host
// marks the rows that belong to it, so the panel shows them as one labelled
// group inside the bucket, and every member keeps the columns a loose row has.
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

  // Every member is a normal row: the cmdline it was matched on, its pid, its
  // working set and its age are all readable inside the group.
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

  // The row that belongs to no group stays a loose row of the same bucket.
  const loose = allNodes(bucket, (node) => node.props?.className === 'tk-row')
  assert.equal(loose.length, 5, 'the bucket renders every row exactly once')
  assert.ok(!containsNode(group, loose.find((node) => textOf(node).includes('pid 4 ·'))))
})

// The host stamps desktop-application membership on each row, so the panel only
// partitions what it was handed: every row comes back exactly once, in the order
// it arrived, and a payload that carries no flag at all groups nothing rather
// than throwing. The bundle runs in its own realm, so the arrays it returns are
// read as plain pids rather than compared whole.
test('the panel partitions the bucket on the flag the host stamped', () => {
  const row = (pid, desktopApp) => ({ pid, ppid: 0, name: 'proc', cmdline: '', desktopApp })
  const { splitDesktopApp } = boot(fixtureData()).plugin._tkTest
  const pids = (rows) => rows.map((proc) => proc.pid)

  const { group, rest } = splitDesktopApp([row(40376, true), row(4, false), row(9480, true)])
  assert.deepEqual(pids(group), [40376, 9480])
  assert.deepEqual(pids(rest), [4])
  assert.equal(group.length + rest.length, 3, 'the bucket is partitioned, nothing is dropped')

  // A row without the flag belongs to no group, and the rank order survives.
  const unstamped = splitDesktopApp([{ pid: 9480 }, row(40376, true)])
  assert.deepEqual(pids(unstamped.group), [40376])
  assert.deepEqual(pids(unstamped.rest), [9480])

  assert.equal(splitDesktopApp([]).group.length, 0)
  assert.equal(splitDesktopApp(null).group.length, 0)
  assert.equal(splitDesktopApp(undefined).rest.length, 0)
})
