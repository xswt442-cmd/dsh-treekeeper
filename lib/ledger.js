// 账本适配器：任务注册表与子代理谱系。服务未挂载时每个访问器都返回 `null`/`[]`：
// 没有账本，操作系统侧仍要能工作；反过来则不行。

/** 列出一份任务快照，范围是当前存活 Agent 能看到的全部任务。 */
export function listJobs(ctx) {
  try {
    const jobs = ctx.jobs || (typeof ctx.get === 'function' ? ctx.get('jobs') : null)
    if (!jobs || typeof jobs.list !== 'function') return null
    const agents = ctx.agents || (typeof ctx.get === 'function' ? ctx.get('agents') : null)
    const callers = [undefined]
    if (agents && typeof agents.list === 'function') callers.push(...agents.list())

    // jobs.list(owner) 是公开的归属边界。按 owner 查询的结果都会重复带上无主
    // 任务，所以按稳定的任务 id 去重，同时保留注册表首次出现的顺序。
    const visible = new Map()
    for (const caller of callers) {
      const raw = jobs.list(caller)
      const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.jobs) ? raw.jobs : null)
      if (!rows) return null
      for (const job of rows) if (!visible.has(job.id)) visible.set(job.id, job)
    }
    return Array.from(visible.values()).map((j) => ({
      id: j.id,
      kind: j.kind,
      label: j.label,
      ownerSession: j.ownerSession ?? null,
      status: j.status,
      detail: j.detail ?? null,
      startedAt: j.startedAt ?? null,
      finishedAt: j.finishedAt ?? null
    }))
  } catch {
    return null
  }
}

/** 说明本宿主能枚举到账本的多少范围。 */
export function jobLedgerAvailability(ctx) {
  try {
    const jobs = ctx.jobs || (typeof ctx.get === 'function' ? ctx.get('jobs') : null)
    if (!jobs || typeof jobs.list !== 'function') return 'unavailable'
    const agents = ctx.agents || (typeof ctx.get === 'function' ? ctx.get('agents') : null)
    return agents && typeof agents.list === 'function' ? 'live-sessions' : 'unowned-only'
  } catch {
    return 'unavailable'
  }
}

/**
 * 通过注册表自己的变更通知让任务快照保持最新。没有动态注入能力的上下文改用
 * 请求时读取的适配器，测试与精简部署因此仍然可用。
 */
export function createJobLedger(ctx) {
  let generation = 0
  let current = null
  let availability = 'unavailable'

  if (typeof ctx.inject === 'function') {
    ctx.inject(['jobs', 'agents'], (scope) => {
      const mine = ++generation
      const refresh = () => {
        if (mine !== generation) return
        current = listJobs(scope)
        availability = jobLedgerAvailability(scope)
      }
      refresh()
      // 这个订阅挂在任务服务自己的上下文上，不在本作用域里，因此本作用域
      // 销毁时没有人会解除它。必须保存返回的解除函数并在 dispose 时调用，
      // 否则每次重载都会在任务服务上留下一个监听器；它虽然会因代数检查停止
      // 刷新，但仍会被每次注册表变化调用。
      const detach = typeof scope.jobs.onJobsChanged === 'function'
        ? scope.jobs.onJobsChanged(refresh)
        : null
      if (typeof scope.on === 'function') {
        scope.on('dispose', () => {
          if (mine !== generation) return
          generation += 1
          if (typeof detach === 'function') detach()
          current = null
          availability = 'unavailable'
        })
      }
    })
  }

  return {
    list() { return current === null ? listJobs(ctx) : current.map(row => ({ ...row })) },
    availability() {
      return current === null ? jobLedgerAvailability(ctx) : availability
    }
  }
}

/**
 * 在注入围栏内捕获可选的子代理注册表。在注入之外读取 `ctx.subagents` 时
 * DSH 会主动抛错；这里只保留绑定好的公开方法，请求处理函数因此不必待在这个
 * 围栏里，缺少该能力的宿主也照常降级。
 */
export function createSubagentTree(ctx) {
  let generation = 0
  let listDescendants = null

  if (typeof ctx.inject === 'function') {
    ctx.inject(['subagents'], (scope) => {
      const mine = ++generation
      listDescendants = typeof scope.subagents.listDescendants === 'function'
        ? scope.subagents.listDescendants.bind(scope.subagents)
        : null
      if (typeof scope.on === 'function') {
        scope.on('dispose', () => {
          if (mine !== generation) return
          generation += 1
          listDescendants = null
        })
      }
    })
  }

  return {
    async list(rootSessionId, signal) {
      if (!rootSessionId) return []
      if (listDescendants) return callListDescendants(listDescendants, rootSessionId)
      // 精简的测试上下文与没有注入围栏的宿主会直接暴露服务对象；适配器会
      // 接住“在围栏外读取服务属性”时抛出的错误。
      return listSubagentTree(ctx, rootSessionId, signal)
    }
  }
}

/**
 * 指定根会话下方的完整后代树。挂载的 DSH 服务不可用时返回 null；
 * 调用方必须把这份“不可用”如实呈现出来。
 */
export async function listSubagentTree(ctx, rootSessionId, signal) {
  if (!rootSessionId) return []
  try {
    const subagents = ctx.subagents || (typeof ctx.get === 'function' ? ctx.get('subagents') : null)
    if (!subagents || typeof subagents.listDescendants !== 'function') return null
    return await callListDescendants(subagents.listDescendants.bind(subagents), rootSessionId, signal)
  } catch (error) {
    if (signal && signal.aborted) throw error
    return null
  }
}

async function callListDescendants(listDescendants, rootSessionId, signal) {
  try {
    return await listDescendants(rootSessionId, signal)
  } catch (error) {
    if (signal && signal.aborted) throw error
    return null
  }
}
