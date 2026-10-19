import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESIDENCY, residencyOf, residencyBusyMs, residencyConfidence, classifyResidency,
  residencySummary, residencyFindings, RESIDENCY_RULE_DESCRIPTION
} from '../lib/residency.js'
import { buildLineage } from '../lib/lineage.js'
import { FINDING_CONFIDENCE, FINDING_RULE, FINDING_RULE_DESCRIPTION } from '../lib/shared.js'

function agent(id, { parent = null, origin = null, status = 'idle' } = {}) {
  const header = { id }
  if (parent) header.parentSession = parent
  if (origin) header.origin = origin
  return { id, status, session: { header } }
}

const ROOT = agent('root-1')
const RUNNING = agent('child-running', { parent: 'root-1', origin: 'subagent', status: 'running' })
const IDLE = agent('child-idle', { parent: 'root-1', origin: 'subagent' })

test('the residency vocabulary is fixed and enumerable', () => {
  assert.deepEqual([...RESIDENCY], ['running', 'idle-resident', 'idle-parked', 'unknown'])
})

test('an unclosed turn in the projection is the hard evidence of running', () => {
  const now = 1_000_000
  // `active` 只在 turn/end 之前存在，因此它的存在就是「这个 turn 还没结束」。
  assert.equal(residencyOf({ live: true, timing: { settledMs: 0, active: { since: now - 5000, through: now } } }), 'running')
  // turn 已结算、Agent 仍存活：驻留且空闲。它可以被继续对话，因此这不是异常。
  assert.equal(residencyOf({ live: true, timing: { settledMs: 60000, lastTurnCompleted: true } }), 'idle-resident')
  // 不在册的子会话已经归还了容量槽，只剩持久记录里的一行。这一档由它在册的
  // 来源本身说明，不需要投影来证明。
  assert.equal(residencyOf({ live: false, timing: null }), 'idle-parked')
  assert.equal(residencyOf({ live: false, timing: { settledMs: 5 } }), 'idle-parked')
  // 读不到投影时不给判定。
  assert.equal(residencyOf({ live: true, timing: null }), 'unknown')
  assert.equal(residencyOf({ live: true, timing: undefined }), 'unknown')
  assert.equal(residencyOf({ live: true, timing: 'nonsense' }), 'unknown')
})

test('a catalog-only row reads as parked without reading a projection for it', async () => {
  const requested = []
  const rows = await classifyResidency({
    lineageRows: [],
    catalogRows: [{ kind: 'child', id: 'cold-1', parentId: 'root-1', mode: 'continuable', activity: 'inactive' }],
    readTiming: async (id) => { requested.push(id); return null }
  }, { now: 1000 })

  assert.deepEqual(requested, [], 'a parked child must not be pulled back into memory')
  assert.deepEqual(rows, [{
    id: 'cold-1', parentId: 'root-1', residency: 'idle-parked',
    // 只有 catalog 行：在册是事实，但「它是否还在跑」没有证据。
    confidence: 'indicative', busyMs: null, settledMs: null, lastTurnCompleted: null
  }])
})

test('only live children from the lineage get their projection read', async () => {
  const requested = []
  const lineage = buildLineage([ROOT, RUNNING, IDLE])
  const rows = await classifyResidency({
    lineageRows: lineage.rows,
    catalogRows: [
      { kind: 'child', id: 'child-idle', parentId: 'root-1' },
      { kind: 'diagnostic', id: 'broken', parentId: 'root-1', reason: 'corrupt' },
      { kind: 'child', id: 'cold-1', parentId: 'root-1' }
    ],
    readTiming: async (id) => {
      requested.push(id)
      return id === 'child-running'
        ? { settledMs: 1000, active: { since: 500, through: 900 } }
        : { settledMs: 120000, lastTurnCompleted: true }
    }
  }, { now: 1000 })

  // 谱系里的两个子代读投影；catalog 里的 parked 行不读；诊断行跳过。
  assert.deepEqual(requested, ['child-running', 'child-idle'])
  assert.deepEqual(rows.map((row) => [row.id, row.residency, row.confidence]), [
    ['child-running', 'running', 'exact'],
    ['child-idle', 'idle-resident', 'exact'],
    // catalog 里重复出现的 child-idle 由谱系那一行覆盖，不再单独出现。
    ['cold-1', 'idle-parked', 'indicative']
  ])
})

test('a missing sessionQuery leaves the row without a verdict rather than a guess', async () => {
  const lineage = buildLineage([ROOT, IDLE])
  const rows = await classifyResidency({
    lineageRows: lineage.rows,
    readTiming: async () => null
  }, { now: 1000 })

  assert.deepEqual(rows, [{
    id: 'child-idle', parentId: 'root-1', residency: 'unknown',
    confidence: 'indicative', busyMs: null, settledMs: null, lastTurnCompleted: null
  }])
})

test('cancelled classification stops instead of finishing the remaining rows', async () => {
  const controller = new AbortController()
  const lineage = buildLineage([ROOT, IDLE, agent('child-c', { parent: 'root-1', origin: 'subagent' })])
  const read = []
  const rows = await classifyResidency({
    lineageRows: lineage.rows,
    readTiming: async (id) => { read.push(id); controller.abort(); return null }
  }, { now: 1000, signal: controller.signal })

  // 取消落在第一次读的中途，因此那一行也不产出，后面的行不再读。
  assert.deepEqual(rows, [])
  assert.deepEqual(read, ['child-idle'], 'no row is read after the request is cancelled')
})

test('busy time comes from the projection, and an absent projection yields none', () => {
  const now = 1_000_000
  // 开放的 turn 用 now - active.since。
  assert.equal(residencyBusyMs({ settledMs: 500, active: { since: now - 250, through: now } }, now), 250)
  // 已结算的 turn 用累计值。
  assert.equal(residencyBusyMs({ settledMs: 90_000, lastTurnCompleted: true }, now), 90_000)
  assert.equal(residencyBusyMs(null, now), null)
  assert.equal(residencyBusyMs({}, now), null)
  // 时钟倒流不会给出负的时长。
  assert.equal(residencyBusyMs({ settledMs: 0, active: { since: now + 5000, through: now } }, now), 0)
})

test('confidence reuses the three declared tiers', () => {
  assert.equal(residencyConfidence({ fromLineage: true, hasTiming: true }), 'exact')
  assert.equal(residencyConfidence({ fromLineage: true, hasTiming: false }), 'indicative')
  assert.equal(residencyConfidence({ fromLineage: false, hasTiming: false }), 'indicative')
  for (const confidence of [residencyConfidence({ fromLineage: true, hasTiming: true })]) {
    assert.ok(FINDING_CONFIDENCE.includes(confidence), confidence)
  }
})

test('the summary reports resident and idle counts and never a capacity figure', () => {
  const rows = [
    { residency: 'running' }, { residency: 'idle-resident' }, { residency: 'idle-resident' },
    { residency: 'idle-parked' }, { residency: 'unknown' }
  ]
  const summary = residencySummary(rows)

  assert.deepEqual(summary, { resident: 3, running: 1, idle: 3, unknown: 1 })
  // maxActiveSubagents 是 Volatile 且 private 的配置，读不到，因此摘要里没有容量。
  assert.ok(!('capacity' in summary) && !('maxActiveSubagents' in summary))
  assert.deepEqual(residencySummary(null), { resident: 0, running: 0, idle: 0, unknown: 0 })
})

test('only rows past the user threshold are promoted, and a disabled threshold promotes none', () => {
  const rows = [
    { id: 'busy', parentId: 'root-1', residency: 'idle-resident', confidence: 'exact', busyMs: 7_200_000, settledMs: 7_200_000 },
    { id: 'fresh', parentId: 'root-1', residency: 'idle-resident', confidence: 'exact', busyMs: 1000, settledMs: 1000 },
    { id: 'unread', parentId: 'root-1', residency: 'unknown', confidence: 'indicative', busyMs: null }
  ]

  const promoted = residencyFindings(rows, { thresholdMs: 3_600_000 })
  assert.equal(promoted.length, 1)
  const [finding] = promoted
  assert.equal(finding.rule, 'subagent.idle-resident')
  assert.equal(finding.confidence, 'exact')
  assert.ok(FINDING_RULE.includes(finding.rule))
  assert.deepEqual(finding.provenance, {
    rule: 'subagent.idle-resident',
    description: RESIDENCY_RULE_DESCRIPTION['subagent.idle-resident']
  })
  // 措辞是驻留 / 空闲，不是泄漏：驻留本身是设计。
  assert.match(finding.detail, /resident and idle/)
  // 没有 OS 进程，因此永远不会成为树杀目标。
  assert.deepEqual(finding.pids, [])
  assert.equal(finding.ownership.session, 'root-1')

  // 默认关闭：判定照常显示，一块发现都没有。
  assert.deepEqual(residencyFindings(rows, { thresholdMs: 0 }), [])
  assert.deepEqual(residencyFindings(rows, { thresholdMs: null }), [])
  // 刚好等于阈值不算越线。
  assert.deepEqual(residencyFindings([{ ...rows[0], busyMs: 3_600_000 }], { thresholdMs: 3_600_000 }), [])
})

test('the residency rule description lives in the shared vocabulary too', () => {
  // 两处说明必须一致：宿主用它填 finding 的 provenance，lib/residency.js 用它
  // 填同一处。
  assert.equal(
    FINDING_RULE_DESCRIPTION['subagent.idle-resident'],
    RESIDENCY_RULE_DESCRIPTION['subagent.idle-resident']
  )
})