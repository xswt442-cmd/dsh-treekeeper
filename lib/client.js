// dsh-treekeeper browser half. Classic-script client bundle, the
// dsh-instance-manager pattern: register a factory with
// window.__ModuleLoader__, React from the platform seed, data from the
// same-origin JSON endpoint /dsh-treekeeper/api (host half).
//
// Panel: floating card, three sections — leak findings (top), ledger × OS
// reconcile summary, and the unattributed bucket (the plugin's whole point)
// with guarded kill buttons (two-step confirm, shows the command line).
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
        '.tk-fab{position:fixed;left:14px;bottom:14px;z-index:9997;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:6px 12px;cursor:pointer;font:inherit;font-size:12px}' +
        '.tk-fab:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}' +
        '.tk-panel{position:fixed;left:14px;bottom:52px;width:460px;max-width:calc(100vw - 28px);max-height:min(600px,76vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);z-index:9998;font-size:12.5px;color:var(--dsw-alias-label-primary);overflow:hidden}' +
        '.tk-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}' +
        '.tk-title{margin:0;font-size:13.5px;font-weight:600}' +
        '.tk-body{overflow:auto;padding:8px}' +
        '.tk-sec{margin:4px 6px 10px}' +
        '.tk-sechead{font-weight:600;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin:6px 2px 4px;display:flex;gap:8px;align-items:center}' +
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
        '.tk-empty{padding:16px 10px;text-align:center;color:var(--dsw-alias-label-secondary)}' +
        '.tk-foot{padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex:none}'
      document.head.appendChild(styleEl)
      return styleEl
    }

    const I18N = {
      zh: { title: 'TreeKeeper · 进程树对账', leaks: '泄漏告警', none: '没有发现异常', jobs: '未归属任务账本', host: 'DSH 宿主后代', unknown: '未归属进程', kill: '树杀', confirm: '确认杀整棵树？', confirmBody: '将对以下进程树执行 taskkill /T /F：', refresh: '刷新', degraded: '降级采样（无父进程链，已禁止树杀）', unattr: '未归属', closed: '连接失败' },
      en: { title: 'TreeKeeper · process tree', leaks: 'Leak findings', none: 'Nothing unusual', jobs: 'Unowned-job ledger', host: 'DSH host descendants', unknown: 'Unattributed', kill: 'Kill tree', confirm: 'Kill the whole tree?', confirmBody: 'taskkill /T /F will run on this tree:', refresh: 'Refresh', degraded: 'Degraded sampling (tree kill disabled)', unattr: 'unattributed', closed: 'request failed' }
    }

    function Panel(props) {
      const { t, data, error, armed, onArm, onKill, onRefresh } = props
      const findings = (data && data.findings) || []
      const rec = (data && data.reconcile) || { summary: {} }
      const unknown = (data && data.unknown) || []
      const exact = ((data && data.processes) || []).filter((process) => process.evidence === 'exact' && process.pid !== data.pid)
      const rows = (rec && rec.rows) || []
      const canKill = !!(data && !data.degraded)
      const jobRows = rows.filter((row) => row.source === 'job')
      return h('div', { className: 'tk-panel' },
        h('div', { className: 'tk-head' },
          h('div', { className: 'tk-title' }, t.title),
          h('div', { style: { flex: 1 } }),
          data && data.degraded ? h('span', { className: 'tk-badge tk-warn' }, t.degraded) : null,
          h('button', { className: 'tk-btn', onClick: onRefresh }, t.refresh)),
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
              : exact.slice(0, 40).map((p) => processRow(t, armed, onArm, onKill, p, canKill)),
            h('div', { className: 'tk-sechead' }, t.unknown + ' · ' + unknown.length),
            unknown.length === 0
              ? h('div', { className: 'tk-empty' }, t.none)
              : unknown.slice(0, 40).map((p) => processRow(t, armed, onArm, onKill, p, canKill)),
            h('div', { className: 'tk-sechead' }, t.jobs + ' · ' + jobRows.length),
            jobRows.length === 0
              ? h('div', { className: 'tk-empty' }, t.none)
              : jobRows.map((row, index) => h('div', { className: 'tk-row', key: 'j' + index },
                  h('span', { className: 'tk-badge tk-ok' }, row.status),
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { className: 'tk-cmd' }, (row.label || '').slice(0, 160)),
                    h('div', { className: 'tk-dim' }, jobDescription(row)))))),
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

    const mount = { open: false, data: null, error: null, armed: null }
    const rootHolder = { el: null }

    async function refresh(render) {
      try {
        const res = await fetch('/dsh-treekeeper/api?action=snapshot', { headers: { accept: 'application/json' } })
        mount.data = await res.json()
        mount.error = null
      } catch (e) {
        mount.error = I18N.zh.closed + ': ' + String(e)
      }
      render()
    }

    function render() {
      if (!mount.open || !rootHolder.el) return
      const lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const t = I18N[lang]
      rootHolder.el.innerHTML = ''
      rootHolder.el.appendChild(document.createElement('div'))
      // Render via React into the holder.
      const ReactDom = require('react-dom')
      ReactDom.createRoot(rootHolder.el).render(
        h(Panel, {
          t,
          data: mount.data,
          error: mount.error,
          armed: mount.armed,
          onArm: (v) => { mount.armed = v; render() },
          onKill: (payload) => {
            fetch('/dsh-treekeeper/api?action=kill', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload)
            }).then(() => refresh(render)).catch(() => render())
          },
          onRefresh: () => refresh(render)
        }))
    }

    // Mount: a small FAB that toggles the panel. The sidebar-footer hook is
    // the P1 entry (same slot dim uses); the FAB works on every web build.
    function ensureFab() {
      cleanupUi()
      const fab = document.createElement('button')
      fab.className = 'tk-fab'
      fab.textContent = '🌳 TreeKeeper'
      fab.addEventListener('click', () => {
        mount.open = !mount.open
        if (mount.open) {
          rootHolder.el = document.createElement('div')
          rootHolder.el.setAttribute('data-dsh-treekeeper-root', '')
          document.body.appendChild(rootHolder.el)
          render()
          refresh(render)
        } else if (rootHolder.el) {
          rootHolder.el.remove()
          rootHolder.el = null
        }
      })
      document.body.appendChild(fab)
    }

    function cleanupUi() {
      for (const fab of document.querySelectorAll('.tk-fab')) fab.remove()
      for (const root of document.querySelectorAll('[data-dsh-treekeeper-root]')) root.remove()
      // Remove the wrapper left by pre-contract builds, which mounted the
      // panel before returning an invalid plugin object.
      const legacyPanel = document.querySelector('.tk-panel')
      if (legacyPanel && legacyPanel.parentElement && legacyPanel.parentElement.parentElement === document.body) {
        legacyPanel.parentElement.remove()
      }
      rootHolder.el = null
      mount.open = false
    }

    const plugin = {
      apply(ctx) {
        const mountUi = () => {
          ensureStyles()
          ensureFab()
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUi, { once: true })
        else mountUi()

        ctx.on('dispose', () => {
          document.removeEventListener('DOMContentLoaded', mountUi)
          cleanupUi()
          const styleEl = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')
          if (styleEl) styleEl.remove()
        })
      }
    }

    return plugin
  }
})
