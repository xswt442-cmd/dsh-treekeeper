// The dock's fourth fragment, `dsh-host-http`, in this repository's shape.
//
// Why this is asserted here and not only by `http:check`: a check compares only
// the markers its pinned dock version knows, so this file is what notices a
// missing, duplicated or out-of-order block. It also holds the reply contract the
// block carries: the `no-store` posture on every way out of it, the POST gate
// with this plugin's published `method` code, the bounded session id, and the
// browser authorizer whose decision order is the security property.

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

  // The order is load-bearing: the guard reads the predicates the loopback block
  // declares, and the HTTP glue lands below both where this file's own glue used
  // to be. A block moved above the guard would still parse and still sync.
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

  // An absent method is GET, which is not a mutation.
  const noMethod = response()
  assert.equal(requirePost({}, noMethod, 'config'), false)
  assert.deepEqual(noMethod.body, { ok: false, code: 'method', error: 'action "config" requires POST' })

  // Only one reason is overridable, and a typo is an error rather than a silent
  // no-op that would publish a code no test expects.
  assert.deepEqual(REQUIRE_POST_REASONS, ['method_not_allowed'])
  assert.throws(() => createRequirePost({ policy: { methd_not_allowed: {} } }), /unknown policy key/)
  const custom = response()
  createRequirePost({ policy: { method_not_allowed: { code: 'need_post', error: '{action} 需要 POST', includeAction: true } } })({ method: 'GET' }, custom, 'kill')
  assert.deepEqual(custom.body, { ok: false, code: 'need_post', error: 'kill 需要 POST', action: 'kill' })
})

test('no way out of the block drops the no-store posture', () => {
  // The posture is a property of the reply, not of a call site that remembered
  // to add a header, so it is asserted on every way the block itself answers:
  // the default sink of `connectionUnavailable`, the POST gate's 405, and each
  // authorization refusal.
  const sendJsonRes = response()
  assert.equal(connectionUnavailable(sendJsonRes), false, 'one call hands back the refusal')
  // Called with no sink at all, which is how a route uses it: the posture can
  // only arrive here if the default really is this block's `sendJson`.
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
  // A route that composes its own reply injects the sink; the argument order is
  // (res, respond), the same shape the guard block's binders use.
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

  // 1. No Connection and none ever seen: a pre-RC1 host, so this plugin's own
  //    guard is the whole boundary.
  authorize.connection = null
  authorize.seen = false
  assert.equal(authorize({}, response()), true)
  assert.deepEqual(calls, ['guard'])

  // 2. A Connection that throws cannot permit: 503, the guard is not consulted,
  //    and the handler is not entered.
  authorize.connection = { requestRejection: () => { throw new Error('disposed') } }
  const thrown = response()
  assert.equal(authorize({}, thrown), false)
  assert.equal(thrown.status, 503)
  assert.deepEqual(thrown.body, CONNECTION_UNAVAILABLE)
  assert.deepEqual(calls, ['guard'], 'a throwing Connection must not fall back to the guard')

  // 3. A rejection code is final: 401 is the browser's to clear, anything else
  //     is this plugin's refusal.
  for (const [code, expected] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    authorize.connection = { requestRejection: () => code }
    const res = response()
    assert.equal(authorize({}, res), false)
    assert.equal(res.status, code)
    assert.equal(res.body.code, expected)
  }

  // 4. A reload gap after a Connection existed: 503, and deliberately NOT the
  //    weaker loopback fence — a local socket peer is not an authorized browser.
  authorize.connection = null
  authorize.seen = true
  const gap = response()
  assert.equal(authorize({}, gap), false)
  assert.equal(gap.status, 503)
  assert.deepEqual(gap.body, CONNECTION_UNAVAILABLE)
  assert.deepEqual(calls, ['guard'], 'the guard must not run once a Connection has existed')
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
  assert.equal(reads, 2, 'a captured Connection would keep authorizing a disposed one')

  // A value instead of an accessor is the mistake the signature exists to catch.
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

// Untrusted numeric input: a coerced pid or interval is a value the caller never
// sent, and here those two pick what dies and how often the machine is sampled.
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
