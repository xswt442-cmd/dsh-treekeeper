import test from 'node:test'
import assert from 'node:assert/strict'
import { validateKillTarget, validateKillOwnership, killTree, classifyKillOutcome, decideKillEntry, decideKillConfirm, TASKKILL_ARGS } from '../lib/act.js'
import { attribute } from '../lib/attribute.js'
import { parseCimDate } from '../lib/shared.js'

const liveNode = { alive: true, createdMs: 1000, name: 'node.exe' }

/**
 * `killTree` 的操作系统接缝：`exec` 记录每条命令、argv 与执行选项而不真的启动
 * 进程，`platform` 站到 Windows 门的两侧，`sleep` 让测试不必为一个从未存在的
 * 进程等 700 毫秒。三者合起来让测试可以断言两个要点：被拒绝的终止不会碰到
 * taskkill；被允许的终止收到的 argv 正是各道检查所针对的那一个。
 */
function fakeOs({ platform = 'win32', probes = [], taskkill = { err: null, stdout: '', stderr: '' } } = {}) {
  const calls = []
  const sleeps = []
  let probe = 0
  const exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    if (cmd === 'taskkill') return taskkill
    return probes[probe++] ?? { err: null, stdout: '', stderr: '' }
  }
  return {
    calls,
    sleeps,
    deps: { exec, platform: () => platform, sleep: async (ms) => { sleeps.push(ms) } },
    taskkillCalls: () => calls.filter((c) => c.cmd === 'taskkill')
  }
}

const CREATED = '20260825162958.5+480'
const CREATED_MS = parseCimDate(CREATED)
const aliveProbe = (name = 'node.exe') => ({ err: null, stdout: JSON.stringify({ CreationDate: CREATED, Name: name }), stderr: '' })
const goneProbe = () => ({ err: null, stdout: '', stderr: '' })
const brokenProbe = () => ({ err: Object.assign(new Error('spawn powershell.exe EACCES'), { code: 'EACCES' }), stdout: '', stderr: '' })


test('kill outcome treats an unreadable creation time as a survivor, not a reuse', () => {
  // CIM 的 JSON 解析失败时 pidFacts 把 createdMs 回退为 null。pid 仍然存活，又
  // 无法证明它换了进程，因此这次终止不能报告成功。
  assert.deepEqual(classifyKillOutcome(100, { alive: true, createdMs: null }), {
    ok: false,
    code: 'still_alive',
    detail: 'process survived taskkill /T /F'
  })
  // 存活且创建时间与验证过的一致：还是同一个进程。
  assert.equal(classifyKillOutcome(100, { alive: true, createdMs: 100 }).ok, false)
  // 已消失。
  assert.deepEqual(classifyKillOutcome(100, { alive: false, createdMs: null }), { ok: true, code: 'killed' })
  // pid 相同但可以证明是另一个进程：原进程已经结束，pid 在探测前被复用，这是
  // 一次成功的树杀。
  assert.deepEqual(classifyKillOutcome(100, { alive: true, createdMs: 999 }), { ok: true, code: 'gone_reused' })
})

test('a failed probe must refuse, never read as already-gone or killed', () => {
  // pidFacts 把查询失败报告为 { alive:false, error }，与干净的“查无此进程”只差
  // error 字段。策略检查必须区分两者：仍在运行的目标碰上偶发的 PowerShell 故障，
  // 不能被当成成功的空操作。
  const facts = { alive: false, createdMs: null, name: null, error: 'spawn blocked' }
  assert.equal(
    validateKillTarget({ pid: 200, seenCreatedMs: 100, facts, whitelistPids: new Set() }).code,
    'verify_failed'
  )

  // 终止后的探测同理：taskkill 已经执行过，复查失败必须读作失败，不能读作
  // `killed`。
  assert.deepEqual(
    classifyKillOutcome(100, { alive: false, createdMs: null, error: 'spawn blocked' }),
    { ok: false, code: 'verify_failed', detail: 'spawn blocked' }
  )
})

test('kill entry refuses anything the snapshot cannot vouch for', () => {
  const procs = [{ pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: 100, wsBytes: 0 }]
  const snapshot = { procs, degraded: false }
  const attribution = { 200: { rootLabel: 'harness' } }
  const base = { pid: 200, seenCreatedMs: 100, snapshot, takenAt: 1000, now: 1100, maxAgeMs: 15000, attribution }

  // 唯一可以继续的路径：快照新鲜、创建时间一致，且 pid 归宿主树所有。
  assert.deepEqual(decideKillEntry(base), { ok: true })

  // 每一种拒绝方式。它们都不能到达 taskkill，并且都在这里覆盖，不只依赖 Windows。
  const refused = (over, code) => {
    assert.equal(decideKillEntry({ ...base, ...over }).code, code)
  }
  refused({ snapshot: null }, 'snapshot_required')
  refused({ snapshot: { procs, degraded: true } }, 'snapshot_required')
  refused({ now: 1000 + 15001 }, 'snapshot_required')
  refused({ pid: 999 }, 'snapshot_required')
  refused({ seenCreatedMs: Number.NaN }, 'snapshot_required')
  refused({ seenCreatedMs: 999 }, 'snapshot_required')
  // 出现在快照里但不属于宿主树（`unknown` 集合），或者归属于 harness 之外的根。
  refused({ attribution: {} }, 'unattributed')
  refused({ attribution: { 200: { rootLabel: 'unknown' } } }, 'non_harness_root')
})

test('kill confirm refuses a target the pre-pull sample cannot re-identify', () => {
  const fresh = { procs: [{ pid: 200, createdMs: 100 }], degraded: false }
  assert.deepEqual(decideKillConfirm({ pid: 200, seenCreatedMs: 100, fresh }), { ok: true })
  assert.equal(decideKillConfirm({ pid: 200, seenCreatedMs: 100, fresh: null }).code, 'snapshot_required')
  assert.equal(decideKillConfirm({ pid: 200, seenCreatedMs: 100, fresh: { procs: [], degraded: true } }).code, 'snapshot_required')
  assert.equal(decideKillConfirm({ pid: 999, seenCreatedMs: 100, fresh }).code, 'snapshot_required')
  assert.equal(decideKillConfirm({ pid: 200, seenCreatedMs: 999, fresh }).code, 'snapshot_required')
})

test('kill policy rejects a target without a verifiable creation time', () => {
  const result = validateKillTarget({ pid: 42, seenCreatedMs: null, facts: liveNode, selfPid: 1 })
  assert.deepEqual(result, { ok: false, code: 'missing_creation_time' })
})

test('kill policy rejects reused or unqueryable process identities', () => {
  const reused = validateKillTarget({ pid: 42, seenCreatedMs: 2000, facts: liveNode, selfPid: 1 })
  const unqueryable = validateKillTarget({ pid: 42, seenCreatedMs: 1000, facts: { ...liveNode, createdMs: null }, selfPid: 1 })

  assert.equal(reused.code, 'pid_identity_unverified')
  assert.equal(unqueryable.code, 'pid_identity_unverified')
})

test('kill policy protects Windows critical process names and configured pids', () => {
  const protectedProcess = validateKillTarget({ pid: 42, seenCreatedMs: 1000, facts: { ...liveNode, name: 'svchost.exe' }, selfPid: 1 })
  const whitelisted = validateKillTarget({ pid: 42, seenCreatedMs: 1000, facts: liveNode, whitelistPids: new Set([42]), selfPid: 1 })

  assert.equal(protectedProcess.code, 'protected')
  assert.equal(whitelisted.code, 'whitelisted')
})

test('kill policy permits only a verified non-protected process', () => {
  const result = validateKillTarget({ pid: 42, seenCreatedMs: 1000, facts: liveNode, selfPid: 1 })
  assert.deepEqual(result, { ok: true, code: 'verified' })
})

test('kill ownership rejects a process outside the DSH host tree', () => {
  const attribution = { 1000: { rootLabel: 'harness', depth: 1 } }
  assert.deepEqual(validateKillOwnership(attribution, 9999), { ok: false, code: 'unattributed' })
  assert.deepEqual(validateKillOwnership(attribution, 1000), { ok: true, code: 'attributed' })
  // 缺少归因对象时，任何终止都不能通过。
  assert.deepEqual(validateKillOwnership(null, 1000), { ok: false, code: 'unattributed' })
})

test('kill ownership rejects descendants of a whitelisted root (REVIEW-0904 P1)', () => {
  // `extraWhitelistPids` 把登记的 pid 作为归因根，好让面板给它们打标签。授权
  // 这些桶等于把设置反过来用：保护一个 pid 会扩大可终止范围。
  const procs = [
    { pid: 1, ppid: 0, name: 'dsh', cmdline: 'dsh host', createdMs: 1, wsBytes: 0 },
    { pid: 500, ppid: 1, name: 'pinned', cmdline: 'pinned root', createdMs: 1, wsBytes: 0 },
    { pid: 501, ppid: 500, name: 'child', cmdline: 'child of pinned', createdMs: 1, wsBytes: 0 }
  ]
  const attribution = Object.fromEntries(
    attribute(procs, new Map([[1, 'harness'], [500, 'whitelisted']])).attributed
  )

  // 登记根的子进程已经“已归因”，但归的不是 harness。
  assert.equal(validateKillOwnership(attribution, 501).ok, false)
  assert.equal(validateKillOwnership(attribution, 501).code, 'non_harness_root')
  // 登记的 pid 本身同样被拒绝。
  assert.equal(validateKillOwnership(attribution, 500).code, 'non_harness_root')
  // harness 的后代照常可用。
  assert.deepEqual(validateKillOwnership(attribution, 1), { ok: true, code: 'attributed' })
})

test('killTree refuses when a protected pid is a descendant (Problem 3)', async () => {
  const procs = [
    { pid: 200, ppid: 1, name: 'node', cmdline: 'node parent', createdMs: 100, wsBytes: 0 },
    { pid: 201, ppid: 200, name: 'node', cmdline: 'node child', createdMs: 100, wsBytes: 0 }
  ]
  // pid 200 已通过验证、本身可终止，但它的树里有受保护的 pid 201；/T 会连带
  // 结束 201，因此整次终止在启动任何进程之前被拒绝。这是纯快照检查，在 Windows
  // 之外也会执行。
  const os = fakeOs()
  const result = await killTree({
    pid: 200,
    seenCreatedMs: 100,
    whitelistPids: new Set([201]),
    config: { allowKill: true },
    procs,
    deps: os.deps
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'protected_descendant')
  assert.equal(result.detail, '201')
  assert.deepEqual(os.calls, [], '受保护后代检查在任何进程启动之前完成')
})

test('a non-Windows host reports unsupported_platform and spawns nothing', async () => {
  // 非 Windows 分支：各道检查都通过，操作系统说不支持，taskkill 仍然不能被执行。
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }
  for (const platform of ['linux', 'darwin']) {
    const os = fakeOs({ platform, probes: [aliveProbe(), aliveProbe()] })
    const result = await killTree({
      pid: 200,
      seenCreatedMs: CREATED_MS,
      whitelistPids: new Set([1]),
      config: { allowKill: true },
      procs: [target],
      deps: os.deps
    })
    assert.deepEqual(result, { ok: false, code: 'unsupported_platform' }, platform)
    assert.deepEqual(os.calls, [], platform + ' must not reach for powershell or taskkill')
  }

  // 同样的事实放在 Windows 上会走到系统调用，因此上面的否定结果来自平台检查，
  // 不是夹具坏了。
  const onWindows = fakeOs({ probes: [aliveProbe(), goneProbe()] })
  const allowed = await killTree({
    pid: 200, seenCreatedMs: CREATED_MS, whitelistPids: new Set([1]),
    config: { allowKill: true }, procs: [target], deps: onWindows.deps
  })
  assert.deepEqual(allowed, { ok: true, code: 'killed' })
})

test('an allowed kill runs exactly taskkill /PID <pid> /T /F, once', async () => {
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }
  const os = fakeOs({ probes: [aliveProbe(), goneProbe()] })
  const result = await killTree({
    pid: 200, seenCreatedMs: CREATED_MS, whitelistPids: new Set(), config: {}, procs: [target], deps: os.deps
  })

  assert.deepEqual(result, { ok: true, code: 'killed' })
  assert.deepEqual(os.calls.map((c) => c.cmd), ['powershell.exe', 'taskkill', 'powershell.exe'],
    'identity precheck, one kill, one liveness recheck')
  const [kill] = os.taskkillCalls()
  assert.deepEqual(kill.args, TASKKILL_ARGS(200))
  assert.deepEqual(kill.args, ['/PID', '200', '/T', '/F'])
  assert.equal(kill.options.windowsHide, true, 'no console window for a guarded kill')
  // 复查要等系统回收进程树；这段等待由接缝承担，测试看得到它，却不用真的花掉。
  assert.deepEqual(os.sleeps, [700])
})

test('every pre-trigger refusal means taskkill is never called', async () => {
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }
  // `self` 在下面的纯函数上断言：通过 killTree 驱动它，就得把测试运行器自己的
  // pid 交给一道万一出错的检查。
  const cases = [
    ['disabled', { config: { allowKill: false }, probes: [aliveProbe()] }],
    ['whitelisted', { whitelistPids: new Set([200]), probes: [aliveProbe()] }],
    ['missing_creation_time', { seenCreatedMs: null, probes: [aliveProbe()] }],
    ['pid_identity_unverified', { seenCreatedMs: CREATED_MS + 5000, probes: [aliveProbe()] }],
    ['protected', { probes: [aliveProbe('lsass.exe')] }],
    ['verify_failed', { probes: [brokenProbe()] }]
  ]

  for (const [code, over] of cases) {
    const os = fakeOs({ probes: over.probes })
    const result = await killTree({
      pid: 200,
      // `??` 会把显式的 null 变成合法时间，因此这里按键是否存在取值：
      // `missing_creation_time` 必须真的以 null 到达。
      seenCreatedMs: 'seenCreatedMs' in over ? over.seenCreatedMs : CREATED_MS,
      whitelistPids: over.whitelistPids ?? new Set(),
      config: over.config ?? {},
      procs: [target],
      deps: os.deps
    })
    assert.equal(result.ok, false, code)
    assert.equal(result.code, code)
    assert.deepEqual(os.taskkillCalls(), [], `${code} must not reach taskkill`)
    // 终止后的复查也不该运行：没有东西需要复查。
    assert.deepEqual(os.sleeps, [], code)
  }

  // self 检查，在决定它的纯函数上断言。
  assert.deepEqual(validateKillTarget({ pid: 4242, seenCreatedMs: 1000, facts: liveNode, selfPid: 4242 }), { ok: false, code: 'self' })
})

test('a target that is already gone is reported without pulling the trigger', async () => {
  const os = fakeOs({ probes: [goneProbe()] })
  const result = await killTree({
    pid: 200, seenCreatedMs: CREATED_MS, config: {}, procs: [], deps: os.deps
  })
  assert.deepEqual(result, { ok: true, code: 'already_gone' })
  assert.deepEqual(os.taskkillCalls(), [])
})

test('a taskkill that fails says so, and a clean "not found" is still a death', async () => {
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }

  const failed = fakeOs({
    probes: [aliveProbe(), goneProbe()],
    taskkill: { err: Object.assign(new Error('access denied'), { code: 'EPERM' }), stdout: '', stderr: 'ERROR: Access is denied.' }
  })
  const result = await killTree({ pid: 200, seenCreatedMs: CREATED_MS, config: {}, procs: [target], deps: failed.deps })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'taskkill_failed')
  assert.match(result.detail, /Access is denied/)
  assert.deepEqual(failed.sleeps, [], 'a failed kill does not recheck')

  // taskkill 自己报的“查无此进程”说明目标已经结束，后面的复查会确认这一点；这
  // 不是检查失败。
  const notFound = fakeOs({
    probes: [aliveProbe(), goneProbe()],
    taskkill: { err: new Error('exit 128'), stdout: '', stderr: 'ERROR: The process "200" not found.' }
  })
  const survived = await killTree({ pid: 200, seenCreatedMs: CREATED_MS, config: {}, procs: [target], deps: notFound.deps })
  assert.deepEqual(survived, { ok: true, code: 'killed' })
})

test('a survivor of taskkill is reported as one, never as success', async () => {
  const target = { pid: 200, ppid: 1, name: 'node', cmdline: 'node', createdMs: CREATED_MS, wsBytes: 0 }
  const os = fakeOs({ probes: [aliveProbe(), aliveProbe()] })
  const result = await killTree({ pid: 200, seenCreatedMs: CREATED_MS, config: {}, procs: [target], deps: os.deps })
  assert.deepEqual(result, { ok: false, code: 'still_alive', detail: 'process survived taskkill /T /F' })
  assert.equal(os.taskkillCalls().length, 1)
})

