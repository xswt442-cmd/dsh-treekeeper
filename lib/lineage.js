// 存活 Agent 的子代理谱系，跨会话。面板只读当前选中会话的子代理树，而驻留的
// 子代理恰恰可能在别的会话里；本模块给出全宿主范围的谱系事实，让普查与释放都
// 建立在同一份读数上。
//
// 读面边界：只读 `agent.session.header` 的 `parentSession` 与 `origin`，以及
// `Agent.status`。不读任何会话内容，不读日志。谱系的构造方式与宿主自己的归档准入
// 一致：一个子代理是「header 指名父会话且带 subagent origin」的那个 Agent；fork
// 共享 lineage 字段却没有 origin，因此不持有它的父会话。
//
// 服务未挂载时每个访问器都把这份「不可用」如实返回，调用方必须把它呈现出来。

/**
 * 在注入围栏内捕获 agents 与 subagents 两个可选服务。两个服务都要：谱系读
 * agents，释放走 subagents.drainChildren。只在围栏内绑定公开方法，请求处理函数
 * 因此不必待在这个围栏里；缺少任一能力的宿主照常降级。
 */
export function createAgentLineage(ctx) {
  let generation = 0
  let agents = null
  let subagents = null
  let readTiming = null

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents', 'subagents', 'sessionQuery'], (scope) => {
      const mine = ++generation
      // 只保留绑定好的公开方法：DSH 在围栏外读取服务属性会抛错，请求处理函数不
      // 能依赖这一点。
      agents = usable(scope.agents, ['list', 'get'])
      subagents = usable(scope.subagents, ['drainChildren'])
      // 驻留判定读的是 subagentTiming 投影，不是会话内容；一次观察的租约由
      // timingReader 用完即释放。
      readTiming = scope.sessionQuery && typeof scope.sessionQuery.observeSession === 'function'
        ? timingReader(scope.sessionQuery)
        : null
      if (typeof scope.on === 'function') {
        scope.on('dispose', () => {
          if (mine !== generation) return
          generation += 1
          agents = null
          subagents = null
          readTiming = null
        })
      }
    })
  }

  return {
    /**
     * 全部存活 Agent 的谱系事实。服务不可用时返回 null，调用方必须说出自己缺
     * 什么，而不是把空集合读成「没有子代理」。
     */
    census() {
      const service = agents || unfenced(ctx, 'agents', ['list', 'get'])
      if (!service) return null
      return buildLineage(service.list())
    },
    /**
     * 全部存活 Agent 的原始读数。终端 pid 的列举按 owner 逐个进行，因此需要
     * Agent 对象本身而不是谱系投影。
     */
    listAgents() {
      const service = agents || unfenced(ctx, 'agents', ['list', 'get'])
      return service ? service.list() : null
    },
    /**
     * 读一个子会话的 `subagentTiming` 投影。读不到时返回 null，让调用方把这一
     * 行标成没有判定，而不是猜一个。
     */
    timing(childId, signal) {
      const reader = readTiming || unfencedTiming(ctx)
      return reader ? reader(childId, signal) : Promise.resolve(null)
    },
    /**
     * 释放一个父的若干直接子代。`parentId` 由本模块的谱系反查得出，调用方不
     * 接受请求体里的父会话；`drainChildren` 自己还会核对父必须是精确存活 Agent。
     */
    async release(parentId, childIds) {
      const service = agents || unfenced(ctx, 'agents', ['list', 'get'])
      if (!service) return { ok: false, code: 'lineage_unavailable' }
      const drain = subagents || unfenced(ctx, 'subagents', ['drainChildren'])
      if (!drain) return { ok: false, code: 'release_unavailable' }
      // 第一道防护：父必须是注册表里精确存活的 Agent 对象，而不是同名的字符串。
      // drainChildren 内部也做同样的核对，这里先做一次，让「父不存活」有一个
      // 不依赖抛错的答案。
      const parent = service.get(parentId)
      if (parent === undefined || parent === null) return { ok: false, code: 'parent_not_live' }
      try {
        await drain.drainChildren(parent, childIds)
      } catch (error) {
        // 谱系读数与释放之间存在真实的窗口：父会话可能在这中间离开注册表，或
        // 子代被别处释放。drainChildren 对这两种情况抛 `UNAUTHORIZED`，它是一个
        // 授权结论而不是宿主故障，因此回答一个可读的拒绝，不让它变成 500。
        if (error && error.code === 'UNAUTHORIZED') return { ok: false, code: 'parent_not_live' }
        throw error
      }
      return { ok: true, code: 'released' }
    }
  }
}

/** 服务对象与其全部公开方法；缺任何一个方法都算能力缺失。 */
function usable(service, methods) {
  if (!service) return null
  const bound = {}
  for (const name of methods) {
    if (typeof service[name] !== 'function') return null
    bound[name] = service[name].bind(service)
  }
  return bound
}

/**
 * `subagentTiming` 投影的读取。一次观察是一次租约，用完即释放；租约上的
 * `projections` 是这次读取的投影快照。
 *
 * 投影模式用宿主默认的 `'all'`：`'none'` 会让租约不带 `projections`，我们要读的
 * 正是宿主已经算好的那一份投影，而不是事件数组。取消信号随 options 传下去，因此
 * 关闭面板会真的停掉正在进行的冷读。
 */
function timingReader(query) {
  return async (childId, signal) => {
    let observation = null
    try {
      observation = await query.observeSession(childId, signal ? { signal } : {})
      const values = observation.projections && observation.projections.values
      const timing = values ? values.subagentTiming : null
      return timing && typeof timing === 'object' ? timing : null
    } catch {
      // 读不出来是一个事实，不是宿主故障：那一行因此不带判定。
      return null
    } finally {
      // 租约必须释放，否则这个子会话的观察会一直留在宿主的准备缓存里。
      if (observation && typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
    }
  }
}

/** 与 unfenced() 同样用途：精简上下文直接暴露服务对象，真实上下文会抛错。 */
function unfencedTiming(ctx) {
  try {
    const query = ctx.sessionQuery || (typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null)
    return query && typeof query.observeSession === 'function' ? timingReader(query) : null
  } catch {
    return null
  }
}

/**
 * 精简的测试上下文与没有注入围栏的宿主会直接暴露服务对象。真实的 DSH 上下文在
 * 围栏外读这个属性会抛错，那正是能力缺失的答案，因此接住它。
 */
function unfenced(ctx, name, methods) {
  try {
    const service = ctx[name] || (typeof ctx.get === 'function' ? ctx.get(name) : null)
    return usable(service, methods)
  } catch {
    return null
  }
}

/**
 * 一份 Agent 列表的谱系视图。
 *
 * @param {Array} agents - `ctx.agents.list()` 的返回值
 * @returns {{ rows: Array, byId: Map, childrenOf: Map, descendantsOf: (id) => Array }}
 */
export function buildLineage(agents) {
  const rows = []
  const byId = new Map()
  const childrenOf = new Map()

  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || typeof agent.id !== 'string' || !agent.id) continue
    const header = (agent.session && agent.session.header) || {}
    const row = {
      id: agent.id,
      // 只有 header 指名父会话且带 subagent origin 的 Agent 才持有它的父会话；
      // fork 共享 lineage 字段却没有 origin，因此不作为子代理行出现。
      parentId: typeof header.parentSession === 'string' && header.parentSession ? header.parentSession : null,
      origin: header.origin === 'subagent' ? 'subagent' : null,
      status: agent.status === 'running' ? 'running' : 'idle',
      depth: Number.isFinite(header.delegationDepth) ? header.delegationDepth : null
    }
    rows.push(row)
    byId.set(row.id, row)
    if (row.parentId === null || row.origin !== 'subagent') continue
    const siblings = childrenOf.get(row.parentId)
    if (siblings) siblings.push(row)
    else childrenOf.set(row.parentId, [row])
  }

  return {
    rows,
    byId,
    childrenOf,
    /** 某个根会话下的全部后代，任意深度；谱系按数据读取，成环的 header 只访问一次。 */
    descendantsOf(rootId) {
      const out = []
      const pending = [rootId]
      const visited = new Set()
      while (pending.length > 0) {
        const parentId = pending.shift()
        if (visited.has(parentId)) continue
        visited.add(parentId)
        for (const child of childrenOf.get(parentId) || []) {
          out.push(child)
          pending.push(child.id)
        }
      }
      return out
    }
  }
}

/**
 * 某个子代的父会话 id。父由谱系反查，不接受调用方提供：请求体里的 parentId 是
 * 攻击者可控的文本，而释放的授权边界是「这个精确存活 Agent 的直接子代」。
 *
 * @returns {string|null} 父会话 id；该子代不存在或不是子代理行时为 null。
 */
export function parentOf(lineage, childId) {
  if (!lineage || typeof childId !== 'string' || !childId) return null
  const row = lineage.byId.get(childId)
  if (!row || row.parentId === null || row.origin !== 'subagent') return null
  return row.parentId
}

/**
 * 第二道防护：`childId` 必须是该父的**直接**子代，用 agents 谱系核。
 *
 * 传孙代会跨过一层归属：它的父不是释放操作的授权者，而 `drainChildren` 对非直接
 * 子代抛 `UNAUTHORIZED`。这里先给出可读的答案，并且因此不接受任何来自请求的父。
 */
export function isDirectChild(lineage, parentId, childId) {
  if (!lineage || typeof parentId !== 'string' || !parentId || typeof childId !== 'string' || !childId) return false
  return (lineage.childrenOf.get(parentId) || []).some((row) => row.id === childId)
}