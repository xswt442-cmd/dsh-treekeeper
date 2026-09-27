// Windows-first process sampler for the host half.
//
// Primary: one CIM query per tick (Get-CimInstance Win32_Process) executed as
// a short-lived powershell child. The plugin runs inside the harness host
// process (NOT under the tool sandbox's restricted token), where CIM reads
// are expected to work; if the query fails the sampler degrades to
// `tasklist /fo csv /nh` (names + pids + memory only, NO ppid) and marks
// every snapshot `degraded: 'no-ppid'` so the UI can say attribution is
// disabled rather than silently lying.
//
// Every kill gate in lib/act.js trusts this module's `degraded` flag, so the
// flag is the security-relevant output, not the process list. The seams below
// (`deps.runExec`, `deps.platform`, `deps.now`) exist so a test can feed real
// PowerShell and tasklist output, a failing command, and an advancing clock
// without a Windows machine or an 8-second wait: a consumer can only be
// verified by testing the producer.

import { execFile } from 'node:child_process'
import { parseCimDate } from './shared.js'

const CIM_SCRIPT =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize | ' +
  'ConvertTo-Json -Compress -Depth 3'

/**
 * One wall-clock budget per sample, shared by the CIM phase and its fallback —
 * and the budget is what a phase may start with, not what the sample may total:
 * `MIN_PHASE_TIMEOUT_MS` keeps the fallback usable, so the worst case is the
 * budget plus that floor.
 */
export const SAMPLE_TIMEOUT_MS = 8000
/**
 * A phase is never starved below this. Without the floor a CIM call that used
 * up the whole budget would leave the degraded fallback no time at all, and the
 * sample would report total failure instead of the usable no-ppid snapshot.
 * Paying it can run the sample past `SAMPLE_TIMEOUT_MS`, which is the trade.
 */
export const MIN_PHASE_TIMEOUT_MS = 1000
/** What a tasklist-only snapshot is marked with; every gate reads this. */
export const DEGRADED_NO_PPID = 'no-ppid'
/**
 * The stable code the non-Windows branch reports with. The route answers with
 * this code, so "this platform is not implemented" is legible without shipping
 * the raw message to a caller.
 */
export const SAMPLER_UNSUPPORTED_PLATFORM = 'unsupported_platform'

const defaultRunExec = (cmd, args, options) => new Promise((resolve, reject) => {
  execFile(cmd, args, options, (err, stdout) => {
    if (err) reject(err)
    else resolve(stdout)
  })
})

const DEFAULT_DEPS = {
  runExec: defaultRunExec,
  platform: () => process.platform,
  now: () => Date.now()
}

const resolveDeps = (deps = {}) => ({ ...DEFAULT_DEPS, ...deps })

/**
 * The part of the sample budget still available to this phase: what the deadline
 * leaves, or the whole budget when the caller supplied no deadline, and never
 * less than the floor.
 */
function phaseTimeout(deadline, deps, timeoutMs) {
  const now = deps.now()
  const floor = Math.min(MIN_PHASE_TIMEOUT_MS, timeoutMs)
  return Math.max(floor, (deadline ?? (now + timeoutMs)) - now)
}

/** CIM rows -> proc records. Rows the contract cannot vouch for are dropped, not guessed. */
export function toProc(row) {
  if (!row || typeof row !== 'object') return null
  const pid = Number(row.ProcessId)
  const ppid = Number(row.ParentProcessId)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return {
    pid,
    ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
    name: String(row.Name || '').replace(/\.exe$/i, ''),
    cmdline: typeof row.CommandLine === 'string' ? row.CommandLine : '',
    createdMs: parseCimDate(row.CreationDate),
    wsBytes: Number(row.WorkingSetSize) || 0
  }
}

/**
 * Parse a `ConvertTo-Json -Compress` reply. One process serializes as an object
 * rather than an array, so both shapes are accepted; an empty reply is an empty
 * list, and a truncated or malformed reply throws so the caller degrades rather
 * than presenting half a process tree as the whole machine.
 */
export function parseCimRows(stdout) {
  if (!stdout || !stdout.trim()) return []
  const parsed = JSON.parse(stdout)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const out = []
  for (const row of rows) {
    const proc = toProc(row)
    if (proc) out.push(proc)
  }
  return out
}

/**
 * Parse `tasklist /fo csv /nh`. The five quoted columns are the documented
 * default layout (Image Name, PID, Session Name, Session#, Mem Usage); a line
 * that does not match is not a process row — a header, a wrapped continuation,
 * or a truncated tail — and is skipped rather than turned into a partial record.
 */
export function parseTasklistRows(stdout) {
  const out = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const cols = /^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/.exec(line)
    if (!cols) continue
    const pid = Number(cols[2])
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({
      pid,
      ppid: 0,
      name: cols[1].replace(/\.exe$/i, ''),
      cmdline: '',
      createdMs: null,
      wsBytes: parseKb(cols[3])
    })
  }
  return out
}

function parseKb(text) {
  const m = /([\d,]+)\s*K/.exec(String(text || '').replace(/"/g, ''))
  return m ? Number(m[1].replace(/,/g, '')) * 1024 : 0
}

/** Full-fidelity CIM sample: pids with parent links, cmdline, birth, memory. */
export async function sampleWindowsCim({ timeoutMs = SAMPLE_TIMEOUT_MS, deps = {}, deadline } = {}) {
  const d = resolveDeps(deps)
  const stdout = await d.runExec('powershell.exe', ['-NoProfile', '-Command', CIM_SCRIPT], {
    windowsHide: true,
    timeout: phaseTimeout(deadline, d, timeoutMs),
    maxBuffer: 32 * 1024 * 1024
  })
  return parseCimRows(stdout)
}

/** Degraded sample: tasklist has no ppid and no cmdline. */
export async function sampleWindowsTasklist({ timeoutMs = SAMPLE_TIMEOUT_MS, deps = {}, deadline } = {}) {
  const d = resolveDeps(deps)
  const stdout = await d.runExec('tasklist', ['/fo', 'csv', '/nh'], {
    windowsHide: true,
    timeout: phaseTimeout(deadline, d, timeoutMs),
    maxBuffer: 16 * 1024 * 1024
  })
  return parseTasklistRows(stdout)
}

/** The non-Windows verdict: an explicit, coded "not implemented", never a guess. */
function unsupportedPlatformError(platform) {
  const error = new Error(`treekeeper: only Windows sampling is implemented in this skeleton (saw platform ${platform})`)
  error.code = SAMPLER_UNSUPPORTED_PLATFORM
  return error
}

/**
 * One platform snapshot. Resolves to `{ procs, degraded }`.
 * On non-Windows this rejects with `SAMPLER_UNSUPPORTED_PLATFORM` up to the
 * caller, which surfaces a setup message instead of pretending to work.
 */
export async function sample({ timeoutMs = SAMPLE_TIMEOUT_MS, deps = {} } = {}) {
  const d = resolveDeps(deps)
  const platform = d.platform()
  if (platform !== 'win32') throw unsupportedPlatformError(platform)
  const deadline = d.now() + timeoutMs
  try {
    const procs = await sampleWindowsCim({ timeoutMs, deps: d, deadline })
    // A live Windows machine never samples zero processes. An empty CIM reply
    // is a truncated or filtered read, not a quiet machine, so it must not
    // present as a healthy sample: fall through to the degraded tasklist path,
    // where the panel shows the degradation and the kill gate stays refused.
    if (!procs.length) throw new Error('CIM returned no processes')
    return { procs, degraded: null }
  } catch (cimErr) {
    try {
      return { procs: await sampleWindowsTasklist({ timeoutMs, deps: d, deadline }), degraded: DEGRADED_NO_PPID, cimError: String(cimErr && cimErr.message || cimErr) }
    } catch (tlErr) {
      throw new Error('treekeeper: both CIM and tasklist sampling failed: ' + String(tlErr && tlErr.message || tlErr))
    }
  }
}
