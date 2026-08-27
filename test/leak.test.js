import test from 'node:test'
import assert from 'node:assert/strict'
import { findDuplicates, findOrphans, findLongLived, collectFindings, PROTECTED_NAMES } from '../lib/leak.js'
import { attribute } from '../lib/attribute.js'

function proc(pid, ppid, cmdline, createdMs = Date.now() - 60 * 60 * 1000, name = 'node', ws = 0) {
  return { pid, ppid, name, cmdline, createdMs, wsBytes: ws }
}

test('duplicate detection groups normalized command lines', () => {
  const procs = [
    proc(1, 10, 'cmd /c npx -y @upstash/context7-mcp'),
    proc(2, 10, 'cmd  /c  npx -y @upstash/context7-mcp'),
    proc(3, 10, 'cmd /c npx -y @upstash/context7-mcp '),
    proc(4, 10, 'node server.js')
  ]
  const found = findDuplicates(procs, { minCopies: 3 })
  assert.equal(found.length, 1)
  assert.equal(found[0].pids.length, 3)
  assert.equal(found[0].type, 'duplicate')
})

test('orphan detection finds survivors of dead parents', () => {
  const procs = [proc(7, 999, 'node mcp.js'), proc(8, 7, 'node kid.js')]
  const found = findOrphans(procs)
  assert.equal(found.length, 1)
  assert.equal(found[0].pids[0], 7)
})

test('long-lived only flags plugin children past the threshold', () => {
  const old = Date.now() - 45 * 60 * 1000
  const fresh = Date.now() - 60 * 1000
  const procs = [
    proc(11, 1, 'node E:\\x\\node_modules\\some-mcp\\index.js', old),
    proc(12, 1, 'node E:\\x\\node_modules\\other-mcp\\index.js', fresh),
    proc(13, 1, 'notepad.exe', old)
  ]
  const found = findLongLived(procs, { olderThanMs: 30 * 60 * 1000 })
  assert.equal(found.length, 1)
  assert.equal(found[0].evidence.plugin, 'some-mcp')
})

test('collectFindings never proposes protected system processes', () => {
  const procs = [
    proc(1, 0, 'lsass', Date.now() - 9999999, 'lsass'),
    proc(2, 1, 'cmd /c npx -y @upstash/context7-mcp'),
    proc(3, 1, 'cmd /c npx -y @upstash/context7-mcp'),
    proc(4, 1, 'cmd /c npx -y @upstash/context7-mcp')
  ]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3 })
  for (const f of findings) {
    for (const pid of f.pids) assert.ok(!PROTECTED_NAMES.has('lsass') || pid !== 1)
  }
  assert.ok(findings.some((f) => f.type === 'duplicate'))
})
