// 受守卫的驻留子代释放。释放走宿主的公开原语 `drainChildren`：它释放父的若干
// **直接**子代并归还它们的容量槽（默认容量 8，按顶层会话一个池）。in-process 的
// spawn / fork 子代理是同进程里的一个 Agent，没有可杀的 OS 进程，taskkill 对它
// 完全无效——所以释放与树杀是两种不同的处置，混在一起只会让其中一种失真。
//
// 停止当前 turn 是另一件事：`interrupt` 只停 turn，不释放驻留。本模块不做它，也
// 不把它并进释放路径。
//
// 防护顺序（与 lib/act.js 同级，全部在任何宿主调用之前完成）：
//   1. 开关     —— `allowRelease` 默认关；与 `allowKill` 分开，终止授权不蕴含释放授权。
//   2. 父       —— 父必须是注册表里精确存活的 Agent，由服务端谱系反查，不接受请求体。
//   3. 直接子代 —— 用 agents 谱系核，不信任何调用方提供的父会话。
//   4. 人的确认 —— 两段式，由客户端完成；宿主只执行检查允许的操作。
//
// 纯判定不访问宿主，因此每种拒绝路径在任何平台上都能被覆盖；lib/index.js 只负责
// 收集事实。

import { parentOf, isDirectChild } from './lineage.js'

/**
 * 释放请求的第一道判定。函数是纯的并对外导出，每一种拒绝方式都不需要真实的
 * 宿主就能断言。
 *
 * @param {object} facts
 * @param {string} facts.childId - 要释放的子代会话 id。
 * @param {boolean} facts.allowRelease - 释放开关；默认关。
 * @param {object|null} facts.lineage - buildLineage() 的输出；null 表示谱系不可读。
 * @returns {{ok:boolean, code:string, parentId?:string, childId?:string}}
 */
export function decideReleaseEntry({ childId, allowRelease = false, lineage = null }) {
  if (allowRelease !== true) return { ok: false, code: 'disabled' }
  if (typeof childId !== 'string' || !childId) return { ok: false, code: 'bad_child_id' }
  if (!lineage) return { ok: false, code: 'lineage_unavailable' }
  // 父由谱系反查。请求体里的 parentId 是攻击者可控的文本，而授权边界是「这个精确
  // 存活 Agent 的直接子代」；接受调用方提供的父会让任何人释放别人的子代。
  const parentId = parentOf(lineage, childId)
  if (parentId === null) return { ok: false, code: 'child_not_found' }
  // 该子代必须确实是这个父的直接子代。谱系反查已经给出这条边，这里再核一次，让
  // 拒绝有独立于反查实现的证据。
  if (!isDirectChild(lineage, parentId, childId)) return { ok: false, code: 'not_direct_child' }
  return { ok: true, code: 'verified', parentId, childId }
}

/** 父存活由宿主在释放的那一刻核；这里给出各道拒绝的人读说明。 */
export const RELEASE_REFUSAL_TEXT = Object.freeze({
  disabled: 'resident subagent release is disabled',
  bad_child_id: 'childId must be a session id',
  lineage_unavailable: 'this DSH build does not expose the agents lineage',
  child_not_found: 'the target is not a live subagent child',
  not_direct_child: 'the target is not a direct child of its own parent',
  parent_not_live: 'the parent session is no longer live',
  release_unavailable: 'this DSH build does not expose subagent release'
})