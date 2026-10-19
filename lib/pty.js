// 终端会话的精确 pid 锚点。
//
// reconcile.js 用任务 label 与进程 cmdline 做双向 includes 匹配，因此只能诚实标
// 成 `indicative`。它同时在误报：终端里跑的长任务（dev server、watcher、
// `npm install`）在操作系统树上就是长驻进程，会命中 `longlived.plugin-child`，
// 而它其实正被一个活着的 PTY 合法拥有着。
//
// 精确锚点存在：`ctx.terminals.list(owner)` 返回的快照带 `pid`——这是 DSH 愿意把
// pid 交给插件的唯一一处。本模块把这些 pid 读成一组归因根，让 reconcile 与归因
// 都能精确地回答「这个进程属于哪个终端会话」。
//
// 服务未挂载时返回 null：宿主不提供终端会话清单，其余部分照常工作。

/**
 * 在注入围栏内捕获 terminals 服务。`list` 收的是精确存活的 Agent 对象，因此调用
 * 方必须提供父会话的 Agent，不能只给一个 id。
 */
export function createTerminalIndex(ctx) {
  let generation = 0
  let terminals = null

  if (typeof ctx.inject === 'function') {
    ctx.inject(['terminals'], (scope) => {
      const mine = ++generation
      terminals = scope.terminals && typeof scope.terminals.list === 'function'
        ? { list: scope.terminals.list.bind(scope.terminals) }
        : null
      if (typeof scope.on === 'function') {
        scope.on('dispose', () => {
          if (mine !== generation) return
          generation += 1
          terminals = null
        })
      }
    })
  }

  return {
    /**
     * 全部存活 Agent 拥有的终端会话 pid。
     *
     * @param {() => Array|null} listAgents - agents.list() 的读数；null 时没有谱系可查。
     * @returns {{ pids: Map<number, {sessionId: string, ownerId: string}>, sessions: number } | null}
     *   null 表示本宿主不提供终端会话清单。
     */
    read(listAgents) {
      const service = terminals || unfencedTerminals(ctx)
      const agents = typeof listAgents === 'function' ? listAgents() : null
      if (!service || !Array.isArray(agents)) return null
      const pids = new Map()
      let sessions = 0
      for (const agent of agents) {
        if (!agent || typeof agent.id !== 'string' || !agent.id) continue
        let snapshots
        try {
          snapshots = service.list(agent)
        } catch {
          // 单一 owner 的列举失败不掩盖其余会话：这个宿主在这一项上读不到就跳过。
          continue
        }
        if (!Array.isArray(snapshots)) continue
        for (const snapshot of snapshots) {
          if (!snapshot || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0) continue
          sessions += 1
          // 同一个 pid 只记一次：第一个拥有它的会话就是它的所有者。
          if (pids.has(snapshot.pid)) continue
          pids.set(snapshot.pid, {
            sessionId: typeof snapshot.sessionId === 'string' ? snapshot.sessionId : null,
            ownerId: agent.id
          })
        }
      }
      return { pids, sessions }
    }
  }
}

/** 与 createAgentLineage 的 unfenced() 同样用途：真实上下文在围栏外读会抛错。 */
function unfencedTerminals(ctx) {
  try {
    const service = ctx.terminals || (typeof ctx.get === 'function' ? ctx.get('terminals') : null)
    return service && typeof service.list === 'function' ? { list: service.list.bind(service) } : null
  } catch {
    return null
  }
}

/**
 * 把终端 pid 变成归因根：pid -> 'pty'。`attribute()` 已支持多根，距离最近的根
 * 获胜，因此整棵后代子树都会带上 `rootLabel: 'pty'`——只标 pty 自己那一行是不够的，
 * 终端里跑起来的进程都在它下面。
 *
 * @param {{pids: Map<number, object>}|null} index - createTerminalIndex().read() 的输出
 * @returns {Map<number, string>} 空的 Map 表示本宿主不提供终端会话清单
 */
export function ptyRoots(index) {
  const roots = new Map()
  if (!index || !(index.pids instanceof Map)) return roots
  for (const pid of index.pids.keys()) roots.set(pid, 'pty')
  return roots
}

/**
 * 精确 join：一个 pid 是否就是某个活着的终端会话的顶层进程。
 *
 * 与 label 匹配的差别在于证据：label 匹配是「两条命令行文本互相包含」，而这里
 * 是 DSH 自己报告的 pid相等。因此命中它的行不再标 `indicative`。
 */
export function ptyOwnerOf(index, pid) {
  if (!index || !(index.pids instanceof Map)) return null
  return index.pids.get(Number(pid)) || null
}