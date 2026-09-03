# 更新日志

Release Notes 由对应版本段生成；最新版本在前。
英文版见 [CHANGELOG.en.md](CHANGELOG.en.md)。

## Unreleased

### 修复

- 请求守卫改用 TCP 对端地址判定本地性：非回环来源不再能读取进程快照或执行树杀。此前伪造 `Host: 127.0.0.1` 即可通过守卫，而 DSH 支持监听 `0.0.0.0`。
- 树杀目标必须归属于 DSH 宿主树。未归属进程不再显示树杀入口，服务端同样拒绝，避免终止与 DSH 无关的进程。
- 目标树的后代包含受保护 PID（白名单或自身进程链）时拒绝执行 `taskkill /T`；此前该 PID 会被连带终止。
- 服务运行在 HTTP 默认端口 80 时，省略端口的同源 Origin（如 `http://127.0.0.1`）不再被误判为跨源。

## 0.2.1 - 2026-09-02

### 变更

- Mini Utility Dock 改由 `dsh-mini-utility-dock` 在构建时同步，插件发布物仍可独立运行。
- Dock 统一过滤外部 SVG 图标，并保留侧栏几何探测与降级定位。

## 0.2.0 - 2026-09-01

### 新增

- 会话标题栏可直接在 TreeKeeper 中打开指定 session 的 subagent 后代树，无需唤醒冷 session。
- Host 与 client 统一使用 unavailable、root-required、available 三种可用状态。

### 变更

- Findings 使用统一证据词汇，并按严重程度分层显示。

## 0.1.1 - 2026-08-31

### 新增

- 面板可读取所选 session 的完整 subagent 后代树。
- Jobs 账本通过 owner-fenced API 枚举存活 Agent，并保留无主 jobs。

### 变更

- Mini Utility Dock 使用带版本的协议和 HMR 所有权保护。
- 打开一个 Dock 面板会关闭同级面板。

### 修复

- Subagent 服务改在 DSH inject 围栏内访问。

## 0.1.0 - 2026-08-29

### 新增

- 增加可定位、可隐藏的 Mini Utility Dock 入口。

### 变更

- Client 等待 slots 服务后再挂载入口和面板。
- 改进采样状态、摘要、键盘焦点和视觉层级。

### 修复

- Kill 失败会保留在面板中。
- 进程归属以 DSH host 为根，并明确标记证据范围。
- 进程终止要求近期完整快照与可验证的创建时间。

## 0.0.1 - 2026-08-27

### 新增

- 首次发布：Windows 进程采样、宿主归属与泄漏 findings。
- 增加带创建时间校验的受控进程树终止。
- 增加浏览器面板和核心单元测试。
