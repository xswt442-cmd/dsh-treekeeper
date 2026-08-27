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
    const jobs = ctx.jobs || (typeof ctx.get === 'function' ? ctx.get('jobs') : null)
    if (!jobs || typeof jobs.list !== 'function') return null
    // `list()` is an implementation extension, not part of the public jobs
    // seam. In dsh-jobs-local, an unscoped caller sees unowned jobs only.
    // Treat the result as limited local evidence, never a cross-session view.
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
 * Full descendant tree below an explicit root session. Returns null when the
 * mounted DSH seam is unavailable; callers must render that absence directly.
 */
export async function listSubagentTree(ctx, rootSessionId) {
  if (!rootSessionId) return []
  const subagents = ctx.subagents || (typeof ctx.get === 'function' ? ctx.get('subagents') : null)
  if (!subagents || typeof subagents.listDescendants !== 'function') return null
  try {
    return await subagents.listDescendants(rootSessionId)
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
