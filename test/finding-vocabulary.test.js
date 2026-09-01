// DTK-M1: the finding vocabulary is data, so it is asserted as data. This
// file pins rule / confidence / ownership for the three rules across the
// scenarios that matter: full sample, degraded sample, no attribution.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findDuplicates, findOrphans, findLongLived, collectFindings,
  applyLedgerOwnership, findingConfidence, findingOwnership, findingProvenance
} from '../lib/leak.js'
import { attribute } from '../lib/attribute.js'
import {
  FINDING_CONFIDENCE, FINDING_SCOPE, FINDING_VIA, FINDING_RULE,
  FINDING_RULE_DESCRIPTION
} from '../lib/shared.js'

function proc(pid, ppid, cmdline, createdMs = Date.now() - 60 * 60 * 1000, name = 'node') {
  return { pid, ppid, name, cmdline, createdMs, wsBytes: 0 }
}

const MCP = 'cmd /c npx -y @upstash/context7-mcp'

test('the vocabulary domains are fixed and enumerable', () => {
  assert.deepEqual([...FINDING_CONFIDENCE], ['exact', 'indicative', 'inferred'])
  assert.deepEqual([...FINDING_SCOPE], ['host-descendant', 'session', 'job', 'unattributed'])
  assert.deepEqual([...FINDING_VIA], ['ppid-chain', 'root-itself', 'job-label', 'none'])
  assert.deepEqual([...FINDING_RULE], ['duplicate.cmdline', 'orphan.dead-parent', 'longlived.plugin-child'])
})

test('each heuristic names its own rule even when called on its own', () => {
  const dup = findDuplicates([proc(1, 9, MCP), proc(2, 9, MCP), proc(3, 9, MCP)], { minCopies: 3 })
  assert.equal(dup[0].rule, 'duplicate.cmdline')
  assert.equal(findOrphans([proc(7, 999, 'node mcp.js')])[0].rule, 'orphan.dead-parent')
  const old = Date.now() - 45 * 60 * 1000
  const long = findLongLived([proc(11, 1, 'node E:\\x\\node_modules\\some-mcp\\index.js', old)], { olderThanMs: 30 * 60 * 1000 })
  assert.equal(long[0].rule, 'longlived.plugin-child')
  for (const rule of [dup[0].rule, 'orphan.dead-parent', long[0].rule]) {
    assert.ok(FINDING_RULE.includes(rule), rule + ' must be in the rule domain')
  }
})

test('provenance pairs every rule id with a human-readable description', () => {
  // The description domain covers the whole rule domain, and nothing else.
  assert.deepEqual(Object.keys(FINDING_RULE_DESCRIPTION).sort(), [...FINDING_RULE].sort())
  for (const description of Object.values(FINDING_RULE_DESCRIPTION)) {
    assert.equal(typeof description, 'string')
    assert.ok(description.length > 0)
  }

  // Standalone finders carry it, so the field exists on every production path.
  const dup = findDuplicates([proc(1, 9, MCP), proc(2, 9, MCP), proc(3, 9, MCP)], { minCopies: 3 })
  assert.deepEqual(dup[0].provenance, findingProvenance('duplicate.cmdline'))
  assert.equal(dup[0].provenance.rule, 'duplicate.cmdline')
  assert.equal(dup[0].provenance.description, FINDING_RULE_DESCRIPTION['duplicate.cmdline'])

  // Unknown rule ids degrade to a null description instead of throwing.
  assert.deepEqual(findingProvenance('future.rule'), { rule: 'future.rule', description: null })
})

test('a full sample inside the host tree is exact via the parent chain', () => {
  const procs = [
    proc(1, 0, 'node host.js'),
    proc(2, 1, MCP),
    proc(3, 1, MCP),
    proc(4, 1, MCP)
  ]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3 })

  assert.equal(findings.length, 1)
  const [finding] = findings
  assert.equal(finding.rule, 'duplicate.cmdline')
  assert.deepEqual(finding.provenance, {
    rule: 'duplicate.cmdline',
    description: FINDING_RULE_DESCRIPTION['duplicate.cmdline']
  })
  assert.equal(finding.confidence, 'exact')
  assert.deepEqual(finding.ownership, {
    scope: 'host-descendant', via: 'ppid-chain',
    rootLabel: 'harness', depth: 1, session: null, job: null
  })
  // The legacy payload the UI reads stays intact.
  assert.equal(finding.evidence.sample, MCP)
  assert.equal(finding.type, 'duplicate')
  assert.equal(typeof finding.detail, 'string')
})

test('a finding whose first pid is the host root is attributed to itself', () => {
  // The stamp describes the group's first pid; with the root first it must
  // say root-itself at depth 0 rather than inventing a parent.
  const procs = [proc(1, 0, MCP), proc(2, 1, MCP), proc(3, 1, MCP)]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3 })

  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0].pids, [1, 2, 3])
  assert.equal(findings[0].ownership.via, 'root-itself')
  assert.equal(findings[0].ownership.depth, 0)
  assert.equal(findings[0].ownership.rootLabel, 'harness')
  assert.equal(findings[0].confidence, 'exact')
})

test('degraded sampling caps confidence at indicative', () => {
  assert.equal(findingConfidence({ attributed: true, degraded: null }), 'exact')
  assert.equal(findingConfidence({ attributed: true, degraded: 'no-ppid' }), 'indicative')
  assert.equal(findingConfidence({ attributed: false, degraded: null }), 'inferred')

  // Wired end to end: the same rows lose `exact` once the sampler degraded.
  const procs = [proc(1, 0, 'node host.js'), proc(2, 1, MCP), proc(3, 1, MCP), proc(4, 1, MCP)]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3, degraded: 'no-ppid' })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].confidence, 'indicative')
  assert.equal(findings[0].ownership.via, 'ppid-chain', 'degraded softens the level, it does not drop the chain')

  // A real degraded sample (tasklist: no ppid, no cmdline, no creation time)
  // can fire none of the rules, which is why the UI disables tree kill.
  const degradedProcs = [
    { pid: 1, ppid: 0, name: 'node', cmdline: '', createdMs: null, wsBytes: 0 },
    { pid: 2, ppid: 0, name: 'node', cmdline: '', createdMs: null, wsBytes: 0 }
  ]
  const degradedAttribution = attribute(degradedProcs, new Map([[1, 'harness']]))
  assert.deepEqual(collectFindings(degradedProcs, degradedAttribution, { degraded: 'no-ppid' }), [])
})

test('an unattributed process is inferred through no chain at all', () => {
  assert.deepEqual(findingOwnership({ info: null }), {
    scope: 'unattributed', via: 'none', rootLabel: null, depth: null, session: null, job: null
  })
  assert.equal(findingConfidence({ attributed: false }), 'inferred')

  // The investigation bucket never reaches collectFindings (it would flood
  // the panel with Windows services), so M3 renders it with this stamp.
  const procs = [proc(1, 0, 'node host.js'), proc(50, 4242, MCP), proc(51, 4242, MCP), proc(52, 4242, MCP)]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3 })
  assert.deepEqual(findings, [], 'strangers stay out of the actionable list')
  assert.equal(attribution.attributed.has(50), false)
})

test('the ledger join adds the session and job links to ownership', () => {
  const procs = [proc(1, 0, 'node host.js'), proc(2, 1, MCP), proc(3, 1, MCP), proc(4, 1, MCP)]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3 })

  applyLedgerOwnership(findings, [{ source: 'job', id: 'bash-1', pids: [2], ownerSession: 'session-1' }])
  assert.deepEqual(findings[0].ownership, {
    scope: 'session', via: 'job-label',
    rootLabel: 'harness', depth: 1, session: 'session-1', job: 'bash-1'
  })
  assert.equal(findings[0].confidence, 'exact', 'an indicative join never raises the level')

  // A job without an owner session is less specific, and a later snapshot
  // without that job must fall back to the OS chain (idempotent refresh).
  applyLedgerOwnership(findings, [{ source: 'job', id: 'bash-2', pids: [2], ownerSession: null }])
  assert.equal(findings[0].ownership.scope, 'job')
  assert.equal(findings[0].ownership.session, null)
  assert.equal(findings[0].ownership.job, 'bash-2')

  applyLedgerOwnership(findings, [])
  assert.deepEqual(findings[0].ownership, {
    scope: 'host-descendant', via: 'ppid-chain',
    rootLabel: 'harness', depth: 1, session: null, job: null
  })
  assert.equal(applyLedgerOwnership(findings, null), findings)
})

test('every collected finding stays inside the declared domains', () => {
  const old = Date.now() - 45 * 60 * 1000
  // Pid 5 is an extra whitelisted root: the orphan rule can only fire on a
  // root, because collectFindings() pre-filters to attributed processes and
  // attribution walks live parent links — a reachable child always has its
  // parent in the snapshot. (Worth revisiting in M3; not changed here.)
  const procs = [
    proc(1, 0, 'node host.js'),
    proc(2, 1, MCP), proc(3, 1, MCP), proc(4, 1, MCP),
    proc(5, 8888, 'node orphan.js'),
    proc(6, 1, 'node E:\\x\\node_modules\\some-mcp\\index.js', old),
    proc(7, 0, 'notepad.exe')
  ]
  const attribution = attribute(procs, new Map([[1, 'harness'], [5, 'whitelisted']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3, olderThanMs: 30 * 60 * 1000 })

  const rules = findings.map((f) => f.rule).sort()
  assert.deepEqual(rules, ['duplicate.cmdline', 'longlived.plugin-child', 'orphan.dead-parent'])
  for (const finding of findings) {
    assert.ok(FINDING_RULE.includes(finding.rule), String(finding.rule))
    assert.deepEqual(finding.provenance, {
      rule: finding.rule,
      description: FINDING_RULE_DESCRIPTION[finding.rule]
    })
    assert.ok(FINDING_CONFIDENCE.includes(finding.confidence), String(finding.confidence))
    assert.ok(FINDING_SCOPE.includes(finding.ownership.scope), String(finding.ownership.scope))
    assert.ok(FINDING_VIA.includes(finding.ownership.via), String(finding.ownership.via))
    assert.equal(typeof finding.detail, 'string', 'free text stays in its own field')
  }
  assert.ok(findings.every((f) => f.confidence === 'exact'), 'all three sit in the host tree')
  const orphan = findings.find((f) => f.rule === 'orphan.dead-parent')
  assert.equal(orphan.ownership.via, 'root-itself')
  assert.equal(orphan.ownership.rootLabel, 'whitelisted')
})
