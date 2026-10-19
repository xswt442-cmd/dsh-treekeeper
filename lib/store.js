// 有界的本地泄漏发现历史，保存在 $DSH_HOME/treekeeper/history.jsonl。每行一个
// JSON 对象；文件达到大小上限后丢弃最早的一半完成轮换。这里不用 SQLite：
// 数据量就是一次 JSONL 追加，没有需要维护的部件。
//
// 所有操作都是异步的。本模块运行在宿主进程里，同一个线程还要回答其他所有请求：
// 轮换需要把整个文件读回来，同步读取会在这次多兆字节的读取期间占住该线程，
// 面板、代理与 webserver 都只能排在后面。

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
    // 追加与轮换串在同一条链上：轮换要依次做 stat、读取、写回，而追加在写，
    // 后台轮询定时器与并发的终止请求都会追加。交错执行时，一行可能写在截断
    // 之后而丢失，也可能盖在已被截断的内容上。
    this.queue = Promise.resolve()
    // 两个通道对应两个不同的问题：写失败说明审计记录没有保留下来（数据完整性
    // 问题），读失败说明记录无法展示。合并成一个槽位会丢掉更要紧的那一个；而
    // 真正要紧的故障往往两边同时失败——路径被一个目录占住时，每次追加和每次
    // 读取都失败，单槽位报告的是最后运行的那一次。读端在面对这种路径时返回
    // ENOENT 还是 ENOTDIR 取决于平台，单槽位会让同一故障在不同机器上给出不同
    // 的说明。
    this.writeFailure = null
    this.readFailure = null
  }

  /** 交给需要区分“没有历史”与“历史不可用”的调用方：写失败优先，因为那是丢失。 */
  get degraded() {
    return this.writeFailure || this.readFailure
  }

  /**
   * 记录一次失败，但不因此中断采样。只在状态变化时写日志：否则一个无法写入
   * 的后台轮询会每个周期往宿主日志里加一行，把说明问题的那一行埋掉。
   */
  noteFailure(context, cause) {
    const channel = context === 'read' ? 'readFailure' : 'writeFailure'
    const detail = `${context}: ${String((cause && cause.code) || 'Error')}: ${String((cause && cause.message) || cause)}`
    if (this[channel] === detail) return
    this[channel] = detail
    console.error(`treekeeper: history store degraded - ${detail}`)
  }

  noteRecovered(channel = 'write') {
    const field = channel === 'read' ? 'readFailure' : 'writeFailure'
    const previous = this[field]
    if (previous === null) return
    console.error(`treekeeper: history store recovered from ${previous}`)
    this[field] = null
  }

  append(record) {
    this.queue = this.queue.then(() => this.appendNow(record))
    return this.queue
  }

  async appendNow(record) {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      await fs.appendFile(this.file, JSON.stringify({ at: Date.now(), ...record }) + '\n')
      await this.rotateIfNeeded()
      this.noteRecovered()
    } catch (cause) {
      // 历史记录尽力而为，绝不因为审计轨迹而让一次采样失败；但丢掉的终止记录
      // 是数据完整性问题，必须说出来。
      this.noteFailure('append', cause)
    }
  }

  async rotateIfNeeded() {
    let size = 0
    try { size = (await fs.stat(this.file)).size } catch (cause) {
      // 文件还不存在是正常的首次运行，不算降级。
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
      // 下一次追加会再试一次
    }
  }

  async last(n = 50) {
    try {
      const lines = (await fs.readFile(this.file, 'utf8')).trim().split('\n')
      this.noteRecovered('read')
      return lines.slice(-n).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch (cause) {
      // 文件不存在是约定的空结果。其他原因——权限问题、路径被目录占住、读取
      // 出错——若也返回空列表，读者会以为从来没有发生过任何事，而审计记录其
      // 实还在磁盘上。
      if (!(cause && cause.code === 'ENOENT')) this.noteFailure('read', cause)
      return []
    }
  }
}
