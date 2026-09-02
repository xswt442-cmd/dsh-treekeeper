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
    headers: {}
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
    headers: {}
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
    headers: {}
  }, missingRootRes)
  assert.equal(missingRootRes.writes[0].status, 400)
  assert.equal(missingRootRes.writes[1].body.code, 'root_required')

  disposeCleanup()
  assert.equal(released, true)
})
