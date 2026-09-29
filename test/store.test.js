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

// The store shares the host process with the panel and the webserver, so every
// read and write goes through fs/promises: a rotation reads the whole file
// back, and a synchronous read would block the thread every request waits on.
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
  // A file where the store expects its directory: mkdir and append both fail.
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-blocked-'))
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }))
  fs.writeFileSync(path.join(blocked, 'treekeeper'), '')

  const store = new HistoryStore(blocked)
  await store.append({ kind: 'kill', pid: 7 })
  assert.deepEqual(await store.last(), [], 'history is best-effort, never fatal')
  // Best-effort is not silent: a lost kill record is a data-integrity fact, and
  // `degraded` is how the API can say "there is no history" apart from "history
  // is not being written".
  assert.ok(String(store.degraded).includes('append'), String(store.degraded))
})

// The channel split, stated without leaning on the file system: whether reading a
// path under a non-directory answers ENOENT (no failure noted) or ENOTDIR (a read
// failure) differs between platforms, so the ordering rule is asserted directly —
// a lost write outranks a failed read, and a later read failure cannot hide it.
test('a read failure cannot overwrite a write failure', (t) => {
  t.mock.method(console, 'error', () => {})
  // No file system involved: only the two channels and their precedence.
  const store = new HistoryStore(path.join(os.tmpdir(), 'treekeeper-channels-only'))
  store.noteFailure('append', { code: 'EPERM', message: 'append boom' })
  store.noteFailure('read', { code: 'ENOTDIR', message: 'read boom' })
  assert.match(String(store.degraded), /^append: EPERM/, String(store.degraded))

  // The write channel clears on its own success, whatever the read channel says,
  // and the read failure is then what remains — reported, not swallowed.
  store.noteRecovered('write')
  assert.match(String(store.degraded), /^read: ENOTDIR/, String(store.degraded))
  store.noteRecovered('read')
  assert.equal(store.degraded, null)
})

// The whole point of keeping the two catches: a store that cannot write and a
// store that has nothing in it look identical from `rows: []`.
test('a write failure is stated once, and stated again when it clears', async (t) => {
  const logged = []
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const store = new HistoryStore(dir)
  // A directory sitting on the history file: every append fails the same way.
  fs.mkdirSync(path.join(dir, 'treekeeper'), { recursive: true })
  fs.mkdirSync(store.file)
  await store.append({ kind: 'kill', pid: 7 })
  await store.append({ kind: 'kill', pid: 8 })
  await store.append({ kind: 'kill', pid: 9 })

  assert.ok(String(store.degraded).startsWith('append'), String(store.degraded))
  assert.equal(logged.filter((line) => line.includes('degraded')).length, 1,
    'one line per state change, not one per attempt — a background poll would otherwise flood the host log')

  fs.rmSync(store.file, { recursive: true })
  await store.append({ kind: 'kill', pid: 10 })
  assert.equal(store.degraded, null, 'a store that writes again stops claiming otherwise')
  assert.ok(logged.some((line) => line.includes('recovered')), logged.join('\n'))
  assert.deepEqual((await store.last()).map((row) => row.pid), [10])
})

test('reading history tells an empty store apart from an unreadable one', async (t) => {
  const logged = []
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))

  // First run: no file yet is the documented empty answer, not a failure.
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(freshDir, { recursive: true, force: true }))
  const fresh = new HistoryStore(freshDir)
  assert.deepEqual(await fresh.last(), [])
  assert.equal(fresh.degraded, null)
  assert.deepEqual(logged, [], 'a missing file must not be reported as damage')

  // Same answer, different fact: the path is a directory, so the audit trail that
  // exists cannot be read. Saying so is the whole difference.
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }))
  fs.mkdirSync(path.join(blocked, 'treekeeper'), { recursive: true })
  fs.mkdirSync(path.join(blocked, 'treekeeper', 'history.jsonl'))
  const unreadable = new HistoryStore(blocked)
  assert.deepEqual(await unreadable.last(), [])
  assert.ok(String(unreadable.degraded).startsWith('read'), String(unreadable.degraded))
  assert.ok(logged.some((line) => line.includes('degraded')))
})
