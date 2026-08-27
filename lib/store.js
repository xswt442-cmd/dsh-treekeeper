// Bounded local history for leak findings, persisted under
// $DSH_HOME/treekeeper/history.jsonl. One JSON object per line; the file is
// size-capped and rotated by dropping the oldest half. Deliberately not
// SQLite — P0 wants zero moving parts (upgrade path documented in
// testplace/dsh-treekeeper-what-to-do.md §12).

import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024
const KEEP_ROWS = 2000

export function historyDir(dshHome) {
  return path.join(dshHome, 'treekeeper')
}

export class HistoryStore {
  constructor(dshHome) {
    this.dir = historyDir(dshHome)
    this.file = path.join(this.dir, 'history.jsonl')
  }

  append(record) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.file, JSON.stringify({ at: Date.now(), ...record }) + '\n')
      this.rotateIfNeeded()
    } catch {
      // History is best-effort; never break sampling over it.
    }
  }

  rotateIfNeeded() {
    let size = 0
    try { size = fs.statSync(this.file).size } catch { return }
    if (size <= MAX_BYTES) return
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n')
      const keep = lines.slice(Math.floor(lines.length / 2)).slice(-KEEP_ROWS)
      fs.writeFileSync(this.file, keep.length ? keep.join('\n') + '\n' : '')
    } catch {
      // next append retries
    }
  }

  last(n = 50) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n')
      return lines.slice(-n).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch {
      return []
    }
  }
}
