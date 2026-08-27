// Windows-first process sampler for the host half.
//
// Primary: one CIM query per tick (Get-CimInstance Win32_Process) executed as
// a short-lived powershell child. The plugin runs inside the harness host
// process (NOT under the tool sandbox's restricted token), where CIM reads
// are expected to work; if the query fails the sampler degrades to
// `tasklist /fo csv /nh` (names + pids + memory only, NO ppid) and marks
// every snapshot `degraded: 'no-ppid'` so the UI can say attribution is
// disabled rather than silently lying.

import { execFile } from 'node:child_process'
import { parseCimDate } from './shared.js'

const CIM_SCRIPT =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize | ' +
  'ConvertTo-Json -Compress -Depth 3'

function execJson(timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', CIM_SCRIPT], { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function execTasklist(timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function toProc(row) {
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

/** Full-fidelity CIM sample: pids with parent links, cmdline, birth, memory. */
export async function sampleWindowsCim({ timeoutMs = 8000 } = {}) {
  const stdout = await execJson(timeoutMs)
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

/** Degraded sample: tasklist has no ppid and no cmdline. */
export async function sampleWindowsTasklist({ timeoutMs = 8000 } = {}) {
  const stdout = await execTasklist(timeoutMs)
  const out = []
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.match(/^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/)
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

/**
 * One platform snapshot. Resolves to `{ procs, degraded }`.
 * On non-Windows this skeleton throws up to the caller, which surfaces a
 * setup message instead of pretending to work.
 */
export async function sample({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('treekeeper: only Windows sampling is implemented in this skeleton')
  }
  try {
    return { procs: await sampleWindowsCim({ timeoutMs }), degraded: null }
  } catch (cimErr) {
    try {
      return { procs: await sampleWindowsTasklist({ timeoutMs }), degraded: 'no-ppid', cimError: String(cimErr && cimErr.message || cimErr) }
    } catch (tlErr) {
      throw new Error('treekeeper: both CIM and tasklist sampling failed: ' + String(tlErr && tlErr.message || tlErr))
    }
  }
}
