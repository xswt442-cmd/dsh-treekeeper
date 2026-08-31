import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('client factory returns a mountable Cordis plugin without early DOM effects', () => {
  let definition = null
  let styleElement = null
  let dockRoot = null
  let domReads = 0
  const registered = []
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const makeElement = () => ({
    style: { setProperty() {} },
    dataset: {},
    children: [],
    setAttribute() {},
    addEventListener() {},
    appendChild(value) { this.children.push(value) },
    replaceChildren() { this.children = [] },
    remove() {}
  })
  const context = {
    document: {
      body: { appendChild(value) { dockRoot = value } },
      documentElement: { dataset: {}, style: { setProperty() {} } },
      head: { appendChild(value) { styleElement = value } },
      createElement: makeElement,
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
      addEventListener() {},
      removeEventListener() {},
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
      assert.equal(name, 'shell.overlay')
      mount()
    },
    register(options, render) {
      registered.push({ options, render })
    }
  }
  plugin.apply({
    get() { assert.fail('client must wait for slots instead of probing it once') },
    inject(services, mount) {
      assert.deepEqual(Array.from(services), ['slots'])
      mount({ slots })
    },
    on() {}
  })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'shell.overlay')
  assert.equal(registered[0].options.id, 'treekeeper-panel')
  assert.equal(registered[0].options.order, 90)
  assert.equal(typeof registered[0].render, 'function')
  const dock = context.window.__CREATEHELPER_DSH_UTILITY_DOCK_V1__
  assert.equal(dock.protocol, 'createhelper.dsh.utility-dock')
  assert.equal(dock.version, 1)
  assert.equal(dockRoot.children[0].title, 'TreeKeeper')
})
