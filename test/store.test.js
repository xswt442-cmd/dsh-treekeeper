import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HistoryStore, historyDir } from '../lib/store.js'

test('history store keeps local append-only audit records', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekeeper-history-'))
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  const store = new HistoryStore(tempDir)
  store.append({ kind: 'kill', pid: 42, code: 'killed' })
  const rows = store.last()

  assert.equal(historyDir(tempDir), path.join(tempDir, 'treekeeper'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'kill')
  assert.equal(rows[0].pid, 42)
  assert.ok(Number.isFinite(rows[0].at))
})
