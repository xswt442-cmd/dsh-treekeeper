import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { HistoryStore } from '../lib/store.js'

function responseCapture() {
  const writes = []
  return {
    writes,
    writeHead(status, headers) { writes.push({ status, headers }) },
    end(body) { writes.push({ body: JSON.parse(body) }) }
  }
}

/**
 * Minimal POST request for the routes that read a JSON body. `readBody` reads
 * `pid`/`seenCreatedMs` from the body, not the query string, so a caller that
 * wants to reach the kill gates has to send one.
 */
function postWith(body, url) {
  return postRaw(JSON.stringify(body), url)
}

/** The same request with the body as the wire sent it, so malformed JSON can be. */
function postRaw(text, url) {
  return {
    url,
    method: 'POST',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data') queueMicrotask(() => cb(Buffer.from(text)))
      if (event === 'end') queueMicrotask(() => cb())
      return this
    }
  }
}

/** Boot one profile and hand back its route plus the disposer the plugin registered. */
function bootRoute(services = {}) {
  let route = null
  let disposeCleanup = null
  apply({
    webServer: { port: 3080, register(value) { route = value; return () => {} } },
    inject(names, mount) {
      if (names.includes('connection') && services.connection) {
        mount({ connection: services.connection, on: services.connectionOn })
      }
    },
    effect(fn) { disposeCleanup = fn() }
  }, services.deps)
  return { route, dispose: () => disposeCleanup() }
}

/**
 * Point $DSH_HOME at a scratch home for one test and hand back the undo.
 * The undo deletes rather than assigning when the variable was unset:
 * `process.env.DSH_HOME = undefined` writes the string 'undefined', which
 * resolveDshHome reads as a home the harness accepts, and every later boot in
 * this file would then write its history under that name.
 */
function useDshHome(home) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

const get = (route, query, extra = {}) => {
  const res = responseCapture()
  return route.handler({
    url: '/dsh-treekeeper/api' + query,
    method: 'GET',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
    ...extra
  }, res).then(() => res)
}

test('host registers the guarded TreeKeeper API and releases it on disposal', async () => {
  let route = null
  let disposeCleanup = null
  let released = false
  apply({
    webServer: {
      port: 3080,
      register(value) {
        route = value
        return () => { released = true }
      }
    },
    subagents: {
      async listDescendants(rootSessionId) {
        return [{ kind: 'child', id: 'child-1', parentId: rootSessionId, depth: 1, mode: 'continuable', label: 'worker', activity: 'running', hasChildren: false }]
      }
    },
    // the host half registers its teardown via ctx.effect(() => cleanup)
    effect(fn) {
      disposeCleanup = fn()
    }
  })

  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/dsh-treekeeper/api')

  const res = responseCapture()
  await route.handler({
    url: '/dsh-treekeeper/api?action=not-real',
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  }, res)
  assert.equal(res.writes[0].status, 400)
  assert.deepEqual(res.writes[1].body, {
    ok: false,
    code: 'bad_action',
    error: 'unknown action "not-real"'
  })

  const subagentRes = responseCapture()
  await route.handler({
    url: '/dsh-treekeeper/api?action=subagents&rootSessionId=root-1',
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  }, subagentRes)
  assert.equal(subagentRes.writes[0].status, 200)
  assert.deepEqual(subagentRes.writes[1].body.subagents, [{
    kind: 'child', id: 'child-1', parentId: 'root-1', depth: 1,
    mode: 'continuable', label: 'worker', activity: 'running', hasChildren: false
  }])

  const missingRootRes = responseCapture()
  await route.handler({
    url: '/dsh-treekeeper/api?action=subagents',
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  }, missingRootRes)
  assert.equal(missingRootRes.writes[0].status, 400)
  assert.equal(missingRootRes.writes[1].body.code, 'root_required')

  disposeCleanup()
  assert.equal(released, true)
})

test('RC1 Connection rejection is final for the TreeKeeper API', async () => {
  let route
  apply({
    webServer: { port: 3080, register(value) { route = value; return () => {} } },
    inject(names, mount) {
      if (names.includes('connection')) {
        mount({ connection: { requestRejection: () => 401 }, on() {} })
      }
    },
    effect(fn) { fn() }
  })
  const res = responseCapture()
  await route.handler({
    url: '/dsh-treekeeper/api?action=history',
    method: 'GET',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' }
  }, res)
  assert.equal(res.writes[0].status, 401)
  assert.equal(res.writes[1].body.code, 'unauthorized')
})

test('request close aborts the descendant traversal signal', async () => {
  let route
  let close
  let observedSignal
  apply({
    webServer: { port: 3080, register(value) { route = value; return () => {} } },
    subagents: {
      listDescendants(_root, signal) {
        observedSignal = signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
    },
    effect(fn) { fn() }
  })
  const res = responseCapture()
  res.once = (event, fn) => { if (event === 'close') close = fn }
  res.off = () => {}
  const pending = route.handler({
    url: '/dsh-treekeeper/api?action=subagents&rootSessionId=root-1',
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    once() {},
    off() {}
  }, res)
  await Promise.resolve()
  close()
  await pending
  assert.equal(observedSignal.aborted, true)
  assert.equal(res.writes.length, 0, 'an aborted response must not write an error body')
})

// The plugin's own guard is the ONLY gate on a host that mounts no Connection
// service, and that is a real composition: the webserver and Connection ship in
// the same bundle today, so this fallback is what a reduced or hand-built host
// gets. Its off-loopback-peer branch is therefore asserted here at the route,
// where the mounted wiring decides it — a unit test on the guard alone cannot
// show that the route still reaches it.
test('with no Connection mounted, the route refuses an off-loopback peer itself', async () => {
  let route = null
  apply({
    webServer: {
      port: 3080,
      register(value) { route = value; return () => { } }
    },
    effect(fn) { fn() }
  })

  // A real loopback socket cannot stage this peer, so the route is driven
  // directly with a socket address no local client can have.
  for (const query of ['action=jobs', 'action=snapshot']) {
    const res = responseCapture()
    await route.handler({
      url: '/dsh-treekeeper/api?' + query,
      method: 'GET',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '203.0.113.7' }
    }, res)

    assert.equal(res.writes[0].status, 403, query + ' must not answer a remote peer')
    assert.equal(res.writes[1].body.code, 'non_loopback_peer')
    // The rejection must not carry the data it refused to serve.
    for (const field of ['jobs', 'ledgerAvailability', 'processes', 'findings', 'attributedCount']) {
      assert.ok(!(field in res.writes[1].body), 'the rejection leaks ' + field)
    }
  }
})

test('the kill route refuses before any OS call when the request or the snapshot is not ready', async () => {
  let route
  apply({
    webServer: { port: 3080, register(value) { route = value; return () => {} } },
    effect(fn) { fn() }
  })

  // The method gate answers before the body is read: a GET can never terminate.
  const getRes = responseCapture()
  await route.handler({
    url: '/dsh-treekeeper/api?action=kill&pid=1',
    method: 'GET',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' }
  }, getRes)
  assert.equal(getRes.writes[0].status, 405)
  // The published POST refusal is the embedded fragment's default shape,
  // unchanged by moving the gate into the block: code `method`, the action named
  // once.
  assert.deepEqual(getRes.writes[1].body, {
    ok: false,
    code: 'method',
    error: 'action "kill" requires POST'
  })

  // No snapshot has been taken in this profile, so the entry gate refuses and
  // taskkill is never reached. The pid is one no live process can hold, so a
  // gate that silently stopped working would fail this assertion instead of
  // terminating the test runner.
  const postRes = responseCapture()
  await route.handler(postWith({ pid: 999999, seenCreatedMs: 1 }, '/dsh-treekeeper/api?action=kill'), postRes)
  assert.equal(postRes.writes[0].status, 409)
  assert.deepEqual(postRes.writes[1].body, {
    ok: false,
    code: 'snapshot_required',
    error: 'refresh a complete process snapshot before terminating'
  })
})

test('a malformed body is a 400, not a stale-snapshot refusal', async () => {
  const { route } = bootRoute()

  // The regression this closes: a truncated kill body parsed to `{}`, the gates
  // saw "no matching pid" and answered 409 snapshot_required - telling the
  // caller to refresh a snapshot for a request that never named a pid.
  for (const text of ['{"pid":', 'not json', 'null', '[{"pid":1}]']) {
    const res = responseCapture()
    await route.handler(postRaw(text, '/dsh-treekeeper/api?action=kill'), res)
    assert.equal(res.writes[0].status, 400, text)
    assert.deepEqual(res.writes[1].body, {
      ok: false,
      code: 'bad_json',
      error: 'request body must be a JSON object'
    }, text)
  }

  // Same rule for the other mutating action, so no route reads fields out of a
  // body that failed to parse.
  const configRes = responseCapture()
  await route.handler(postRaw('{"pollMs":', '/dsh-treekeeper/api?action=config'), configRes)
  assert.equal(configRes.writes[0].status, 400)
  assert.equal(configRes.writes[1].body.code, 'bad_json')

  // The size contract keeps answering 413, ahead of the parse.
  const bigRes = responseCapture()
  await route.handler(postRaw('{"pad":"' + 'x'.repeat(70000), '/dsh-treekeeper/api?action=kill'), bigRes)
  assert.equal(bigRes.writes[0].status, 413)
  assert.equal(bigRes.writes[1].body.code, 'body_too_large')
})

test('a kill body must name a pid and a creation time', async () => {
  const { route } = bootRoute()
  const cases = [
    [{}, 400, 'bad_pid'],
    [{ pid: 'abc', seenCreatedMs: 1 }, 400, 'bad_pid'],
    [{ pid: '1e9', seenCreatedMs: 1 }, 400, 'bad_pid'],
    [{ pid: 0, seenCreatedMs: 1 }, 400, 'bad_pid'],
    [{ pid: -1, seenCreatedMs: 1 }, 400, 'bad_pid'],
    [{ pid: 1.5, seenCreatedMs: 1 }, 400, 'bad_pid'],
    [{ pid: 999999 }, 400, 'bad_created_ms'],
    [{ pid: 999999, seenCreatedMs: 'soon' }, 400, 'bad_created_ms'],
    [{ pid: 999999, seenCreatedMs: null }, 400, 'bad_created_ms']
  ]
  for (const [body, status, code] of cases) {
    const res = responseCapture()
    await route.handler(postWith(body, '/dsh-treekeeper/api?action=kill'), res)
    assert.equal(res.writes[0].status, status, JSON.stringify(body))
    assert.equal(res.writes[1].body.code, code, JSON.stringify(body))
  }

  // A well-formed integer still reaches the gates, which is what the 409 case
  // above proves; the validators must not become an new open door either.
  const ok = responseCapture()
  await route.handler(postWith({ pid: 999999, seenCreatedMs: 1 }, '/dsh-treekeeper/api?action=kill'), ok)
  assert.equal(ok.writes[0].status, 409)
  assert.equal(ok.writes[1].body.code, 'snapshot_required')
})

test('subtree refuses an absent or non-integer pid instead of reading it as 0', async () => {
  const { route } = bootRoute()
  for (const query of ['?action=subtree', '?action=subtree&pid=', '?action=subtree&pid=abc', '?action=subtree&pid=0', '?action=subtree&pid=-7', '?action=subtree&pid=1e9', '?action=subtree&pid=8.5']) {
    const res = await get(route, query)
    assert.equal(res.writes[0].status, 400, query)
    assert.equal(res.writes[1].body.code, 'bad_pid', query)
  }
})

test('config narrows pollMs to off or a bounded interval', async () => {
  const { route, dispose } = bootRoute()
  try {
    for (const pollMs of [100, 1999, 600001, 70000000, 'soon', {}, null, -1, 1e30]) {
      const res = responseCapture()
      await route.handler(postWith({ pollMs }, '/dsh-treekeeper/api?action=config'), res)
      assert.equal(res.writes[0].status, 400, JSON.stringify({ pollMs }))
      assert.equal(res.writes[1].body.code, 'bad_poll_ms', JSON.stringify({ pollMs }))
      assert.match(res.writes[1].body.error, /2000 and 600000/)
    }

    // Off and in-range still work, and the answer states what was set.
    const off = responseCapture()
    await route.handler(postWith({ pollMs: 0 }, '/dsh-treekeeper/api?action=config'), off)
    assert.equal(off.writes[0].status, 200)
    assert.equal(off.writes[1].body.config.pollMs, 0)

    const on = responseCapture()
    await route.handler(postWith({ pollMs: 5000 }, '/dsh-treekeeper/api?action=config'), on)
    assert.equal(on.writes[0].status, 200)
    assert.equal(on.writes[1].body.config.pollMs, 5000)

    // Whitelist pids are read with the same rule: junk entries are dropped
    // rather than becoming 0 (a pid every snapshot can contain nothing of).
    const pins = responseCapture()
    await route.handler(postWith({ extraWhitelistPids: [400, '500', 'abc', 1.5, 0, null] }, '/dsh-treekeeper/api?action=config'), pins)
    assert.deepEqual(pins.writes[1].body.config.extraWhitelistPids, [400, 500])
  } finally {
    dispose()
  }
})

test('a host failure answers a fixed code and keeps its message in the log', async (t) => {
  const logged = []
  t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')) })
  const hostFailure = 'Get-CimInstance : 拒绝访问 C:\\Users\\dev\\.dsh\\profiles\\web\\node_modules'
  // The sampler is the seam: a real one would spawn PowerShell, and the route
  // outcome under test is the failure handling, not the sampling.
  const { route } = bootRoute({ deps: { sample: () => { throw new Error(hostFailure) } } })

  const res = await get(route, '?action=snapshot')
  assert.equal(res.writes[0].status, 500)
  assert.deepEqual(res.writes[1].body, {
    ok: false,
    code: 'internal_error',
    error: 'treekeeper request failed; see the host log'
  })
  const text = JSON.stringify(res.writes[1].body)
  assert.ok(!text.includes(hostFailure), 'the raw host text must not reach the caller')
  assert.ok(!text.includes('C:\\'), 'nor a path')
  assert.ok(logged.some((line) => line.includes(hostFailure)),
    'the cause is in the host log, which is where a reader of the panel is sent')
  assert.ok(logged.some((line) => line.includes('snapshot')), 'the log line names the action that failed')
})

test('the sampler platform verdict keeps its own code', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { route } = bootRoute({
    deps: {
      sample: () => {
        const error = new Error('treekeeper: only Windows sampling is implemented in this skeleton (saw platform linux)')
        error.code = 'unsupported_platform'
        throw error
      }
    }
  })
  const res = await get(route, '?action=snapshot')
  assert.equal(res.writes[0].status, 500)
  assert.deepEqual(res.writes[1].body, {
    ok: false,
    code: 'unsupported_platform',
    error: 'process sampling is only implemented on Windows'
  })
})

test('subtree answers from the sample it was given and hides nothing about the host', async (t) => {
  t.mock.method(console, 'error', () => {})
  // ppid 0 on the root: a parent that is simply absent would be an orphan
  // finding, and a finding makes the snapshot route append to the history file —
  // this test has no business writing into whoever's harness home it runs in.
  const procs = [
    { pid: 100, ppid: 0, name: 'node', cmdline: 'node host', createdMs: 1, wsBytes: 0 },
    { pid: 101, ppid: 100, name: 'git', cmdline: 'git status', createdMs: 1, wsBytes: 0 }
  ]
  const { route } = bootRoute({ deps: { sample: async () => ({ procs, degraded: null }) } })
  const res = await get(route, '?action=subtree&pid=100')
  assert.equal(res.writes[0].status, 200)
  // The root first, then its descendants — the shape the panel renders as the
  // tree it is about to kill, and the same one the protected-descendant gate
  // scans.
  assert.deepEqual(res.writes[1].body.subtree.map((p) => p.pid), [100, 101])

  // A sampler that says "not here" is the same verdict the snapshot route gives.
  const unsupported = bootRoute({
    deps: {
      sample: () => {
        const error = new Error('only Windows sampling is implemented')
        error.code = 'unsupported_platform'
        throw error
      }
    }
  })
  const refused = await get(unsupported.route, '?action=subtree&pid=100')
  assert.equal(refused.writes[1].body.code, 'unsupported_platform')
})

// The kill route is where `snapshot.degraded` is spent: the gates trust the
// producer, so the route's own use of a fresh sample has to be asserted with one
// that is degraded, and with one that passes.
test('a degraded fresh sample refuses the pull even when the entry gate passed', async (t) => {
  t.mock.method(console, 'error', () => {})
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-routes-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const restoreHome = useDshHome(home)

  const target = { pid: 4234, ppid: process.pid, name: 'node', cmdline: 'node worker', createdMs: 1000, wsBytes: 0 }
  const healthy = { procs: [{ pid: process.pid, ppid: 0, name: 'node', cmdline: 'dsh host', createdMs: 900, wsBytes: 0 }, target], degraded: null }
  const degraded = { procs: healthy.procs.map((p) => ({ ...p, createdMs: null })), degraded: 'no-ppid' }

  const kills = []
  let call = 0
  const { route, dispose } = bootRoute({
    deps: {
      // takeSnapshot() samples first, then the kill route re-samples before the pull.
      sample: async () => (call++ === 0 ? healthy : degraded),
      killTree: async (opts) => { kills.push(opts); return { ok: true, code: 'killed' } }
    }
  })
  try {
    // Prime the snapshot the entry gate reads, so what follows really is refused
    // by the pre-pull re-sample and not by a missing snapshot.
    await get(route, '?action=snapshot')
    const res = responseCapture()
    await route.handler(postWith({ pid: 4234, seenCreatedMs: 1000 }, '/dsh-treekeeper/api?action=kill'), res)
    assert.equal(res.writes[0].status, 409)
    assert.deepEqual(res.writes[1].body, {
      ok: false,
      code: 'snapshot_required',
      error: 'refresh a complete process snapshot before terminating'
    })
    assert.deepEqual(kills, [], 'a degraded re-sample must stop the kill before act.js is called')
  } finally {
    dispose()
    restoreHome()
  }
})

test('a kill that runs forwards the fresh tree, and its OS text stays out of the body', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-routes-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const restoreHome = useDshHome(home)

  const host = { pid: process.pid, ppid: 0, name: 'node', cmdline: 'dsh host', createdMs: 900, wsBytes: 0 }
  const target = { pid: 4234, ppid: process.pid, name: 'node', cmdline: 'node worker', createdMs: 1000, wsBytes: 0 }
  const fresh = { procs: [host, target], degraded: null }
  const rawStderr = 'ERROR: The process 4234 could not be terminated. Access is denied.'
  const kills = []
  const { route, dispose } = bootRoute({
    deps: {
      sample: async () => fresh,
      killTree: async (opts) => {
        kills.push(opts)
        return { ok: false, code: 'taskkill_failed', detail: rawStderr }
      }
    }
  })

  try {
    // Prime the snapshot the entry gate reads with the same healthy tree.
    await get(route, '?action=snapshot')
    const res = responseCapture()
    await route.handler(postWith({ pid: 4234, seenCreatedMs: 1000 }, '/dsh-treekeeper/api?action=kill'), res)
    assert.equal(kills.length, 1, 'every gate passed, so the guarded kill ran')
    const opts = kills[0]
    assert.deepEqual(opts.procs, fresh.procs, 'the protected-descendant scan sees the pre-pull tree')
    assert.ok(opts.whitelistPids.has(process.pid), 'the host itself stays on the never-kill list')
    assert.equal(opts.seenCreatedMs, 1000)
    assert.equal(opts.config.allowKill, true)

    assert.equal(res.writes[0].status, 409)
    assert.deepEqual(res.writes[1].body, { ok: false, code: 'taskkill_failed' })
    assert.ok(!JSON.stringify(res.writes[1].body).includes('Access is denied'),
      'taskkill stderr is log material, not panel material')

    // The audit record keeps what the response dropped.
    const rows = await new HistoryStore(home).last(10)
    const kill = rows.find((row) => row.kind === 'kill')
    assert.equal(kill.code, 'taskkill_failed')
    assert.equal(kill.detail, rawStderr)
    assert.equal(kill.pid, 4234)
    // One history file is shared by every host on the machine, so each record
    // has to say which host wrote it; the file name itself cannot change.
    assert.equal(kill.hostPid, process.pid)
    assert.equal(kill.port, 3080)

    // A refusal whose detail is a name the plugin chose is still shown: it is the
    // answer to "why was this one refused", not a leak.
    const protectedKill = bootRoute({
      deps: {
        sample: async () => fresh,
        killTree: async () => ({ ok: false, code: 'protected', detail: 'lsass' })
      }
    })
    await get(protectedKill.route, '?action=snapshot')
    const protectedRes = responseCapture()
    await protectedKill.route.handler(postWith({ pid: 4234, seenCreatedMs: 1000 }, '/dsh-treekeeper/api?action=kill'), protectedRes)
    assert.deepEqual(protectedRes.writes[1].body, { ok: false, code: 'protected', detail: 'lsass' })
    protectedKill.dispose()
  } finally {
    dispose()
    restoreHome()
  }
})

test('a findings record names the host that wrote it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-routes-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const restoreHome = useDshHome(home)

  // A root whose recorded parent is absent from the sample: one orphan finding,
  // which is what makes the snapshot route append to the audit trail.
  const procs = [{ pid: process.pid, ppid: 77777, name: 'node', cmdline: 'node host', createdMs: 1, wsBytes: 0 }]
  const { route, dispose } = bootRoute({ deps: { sample: async () => ({ procs, degraded: null }) } })

  try {
    const res = await get(route, '?action=snapshot')
    assert.equal(res.writes[0].status, 200)

    const rows = await new HistoryStore(home).last(10)
    const record = rows.find((row) => row.kind === 'findings')
    assert.ok(record, 'a finding is recorded for the audit trail')
    assert.equal(record.count, 1)
    assert.equal(record.hostPid, process.pid)
    assert.equal(record.port, 3080)
  } finally {
    dispose()
    restoreHome()
  }
})

test('a browser authorizer states its verdict once per case', async () => {
  // requestRejection throwing is a Connection that cannot answer, not one that
  // permits: 503, and the route handler is never entered.
  const thrown = bootRoute({ connection: { requestRejection: () => { throw new Error('disposed') } } })
  const thrownRes = await get(thrown.route, '?action=jobs')
  assert.equal(thrownRes.writes[0].status, 503)
  assert.deepEqual(thrownRes.writes[1].body, { ok: false, code: 'connection_unavailable', error: 'browser authentication unavailable' })
  assert.equal(thrownRes.writes.length, 2, 'a refusal must not fall through to the handler')
  thrown.dispose()

  // Any rejection code other than 401 reads as forbidden.
  const forbidden = bootRoute({ connection: { requestRejection: () => 403 } })
  const forbiddenRes = await get(forbidden.route, '?action=jobs')
  assert.equal(forbiddenRes.writes[0].status, 403)
  assert.equal(forbiddenRes.writes[1].body.code, 'forbidden')
  forbidden.dispose()

  const allowed = bootRoute({ connection: { requestRejection: () => undefined } })
  const allowedRes = await get(allowed.route, '?action=jobs')
  assert.equal(allowedRes.writes[0].status, 200)
  assert.equal(allowedRes.writes[1].body.ok, true)
  allowed.dispose()
})

test('a reload gap answers 503 and does not fall back to the weaker guard fence', async () => {
  let disposeFn = null
  const { route } = bootRoute({
    connection: { requestRejection: () => undefined },
    connectionOn: (event, fn) => { if (event === 'dispose') disposeFn = fn }
  })
  assert.equal(typeof disposeFn, 'function', 'the authorizer must subscribe to disposal')
  disposeFn()

  // The guard would have let this request through: a loopback peer with a
  // loopback Host. Getting 503 instead proves the guard was never consulted.
  const res = await get(route, '?action=jobs', {
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }
  })
  assert.equal(res.writes[0].status, 503)
  assert.equal(res.writes[1].body.code, 'connection_unavailable')
})

test('with no Connection ever mounted, this plugin guard is the boundary', async () => {
  const { route } = bootRoute()
  const res = await get(route, '?action=jobs', {
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' }
  })
  assert.equal(res.writes[0].status, 200)
  assert.equal(res.writes[1].body.ok, true)

  const crossSite = await get(route, '?action=jobs', {
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }
  })
  assert.equal(crossSite.writes[0].status, 403)
  assert.equal(crossSite.writes[1].body.code, 'cross_site')
})

// `action` is the one request-supplied value this plugin writes into a host log
// line, so it is the one that can forge a row the plugin never wrote.
test('a request-supplied action cannot forge a second host log line', async (t) => {
  const logged = []
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))
  const { route, dispose } = bootRoute()

  // A response whose headers are already out: the reply this request earns cannot
  // be written, so the failure path runs — and logs with the caller's text in it.
  const send = async (query) => {
    const res = responseCapture()
    res.writeHead = () => { throw new Error('Cannot write headers after they are sent') }
    await assert.rejects(route.handler({
      url: '/dsh-treekeeper/api' + query,
      method: 'GET',
      headers: { host: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' }
    }, res), 'a reply that cannot be written still surfaces as a failed request')
  }

  try {
    await send('?action=%0D%0Ainjected%3A%20a%20forged%20second%20line')
    assert.equal(logged.length, 1, 'one failure, one log row')
    assert.ok(!/[\r\n]/.test(logged[0]), 'the action cannot start a second row')
    assert.match(logged[0], /injected: a forged second line/, 'the text stays readable on the one row')

    // Bounded as well: the action vocabulary here is nine characters, so a
    // caller that sends four hundred of them is not worth four hundred log bytes.
    await send(`?action=${'a'.repeat(400)}`)
    assert.equal(logged.length, 2, 'the second failure is its own row')
    assert.ok(!/a{100}/.test(logged[1]), 'the echoed action is cut, not copied')
    assert.match(logged[1], /a{20}/, 'and what is left still identifies the request')
  } finally {
    dispose()
  }
})
