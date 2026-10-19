// 祖先链归因：从少量已知根（宿主自身、用户登记的 pid）沿进程表向下遍历，
// 让每个可达进程带上最近的根与深度；剩下的部分就是“未归属”集合，插件报告的
// 泄漏与孤儿进程主要来自这里：MCP 服务、npx 缓存链、其他应用。
//
// 这里的函数只处理传入的快照，不访问操作系统，因此可以直接用固定数据做单元
// 测试。本模块只信任拿到的 ppid 图；pid 复用与父进程消失由调用方处理。

/**
 * 建立 `pid -> 进程` 与 `pid -> 子进程 pid 列表` 两个索引。
 * 进程表里不应出现环；attribute() 的已访问集合保证遇到环时仍然终止。
 */
export function buildIndexes(procs) {
  const byPid = new Map()
  const children = new Map()
  for (const p of procs) {
    byPid.set(p.pid, p)
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p.pid)
  }
  return { byPid, children }
}

/**
 * 把每个进程归到最近的已知根。
 *
 * @param {Array} procs - 快照行（{pid, ppid, name, cmdline, createdMs, wsBytes}）
 * @param {Map<number,string>|Object} roots - pid -> 根标签（例如 `{ 4242: 'harness' }`）
 * @param {Object} [hints] - 可选的额外归因提示
 * @param {(cmdline: string) => {plugin: string, viaNpx: boolean} | null} [hints.pluginHint]
 * @returns {{ attributed: Map<number, {rootId:number, rootLabel:string, depth:number, pluginHint:object|null}>, unknown: Array, byPid: Map, children: Map }}
 */
export function attribute(procs, roots, hints = {}) {
  const rootMap = roots instanceof Map ? roots : new Map(Object.entries(roots).map(([k, v]) => [Number(k), v]))
  const { byPid, children } = buildIndexes(procs)
  const attributed = new Map()

  // 多源广度优先：距离最近的根获胜；同一距离由 roots 的插入顺序决定，
  // 因此同一份输入总得到同一份结果。
  let frontier = []
  for (const [pid, label] of rootMap) {
    if (!byPid.has(pid)) continue // 根本身已不在快照里，跳过它继续处理其他根
    attributed.set(pid, { rootId: pid, rootLabel: label, depth: 0, pluginHint: hints.pluginHint ? hints.pluginHint(byPid.get(pid).cmdline) : null })
    frontier.push(pid)
  }
  while (frontier.length > 0) {
    const next = []
    for (const pid of frontier) {
      const info = attributed.get(pid)
      for (const childPid of children.get(pid) || []) {
        if (attributed.has(childPid)) continue
        const node = byPid.get(childPid)
        attributed.set(childPid, {
          rootId: info.rootId,
          rootLabel: info.rootLabel,
          depth: info.depth + 1,
          pluginHint: hints.pluginHint ? hints.pluginHint(node.cmdline) : null
        })
        next.push(childPid)
      }
    }
    frontier = next
  }

  const unknown = []
  for (const p of procs) {
    if (!attributed.has(p.pid)) unknown.push(p)
  }
  return { attributed, unknown, byPid, children }
}

/**
 * 收集一个 pid 的完整进程树（自身与全部后代），供树杀前的确认界面使用。
 * 输出按“父先子后”的遍历顺序，结果稳定便于渲染；`taskkill /T` 本身不依赖
 * 这个顺序。
 */
export function subtreeOf(procs, rootPid) {
  const { byPid, children } = buildIndexes(procs)
  const out = []
  const seen = new Set()
  const walk = (pid) => {
    if (seen.has(pid)) return
    seen.add(pid)
    const node = byPid.get(pid)
    if (node) out.push(node)
    for (const c of children.get(pid) || []) walk(c)
  }
  walk(Number(rootPid))
  return out
}
