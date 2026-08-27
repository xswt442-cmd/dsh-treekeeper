// Root and protection-chain helpers. Ancestors protect the host from a
// destructive action; only the host itself is an attribution root.

export function findAncestorPids(procs, startPid) {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
  const ancestors = new Set()
  let currentPid = Number(startPid)

  while (currentPid > 0) {
    const current = byPid.get(currentPid)
    if (!current || !current.ppid || ancestors.has(current.ppid)) break
    ancestors.add(current.ppid)
    currentPid = current.ppid
  }

  return ancestors
}

export function processRows(procs, attribution) {
  return procs.map((proc) => ({
    ...proc,
    attribution: attribution.attributed.get(proc.pid) || null,
    evidence: attribution.attributed.has(proc.pid) ? 'exact' : 'unattributed'
  }))
}
