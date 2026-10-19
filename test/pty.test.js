import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalIndex, ptyRoots, ptyOwnerOf } from '../lib/pty.js'
import { attribute } from '../lib/attribute.js'
import { validateKillOwnership, decideKillEntry } from '../lib/act.js'

function agent(id) {
  return { id, status: 'idle', session: { header: { id } } }
}

const ROOT = agent('root-1')
const OTHER = agent('root-2')

test('terminal pids become attribution roots so the whole subtree is labelled', () => {
  // 终端里跑起来的进程都在 pty 下面：只标 pty 自己那一行是不够的。
  const procs = [
    { pid: 1, ppid: 0, name: 'node', cmdline: 'dsh host', createdMs: 1, wsBytes: 0 },
    { pid: 100, ppid: 1, name: 'pwsh', cmdline: 'pwsh', createdMs: 1, wsBytes: 0 },
    { pid: 101, ppid: 100, name: 'node', cmdline: 'node dev.js', createdMs: 1, wsBytes: 0 },
    { pid: 102, ppid: 101, name: 'node', cmdline: 'node watcher.js', createdMs: 1, wsBytes: 0 }
  ]
  const roots = ptyRoots({ pids: new Map([[100, { sessionId: 't1', ownerId: 'root-1' }]]), sessions: 1 })
  const { attributed } = attribute(procs, new Map([[1, 'harness'], ...roots]))

  // pty 本身，以及它下面的两层，都带 rootLabel 'pty'。
  for (const pid of [100, 101, 102]) {
    assert.equal(attributed.get(pid).rootLabel, 'pty', `pid ${pid}`)
  }
  // 宿主自身仍然是 harness。
  assert.equal(attributed.get(1).rootLabel, 'harness')
})

test('a host without terminal sessions contributes no roots', () => {
  assert.equal(ptyRoots(null).size, 0)
  assert.equal(ptyRoots({ pids: null }).size, 0)
  assert.equal(ptyRoots({ pids: new Map() }).size, 0)
})

test('the index lists every live owner and skips snapshots without a pid', () => {
  const seen = []
  const index = createTerminalIndex({
    terminals: {
      list(owner) {
        seen.push(owner.id)
        return owner.id === 'root-1'
          ? [{ sessionId: 't1', type: 'pwsh', pid: 100, status: { kind: 'running' } },
             { sessionId: 't2', type: 'pwsh', status: { kind: 'exited', exitCode: 0, signal: null } }]
          : [{ sessionId: 't3', type: 'pwsh', pid: 200, status: { kind: 'running' } }]
      }
    }
  })

  const read = index.read(() => [ROOT, OTHER])
  // list 收的是精确存活的 Agent 对象，因此遍历按 owner 进行。
  assert.deepEqual(seen, ['root-1', 'root-2'])
  assert.equal(read.sessions, 2)
  assert.deepEqual([...read.pids.keys()].sort((a, b) => a - b), [100, 200])
  assert.deepEqual(read.pids.get(100), { sessionId: 't1', ownerId: 'root-1' })
  // 没有 pid 的快照（后端没有顶层进程）不进入索引，也不凑成一个假的 0。
  assert.equal(read.pids.has('t2'), false)
})

test('the index states its absence instead of reporting an empty host', () => {
  const noService = createTerminalIndex({})
  assert.equal(noService.read(() => [ROOT]), null)

  const noAgents = createTerminalIndex({ terminals: { list: () => [] } })
  assert.equal(noAgents.read(() => null), null, 'no lineage means no owners to list for')
  assert.equal(noAgents.read(null), null)
})

test('one owner failing to list does not hide the other sessions', () => {
  const index = createTerminalIndex({
    terminals: {
      list(owner) {
        if (owner.id === 'root-1') throw new Error('this owner cannot be listed')
        return [{ sessionId: 't3', type: 'pwsh', pid: 200, status: { kind: 'running' } }]
      }
    }
  })

  const read = index.read(() => [ROOT, OTHER])
  assert.deepEqual([...read.pids.keys()], [200])
})

test('the exact owner of a pid is readable back', () => {
  const index = { pids: new Map([[100, { sessionId: 't1', ownerId: 'root-1' }]]), sessions: 1 }

  assert.deepEqual(ptyOwnerOf(index, 100), { sessionId: 't1', ownerId: 'root-1' })
  assert.equal(ptyOwnerOf(index, 999), null)
  assert.equal(ptyOwnerOf(null, 100), null)
})

test('the index captures terminals through inject and drops them on disposal', () => {
  let dispose = null
  const guarded = {
    get terminals() { throw new Error('cannot get property "terminals" without inject') },
    inject(services, mount) {
      assert.deepEqual(Array.from(services), ['terminals'])
      mount({
        terminals: { list: () => [{ sessionId: 't1', type: 'pwsh', pid: 100, status: { kind: 'running' } }] },
        on(event, listener) { if (event === 'dispose') dispose = listener }
      })
    }
  }

  const index = createTerminalIndex(guarded)
  assert.deepEqual([...index.read(() => [ROOT]).pids.keys()], [100])
  dispose()
  assert.equal(index.read(() => [ROOT]), null)
})

// 终端归属的进程树不可终止。这条结论必须被钉死：将来放宽归因判据的人不会看到
// 本文件，就不会知道这里曾经有一个明确的拒绝。

test('a process owned by a live terminal session is never a kill target', () => {
  const procs = [
    { pid: 1, ppid: 0, name: 'node', cmdline: 'dsh host', createdMs: 1, wsBytes: 0 },
    { pid: 100, ppid: 1, name: 'pwsh', cmdline: 'pwsh', createdMs: 1, wsBytes: 0 },
    { pid: 101, ppid: 100, name: 'node', cmdline: 'node dev.js', createdMs: 1, wsBytes: 0 }
  ]
  const attribution = Object.fromEntries(
    attribute(procs, new Map([[1, 'harness'], [100, 'pty']])).attributed
  )

  // pty 根自己与它下面的每一行都不可终止。
  for (const pid of [100, 101]) {
    const verdict = validateKillOwnership(attribution, pid)
    assert.equal(verdict.ok, false, `pid ${pid} must not be terminable`)
    assert.equal(verdict.code, 'pty_owned', `pid ${pid}`)
  }
  // 宿主自身照旧可终止，因此这条拒绝不是把整个归因表关掉。
  assert.deepEqual(validateKillOwnership(attribution, 1), { ok: true, code: 'attributed' })

  // 入口检查因此在动手之前就停住这一类目标。
  const snapshot = { procs, degraded: false }
  const entry = decideKillEntry({
    pid: 101, seenCreatedMs: 1, snapshot, takenAt: 1000, now: 1100, maxAgeMs: 15000, attribution
  })
  assert.deepEqual(entry, { ok: false, code: 'pty_owned' })
})