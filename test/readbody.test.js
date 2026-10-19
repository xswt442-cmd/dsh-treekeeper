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

// 格式错误的请求体是独立的一种结果，不等于“没有请求体”。readBody 报告它，路由
// 因此回答 400 `bad_json`；被截断的终止请求会读成坏请求体，而不是一个没有携带
// pid 的请求。
test('readBody separates a malformed body from no body', async () => {
  const malformed = [
    '{"pid":',
    '{"pid":1,}',
    'pid=1',
    '{"pid":1}\ntrailing'
  ]
  for (const text of malformed) {
    const req = new EventEmitter()
    const pending = readBody(req)
    req.emit('data', text)
    req.emit('end')
    assert.deepEqual(await pending, { parseError: true }, JSON.stringify(text))
  }

  const empty = new EventEmitter()
  const emptyPending = readBody(empty)
  empty.emit('end')
  assert.deepEqual(await emptyPending, {}, 'no body is not a parse failure')
})

test('readBody rejects JSON that is not an object', async () => {
  for (const text of ['null', '123', '"a string"', '[]', '[{"pid":1}]', 'true']) {
    const req = new EventEmitter()
    const pending = readBody(req)
    req.emit('data', text)
    req.emit('end')
    assert.deepEqual(await pending, { parseError: true }, text)
  }
})

test('readBody reports an overflow body without parsing it', async () => {
  const req = new EventEmitter()
  const pending = readBody(req)
  req.emit('data', '{"pad":"')
  req.emit('data', 'x'.repeat(70000))
  assert.deepEqual(await pending, { tooLarge: true })
  req.emit('end')
  assert.deepEqual(await pending, { tooLarge: true }, 'a settled reader never changes its verdict')
})
