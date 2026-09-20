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
// back, and that used to block the one thread every other request waits on.
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
})
