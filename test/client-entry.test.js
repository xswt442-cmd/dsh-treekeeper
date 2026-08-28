import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('client factory returns a mountable Cordis plugin without early DOM effects', () => {
  let definition = null
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const context = {
    window: {
      __ModuleLoader__: {
        load(value) { definition = value }
      }
    }
  }

  vm.runInNewContext(source, context, { filename: 'lib/client.js' })
  assert.equal(definition.id, 'dsh-treekeeper')

  const plugin = definition.factory((name) => {
    assert.equal(name, 'react')
    return { createElement() {} }
  })

  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.apply, 'function')
})
