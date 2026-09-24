// dsh-treekeeper browser half. Classic-script client bundle, the standard
// DSH client-module pattern: register a factory with
// window.__ModuleLoader__, React from the platform seed, data from the
// same-origin JSON endpoint /dsh-treekeeper/api (host half).
//
// The entry joins the Mini Utility Dock, mounted just outside the sidebar at
// the bottom of the page.
// of the main content area; each plugin still owns its own panel and state.
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
        // The panel followed the retired dock's measured left offset; it is pinned
        // to the frame's top-right corner now — like the family's other panels —
        // so it never lands on the sidebar's controls or the composer.
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
        '.tk-btn-arm{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-overlay)}' +
        '.tk-err{margin:2px 2px 8px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px}' +
        '.tk-empty{padding:12px 8px;text-align:center;color:var(--dsw-alias-label-secondary)}' +
        '.tk-loading{padding:28px 10px;text-align:center;color:var(--dsw-alias-label-secondary)}' +
        // DTK-M2 session-scope header action: a small chip that says "view
        // this session in TreeKeeper". The header host owns spacing, so the
        // entry only styles itself.
        '.tk-session-entry{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;white-space:nowrap}' +
        '.tk-session-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
        // DTK-M3: the two ambient Session-row seats. The leading glyph lives in
        // the row's own 16px cell and must stay a passive mark (no tab stop),
        // so the span only paints a 12px icon in the inherited text colour.
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
      zh: { title: 'TreeKeeper', subtitle: '进程树对账', leaks: '泄漏告警', none: '没有发现异常', jobs: '任务账本', subagents: '子代理树', selectSession: '未选定会话：在会话标题栏点击「在 TreeKeeper 中查看此会话」', unavailable: '当前 DSH 未提供此能力', host: 'DSH 宿主后代', unknown: '未归属进程', kill: '树杀', confirm: '确认杀整棵树？', confirmBody: '将对以下进程树执行 taskkill /T /F：', refresh: '刷新', refreshing: '采样中', close: '关闭', sampling: '正在读取当前宿主的进程快照…', degraded: '降级采样（无父进程链，已禁止树杀）', unattr: '未归属', closed: '连接失败', findings: '发现', descendants: '后代', hard: '确证', inferred: '推断', inferredSection: '推断级发现（仅指示性线索，不可树杀）', viewInTreeKeeper: '在 TreeKeeper 中查看此会话', session: '会话', rowFact: 'TreeKeeper 已缓存此会话的进程事实', rowRunning: '运行中', rowDiagnostic: '读取异常' },
      en: { title: 'TreeKeeper', subtitle: 'process reconciliation', leaks: 'Leak findings', none: 'Nothing unusual', jobs: 'Job ledger', subagents: 'Subagent tree', selectSession: 'No session selected: use "View this session in TreeKeeper" in the session header', unavailable: 'This DSH build does not provide the capability', host: 'DSH host descendants', unknown: 'Unattributed', kill: 'Kill tree', confirm: 'Kill the whole tree?', confirmBody: 'taskkill /T /F will run on this tree:', refresh: 'Refresh', refreshing: 'Sampling', close: 'Close', sampling: 'Reading the current host process snapshot…', degraded: 'Degraded sampling (tree kill disabled)', unattr: 'unattributed', closed: 'request failed', findings: 'Findings', descendants: 'Descendants', hard: 'hard', inferred: 'inferred', inferredSection: 'Inferred findings (indicative only, no kill)', viewInTreeKeeper: 'View this session in TreeKeeper', session: 'session', rowFact: 'TreeKeeper holds cached facts for this session', rowRunning: 'running', rowDiagnostic: 'read issues' }
    }
    const fallbackLanguage = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const localeState = { translate: null, revision: 0, listeners: new Set() }
    const text = (key) => {
      if (localeState.translate) {
        const translated = localeState.translate(key)
        if (translated && translated !== key) return translated
      }
      return I18N[fallbackLanguage][key] || I18N.en[key] || key
    }
    const texts = () => Object.fromEntries(Object.keys(I18N.en).map((key) => [key, text(key)]))
    const useTexts = () => {
      const [, setRevision] = React.useState(localeState.revision)
      React.useEffect(() => {
        const listener = () => setRevision(localeState.revision)
        localeState.listeners.add(listener)
        return () => localeState.listeners.delete(listener)
      }, [])
      return texts()
    }
    const notifyLocale = () => {
      localeState.revision += 1
      localeState.listeners.forEach((listener) => listener())
    }

    // DTK-M1 noise policy, as data: a finding with an attribution chain
    // (confidence exact/indicative) is hard evidence and stays expanded; a
    // finding the heuristics produced without any host-tree link is inferred
    // and collapses behind a disclosure. Unknown/legacy payloads (no
    // confidence field) count as hard so old snapshots stay visible.
    function findingTier(finding) {
      return finding && finding.confidence === 'inferred' ? 'inferred' : 'hard'
    }
    function partitionFindings(findings) {
      const hard = []
      const inferred = []
      for (const finding of findings || []) {
        (findingTier(finding) === 'hard' ? hard : inferred).push(finding)
      }
      return { hard, inferred }
    }
    // One dim line per finding answering "why is this here": the rule that
    // fired plus the ownership chain (scope, and the session/job link when
    // the ledger join found one).
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
      const { t, data, error, loading, armed, rootSessionId, onArm, onKill, onRefresh, onClose } = props
      const findings = (data && data.findings) || []
      const { hard, inferred } = partitionFindings(findings)
      const rec = (data && data.reconcile) || { summary: {} }
      const unknown = (data && data.unknown) || []
      const exact = ((data && data.processes) || []).filter((process) => process.evidence === 'exact' && process.pid !== data.pid)
      const rows = (rec && rec.rows) || []
      const canKill = !!(data && !data.degraded)
      const jobRows = rows.filter((row) => row.source === 'job')
      const subagents = (data && Array.isArray(data.subagents)) ? data.subagents : []
      // DTK-M2 three-state: available (root resolved + host has the seam),
      // root-required (no session yet), unavailable (capability missing).
      const subagentState = subagentStateFor(data, rootSessionId)
      return h('section', { className: 'tk-panel', 'aria-label': t.title },
        h('div', { className: 'tk-head' },
          h('div', { className: 'tk-titlegroup' },
            h('div', { className: 'tk-titleicon', 'aria-hidden': 'true' }, h(TreeIcon)),
            h('div', null, h('div', { className: 'tk-title' }, t.title), h('div', { className: 'tk-subtitle' }, t.subtitle))),
          h('div', { style: { flex: 1 } }),
          data && data.degraded ? h('span', { className: 'tk-badge tk-warn' }, t.degraded) : null,
          h('button', { className: 'tk-headbtn', onClick: onRefresh, disabled: loading, title: loading ? t.refreshing : t.refresh }, loading ? t.refreshing : t.refresh),
          h('button', { className: 'tk-headbtn tk-close', onClick: onClose, title: t.close, 'aria-label': t.close }, '×')),
        h('div', { className: 'tk-body' },
          error ? h('div', { className: 'tk-err' }, error) : null,
          loading && !data ? h('div', { className: 'tk-loading' }, t.sampling) : h('div', { className: 'tk-sec' },
            data ? h('div', { className: 'tk-summary' },
              h('span', null, t.findings + ' ', h('strong', null, String(findings.length))),
              h('span', { className: 'tk-dim' }, t.hard + ' ' + hard.length + ' · ' + t.inferred + ' ' + inferred.length),
              h('span', { className: 'tk-sep', 'aria-hidden': 'true' }),
              h('span', null, t.descendants + ' ', h('strong', null, String(exact.length)))) : null,
            h('div', { className: 'tk-sechead' }, t.leaks,
              h('span', { className: 'tk-badge ' + (findings.length ? 'tk-red' : 'tk-ok') }, String(findings.length)),
              rec.summary ? h('span', { className: 'tk-dim' },
                'jobs ' + (rec.summary.jobs || 0) + ' · matched ' + (rec.summary.jobsMatched || 0) +
                ' · os-only ' + (rec.summary.osOnly || 0) + ' · unattributed ' + (rec.summary.unattributed || 0)) : null),
            findings.length === 0
              ? h('div', { className: 'tk-empty' }, t.none)
              : h('div', null,
                  hard.map((f, i) => findingRow(t, f, i, armed, onArm, onKill, data, canKill)),
                  inferred.length
                    ? h('details', { className: 'tk-disclosure', key: 'tk-inferred' },
                        h('summary', null, t.inferredSection,
                          h('span', { className: 'tk-badge tk-dim' }, String(inferred.length))),
                        inferred.map((f, i) => findingRow(t, f, i, armed, onArm, onKill, data, canKill)))
                    : null),
            // Descendants are context, not a finding: they are already counted in
            // the summary above, so an expanded list of healthy host processes
            // pushed the actionable sections (未归属进程 / 任务账本 / 子代理树) below
            // the fold. Every sibling section is a closed disclosure for the same
            // reason; this one now matches.
            h('details', { className: 'tk-disclosure', key: 'tk-host' },
              h('summary', null, t.host, h('span', { className: 'tk-badge tk-dim' }, String(exact.length))),
              exact.length === 0
                ? h('div', { className: 'tk-empty' }, t.none)
                : exact.slice(0, 16).map((p) => processRow(t, armed, onArm, onKill, p, canKill))),
            h('details', { className: 'tk-disclosure' },
              h('summary', null, t.unknown, h('span', { className: 'tk-badge tk-dim' }, String(unknown.length))),
              unknown.length === 0
                ? h('div', { className: 'tk-empty' }, t.none)
                : unknown.slice(0, 20).map((p) => processRow(t, armed, onArm, onKill, p, canKill))),
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

    // One glyph for both the panel title (16px, no props) and the DTK-M3 row
    // mark (12px via `size`); every size inherits currentColor.
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
     * The server authorizes kills by `rootLabel === 'harness'`: whitelisted
     * pids are pinned for investigation, and their descendants are not the DSH
     * host tree. A button the server would reject with 409 is a lie, so the UI
     * applies the same rule instead of trusting `evidence` alone.
     */
    function killAuthorizedFor(data, pid) {
      const rows = (data && data.processes) || []
      const row = rows.find((candidate) => candidate.pid === pid)
      return !!(row && row.attribution && row.attribution.rootLabel === 'harness')
    }

    function findingRow(t, finding, index, armed, onArm, onKill, data, canKill) {
      const tier = findingTier(finding)
      return h('div', { className: 'tk-row', key: 'f' + (finding.key ?? index) },
        h('span', { className: 'tk-badge ' + (tier === 'hard' ? 'tk-warn' : 'tk-dim') },
          (tier === 'hard' ? t.hard : t.inferred) + ' ' + finding.type),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'tk-dim' }, finding.detail),
          h('div', { className: 'tk-dim' }, findingMeta(finding)),
          h('div', { className: 'tk-cmd' }, (finding.evidence && finding.evidence.sample) || '')),
        // Inferred findings are heuristic-only leads, never kill candidates.
        tier === 'hard' && canKill && finding.pids && finding.pids.length === 1 && killAuthorizedFor(data, finding.pids[0])
          ? killBtn(t, armed, onArm, onKill, finding.pids[0], (finding.evidence && finding.evidence.sample) || finding.detail, processCreatedMs(data, finding.pids[0]))
          : null)
    }

    function processRow(t, armed, onArm, onKill, process, canKill) {
      return h('div', { className: 'tk-row', key: 'p' + process.pid },
        h('span', { className: 'tk-badge ' + (process.evidence === 'exact' ? 'tk-ok' : 'tk-dim') }, process.evidence === 'exact' ? 'exact' : t.unattr),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'tk-cmd' }, (process.cmdline || process.name || '').slice(0, 200)),
          h('div', { className: 'tk-dim' }, 'pid ' + process.pid + ' · ' + Math.round((process.wsBytes || 0) / 1048576) + ' MB' + (process.createdMs ? ' · ' + Math.max(0, Math.round((Date.now() - process.createdMs) / 60000)) + ' min' : ''))),
        // `evidence: 'exact'` only means "attributed"; authorization is
        // narrower — the attribution root must be the harness itself.
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

    const TREE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v6M7 9h10M7 9v5M17 9v5M12 9v8"></path><circle cx="7" cy="17" r="2"></circle><circle cx="12" cy="20" r="2"></circle><circle cx="17" cy="17" r="2"></circle></svg>'

    const openStore = { open: false, listeners: new Set() }
    let sessionsService = null
    const setOpen = (value) => {
      openStore.open = !!value
      openStore.listeners.forEach((listener) => listener())
    }
    const useOpen = () => {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const listener = () => setTick((value) => value + 1)
        openStore.listeners.add(listener)
        return () => openStore.listeners.delete(listener)
      }, [])
      return openStore.open
    }

    // DTK-M2: deterministic session entry. `conversation.session.header.actions`
    // is scope 'session', so a registered component receives a sessionId the
    // framework guarantees resolves to a live session — the panel can stop
    // guessing from `sessions.list.getSnapshot().current`. Clicking the header
    // entry focuses the panel on that session: it records the id here, then
    // opens (or, if already open, re-samples) through the same open path.
    const focusStore = { sessionId: null, revision: 0, listeners: new Set() }
    const focusSession = (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return
      focusStore.sessionId = sessionId
      focusStore.revision += 1
      focusStore.listeners.forEach((listener) => listener())
      setOpen(true)
    }
    const useFocusRevision = () => {
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        const listener = () => setRevision(focusStore.revision)
        focusStore.listeners.add(listener)
        return () => focusStore.listeners.delete(listener)
      }, [])
      return revision
    }

    // DTK-M3 per-session fact cache, in the style of the stores above. The two
    // sidebar Session-row seats mount per row, so neither may touch the host:
    // this map is filled only from a snapshot the panel already loaded, and an
    // occupant renders nothing when it holds no fact for its sessionId.
    //
    // Only facts the host attributes to ONE session are stored: the focused
    // root's subagent rows (the request names that root and nothing else),
    // running jobs whose ledger row carries `ownerSession`, and findings whose
    // ledger join filled `ownership.session`. No part of a snapshot attributes
    // a host process row, the unattributed bucket, or a job without an owner
    // session to a session, so none of them are cached.
    const factStore = { facts: new Map(), revision: 0, listeners: new Set() }

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
          // A diagnostic row is a fact about the read, not a descendant.
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

    // Replace the whole map: one body is the session state just observed, and
    // keeping entries it no longer contains would leave a stale row glyph.
    function publishSessionFacts(body) {
      factStore.facts = sessionFactsFrom(body)
      factStore.revision += 1
      factStore.listeners.forEach((listener) => listener())
    }
    const sessionFact = (sessionId) =>
      typeof sessionId === 'string' && sessionId ? factStore.facts.get(sessionId) || null : null
    const useFactRevision = () => {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => {
        const listener = () => setRevision(factStore.revision)
        factStore.listeners.add(listener)
        return () => factStore.listeners.delete(listener)
      }, [])
      return factStore.revision
    }

    // Pure decision helpers (DTK-M2). The session header entry proves a
    // session only while a session is open; the panel, mounted on the root
    // shell.overlay slot, must still say what it is missing.
    function resolveRootSessionId(focusSessionId, currentGuess) {
      if (typeof focusSessionId === 'string' && focusSessionId) return focusSessionId
      if (typeof currentGuess === 'string' && currentGuess) return currentGuess
      return null
    }
    // Data is host-authoritative once a snapshot landed; before that the local
    // root is the only signal. Shared ordering with lib/shared.js
    // subagentAvailability so host and client can never disagree.
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
    // One request path for the panel and for the session entry's focused
    // re-sample; the root is always explicit (never re-derived server side).
    const fetchSnapshot = (rootSessionId, signal) =>
      fetch('/dsh-treekeeper/api' + snapshotQuery(rootSessionId), { headers: { accept: 'application/json' }, signal: signal })

    // DTK-M3 leading occupant. `sidebar.session.row.leading` mounts on every
    // idle Session row, so this component reads only factStore: no fetch, no
    // session binding, no timer. The standard `useSessions` / `useSessionStatus`
    // props are deliberately left untouched — subscribing per row is host work
    // the seat must not cause — and no cached fact for this sessionId means no
    // glyph at all.
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

    // DTK-M3 hover occupant: one compact line of the cached facts for that row,
    // then the discovery action. The action opens the panel through exactly the
    // path the session-header entry uses, and it works with an empty cache —
    // that click is how a row TreeKeeper has not looked at yet gets looked at.
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
        parts.push(t.descendants + ' ' + fact.descendants +
          (fact.running > 0 ? ' (' + fact.running + ' ' + t.rowRunning + ')' : ''))
      }
      if (fact.jobs > 0) parts.push(t.jobs + ' ' + fact.jobs)
      if (fact.findings > 0) parts.push(t.findings + ' ' + fact.findings)
      if (fact.diagnostics > 0) parts.push(fact.diagnostics + ' ' + t.rowDiagnostic)
      return parts.join(' · ')
    }

    // The session-scope header action. The slot contract guarantees sessionId
    // is a live session, so the chip is always actionable; capability absence
    // is reported by the panel (unavailable state), not by hiding the entry.
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
// Family utility launcher shared by the browser halves of the DSH plugins.
//
// This fragment has ONE source of truth: dsh-mini-utility-dock/dist/launcher.js.
// DSH client artifacts are self-contained classic scripts, so the fragment is
// embedded into lib/client.js at build time by
//   npm run launcher:sync    (write it)
//   npm run launcher:check   (fail on drift)
// instead of being imported: a bare import would put a runtime dependency on the
// dock into every plugin, and the whole point of the dock is that a plugin ships
// standalone, with nothing else required.
//
// The launcher is one icon that opens a menu of family panels. It is contributed
// through slots, not through a page-local protocol: exactly one copy of this
// assembly runs per page (the first plugin to load wins the window mutex and
// declares the menu seat), and every plugin adds one row to that seat.
const UTILITY_ITEM_SLOT = 'createhelper.utility.item'
const UTILITY_MUTEX_KEY = '__CREATEHELPER_DSH_UTILITY_LAUNCHER_V1__'
const UTILITY_CSS_ID = 'createhelper-utility-launcher'
const UTILITY_FALLBACK_LEFT_PX = 80
const UTILITY_MEASURE_TRIES = 120
const UTILITY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"></rect><rect x="14" y="3" width="7" height="7" rx="2"></rect><rect x="3" y="14" width="7" height="7" rx="2"></rect><rect x="14" y="14" width="7" height="7" rx="2"></rect></svg>'

// The launcher's own chrome, injected once by whichever copy wins the mutex.
// The rows belong to other plugins, so the menu styles its own buttons by
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

// The position rule the retired page dock used: right of the sidebar, 16px
// in, and 80px when the shell has not laid the column out yet.
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
// are other plugins' components.
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
// The claim lives on the page and is released with its owner. Every family
// client half carries this assembly, so without the release a hot reload of the
// owner would dispose its registration while the claim stayed taken, and the
// launcher would stay missing until the page was reloaded. A released claim
// wakes the other copies, which re-register immediately.
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
        console.error('[utility-launcher] could not register the family launcher', error)
      }
    }
  })
}
// </dsh-utility-launcher>
    // This plugin's row in the family utility menu. Choosing it opens the panel;
    // the menu closes itself because the click bubbles out of the row.
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
      const requestRef = React.useRef(null)
      const focusRevision = useFocusRevision()
      const t = useTexts()

      // Deterministic root first (the header entry), guessed current selection
      // second, nothing last. Reading the bound sessions service here is safe:
      // it was captured inside the injection fence, never probed off it.
      const currentGuess = sessionsService && sessionsService.list && typeof sessionsService.list.getSnapshot === 'function'
        ? sessionsService.list.getSnapshot().current
        : null
      const rootSessionId = resolveRootSessionId(focusStore.sessionId, currentGuess)

      const refresh = async () => {
        if (requestRef.current) requestRef.current.abort()
        const controller = new AbortController()
        requestRef.current = controller
        setLoading(true)
        try {
          const res = await fetchSnapshot(rootSessionId, controller.signal)
          const body = await res.json()
          if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status))
          if (requestRef.current !== controller) return
          setData(body)
          // DTK-M3: the row seats read only what this load observed.
          publishSessionFacts(body)
          setError(null)
        } catch (e) {
          if (controller.signal.aborted || requestRef.current !== controller) return
          setError(t.closed + ': ' + String(e && e.message ? e.message : e))
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
          const body = await res.json()
          if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status))
          await refresh()
        } catch (e) {
          setError(t.closed + ': ' + String(e && e.message ? e.message : e))
        }
      }

      if (!open) return null
      return h('div', { className: 'tk-layer', ref: rootRef },
        h(Panel, {
          t, data, error, loading, armed, rootSessionId,
          onArm: setArmed,
          onKill: kill,
          onRefresh: refresh,
          onClose: () => setOpen(false)
        }))
    }

    function cleanupLegacyUi() {
      for (const fab of document.querySelectorAll('.tk-fab')) fab.remove()
      for (const root of document.querySelectorAll('[data-dsh-treekeeper-root]')) root.remove()
      // Remove the wrapper left by pre-contract builds, which mounted the
      // panel before returning an invalid plugin object.
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
            localeState.translate = localeScope.locale.bind('dsh-treekeeper')
            if (typeof localeScope.locale.subscribe === 'function') disposeSubscription = localeScope.locale.subscribe(notifyLocale)
            notifyLocale()
            if (typeof localeScope.on === 'function') {
              localeScope.on('dispose', () => {
                if (typeof disposeSubscription === 'function') disposeSubscription()
                if (typeof disposeDictionary === 'function') disposeDictionary()
                localeState.translate = null
                notifyLocale()
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
          // This plugin contributes one row to the family menu, and claims the
          // menu itself when this plugin is the first family member to load (see
          // the utility-launcher block above).
          scope.slots.inject(UTILITY_ITEM_SLOT, () => scope.slots.register(
            { name: UTILITY_ITEM_SLOT, id: 'treekeeper', order: 20, label: () => text('title') },
            () => h(TkMenuItem, null)))
          registerUtilityLauncher(scope)
          scope.slots.inject('shell.overlay', () => scope.slots.register(
            { name: 'shell.overlay', id: 'treekeeper-panel', order: 90, label: () => text('title') },
            () => h(TreeKeeperSurface)))
          // DTK-M2 session-scope entry. scope 'session' means the framework
          // guarantees a live Session binding, so sessionId is never the
          // panel's guessed `current`. The slots.inject wait also degrades
          // cleanly: on builds without this slot the contribution never mounts.
          scope.slots.inject('conversation.session.header.actions', () => scope.slots.register(
            { name: 'conversation.session.header.actions', id: 'treekeeper-open', order: 30, label: () => text('title') },
            SessionEntry))
          // DTK-M3 ambient session-row facts. Both seats are root-scoped and
          // receive only the row's sessionId; neither samples the host, so the
          // glyph can only report what the panel's last load cached. Order 20
          // sits beside the shipped schedule occupants (10) without colliding.
          scope.slots.inject('sidebar.session.row.leading', () => scope.slots.register(
            { name: 'sidebar.session.row.leading', id: 'treekeeper', order: 20, label: () => text('title') },
            RowMark))
          scope.slots.inject('sidebar.session.row.hover', () => scope.slots.register(
            { name: 'sidebar.session.row.hover', id: 'treekeeper', order: 20, label: () => text('title') },
            RowHover))
        })
      }
    }

    // The bundle is a classic script with no module system, so the pure
    // decision helpers are reachable only through the plugin object; tests
    // drive them directly. Non-enumerable so no loader diagnostic trips on it.
    Object.defineProperty(plugin, '_tkTest', {
      value: {
        subagentState: subagentStateFor,
        resolveRootSessionId,
        snapshotQuery,
        fetchSnapshot,
        focusSession,
        getFocusSessionId: () => focusStore.sessionId,
        sessionFactsFrom,
        publishSessionFacts,
        sessionFact,
        sessionFactIds: () => Array.from(factStore.facts.keys()),
        isOpen: () => openStore.open
      },
      enumerable: false
    })

    return plugin
  }
})
