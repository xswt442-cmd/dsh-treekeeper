# dsh-treekeeper

DeepSeek Harness 的运行时进程树对账与治理插件。

**状态：开发中（骨架）。** 纯函数核心（归属算法、泄漏启发式）已测试；宿主联调未完成，见下方「现状」。

## 问题

DSH 的任务与子代理接缝不携带 OS PID：一个后台 bash 或子代理在系统里留下了哪些进程、是否泄漏、归谁所有，账本本身不回答。

## 做什么

- **进程树归属**：周期采样本机进程表，只沿当前 DSH host PID 向下归属；无法归入的进入「未归属桶」；启动器祖先仅用于保护，不会误归属其兄弟进程；
- **泄漏启发式**：相同命令行 ≥N 份、父进程已死的存活进程、归属插件但超长存活的子进程；
- **账本对照（可选）**：实现提供时读取未归属 jobs，并以命令行做指示性关联；`JobSnapshot` 不含 pid，绝不据此终止进程；
- **插件审计**：命令行含 `node_modules/<pkg>/` 的进程归因到来源插件；
- **树杀**：`taskkill /T` 前做创建时间预检（防 pid 复用）、系统进程与自身进程树白名单拒绝、客户端二次确认，杀后复查。

## 现状

已实现：

- 采样器（Windows CIM；失败时降级 `tasklist`，降级时归属停用并明示）；
- 归属与泄漏启发式（纯函数，`node --test` 覆盖）；
- 宿主路由 `/dsh-treekeeper/api`（snapshot / jobs / subtree / history / kill / config）；快照返回 `exact` / `unattributed` 证据等级；
- 浏览器浮层面板（告警、未归属桶、任务账本、两步确认树杀）。

未验证 / 未完成：

- 宿主进程内 CIM 可用性、webServer 路由和面板插槽——待宿主联调；
- 子代理谱系使用 `ctx.subagents.listDescendants(rootSessionId)`；尚未接入 API/UI，且只支持明确 root session；
- 未发布到 npm，未提交 awesome-dsh-plugin 收录。

## 安全模型

- `/api` 同源守卫（Fetch Metadata + Origin + loopback Host），变更动作仅 POST；
- 树杀服务端四道闸：15 秒内完整快照、创建时间必填且复检、白名单/系统进程黑名单、杀后复查；动作写入本地历史文件；
- 只读采样 + 显式杀进程；不读会话正文，数据不出本机。

## 平台与边界

- Windows 优先；非 Windows 采样未实现；
- 绕过 `ctx.subprocess` 直接创建的进程只能由 OS 层兜底可见；
- 与 macOS/Linux：路线图。

## License

MIT
