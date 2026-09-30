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
- 对照任务账本与根 session 的 subagent 后代树，其他 session 的后代树不读取。
- 受保护的整树终止（`taskkill /T /F`），条件列在安全与边界的终止护栏表中。
- 从命令行中的 `node_modules` 路径识别进程所属插件，findings 与终止操作历史写入记录文件。
- DSH 宿主后代分区默认收起，数量显示在标题上。
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
| `available` | 显示根 session 的完整后代树 |
| `root-required` | 没有可用的根 session |
| `unavailable` | 当前 DSH 构建未提供 subagents 能力 |

会话标题栏入口的根 session 是该行的 sessionId，全局面板入口取当前选中的 session。

面板加载一次快照后，可归属到具体 session 的事实进入客户端缓存：

| 缓存内容 | 归属依据 |
| --- | --- |
| 后代数、运行中数、读取异常数 | 响应的 `subagentRoot` 与其后代行 |
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
| `extraWhitelistPids` | `[]` | PID 数组 | 额外受保护的 PID |

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
| 远端可达 | 宿主配置 `trustedHosts` 且监听 `0.0.0.0` 时，持有有效浏览器会话的远端可调用包括 `kill` 在内的接口 |
| 准入收窄 | 本插件不额外收窄宿主的 Connection 准入，终止护栏在该情形下同样适用 |
| 遍历取消 | 页面关闭、刷新被替代或 HTTP 断开时，进行中的 subagent 后代遍历收到取消信号 |

终止护栏：

| 护栏 | 规则 |
| --- | --- |
| 激活 | 第一次点击激活按钮，6 秒内有效 |
| 确认 | 第二次点击弹出浏览器确认框 |
| 快照 | 要求 15 秒内的完整快照 |
| 身份核对 | 请求进入时按快照核对 PID 创建时间 |
| 执行前复核 | 重新采样，再核对一次创建时间 |
| 归属 | 仅归属根为 DSH 宿主的进程可终止，未归属进程只用于排查 |
| 不可终止 | 系统关键进程、当前宿主、启动链与 `extraWhitelistPids` |
| 白名单 | 额外白名单 PID 只作为排查用的归属根，其后代可见但不可终止 |
| 受保护后代 | 终止前即时采样的树含任一受保护 PID 时，整个操作被拒绝 |

即时采样之后新出现的受保护后代无法排除。

- Jobs 与 OS 进程之间没有稳定的 PID 映射。
- 命令行匹配只用于排查，不触发自动操作。
- Findings 与终止结果写入 `$DSH_HOME/treekeeper/history.jsonl`。

## 开发

提交前运行：

```sh
npm test
npm run docs:check
npm pack --dry-run
```

## License

[MIT](./LICENSE)
