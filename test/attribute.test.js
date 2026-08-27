import test from 'node:test'
import assert from 'node:assert/strict'
import { attribute, subtreeOf, buildIndexes } from '../lib/attribute.js'

const procs = [
  { pid: 100, ppid: 90, name: 'electron', cmdline: 'electron.exe dsh-app', createdMs: 1, wsBytes: 1 },
  { pid: 200, ppid: 100, name: 'node', cmdline: 'node C:\\u\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3080', createdMs: 2, wsBytes: 1 },
  { pid: 300, ppid: 200, name: 'cmd', cmdline: 'cmd /c npx -y @upstash/context7-mcp', createdMs: 3, wsBytes: 1 },
  { pid: 301, ppid: 300, name: 'node', cmdline: 'node npx-cli.js -y @upstash/context7-mcp', createdMs: 3, wsBytes: 1 },
  { pid: 400, ppid: 500, name: 'node', cmdline: 'node E:\\nodejs_cache\\_npx\\x\\node_modules\\some-mcp\\index.js', createdMs: 4, wsBytes: 1 },
  { pid: 500, ppid: 0, name: 'codex', cmdline: 'codex.exe app-server', createdMs: 5, wsBytes: 1 },
  { pid: 600, ppid: 424242, name: 'node', cmdline: 'node server.js', createdMs: 6, wsBytes: 1 }
]

test('buildIndexes wires parents and children', () => {
  const { byPid, children } = buildIndexes(procs)
  assert.equal(byPid.size, procs.length)
  assert.deepEqual(children.get(200), [300])
  assert.deepEqual(children.get(300), [301])
})

test('attribute labels the harness subtree and leaves strangers out', () => {
  const { attributed, unknown } = attribute(procs, new Map([[100, 'harness']]))
  assert.equal(attributed.get(100).rootLabel, 'harness')
  assert.equal(attributed.get(200).depth, 1)
  assert.equal(attributed.get(301).depth, 3)
  assert.ok(!attributed.has(500), 'unrelated root must not be claimed')
  assert.ok(!attributed.has(600), 'dead-parent orphan stays unattributed')
  const unknownPids = unknown.map((p) => p.pid).sort((a, b) => a - b)
  assert.deepEqual(unknownPids, [400, 500, 600])
})

test('nearest root wins for nested roots', () => {
  const { attributed } = attribute(procs, new Map([[100, 'harness'], [500, 'codex']]))
  assert.equal(attributed.get(400).rootLabel, 'codex')
  assert.equal(attributed.get(301).rootLabel, 'harness')
})

test('pluginHint reads package names out of node_modules paths', () => {
  const { attributed } = attribute(procs, new Map([[500, 'codex']]), {
    pluginHint: (cmdline) => {
      const m = /[\\/]node_modules[\\/]+(@[^\\/]+[\\/][^\\/]+|[^\\/]*)[\\/]/.exec(cmdline || '')
      return m ? { plugin: m[1].replace(/\\/g, '/'), viaNpx: /[\\/]_npx[\\/]/.test(cmdline) } : null
    }
  })
  assert.equal(attributed.get(400).pluginHint.plugin, 'some-mcp')
  assert.equal(attributed.get(400).pluginHint.viaNpx, true)
})

test('subtreeOf walks the whole tree, cycle-safe', () => {
  const rows = subtreeOf(procs, 100).map((p) => p.pid)
  assert.deepEqual(rows, [100, 200, 300, 301])
  // A cycle must not hang: point 301 back at 100. buildIndexes keeps the
  // last row per pid, so 301 now hangs off BOTH 300 and 100; the visited set
  // must collapse that into one visit of each node in the tree.
  const cyclic = procs.concat([{ pid: 301, ppid: 100, name: 'node', cmdline: 'x', createdMs: 9, wsBytes: 0 }])
  assert.deepEqual(subtreeOf(cyclic, 100).map((p) => p.pid).sort((a, b) => a - b), [100, 200, 300, 301])
})
