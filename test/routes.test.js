import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function responseCapture() {
  const writes = []
  return {
    writes,
    writeHead(status, headers) { writes.push({ status, headers }) },
    end(body) { writes.push({ body: JSON.parse(body) }) }
  }
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
