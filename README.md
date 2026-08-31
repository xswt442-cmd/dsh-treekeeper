# dsh-treekeeper

[中文](./README.md) | [English](./README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-treekeeper)](https://www.npmjs.com/package/dsh-treekeeper)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

DSH Web 运行时进程树对账插件。它采样当前 DSH 宿主的 OS 进程后代，将其与可用的后台任务账本并列展示，标出疑似泄漏、孤儿进程和未归属进程；高风险操作受多重校验保护。

## 功能

- **宿主进程树**：只归属当前 DSH 宿主的后代；启动器祖先用于保护，不会把其兄弟进程误归入宿主。
- **异常发现**：检测重复命令行、父进程已退出的孤儿进程和长时间存活的插件子进程。
- **账本对照**：通过 DSH 的 owner fence 列出未归属任务和所有活动 session 的 jobs，并作指示性命令行匹配。任务账本不含 PID，不作为终止依据。
- **子代理树**：对当前 session 调用 `subagents.listDescendants()`，显示持久化父子关系、深度、模式和活动状态，不唤醒冷 session。
- **插件归因**：从 `node_modules/<package>/` 命令行路径识别插件来源。
- **受控树杀**：对已确认的进程树执行 `taskkill /T /F`；PID 创建时间、受保护名称、宿主/启动链白名单和新鲜完整快照均为必经校验。
- **共享工具坞**：与 dsh-instance-manager 通过页面内版本化协议共用主内容区左下的 Utility Dock，无额外前置插件。

## 安装

```powershell
dsh plugin --profile web add dsh-treekeeper
# 或 Git 直装
dsh plugin --profile web add github:xswt442-cmd/dsh-treekeeper
```

安装后重启 DSH Web。点击主内容区左下的 TreeKeeper 入口打开面板。

## 工作原理

主机端注册同源 API：`/dsh-treekeeper/api`。

| 动作 | 方法 | 说明 |
|---|---|---|
| `snapshot&rootSessionId=` | GET | 采样进程、归属、异常发现、可用任务账本和指定 session 的子代理树；OS 快照 2 秒内复用 |
| `jobs` | GET | 返回未归属和所有活动 owner 可见的 jobs |
| `subagents&rootSessionId=` | GET | 返回指定 session 的完整持久化子代理树 |
| `subtree&pid=` | GET | 返回指定 PID 的当前进程子树 |
| `history` | GET | 返回最近 100 条本地异常和操作记录 |
| `config` | POST | 更新运行期采样间隔、树杀开关和额外白名单 PID |
| `kill` | POST | 以 `{ pid, seenCreatedMs }` 终止已验证的进程树 |

进程采样优先使用 Windows CIM；CIM 不可用时降级为 `tasklist`。降级模式没有父进程链，归属和树杀会被禁用并在面板中显示。

## 安全模型

- API 只接受 loopback 同源请求：校验 Fetch Metadata、`Origin` 和 `Host`，防止跨站调用与 DNS rebinding。
- 变更动作只接受 POST。
- 树杀要求 15 秒内的完整快照；服务端重新核验 PID 创建时间，避免 PID 复用。
- 系统关键进程名、当前 DSH 宿主、启动链和用户配置的白名单 PID 均不可终止。
- 操作完成后复查进程存活状态，并将异常与终止结果追加至 `$DSH_HOME/treekeeper/history.jsonl`。

## 配置

`config` 为运行期配置，实例重启后恢复默认值。

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `pollMs` | `0` | 后台采样间隔（毫秒）；`0` 表示仅在请求时采样，最小有效值为 `2000` |
| `allowKill` | `true` | 是否允许树杀 |
| `extraWhitelistPids` | `[]` | 额外保护的 PID 列表 |

重复命令行告警阈值固定为 3 份；长时间存活插件子进程阈值固定为 30 分钟。

## 平台与边界

- 当前支持 Windows；其他平台不提供进程采样。
- 进程归属基于 OS 父子关系。绕过 DSH 子进程接口创建的进程仍可见，但不一定能关联到具体任务。
- 任务账本与 OS 进程没有稳定 PID 关联；命令行匹配仅用于排查，不会自动终止进程。

## 结构

```
package.json       npm 元数据与 DSH 声明
cordis.patch.yml   profile loader 补丁
lib/index.js       宿主 API 与运行期状态
lib/client.js      Utility Dock 入口与面板
lib/sampler.js     Windows 进程采样
lib/attribute.js   进程归属与子树计算
lib/leak.js        异常发现规则
lib/act.js         受控树杀
lib/ledger.js      DSH jobs owner 账本与 subagent 树适配
test/              node:test 测试
```

## License

[MIT](./LICENSE)
