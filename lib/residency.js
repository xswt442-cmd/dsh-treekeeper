// 子代理的驻留级判定。面板此前把 DSH 的 `activity` 当状态显示，而那个字段只回答
// 「这个子会话还挂在 store 里吗」：一个 turn 早已结束、inbox 空、但 Activation 仍
// 驻留的子代理，在面板上与真在跑的那一行长得一样。真正的 turn 事实写在
// `subagentTiming` 投影里，经 `sessionQuery.observeSession(childId)` 读——上游
// 客户端自己就用它算时长。
//
// 三种判定都是可观测事实，不是告警：
//
//   running         投影里有未闭合的 turn（`active`）。
//   idle-resident   turn 已结算，Agent 仍存活——它占着容量槽，且可以被
//                   `send_message` 继续。这不是异常，是设计。
//   idle-parked     子会话不再挂在 store 里，容量槽已经归还；它只是持久记录
//                   里的一行。
//
// 只有超过用户可配阈值才升级为 finding，措辞用「驻留 / 空闲」而不叫泄漏：驻留
// 本身是设计，空闲的子代理可以被继续对话。
//
// 判定不到时不猜：缺 sessionQuery、投影读不出来时，那一行不带判定。

/** 三种可观测的驻留级。`unknown` 表示这一行没有可依据的判定。 */
export const RESIDENCY = Object.freeze(['running', 'idle-resident', 'idle-parked', 'unknown'])

/**
 * 从 `subagentTiming` 投影值判定驻留级。
 *
 * @param {{live: boolean, timing: object|null}} facts
 * @returns {'running'|'idle-resident'|'idle-parked'|'unknown'}
 */
export function residencyOf({ live, timing }) {
  // 不在 agents 注册表里的子会话已经不在 store 中，容量槽已经归还——这由它在册
  // 的来源本身说明，不需要投影来证明。因此这一档先判。
  if (!live) return 'idle-parked'
  if (timing === null || typeof timing !== 'object') return 'unknown'
  // 未闭合的 turn 是最硬的证据：`active` 只在 turn/end 之前存在。
  if (timing.active && Number.isFinite(timing.active.since)) return 'running'
  // 投影读到了却没有开放的 turn，说明最后一个 turn 已经结算，而它仍是存活的
  // Agent，因此占着容量槽。
  return 'idle-resident'
}

/**
 * 这一行已经花了多少 turn 时间（毫秒）。
 *
 * 投影只回答得了累计量：`settledMs` 是已完成 turn 的累计时长，当前 turn 的时长
 * 由 `now - active.since` 得出。它没有记录「最后一个 turn 何时结束」，因此空闲了
 * 多久算不出来——阈值判定因此不建立在空闲时长上，而是建立在这个累计量上：一个
 * 被反复唤醒的驻留子代会累积出可观的时长。
 *
 * @param {object|null} timing - `subagentTiming` 投影值
 * @param {number} now
 * @returns {number|null} 可算出的累计时长；算不出时为 null
 */
export function residencyBusyMs(timing, now) {
  if (timing === null || typeof timing !== 'object') return null
  if (timing.active && Number.isFinite(timing.active.since)) return Math.max(0, now - timing.active.since)
  return Number.isFinite(timing.settledMs) ? timing.settledMs : null
}

/**
 * 一条驻留判定的置信度。与进程发现共用同一套三档词表，判据也是同一件事：证据
 * 从哪来。
 *
 *   exact       agents 谱系与 timing 投影都在：子代确实存活，且 turn 状态是投影
 *               读出来的事实。
 *   indicative  只有 catalog 行：子代理在持久记录里，但这一轮没有读到它的投影，
 *               结论因此只到「它在册」这一层。
 */
export function residencyConfidence({ fromLineage, hasTiming }) {
  return fromLineage && hasTiming ? 'exact' : 'indicative'
}

/**
 * 把跨会话谱系与 catalog 行合成一批带驻留级的判定行。
 *
 * 性能边界：只对 agents 里活着的子代读投影。为一个不在注册表里的子会话读投影，
 * 会替它把持久化会话重新准备回内存——那正是 `idle-parked` 这一档要说明的状态，
 * 不该由一次普查把它变活。`listDescendants` 的诊断行没有子会话可读，直接跳过。
 *
 * @param {object} sources
 * @param {Array} [sources.lineageRows] - buildLineage() 的行（全部存活）
 * @param {Array} [sources.catalogRows] - listDescendants() 的行（可能已不在册）
 * @param {(id: string, signal?: AbortSignal) => Promise<object|null>} readTiming - 投影读取
 * @param {{now?: number, signal?: AbortSignal}} opts
 */
export async function classifyResidency({ lineageRows = [], catalogRows = [], readTiming }, { now = Date.now(), signal } = {}) {
  const out = []
  const seen = new Set()

  // 先走 agents 谱系：这些是存活的子代，也是唯一值得读投影的一批。
  for (const row of Array.isArray(lineageRows) ? lineageRows : []) {
    if (!row || row.origin !== 'subagent' || row.parentId === null) continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const timing = typeof readTiming === 'function' ? await readTiming(row.id, signal) : null
    if (signal && signal.aborted) return out
    out.push(residencyRow({ id: row.id, parentId: row.parentId, live: true, timing, now }))
  }

  // 再补 catalog 行：不在谱系里的行说明这个子会话已经不在 store 中，容量槽已经
  // 归还。它在册是事实（indicative），但不必为它读投影。
  for (const row of Array.isArray(catalogRows) ? catalogRows : []) {
    if (!row || row.kind === 'diagnostic') continue
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id)) continue
    seen.add(row.id)
    out.push(residencyRow({
      id: row.id,
      parentId: typeof row.parentId === 'string' ? row.parentId : null,
      live: false,
      timing: null,
      now
    }))
  }

  return out
}

function residencyRow({ id, parentId, live, timing, now }) {
  const residency = residencyOf({ live, timing })
  return {
    id,
    parentId,
    residency,
    // 有谱系且读到了投影才是确证。缺 sessionQuery 时 `hasTiming` 为 false，这一
    // 行停在 indicative，而不是假装它空闲。
    confidence: residencyConfidence({ fromLineage: live, hasTiming: timing !== null }),
    busyMs: residencyBusyMs(timing, now),
    settledMs: timing && Number.isFinite(timing.settledMs) ? timing.settledMs : null,
    lastTurnCompleted: timing && typeof timing.lastTurnCompleted === 'boolean' ? timing.lastTurnCompleted : null
  }
}

/**
 * 一批判定行里的计数。插件不报容量上限——`ctx.subagents.maxActiveSubagents` 是
 * Volatile 且 private 的配置，读不到——因此只报「驻留 N / 空闲 M」这两个由观测
 * 得出的数字。
 */
export function residencySummary(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean)
  return {
    resident: list.filter((row) => row.residency === 'running' || row.residency === 'idle-resident').length,
    running: list.filter((row) => row.residency === 'running').length,
    idle: list.filter((row) => row.residency === 'idle-resident' || row.residency === 'idle-parked').length,
    unknown: list.filter((row) => row.residency === 'unknown').length
  }
}

/**
 * 超过阈值的驻留行升级为一条发现。措辞是「驻留 / 空闲」而不是泄漏：驻留本身是
 * 设计，空闲的子代可以被 `send_message` 继续。只有累计 turn 时长越过用户可配
 * 阈值的行才进入这里，因此这一块默认是空的。
 *
 * @param {Array} rows - classifyResidency() 的输出
 * @param {{thresholdMs: number}} opts
 */
export function residencyFindings(rows, { thresholdMs }) {
  const list = Array.isArray(rows) ? rows : []
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return []
  return list
    .filter((row) => row && row.busyMs !== null && row.busyMs > thresholdMs)
    .map((row) => ({
      type: 'residency',
      rule: 'subagent.idle-resident',
      provenance: { rule: 'subagent.idle-resident', description: RESIDENCY_RULE_DESCRIPTION['subagent.idle-resident'] },
      // 驻留判定没有 OS 进程，因此 pids 为空：它永远不会成为树杀目标。
      pids: [],
      key: `session:${row.id}`,
      detail: row.residency === 'idle-resident'
        ? `subagent is resident and idle after ${Math.round(row.busyMs / 60000)} min of turns`
        : `subagent is parked after ${Math.round(row.busyMs / 60000)} min of turns`,
      evidence: { sessionId: row.id, parentSessionId: row.parentId, residency: row.residency, busyMs: row.busyMs },
      confidence: row.confidence,
      ownership: {
        scope: 'session',
        via: 'none',
        rootLabel: null,
        depth: null,
        session: row.parentId,
        job: null
      }
    }))
}

/** 每条规则的人读说明，显示在原始 id 之前。 */
export const RESIDENCY_RULE_DESCRIPTION = Object.freeze({
  'subagent.idle-resident': 'a subagent holds its capacity slot after accumulating turn time past the threshold'
})