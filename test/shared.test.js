import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuard, hasVerifiedCreationTime, parseCimDate, isLoopbackAddress } from '../lib/shared.js'

function response() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) }
  }
}

// Every request in these tests arrives over loopback unless a test says
// otherwise; the guard now keys off the TCP peer address, not the headers.
const loopback = (headers = {}) => ({ headers, socket: { remoteAddress: '127.0.0.1' } })

test('CIM dates and identity tolerance are parsed consistently', () => {
  const createdMs = parseCimDate('20260825162958.5+480')

  assert.equal(createdMs, Date.UTC(2026, 7, 25, 8, 29, 58, 500))
  assert.ok(hasVerifiedCreationTime(createdMs, createdMs + 750))
  assert.ok(!hasVerifiedCreationTime(createdMs, createdMs + 751))
  assert.ok(!hasVerifiedCreationTime(createdMs, null))
})

test('isLoopbackAddress folds real loopback forms and fails closed', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:127.0.0.2', '127.255.0.1']) {
    assert.ok(isLoopbackAddress(a), a)
  }
  for (const a of ['192.168.1.5', '10.0.0.1', '::2', 'example.com', '', null, undefined, '  ', '::ffff:8.8.8.8']) {
    assert.ok(!isLoopbackAddress(a), String(a))
  }
})

test('API guard accepts loopback and rejects browser cross-site requests', () => {
  const guard = createGuard()
  const allowedResponse = response()
  const rejectedResponse = response()

  assert.equal(guard(loopback({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }), allowedResponse), true)
  assert.equal(guard(loopback({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), rejectedResponse), false)
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
    assert.equal(guard(loopback({ host: '127.0.0.1:3080', origin }), rejectedResponse), false)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'foreign_origin')
  }

  for (const host of ['rebound.example', '127.0.0.1.evil.example']) {
    const rejectedResponse = response()
    assert.equal(guard(loopback({ host, 'sec-fetch-site': 'same-origin' }), rejectedResponse), false)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'non_loopback')
  }

  // Only exact loopback spellings pass; arbitrary localhost subdomains are
  // rejected to keep DNS rebinding out of the API surface.
  for (const host of ['localhost:3080', '127.0.0.1:3080']) {
    const allowedResponse = response()
    assert.equal(guard(loopback({ host, origin: 'http://localhost:3080' }), allowedResponse), true)
  }
  const subdomainResponse = response()
  assert.equal(guard(loopback({ host: 'api.localhost' }), subdomainResponse), false)
  assert.equal(subdomainResponse.body.code, 'non_loopback')
  const mappedIpv6Response = response()
  assert.equal(guard(loopback({ host: '[::ffff:127.0.0.1]:3080' }), mappedIpv6Response), false)
  assert.equal(mappedIpv6Response.body.code, 'non_loopback')
})

test('API guard uses strict loopback names, matching Origin ports, and bracketed IPv6', () => {
  const guard = createGuard({ currentPort: () => 3080 })
  for (const host of ['evil.localhost:3080', '[::1]:3080']) {
    const res = response()
    assert.equal(guard(loopback({ host }), res), host.startsWith('evil') ? false : true)
  }
  for (const origin of ['http://evil.localhost:3080', 'http://localhost:3081']) {
    const res = response()
    assert.equal(guard(loopback({ host: '127.0.0.1:3080', origin }), res), false)
    assert.equal(res.status, 403)
  }
  for (const origin of ['http://[::1]:3080', 'http://127.0.0.1:3080']) {
    const res = response()
    assert.equal(guard(loopback({ host: '[::1]:3080', origin }), res), true)
  }
})

test('API guard rejects a non-loopback TCP peer regardless of spoofed headers', () => {
  const guard = createGuard({ currentPort: () => 3080 })
  // Forged loopback Host + same-origin metadata, but the real peer is remote.
  const spoofed = response()
  assert.equal(
    guard({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '192.168.1.50' } }, spoofed),
    false
  )
  assert.equal(spoofed.status, 403)
  assert.equal(spoofed.body.code, 'non_loopback_peer')
  // HTTP/1.0-style request with no Host header at all, remote peer.
  const noHost = response()
  assert.equal(guard({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }, noHost), false)
  assert.equal(noHost.body.code, 'non_loopback_peer')
})

test('API guard allows loopback TCP peers including IPv6 loopback forms', () => {
  const guard = createGuard({ currentPort: () => 3080 })
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const res = response()
    assert.equal(
      guard({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: addr } }, res),
      true
    )
  }
})

test('API guard fails closed when the peer address is missing or empty', () => {
  const guard = createGuard({ currentPort: () => 3080 })
  const cases = [
    { headers: { host: '127.0.0.1:3080' } }, // no socket at all
    { headers: { host: '127.0.0.1:3080' }, socket: {} }, // socket but no remoteAddress
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '' } },
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '   ' } },
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: null } }
  ]
  for (const req of cases) {
    const res = response()
    assert.equal(guard(req, res), false)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'non_loopback_peer')
  }
})

test('API guard accepts a same-origin Origin on the default HTTP port (80)', () => {
  const guard = createGuard({ currentPort: () => 80 })
  // http://127.0.0.1 has no explicit port; WHATWG URL normalizes .port to '',
  // so the comparison must fall back to the protocol's default port.
  const res = response()
  assert.equal(
    guard(loopback({ host: '127.0.0.1', origin: 'http://127.0.0.1' }), res),
    true
  )
  // A mismatched explicit port is still rejected.
  const mismatch = response()
  assert.equal(
    guard(loopback({ host: '127.0.0.1', origin: 'http://127.0.0.1:8080' }), mismatch),
    false
  )
  assert.equal(mismatch.body.code, 'foreign_origin')
})
