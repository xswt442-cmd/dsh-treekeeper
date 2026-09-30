import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { treekeeperGuard, hasVerifiedCreationTime, parseCimDate, isLoopbackAddress, resolveDshHome, hostDshHome, dshSignals, hasPreviousHostSignal, rankUnattributed, unattributedRows, hostKind, HOST_KIND_DESKTOP, HOST_KIND_WEB } from '../lib/shared.js'

function response() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) }
  }
}

// Every request in these tests arrives over loopback unless a test says
// otherwise; the guard now keys off the TCP peer address, not the headers.
const loopback = (headers = {}) => ({ headers, socket: { remoteAddress: '127.0.0.1' } })

test('CIM dates and identity tolerance are parsed consistently', () => {
  const createdMs = parseCimDate('20260825162958.5+480')

  assert.equal(createdMs, Date.UTC(2026, 7, 25, 8, 29, 58, 500))
  assert.ok(hasVerifiedCreationTime(createdMs, createdMs + 750))
  assert.ok(!hasVerifiedCreationTime(createdMs, createdMs + 751))
  assert.ok(!hasVerifiedCreationTime(createdMs, null))
})

test('the .NET JSON date form is a creation time, and the .NET floor is not', () => {
  // Windows PowerShell 5.1's ConvertTo-Json has no ISO form: the JSON text is
  // `"\/Date(ms)\/"`, which parses back to `/Date(ms)/`. Reading it as null
  // stripped the creation time — and with it the kill button — from every row.
  assert.equal(parseCimDate('/Date(1790745392422)/'), 1790745392422)
  assert.equal(parseCimDate('  /Date(1790745392422)/  '), 1790745392422)
  // Digits only: the floor a refused property carries (1601-01-01) must not be
  // read back as a creation time the kill gate would then compare for identity.
  assert.equal(parseCimDate('/Date(-62135596800000)/'), null)
  assert.equal(parseCimDate('/Date(abc)/'), null)
  assert.equal(parseCimDate('/Date(1790745392422)/extra'), null)
  // Every form the two PowerShell generations emit, plus absence, stays distinct.
  assert.equal(parseCimDate('2026-08-25T16:29:59.250+08:00'), Date.UTC(2026, 7, 25, 8, 29, 59, 250))
  assert.equal(parseCimDate(null), null)
  assert.equal(parseCimDate(''), null)
})

test('DSH relevance orders the unattributed bucket, and only DSH paths accuse a dead host', () => {
  const desktopHost = {
    pid: 37224,
    name: 'DeepSeek Harness',
    cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --expose-internals "E:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js"'
  }
  assert.deepEqual(dshSignals(desktopHost).signals, ['image', 'expose-internals', 'asar', 'node_modules'])
  assert.equal(dshSignals(desktopHost).score, 13)
  assert.ok(hasPreviousHostSignal(desktopHost))

  // A package manager is a ranking signal only: `_npx` and `node_modules` say
  // nothing about which host spawned a process, so they never accuse one.
  const cache = {
    pid: 51,
    name: 'node',
    cmdline: 'node C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\x\\index.js'
  }
  assert.deepEqual(dshSignals(cache).signals, ['npx', 'node_modules'])
  assert.ok(!hasPreviousHostSignal(cache))
  // The `npx` a command line invokes is not the `_npx` cache path it runs from.
  assert.equal(dshSignals({ pid: 50, name: 'cmd', cmdline: 'cmd /c npx -y @upstash/context7-mcp' }).score, 0)
  assert.equal(dshSignals({ pid: 4, name: 'System', cmdline: '' }).score, 0)
  assert.equal(dshSignals(undefined).score, 0)

  const ranked = rankUnattributed([
    { pid: 900, name: 'svchost', cmdline: 'C:\\Windows\\system32\\svchost.exe -k netsvcs' },
    cache,
    desktopHost,
    { pid: 3, name: 'System', cmdline: '' }
  ])
  assert.deepEqual(ranked.map((p) => p.pid), [37224, 51, 3, 900], 'relevance first, then pid ascending')

  // The rows the host sends carry the desktop-application membership, so the
  // panel groups on that flag instead of matching the machine's command lines
  // again. The signal ids that select the membership stay in the host.
  const rows = unattributedRows([
    { pid: 900, ppid: 0, name: 'svchost', cmdline: 'svchost -k netsvcs' },
    desktopHost
  ])
  assert.deepEqual(rows.map((row) => row.pid), [37224, 900], 'the order is the ranked one')
  assert.deepEqual(rows.map((row) => row.desktopApp), [true, false])
  assert.ok(!('signals' in rows[0]), 'the signal ids do not cross to the browser')
  assert.equal(rows[0].ppid, undefined, 'a stamped row keeps the fields it came with')
  assert.equal(unattributedRows(null).length, 0)
})

// The desktop application's Electron set: the renderer, the GPU process and the
// network utility are the host's siblings, not its descendants, so they head a
// machine-wide bucket and read as leftovers. They are one application, and the
// host marks the rows that belong to it so the panel can show them as one group.
test('the desktop application membership follows the parent chain inside the bucket', () => {
  const main = { pid: 40376, ppid: 13784, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe"' }
  const gpu = { pid: 26928, ppid: 40376, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=gpu-process' }
  const renderer = { pid: 9480, ppid: 40376, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=renderer --standard-schemes=dsh-app' }
  const outsider = { pid: 35004, ppid: 0, name: 'node', cmdline: 'node C:\\billion-context\\dist\\index.js start' }

  const flags = (procs) => unattributedRows(procs).map((row) => [row.pid, row.desktopApp])

  // The parent chain identifies the set, so the members join whatever order the
  // ranked bucket arrived in, and a row whose parent is outside the bucket does
  // not join through it.
  const orders = [[main, gpu, renderer, outsider], [renderer, outsider, gpu, main], [gpu, outsider, renderer, main]]
  for (const order of orders) {
    assert.deepEqual(flags(order), [[9480, true], [26928, true], [40376, true], [35004, false]])
  }

  // A child of a child joins as well: the closure repeats while it grows.
  const util = { pid: 27240, ppid: 9480, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=utility' }
  assert.deepEqual(flags([util, outsider, main, gpu, renderer]), [[9480, true], [26928, true], [27240, true], [40376, true], [35004, false]])

  // Two runs of the application each keep their own children, and no row leaks
  // into the other run's group.
  const second = { pid: 40100, ppid: 13784, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe"' }
  const secondChild = { pid: 40101, ppid: 40100, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=gpu-process' }
  assert.deepEqual(flags([main, gpu, second, secondChild]), [[26928, true], [40100, true], [40101, true], [40376, true]])

  // The bucket keeps every row and its rank; the flag is the only addition.
  const rows = unattributedRows([outsider, main, gpu])
  assert.deepEqual(rows.map((row) => row.pid), [26928, 40376, 35004])
  assert.equal(rows.length, 3, 'membership does not remove a row from the bucket')
  assert.equal(unattributedRows([]).length, 0)
})

// The panel states which kind of host answered, and the answer is read from the
// process facts: the Electron bundle for the desktop host, node.exe for the web
// host. The environment is not evidence, because a `dsh web` host launched from
// the desktop application inherits ELECTRON_RUN_AS_NODE from it.
test('the host kind is read from the process facts, and the environment is not one of them', () => {
  assert.equal(HOST_KIND_DESKTOP, 'desktop')
  assert.equal(HOST_KIND_WEB, 'web')

  assert.equal(hostKind({
    execPath: 'E:\\DSH\\resources\\app.asar\\dsh\\node.exe',
    execArgv: [],
    argv: ['node', 'E:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'],
    env: {}
  }), HOST_KIND_DESKTOP)

  // The live desktop host: node.exe as the executable, the bundle's script in
  // argv, and the flag Node itself moved into execArgv.
  assert.equal(hostKind({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    execArgv: ['--expose-internals'],
    argv: ['node', 'E:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'],
    env: {}
  }), HOST_KIND_DESKTOP, 'the flag lives in execArgv on a live process')

  // A process row the sampler read from the operating system still shows the
  // flag inside the recorded command line.
  assert.equal(hostKind({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    execArgv: [],
    argv: ['node', '--expose-internals', 'E:\\DSH\\resources\\app.asar\\dsh\\lib\\index.js'],
    env: {}
  }), HOST_KIND_DESKTOP, 'the flag is still read out of a recorded command line')

  const web = { execPath: 'C:\\Program Files\\nodejs\\node.exe', execArgv: [], argv: ['node', 'C:\\dsh\\bin\\dsh.js', 'web'] }
  assert.equal(hostKind(web), HOST_KIND_WEB)
  assert.equal(hostKind({ ...web, env: { ELECTRON_RUN_AS_NODE: '1' } }), hostKind(web),
    'an inherited ELECTRON_RUN_AS_NODE does not make a web host read as a desktop host')
  assert.equal(hostKind({ ...web, env: {} }), hostKind(web))

  // An odd process object answers rather than throwing.
  assert.equal(hostKind({}), HOST_KIND_WEB)
  assert.equal(hostKind(undefined), HOST_KIND_WEB)
  assert.equal(hostKind({ execPath: 42, execArgv: 'nope', argv: [null, 7] }), HOST_KIND_WEB)
})

test('isLoopbackAddress folds real loopback forms and fails closed', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:127.0.0.2', '127.255.0.1']) {
    assert.ok(isLoopbackAddress(a), a)
  }
  for (const a of ['192.168.1.5', '10.0.0.1', '::2', 'example.com', '', null, undefined, '  ', '::ffff:8.8.8.8']) {
    assert.ok(!isLoopbackAddress(a), String(a))
  }
})

test('API guard accepts loopback and rejects browser cross-site requests', () => {
  const guard = treekeeperGuard()
  const allowedResponse = response()
  const rejectedResponse = response()

  assert.equal(guard(loopback({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }), allowedResponse), true)
  assert.equal(guard(loopback({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), rejectedResponse), false)
  assert.equal(rejectedResponse.status, 403)
  assert.equal(rejectedResponse.body.code, 'cross_site')
})

// DTK-M2 guard regression: the session entry never touches the API directly,
// but it raised the request surface of the client, so the origin/host/site
// checks must stay airtight across every axis they already enforce.
test('API guard rejects a foreign Origin and a rebound non-loopback Host', () => {
  // The port is stated because the shared guard always compares an Origin's port
  // against the server's; a previous local copy of this guard skipped that check
  // when no port was configured, which admitted `http://localhost:3080` to a
  // server on any other port. The generated block compares unconditionally.
  const guard = treekeeperGuard({ currentPort: () => 3080 })

  for (const origin of ['https://evil.example', 'https://127.0.0.1.evil.example', 'http://localhost.evil.example']) {
    const rejectedResponse = response()
    assert.equal(guard(loopback({ host: '127.0.0.1:3080', origin }), rejectedResponse), false)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'foreign_origin')
  }

  for (const host of ['rebound.example', '127.0.0.1.evil.example']) {
    const rejectedResponse = response()
    assert.equal(guard(loopback({ host, 'sec-fetch-site': 'same-origin' }), rejectedResponse), false)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'non_loopback')
  }

  // Only exact loopback spellings pass; arbitrary localhost subdomains are
  // rejected to keep DNS rebinding out of the API surface.
  for (const host of ['localhost:3080', '127.0.0.1:3080']) {
    const allowedResponse = response()
    assert.equal(guard(loopback({ host, origin: 'http://localhost:3080' }), allowedResponse), true)
  }
  const subdomainResponse = response()
  assert.equal(guard(loopback({ host: 'api.localhost' }), subdomainResponse), false)
  assert.equal(subdomainResponse.body.code, 'non_loopback')

  // The IPv4-mapped IPv6 form of loopback IS loopback: a dual-stack browser
  // reaches the panel as ::ffff:127.0.0.1, and rejecting it locks a legitimate
  // client out of its own API. Covered in both spellings; see the parity bin.
  for (const host of ['[::ffff:127.0.0.1]:3080', '[::ffff:7f00:1]:3080']) {
    const allowedResponse = response()
    assert.equal(guard(loopback({ host }), allowedResponse), true, `${host} is loopback`)
  }

  // A Host that parses to no hostname must fail closed, not skip the allowlist.
  // RFC 7230 requires brackets around an IPv6 literal; a client can send the
  // unbracketed form anyway, and `hostHostname` splits it at the first colon.
  for (const host of ['::1:3080', '::ffff:127.0.0.1:3080']) {
    const rejectedResponse = response()
    assert.equal(guard(loopback({ host }), rejectedResponse), false, `${host} is not a usable Host`)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'non_loopback')
  }
})

test('API guard uses strict loopback names, matching Origin ports, and bracketed IPv6', () => {
  const guard = treekeeperGuard({ currentPort: () => 3080 })
  for (const host of ['evil.localhost:3080', '[::1]:3080']) {
    const res = response()
    assert.equal(guard(loopback({ host }), res), host.startsWith('evil') ? false : true)
  }
  for (const origin of ['http://evil.localhost:3080', 'http://localhost:3081']) {
    const res = response()
    assert.equal(guard(loopback({ host: '127.0.0.1:3080', origin }), res), false)
    assert.equal(res.status, 403)
  }
  for (const origin of ['http://[::1]:3080', 'http://127.0.0.1:3080']) {
    const res = response()
    assert.equal(guard(loopback({ host: '[::1]:3080', origin }), res), true)
  }
})

test('API guard rejects a non-loopback TCP peer regardless of spoofed headers', () => {
  const guard = treekeeperGuard({ currentPort: () => 3080 })
  // Forged loopback Host + same-origin metadata, but the real peer is remote.
  const spoofed = response()
  assert.equal(
    guard({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '192.168.1.50' } }, spoofed),
    false
  )
  assert.equal(spoofed.status, 403)
  assert.equal(spoofed.body.code, 'non_loopback_peer')
  // HTTP/1.0-style request with no Host header at all, remote peer.
  const noHost = response()
  assert.equal(guard({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }, noHost), false)
  assert.equal(noHost.body.code, 'non_loopback_peer')
})

test('API guard allows loopback TCP peers including IPv6 loopback forms', () => {
  const guard = treekeeperGuard({ currentPort: () => 3080 })
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const res = response()
    assert.equal(
      guard({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: addr } }, res),
      true
    )
  }
})

test('API guard fails closed when the peer address is missing or empty', () => {
  const guard = treekeeperGuard({ currentPort: () => 3080 })
  const cases = [
    { headers: { host: '127.0.0.1:3080' } }, // no socket at all
    { headers: { host: '127.0.0.1:3080' }, socket: {} }, // socket but no remoteAddress
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '' } },
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '   ' } },
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: null } }
  ]
  for (const req of cases) {
    const res = response()
    assert.equal(guard(req, res), false)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'non_loopback_peer')
  }
})

test('API guard accepts a same-origin Origin on the default HTTP port (80)', () => {
  const guard = treekeeperGuard({ currentPort: () => 80 })
  // http://127.0.0.1 has no explicit port; WHATWG URL normalizes .port to '',
  // so the comparison must fall back to the protocol's default port.
  const res = response()
  assert.equal(
    guard(loopback({ host: '127.0.0.1', origin: 'http://127.0.0.1' }), res),
    true
  )
  // A mismatched explicit port is still rejected.
  const mismatch = response()
  assert.equal(
    guard(loopback({ host: '127.0.0.1', origin: 'http://127.0.0.1:8080' }), mismatch),
    false
  )
  assert.equal(mismatch.body.code, 'foreign_origin')
})

// The harness home decides where this plugin's own history lands, so it is
// resolved with the same precedence the harness itself uses — including a
// tilde, which a plain path.join() would have made a literal directory name.
test('resolveDshHome honours the harness precedence and never falls back to cwd', () => {
  const homeDir = '/home/dsh-user' // (pure function: the argument is never touched)

  assert.equal(resolveDshHome({ DSH_HOME: '/srv/dsh-home' }, homeDir), path.resolve('/srv/dsh-home'))
  assert.equal(resolveDshHome({ DSH_HOME: '~/elsewhere' }, homeDir), path.resolve('/home/dsh-user/elsewhere'))
  assert.equal(resolveDshHome({}, homeDir), path.resolve('/home/dsh-user/.dsh'))
  for (const blank of ['', '   ', undefined]) {
    assert.equal(resolveDshHome({ DSH_HOME: blank }, homeDir), path.resolve("/home/dsh-user/.dsh"),
      'a blank override counts as unset')
  }
})

// The host's own accessor is the only answer that cannot drift from the harness
// rule, so it wins whenever the boot layer provided it; a context that provides
// nothing (a bare embedder, the route suites' stub) is the fallback case rather
// than a failure.
test('hostDshHome prefers the host accessor and falls back without one', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/srv/from-env'
  try {
    let calls = 0
    const accessor = () => { calls += 1; return '/srv/from-host' }
    const hosted = { get: (name) => (name === 'dshHomePath' ? accessor : undefined) }
    assert.equal(hostDshHome(hosted), '/srv/from-host')
    assert.equal(calls, 1)

    // A context that offers no accessor, or offers something that is not one,
    // never has its value read as a home.
    for (const ctx of [{}, { get: () => undefined }, { get: () => '/srv/not-a-function' }]) {
      assert.equal(hostDshHome(ctx), path.resolve('/srv/from-env'))
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
