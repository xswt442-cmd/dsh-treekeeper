import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HistoryStore, historyDir } from '../lib/store.js'

test('history store keeps local append-only audit records', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  const store = new HistoryStore(tempDir)
  await store.append({ kind: 'kill', pid: 42, code: 'killed' })
  const rows = await store.last()

  assert.equal(historyDir(tempDir), path.join(tempDir, 'treekeeper'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'kill')
  assert.equal(rows[0].pid, 42)
  assert.ok(Number.isFinite(rows[0].at))
})

// 存储与面板、webserver 共用宿主进程，因此每次读写都走 fs/promises：轮换要把
// 整个文件读回来，同步读取会在这期间卡住每个请求都要用的那个线程。
test('history store appends and reads without blocking the thread that owns it', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  const store = new HistoryStore(tempDir)
  await Promise.all([
    store.append({ kind: 'findings', count: 1 }),
    store.append({ kind: 'findings', count: 2 })
  ])

  const rows = await store.last()
  assert.deepEqual(rows.map((row) => row.count).sort(), [1, 2], 'every concurrent append lands')
})

test('history store survives an unwritable target instead of breaking sampling', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  // 文件占住了存储期望的目录位置：mkdir 与追加都会失败。
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-blocked-'))
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }))
  fs.writeFileSync(path.join(blocked, 'treekeeper'), '')

  const store = new HistoryStore(blocked)
  await store.append({ kind: 'kill', pid: 7 })
  assert.deepEqual(await store.last(), [], '历史记录尽力而为，永不致命')
  // 尽力而为不等于沉默：丢掉一条终止记录是数据完整性问题，`degraded` 让接口能
  // 把“没有历史”与“历史没有被写入”分开说明。
  assert.ok(String(store.degraded).includes('append'), String(store.degraded))
})

// 不依赖文件系统来验证双通道：读取非目录路径下的文件时返回 ENOENT（不计失败）
// 还是 ENOTDIR（计读失败）因平台而异，因此直接断言优先顺序——写失败优先于读
// 失败，之后的读失败也盖不掉它。
test('a read failure cannot overwrite a write failure', (t) => {
  t.mock.method(console, 'error', () => {})
  // 没有文件系统参与：只验证两个通道与其优先顺序。
  const store = new HistoryStore(path.join(os.tmpdir(), 'treekeeper-channels-only'))
  store.noteFailure('append', { code: 'EPERM', message: 'append boom' })
  store.noteFailure('read', { code: 'ENOTDIR', message: 'read boom' })
  assert.match(String(store.degraded), /^append: EPERM/, String(store.degraded))

  // 写通道由它自己的成功清除，与读通道无关；剩下的是读失败——被报告出来，不会
  // 被吞掉。
  store.noteRecovered('write')
  assert.match(String(store.degraded), /^read: ENOTDIR/, String(store.degraded))
  store.noteRecovered('read')
  assert.equal(store.degraded, null)
})

// 保留两个 catch 的理由：无法写入的存储与空存储都会返回 `rows: []`，从结果上
// 看不出区别。
test('a write failure is stated once, and stated again when it clears', async (t) => {
  const logged = []
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const store = new HistoryStore(dir)
  // 历史文件的位置被一个目录占住：每次追加都以同样的方式失败。
  fs.mkdirSync(path.join(dir, 'treekeeper'), { recursive: true })
  fs.mkdirSync(store.file)
  await store.append({ kind: 'kill', pid: 7 })
  await store.append({ kind: 'kill', pid: 8 })
  await store.append({ kind: 'kill', pid: 9 })

  assert.ok(String(store.degraded).startsWith('append'), String(store.degraded))
  assert.equal(logged.filter((line) => line.includes('degraded')).length, 1,
    '每次状态变化写一行，而不是每次尝试写一行——否则后台轮询会淹没宿主日志')

  fs.rmSync(store.file, { recursive: true })
  await store.append({ kind: 'kill', pid: 10 })
  assert.equal(store.degraded, null, '重新能写入的存储不再声称自己失败')
  assert.ok(logged.some((line) => line.includes('recovered')), logged.join('\n'))
  assert.deepEqual((await store.last()).map((row) => row.pid), [10])
})

test('reading history tells an empty store apart from an unreadable one', async (t) => {
  const logged = []
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))

  // 首次运行：还没有文件是约定的空结果，不是故障。
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(freshDir, { recursive: true, force: true }))
  const fresh = new HistoryStore(freshDir)
  assert.deepEqual(await fresh.last(), [])
  assert.equal(fresh.degraded, null)
  assert.deepEqual(logged, [], '文件不存在不能被报告成损坏')

  // 同样的空答案，不同的事实：路径是一个目录，存在的审计记录读不出来。把这个
  // 差别说出来就是全部意义。
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }))
  fs.mkdirSync(path.join(blocked, 'treekeeper'), { recursive: true })
  fs.mkdirSync(path.join(blocked, 'treekeeper', 'history.jsonl'))
  const unreadable = new HistoryStore(blocked)
  assert.deepEqual(await unreadable.last(), [])
  assert.ok(String(unreadable.degraded).startsWith('read'), String(unreadable.degraded))
  assert.ok(logged.some((line) => line.includes('degraded')))
})
