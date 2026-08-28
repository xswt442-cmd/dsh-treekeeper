// dsh-treekeeper browser half. Classic-script client bundle, the
// dsh-instance-manager pattern: register a factory with
// window.__ModuleLoader__, React from the platform seed, data from the
// same-origin JSON endpoint /dsh-treekeeper/api (host half).
//
// The entry rides DSH's additive sidebar footer slot and the card is a fixed
// popover anchored above it. This keeps Settings and other plugin entries in
// normal layout flow instead of competing with a body-level floating button.
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
        '.tk-layer{display:flex;align-items:center;position:relative}' +
        '.tk-entry{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
        '.tk-entry:hover,.tk-entry[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
        '.tk-entry-rail{width:36px;height:36px;color:var(--dsw-alias-label-primary)}' +
        '.tk-panel{position:fixed;width:400px;max-width:calc(100vw - 24px);max-height:min(480px,65vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);z-index:9998;font-size:12.5px;color:var(--dsw-alias-label-primary);overflow:hidden}' +
        '.tk-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}' +
        '.tk-title{margin:0;font-size:13.5px;font-weight:600}' +
        '.tk-headbtn{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px}' +
        '.tk-headbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
        '.tk-close{width:26px;padding:0;font-size:16px}' +
        '.tk-body{overflow:auto;padding:7px 8px}' +
        '.tk-sec{margin:2px 4px 7px}' +
        '.tk-sechead{font-weight:600;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin:6px 2px 4px;display:flex;gap:8px;align-items:center}' +
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
        '.tk-row{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px}' +
        '.tk-row:hover{background:var(--dsw-alias-bg-layer-2)}' +
        '.tk-cmd{font-family:ui-monospace,Consolas,Menlo,monospace;font-size:11px;word-break:break-all;color:var(--dsw-alias-label-primary)}' +
        '.tk-btn{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent;border-radius:6px;padding:2px 8px;cursor:pointer;font:inherit;font-size:11px;white-space:nowrap;flex:none}' +
        '.tk-btn:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-overlay)}' +
        '.tk-btn-arm{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-overlay)}' +
        '.tk-err{margin:4px 8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px}' +
        '.tk-empty{padding:9px 8px;text-align:center;color:var(--dsw-alias-label-secondary)}' +
        '.tk-foot{padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex:none}'
      document.head.appendChild(styleEl)
      return styleEl
    }

    const I18N = {
      zh: { title: 'TreeKeeper · 进程树对账', leaks: '泄漏告警', none: '没有发现异常', jobs: '未归属任务账本', host: 'DSH 宿主后代', unknown: '未归属进程', kill: '树杀', confirm: '确认杀整棵树？', confirmBody: '将对以下进程树执行 taskkill /T /F：', refresh: '刷新', close: '关闭', degraded: '降级采样（无父进程链，已禁止树杀）', unattr: '未归属', closed: '连接失败' },
      en: { title: 'TreeKeeper · process tree', leaks: 'Leak findings', none: 'Nothing unusual', jobs: 'Unowned-job ledger', host: 'DSH host descendants', unknown: 'Unattributed', kill: 'Kill tree', confirm: 'Kill the whole tree?', confirmBody: 'taskkill /T /F will run on this tree:', refresh: 'Refresh', close: 'Close', degraded: 'Degraded sampling (tree kill disabled)', unattr: 'unattributed', closed: 'request failed' }
    }

    function Panel(props) {
      const { t, data, error, armed, onArm, onKill, onRefresh, onClose, style } = props
      const findings = (data && data.findings) || []
      const rec = (data && data.reconcile) || { summary: {} }
      const unknown = (data && data.unknown) || []
      const exact = ((data && data.processes) || []).filter((process) => process.evidence === 'exact' && process.pid !== data.pid)
      const rows = (rec && rec.rows) || []
      const canKill = !!(data && !data.degraded)
      const jobRows = rows.filter((row) => row.source === 'job')
      return h('section', { className: 'tk-panel', style, 'aria-label': t.title },
        h('div', { className: 'tk-head' },
          h('div', { className: 'tk-title' }, t.title),
          h('div', { style: { flex: 1 } }),
          data && data.degraded ? h('span', { className: 'tk-badge tk-warn' }, t.degraded) : null,
          h('button', { className: 'tk-headbtn', onClick: onRefresh }, t.refresh),
          h('button', { className: 'tk-headbtn tk-close', onClick: onClose, title: t.close, 'aria-label': t.close }, '×')),
        h('div', { className: 'tk-body' },
          error ? h('div', { className: 'tk-err' }, error) : null,
          h('div', { className: 'tk-sec' },
            h('div', { className: 'tk-sechead' }, t.leaks,
              h('span', { className: 'tk-badge ' + (findings.length ? 'tk-red' : 'tk-ok') }, String(findings.length)),
              rec.summary ? h('span', { className: 'tk-dim' },
                'jobs ' + (rec.summary.jobs || 0) + ' · matched ' + (rec.summary.jobsMatched || 0) +
                ' · os-only ' + (rec.summary.osOnly || 0) + ' · unattributed ' + (rec.summary.unattributed || 0)) : null),
            findings.length === 0
              ? h('div', { className: 'tk-empty' }, t.none)
              : findings.map((f, i) => h('div', { className: 'tk-row', key: 'f' + i },
                  h('span', { className: 'tk-badge tk-warn' }, f.type),
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { className: 'tk-dim' }, f.detail),
                    h('div', { className: 'tk-cmd' }, (f.evidence && f.evidence.sample) || '')),
                  canKill && f.pids && f.pids.length === 1
                    ? killBtn(t, armed, onArm, onKill, f.pids[0], (f.evidence && f.evidence.sample) || f.detail, processCreatedMs(data, f.pids[0]))
                    : null)),
            h('div', { className: 'tk-sechead' }, t.host + ' · ' + exact.length),
            exact.length === 0
              ? h('div', { className: 'tk-empty' }, t.none)
              : exact.slice(0, 16).map((p) => processRow(t, armed, onArm, onKill, p, canKill)),
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

    function jobDescription(row) {
      if (row.pids && row.pids.length) return row.id + ' → pid ' + row.pids.join(', ')
      return row.id + (row.indicative ? ' → no pid match (indicative join)' : '')
    }

    function processRow(t, armed, onArm, onKill, process, canKill) {
      return h('div', { className: 'tk-row', key: 'p' + process.pid },
        h('span', { className: 'tk-badge ' + (process.evidence === 'exact' ? 'tk-ok' : 'tk-dim') }, process.evidence === 'exact' ? 'exact' : t.unattr),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'tk-cmd' }, (process.cmdline || process.name || '').slice(0, 200)),
          h('div', { className: 'tk-dim' }, 'pid ' + process.pid + ' · ' + Math.round((process.wsBytes || 0) / 1048576) + ' MB' + (process.createdMs ? ' · ' + Math.max(0, Math.round((Date.now() - process.createdMs) / 60000)) + ' min' : ''))),
        canKill ? killBtn(t, armed, onArm, onKill, process.pid, process.cmdline || process.name, process.createdMs) : null)
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

    function TreeIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true'
      },
      h('path', { d: 'M12 3v6M7 9h10M7 9v5M17 9v5M12 9v8' }),
      h('circle', { cx: 7, cy: 17, r: 2 }),
      h('circle', { cx: 12, cy: 20, r: 2 }),
      h('circle', { cx: 17, cy: 17, r: 2 }))
    }

    function TreeKeeperEntry(props) {
      const rootRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [armed, setArmed] = React.useState(null)
      const lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const t = I18N[lang]

      const refresh = async () => {
        try {
          const res = await fetch('/dsh-treekeeper/api?action=snapshot', { headers: { accept: 'application/json' } })
          const body = await res.json()
          if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status))
          setData(body)
          setError(null)
        } catch (e) {
          setError(t.closed + ': ' + String(e && e.message ? e.message : e))
        }
      }

      React.useLayoutEffect(() => {
        if (!open) return
        const place = () => {
          const rect = rootRef.current && rootRef.current.getBoundingClientRect()
          if (!rect) return
          setAnchor({
            left: Math.max(12, Math.min(rect.left, window.innerWidth - 412)),
            bottom: window.innerHeight - rect.top + 8
          })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open, props.wide])

      React.useEffect(() => {
        if (!open) return
        refresh()
        const dismiss = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const closeOnEscape = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', dismiss)
        document.addEventListener('keydown', closeOnEscape)
        return () => {
          document.removeEventListener('pointerdown', dismiss)
          document.removeEventListener('keydown', closeOnEscape)
        }
      }, [open])

      const kill = async (payload) => {
        try {
          await fetch('/dsh-treekeeper/api?action=kill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          })
        } finally {
          refresh()
        }
      }

      return h('div', { className: 'tk-layer', ref: rootRef },
        open && anchor ? h(Panel, {
          t, data, error, armed, style: anchor,
          onArm: setArmed,
          onKill: kill,
          onRefresh: refresh,
          onClose: () => setOpen(false)
        }) : null,
        h('button', {
          type: 'button',
          className: 'tk-entry' + (props.wide ? '' : ' tk-entry-rail'),
          title: t.title,
          'aria-label': t.title,
          'aria-expanded': open,
          'data-open': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value)
        }, h(TreeIcon)))
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
        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('sidebar.footer.action', () => slots.register(
          { name: 'sidebar.footer.action', id: 'treekeeper', order: -20, label: 'TreeKeeper' },
          (props) => h(TreeKeeperEntry, props)))

        ctx.on('dispose', () => {
          cleanupLegacyUi()
          const styleEl = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')
          if (styleEl) styleEl.remove()
        })
      }
    }

    return plugin
  }
})
