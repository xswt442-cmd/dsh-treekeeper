// 本仓库内嵌的宿主 HTTP 片段 `dsh-host-http`。
//
// 除了 `http:check` 之外仍要在这里断言：检查只比较它固定的 dock 版本认识的标记，
// 因此缺块、重复块与顺序错误由本文件发现。它同时覆盖片段携带的响应约定：每条
// 出口都带 `no-store`，POST 门使用本插件公布的 `method` 错误码，会话 id 有长度
// 上限，以及浏览器授权器的判定顺序（那是安全属性）。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  sendJson, requirePost, optionalSessionId, createRequirePost, createBrowserAuthorizer,
  connectionUnavailable, CONNECTION_UNAVAILABLE, REQUIRE_POST_REASONS, normalizePidInput,
  normalizeCreatedMsInput, normalizePollIntervalMs, POLL_INTERVAL_MIN_MS, POLL_INTERVAL_MAX_MS
} from '../lib/shared.js'

const SHARED = fs.readFileSync(new URL('../lib/shared.js', import.meta.url), 'utf8')

function response() {
  const writes = []
  return {
    writes,
    get status() { return writes[0].status },
    get body() { return writes[1].body },
    writeHead(status, headers) { writes.push({ status, headers }) },
    end(body) { writes.push({ status: null, body: JSON.parse(body) }) }
  }
}

const marker = (name, edge) => `// <${edge}${name}>`

test('lib/shared.js carries exactly one host-HTTP block, below the guard', () => {
  for (const name of ['dsh-loopback-helpers', 'dsh-host-guard', 'dsh-host-http']) {
    const open = SHARED.split('\n').filter((line) => line.trim() === marker(name, '')).length
    const close = SHARED.split('\n').filter((line) => line.trim() === marker(name, '/')).length
    assert.equal(open, 1, `${name} opening marker count`)
    assert.equal(close, 1, `${name} closing marker count`)
  }

  // 顺序有实际作用：守卫读取 loopback 块声明的判断函数，HTTP 胶水位于两者下方。
  // 把某个块移到守卫上方仍然能解析，也仍然能通过同步检查。
  assert.ok(
    SHARED.indexOf(marker('dsh-loopback-helpers', '')) < SHARED.indexOf(marker('dsh-host-guard', '')),
    'the guard block must sit below the predicates it uses'
  )
  assert.ok(
    SHARED.indexOf(marker('dsh-host-guard', '/')) < SHARED.indexOf(marker('dsh-host-http', '')),
    'the host-HTTP block must sit below the guard block'
  )
})

test('every JSON reply carries the no-store posture', () => {
  const res = response()
  sendJson(res, 200, { ok: true, port: 3080 })
  assert.equal(res.status, 200)
  assert.deepEqual(res.writes[0].headers, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  assert.deepEqual(res.body, { ok: true, port: 3080 })
})

test("the POST gate keeps this plugin's published vocabulary", () => {
  const res = response()
  assert.equal(requirePost({ method: 'post' }, res, 'kill'), true, 'the method is read case-insensitively')

  const rejected = response()
  assert.equal(requirePost({ method: 'GET' }, rejected, 'kill'), false)
  assert.equal(rejected.status, 405)
  assert.deepEqual(rejected.body, { ok: false, code: 'method', error: 'action "kill" requires POST' })

  // 没有 method 读作 GET，不属于会改变状态的请求。
  const noMethod = response()
  assert.equal(requirePost({}, noMethod, 'config'), false)
  assert.deepEqual(noMethod.body, { ok: false, code: 'method', error: 'action "config" requires POST' })

  // 只有一个原因可以覆盖，键名写错会抛错，而不是静默无效、公布一个没有测试
  // 期待的错误码。
  assert.deepEqual(REQUIRE_POST_REASONS, ['method_not_allowed'])
  assert.throws(() => createRequirePost({ policy: { methd_not_allowed: {} } }), /unknown policy key/)
  const custom = response()
  createRequirePost({ policy: { method_not_allowed: { code: 'need_post', error: '{action} 需要 POST', includeAction: true } } })({ method: 'GET' }, custom, 'kill')
  assert.deepEqual(custom.body, { ok: false, code: 'need_post', error: 'kill 需要 POST', action: 'kill' })
})

test('no way out of the block drops the no-store posture', () => {
  // 这是响应本身的属性，不取决于某个调用点是否记得加响应头，因此对片段自己
  // 作答的每条出口都断言：`connectionUnavailable` 的默认接收函数、POST 门的 405，
  // 以及每种授权拒绝。
  const sendJsonRes = response()
  assert.equal(connectionUnavailable(sendJsonRes), false, 'one call hands back the refusal')
  // 完全不传接收函数，路由就是这样使用它的：只有默认值确实是本片段的
  // `sendJson`，响应头才可能出现在这里。
  assert.equal(sendJsonRes.writes[0].headers['cache-control'], 'no-store')
  assert.deepEqual(sendJsonRes.writes[1].body, CONNECTION_UNAVAILABLE)

  const gated = response()
  requirePost({ method: 'GET' }, gated, 'kill')
  assert.equal(gated.writes[0].headers['cache-control'], 'no-store')

  const authorizer = (connection, seen) => createBrowserAuthorizer({
    getConnection: () => connection,
    getConnectionSeen: () => seen,
    guard: () => true
  })
  const refusals = [
    ['a throwing Connection', authorizer({ requestRejection: () => { throw new Error('disposed') } }, false)],
    ['a 401 rejection', authorizer({ requestRejection: () => 401 }, false)],
    ['a reload gap', authorizer(null, true)]
  ]
  for (const [label, authorize] of refusals) {
    const res = response()
    assert.equal(authorize({}, res), false, label)
    assert.equal(res.writes[0].headers['cache-control'], 'no-store', `${label} keeps the posture`)
  }
})

test('connectionUnavailable states the one 503 payload', () => {
  assert.deepEqual(CONNECTION_UNAVAILABLE, { ok: false, code: 'connection_unavailable', error: 'browser authentication unavailable' })
  assert.throws(() => { CONNECTION_UNAVAILABLE.code = 'x' }, TypeError, 'the shared payload is frozen')
  // 自己组装回复的路由注入接收函数；参数顺序是 (res, respond)，与守卫块的绑定器
  // 一致。
  const res = response()
  const written = []
  assert.equal(connectionUnavailable(res, (r, status, body) => { written.push({ status, body }); r.writeHead(status, {}); r.end(JSON.stringify(body)) }), false)
  assert.deepEqual(written, [{ status: 503, body: CONNECTION_UNAVAILABLE }])
  assert.equal(res.status, 503)
  assert.deepEqual(res.body, CONNECTION_UNAVAILABLE)
})

test('the browser authorizer decision order is the security property', () => {
  const calls = []
  const guard = (req, res) => { calls.push('guard'); return true }
  const authorize = createBrowserAuthorizer({
    getConnection: () => authorize.connection,
    getConnectionSeen: () => authorize.seen,
    guard
  })

  // 1. 没有 Connection，也从未有过：说明是 RC1 之前的宿主，本插件自己的守卫就是
  //    整个边界。
  authorize.connection = null
  authorize.seen = false
  assert.equal(authorize({}, response()), true)
  assert.deepEqual(calls, ['guard'])

  // 2. 抛错的 Connection 不能放行：回答 503，不询问守卫，也不进入处理函数。
  authorize.connection = { requestRejection: () => { throw new Error('disposed') } }
  const thrown = response()
  assert.equal(authorize({}, thrown), false)
  assert.equal(thrown.status, 503)
  assert.deepEqual(thrown.body, CONNECTION_UNAVAILABLE)
  assert.deepEqual(calls, ['guard'], 'a throwing Connection must not fall back to the guard')

  // 3. 拒绝码就是最终结果：401 由浏览器处理，其他码都是本插件的拒绝。
  for (const [code, expected] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    authorize.connection = { requestRejection: () => code }
    const res = response()
    assert.equal(authorize({}, res), false)
    assert.equal(res.status, code)
    assert.equal(res.body.code, expected)
  }

  // 4. Connection 存在过之后的重载间隙：回答 503，绝不退回较弱的回环围栏——本地
  //    套接字对端与已授权的浏览器不是一回事。
  authorize.connection = null
  authorize.seen = true
  const gap = response()
  assert.equal(authorize({}, gap), false)
  assert.equal(gap.status, 503)
  assert.deepEqual(gap.body, CONNECTION_UNAVAILABLE)
  assert.deepEqual(calls, ['guard'], 'Connection 存在过之后守卫不能再运行')
})

test('the authorizer reads its accessors per request and demands them as functions', () => {
  let reads = 0
  const authorize = createBrowserAuthorizer({
    getConnection: () => { reads += 1; return null },
    getConnectionSeen: () => false,
    guard: () => true
  })
  authorize({}, response())
  authorize({}, response())
  assert.equal(reads, 2, '捕获的 Connection 会一直为已销毁的实例授权')

  // 传值而不是访问器，正是这个签名要拦下的错误。
  assert.throws(() => createBrowserAuthorizer({ getConnection: null, getConnectionSeen: () => false, guard: () => true }), /must be an accessor/)
  assert.throws(() => createBrowserAuthorizer({ getConnection: () => null, getConnectionSeen: true, guard: () => true }), /must be an accessor/)
  assert.throws(() => createBrowserAuthorizer({ getConnection: () => null, getConnectionSeen: () => false }), /guard is required/)
})

test('optionalSessionId bounds what reaches a session lookup', () => {
  assert.equal(optionalSessionId('root-1'), 'root-1')
  assert.equal(optionalSessionId('  root-1  '), 'root-1')
  assert.equal(optionalSessionId(''), null)
  assert.equal(optionalSessionId('   '), null)
  assert.equal(optionalSessionId(null), null)
  assert.equal(optionalSessionId(undefined), null)
  assert.equal(optionalSessionId(42), null)
  assert.equal(optionalSessionId('x'.repeat(512)), 'x'.repeat(512))
  assert.equal(optionalSessionId('x'.repeat(513)), null)
})

// 不可信的数值输入：被强转出来的 pid 或间隔是调用方从未发送的值，而这两个值在这里
// 决定结束哪个进程、以及整台机器多久被采样一次。
test('numeric input is narrowed the way a port is, never coerced', () => {
  assert.equal(normalizePidInput(4234), 4234)
  assert.equal(normalizePidInput('4234'), 4234)
  assert.equal(normalizePidInput(' 4234 '), 4234)
  for (const bad of [undefined, null, '', 'abc', '1e9', '0x10', '8.5', 8.5, -1, 0, NaN, Infinity, {}, [], true]) {
    assert.equal(normalizePidInput(bad), null, JSON.stringify(bad))
  }

  assert.equal(normalizeCreatedMsInput(1780000000000), 1780000000000)
  assert.equal(normalizeCreatedMsInput('1780000000000'), 1780000000000)
  for (const bad of [0, -5, 'soon', 1.5, null, undefined]) {
    assert.equal(normalizeCreatedMsInput(bad), null, String(bad))
  }

  assert.equal(normalizePollIntervalMs(0), 0, 'off stays a legal value')
  assert.equal(normalizePollIntervalMs('0'), 0)
  assert.equal(normalizePollIntervalMs(POLL_INTERVAL_MIN_MS), POLL_INTERVAL_MIN_MS)
  assert.equal(normalizePollIntervalMs(POLL_INTERVAL_MIN_MS + 1), POLL_INTERVAL_MIN_MS + 1, 'inside the range is inside')
  assert.equal(normalizePollIntervalMs(POLL_INTERVAL_MAX_MS), POLL_INTERVAL_MAX_MS)
  for (const bad of [1, 1999, POLL_INTERVAL_MAX_MS + 1, 1e30, 'soon', null, undefined, {}, -1]) {
    assert.equal(normalizePollIntervalMs(bad), null, String(bad), `${bad} is neither off nor in range`)
  }
})
