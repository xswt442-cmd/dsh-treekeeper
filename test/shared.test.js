import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuard, hasVerifiedCreationTime, parseCimDate } from '../lib/shared.js'

function response() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) }
  }
}

test('CIM dates and identity tolerance are parsed consistently', () => {
  const createdMs = parseCimDate('20260825162958.5+480')

  assert.equal(createdMs, Date.UTC(2026, 7, 25, 8, 29, 58, 500))
  assert.ok(hasVerifiedCreationTime(createdMs, createdMs + 750))
  assert.ok(!hasVerifiedCreationTime(createdMs, createdMs + 751))
  assert.ok(!hasVerifiedCreationTime(createdMs, null))
})

test('API guard accepts loopback and rejects browser cross-site requests', () => {
  const guard = createGuard()
  const allowedResponse = response()
  const rejectedResponse = response()

  assert.equal(guard({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } }, allowedResponse), true)
  assert.equal(guard({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }, rejectedResponse), false)
  assert.equal(rejectedResponse.status, 403)
  assert.equal(rejectedResponse.body.code, 'cross_site')
})
