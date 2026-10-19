# dsh-treekeeper

[中文](./README.md) | [English](./README.en.md)

[![ci](https://github.com/xswt442-cmd/dsh-treekeeper/actions/workflows/compat.yml/badge.svg?branch=main)](https://github.com/xswt442-cmd/dsh-treekeeper/actions/workflows/compat.yml)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=plugin&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/dsh-treekeeper?label=npm&color=4d6bfe)](https://www.npmjs.com/package/dsh-treekeeper)
[![release](https://img.shields.io/github/v/release/xswt442-cmd/dsh-treekeeper?label=release&color=16a3a3)](https://github.com/xswt442-cmd/dsh-treekeeper/releases)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=%3E%3D0.1.5-rc.3&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D20&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![downloads](https://img.shields.io/npm/d18m/dsh-treekeeper?label=downloads&logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-treekeeper)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

面向 Windows 的 DSH 进程树对账与治理插件。它把当前宿主进程树与可用任务账本并列，把每个进程归属到创建它的任务，标出未归属与孤儿进程，并提供受保护的整树终止。

## 功能

- 采样当前 DSH 宿主的进程树，启动器的其他子进程不归入该树。
- 把每个进程归属到创建它的任务，并检测重复命令、孤儿进程与长时间运行的插件子进程。
- 对照任务账本与根 session 的 subagent 子代理树，其他 session 的子代理树不读取。
- 以终端会话报告的 pid 作为精确归因锚点，终端里跑着的进程归到 `pty` 根下并标为不可终止。
- 跨会话普查：列出全部 session 的存活子代理，而不只是当前选中的那一棵。
- 子代理驻留级：`running` / `idle-resident` / `idle-parked`，取自 turn 时长投影而非 store 归属。
- 释放驻留子代理：归还它的容量槽。in-process 的 spawn / fork 子代理是同进程里的一个 Agent，没有可杀的 OS 进程，因此释放走宿主原语而不是 `taskkill`。默认关闭。
- 受保护的整树终止（`taskkill /T /F`），条件列在安全与边界的终止护栏表中。
- 从命令行中的 `node_modules` 路径识别进程所属插件，findings 与终止操作历史写入记录文件。
- DSH 宿主子进程分区默认收起，数量显示在标题上。
- 面板头部显示宿主类型，取自宿主进程的可执行路径与命令行，进程环境不作为判据。
- 桌面应用自身的 Electron 进程在未归属分区内单列为一个进程组，组内成员各自保留命令行、进程号、内存与运行时长。
- finding 的置信度分三档：`exact` 由宿主进程树归属支撑，可作为树杀目标；`indicative` 有真实的进程事实而归属链较弱或缺失（降级采样，或上一个宿主留下的幸存进程）；`inferred` 只由启发式规则得出，不可作为目标。
- 页面左下的 `dsh-mini-utility-dock` launcher 打开全局面板，会话标题栏打开面板并聚焦该 session，侧栏会话行显示该 session 已缓存的事实。

## 安装

```powershell
# 从 npm 安装并注册到 web profile（推荐）
dsh plugin --profile web add dsh-treekeeper

# 仅安装 npm package
npm install dsh-treekeeper

# 或从 GitHub 安装
dsh plugin --profile web add github:xswt442-cmd/dsh-treekeeper
```

- `npm install` 只安装 package，不注册 DSH profile。
- 重启 DSH Web 后生效。

## 会话范围

Subagent 分区有三种状态：

| 状态 | 含义 |
| --- | --- |
| `available` | 显示根 session 的完整子代理树 |
| `root-required` | 没有可用的根 session |
| `unavailable` | 当前 DSH 构建未提供 subagents 能力 |

会话标题栏入口的根 session 是该行的 sessionId，全局面板入口取当前选中的 session。

面板加载一次快照后，可归属到具体 session 的事实进入客户端缓存：

| 缓存内容 | 归属依据 |
| --- | --- |
| 子代理数、运行中数、读取异常数 | 响应的 `subagentRoot` 与其子代理行 |
| 运行中 job 数 | 账本行的 `ownerSession` |
| finding 数 | 账本关联填入的 `ownership.session` |

宿主进程清单、未归属进程与无主 job 无法归属到 session，不进入缓存。

侧栏会话行读取这份缓存：空闲行的前导格显示一个图标，悬浮卡片显示一行摘要与「在 TreeKeeper 中查看此会话」的入口。该 session 没有缓存时前导格留空，卡片入口仍然可用；两者只读取缓存，不发起宿主读取。

## 配置

配置仅在当前进程中生效，重启后恢复默认值。

| 字段 | 默认值 | 取值范围 | 作用 |
| --- | ---: | --- | --- |
| `pollMs` | `0` | `0`（按请求采样）或 2000–600000 ms | 后台采样间隔 |
| `allowKill` | `true` | 布尔值 | 受保护的进程树终止开关 |
| `allowRelease` | `false` | 布尔值 | 驻留子代理释放开关，与 `allowKill` 分开 |
| `residencyThresholdMs` | `0` | `0`（关闭）或 60000–86400000 ms | 子代理累计 turn 时长越过该值才升级为发现 |
| `extraWhitelistPids` | `[]` | PID 数组 | 额外受保护的 PID |

## 子代理驻留

面板显示的驻留级是可观测事实，不是告警：

| 驻留级 | 含义 |
| --- | --- |
| `running` | 投影里有未闭合的 turn |
| `idle-resident` | turn 已结算，Agent 仍存活。它占着容量槽，且可以被 `send_message` 继续 |
| `idle-parked` | 子会话已不在 store 中，容量槽已经归还 |
| 无判定 | 宿主没有提供 `sessionQuery`，或投影读不出来 |

**驻留不等于泄漏。** 驻留本身是设计：空闲的子代理可以被继续对话，因此默认不把它报成发现。只有累计 turn 时长越过 `residencyThresholdMs` 才升级，阈值默认关闭，由你决定多久算太久。

阈值建立在投影能回答的量上：`subagentTiming` 的 `settledMs` 是已完成 turn 的累计时长，当前 turn 的时长由 `now - active.since` 得出。投影没有记录「最后一个 turn 何时结束」，因此空闲了多久算不出来，判定不建立在空闲时长上。

面板只报「驻留 N / 空闲 M」，不报容量上限：`ctx.subagents.maxActiveSubagents` 是 Volatile 且 private 的配置，读不到。

只有 agents 谱系里活着的子代才读投影；`listDescendants` 的诊断行没有子会话可读，被跳过。

## 驻留子代理释放

释放与树杀是两种不同的处置：

- **释放**归还一个驻留子代理占着的容量槽（默认容量 8，按顶层会话一个池）。它走宿主公开原语 `drainChildren`。释放之后这个子代理不能再被 `send_message` 继续。
- **停止当前 turn** 只停当前这一轮，不释放驻留。子代理仍然占着容量槽，仍然可以被继续对话。本插件不做这个动作。

驻留子代理可能根本没有对应的 OS 进程——in-process 的 `spawn` / `fork` 子代理就是宿主进程里的一个 Agent。因此释放**不会**附带任何 `taskkill`：树杀会连带结束它自己的后代树，而那与释放无关。

释放护栏：

| 护栏 | 规则 |
| --- | --- |
| 开关 | `allowRelease` 默认关闭，与 `allowKill` 分开；打开终止开关不打开释放开关 |
| 确认 | 第一次点击进入待确认（6 秒），第二次点击弹出确认框 |
| 父 | 父必须是注册表里精确存活的 Agent |
| 直接子代 | 目标必须是该父的直接子代，用 agents 谱系核 |
| 父会话来源 | 父会话由服务端谱系反查，请求体里的 `parentId` 不参与判定 |
| 读面 | 只读 `session.header` 的 `parentSession` / `origin` 与 `Agent.status`，不读会话内容，不读日志 |

插件不报容量上限数字：`ctx.subagents.maxActiveSubagents` 是 Volatile 配置且为 private，读不到。

## 安全与边界

| 项 | 边界 |
| --- | --- |
| 平台 | 仅支持 Windows |
| 非 Windows | 报告 `unsupported_platform` |
| 采样降级 | CIM 不可用时降级为只读采样，归属与终止禁用 |
| 浏览器凭据 | DSH 0.1.0-rc.7+ 复用 Connection 的签名 cookie |
| 准入：宿主有 Connection | 由 Connection 的 Host/Origin 校验与签名 cookie 决定 |
| 准入：宿主无 Connection | 由本插件守卫按 TCP 对端地址、Fetch Metadata、Origin 与 loopback Host 判定 |
| 写操作 | 仅接受 POST |
| 遍历取消 | 页面关闭、刷新被替代或 HTTP 断开时，进行中的 subagent 子代理树遍历与跨会话普查收到取消信号 |
| 远端可达 | 宿主配置 `trustedHosts` 且在非回环地址上监听时，持有有效浏览器会话的远端可调用包括 `kill` 在内的接口 |
| 准入收窄 | 本插件不额外收窄宿主的 Connection 准入，终止护栏在该情形下同样适用 |

终止护栏：

| 护栏 | 规则 |
| --- | --- |
| 激活 | 第一次点击激活按钮，6 秒内有效 |
| 确认 | 第二次点击弹出浏览器确认框 |
| 快照 | 要求 15 秒内的完整快照 |
| 身份核对 | 请求进入时按快照核对 PID 创建时间 |
| 执行前复核 | 重新采样，再核对一次创建时间 |
| 归属 | 仅归属根为 DSH 宿主的进程可终止，未归属进程只用于排查 |
| 终端归属 | 归因到终端会话 pty 的进程与其整棵后代子树不可终止 |
| 不可终止 | 系统关键进程、当前宿主、启动链与 `extraWhitelistPids` |
| 白名单 | 额外白名单 PID 只作为排查用的归属根，其子进程可见但不可终止 |
| 受保护子进程 | 终止前即时采样的树含任一受保护 PID 时，整个操作被拒绝 |

即时采样之后新出现的受保护子进程无法排除。

- Jobs 与 OS 进程之间没有稳定的 PID 映射。
- 命令行匹配只用于排查，不触发自动操作。
- Findings 与终止结果写入 `$DSH_HOME/treekeeper/history.jsonl`。

## 终端会话归属

任务账本与操作系统之间没有稳定的 pid 映射，因此对账默认用 label 近似命令行，结论是 `indicative`。

终端会话是唯一的例外：`ctx.terminals.list(owner)` 返回的快照带 `pid`，这是 DSH 愿意把 pid 交给插件的唯一一处。这些 pid 作为新的归因根参与同一次多源归因，因此终端会话的**整个后代子树**都带上 `rootLabel: 'pty'`——终端里跑起来的进程都在 pty 下面，只标 pty 自己那一行是不够的。

命中该 pid 的任务行不再是 `indicative`，它标为 `via: 'pty-pid'`：label 匹配是两条命令行文本互相包含，而这里是 DSH 自己报告的 pid 相同。

**归因到 `pty` 的进程不可终止。** 终端里跑着的 dev server、watcher、`npm install` 正被一个活着的 PTY 合法拥有，把它们当成宿主树的残留去结束，等于结束用户正在用的东西。整棵终端归属子树都由那个 pty 拥有，因此 pty 根与它下面的每一行都带拒绝码 `pty_owned`。

本宿主不提供终端会话清单时，上面这条路径整体不出现：没有 `pty` 归因根，`FINDING_VIA` 里也不会有 `pty-pid`，对账的形态与之前一致。

## 开发

首次检出后运行 `npm install`。提交前的完整检查见 [AGENTS.md 的 Verify 一节](./AGENTS.md#verify)。

## License

[MIT](./LICENSE)
