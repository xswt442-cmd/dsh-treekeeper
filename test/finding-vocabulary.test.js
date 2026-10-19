// 发现的词表以数据形式提供，因此也以数据形式断言。本文件在三种场景（完整采样、
// 降级采样、无归因）下锁定每条规则的 rule / confidence / ownership。

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
  assert.deepEqual([...FINDING_VIA], ['ppid-chain', 'root-itself', 'job-label', 'pty-pid', 'none'])
  assert.deepEqual([...FINDING_RULE], ['duplicate.cmdline', 'orphan.dead-parent', 'orphan.previous-host', 'longlived.plugin-child', 'subagent.idle-resident'])
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
  // 说明的键集合覆盖整个规则集合，不多也不少。
  assert.deepEqual(Object.keys(FINDING_RULE_DESCRIPTION).sort(), [...FINDING_RULE].sort())
  for (const description of Object.values(FINDING_RULE_DESCRIPTION)) {
    assert.equal(typeof description, 'string')
    assert.ok(description.length > 0)
  }

  // 单独调用的查找函数也会带上它，因此每条生产路径上这个字段都存在。
  const dup = findDuplicates([proc(1, 9, MCP), proc(2, 9, MCP), proc(3, 9, MCP)], { minCopies: 3 })
  assert.deepEqual(dup[0].provenance, findingProvenance('duplicate.cmdline'))
  assert.equal(dup[0].provenance.rule, 'duplicate.cmdline')
  assert.equal(dup[0].provenance.description, FINDING_RULE_DESCRIPTION['duplicate.cmdline'])

  // 未知规则 id 得到 null 说明，不会抛错。
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
  // 界面读取的旧负载字段保持原样。
  assert.equal(finding.evidence.sample, MCP)
  assert.equal(finding.type, 'duplicate')
  assert.equal(typeof finding.detail, 'string')
})

test('a finding whose first pid is the host root is attributed to itself', () => {
  // 戳记描述的是这组进程的第一个 pid；根排在最前时，它必须说 depth 0 的
  // root-itself，而不是编造一个父进程。
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

  // 端到端接通：同样的行在采样降级后失去 `exact`。
  const procs = [proc(1, 0, 'node host.js'), proc(2, 1, MCP), proc(3, 1, MCP), proc(4, 1, MCP)]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3, degraded: 'no-ppid' })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].confidence, 'indicative')
  assert.equal(findings[0].ownership.via, 'ppid-chain', '降级只压低等级，不会丢掉链条')

  // 真实的降级采样（tasklist：无 ppid、无命令行、无创建时间）触发不了任何规则，
  // 界面因此停用树杀。
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

  // 排查集合不会进入 collectFindings（那会让面板被 Windows 服务淹没），因此界面
  // 用这个戳记单独渲染它。
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
  assert.equal(findings[0].confidence, 'exact', '指示性的对账不会抬高置信等级')

  // 没有 ownerSession 的任务更宽泛；之后一份不含该任务的快照必须退回操作系统
  // 链条（刷新是幂等的）。
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

test('the previous-host rule stays inside the declared domains', () => {
  const procs = [
    proc(1, 0, 'node host.js'),
    proc(2, 1, 'node host-child.js'),
    // 被结束的宿主留下的残留：没有存活的父进程，没有归因链，但桌面包的路径仍在
    // 命令行里。
    proc(99, 8888, 'node E:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js')
  ]
  const attribution = attribute(procs, new Map([[1, 'harness']]))
  const findings = collectFindings(procs, attribution, { minCopies: 3 })

  assert.equal(findings.length, 1)
  const [finding] = findings
  assert.equal(finding.rule, 'orphan.previous-host')
  // 指示性，不是推断：证据是真实的，与当前宿主的链接不是。
  assert.equal(finding.confidence, 'indicative')
  assert.ok(FINDING_CONFIDENCE.includes(finding.confidence))
  assert.equal(finding.ownership.scope, 'unattributed')
  assert.ok(FINDING_SCOPE.includes(finding.ownership.scope))
  assert.ok(FINDING_VIA.includes(finding.ownership.via))
  assert.ok(FINDING_RULE.includes(finding.rule))
  assert.deepEqual(finding.provenance, {
    rule: 'orphan.previous-host',
    description: FINDING_RULE_DESCRIPTION['orphan.previous-host']
  })
})

test('every collected finding stays inside the declared domains', () => {
  const old = Date.now() - 45 * 60 * 1000
  // pid 5 是额外的登记根：孤儿规则只能命中根，因为 collectFindings() 先筛出已
  // 归因的进程，而归因沿存活的父链向下走——可达的子进程一定在快照里有父进程。
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
