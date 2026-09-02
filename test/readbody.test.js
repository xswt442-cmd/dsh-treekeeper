import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readBody } from '../lib/index.js'

test('readBody settles immediately on overflow and drains later chunks without destroy', async () => {
  const req = new EventEmitter()
  let destroyed = false
  req.destroy = () => {
    destroyed = true
    req.emit('close')
  }
  const pending = readBody(req)
  req.emit('data', 'x'.repeat(65537))
  let settled = false
  pending.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, true)
  req.emit('data', 'later data must be ignored')
  assert.deepEqual(await pending, { tooLarge: true })
  assert.equal(destroyed, false)
})

test('readBody resolves safely when the request closes or errors', async () => {
  for (const event of ['close', 'error']) {
    const req = new EventEmitter()
    const pending = readBody(req)
    req.emit(event, event === 'error' ? new Error('aborted') : undefined)
    assert.deepEqual(await pending, {})
  }
})

test('readBody still parses a normal JSON body', async () => {
  const req = new EventEmitter()
  const pending = readBody(req)
  req.emit('data', '{"pollMs":2000}')
  req.emit('end')
  assert.deepEqual(await pending, { pollMs: 2000 })
})
