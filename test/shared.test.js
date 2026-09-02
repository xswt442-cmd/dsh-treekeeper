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

// DTK-M2 guard regression: the session entry never touches the API directly,
// but it raised the request surface of the client, so the origin/host/site
// checks must stay airtight across every axis they already enforce.
test('API guard rejects a foreign Origin and a rebound non-loopback Host', () => {
  const guard = createGuard()

  for (const origin of ['https://evil.example', 'https://127.0.0.1.evil.example', 'http://localhost.evil.example']) {
    const rejectedResponse = response()
    assert.equal(guard({ headers: { host: '127.0.0.1:3080', origin } }, rejectedResponse), false)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'foreign_origin')
  }

  for (const host of ['rebound.example', '127.0.0.1.evil.example']) {
    const rejectedResponse = response()
    assert.equal(guard({ headers: { host, 'sec-fetch-site': 'same-origin' } }, rejectedResponse), false)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'non_loopback')
  }

  // Only exact loopback spellings pass; arbitrary localhost subdomains are
  // rejected to keep DNS rebinding out of the API surface.
  for (const host of ['localhost:3080', '127.0.0.1:3080']) {
    const allowedResponse = response()
    assert.equal(guard({ headers: { host, origin: 'http://localhost:3080' } }, allowedResponse), true)
  }
  const subdomainResponse = response()
  assert.equal(guard({ headers: { host: 'api.localhost' } }, subdomainResponse), false)
  assert.equal(subdomainResponse.body.code, 'non_loopback')
  const mappedIpv6Response = response()
  assert.equal(guard({ headers: { host: '[::ffff:127.0.0.1]:3080' } }, mappedIpv6Response), false)
  assert.equal(mappedIpv6Response.body.code, 'non_loopback')
})

test('API guard uses strict loopback names, matching Origin ports, and bracketed IPv6', () => {
  const guard = createGuard({ currentPort: () => 3080 })
  for (const host of ['evil.localhost:3080', '[::1]:3080']) {
    const res = response()
    assert.equal(guard({ headers: { host } }, res), host.startsWith('evil') ? false : true)
  }
  for (const origin of ['http://evil.localhost:3080', 'http://localhost:3081']) {
    const res = response()
    assert.equal(guard({ headers: { host: '127.0.0.1:3080', origin } }, res), false)
    assert.equal(res.status, 403)
  }
  for (const origin of ['http://[::1]:3080', 'http://127.0.0.1:3080']) {
    const res = response()
    assert.equal(guard({ headers: { host: '[::1]:3080', origin } }, res), true)
  }
})
