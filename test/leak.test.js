import test from 'node:test'
import assert from 'node:assert/strict'
import { findDuplicates, findOrphans, findLongLived, findPreviousHostOrphans, collectFindings, PROTECTED_NAMES } from '../lib/leak.js'
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

// The false positive the panel showed at every refresh: the desktop host is a
// descendant of the root itself, its parent is the live Electron main process,
// and that parent is never in the killable list because DSH does not own it.
test('a live parent outside the candidate list is not a dead parent', () => {
  const procs = [
    proc(12000, 1000, 'C:\\Windows\\Explorer.EXE', Date.now(), 'explorer'),
    proc(40376, 12000, '"E:\\DSH\\DeepSeek Harness.exe"', Date.now(), 'DeepSeek Harness'),
    proc(37224, 40376, 'node host.js')
  ]
  const killable = procs.filter((p) => p.pid === 37224)

  assert.equal(findOrphans(killable).length, 1, 'against the narrowed list the parent looks gone')
  assert.deepEqual(findOrphans(killable, new Set(procs.map((p) => p.pid))), [], 'against the whole snapshot it is alive')
})

test('a DSH path with a dead parent is a previous-host lead, and a plain node process is not', () => {
  const leaf = Date.now() - 60 * 1000
  const procs = [
    proc(99001, 88888, 'node C:\\Users\\dev\\.dsh\\profiles\\web\\node_modules\\some-mcp\\index.js', leaf),
    proc(99002, 88888, 'node C:\\Users\\dev\\node_modules\\some-mcp\\index.js', leaf),
    proc(99003, 99001, 'node kid.js', leaf)
  ]
  const found = findPreviousHostOrphans(procs)

  assert.equal(found.length, 1)
  assert.equal(found[0].rule, 'orphan.previous-host')
  assert.equal(found[0].key, 'pid:99001')
  assert.equal(found[0].evidence.parentPid, 88888)
  assert.deepEqual(found[0].evidence.signals, ['profile', 'node_modules'])
})

test('a previous-host survivor is an indicative investigation lead and never a candidate', () => {
  const procs = [
    proc(1, 0, 'node host.js'),
    proc(2, 1, 'node host-child.js'),
    // Long-lived and plugin-hinted, but outside the host tree: the two rules
    // that could have claimed it look only at attributed descendants.
    proc(99001, 88888, 'node C:\\Users\\dev\\.dsh\\profiles\\web\\node_modules\\some-mcp\\index.js', Date.now() - 45 * 60 * 1000)
  ]
  const attribution = attribute(procs, new Map([[1, 'harness']]))

  const findings = collectFindings(procs, attribution, { minCopies: 3, olderThanMs: 30 * 60 * 1000 })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'orphan.previous-host')
  assert.equal(findings[0].confidence, 'indicative')
  assert.equal(findings[0].ownership.scope, 'unattributed')
  assert.equal(findings[0].attribution, null)
  assert.ok(!attribution.attributed.has(99001), 'the finding never claims the process')
})

test('the host tree does not report a live unattributed parent as an orphan', () => {
  const procs = [
    proc(40376, 12000, '"E:\\DSH\\DeepSeek Harness.exe"', Date.now(), 'DeepSeek Harness'),
    proc(37224, 40376, 'node host.js')
  ]
  const attribution = attribute(procs, new Map([[37224, 'harness']]))

  assert.deepEqual(collectFindings(procs, attribution, { minCopies: 3, olderThanMs: 30 * 60 * 1000 }), [])
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

test('collectFindings ignores duplicate and orphan candidates outside the host tree', () => {
  const procs = [
    proc(1, 0, 'node host.js'),
    proc(2, 1, 'node host-child.js'),
    proc(10, 999, 'node system-worker.js'),
    proc(11, 999, 'node system-worker.js'),
    proc(12, 999, 'node system-worker.js')
  ]
  const attribution = attribute(procs, new Map([[1, 'harness']]))

  const findings = collectFindings(procs, attribution, { minCopies: 3 })

  assert.deepEqual(findings, [])
})
