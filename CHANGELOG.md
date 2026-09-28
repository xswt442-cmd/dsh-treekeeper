# 更新日志

Release Notes 由对应版本段生成；最新版本在前。
英文版见 [CHANGELOG.en.md](CHANGELOG.en.md)。

## Unreleased

### 安全

- 主机侧的 JSON 应答与会话 id 校验改由嵌入的 `dsh-mini-utility-dock` 片段 `dsh-host-http` 提供，`cache-control: no-store` 从此只有一个来源。
- Connection 授权收进片段构造的 `authorizeBrowser(req, res)`，不再散在路由里；出现过 Connection 之后的重载空档仍回 503，不降级到较弱的本地回环守卫。
- 兜底 500 与客户端渲染不再携带原始异常文本：响应只有固定 `code`，异常原文进宿主日志。
- 进宿主日志的请求 `action` 先折叠换行、再截断长度，一条请求伪造不出第二行日志。

### 变更

- 请求体的问题现在分得清：不是 JSON 对象回 400 `bad_json`，超出尺寸回 413 `body_too_large`，不再伪装成 409 `snapshot_required`。
- `pid` 与 `pollMs` 改走显式校验：非法值不再被折叠成 `0`，越界的轮询间隔回 400 而不是被静默接受。
- 补上进程采样（`lib/sampler.js`）的解析与降级测试：此前每道终止门都信任 `snapshot.degraded`，而它从未被测。
- 历史存储区分「还没有记录」与「记录不了」，并按状态变化各记一条日志，不再每次轮询都记。

### 维护

- 兼容 CI 增加 `pull_request` 触发，Windows 格开始跑单元测试，语法检查遍历 `lib/*.js`，矩阵去掉 `@latest` 并补上 `engines.node` 下限 Node 20。
- 发布工作流拆成 checks / npm / GitHub release 三个 job：跑本仓代码的 job 只持只读 token，tag 必须是 `main` 的祖先才能上 npm。
- npm 包补上两份 CHANGELOG 与 `LICENSE`，`package.json` 声明 author；两份 README 的徽章行最前面放兼容 CI 徽章，`README.en.md` 一处指向不存在章节名的引用已改正。
- `http:check` 进入 `npm test`；`check` 只比它所 pin 的 dock 认识的标记块，故新增块的存在与唯一性另由 `test/host-http.test.js` 断言。

- dock pin 抬到 0.6.0，四个嵌入块重新 sync（片段注释文本随之更新）；`http:check` 自此真的比对第四块。
## 0.3.2 - 2026-09-25

### 变更

- 采纳 DSH `0.1.7-rc.2` 的两个侧栏会话行座位：空闲行前导格显示一个小图标，悬浮卡片给出一行摘要与「在 TreeKeeper 中查看此会话」入口；两者只读面板写入的缓存，不产生宿主请求。
- 面板入口改用 `dsh-mini-utility-dock` 的共享 launcher 片段：左下角一个图标点开面板菜单；页面级 dock 协议与 `dock:sync` / `dock:check` 退役，面板固定在右上角。
- 最低支持 DSH 版本提高到 `0.1.5-rc.3`；兼容矩阵改为固定检查该基线与 0.1.7 线。
- 声明对宿主的兼容性：`peerDependencies` 与 `engines.dsh` 都要求 `>=0.1.5-rc.3`，peer 标 optional 以免 npm 去装宿主；宿主启动预检据此决定要不要禁用本插件。
- 修复热重载后左下角 launcher 图标消失：归属随 `dsh-mini-utility-dock` 0.5.1 改为可释放的认领，owner 销毁即唤醒其余副本注册，不再需要刷新整页。

## 0.3.0 - 2026-09-23

### 修复

- kill 路径的两处 fail-open 现在一律 fail-closed：一次授权的终止不再因缺采样而 500，采样失败也不再被报成「已消失」或「已杀掉」。
- 空 CIM 回复按降级处理：活机器不可能采到零进程。
- history.jsonl 的追加与轮转串行化：后台 poll 与并发 kill 都会写，交错会丢行。
- 后台采样失败留下日志，不再被静默吞掉。

### 变更

- kill 门控抽成纯函数（`decideKillEntry` / `decideKillConfirm`），八条拒绝路径在所有平台都有覆盖。
- README 声明的最低 DSH 版本改为 `>=0.1.2-rc.1`（原 `>=0.1.0-rc.6`；CI 从未覆盖）。

## 0.2.6 - 2026-09-17

### 维护

- README 徽章分色（npm / release / DSH / node / 下载量 / 许可证各自一色），并整理更新日志措辞。代码未变。

## 0.2.5 - 2026-09-17

### 变更

- 「DSH 宿主后代」改为默认收起的折叠区，数量角标仍显示。此前展开的清单把可操作分区（未归属进程、任务账本、子代理树）挤到首屏之外。
- README 抬头统一为一致徽章行。

## 0.2.4 - 2026-09-16

### 维护

- 共享片段的 CI 校验改为在本仓执行（`loopback:check` / `guard:check`），不再跨仓比对。

## 0.2.3 - 2026-09-14

### 安全

- **Origin 的端口现在始终参与比对。** 此前未配置 `currentPort` 时会整段跳过该比对，于是任意端口上的服务都能用 `Origin: http://localhost:3080` 通过校验。这是收紧，不会放行此前被拒绝的任何请求。
- 修复同源校验的一处绕过：`Host` 头存在但解析不出主机名时（例如写成未加方括号的 IPv6 主机 `::1:3080`，RFC 7230 不允许这种写法），此前会**整段跳过白名单校验**。现在这类请求一律按非回环拒绝。
- IPv4-mapped IPv6 回环（`::ffff:127.0.0.1`，以及 URL 解析器规范化后的 `::ffff:7f00:1`）在 Host 与 Origin 两条路径上都识别为回环。

### 修复

- 通过 IPv6 回环地址（`::1`）访问时不再被拒绝。

## 0.2.2 - 2026-09-04

### 变更

- 适配 DSH 0.1.2-rc.1：浏览器 API 复用 Connection 签名 cookie，拒绝结果不会回退到旧 loopback 守卫。
- descendant 查询现在接收 HTTP 与浏览器 refresh 的取消信号；新刷新、关闭面板或断开请求会停止旧遍历。
- 接入 DSH 全局 locale，运行中切换语言会同步刷新面板、会话入口与 Dock 标签。
- 兼容检查覆盖 `0.1.2-rc.1` 与 latest。

### 修复

- 树杀授权改为只认 DSH 宿主归属：白名单 PID 仍用于标注，但它的后代不再可终止。此前保护一个 PID 反而会扩大可杀范围。
- 树杀前重新采样进程树并复核目标创建时间，受保护后代检查不再依赖最多 15 秒前的旧快照。
- 请求守卫改用 TCP 对端地址判定本地性：非回环来源不再能读取进程快照或执行树杀。在旧版或自定义远程监听下，此前伪造 `Host: 127.0.0.1` 即可通过守卫。
- 树杀目标必须归属于 DSH 宿主树。未归属进程不再显示树杀入口，服务端同样拒绝，避免终止与 DSH 无关的进程。
- 目标树的后代包含受保护 PID（白名单或自身进程链）时拒绝执行 `taskkill /T`；此前该 PID 会被连带终止。
- 服务运行在 HTTP 默认端口 80 时，省略端口的同源 Origin（如 `http://127.0.0.1`）不再被误判为跨源。

## 0.2.1 - 2026-09-02

### 变更

- Dock 片段改为构建期从外部片段包嵌入；插件发布物仍可独立运行。
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
