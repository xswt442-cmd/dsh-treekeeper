// Bounded local history for leak findings, persisted under
// $DSH_HOME/treekeeper/history.jsonl. One JSON object per line; the file is
// size-capped and rotated by dropping the oldest half. Deliberately not
// SQLite — zero moving parts, and the volume is a JSONL append.
//
// Every operation is async. This module runs inside the harness host process,
// whose single thread also answers every other request: rotation reads the
// whole file back, so doing that synchronously held that thread for a
// multi-megabyte read while the panel, the agent and the webserver waited
// behind it.

import fs from 'node:fs/promises'
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

  async append(record) {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      await fs.appendFile(this.file, JSON.stringify({ at: Date.now(), ...record }) + '\n')
      await this.rotateIfNeeded()
    } catch {
      // History is best-effort; never break sampling over it.
    }
  }

  async rotateIfNeeded() {
    let size = 0
    try { size = (await fs.stat(this.file)).size } catch { return }
    if (size <= MAX_BYTES) return
    try {
      const lines = (await fs.readFile(this.file, 'utf8')).trim().split('\n')
      const keep = lines.slice(Math.floor(lines.length / 2)).slice(-KEEP_ROWS)
      await fs.writeFile(this.file, keep.length ? keep.join('\n') + '\n' : '')
    } catch {
      // next append retries
    }
  }

  async last(n = 50) {
    try {
      const lines = (await fs.readFile(this.file, 'utf8')).trim().split('\n')
      return lines.slice(-n).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch {
      return []
    }
  }
}
