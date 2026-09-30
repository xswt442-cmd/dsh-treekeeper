// The producer of `snapshot.degraded` — the flag every kill gate trusts
// (lib/act.js decideKillEntry / decideKillConfirm, and the leak confidence rule).
// A consumer can only believe that flag, so the sampler is tested here against
// real PowerShell and tasklist output, through the seams in lib/sampler.js:
// `deps.runExec` feeds a reply, `deps.platform` stands on either side of the
// Windows gate, `deps.now` is a clock the test advances so a timeout budget can
// be asserted without ever waiting for one.
//
// Nothing in this file spawns a process or needs Windows.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  sample, sampleWindowsCim, sampleWindowsTasklist,
  parseCimRows, parseTasklistRows, toProc,
  SAMPLE_TIMEOUT_MS, MIN_PHASE_TIMEOUT_MS, DEGRADED_NO_PPID, SAMPLER_UNSUPPORTED_PLATFORM
} from '../lib/sampler.js'

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const CIM_FIXTURE = fixture('cim-processes.json')
const CIM_SINGLE_FIXTURE = fixture('cim-single-process.json')
const CIM_TRUNCATED_FIXTURE = fixture('cim-truncated.json')
// Windows PowerShell 5.1's `ConvertTo-Json`, which is what this plugin's
// `powershell.exe` child runs: the same query, the escaped `\/Date(ms)\/` form.
const CIM_PS51_FIXTURE = fixture('cim-processes-ps51.json')
const TASKLIST_FIXTURE = fixture('tasklist-normal.txt')
const TASKLIST_TRUNCATED_FIXTURE = fixture('tasklist-truncated.txt')

const EPOCH = 1780000000000

/**
 * Fake OS boundary: records every command, reply, and timeout option, and moves
 * the injected clock by the configured amount so a shared budget can be observed.
 */
function harness({ cim = '', tasklist = '', spends = {}, platform = 'win32' } = {}) {
  const calls = []
  const clock = { t: EPOCH }
  const runExec = async (cmd, args, options) => {
    const phase = cmd === 'tasklist' ? 'tasklist' : 'cim'
    calls.push({ phase, cmd, args, options })
    clock.t += spends[phase] ?? 0
    const reply = phase === 'cim' ? cim : tasklist
    if (reply instanceof Error) throw reply
    return reply
  }
  return { calls, clock, deps: { runExec, platform: () => platform, now: () => clock.t } }
}

const timeoutError = (message = 'spawn powershell.exe ETIMEDOUT') =>
  Object.assign(new Error(message), { code: 'ETIMEDOUT' })

const commandError = (message = 'spawnSync tasklist ENOENT') =>
  Object.assign(new Error(message), { code: 'ENOENT' })

test('a real CIM reply becomes full-fidelity rows, and the sample is not degraded', async () => {
  const os = harness({ cim: CIM_FIXTURE })
  const { procs, degraded, cimError } = await sample({ deps: os.deps })

  assert.equal(degraded, null, 'a CIM sample is the healthy path')
  assert.equal(cimError, undefined)
  // `System Idle Process` is pid 0: not a tree node, so it is dropped rather than
  // becoming a parent every orphan can point at.
  assert.ok(!procs.some((p) => p.pid === 0))
  assert.deepEqual(procs.map((p) => p.pid), [4, 2784, 19000, 18432, 20144, 21008, 21100])

  const svchost = procs.find((p) => p.pid === 2784)
  assert.deepEqual(svchost, {
    pid: 2784,
    ppid: 552,
    // `.exe` is stripped once, here, so every consumer compares bare names.
    name: 'svchost',
    // Access-denied rows come back with a null CommandLine: absence is '' and
    // never a guess.
    cmdline: '',
    createdMs: Date.parse('2026-08-25T09:14:07.1234567+08:00'),
    wsBytes: 12656640
  })

  // The host itself: the ISO form PowerShell serializes, and the raw CIM string
  // form `20260825162958.5+480` that `parseCimDate` documents, both land on the
  // same epoch ms — the kill gate compares those numbers for identity.
  const launcher = procs.find((p) => p.pid === 19000)
  assert.equal(launcher.createdMs, Date.UTC(2026, 7, 25, 8, 29, 58, 500))
  const node = procs.find((p) => p.pid === 18432)
  assert.equal(node.createdMs, Date.parse('2026-08-25T16:29:59.2500000+08:00'))
  assert.match(node.cmdline, /@deepseek-ai\\dsh\\lib\\bin\.js/)
  // A row whose CreationDate is missing has no identity to verify, which the
  // gates read as "not killable", never as "matches".
  assert.equal(procs.find((p) => p.pid === 21100).createdMs, null)
  assert.equal(procs.find((p) => p.pid === 4).createdMs, Date.parse('2026-08-25T09:14:02.0000000+08:00'))

  // One CIM query per tick, and only one: the fallback is for failures.
  assert.deepEqual(os.calls.map((c) => c.phase), ['cim'])
})

test('the CIM call is the documented hidden powershell child with the full budget', async () => {
  const os = harness({ cim: CIM_FIXTURE })
  await sample({ deps: os.deps })

  const [call] = os.calls
  assert.equal(call.cmd, 'powershell.exe')
  assert.deepEqual(call.args.slice(0, 2), ['-NoProfile', '-Command'])
  assert.match(call.args[2], /^Get-CimInstance Win32_Process \| /)
  assert.match(call.args[2], /ConvertTo-Json -Compress -Depth 3$/)
  assert.equal(call.options.windowsHide, true, 'a visible PowerShell window on every poll is a regression')
  assert.equal(call.options.timeout, SAMPLE_TIMEOUT_MS)
  assert.equal(call.options.maxBuffer, 32 * 1024 * 1024)
})

test('a single-process CIM reply is an object, not an array, and still parses', async () => {
  const rows = parseCimRows(CIM_SINGLE_FIXTURE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 18432)
  assert.equal(rows[0].ppid, 19000)
})

// The kill path compares a process's creation time against a freshly sampled
// one, and it refuses to arm without that identity. Windows PowerShell 5.1 —
// the `powershell.exe` this plugin always spawns — serializes every CIM
// datetime as `\/Date(ms)\/` rather than the ISO string PowerShell 7 produces,
// and reading that as "no identity" left every row without a creation time:
// no kill button, no long-lived rule. This fixture is the escaped reply itself.
test('a Windows PowerShell 5.1 reply keeps creation times, so a snapshot stays actionable', async () => {
  const os = harness({ cim: CIM_PS51_FIXTURE })
  const { procs, degraded } = await sample({ deps: os.deps })

  assert.equal(degraded, null, 'the escaped .NET date form is not a degraded sample')
  assert.ok(CIM_PS51_FIXTURE.includes('\\/Date(1790745392422)\\/'), 'the fixture must stay in the form 5.1 emits')

  const byPid = new Map(procs.map((p) => [p.pid, p]))
  // The desktop host and its Electron parent both arrive as `/Date(ms)/`.
  assert.equal(byPid.get(37224).createdMs, 1790745392422)
  assert.equal(byPid.get(40376).createdMs, 1790745000000)
  assert.equal(byPid.get(38888).createdMs, 1790745123456)
  assert.equal(byPid.get(99001).createdMs, 1790745600000)
  assert.equal(byPid.get(37224).name, 'DeepSeek Harness', '.exe is stripped here too')
  // The assertion the defect needs: a real snapshot has at least one dated row,
  // so the kill button and the long-lived rule have something to work from.
  assert.ok(procs.some((p) => Number.isFinite(p.createdMs)), 'a real snapshot dates at least one process')
  // The two ways a creation time legitimately stays unknown, and neither may be
  // rounded into a number: an absent property, and the .NET floor that a
  // refused property carries. The floor must not read as 1601.
  assert.equal(byPid.get(21100).createdMs, null)
  assert.equal(byPid.get(20144).createdMs, null, 'the .NET DateTime floor is not a creation time')
})

test('rows the contract cannot vouch for are dropped, not guessed', () => {
  assert.equal(toProc(null), null)
  assert.equal(toProc('2784'), null)
  assert.equal(toProc({ ProcessId: 0, ParentProcessId: 4 }), null, 'pid 0 is not a node')
  assert.equal(toProc({ ProcessId: 'abc', ParentProcessId: 4 }), null)
  assert.equal(toProc({ ProcessId: 12.5, ParentProcessId: 4 }), null)
  // A missing or broken parent is "no known parent", never pid 0-by-accident.
  assert.equal(toProc({ ProcessId: 7, ParentProcessId: null }).ppid, 0)
  assert.equal(toProc({ ProcessId: 7, ParentProcessId: -1 }).ppid, 0)
  assert.equal(toProc({ ProcessId: 7 }).wsBytes, 0)
})

test('a truncated CIM reply degrades the sample instead of showing half a machine', async () => {
  const os = harness({ cim: CIM_TRUNCATED_FIXTURE, tasklist: TASKLIST_FIXTURE })
  const { procs, degraded, cimError } = await sample({ deps: os.deps })

  assert.equal(degraded, DEGRADED_NO_PPID)
  assert.match(cimError, /JSON|Unexpected/, 'the reason the primary query was unusable is kept')
  // The degraded snapshot has no parent chain and no birth times, which is what
  // `degraded` tells the gates.
  assert.ok(procs.length > 0)
  assert.ok(procs.every((p) => p.ppid === 0 && p.createdMs === null))
  assert.deepEqual(os.calls.map((c) => c.phase), ['cim', 'tasklist'])
})

test('a CIM process failure degrades the sample', async () => {
  const os = harness({ cim: commandError('Get-CimInstance : Access denied'), tasklist: TASKLIST_FIXTURE })
  const { degraded, cimError } = await sample({ deps: os.deps })
  assert.equal(degraded, DEGRADED_NO_PPID)
  assert.equal(cimError, 'Get-CimInstance : Access denied')
})

test('an empty CIM reply is a failed read, not a quiet machine', async () => {
  // ConvertTo-Json emits nothing for an empty pipeline. A live Windows box always
  // has processes, so this shape must not render as a healthy empty snapshot.
  for (const empty of ['', '   \r\n', 'null']) {
    const os = harness({ cim: empty, tasklist: TASKLIST_FIXTURE })
    const { degraded, cimError } = await sample({ deps: os.deps })
    assert.equal(degraded, DEGRADED_NO_PPID, JSON.stringify(empty))
    assert.equal(cimError, 'CIM returned no processes')
    assert.deepEqual(os.calls.map((c) => c.phase), ['cim', 'tasklist'])
  }
})

test('tasklist rows carry what tasklist can know and nothing more', async () => {
  const os = harness({ cim: timeoutError(), tasklist: TASKLIST_FIXTURE })
  const { procs, degraded } = await sample({ deps: os.deps })

  assert.equal(degraded, DEGRADED_NO_PPID)
  assert.deepEqual(procs.map((p) => p.pid), [4, 2784, 19000, 18432, 21008])
  const svchost = procs.find((p) => p.pid === 2784)
  assert.deepEqual(svchost, {
    pid: 2784, ppid: 0, name: 'svchost', cmdline: '', createdMs: null,
    // "12,345 K" is kilobytes with a thousands separator.
    wsBytes: 12345 * 1024
  })
  // Every row is parentless and birthless: attribution and the kill gates are
  // disabled for exactly this reason.
  assert.ok(procs.every((p) => p.ppid === 0 && p.createdMs === null && p.cmdline === ''))
})

test('tasklist output is parsed with CRLF and with LF alike', () => {
  const lf = parseTasklistRows(TASKLIST_FIXTURE)
  const crlf = parseTasklistRows(TASKLIST_FIXTURE.replace(/\n/g, '\r\n'))
  assert.deepEqual(crlf, lf)
  assert.ok(lf.length > 0)
})

test('a truncated tasklist reply yields the rows that are whole', () => {
  // A stream cut mid-line must not invent a process, and a header line (which
  // `/nh` removes but a garbled reply can carry) is not a row.
  const rows = parseTasklistRows(TASKLIST_TRUNCATED_FIXTURE)
  assert.deepEqual(rows.map((r) => r.pid), [2784])
  assert.equal(rows[0].name, 'svchost')
  assert.deepEqual(parseTasklistRows(''), [])
  assert.deepEqual(parseTasklistRows(null), [])
  // An error page on stdout with a zero exit is not a process list; the caller
  // still gets a degraded snapshot, which the gates refuse.
  assert.deepEqual(parseTasklistRows('ERROR: The specified tasklist has no tasks running.\r\n'), [])
})

test('the tasklist call is a hidden CSV dump with the degraded budget', async () => {
  const os = harness({ cim: timeoutError(), tasklist: TASKLIST_FIXTURE })
  await sample({ deps: os.deps })
  const [, call] = os.calls
  assert.equal(call.cmd, 'tasklist')
  assert.deepEqual(call.args, ['/fo', 'csv', '/nh'])
  assert.equal(call.options.windowsHide, true)
  assert.equal(call.options.maxBuffer, 16 * 1024 * 1024)
})

test('the budget is shared by both phases, and its floor can push the worst case past the budget', async () => {
  const baseline = harness({ cim: CIM_FIXTURE })
  const rows = await sampleWindowsCim({ deps: baseline.deps, deadline: EPOCH + SAMPLE_TIMEOUT_MS })
  assert.ok(rows.length > 0)
  assert.equal(baseline.calls[0].options.timeout, SAMPLE_TIMEOUT_MS, 'the CIM phase gets the whole budget')

  // A CIM call that consumed most of the budget leaves the remainder to tasklist.
  const partly = harness({ cim: timeoutError(), tasklist: TASKLIST_FIXTURE, spends: { cim: 5000 } })
  await sample({ deps: partly.deps })
  assert.equal(partly.calls[0].options.timeout, SAMPLE_TIMEOUT_MS)
  assert.equal(partly.calls[1].options.timeout, SAMPLE_TIMEOUT_MS - 5000)

  // A CIM call that used the whole budget would otherwise leave 0 ms, i.e. a
  // guaranteed second failure and a snapshot that reports nothing at all.
  const spent = harness({ cim: timeoutError(), tasklist: TASKLIST_FIXTURE, spends: { cim: SAMPLE_TIMEOUT_MS + 500 } })
  const result = await sample({ deps: spent.deps })
  assert.equal(spent.calls[1].options.timeout, MIN_PHASE_TIMEOUT_MS)
  assert.equal(result.degraded, DEGRADED_NO_PPID)
  assert.ok(result.procs.length > 0, 'the degraded snapshot still lands')

  // The floor is what makes a sample outlive its budget: this one has already
  // spent 8500 ms of an 8000 ms budget and is handed 1000 ms more, so the
  // invariant is `budget + per-phase floor`, not `budget`. A sample that said
  // "total failure" instead would cost the caller the usable snapshot.
  assert.equal(spent.clock.t - EPOCH, SAMPLE_TIMEOUT_MS + 500, 'the CIM phase ran past the budget')
  assert.equal(
    (spent.clock.t - EPOCH) + spent.calls[1].options.timeout,
    SAMPLE_TIMEOUT_MS + 500 + MIN_PHASE_TIMEOUT_MS,
    'the worst case is the budget plus the floor'
  )

  // A caller-supplied budget is what the phases get; no test waits for it.
  const custom = harness({ cim: CIM_FIXTURE })
  await sample({ timeoutMs: 1234, deps: custom.deps })
  assert.equal(custom.calls[0].options.timeout, 1234)
})

test('a phase prices its budget from one clock read', async () => {
  // `deps.now` is a seam a test controls. A second read inside one phase charges
  // that phase for looking at the time, so with a clock that ticks per read the
  // budget would land one millisecond short of what the caller asked for.
  const granted = []
  let reads = 0
  const ticking = {
    runExec: async (cmd, args, options) => {
      granted.push(options.timeout)
      return cmd === 'tasklist' ? TASKLIST_FIXTURE : CIM_FIXTURE
    },
    platform: () => 'win32',
    now: () => (reads += 1)
  }

  await sampleWindowsTasklist({ timeoutMs: 1234, deps: ticking })
  assert.equal(reads, 1, 'one clock read per phase')
  assert.equal(granted[0], 1234, 'the budget is the budget, not the budget minus the reads')

  // The deadline branch reads once too, and measures the remainder from that one.
  granted.length = 0
  reads = 0
  await sampleWindowsCim({ timeoutMs: 1234, deps: ticking, deadline: 10_000 })
  assert.equal(reads, 1, 'the deadline branch reads once as well')
  assert.equal(granted[0], 10_000 - 1, 'the remainder against the single read')
})

test('both phases failing reports one failure that names the last cause', async () => {
  const os = harness({ cim: timeoutError('powershell timed out'), tasklist: commandError('tasklist not found') })
  await assert.rejects(sample({ deps: os.deps }), (error) => {
    assert.match(error.message, /both CIM and tasklist sampling failed/)
    assert.match(error.message, /tasklist not found/)
    return true
  })
  assert.deepEqual(os.calls.map((c) => c.phase), ['cim', 'tasklist'])
})

test('a non-Windows host reports an explicit unsupported state and runs nothing', async () => {
  const os = harness({ platform: 'linux', cim: CIM_FIXTURE })
  await assert.rejects(sample({ deps: os.deps }), (error) => {
    // A code, not just prose: the route answers with this and the panel localizes
    // it, so "not implemented here" survives without shipping the message.
    assert.equal(error.code, SAMPLER_UNSUPPORTED_PLATFORM)
    assert.match(error.message, /only Windows sampling is implemented/)
    assert.match(error.message, /linux/)
    return true
  })
  assert.deepEqual(os.calls, [], 'the unsupported branch never reaches for a shell')

  // The same statement on a mac: no crash, no invented snapshot.
  const mac = harness({ platform: 'darwin' })
  await assert.rejects(sample({ deps: mac.deps }), { code: SAMPLER_UNSUPPORTED_PLATFORM })
  assert.deepEqual(mac.calls, [])
})

test('phase helpers stay injectable on their own for the two reply shapes', async () => {
  const cimOs = harness({ cim: CIM_FIXTURE })
  assert.ok((await sampleWindowsCim({ deps: cimOs.deps })).length > 0)
  const tlOs = harness({ tasklist: TASKLIST_FIXTURE })
  assert.ok((await sampleWindowsTasklist({ deps: tlOs.deps })).length > 0)
  // An empty tasklist reply is an empty list, and `sample` is what marks it.
  const emptyOs = harness({ tasklist: '' })
  assert.deepEqual(await sampleWindowsTasklist({ deps: emptyOs.deps }), [])
})
