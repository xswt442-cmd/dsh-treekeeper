import test from 'node:test'
import assert from 'node:assert/strict'
import hostPlugin, { apply, inject } from '../lib/index.js'

test('host entry exposes a callable Cordis plugin contract through default and named exports', async () => {
  const moduleNamespace = await import(new URL('../lib/index.js', import.meta.url).href)

  assert.equal(hostPlugin, apply)
  assert.deepEqual(hostPlugin.inject, ['webServer'])
  assert.deepEqual(inject, ['webServer'])
  assert.equal(moduleNamespace.apply, apply)
  assert.deepEqual(moduleNamespace.inject, ['webServer'])
})
