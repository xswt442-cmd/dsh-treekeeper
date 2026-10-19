// dsh-treekeeper 的浏览器侧。DSH 客户端模块使用经典脚本：向
// window.__ModuleLoader__ 注册工厂，React 来自平台种子，数据来自同源 JSON 接口
// /dsh-treekeeper/api（宿主侧）。
//
// 入口挂进共享的工具面板启动器，启动器固定在侧边栏外侧的页面底部；每个插件仍然
// 拥有自己的面板与状态。
window.__ModuleLoader__.load({
  id: 'dsh-treekeeper',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement


    const CSS_ID = 'dsh-treekeeper'
    function ensureStyles() {
      if (typeof document === 'undefined') return null
      const existing = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')
      if (existing !== null) return existing
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin-css', CSS_ID)
      styleEl.textContent =
        '.tk-layer{position:fixed;inset:0;z-index:9998;pointer-events:none}' +
        // 面板固定在框架右上角，不压在侧边栏控件上，也不挡住输入区。
        '.tk-panel{position:fixed;right:16px;top:64px;width:420px;max-width:calc(100vw - 24px);max-height:min(520px,68vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;box-shadow:0 18px 54px rgba(0,0,0,.32);z-index:9998;pointer-events:auto;font-size:12.5px;color:var(--dsw-alias-label-primary);overflow:hidden}' +
        '.tk-head{display:flex;align-items:center;gap:9px;padding:12px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:linear-gradient(135deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-overlay));flex:none}' +
        '.tk-titlegroup{display:flex;align-items:center;gap:8px;min-width:0}' +
        '.tk-titleicon{width:27px;height:27px;display:grid;place-items:center;border-radius:9px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover);flex:none}' +
        '.tk-title{margin:0;font-size:13.5px;font-weight:650;letter-spacing:.01em}' +
        '.tk-subtitle{margin-top:1px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}' +
        '.tk-headbtn{display:inline-flex;align-items:center;justify-content:center;height:27px;padding:0 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px}' +
        '.tk-headbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
        '.tk-headbtn:focus-visible,.tk-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
        '.tk-headbtn:disabled{opacity:.55;cursor:wait}' +
        '.tk-close{width:26px;padding:0;font-size:16px}' +
        '.tk-body{overflow:auto;padding:9px 10px 8px}' +
        '.tk-summary{display:flex;align-items:center;gap:8px;margin:0 2px 8px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}' +
        '.tk-summary strong{color:var(--dsw-alias-label-primary);font-size:12px}' +
        '.tk-sep{width:1px;height:13px;background:var(--dsw-alias-border-l1)}' +
        '.tk-sec{margin:2px 2px 8px}' +
        '.tk-sechead{font-weight:600;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin:8px 2px 5px;display:flex;gap:8px;align-items:center}' +
        '.tk-disclosure{border-top:1px solid var(--dsw-alias-border-l1);margin-top:5px}' +
        '.tk-disclosure>summary{display:flex;align-items:center;gap:8px;padding:8px 2px 4px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;list-style:none}' +
        '.tk-disclosure>summary::-webkit-details-marker{display:none}' +
        '.tk-disclosure>summary:before{content:"▸";font-size:10px}' +
        '.tk-disclosure[open]>summary:before{content:"▾"}' +
        '.tk-badge{font-size:10.5px;line-height:15px;padding:0 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}' +
        '.tk-red{color:var(--dsw-alias-state-error-primary)}' +
        '.tk-warn{color:var(--dsw-alias-state-warn-primary)}' +
        '.tk-ok{color:var(--dsw-alias-state-success-primary)}' +
        '.tk-dim{color:var(--dsw-alias-label-secondary)}' +
        '.tk-row{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:9px}' +
        '.tk-row:hover{background:var(--dsw-alias-bg-layer-2)}' +
        '.tk-cmd{font-family:ui-monospace,Consolas,Menlo,monospace;font-size:11px;word-break:break-all;color:var(--dsw-alias-label-primary)}' +
        '.tk-btn{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent;border-radius:6px;padding:2px 8px;cursor:pointer;font:inherit;font-size:11px;white-space:nowrap;flex:none}' +
        '.tk-btn:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-overlay)}' +
        // 释放按钮与树杀按钮同样是破坏性动作，但走的是另一条路径，因此用另一种
        // 语气，避免用户把两者当成同一件事。
        '.tk-btn-release{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);margin-top:3px}' +
        '.tk-toggle{display:flex;align-items:center;gap:6px;padding:5px 2px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
        '.tk-btn-arm{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-overlay)}' +
        '.tk-err{margin:2px 2px 8px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px}' +
        '.tk-empty{padding:12px 8px;text-align:center;color:var(--dsw-alias-label-secondary)}' +
        '.tk-loading{padding:28px 10px;text-align:center;color:var(--dsw-alias-label-secondary)}' +
        // 会话标题栏的操作入口：一个小按钮，内容是“在 TreeKeeper 中查看此会话”。
        // 间距由标题栏宿主负责，这里只给按钮自己写样式。
        '.tk-session-entry{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;white-space:nowrap}' +
        '.tk-session-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
        // 侧边栏会话行的两个座位。前置图标落在行内 16px 的格子里，必须是不可
        // 聚焦的被动标记，因此 span 只画一个 12px 图标并使用继承的文字颜色。
        '.tk-row-mark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}' +
        '.tk-row-hover{display:flex;flex-direction:column;gap:3px;margin:2px 0}' +
        '.tk-row-hover-line{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}' +
        '.tk-row-hover-action{align-self:flex-start;display:inline-flex;align-items:center;height:20px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;white-space:nowrap}' +
        '.tk-row-hover-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
        '.tk-foot{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex:none}'
      document.head.appendChild(styleEl)
      return styleEl
    }

    const I18N = {
      zh: { title: 'TreeKeeper', subtitle: '进程树对账', leaks: '泄漏告警', none: '没有发现异常', jobs: '任务账本', subagents: '子代理树', selectSession: '未选定会话：在会话标题栏点击「在 TreeKeeper 中查看此会话」', unavailable: '当前 DSH 未提供此能力', host: 'DSH 宿主子进程', hostId: '本宿主', hostDesktop: '桌面宿主', unknown: '未归属进程（按 DSH 相关度排序）', unknownHint: '整机共 {n} 个未归属进程，已按与 DSH 的相关度排序；桌面应用进程组单列，其余列出前 20 个。', desktopApp: '桌面应用进程组', kill: '树杀', confirm: '确认杀整棵树？', confirmBody: '将对以下进程树执行 taskkill /T /F：', refresh: '刷新', refreshing: '采样中', close: '关闭', sampling: '正在读取当前宿主的进程快照…', degraded: '降级采样（无父进程链，已禁止树杀）', unattr: '未归属', unattrDsh: '与 DSH 相关的未归属', unattrTotal: '整机未归属', closed: '连接失败', findings: '发现', descendants: '子进程', subagentDescendants: '子代理', exact: '确证', inferred: '推断', indicative: '指示性', collapsedSection: '无归属链的发现（仅供排查，不可树杀）', viewInTreeKeeper: '在 TreeKeeper 中查看此会话', session: '会话', rowFact: 'TreeKeeper 已缓存此会话的进程事实', rowRunning: '运行中', rowDiagnostic: '读取异常', census: '跨会话子代理', censusUnavailable: '当前 DSH 未提供 agents 谱系', censusEmpty: '没有驻留的子代理', censusHint: '全部会话的存活子代理；释放会归还它的容量槽，但这个子代理不能再被继续对话。', resident: '驻留', release: '释放', releaseConfirm: '确认释放驻留子代？', releaseConfirmBody: '将释放该子代理并归还它的容量槽。释放后不能对它继续对话；这与停止当前 turn 是两件事。', releaseOff: '释放默认关闭', enableRelease: '允许释放驻留子代', reasonStale: '快照已过期或降级，请重新采样后再终止', reasonUnattributed: '目标不在 DSH 宿主进程树内，不可终止', reasonUnsupported: '当前平台不支持进程采样（仅 Windows）', reasonInternal: '宿主未能完成请求，详见宿主日志', reasonAuth: '需要已授权的浏览器会话', reasonBadBody: '请求内容无效', reasonReleaseOff: '驻留子代释放未启用', reasonChildNotFound: '目标不是存活的子代理子代', reasonParentNotLive: '父会话已不存活' },
      en: { title: 'TreeKeeper', subtitle: 'process reconciliation', leaks: 'Leak findings', none: 'Nothing unusual', jobs: 'Job ledger', subagents: 'Subagent tree', selectSession: 'No session selected: use "View this session in TreeKeeper" in the session header', unavailable: 'This DSH build does not provide the capability', host: 'DSH host descendants', hostId: 'this host', hostDesktop: 'desktop host', unknown: 'Unattributed (ranked by DSH relevance)', unknownHint: '{n} unattributed processes machine-wide; ranked by DSH relevance, with the desktop application processes listed apart and the first 20 of the rest shown.', desktopApp: 'desktop application processes', kill: 'Kill tree', confirm: 'Kill the whole tree?', confirmBody: 'taskkill /T /F will run on this tree:', refresh: 'Refresh', refreshing: 'Sampling', close: 'Close', sampling: 'Reading the current host process snapshot…', degraded: 'Degraded sampling (tree kill disabled)', unattr: 'unattributed', unattrDsh: 'DSH-related unattributed', unattrTotal: 'machine-wide unattributed', closed: 'request failed', findings: 'Findings', descendants: 'Descendants', subagentDescendants: 'Subagents', exact: 'exact', inferred: 'inferred', indicative: 'indicative', collapsedSection: 'Findings without an attribution chain (investigation only, no kill)', viewInTreeKeeper: 'View this session in TreeKeeper', session: 'session', rowFact: 'TreeKeeper holds cached facts for this session', rowRunning: 'running', rowDiagnostic: 'read issues', census: 'Subagents across sessions', censusUnavailable: 'This DSH build does not expose the agents lineage', censusEmpty: 'No resident subagents', censusHint: 'Live subagents across every session. Releasing one returns its capacity slot, and that subagent can no longer be continued.', resident: 'resident', release: 'Release', releaseConfirm: 'Release the resident subagent?', releaseConfirmBody: 'This releases the subagent and returns its capacity slot. It can no longer be continued afterwards; this is a different thing from stopping its current turn.', releaseOff: 'release is off by default', enableRelease: 'Allow releasing resident subagents', reasonStale: 'the snapshot is stale or degraded; resample before terminating', reasonUnattributed: 'target is outside the DSH host tree and cannot be terminated', reasonUnsupported: 'process sampling is only implemented on Windows', reasonInternal: 'the host could not complete the request; see the host log', reasonAuth: 'an authorized browser session is required', reasonBadBody: 'the request body is not usable', reasonReleaseOff: 'resident subagent release is not enabled', reasonChildNotFound: 'the target is not a live subagent child', reasonParentNotLive: 'the parent session is no longer live' }
    }
    const fallbackLanguage = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    // 面板、会话标题栏入口和侧边栏行内座位共用同一套订阅方式：一个值、一个
    // 修订号和一组监听器。`set` 写入后通知全部订阅者，组件通过 `use` 订阅，
    // 因此只有订阅了同一个 store 的组件会重绘。
    function createStore(initial) {
      const store = {
        value: initial,
        revision: 0,
        listeners: new Set(),
        touch() {
          store.revision += 1
          store.listeners.forEach((listener) => listener())
        },
        set(value) {
          store.value = value
          store.touch()
        },
        use() {
          const [, setRevision] = React.useState(0)
          React.useEffect(() => {
            const listener = () => setRevision(store.revision)
            store.listeners.add(listener)
            return () => store.listeners.delete(listener)
          }, [])
          return store.revision
        }
      }
      return store
    }

    const localeState = createStore(null)
    const text = (key) => {
      const translate = localeState.value
      if (translate) {
        const translated = translate(key)
        if (translated && translated !== key) return translated
      }
      return I18N[fallbackLanguage][key] || I18N.en[key] || key
    }
    const texts = () => Object.fromEntries(Object.keys(I18N.en).map((key) => [key, text(key)]))
    const useTexts = () => {
      localeState.use()
      return texts()
    }
    const notifyLocale = () => localeState.touch()

    // 噪音策略以数据表达：面板沿用宿主给出的三个 confidence 值作为三个桶，
    // 顺序与宿主一致。每个桶只统计它对应的等级，`indicative` 不会计入 `exact`。
    // 没有 confidence 字段的旧负载按 `exact` 统计，旧快照因此仍然可见。
    function findingLevel(finding) {
      if (!finding) return 'exact'
      if (finding.confidence === 'indicative') return 'indicative'
      return finding.confidence === 'inferred' ? 'inferred' : 'exact'
    }
    // 一条发现渲染在哪里是另一个问题，看的是归属链而不是等级。有归因的发现
    // （无论是 `exact` 还是 `indicative`）保持展开，因为链条就是证据。作用域为
    // `unattributed` 意味着完全没有链条，`orphan.previous-host` 正是如此：它收进
    // 排查区，但仍按自己的 `indicative` 等级计数。没有任何链条的启发式发现同样
    // 收进去。两种收起的情况都不会成为终止候选。
    function findingCollapsed(finding) {
      if (!finding) return false
      if (finding.ownership && finding.ownership.scope === 'unattributed') return true
      return finding.confidence === 'inferred'
    }
    function partitionFindings(findings) {
      const exact = []
      const indicative = []
      const inferred = []
      for (const finding of findings || []) {
        const level = findingLevel(finding)
        if (level === 'exact') exact.push(finding)
        else if (level === 'indicative') indicative.push(finding)
        else inferred.push(finding)
      }
      return { exact, indicative, inferred }
    }
    // 每条发现一行灰色说明，回答“它为什么在这里”：触发的规则，加上归属链
    // （作用域，以及账本对账找到时的会话/任务链接）。
    function findingMeta(finding) {
      const parts = []
      if (finding.rule) parts.push(finding.rule)
      if (finding.ownership) {
        parts.push(finding.ownership.scope)
        if (finding.ownership.session) parts.push('session ' + finding.ownership.session)
        else if (finding.ownership.job) parts.push('job ' + finding.ownership.job)
      }
      return parts.join(' · ')
    }

    function Panel(props) {
      const { t, data, error, loading, armed, rootSessionId, onArm, onKill, onRefresh, onClose, census, released, onArmRelease, onRelease, onSetAllowRelease } = props
      // 非对象条目在这里统一剔除，分区与行渲染都不会拿到解引用会出错的条目。
      const findings = ((data && data.findings) || []).filter(Boolean)
      const { exact: exactFindings, indicative, inferred } = partitionFindings(findings)
      // 展开列表是所有带归因链的发现，收起的披露区是剩下的那些。两个集合来自
      // 同一次分区，因此每条发现只渲染一次。
      const expanded = findings.filter((finding) => !findingCollapsed(finding))
      const collapsed = findings.filter(findingCollapsed)
      const rec = (data && data.reconcile) || { summary: {} }
      const unknown = (data && data.unknown) || []
      const { group: desktopAppGroup, rest: unknownRows } = splitDesktopApp(unknown)
      const descendants = ((data && data.processes) || []).filter((process) => process.evidence === 'exact' && process.pid !== data.pid)
      const rows = (rec && rec.rows) || []
      const canKill = !!(data && !data.degraded)
      const jobRows = rows.filter((row) => row.source === 'job')
      const subagents = (data && Array.isArray(data.subagents)) ? data.subagents : []
      // 子代理区域的三种状态：available（已确定根且宿主提供该服务）、
      // root-required（还没有会话）、unavailable（能力缺失）。
      const subagentState = subagentStateFor(data, rootSessionId)
      // 跨会话普查：全部会话的存活子代理，而不是只看当前选中会话的那一棵。
      const censusParents = census && Array.isArray(census.parents) ? census.parents : []
      const censusTotal = censusParents.reduce((sum, parent) => sum + parent.children.length, 0)
      const releaseEnabled = !!(census && census.releaseEnabled)
      return h('section', { className: 'tk-panel', 'aria-label': t.title },
        h('div', { className: 'tk-head' },
          h('div', { className: 'tk-titlegroup' },
            h('div', { className: 'tk-titleicon', 'aria-hidden': 'true' }, h(TreeIcon)),
            h('div', null, h('div', { className: 'tk-title' }, t.title), h('div', { className: 'tk-subtitle' }, t.subtitle))),
          // 标明这是哪一棵树。`$DSH_HOME/treekeeper` 与整机进程表是共享的，
          // pid、端口和宿主类型是区分不同宿主的三项事实。
          data ? h('span', { className: 'tk-dim' },
            t.hostId + ' pid ' + data.pid + ' · port ' + (data.port || '?') +
            (data.hostKind === 'desktop' ? ' · ' + t.hostDesktop : '')) : null,
          h('div', { style: { flex: 1 } }),
          data && data.degraded ? h('span', { className: 'tk-badge tk-warn' }, t.degraded) : null,
          h('button', { className: 'tk-headbtn', onClick: onRefresh, disabled: loading, title: loading ? t.refreshing : t.refresh }, loading ? t.refreshing : t.refresh),
          h('button', { className: 'tk-headbtn tk-close', onClick: onClose, title: t.close, 'aria-label': t.close }, '×')),
        h('div', { className: 'tk-body' },
          error ? h('div', { className: 'tk-err' }, error) : null,
          loading && !data ? h('div', { className: 'tk-loading' }, t.sampling) : h('div', { className: 'tk-sec' },
            data ? h('div', { className: 'tk-summary' },
              h('span', null, t.findings + ' ', h('strong', null, String(findings.length))),
              h('span', { className: 'tk-dim' }, t.exact + ' ' + exactFindings.length +
                ' · ' + t.indicative + ' ' + indicative.length +
                ' · ' + t.inferred + ' ' + inferred.length),
              h('span', { className: 'tk-sep', 'aria-hidden': 'true' }),
              h('span', null, t.descendants + ' ', h('strong', null, String(descendants.length)))) : null,
            h('div', { className: 'tk-sechead' }, t.leaks,
              h('span', { className: 'tk-badge ' + (findings.length ? 'tk-red' : 'tk-ok') }, String(findings.length)),
              rec.summary ? h('span', { className: 'tk-dim' },
                'jobs ' + (rec.summary.jobs || 0) + ' · matched ' + (rec.summary.jobsMatched || 0) +
                ' · os-only ' + (rec.summary.osOnly || 0) +
                ' · ' + t.unattrDsh + ' ' + (rec.summary.unattributed || 0) +
                ' / ' + t.unattrTotal + ' ' + (rec.summary.unattributedTotal || 0)) : null),
            findings.length === 0
              ? h('div', { className: 'tk-empty' }, t.none)
              : h('div', null,
                  expanded.map((f, i) => findingRow(t, f, i, armed, onArm, onKill, data, canKill)),
                  collapsed.length
                    ? h('details', { className: 'tk-disclosure', key: 'tk-inferred' },
                        h('summary', null, t.collapsedSection,
                          h('span', { className: 'tk-badge tk-dim' }, String(collapsed.length))),
                        collapsed.map((f, i) => findingRow(t, f, i, armed, onArm, onKill, data, canKill)))
                    : null),
            // 后代进程是上下文，不是发现：它们已经计入上面的摘要，把健康的宿主
            // 进程全部展开会把可操作的区块（未归属进程、任务账本、子代理树）挤到
            // 折叠线以下。同级区块都默认收起，这一块也一样。
            h('details', { className: 'tk-disclosure', key: 'tk-host' },
              h('summary', null, t.host, h('span', { className: 'tk-badge tk-dim' }, String(descendants.length))),
              descendants.length === 0
                ? h('div', { className: 'tk-empty' }, t.none)
                : descendants.slice(0, 16).map((p) => processRow(t, armed, onArm, onKill, p, canKill))),
            h('details', { className: 'tk-disclosure' },
              h('summary', null, t.unknown, h('span', { className: 'tk-badge tk-dim' }, String(unknown.length))),
              unknown.length === 0
                ? h('div', { className: 'tk-empty' }, t.none)
                : h('div', null,
                    // 列表被截断了，所以要在这里说明范围与排序：徽标统计的是整机
                    // 集合的全部行，不只是下面显示的行。
                    h('div', { className: 'tk-dim' }, t.unknownHint.replace('{n}', String(unknown.length))),
                    // 桌面应用的 Electron 进程组排在最前，因为它是一个应用，所以
                    // 在这里作为一个披露区。截断后展示的二十行是集合里其余的进程；
                    // 进程组自己的行由整集合徽标计数，不从这二十行里占位。
                    desktopAppGroup.length === 0
                      ? null
                      : h('details', { className: 'tk-disclosure', key: 'tk-desktop-app' },
                          h('summary', null, t.desktopApp,
                            h('span', { className: 'tk-badge tk-dim' }, String(desktopAppGroup.length))),
                          desktopAppGroup.map((p) => processRow(t, armed, onArm, onKill, p, canKill))),
                    unknownRows.slice(0, 20).map((p) => processRow(t, armed, onArm, onKill, p, canKill)))),
            h('details', { className: 'tk-disclosure' },
              h('summary', null, t.jobs, h('span', { className: 'tk-badge tk-dim' }, String(jobRows.length))),
              jobRows.length === 0
                ? h('div', { className: 'tk-empty' }, t.none)
                : jobRows.map((row, index) => h('div', { className: 'tk-row', key: 'j' + index },
                    h('span', { className: 'tk-badge tk-ok' }, row.status),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                      h('div', { className: 'tk-cmd' }, (row.label || '').slice(0, 160)),
                    h('div', { className: 'tk-dim' }, jobDescription(row))))))),
            h('details', { className: 'tk-disclosure' },
              h('summary', null, t.subagents,
                subagentState === 'available' && rootSessionId
                  ? h('span', { className: 'tk-dim' }, ' · ' + t.session + ' ' + rootSessionId.slice(0, 24))
                  : null,
                h('span', { className: 'tk-badge tk-dim' }, String(subagents.length))),
              subagentState === 'root-required'
                ? h('div', { className: 'tk-empty' }, t.selectSession)
                : subagentState === 'unavailable'
                  ? h('div', { className: 'tk-empty' }, t.unavailable)
                  : subagents.length === 0
                    ? h('div', { className: 'tk-empty' }, t.none)
                    : subagents.map((row, index) => subagentRow(row, index))),
            // 跨会话普查。上面的子树只覆盖当前选中的会话，而驻留的子代理可能正在
            // 别的会话里；这一块是全宿主范围，因此它是唯一能回答「还有谁占着容量」
            // 的地方。
            h('details', { className: 'tk-disclosure', key: 'tk-census' },
              h('summary', null, t.census, h('span', { className: 'tk-badge tk-dim' }, String(censusTotal))),
              census === null
                ? h('div', { className: 'tk-empty' }, t.censusUnavailable)
                : censusTotal === 0
                  ? h('div', { className: 'tk-empty' }, t.censusEmpty)
                  : h('div', null,
                      h('div', { className: 'tk-dim' }, t.censusHint),
                      // 释放是破坏性动作，与树杀同样默认关闭，因此开关就在这一块
                      // 里：用户先决定本进程是否允许释放，再谈释放哪一个。
                      h('label', { className: 'tk-toggle' },
                        h('input', {
                          type: 'checkbox',
                          checked: releaseEnabled,
                          onChange: (event) => onSetAllowRelease(event.target.checked)
                        }),
                        h('span', null, releaseEnabled ? t.enableRelease : t.releaseOff)),
                      censusParents.map((parent, index) => h('div', { className: 'tk-row', key: 'cp' + index },
                        h('span', { className: 'tk-badge tk-dim' }, t.session),
                        h('div', { style: { flex: 1, minWidth: 0 } },
                          h('div', { className: 'tk-cmd' }, parent.parentId),
                          h('div', { className: 'tk-dim' }, parent.children.length + ' × ' + t.resident)),
                        releaseEnabled
                          ? parent.children.map((child) => releaseBtn(t, released, onArmRelease, onRelease, child))
                          : null))))
          ),
        h('div', { className: 'tk-foot' },
          data ? new Date(data.takenAt).toLocaleTimeString() : '',
          h('span', { style: { flex: 1 } }),
          data ? (data.attributedCount + ' attributed') : '')
      )
    }

    function processCreatedMs(data, pid) {
      const process = ((data && data.processes) || []).find((row) => row.pid === pid)
      return process ? process.createdMs : null
    }

    // 面板标题（16px，无参数）与侧边栏行标记（通过 `size` 传 12px）共用同一个
    // 图标；每种尺寸都继承 currentColor。
    function TreeIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round'
      },
      h('path', { d: 'M12 3v6M7 9h10M7 9v5M17 9v5M12 9v8' }),
      h('circle', { cx: 7, cy: 17, r: 2 }),
      h('circle', { cx: 12, cy: 20, r: 2 }),
      h('circle', { cx: 17, cy: 17, r: 2 }))
    }

    function jobDescription(row) {
      if (row.pids && row.pids.length) return row.id + ' → pid ' + row.pids.join(', ')
      return row.id + (row.indicative ? ' → no pid match (indicative join)' : '')
    }

    function subagentRow(row, index) {
      const depth = Number.isFinite(row.depth) ? Math.max(1, row.depth) : 1
      if (row.kind === 'diagnostic') {
        return h('div', { className: 'tk-row', key: 'sa' + index, style: { paddingLeft: (8 + depth * 12) + 'px' } },
          h('span', { className: 'tk-badge tk-warn' }, row.reason || 'diagnostic'),
          h('div', { className: 'tk-cmd' }, row.id || 'unknown'))
      }
      const activity = row.activity || 'inactive'
      return h('div', { className: 'tk-row', key: 'sa' + index, style: { paddingLeft: (8 + depth * 12) + 'px' } },
        h('span', { className: 'tk-badge ' + (activity === 'running' ? 'tk-ok' : 'tk-dim') }, activity),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'tk-cmd' }, row.label || row.id || 'unknown'),
          h('div', { className: 'tk-dim' }, (row.mode || 'subagent') + ' · ' + (row.id || '') + (row.hasChildren ? ' · +' : ''))))
    }

    /**
     * 服务器按 `rootLabel === 'harness'` 授权终止：用户登记的 pid 只是排查用的
     * 根，它们的后代不属于 DSH 宿主树。会得到服务器 409 的按钮是在骗人，因此
     * 界面应用同一条规则，不单凭 `evidence` 判断。
     */
    function killAuthorizedFor(data, pid) {
      const rows = (data && data.processes) || []
      const row = rows.find((candidate) => candidate.pid === pid)
      return !!(row && row.attribution && row.attribution.rootLabel === 'harness')
    }

    function findingRow(t, finding, index, armed, onArm, onKill, data, canKill) {
      const level = findingLevel(finding)
      // 徽标写出宿主盖下的等级，也是这一行在上面摘要里计入的等级。徽标同时带
      // 等级的语气：`exact` 与 `indicative` 都建立在进程事实上，用警示色；
      // `inferred` 只是启发式线索，用灰色。
      return h('div', { className: 'tk-row', key: 'f' + (finding.key ?? index) },
        h('span', { className: 'tk-badge ' + (level === 'inferred' ? 'tk-dim' : 'tk-warn') },
          t[level] + ' ' + finding.type),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'tk-dim' }, finding.detail),
          h('div', { className: 'tk-dim' }, findingMeta(finding)),
          h('div', { className: 'tk-cmd' }, (finding.evidence && finding.evidence.sample) || '')),
        // 没有归因链的发现只是启发式线索，无论宿主给它盖了哪个等级，都不会成为
        // 终止候选。
        !findingCollapsed(finding) && canKill && finding.pids && finding.pids.length === 1 && killAuthorizedFor(data, finding.pids[0])
          ? killBtn(t, armed, onArm, onKill, finding.pids[0], (finding.evidence && finding.evidence.sample) || finding.detail, processCreatedMs(data, finding.pids[0]))
          : null)
    }

    /**
     * 把未归属集合分成桌面应用自己的进程组与不属于任何组的行，返回
     * `{ group, rest }`。
     *
     * 桌面应用的渲染、GPU 与工具进程是宿主进程的兄弟而不是后代，因此它们会排在
     * 整机集合的前面，看起来像遗留进程。它们属于同一个应用，面板用一个披露区
     * 展示，而不散落成一堆排行。
     *
     * 成员标记随每一行以 `desktopApp` 到达，由宿主从 DSH 信号与父进程链推出。
     * 这一侧只划分拿到的数据，自己不做匹配：它是经典脚本，够不到
     * `lib/shared.js`，在这里再抄一份词表就要维护两处。集合里的每一行无论如何
     * 都会渲染，因此宿主报告的数量不变。
     */
    function splitDesktopApp(rows) {
      const list = Array.isArray(rows) ? rows : []
      return {
        group: list.filter((row) => row && row.desktopApp === true),
        rest: list.filter((row) => !row || row.desktopApp !== true)
      }
    }

    function processRow(t, armed, onArm, onKill, process, canKill) {
      return h('div', { className: 'tk-row', key: 'p' + process.pid },
        h('span', { className: 'tk-badge ' + (process.evidence === 'exact' ? 'tk-ok' : 'tk-dim') }, process.evidence === 'exact' ? 'exact' : t.unattr),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'tk-cmd' }, (process.cmdline || process.name || '').slice(0, 200)),
          h('div', { className: 'tk-dim' }, 'pid ' + process.pid + ' · ' + Math.round((process.wsBytes || 0) / 1048576) + ' MB' + (process.createdMs ? ' · ' + Math.max(0, Math.round((Date.now() - process.createdMs) / 60000)) + ' min' : ''))),
        // `evidence: 'exact'` 只表示“已归因”；授权范围更窄——归因根必须是
        // 宿主进程本身。
        canKill && process.evidence === 'exact' && process.attribution && process.attribution.rootLabel === 'harness'
          ? killBtn(t, armed, onArm, onKill, process.pid, process.cmdline || process.name, process.createdMs)
          : null)
    }

    function killBtn(t, armed, onArm, onKill, pid, cmdText, createdMs) {
      if (!Number.isFinite(createdMs)) return null
      const key = 'k' + pid
      const isArmed = armed && armed.pid === pid
      return h('button', {
        className: 'tk-btn' + (isArmed ? ' tk-btn-arm' : ''),
        title: cmdText,
        onClick: () => {
          if (!isArmed) { onArm({ pid, createdMs: createdMs ?? null }); setTimeout(() => onArm(null), 6000); return }
          if (!window.confirm(t.confirm + '\n\n' + t.confirmBody + '\n' + String(cmdText || '').slice(0, 200))) { onArm(null); return }
          onKill({ pid, seenCreatedMs: createdMs ?? null })
          onArm(null)
        }
      }, isArmed ? t.confirm.split('？')[0].split('?')[0] + '!' : t.kill)
    }

    /**
     * 释放按钮，与树杀同一套两段式：第一次点击进入待确认（6 秒），第二次点击才弹
     * 确认框；误触一次不会把一个破坏性动作留在待发状态。确认框的正文要说明释放与
     * 「停止当前 turn」是两件事——按下它之后这个子代理不能再被继续对话。
     *
     * 释放只发 childId。父会话由宿主谱系反查，因此界面无从也不需要指定它。
     */
    function releaseBtn(t, released, onArmRelease, onRelease, child) {
      const isArmed = released === child.id
      return h('button', {
        className: 'tk-btn tk-btn-release' + (isArmed ? ' tk-btn-arm' : ''),
        title: child.id,
        onClick: () => {
          if (!isArmed) { onArmRelease(child.id); setTimeout(() => onArmRelease(null), 6000); return }
          if (!window.confirm(t.releaseConfirm + '\n\n' + t.releaseConfirmBody + '\n' + child.id)) { onArmRelease(null); return }
          onRelease(child.id)
          onArmRelease(null)
        }
      }, isArmed ? t.releaseConfirm.split('？')[0].split('?')[0] + '!' : t.release + ' ' + child.id.slice(0, 8))
    }

    const TREE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v6M7 9h10M7 9v5M17 9v5M12 9v8"></path><circle cx="7" cy="17" r="2"></circle><circle cx="12" cy="20" r="2"></circle><circle cx="17" cy="17" r="2"></circle></svg>'

    let sessionsService = null
    const openStore = createStore(false)
    const setOpen = (value) => openStore.set(!!value)
    const useOpen = () => {
      openStore.use()
      return openStore.value
    }

    // 确定性的会话入口：`conversation.session.header.actions` 的作用域是
    // 'session'，注册的组件拿到的 sessionId 一定对应存活会话，面板不必再从
    // `sessions.list.getSnapshot().current` 猜。点击标题栏入口会把面板聚焦到那个
    // 会话：先记下 id，再通过与平常相同的打开路径打开（已打开时重新采样）。
    const focusStore = createStore(null)
    const focusSession = (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return
      focusStore.set(sessionId)
      setOpen(true)
    }
    const useFocusRevision = () => focusStore.use()

    // 按会话缓存的进程事实，与上面的 store 同一套写法。侧边栏会话行的两个座位
    // 每行都会挂载，因此两者都不访问宿主：这张表只由面板已经加载的快照填充，
    // 某个座位拿不到自己 sessionId 的事实时就什么都不画。
    //
    // 只保存宿主归到某一个会话的事实：聚焦根的 subagent 行（请求只指定这个根）、
    // 账本行带 `ownerSession` 的运行中任务，以及账本对账填了 `ownership.session`
    // 的发现。快照里没有任何部分把宿主进程行、未归属集合或没有 ownerSession 的
    // 任务归到某个会话，因此这些都不缓存。
    const factStore = createStore(new Map())

    function sessionFactsFrom(body) {
      const facts = new Map()
      const bump = (sessionId, field) => {
        if (typeof sessionId !== 'string' || !sessionId) return
        let fact = facts.get(sessionId)
        if (!fact) {
          fact = { descendants: 0, running: 0, diagnostics: 0, jobs: 0, findings: 0 }
          facts.set(sessionId, fact)
        }
        fact[field] += 1
      }
      const root = body && typeof body.subagentRoot === 'string' ? body.subagentRoot : null
      if (root) {
        for (const row of Array.isArray(body.subagents) ? body.subagents : []) {
          if (!row) continue
          // 诊断行讲的是这次读取，不是后代。
          if (row.kind === 'diagnostic') { bump(root, 'diagnostics'); continue }
          bump(root, 'descendants')
          if (row.activity === 'running') bump(root, 'running')
        }
      }
      const rows = body && body.reconcile && Array.isArray(body.reconcile.rows) ? body.reconcile.rows : []
      for (const row of rows) if (row && row.source === 'job') bump(row.ownerSession, 'jobs')
      const findings = body && Array.isArray(body.findings) ? body.findings : []
      for (const finding of findings) {
        bump(finding && finding.ownership ? finding.ownership.session : null, 'findings')
      }
      return facts
    }

    // 整张表替换：一份响应就是刚刚观察到的会话状态，保留它已不再包含的条目会
    // 留下过期的行标记。
    function publishSessionFacts(body) {
      factStore.set(sessionFactsFrom(body))
    }
    const sessionFact = (sessionId) =>
      typeof sessionId === 'string' && sessionId ? factStore.value.get(sessionId) || null : null
    const useFactRevision = () => factStore.use()

    // 纯判定函数。标题栏入口只在会话打开时能证明会话存在；面板挂在根级
    // shell.overlay 槽位上，仍然必须说出自己缺什么。
    function resolveRootSessionId(focusSessionId, currentGuess) {
      if (typeof focusSessionId === 'string' && focusSessionId) return focusSessionId
      if (typeof currentGuess === 'string' && currentGuess) return currentGuess
      return null
    }
    // 快照到达之后以宿主为准；在此之前本地根是唯一依据。这里的顺序与
    // lib/shared.js 的 subagentAvailability 一致，宿主与客户端的结论不会互相矛盾。
    function subagentStateFor(data, rootSessionId) {
      const availability = data && data.subagentAvailability
      if (availability === 'unavailable') return 'unavailable'
      if (availability === 'root-required') return 'root-required'
      if (rootSessionId == null) return 'root-required'
      return 'available'
    }
    function snapshotQuery(rootSessionId) {
      return rootSessionId
        ? '?action=snapshot&rootSessionId=' + encodeURIComponent(rootSessionId)
        : '?action=snapshot'
    }
    // 面板与标题栏入口的聚焦重采样共用这一条请求路径；根总是显式传入，不在
    // 服务器侧重推。
    const fetchSnapshot = (rootSessionId, signal) =>
      fetch('/dsh-treekeeper/api' + snapshotQuery(rootSessionId), { headers: { accept: 'application/json' }, signal: signal })

    /**
     * 跨会话普查。与快照分开请求：它读的是 agents 服务而不是操作系统采样，因此
     * 面板的进程树刷新不必带上它，而关闭面板时的取消同样覆盖它。
     */
    const fetchCensus = (signal) =>
      fetch('/dsh-treekeeper/api?action=census', { headers: { accept: 'application/json' }, signal: signal })

    const postConfig = async (payload, signal) => {
      const res = await fetch('/dsh-treekeeper/api?action=config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body || !body.ok) throw hostFailure(body, res.status)
      return body
    }

    /**
     * 把失败的宿主响应变成一个带机器可读 `code` 的错误。面板只读错误码，不读
     * 宿主的句子：固定的错误码是稳定契约，码背后的文案可以改。
     */
    function hostFailure(body, status) {
      const code = body && typeof body.code === 'string' && body.code ? body.code : null
      const error = new Error('treekeeper: HTTP ' + status + ' ' + (code || 'no_code'))
      error.code = code
      return error
    }

    // 由本插件撰写文案、可以本地化的宿主错误码。
    const HOST_REFUSAL_TEXT = {
      snapshot_required: 'reasonStale',
      unattributed: 'reasonUnattributed',
      non_harness_root: 'reasonUnattributed',
      disabled: 'reasonReleaseOff',
      release_unavailable: 'reasonReleaseOff',
      lineage_unavailable: 'reasonReleaseOff',
      child_not_found: 'reasonChildNotFound',
      not_direct_child: 'reasonChildNotFound',
      parent_not_live: 'reasonParentNotLive',
      unsupported_platform: 'reasonUnsupported',
      internal_error: 'reasonInternal',
      connection_unavailable: 'reasonAuth',
      unauthorized: 'reasonAuth',
      forbidden: 'reasonAuth',
      bad_json: 'reasonBadBody',
      body_too_large: 'reasonBadBody',
      bad_pid: 'reasonBadBody',
      bad_created_ms: 'reasonBadBody',
      bad_poll_ms: 'reasonBadBody'
    }

    /**
     * 面板为一次失败显示的唯一一行。本插件自己写的拒绝（快照过期、目标不在宿主
     * 树内）说明用户能采取的动作，原样显示；表示“宿主抛错”的错误码只说这一点，
     * 因为它的原文是命令行、Windows 错误串或路径——那是日志材料，不是面板内容。
     * 无论哪种情况完整信息都会写到控制台，浏览器里仍有地方可查。
     */
    function failureLine(t, cause) {
      const raw = cause && cause.message ? String(cause.message) : String(cause)
      const code = cause && cause.code
      const reason = code ? (HOST_REFUSAL_TEXT[code] ? t[HOST_REFUSAL_TEXT[code]] : null) : null
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[dsh-treekeeper] request failed', raw)
      }
      return reason || (t.closed + ': ' + (code || 'unknown_error'))
    }

    // 前置座位。`sidebar.session.row.leading` 在每个空闲会话行上挂载，因此这个
    // 组件只读 factStore：不请求、不绑定会话、不定时。标准的 `useSessions` /
    // `useSessionStatus` 属性有意不用——逐行订阅会给宿主增加工作——这个 sessionId
    // 没有缓存事实时也不画任何图标。
    function RowMark(props) {
      useFactRevision()
      const t = useTexts()
      const fact = sessionFact(props && props.sessionId)
      if (!fact) return null
      return h('span', {
        className: 'tk-row-mark',
        role: 'img',
        title: t.rowFact,
        'aria-label': t.rowFact
      }, h(TreeIcon, { size: 12 }))
    }

    // 悬停座位：一行紧凑的缓存事实，随后是发现动作。这个动作走的路径与标题栏
    // 入口完全相同，而且在缓存为空时也能用——TreeKeeper 还没看过的会话正是靠这次
    // 点击去看。
    function RowHover(props) {
      useFactRevision()
      const t = useTexts()
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null
      const fact = sessionFact(sessionId)
      return h('div', { className: 'tk-row-hover' },
        fact ? h('div', { className: 'tk-row-hover-line' }, rowFactLine(t, fact)) : null,
        h('button', {
          type: 'button',
          className: 'tk-row-hover-action',
          title: t.viewInTreeKeeper,
          onClick: () => focusSession(sessionId)
        }, t.viewInTreeKeeper))
    }

    function rowFactLine(t, fact) {
      const parts = []
      if (fact.descendants > 0) {
        parts.push(t.subagentDescendants + ' ' + fact.descendants +
          (fact.running > 0 ? ' (' + fact.running + ' ' + t.rowRunning + ')' : ''))
      }
      if (fact.jobs > 0) parts.push(t.jobs + ' ' + fact.jobs)
      if (fact.findings > 0) parts.push(t.findings + ' ' + fact.findings)
      if (fact.diagnostics > 0) parts.push(fact.diagnostics + ' ' + t.rowDiagnostic)
      return parts.join(' · ')
    }

    // 会话作用域的标题栏操作。槽位契约保证 sessionId 是存活会话，所以按钮总是
    // 可用；能力缺失由面板的 unavailable 状态说明，不通过隐藏入口表达。
    function SessionEntry(props) {
      const t = useTexts()
      return h('button', {
        className: 'tk-session-entry',
        type: 'button',
        title: t.viewInTreeKeeper,
        'aria-label': t.viewInTreeKeeper,
        onClick: () => focusSession(props.sessionId)
      }, t.viewInTreeKeeper)
    }
// <dsh-utility-launcher>
// The shared launcher assembly: one icon plus the menu of panels it opens, for a
// plugin's browser half.
//
// This fragment has ONE source of truth: dsh-mini-utility-dock/dist/launcher.js.
// DSH client artifacts are self-contained classic scripts, so the fragment is
// embedded into lib/client.js at build time by
//   npm run launcher:sync    (write it)
//   npm run launcher:check   (fail on drift)
// instead of being imported: a bare import would put a runtime dependency on
// this package into the bundle that embeds it, and an embedding plugin ships
// standalone, with nothing else required.
//
// The launcher is one icon that opens a menu of utility panels. It is contributed
// through slots, not through a page-local protocol: exactly one copy of this
// assembly runs per page — the first to load wins the window mutex, registers the
// launcher, and declares the menu seat — while the other copies register nothing
// here and only wait to take the claim over once their owner is disposed.
const UTILITY_ITEM_SLOT = 'createhelper.utility.item'
const UTILITY_MUTEX_KEY = '__CREATEHELPER_DSH_UTILITY_LAUNCHER_V1__'
const UTILITY_CSS_ID = 'createhelper-utility-launcher'
const UTILITY_FALLBACK_LEFT_PX = 80
const UTILITY_MEASURE_TRIES = 120
const UTILITY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"></rect><rect x="14" y="3" width="7" height="7" rx="2"></rect><rect x="3" y="14" width="7" height="7" rx="2"></rect><rect x="14" y="14" width="7" height="7" rx="2"></rect></svg>'

// The launcher's own chrome, injected once by whichever copy wins the mutex.
// The rows are other plugins' components, so the menu styles its buttons by
// position instead of asking every contributor for a class name.
function ensureUtilityStyles() {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="' + UTILITY_CSS_ID + '"]') !== null) return
  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-plugin-css', UTILITY_CSS_ID)
  styleEl.textContent =
    '.createhelper-utility-anchor{position:fixed;bottom:16px;z-index:9997;pointer-events:auto}' +
    '.createhelper-utility-launcher{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.22)}' +
    '.createhelper-utility-launcher:hover,.createhelper-utility-launcher[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
    '.createhelper-utility-launcher svg{display:block}' +
    '.createhelper-utility-menu{display:flex;flex-direction:column;gap:2px;min-width:172px;margin-bottom:6px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 30px rgba(0,0,0,.28)}' +
    '.createhelper-utility-menu[hidden]{display:none}' +
    '.createhelper-utility-menu button{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;text-align:left;white-space:nowrap}' +
    '.createhelper-utility-menu button:hover,.createhelper-utility-menu button[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
    '.createhelper-utility-menu button svg{display:block;flex:none}'
  document.head.appendChild(styleEl)
}

// The launcher tracks the shell's sidebar column rather than a fixed offset: its
// left edge sits 16px right of the sidebar's edge, and 80px while the shell has
// not laid that column out yet.
const measureUtilityLeft = () => {
  if (typeof document === 'undefined') return UTILITY_FALLBACK_LEFT_PX
  const overlay = document.querySelector('[data-shell-overlay]')
  const frame = overlay && overlay.parentElement
  const sidebar = frame && frame.firstElementChild
  const rect = sidebar && typeof sidebar.getBoundingClientRect === 'function'
    ? sidebar.getBoundingClientRect()
    : null
  if (!rect || !rect.right) return UTILITY_FALLBACK_LEFT_PX
  return Math.max(16, Math.round(rect.right + 16))
}
// The overlay layer commits before the frame's columns are laid out, so the
// first read answers the fallback; keep re-reading for ~2s and then stop.
const useUtilityLeft = () => {
  const [left, setLeft] = React.useState(UTILITY_FALLBACK_LEFT_PX)
  React.useEffect(() => {
    let stopped = false
    let tries = 0
    let frameId = 0
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
    const sync = () => {
      if (stopped) return
      const next = measureUtilityLeft()
      setLeft(next)
      if (next === UTILITY_FALLBACK_LEFT_PX && raf !== null && tries < UTILITY_MEASURE_TRIES) {
        tries += 1
        frameId = raf(sync)
      }
    }
    sync()
    window.addEventListener('resize', sync)
    return () => {
      stopped = true
      if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId)
      window.removeEventListener('resize', sync)
    }
  }, [])
  return left
}
// The block owns no dictionary, so its own title follows the browser
// language; each row's label comes from the plugin that contributes it.
const utilityTitle = () => {
  const nav = (typeof navigator !== 'undefined' && navigator.language) || ''
  return /^zh/i.test(nav) ? '工具面板' : 'Utility panels'
}
const utilityMenu = { open: false, listeners: new Set() }
const setUtilityMenu = (value) => {
  utilityMenu.open = !!value
  utilityMenu.listeners.forEach((listener) => listener())
}
const useUtilityMenu = () => {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    const listener = () => setTick((value) => value + 1)
    utilityMenu.listeners.add(listener)
    return () => utilityMenu.listeners.delete(listener)
  }, [])
  return utilityMenu.open
}
// The launcher and its menu. The menu is always rendered - a declared child
// slot is not conditionally declared - and hidden when closed. Choosing a row
// closes the menu through the click that bubbles out of it, because the rows
// belong to other plugins, not to this block.
function UtilityLauncher (props) {
  const left = useUtilityLeft()
  const open = useUtilityMenu()
  ensureUtilityStyles()
  React.useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      const target = event && event.target
      if (target && typeof target.closest === 'function' && target.closest('[data-utility-anchor]') !== null) return
      setUtilityMenu(false)
    }
    const onKey = (event) => { if (event && event.key === 'Escape') setUtilityMenu(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return h('div', {
    'data-utility-anchor': '',
    className: 'createhelper-utility-anchor',
    style: { left: left + 'px' }
  }, [
    h('div', {
      key: 'menu',
      className: 'createhelper-utility-menu',
      hidden: !open,
      onClick: () => setUtilityMenu(false)
    }, props && typeof props.renderSlot === 'function' ? props.renderSlot(UTILITY_ITEM_SLOT, {}) : null),
    h('button', {
      key: 'icon',
      type: 'button',
      className: 'createhelper-utility-launcher',
      title: utilityTitle(),
      'aria-label': utilityTitle(),
      'aria-expanded': open ? 'true' : 'false',
      onClick: () => setUtilityMenu(!open),
      dangerouslySetInnerHTML: { __html: UTILITY_ICON }
    })
  ])
}
// Whoever loads first owns the assembly; everyone else only contributes rows.
// The child slot is declared here, so a plugin that joins later still finds it
// through slots.inject, and an install with one plugin still gets a launcher.
//
// The seat belongs to the shell, so it is reached through inject: registering
// into it directly throws while that declaration is still pending, and a
// launcher must never cost the caller the surfaces it registers afterwards.
//
// The claim lives on the page and is released with its owner. Any plugin that
// embeds this block may win the claim, so without the release a hot reload of
// the owner would dispose its registration while the claim stayed taken, and the
// launcher would stay missing until the page was reloaded. A released claim wakes
// the other copies on the page, which re-register immediately.
const utilityClaim = () => {
  if (typeof window === 'undefined') return null
  const existing = window[UTILITY_MUTEX_KEY]
  if (existing !== null && typeof existing === 'object') return existing
  const claim = { owner: null, waiters: new Set() }
  window[UTILITY_MUTEX_KEY] = claim
  return claim
}
const registerUtilityLauncher = (scope) => {
  const claim = utilityClaim()
  if (claim === null) return
  if (claim.owner !== null) {
    claim.waiters.add(() => registerUtilityLauncher(scope))
    return
  }
  claim.owner = scope
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (claim.owner === scope) claim.owner = null
    if (window[UTILITY_MUTEX_KEY] !== claim) return
    const waiters = [...claim.waiters]
    claim.waiters.clear()
    for (const wake of waiters) wake()
  }
  scope.on('dispose', release)
  scope.slots.inject('shell.overlay', () => {
    try {
      scope.slots.register({
        name: 'shell.overlay',
        id: 'utility-launcher',
        order: 98,
        children: { [UTILITY_ITEM_SLOT]: { kind: 'list', scope: 'root' } }
      }, UtilityLauncher)
    } catch (error) {
      release()
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[utility-launcher] could not register the launcher', error)
      }
    }
  })
}
// </dsh-utility-launcher>
    // 本插件在共享启动器菜单里的行。选择它打开面板；点击会冒泡出这一行，菜单
    // 因此自行关闭。
    function TkMenuItem () {
      const t = useTexts()
      const open = useOpen()
      return h('button', {
        type: 'button',
        'aria-pressed': open ? 'true' : 'false',
        title: t.title,
        onClick: () => setOpen(true)
      }, [
        h('span', { key: 'icon', dangerouslySetInnerHTML: { __html: TREE_ICON } }),
        h('span', { key: 'label' }, t.title)
      ])
    }

    function TreeKeeperSurface() {
      const rootRef = React.useRef(null)
      const open = useOpen()
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [armed, setArmed] = React.useState(null)
      const [released, setReleased] = React.useState(null)
      const [census, setCensus] = React.useState(null)
      const requestRef = React.useRef(null)
      const focusRevision = useFocusRevision()
      const t = useTexts()

      // 先取确定性的根（标题栏入口），再取猜测的当前会话，最后为空。在这里读取
      // 已绑定的会话服务是安全的：它是在注入围栏内捕获的，从未在围栏外探测。
      const currentGuess = sessionsService && sessionsService.list && typeof sessionsService.list.getSnapshot === 'function'
        ? sessionsService.list.getSnapshot().current
        : null
      const rootSessionId = resolveRootSessionId(focusStore.value, currentGuess)

      const refresh = async () => {
        if (requestRef.current) requestRef.current.abort()
        const controller = new AbortController()
        requestRef.current = controller
        setLoading(true)
        try {
          const [res, censusRes] = await Promise.all([fetchSnapshot(rootSessionId, controller.signal), fetchCensus(controller.signal)])
          const body = await res.json().catch(() => null)
          if (!res.ok || !body || !body.ok) throw hostFailure(body, res.status)
          const censusBody = await censusRes.json().catch(() => null)
          if (requestRef.current !== controller) return
          setData(body)
          setCensus(censusRes.ok && censusBody && censusBody.ok ? censusBody : null)
          // 侧边栏行座位只读取这次加载观察到的事实。
          publishSessionFacts(body)
          setError(null)
        } catch (e) {
          if (controller.signal.aborted || requestRef.current !== controller) return
          setError(failureLine(t, e))
        } finally {
          if (requestRef.current === controller) {
            requestRef.current = null
            setLoading(false)
          }
        }
      }

      React.useEffect(() => {
        if (!open) return
        refresh()
        const dismiss = (event) => {
          const target = event.target
          const dockButton = target && typeof target.closest === 'function'
            ? target.closest('[data-createhelper-dock-item="treekeeper"]')
            : null
          if (!dockButton && rootRef.current && !rootRef.current.contains(target)) setOpen(false)
        }
        const closeOnEscape = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', dismiss)
        document.addEventListener('keydown', closeOnEscape)
        return () => {
          if (requestRef.current) requestRef.current.abort()
          requestRef.current = null
          document.removeEventListener('pointerdown', dismiss)
          document.removeEventListener('keydown', closeOnEscape)
        }
      }, [open, focusRevision])

      const kill = async (payload) => {
        try {
          const res = await fetch('/dsh-treekeeper/api?action=kill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body || !body.ok) throw hostFailure(body, res.status)
          await refresh()
        } catch (e) {
          setError(failureLine(t, e))
        }
      }

      // 释放与树杀走两条路径、两个 action：驻留子代可能根本没有对应的 OS 进程，
      // 而释放也不该顺带结束任何进程。请求体只带 childId，父由宿主谱系反查。
      const release = async (childId) => {
        setReleased(null)
        try {
          const res = await fetch('/dsh-treekeeper/api?action=release', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ childId })
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body || !body.ok) throw hostFailure(body, res.status)
          await refresh()
        } catch (e) {
          setError(failureLine(t, e))
        }
      }

      const setAllowRelease = async (value) => {
        try {
          await postConfig({ allowRelease: value })
          await refresh()
        } catch (e) {
          setError(failureLine(t, e))
        }
      }

      if (!open) return null
      return h('div', { className: 'tk-layer', ref: rootRef },
        h(Panel, {
          t, data, error, loading, armed, rootSessionId, census, released,
          onArm: setArmed,
          onKill: kill,
          onArmRelease: setReleased,
          onRelease: release,
          onSetAllowRelease: setAllowRelease,
          onRefresh: refresh,
          onClose: () => setOpen(false)
        }))
    }

    function cleanupLegacyUi() {
      for (const fab of document.querySelectorAll('.tk-fab')) fab.remove()
      for (const root of document.querySelectorAll('[data-dsh-treekeeper-root]')) root.remove()
      // 清掉页面级的旧容器：面板现在挂在宿主 overlay 里，页面上不应再出现这些
      // 节点。
      const legacyPanel = document.querySelector('.tk-panel')
      if (legacyPanel && legacyPanel.parentElement && legacyPanel.parentElement.parentElement === document.body) {
        legacyPanel.parentElement.remove()
      }
    }

    const plugin = {
      apply(ctx) {
        ensureStyles()
        cleanupLegacyUi()
        if (typeof ctx.inject === 'function') {
          ctx.inject(['locale'], (localeScope) => {
            if (!localeScope.locale) return
            let disposeDictionary = null
            let disposeSubscription = null
            try { disposeDictionary = localeScope.locale.register('dsh-treekeeper', { zh: I18N.zh, en: I18N.en }) } catch (e) { }
            localeState.set(localeScope.locale.bind('dsh-treekeeper'))
            if (typeof localeScope.locale.subscribe === 'function') disposeSubscription = localeScope.locale.subscribe(notifyLocale)
            if (typeof localeScope.on === 'function') {
              localeScope.on('dispose', () => {
                if (typeof disposeSubscription === 'function') disposeSubscription()
                if (typeof disposeDictionary === 'function') disposeDictionary()
                localeState.set(null)
              })
            }
          })
        }
        ctx.on('dispose', () => {
          setOpen(false)
          cleanupLegacyUi()
          const styleEl = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')
          if (styleEl) styleEl.remove()
        })
        ctx.inject(['slots'], (scope) => {
          if (typeof scope.inject === 'function') {
            scope.inject(['sessions'], (sessionScope) => {
              sessionsService = sessionScope.sessions
              sessionScope.on('dispose', () => {
                if (sessionsService === sessionScope.sessions) sessionsService = null
              })
            })
          }
          // 本插件向共享启动器菜单贡献一行；如果它是第一个加载的贡献者，还会
          // 声明启动器本身（见上面的 utility-launcher 片段）。
          scope.slots.inject(UTILITY_ITEM_SLOT, () => scope.slots.register(
            { name: UTILITY_ITEM_SLOT, id: 'treekeeper', order: 20, label: () => text('title') },
            () => h(TkMenuItem, null)))
          registerUtilityLauncher(scope)
          scope.slots.inject('shell.overlay', () => scope.slots.register(
            { name: 'shell.overlay', id: 'treekeeper-panel', order: 90, label: () => text('title') },
            () => h(TreeKeeperSurface)))
          // 会话作用域的入口。作用域 'session' 意味着框架保证存在存活的会话绑定，
          // sessionId 不会是面板猜的 `current`。slots.inject 的等待也能正常降级：
          // 没有这个槽位的宿主上，这项贡献根本不会挂载。
          scope.slots.inject('conversation.session.header.actions', () => scope.slots.register(
            { name: 'conversation.session.header.actions', id: 'treekeeper-open', order: 30, label: () => text('title') },
            SessionEntry))
          // 侧边栏会话行的常驻事实。两个座位都是根作用域，只拿到该行的
          // sessionId；两者都不采样宿主，因此图标只能报告面板上次加载缓存的内容。
          // order 20 与已发布的日程座位（10）相邻而不冲突。
          scope.slots.inject('sidebar.session.row.leading', () => scope.slots.register(
            { name: 'sidebar.session.row.leading', id: 'treekeeper', order: 20, label: () => text('title') },
            RowMark))
          scope.slots.inject('sidebar.session.row.hover', () => scope.slots.register(
            { name: 'sidebar.session.row.hover', id: 'treekeeper', order: 20, label: () => text('title') },
            RowHover))
        })
      }
    }

    // 这个包是没有模块系统的经典脚本，纯判定函数只能通过插件对象访问；测试
    // 直接驱动它们。属性不可枚举，加载器不会因此报警。
    Object.defineProperty(plugin, '_tkTest', {
      value: {
        subagentState: subagentStateFor,
        resolveRootSessionId,
        snapshotQuery,
        fetchSnapshot,
        hostFailure,
        failureLine,
        focusSession,
        getFocusSessionId: () => focusStore.value,
        sessionFactsFrom,
        publishSessionFacts,
        sessionFact,
        sessionFactIds: () => Array.from(factStore.value.keys()),
        splitDesktopApp,
        isOpen: () => openStore.value
      },
      enumerable: false
    })

    return plugin
  }
})
