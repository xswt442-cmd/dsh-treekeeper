import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('client factory returns a mountable Cordis plugin without early DOM effects', () => {
  let definition = null
  let styleElement = null
  let domReads = 0
  let registered = null
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const context = {
    document: {
      head: { appendChild(value) { styleElement = value } },
      createElement() {
        return { setAttribute() {}, remove() {} }
      },
      querySelector(selector) {
        domReads += 1
        return selector.startsWith('style[') ? styleElement : null
      },
      querySelectorAll() {
        domReads += 1
        return []
      }
    },
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
  assert.equal(domReads, 0)

  const slots = {
    inject(name, mount) {
      assert.equal(name, 'sidebar.footer.action')
      mount()
    },
    register(options, render) {
      registered = { options, render }
    }
  }
  plugin.apply({
    get(name) {
      assert.equal(name, 'slots')
      return slots
    },
    on() {}
  })

  assert.equal(registered.options.name, 'sidebar.footer.action')
  assert.equal(registered.options.id, 'treekeeper')
  assert.equal(registered.options.order, -20)
  assert.equal(typeof registered.render, 'function')
})
