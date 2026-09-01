// DTK-M1: the dock measures the DSH shell through the DOM because slots give
// no geometry. When that chain is missing the dock must degrade loudly once
// (misplaced, not broken) instead of silently.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const DOCK_KEY = '__CREATEHELPER_DSH_UTILITY_DOCK_V1__'
const FALLBACK_LEFT = '80px'

/**
 * Boot the client bundle in a reduced DOM.
 * @param {null|{sidebarRight: number|null}} shell
 *   null                     → no [data-shell-overlay] at all
 *   { sidebarRight: null }   → overlay + frame present, sidebar missing
 *   { sidebarRight: 240 }    → full chain, sidebar right edge at 240
 */
function boot(shell) {
  const warnings = []
  const cssVars = new Map()
  let dockRoot = null
  let definition = null

  const makeElement = () => ({
    style: {},
    dataset: {},
    children: [],
    hidden: false,
    innerHTML: '',
    title: '',
    type: '',
    className: '',
    setAttribute() {},
    addEventListener() {},
    appendChild(value) { this.children.push(value) },
    replaceChildren() { this.children = [] },
    remove() {},
    getBoundingClientRect() { return { left: 0, right: this.rectRight ?? 0 } }
  })

  let overlay = null
  if (shell) {
    const frame = makeElement()
    if (shell.sidebarRight !== null) {
      const sidebar = makeElement()
      sidebar.rectRight = shell.sidebarRight
      frame.firstElementChild = sidebar
    }
    overlay = makeElement()
    overlay.parentElement = frame
  }

  const context = {
    console: { warn: (message) => warnings.push(message) },
    document: {
      body: { appendChild(value) { dockRoot = value } },
      documentElement: {
        dataset: {},
        style: { setProperty(name, value) { cssVars.set(name, value) } }
      },
      head: { appendChild() {} },
      createElement: makeElement,
      querySelector(selector) {
        return selector === '[data-shell-overlay]' ? overlay : null
      },
      querySelectorAll() { return [] }
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: { load(value) { definition = value } }
    }
  }

  vm.runInNewContext(SOURCE, context, { filename: 'lib/client.js' })
  const plugin = definition.factory(() => ({ createElement: () => null }))
  const slots = {
    inject(name, mount) { mount() },
    register(options, render) { this.registered = { options, render } }
  }
  plugin.apply({
    get() {},
    inject(services, mount) { mount({ slots }) },
    on() {}
  })

  return {
    warnings,
    cssVars,
    dockRoot,
    dock: context.window[DOCK_KEY],
    registered: slots.registered
  }
}

test('a missing shell overlay falls back to the named offset and warns once', () => {
  const { warnings, cssVars, dockRoot, dock } = boot(null)

  assert.equal(dockRoot.style.left, FALLBACK_LEFT)
  assert.equal(cssVars.get('--createhelper-utility-dock-left'), FALLBACK_LEFT)
  assert.equal(warnings.length, 1, 'one warning, not one per render')
  assert.match(warnings[0], /shell geometry unavailable/)
  assert.match(warnings[0], /left=80px/)

  // Re-renders and re-placements must stay quiet: the dock keeps working.
  dock.setPlacement('main-bottom-right')
  dock.setPlacement('main-bottom-left')
  dock.setPlacement('main-bottom-left')
  assert.equal(warnings.length, 1)
  assert.equal(dockRoot.style.left, FALLBACK_LEFT)
})

test('a frame without a sidebar is a missing link, not a measurement', () => {
  const { warnings, dockRoot } = boot({ sidebarRight: null })

  assert.equal(dockRoot.style.left, FALLBACK_LEFT)
  assert.equal(warnings.length, 1)
})

test('a measurable shell places the dock past the sidebar and stays quiet', () => {
  const { warnings, cssVars, dockRoot } = boot({ sidebarRight: 240 })

  assert.equal(dockRoot.style.left, '256px')
  assert.equal(cssVars.get('--createhelper-utility-dock-left'), '256px')
  assert.equal(warnings.length, 0)
})
