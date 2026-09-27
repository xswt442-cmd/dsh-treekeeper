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
    // Append and rotate are serialized through one chain: rotation does
    // stat→read→write while appends write, and the background poll timer plus
    // concurrent kill requests can both append. Interleaved, a line can land
    // after truncation and be lost, or land on top of truncated content.
    this.queue = Promise.resolve()
    // `null` while the store is writing what it reads back; otherwise the last
    // failure, so a caller can tell "no history yet" from "history is unwritable".
    this.degraded = null
  }

  /**
   * Record a failure without breaking sampling over it. Logging is per state
   * change, not per attempt: a background poll that cannot write would otherwise
   * add a line to the host log on every tick, and the flood would bury the one
   * line that says what broke.
   */
  noteFailure(context, cause) {
    const detail = `${context}: ${String((cause && cause.code) || 'Error')}: ${String((cause && cause.message) || cause)}`
    if (this.degraded === detail) return
    this.degraded = detail
    console.error(`treekeeper: history store degraded - ${detail}`)
  }

  noteRecovered() {
    if (this.degraded === null) return
    console.error(`treekeeper: history store recovered from ${this.degraded}`)
    this.degraded = null
  }

  append(record) {
    const run = this.queue.catch(() => {})
    this.queue = run.then(() => this.appendNow(record))
    return this.queue
  }

  async appendNow(record) {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      await fs.appendFile(this.file, JSON.stringify({ at: Date.now(), ...record }) + '\n')
      await this.rotateIfNeeded()
      this.noteRecovered()
    } catch (cause) {
      // History stays best-effort — never fail a sample over its audit trail —
      // but a lost kill record is a data-integrity fact and has to be said.
      this.noteFailure('append', cause)
    }
  }

  async rotateIfNeeded() {
    let size = 0
    try { size = (await fs.stat(this.file)).size } catch (cause) {
      // A file that is not there yet is the normal first run, not a degradation.
      if (cause && cause.code !== 'ENOENT') this.noteFailure('rotate-stat', cause)
      return
    }
    if (size <= MAX_BYTES) return
    try {
      const lines = (await fs.readFile(this.file, 'utf8')).trim().split('\n')
      const keep = lines.slice(Math.floor(lines.length / 2)).slice(-KEEP_ROWS)
      await fs.writeFile(this.file, keep.length ? keep.join('\n') + '\n' : '')
    } catch (cause) {
      this.noteFailure('rotate-write', cause)
      // next append retries
    }
  }

  async last(n = 50) {
    try {
      const lines = (await fs.readFile(this.file, 'utf8')).trim().split('\n')
      return lines.slice(-n).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch (cause) {
      // Missing is the documented empty case. Anything else — a permission
      // problem, a directory in the way, a read error — would read as "nothing
      // has ever happened" while the audit trail is still on disk.
      if (!(cause && cause.code === 'ENOENT')) this.noteFailure('read', cause)
      return []
    }
  }
}
