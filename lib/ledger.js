// Layer 1 ledger adapters: the official jobs registry and the subagent
// genealogy. Every accessor degrades to `null`/`[]` when the seam is not
// mounted — Layer 2 must work without Layer 1, never the reverse.

/** Snapshot every job visible to the host's currently live Agents. */
export function listJobs(ctx) {
  try {
    const jobs = ctx.jobs || (typeof ctx.get === 'function' ? ctx.get('jobs') : null)
    if (!jobs || typeof jobs.list !== 'function') return null
    const agents = ctx.agents || (typeof ctx.get === 'function' ? ctx.get('agents') : null)
    const callers = [undefined]
    if (agents && typeof agents.list === 'function') callers.push(...agents.list())

    // jobs.list(owner) is the public ownership fence. Every owner-relative
    // result repeats unowned jobs, so retain the registry's first-seen order
    // while deduplicating by its stable job id.
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

/** Describe how much of the owner-fenced registry this host can enumerate. */
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
 * Keep an owner-aware job snapshot current through the registry's official
 * replacement notification. Contexts without dynamic injection retain the
 * request-time adapter, which keeps tests and reduced deployments useful.
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
      if (typeof scope.jobs.onJobsChanged === 'function') scope.jobs.onJobsChanged(refresh)
      if (typeof scope.on === 'function') {
        scope.on('dispose', () => {
          if (mine !== generation) return
          generation += 1
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
