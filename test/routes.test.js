import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { HOST_KIND_WEB } from '../lib/shared.js'
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
 * 读取 JSON 请求体的路由所需的最小 POST 请求。`readBody` 从请求体而不是查询串里
 * 读 `pid`/`seenCreatedMs`，因此想走到终止检查的调用方必须发送请求体。
 */
function postWith(body, url) {
  return postRaw(JSON.stringify(body), url)
}

/** 同一个请求，但请求体保持发送时的原文，用来构造格式错误的 JSON。 */
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

/** 启动一份配置，返回路由与插件注册的清理函数。 */
function bootRoute(services = {}) {
  let route = null
  let disposeCleanup = null
  apply({
    webServer: { port: 3080, register(value) { route = value; return () => {} } },
    // 只有需要启动层主目录访问器的挂载才提供 `get`；没有它时插件回退到
    // resolveDshHome()，本文件其他测试走的都是这条路径。
    ...(services.get ? { get: services.get } : {}),
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
 * 为一个测试把 $DSH_HOME 指向临时主目录，并返回撤销函数。
 * 变量原本未设置时撤销必须删除而不是赋值：`process.env.DSH_HOME = undefined`
 * 会写入字符串 'undefined'，resolveDshHome 把它当成宿主接受的主目录，本文件之后
 * 每次启动都会把历史写到那个名字下。
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
    // 宿主侧通过 ctx.effect(() => cleanup) 注册清理函数
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

// 在没有挂载 Connection 服务的宿主上，插件自己的守卫是唯一的关卡，而这是一种
// 真实组合：webserver 与 Connection 目前出自同一个包，精简或手工搭建的宿主拿到
// 的就是这条后备路径。因此它的“非回环对端”分支在路由层断言，由实际挂载的接线
// 决定——只测守卫本身无法说明路由仍然会走到它。
test('with no Connection mounted, the route refuses an off-loopback peer itself', async () => {
  let route = null
  apply({
    webServer: {
      port: 3080,
      register(value) { route = value; return () => { } }
    },
    effect(fn) { fn() }
  })

  // 真实的回环套接字造不出这种对端，因此直接用本地客户端不可能持有的套接字地址
  // 驱动路由。
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
    // 拒绝的响应不能带上它拒绝提供的数据。
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

  // 方法检查在读取请求体之前回答：GET 永远不能终止进程。
  const getRes = responseCapture()
  await route.handler({
    url: '/dsh-treekeeper/api?action=kill&pid=1',
    method: 'GET',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' }
  }, getRes)
  assert.equal(getRes.writes[0].status, 405)
  // 公布的 POST 拒绝是内嵌片段的默认形状：错误码 `method`，action 只出现一次。
  assert.deepEqual(getRes.writes[1].body, {
    ok: false,
    code: 'method',
    error: 'action "kill" requires POST'
  })

  // 这份配置还没有取过快照，因此入口检查拒绝，taskkill 不会被调用。pid 没有任何
  // 存活进程会持有，所以一道悄悄失效的检查会让这个断言失败，而不会终止测试运行器。
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

  // 被截断的终止请求体会解析成 `{}`，各道检查看到“没有匹配的 pid”后回答 409
  // snapshot_required，让调用方为一个从未指定 pid 的请求刷新快照。
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

  // 另一个会改变状态的 action 遵循同一条规则，因此没有路由会从解析失败的请求体
  // 里读字段。
  const configRes = responseCapture()
  await route.handler(postRaw('{"pollMs":', '/dsh-treekeeper/api?action=config'), configRes)
  assert.equal(configRes.writes[0].status, 400)
  assert.equal(configRes.writes[1].body.code, 'bad_json')

  // 大小限制仍然在解析之前回答 413。
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

  // 格式正确的整数仍然会走到各道检查，上面的 409 用例已经证明了这一点；这些
  // 校验器也不能变成新的后门。
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

    // 关闭与范围内的值都可用，回答里说明设置成了什么。
    const off = responseCapture()
    await route.handler(postWith({ pollMs: 0 }, '/dsh-treekeeper/api?action=config'), off)
    assert.equal(off.writes[0].status, 200)
    assert.equal(off.writes[1].body.config.pollMs, 0)

    const on = responseCapture()
    await route.handler(postWith({ pollMs: 5000 }, '/dsh-treekeeper/api?action=config'), on)
    assert.equal(on.writes[0].status, 200)
    assert.equal(on.writes[1].body.config.pollMs, 5000)

    // 登记的 pid 用同一套规则读取：无效条目被丢掉，不会变成 0（快照里不可能有
    // pid 0）。
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
  // 采样器是接缝：真实采样器会启动 PowerShell，这里要验证的是失败处理，不是采样。
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
  // 根的 ppid 为 0：单纯缺失的父进程会变成一条孤儿发现，而有发现时快照路由会
  // 往历史文件追加内容——这个测试不该写进运行它的宿主主目录。
  const procs = [
    { pid: 100, ppid: 0, name: 'node', cmdline: 'node host', createdMs: 1, wsBytes: 0 },
    { pid: 101, ppid: 100, name: 'git', cmdline: 'git status', createdMs: 1, wsBytes: 0 }
  ]
  const { route } = bootRoute({ deps: { sample: async () => ({ procs, degraded: null }) } })
  const res = await get(route, '?action=subtree&pid=100')
  assert.equal(res.writes[0].status, 200)
  // 先根、再后代——面板把这份顺序渲染成即将终止的树，受保护后代检查扫描的也是
  // 这棵树。
  assert.deepEqual(res.writes[1].body.subtree.map((p) => p.pid), [100, 101])

  // 采样器报告“此平台不支持”时，答案与快照路由一致。
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

// 终止路由是消费 `snapshot.degraded` 的地方：各道检查相信生产者，因此路由自己对
// 新采样的使用要分别用降级采样和正常采样断言。
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
      // takeSnapshot() 先采样，终止路由在执行前再采一次。
      sample: async () => (call++ === 0 ? healthy : degraded),
      killTree: async (opts) => { kills.push(opts); return { ok: true, code: 'killed' } }
    }
  })
  try {
    // 先准备入口检查读取的快照，这样后面的拒绝确实来自执行前的重采样，而不是
    // 缺少快照。
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
    // 用同一棵健康的树准备入口检查读取的快照。
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

    // 审计记录保留响应里被丢掉的内容。
    const rows = await new HistoryStore(home).last(10)
    const kill = rows.find((row) => row.kind === 'kill')
    assert.equal(kill.code, 'taskkill_failed')
    assert.equal(kill.detail, rawStderr)
    assert.equal(kill.pid, 4234)
    // 一台机器只有一个历史文件，因此每条记录都要说明是哪个宿主写的；文件名
    // 本身不能改。
    assert.equal(kill.hostPid, process.pid)
    assert.equal(kill.port, 3080)

    // detail 是本插件自己选定的名称时仍然会显示：它回答的是“这一条为什么被拒”，
    // 不是泄漏。
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

  // 根的记录父进程不在采样里：产生一条孤儿发现，快照路由因此往审计记录追加内容。
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

// 审计文件每台机器一份，桌面宿主与 `dsh web` 宿主因此写进同一个流。进程自己
// 推导的主目录若与宿主给出的不同，它会读到空历史，写下的记录也没有别人会打开，
// 所以宿主给出的主目录必须优先于 $DSH_HOME。这里两个主目录都是真实目录，断言
// 才能指出记录落在哪一个。
test('the host accessor, not $DSH_HOME, decides where the audit trail is written', async (t) => {
  const envHome = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-env-home-'))
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-host-home-'))
  t.after(() => {
    fs.rmSync(envHome, { recursive: true, force: true })
    fs.rmSync(hostHome, { recursive: true, force: true })
  })
  const restoreHome = useDshHome(envHome)

  // 根的记录父进程不在采样里：产生一条孤儿发现，快照路由因此往审计记录追加内容。
  const procs = [{ pid: process.pid, ppid: 77777, name: 'node', cmdline: 'node host', createdMs: 1, wsBytes: 0 }]
  const { route, dispose } = bootRoute({
    get: (name) => (name === 'dshHomePath' ? () => hostHome : undefined),
    deps: { sample: async () => ({ procs, degraded: null }) }
  })

  try {
    const res = await get(route, '?action=snapshot')
    assert.equal(res.writes[0].status, 200)

    const rows = await new HistoryStore(hostHome).last(10)
    assert.ok(rows.find((row) => row.kind === 'findings'), 'the host home received the audit record')
    assert.equal(fs.existsSync(path.join(envHome, 'treekeeper', 'history.jsonl')), false,
      '$DSH_HOME is not consulted when the host answers for itself')
  } finally {
    dispose()
    restoreHome()
  }
})

test('the snapshot names the host kind and stamps each unattributed row with its signals', async (t) => {
  t.mock.method(console, 'error', () => {})
  // 桌面应用的 Electron 进程组：主进程带映像名，子进程通过 ppid 走到它。四个
  // 进程都未归属，因为它们是宿主的兄弟而不是后代。
  const desktopMain = { pid: 40376, ppid: 13784, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe"', createdMs: 1, wsBytes: 0 }
  const procs = [
    { pid: process.pid, ppid: 0, name: 'node', cmdline: 'dsh host', createdMs: 1, wsBytes: 0 },
    desktopMain,
    { pid: 26928, ppid: 40376, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=gpu-process', createdMs: 1, wsBytes: 0 },
    { pid: 9480, ppid: 40376, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=renderer', createdMs: 1, wsBytes: 0 },
    { pid: 35004, ppid: 0, name: 'node', cmdline: 'node C:\\billion-context\\dist\\index.js start', createdMs: 1, wsBytes: 0 }
  ]
  const { route, dispose } = bootRoute({ deps: { sample: async () => ({ procs, degraded: null }) } })
  t.after(() => dispose())

  const res = await get(route, '?action=snapshot')
  assert.equal(res.writes[0].status, 200)
  const body = res.writes[1].body

  // 类型从运行中进程自己的事实读取，因此 node.exe 下的测试宿主报告 `web`，
  // 尽管桌面应用会给它启动的每个子进程导出 ELECTRON_RUN_AS_NODE。
  assert.equal(body.hostKind, HOST_KIND_WEB)

  // 集合保留每一行，先按 DSH 相关度、再按 pid 升序排列。应用自己的进程共用
  // 一个映像名，因此三行都被标为它的成员；父链走出集合的那一行不是，集合仍然
  // 保留全部四行。
  assert.deepEqual(body.unknown.map((row) => row.pid), [9480, 26928, 40376, 35004])
  assert.deepEqual(body.unknown.map((row) => row.desktopApp), [true, true, true, false])
  assert.equal('signals' in body.unknown[0], false, 'the signal ids stay in the host')
  assert.equal(body.unknown[2].ppid, 13784, 'the main row keeps its parent, which is how the client walks the chain')
  assert.equal(body.unknown[0].ppid, 40376, 'a child row keeps its parent as well')
})

test('a browser authorizer states its verdict once per case', async () => {
  // requestRejection 抛错说明这个 Connection 无法作答，不属于允许：回答 503，
  // 路由处理函数完全不会进入。
  const thrown = bootRoute({ connection: { requestRejection: () => { throw new Error('disposed') } } })
  const thrownRes = await get(thrown.route, '?action=jobs')
  assert.equal(thrownRes.writes[0].status, 503)
  assert.deepEqual(thrownRes.writes[1].body, { ok: false, code: 'connection_unavailable', error: 'browser authentication unavailable' })
  assert.equal(thrownRes.writes.length, 2, 'a refusal must not fall through to the handler')
  thrown.dispose()

  // 401 之外的拒绝码都读作 forbidden。
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

  // 守卫本来会放行这个请求：回环对端加回环 Host。拿到 503 正好证明守卫从未被
  // 询问。
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

// `action` 是本插件写进宿主日志的唯一一个由请求提供的值，因此也是唯一能伪造一行
// 并非本插件所写日志的值。
test('a request-supplied action cannot forge a second host log line', async (t) => {
  const logged = []
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))
  const { route, dispose } = bootRoute()

  // 响应头已经写出：这次请求应得的回复写不出去，因此走失败路径，并且日志里带着
  // 调用方的原文。
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

    // 同样有长度上限：这里的 action 名称最长九个字符，传入四百个字符的调用方
    // 不值得换来四百字节日志。
    await send(`?action=${'a'.repeat(400)}`)
    assert.equal(logged.length, 2, 'the second failure is its own row')
    assert.ok(!/a{100}/.test(logged[1]), 'the echoed action is cut, not copied')
    assert.match(logged[1], /a{20}/, 'and what is left still identifies the request')
  } finally {
    dispose()
  }
})
