// `snapshot.degraded` 的生产者——每个终止检查都信任这个标记（lib/act.js 的
// decideKillEntry / decideKillConfirm，以及泄漏发现的置信度规则）。消费者只能
// 相信这个标记，因此这里用真实的 PowerShell 与 tasklist 输出，通过
// lib/sampler.js 的接缝验证采样器：`deps.runExec` 喂入回复，`deps.platform`
// 站到 Windows 门的两侧，`deps.now` 是测试可以推进的时钟，超时预算因此不用真的
// 等待。
//
// 本文件不启动任何进程，也不需要 Windows。

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
// Windows PowerShell 5.1 的 `ConvertTo-Json`，也就是本插件的 `powershell.exe`
// 子进程实际运行的那一个：同样的查询，日期是转义的 `\/Date(ms)\/` 形式。
const CIM_PS51_FIXTURE = fixture('cim-processes-ps51.json')
const TASKLIST_FIXTURE = fixture('tasklist-normal.txt')
const TASKLIST_TRUNCATED_FIXTURE = fixture('tasklist-truncated.txt')

const EPOCH = 1780000000000

/**
 * 假的操作系统边界：记录每条命令、回复与超时选项，并按配置推进注入的时钟，
 * 让共享预算可以被观察到。
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
  // `System Idle Process` 是 pid 0：它不是树节点，因此被丢弃，不能变成每个孤儿
  // 都能指过去的父进程。
  assert.ok(!procs.some((p) => p.pid === 0))
  assert.deepEqual(procs.map((p) => p.pid), [4, 2784, 19000, 18432, 20144, 21008, 21100])

  const svchost = procs.find((p) => p.pid === 2784)
  assert.deepEqual(svchost, {
    pid: 2784,
    ppid: 552,
    // `.exe` 在这里被去掉一次，之后每个消费者都只比较裸名称。
    name: 'svchost',
    // 拒绝访问的行回来时 CommandLine 为 null：缺失读作 ''，从不猜测。
    cmdline: '',
    createdMs: Date.parse('2026-08-25T09:14:07.1234567+08:00'),
    wsBytes: 12656640
  })

  // 宿主自身：PowerShell 序列化的 ISO 形式，与 `parseCimDate` 记录的原始 CIM
  // 字符串形式 `20260825162958.5+480`，都落到同一个 epoch 毫秒——终止检查比较的
  // 就是这两个数字。
  const launcher = procs.find((p) => p.pid === 19000)
  assert.equal(launcher.createdMs, Date.UTC(2026, 7, 25, 8, 29, 58, 500))
  const node = procs.find((p) => p.pid === 18432)
  assert.equal(node.createdMs, Date.parse('2026-08-25T16:29:59.2500000+08:00'))
  assert.match(node.cmdline, /@deepseek-ai\\dsh\\lib\\bin\.js/)
  // CreationDate 缺失的行没有可用于验证的身份，各道检查读作“不可终止”，绝不会
  // 读成“匹配”。
  assert.equal(procs.find((p) => p.pid === 21100).createdMs, null)
  assert.equal(procs.find((p) => p.pid === 4).createdMs, Date.parse('2026-08-25T09:14:02.0000000+08:00'))

  // 每次采样只有一次 CIM 查询，而且只有一次：降级路径是给失败准备的。
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
  assert.equal(call.options.windowsHide, true, '每次轮询都弹出 PowerShell 窗口是缺陷')
  assert.equal(call.options.timeout, SAMPLE_TIMEOUT_MS)
  assert.equal(call.options.maxBuffer, 32 * 1024 * 1024)
})

test('a single-process CIM reply is an object, not an array, and still parses', async () => {
  const rows = parseCimRows(CIM_SINGLE_FIXTURE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 18432)
  assert.equal(rows[0].ppid, 19000)
})

// 终止路径用新采样的创建时间比对身份，读不到身份就不允许终止。本插件固定启动的
// `powershell.exe` 是 Windows PowerShell 5.1，它把所有 CIM 时间序列化成
// `\/Date(ms)\/`，而 PowerShell 7 输出 ISO 字符串；按 ISO 理解这种回复会让每一行
// 都没有创建时间，终止按钮与长驻规则随之失效。这个夹具就是转义后的真实回复。
test('a Windows PowerShell 5.1 reply keeps creation times, so a snapshot stays actionable', async () => {
  const os = harness({ cim: CIM_PS51_FIXTURE })
  const { procs, degraded } = await sample({ deps: os.deps })

  assert.equal(degraded, null, '转义的 .NET 日期形式不构成降级采样')
  assert.ok(CIM_PS51_FIXTURE.includes('\\/Date(1790745392422)\\/'), '夹具必须保持 5.1 输出的形式')

  const byPid = new Map(procs.map((p) => [p.pid, p]))
  // 桌面宿主与它的 Electron 父进程都以 `/Date(ms)/` 到达。
  assert.equal(byPid.get(37224).createdMs, 1790745392422)
  assert.equal(byPid.get(40376).createdMs, 1790745000000)
  assert.equal(byPid.get(38888).createdMs, 1790745123456)
  assert.equal(byPid.get(99001).createdMs, 1790745600000)
  assert.equal(byPid.get(37224).name, 'DeepSeek Harness', '.exe 在这里同样被去掉')
  // 真实快照至少有一行带创建时间，终止按钮与长驻规则因此有数据可用。
  assert.ok(procs.some((p) => Number.isFinite(p.createdMs)), '真实快照至少给一个进程确定创建时间')
  // 创建时间合法地保持未知的两种情形，都不能被凑成一个数字：属性缺失，以及属性
  // 被拒绝时携带的 .NET 下限。下限不能被读成 1601 年。
  assert.equal(byPid.get(21100).createdMs, null)
  assert.equal(byPid.get(20144).createdMs, null, '.NET 的 DateTime 下限不是创建时间')
})

test('rows the contract cannot vouch for are dropped, not guessed', () => {
  assert.equal(toProc(null), null)
  assert.equal(toProc('2784'), null)
  assert.equal(toProc({ ProcessId: 0, ParentProcessId: 4 }), null, 'pid 0 is not a node')
  assert.equal(toProc({ ProcessId: 'abc', ParentProcessId: 4 }), null)
  assert.equal(toProc({ ProcessId: 12.5, ParentProcessId: 4 }), null)
  // 缺失或损坏的父进程读作“没有已知父进程”，不会意外变成 pid 0。
  assert.equal(toProc({ ProcessId: 7, ParentProcessId: null }).ppid, 0)
  assert.equal(toProc({ ProcessId: 7, ParentProcessId: -1 }).ppid, 0)
  assert.equal(toProc({ ProcessId: 7 }).wsBytes, 0)
})

test('a truncated CIM reply degrades the sample instead of showing half a machine', async () => {
  const os = harness({ cim: CIM_TRUNCATED_FIXTURE, tasklist: TASKLIST_FIXTURE })
  const { procs, degraded, cimError } = await sample({ deps: os.deps })

  assert.equal(degraded, DEGRADED_NO_PPID)
  assert.match(cimError, /JSON|Unexpected/, '主查询不可用的原因被保留下来')
  // 降级快照没有父进程链，也没有创建时间，`degraded` 就是把这一点告诉各道检查。
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
  // ConvertTo-Json 对空管道不输出内容。运行中的 Windows 机器总会有进程，因此
  // 这种回复不能渲染成一份健康的空快照。
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
    // "12,345 K" 是带千位分隔符的千字节数。
    wsBytes: 12345 * 1024
  })
  // 每一行都没有父进程，也没有创建时间：归因与终止检查正是因为这一点被停用。
  assert.ok(procs.every((p) => p.ppid === 0 && p.createdMs === null && p.cmdline === ''))
})

test('tasklist output is parsed with CRLF and with LF alike', () => {
  const lf = parseTasklistRows(TASKLIST_FIXTURE)
  const crlf = parseTasklistRows(TASKLIST_FIXTURE.replace(/\n/g, '\r\n'))
  assert.deepEqual(crlf, lf)
  assert.ok(lf.length > 0)
})

test('a truncated tasklist reply yields the rows that are whole', () => {
  // 流在行中间被切断时不能凭空造出进程；表头行（`/nh` 会去掉，但损坏的回复
  // 可能带上）也不是进程行。
  const rows = parseTasklistRows(TASKLIST_TRUNCATED_FIXTURE)
  assert.deepEqual(rows.map((r) => r.pid), [2784])
  assert.equal(rows[0].name, 'svchost')
  assert.deepEqual(parseTasklistRows(''), [])
  assert.deepEqual(parseTasklistRows(null), [])
  // 退出码为零但 stdout 是错误页时，它不是进程列表；调用方仍然得到一份降级
  // 快照，各道检查会拒绝它。
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
  assert.equal(baseline.calls[0].options.timeout, SAMPLE_TIMEOUT_MS, 'CIM 阶段拿到整个预算')

  // 用掉大部分预算的 CIM 调用把剩余部分留给 tasklist。
  const partly = harness({ cim: timeoutError(), tasklist: TASKLIST_FIXTURE, spends: { cim: 5000 } })
  await sample({ deps: partly.deps })
  assert.equal(partly.calls[0].options.timeout, SAMPLE_TIMEOUT_MS)
  assert.equal(partly.calls[1].options.timeout, SAMPLE_TIMEOUT_MS - 5000)

  // 用完整预算的 CIM 调用否则会给降级阶段留下 0 毫秒，等于第二次必然失败，采样
  // 什么都报告不出来。
  const spent = harness({ cim: timeoutError(), tasklist: TASKLIST_FIXTURE, spends: { cim: SAMPLE_TIMEOUT_MS + 500 } })
  const result = await sample({ deps: spent.deps })
  assert.equal(spent.calls[1].options.timeout, MIN_PHASE_TIMEOUT_MS)
  assert.equal(result.degraded, DEGRADED_NO_PPID)
  assert.ok(result.procs.length > 0, '降级快照仍然交得出来')

  // 下限让采样可以超出预算：这次采样在 8000 毫秒预算里已经花掉 8500 毫秒，又
  // 拿到 1000 毫秒，因此不变式是“预算加每阶段下限”。若报告彻底失败，调用方就
  // 失去这份可用的快照。
  assert.equal(spent.clock.t - EPOCH, SAMPLE_TIMEOUT_MS + 500, 'the CIM phase ran past the budget')
  assert.equal(
    (spent.clock.t - EPOCH) + spent.calls[1].options.timeout,
    SAMPLE_TIMEOUT_MS + 500 + MIN_PHASE_TIMEOUT_MS,
    'the worst case is the budget plus the floor'
  )

  // 调用方给的预算就是各阶段拿到的预算；没有测试真的等它。
  const custom = harness({ cim: CIM_FIXTURE })
  await sample({ timeoutMs: 1234, deps: custom.deps })
  assert.equal(custom.calls[0].options.timeout, 1234)
})

test('a phase prices its budget from one clock read', async () => {
  // `deps.now` 是测试控制的接缝。一个阶段内读两次时钟会让这个阶段为看时间而
  // 付费；时钟每次读取都前进时，预算会比调用方要求的少一毫秒。
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

  // 截止时间分支同样只读一次时钟，并按这一次读数计算剩余量。
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
    // 用错误码而不只是文字：路由把这个码带给面板，面板据此本地化，因此“此平台
    // 未实现”不必依赖错误原文传出去。
    assert.equal(error.code, SAMPLER_UNSUPPORTED_PLATFORM)
    assert.match(error.message, /only Windows sampling is implemented/)
    assert.match(error.message, /linux/)
    return true
  })
  assert.deepEqual(os.calls, [], 'the unsupported branch never reaches for a shell')

  // mac 上是同一个结论：不崩溃，也不编造快照。
  const mac = harness({ platform: 'darwin' })
  await assert.rejects(sample({ deps: mac.deps }), { code: SAMPLER_UNSUPPORTED_PLATFORM })
  assert.deepEqual(mac.calls, [])
})

test('phase helpers stay injectable on their own for the two reply shapes', async () => {
  const cimOs = harness({ cim: CIM_FIXTURE })
  assert.ok((await sampleWindowsCim({ deps: cimOs.deps })).length > 0)
  const tlOs = harness({ tasklist: TASKLIST_FIXTURE })
  assert.ok((await sampleWindowsTasklist({ deps: tlOs.deps })).length > 0)
  // 空的 tasklist 回复是空列表，由 `sample` 决定如何标记。
  const emptyOs = harness({ tasklist: '' })
  assert.deepEqual(await sampleWindowsTasklist({ deps: emptyOs.deps }), [])
})
