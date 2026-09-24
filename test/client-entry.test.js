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
  const injected = []
  let localeNamespace = null
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
      injected.push(name)
      mount()
    },
    register(options, render) {
      registered.push({ options, render })
    }
  }
  plugin.apply({
    get() { assert.fail('client must wait for slots instead of probing it once') },
    inject(services, mount) {
      if (Array.from(services)[0] === 'locale') {
        mount({
          locale: {
            register(namespace, dictionaries) {
              localeNamespace = namespace
              assert.equal(dictionaries.en.refresh, 'Refresh')
              return () => {}
            },
            bind: () => (key) => key,
            subscribe: () => () => {}
          },
          on() {}
        })
        return
      }
      assert.deepEqual(Array.from(services), ['slots'])
      mount({ slots })
    },
    on() {}
  })

  // Six registrations: this plugin's row in the family menu, the family launcher
  // it claims when it loads first (reached through inject, because that seat
  // belongs to the shell), the overlay panel, the session-scope header action,
  // and the two DTK-M3 ambient Session-row seats.
  assert.deepEqual(injected, ['createhelper.utility.item', 'shell.overlay', 'shell.overlay', 'conversation.session.header.actions', 'sidebar.session.row.leading', 'sidebar.session.row.hover'])
  assert.equal(registered.length, 6)
  assert.equal(registered[0].options.name, 'createhelper.utility.item')
  assert.equal(registered[0].options.id, 'treekeeper')
  assert.equal(registered[0].options.order, 20)
  assert.equal(typeof registered[0].render, 'function')
  assert.equal(registered[1].options.name, 'shell.overlay')
  assert.equal(registered[1].options.id, 'utility-launcher')
  assert.equal(typeof registered[1].render, 'function')
  assert.equal(registered[2].options.name, 'shell.overlay')
  assert.equal(registered[2].options.id, 'treekeeper-panel')
  assert.equal(registered[2].options.order, 90)
  assert.equal(typeof registered[2].render, 'function')
  assert.equal(registered[3].options.name, 'conversation.session.header.actions')
  assert.equal(registered[3].options.id, 'treekeeper-open')
  assert.equal(typeof registered[3].render, 'function')
  assert.equal(registered[4].options.name, 'sidebar.session.row.leading')
  assert.equal(registered[4].options.id, 'treekeeper')
  assert.equal(registered[4].options.order, 20)
  assert.equal(typeof registered[4].render, 'function')
  assert.equal(registered[5].options.name, 'sidebar.session.row.hover')
  assert.equal(registered[5].options.id, 'treekeeper')
  assert.equal(registered[5].options.order, 20)
  assert.equal(typeof registered[5].render, 'function')
  assert.equal(localeNamespace, 'dsh-treekeeper')
  // The retired page-local dock is what floated its own container over the
  // composer; the host's overlay layer holds the launcher now, so nothing may
  // append a container to body again.
  assert.equal(context.window.__CREATEHELPER_DSH_UTILITY_DOCK_V1__, undefined)
  assert.doesNotMatch(source, /getUtilityDock|CREATEHELPER_DSH_UTILITY_DOCK/)
  assert.equal(dockRoot, null, 'the client must not append a floating container to body')
})
