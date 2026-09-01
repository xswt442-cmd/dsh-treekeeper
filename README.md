# dsh-treekeeper

[中文](./README.md) | [English](./README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-treekeeper)](https://www.npmjs.com/package/dsh-treekeeper)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

面向 Windows 的 DSH 进程树对账与治理插件。它将当前宿主的 OS 进程后代与可用任务账本并列展示，标出泄漏、孤儿和未归属进程，并提供受保护的进程树终止。

## 功能

- 采样当前 DSH 宿主的进程树，避免把启动器的其他子进程误归入宿主。
- 检测重复命令、孤儿进程和长时间运行的插件子进程。
- 对照 jobs 与指定 session 的 subagent 后代树，不唤醒冷 session。
- 从 Mini Utility Dock 打开全局面板，或从会话标题栏直接聚焦当前 session。
- 从命令行路径识别插件来源，并记录 findings 与操作历史。

## 安装

```powershell
# 从 npm 安装并注册到 web profile（推荐）
dsh plugin --profile web add dsh-treekeeper

# 仅安装 npm package
npm install dsh-treekeeper

# 或从 GitHub 安装
dsh plugin --profile web add github:xswt442-cmd/dsh-treekeeper
```

`npm install` 只安装 package；在 DSH 中启用仍需将 bundle 加入 profile。使用 `dsh plugin add` 可一次完成。重启 DSH Web 后生效。

## 会话范围

Subagent 分区有三种状态：

| 状态 | 含义 |
| --- | --- |
| `available` | 显示已选 session 的完整后代树 |
| `root-required` | 从 Dock 打开，尚未选择 session |
| `unavailable` | 当前 DSH 构建未提供 subagents 能力 |

会话标题栏入口始终传入明确的 session；全局入口不会猜测当前选择。

## 配置

配置仅在当前进程中生效，重启后恢复默认值。

| 字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `pollMs` | `0` | 后台采样间隔；`0` 表示按请求采样，最小有效值为 2000 ms |
| `allowKill` | `true` | 启用受保护的进程树终止 |
| `extraWhitelistPids` | `[]` | 额外保护的 PID |

## 安全与边界

- 当前仅支持 Windows；CIM 不可用时降级为只读采样，并禁用归属与终止。
- API 仅接受 loopback 同源请求；写操作仅接受 POST。
- 终止要求 15 秒内的完整快照，并重新核验 PID 创建时间。
- 系统关键进程、当前宿主、启动链和额外白名单 PID 不可终止。
- Jobs 与 OS 进程没有稳定 PID 映射；命令行匹配仅用于排查，不触发自动操作。
- Findings 与终止结果写入 `$DSH_HOME/treekeeper/history.jsonl`。

## 开发

```sh
npm test
npm run docs:check
npm pack --dry-run
```

## License

[MIT](./LICENSE)
