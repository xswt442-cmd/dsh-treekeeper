import test from 'node:test'
import assert from 'node:assert/strict'
import { attribute } from '../lib/attribute.js'
import { findAncestorPids, processRows } from '../lib/roots.js'

const procs = [
  { pid: 10, ppid: 1, name: 'electron', cmdline: 'electron', createdMs: 1, wsBytes: 0 },
  { pid: 20, ppid: 10, name: 'node', cmdline: 'dsh web', createdMs: 2, wsBytes: 0 },
  { pid: 30, ppid: 20, name: 'node', cmdline: 'dsh child', createdMs: 3, wsBytes: 0 },
  { pid: 40, ppid: 10, name: 'node', cmdline: 'unrelated sibling', createdMs: 4, wsBytes: 0 }
]

test('ancestor chain protects launchers without making them attribution roots', () => {
  assert.deepEqual([...findAncestorPids(procs, 20)], [10, 1])

  const attribution = attribute(procs, new Map([[20, 'harness']]))
  assert.equal(attribution.attributed.get(30).rootLabel, 'harness')
  assert.ok(!attribution.attributed.has(40), 'launcher sibling must remain unattributed')
})

test('process rows carry an explicit evidence level', () => {
  const attribution = attribute(procs, new Map([[20, 'harness']]))
  const rows = processRows(procs, attribution)

  assert.equal(rows.find((row) => row.pid === 30).evidence, 'exact')
  assert.equal(rows.find((row) => row.pid === 40).evidence, 'unattributed')
})
