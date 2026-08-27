// Layer 1 ledger adapters: the official jobs registry and the subagent
// genealogy. Every accessor degrades to `null`/`[]` when the seam is not
// mounted — Layer 2 must work without Layer 1, never the reverse.

/**
 * Snapshot the background-job registry across ALL owners (the client-ui-jobs
 * panel only shows the current session's; that gap is ours).
 * Tolerant on purpose: the registry service is `ctx.get('jobs')` and its
 * list() surface is not versioned.
 */
export function listJobs(ctx) {
  try {
    const jobs = ctx.get('jobs')
    if (!jobs || typeof jobs.list !== 'function') return null
    // Unowned jobs change every caller's visible set, so list() without an
    // owner is the cross-session view we want. Tolerate either array return
    // or { jobs } shapes from future versions.
    const raw = jobs.list()
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.jobs) ? raw.jobs : null)
    if (!arr) return null
    return arr.map((j) => ({
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

/**
 * Resolve the subagent genealogy module lazily from the harness's own
 * dependency tree. The plugin does not declare @deepseek-ai/dsh-subagent as
 * a dependency on purpose (it is a host package); resolve it from wherever
 * the running harness loads its own deps, and degrade when unavailable.
 */
export async function loadSubagentModule(ctx) {
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const require = createRequire(pathToFileURL(process.execPath))
    try {
      return await import(require.resolve('@deepseek-ai/dsh-subagent'))
    } catch {
      // Fall back to resolving relative to the dsh entry currently running.
      const dshDir = resolveDshDir()
      if (dshDir) {
        const require2 = createRequire(pathToFileURL(dshDir))
        return await import(require2.resolve('@deepseek-ai/dsh-subagent'))
      }
      return null
    }
  } catch {
    return null
  }
  function resolveDshDir() {
    try {
      const home = process.env.DSH_HOME || ''
      const candidates = home
        ? [`${home}/profiles/node_modules/@deepseek-ai/dsh/package.json`]
        : []
      // Also try the global npm layout that `npm i -g` produces.
      if (process.env.APPDATA) candidates.push(`${process.env.APPDATA}/npm/node_modules/@deepseek-ai/dsh/package.json`)
      for (const c of candidates) {
        // createRequire from the package.json path resolves the package's own deps.
        if (import.meta.url) return c
      }
      return null
    } catch {
      return null
    }
  }
}

/**
 * Full descendant tree below the current session (or a chosen root).
 * Returns [] when the seam is unavailable — callers render "账本缺席",
 * never a fake tree.
 */
export async function listSubagentTree(ctx, rootSessionId) {
  if (!rootSessionId) return []
  const mod = await loadSubagentModule(ctx)
  if (!mod || typeof mod.listDescendants !== 'function') return null
  try {
    return await mod.listDescendants(ctx, rootSessionId)
  } catch {
    return null
  }
}

/** Interrupt a continuable subagent through the official control surface, if present. */
export async function interruptSubagent(ctx, agentId) {
  try {
    const mod = await import('@deepseek-ai/dsh-tool-subagent-control').catch(() => null)
    if (mod && typeof mod.interruptAgent === 'function') {
      return mod.interruptAgent(ctx, agentId)
    }
    return { ok: false, code: 'unavailable' }
  } catch (e) {
    return { ok: false, code: 'error', error: String(e) }
  }
}
