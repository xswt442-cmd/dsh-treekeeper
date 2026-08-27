// Ancestor-chain attribution: walk the live process table from a small set of
// known roots (the harness itself, its launch chain, user-registered pids)
// downward, so every reachable process is labeled with the nearest root and
// its depth. Whatever remains is the "unattributed bucket" — the whole point
// of the plugin: MCP servers, vision CLIs, leaked npx chains, other apps.
//
// Pure functions over a snapshot; no OS access here (easy to unit test with
// fixtures). PID reuse and dead parents are handled by callers via creation
// times; this module only trusts the ppid graph it is handed.

/**
 * Build `pid -> node` and `pid -> [child pids]` indexes.
 * Cycles (should not exist in a process table, but cost nothing to defuse)
 * are broken by the visited set in attribute().
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
 * Attribute every process to its nearest known root.
 *
 * @param {Array} procs - snapshot rows ({pid, ppid, name, cmdline, createdMs, wsBytes})
 * @param {Map<number,string>|Object} roots - pid -> root label (e.g. `{ 4242: 'harness' }`)
 * @param {Object} [hints] - optional extra attribution hints
 * @param {(cmdline: string) => {plugin: string, viaNpx: boolean} | null} [hints.pluginHint]
 * @returns {{ attributed: Map<number, {rootId:number, rootLabel:string, depth:number, pluginHint:object|null}>, unknown: Array, byPid: Map, children: Map }}
 */
export function attribute(procs, roots, hints = {}) {
  const rootMap = roots instanceof Map ? roots : new Map(Object.entries(roots).map(([k, v]) => [Number(k), v]))
  const { byPid, children } = buildIndexes(procs)
  const attributed = new Map()

  // Multi-source BFS: nearest root wins (smallest depth), ties broken by
  // smaller root pid so results are stable.
  let frontier = []
  for (const [pid, label] of rootMap) {
    if (!byPid.has(pid)) continue // root itself gone; keep going with the rest
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
 * Collect the full OS tree of one pid (itself + every descendant), for the
 * confirm dialog of a tree kill. Returns rows in kill-safe order (parents
 * before children is irrelevant for taskkill /T, but stable output helps UI).
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
