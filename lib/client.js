// dsh-treekeeper browser half. Classic-script client bundle, the
// dsh-instance-manager pattern: register a factory with
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

    // <dsh-mini-utility-dock>
    // Mini Utility Dock bootstrap. DSH client artifacts are self-contained classic
    // scripts, so this fragment is embedded at build time. At runtime the dock is a
    // page-local protocol with no package or plugin dependency.
    //
    // Protocol invariants (createhelper.dsh.utility-dock v1), all page-local:
    //   - Exactly one dock container in the page. Whoever loads first creates it;
    //     everyone else joins. Joining never takes over an existing dock.
    //   - register() requires a non-empty `id` and an `onActivate()`; a dock item
    //     is a launcher, and each plugin owns and renders its own panel.
    //   - Activating one item deactivates the others.
    //   - An item's `icon` is untrusted markup: only a presentational inline SVG
    //     reaches the page, anything else renders the label as text.
    //   - The registration disposer carries an ownership token, so a stale HMR
    //     disposer cannot delete a newer registration for the same id.
    //   - Placement is shared and persisted; `hidden` keeps a recovery entry.

    const DOCK_KEY = '__CREATEHELPER_DSH_UTILITY_DOCK_V1__'
    const DOCK_PROTOCOL = 'createhelper.dsh.utility-dock'
    const DOCK_VERSION = 1
    const DOCK_PLACEMENT_KEY = 'createhelper.utilityDock.placement'
    const DOCK_CSS_ID = 'createhelper-utility-dock'
    const DOCK_SNAPSHOT = 'createhelper.utility-dock/1+placement'
    const DOCK_LEFT_FALLBACK_PX = 80

    const warnDockGeometry = (left) => {
      if (typeof console === 'undefined' || typeof console.warn !== 'function') return
      console.warn('[dsh-mini-utility-dock] shell geometry unavailable; falling back to left=' + left + 'px')
    }

    const isCompatibleDock = (value) => !!value &&
      typeof value.register === 'function' &&
      typeof value.setPlacement === 'function' &&
      typeof value.getPlacement === 'function' &&
      // Builds before the protocol metadata shipped already implemented v1.
      (value.protocol === undefined ||
        (value.protocol === DOCK_PROTOCOL && value.version === DOCK_VERSION))

    /**
     * Dock chrome styles live here because the creator owns the container. Both
     * shipped plugins previously carried their own copy of these five rules, so a
     * dock created by the plugin that happens to load second still painted.
     */
    function ensureUtilityDockStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + DOCK_CSS_ID + '"]') !== null) return
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin-css', DOCK_CSS_ID)
      styleEl.textContent =
        '.createhelper-utility-dock{position:fixed;bottom:16px;z-index:9997;display:flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 22px rgba(0,0,0,.24);pointer-events:auto}' +
        '.createhelper-utility-dock[hidden]{display:none}' +
        '.createhelper-utility-dock-item{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
        '.createhelper-utility-dock-item:hover,.createhelper-utility-dock-item[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
        '.createhelper-utility-dock-item svg{display:block}'
      document.head.appendChild(styleEl)
    }

    /**
     * An item's `icon` is markup another plugin hands to `innerHTML`, so the dock —
     * not each registrant — owns what reaches the page. Admit a single inline SVG
     * whose tags and attributes are presentational; `href`, `style`, `on*`,
     * `<script>` and `<foreignObject>` are exactly the shapes that turn an icon
     * into a script, and none of them draws a glyph.
     */
    const DOCK_ICON_TAGS = /^(svg|g|path|rect|circle|ellipse|line|polyline|polygon)$/i
    const DOCK_ICON_ATTRS = /^(width|height|viewBox|preserveAspectRatio|fill|fill-rule|fill-opacity|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-opacity|stroke-dasharray|stroke-dashoffset|opacity|d|x|y|x1|y1|x2|y2|rx|ry|cx|cy|r|points|transform|role|aria-hidden|focusable|class)$/i

    function safeDockIcon(icon) {
      if (typeof icon !== 'string') return false
      const markup = icon.trim()
      if (!/^<svg(?:\s|>)/i.test(markup) || !/<\/svg>$/i.test(markup)) return false
      // A comment, CDATA or processing instruction can carry markup the scans below
      // never look at.
      if (/<!--|<!\[CDATA\[|<\?|]]>/.test(markup)) return false
      // Splitting on `"` pairs the quotes up: an even segment count is an unbalanced
      // quote, and only the odd-index segments are quoted values. A value holding a
      // tag boundary would move `>` past what the scans below can see.
      const quoted = markup.split('"')
      if (quoted.length % 2 === 0) return false
      for (let i = 1; i < quoted.length; i += 2) {
        if (/[<>]/.test(quoted[i])) return false
      }
      if (/[\s"']on[a-z]+\s*=/i.test(markup)) return false
      if (/javascript\s*:/i.test(markup)) return false
      // A same-document fragment reference is how a gradient is painted; anything
      // else turns a presentational attribute into a network read.
      if (/url\(\s*(?!#)/i.test(markup)) return false
      const tags = markup.match(/<\/?[a-zA-Z][^>]*>/g)
      if (!tags) return false
      for (const tag of tags) {
        const name = /^<\/?\s*([^/>\s]+)/.exec(tag)
        if (!name || !DOCK_ICON_TAGS.test(name[1])) return false
        for (const raw of tag.match(/[^=<>\s]+\s*=/g) || []) {
          if (!DOCK_ICON_ATTRS.test(raw.replace(/\s*=$/, ''))) return false
        }
      }
      return true
    }

    /** Two characters stand in for an icon the dock could not admit. */
    function dockIconFallback(item) {
      const label = String(item.label || item.id || '')
      return label.slice(0, 2)
    }

    /**
     * A missing, blank, or non-string `label` would reach `render()` as `undefined`
     * and produce aria-label="undefined". `id` is always present (register() rejects
     * an empty one), so it is the safe, meaningful accessible name. Normalize once
     * on store — not at every render — so the stored item is always valid.
     */
    const normalizeDockLabel = (item) => {
      const label = typeof item.label === 'string' ? item.label.trim() : ''
      return label || item.id
    }

    function getUtilityDock() {
      if (isCompatibleDock(window[DOCK_KEY])) return window[DOCK_KEY]
      ensureUtilityDockStyles()
      const items = new Map()
      let root = null
      let resizeObserver = null
      let mutationObserver = null
      const readPlacement = () => {
        try {
          const value = localStorage.getItem(DOCK_PLACEMENT_KEY)
          if (value === 'main-bottom-right' || value === 'hidden') return value
        } catch (e) { }
        return 'main-bottom-left'
      }
      let placement = readPlacement()
      const findShellFrame = () => {
        const overlay = document.querySelector('[data-shell-overlay]')
        return (overlay && overlay.parentElement) || null
      }
      let geometryWarned = false
      const measureDockLeft = () => {
        const frame = findShellFrame()
        const sidebar = frame && frame.firstElementChild
        const sidebarRect = sidebar && typeof sidebar.getBoundingClientRect === 'function'
          ? sidebar.getBoundingClientRect()
          : null
        if (!sidebarRect) {
          if (!geometryWarned) {
            geometryWarned = true
            warnDockGeometry(DOCK_LEFT_FALLBACK_PX)
          }
          return DOCK_LEFT_FALLBACK_PX
        }
        return Math.max(16, Math.round(sidebarRect.right + 16))
      }
      const updateGeometry = () => {
        if (!root) return
        root.hidden = placement === 'hidden'
        root.dataset.placement = placement
        document.documentElement.dataset.createhelperUtilityDockPlacement = placement
        root.style.right = ''
        root.style.left = ''
        if (placement === 'main-bottom-right') {
          root.style.right = '16px'
          return
        }
        const left = measureDockLeft()
        root.style.left = left + 'px'
        document.documentElement.style.setProperty('--createhelper-utility-dock-left', left + 'px')
      }
      const render = () => {
        if (!root) {
          root = document.createElement('nav')
          root.className = 'createhelper-utility-dock'
          root.setAttribute('aria-label', 'DSH utilities')
          document.body.appendChild(root)
          window.addEventListener('resize', updateGeometry)
          const observeLayout = () => {
            const frame = findShellFrame()
            if (!frame) return false
            mutationObserver?.disconnect()
            mutationObserver = null
            if (typeof ResizeObserver === 'function' && !resizeObserver) {
              resizeObserver = new ResizeObserver(updateGeometry)
              resizeObserver.observe(frame)
              if (frame.firstElementChild) resizeObserver.observe(frame.firstElementChild)
            }
            updateGeometry()
            return true
          }
          if (!observeLayout() && typeof MutationObserver === 'function') {
            mutationObserver = new MutationObserver(() => { observeLayout() })
            mutationObserver.observe(document.body, { childList: true, subtree: true })
          }
        }
        root.replaceChildren()
        Array.from(items.values()).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).forEach((item) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'createhelper-utility-dock-item'
          button.dataset.createhelperDockItem = item.id
          button.title = item.label
          button.setAttribute('aria-label', item.label)
          button.setAttribute('aria-pressed', item.active ? 'true' : 'false')
          // Sanitized here, not in register(), so `update({ icon })` cannot be a
          // second way past the gate.
          if (safeDockIcon(item.icon)) button.innerHTML = item.icon
          else button.textContent = dockIconFallback(item)
          button.addEventListener('click', () => {
            if (!item.active) {
              for (const other of items.values()) {
                if (other.id !== item.id && other.active && typeof other.onDeactivate === 'function') {
                  other.onDeactivate()
                }
              }
            }
            item.onActivate()
          })
          root.appendChild(button)
        })
        updateGeometry()
      }
      const api = {
        protocol: DOCK_PROTOCOL,
        version: DOCK_VERSION,
        snapshot: DOCK_SNAPSHOT,
        register(item) {
          if (!item || typeof item.id !== 'string' || !item.id || typeof item.onActivate !== 'function') {
            throw new TypeError('utility dock item requires a non-empty id and onActivate()')
          }
          const registration = Object.freeze({})
          items.set(item.id, { ...item, registration, label: normalizeDockLabel(item), order: Number(item.order) || 0, active: !!item.active })
          render()
          return {
            update(patch) {
              const current = items.get(item.id)
              if (!current || current.registration !== registration) return
              const next = { ...current, ...patch }
              // Keep the stored label valid even when `update({ label })` is passed.
              next.label = normalizeDockLabel(next)
              items.set(item.id, next)
              render()
            },
            dispose() {
              const current = items.get(item.id)
              if (!current || current.registration !== registration) return
              items.delete(item.id)
              if (items.size) { render(); return }
              resizeObserver?.disconnect()
              resizeObserver = null
              mutationObserver?.disconnect()
              mutationObserver = null
              window.removeEventListener('resize', updateGeometry)
              root?.remove()
              root = null
            }
          }
        },
        setPlacement(next) {
          placement = next === 'main-bottom-right' || next === 'hidden' ? next : 'main-bottom-left'
          try { localStorage.setItem(DOCK_PLACEMENT_KEY, placement) } catch (e) { }
          updateGeometry()
        },
        getPlacement() { return placement }
      }
      window[DOCK_KEY] = api
      return api
    }
    // </dsh-mini-utility-dock>

    const CSS_ID = 'dsh-treekeeper'
    function ensureStyles() {
      if (typeof document === 'undefined') return null
      const existing = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')
      if (existing !== null) return existing
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin-css', CSS_ID)
      styleEl.textContent =
        '.createhelper-utility-dock{position:fixed;bottom:16px;z-index:9997;display:flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 22px rgba(0,0,0,.24);pointer-events:auto}' +
        '.createhelper-utility-dock[hidden]{display:none}' +
        '.createhelper-utility-dock-item{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
        '.createhelper-utility-dock-item:hover,.createhelper-utility-dock-item[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
        '.createhelper-utility-dock-item svg{display:block}' +
        '.tk-layer{position:fixed;inset:0;z-index:9998;pointer-events:none}' +
        '.tk-panel{position:fixed;left:var(--createhelper-utility-dock-left,80px);bottom:58px;width:420px;max-width:calc(100vw - 24px);max-height:min(520px,68vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;box-shadow:0 18px 54px rgba(0,0,0,.32);z-index:9998;pointer-events:auto;font-size:12.5px;color:var(--dsw-alias-label-primary);overflow:hidden}' +
        'html[data-createhelper-utility-dock-placement="main-bottom-right"] .tk-panel{left:auto;right:16px}' +
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
        '.tk-foot{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex:none}'
      document.head.appendChild(styleEl)
      return styleEl
    }

    const I18N = {
      zh: { title: 'TreeKeeper', subtitle: '进程树对账', leaks: '泄漏告警', none: '没有发现异常', jobs: '任务账本', subagents: '子代理树', selectSession: '未选定会话：在会话标题栏点击「在 TreeKeeper 中查看此会话」', unavailable: '当前 DSH 未提供此能力', host: 'DSH 宿主后代', unknown: '未归属进程', kill: '树杀', confirm: '确认杀整棵树？', confirmBody: '将对以下进程树执行 taskkill /T /F：', refresh: '刷新', refreshing: '采样中', close: '关闭', sampling: '正在读取当前宿主的进程快照…', degraded: '降级采样（无父进程链，已禁止树杀）', unattr: '未归属', closed: '连接失败', findings: '发现', descendants: '后代', hard: '确证', inferred: '推断', inferredSection: '推断级发现（仅指示性线索，不可树杀）', viewInTreeKeeper: '在 TreeKeeper 中查看此会话', session: '会话' },
      en: { title: 'TreeKeeper', subtitle: 'process reconciliation', leaks: 'Leak findings', none: 'Nothing unusual', jobs: 'Job ledger', subagents: 'Subagent tree', selectSession: 'No session selected: use "View this session in TreeKeeper" in the session header', unavailable: 'This DSH build does not provide the capability', host: 'DSH host descendants', unknown: 'Unattributed', kill: 'Kill tree', confirm: 'Kill the whole tree?', confirmBody: 'taskkill /T /F will run on this tree:', refresh: 'Refresh', refreshing: 'Sampling', close: 'Close', sampling: 'Reading the current host process snapshot…', degraded: 'Degraded sampling (tree kill disabled)', unattr: 'unattributed', closed: 'request failed', findings: 'Findings', descendants: 'Descendants', hard: 'hard', inferred: 'inferred', inferredSection: 'Inferred findings (indicative only, no kill)', viewInTreeKeeper: 'View this session in TreeKeeper', session: 'session' }
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

    function TreeIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
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
    let dockItem = null
    const setOpen = (value) => {
      openStore.open = !!value
      openStore.listeners.forEach((listener) => listener())
      dockItem?.update({ active: openStore.open })
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
    const fetchSnapshot = (rootSessionId) =>
      fetch('/dsh-treekeeper/api' + snapshotQuery(rootSessionId), { headers: { accept: 'application/json' } })

    // The session-scope header action. The slot contract guarantees sessionId
    // is a live session, so the chip is always actionable; capability absence
    // is reported by the panel (unavailable state), not by hiding the entry.
    function SessionEntry(props) {
      const lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const t = I18N[lang]
      return h('button', {
        className: 'tk-session-entry',
        type: 'button',
        title: t.viewInTreeKeeper,
        'aria-label': t.viewInTreeKeeper,
        onClick: () => focusSession(props.sessionId)
      }, t.viewInTreeKeeper)
    }

    function TreeKeeperSurface() {
      const rootRef = React.useRef(null)
      const open = useOpen()
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [armed, setArmed] = React.useState(null)
      const focusRevision = useFocusRevision()
      const lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const t = I18N[lang]

      // Deterministic root first (the header entry), guessed current selection
      // second, nothing last. Reading the bound sessions service here is safe:
      // it was captured inside the injection fence, never probed off it.
      const currentGuess = sessionsService && sessionsService.list && typeof sessionsService.list.getSnapshot === 'function'
        ? sessionsService.list.getSnapshot().current
        : null
      const rootSessionId = resolveRootSessionId(focusStore.sessionId, currentGuess)

      const refresh = async () => {
        setLoading(true)
        try {
          const res = await fetchSnapshot(rootSessionId)
          const body = await res.json()
          if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status))
          setData(body)
          setError(null)
        } catch (e) {
          setError(t.closed + ': ' + String(e && e.message ? e.message : e))
        } finally {
          setLoading(false)
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
        ctx.on('dispose', () => {
          dockItem?.dispose()
          dockItem = null
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
          const dock = getUtilityDock()
          dockItem = dock.register({
            id: 'treekeeper',
            order: 20,
            label: 'TreeKeeper',
            icon: TREE_ICON,
            active: openStore.open,
            onDeactivate: () => setOpen(false),
            onActivate: () => setOpen(!openStore.open)
          })
          scope.slots.inject('shell.overlay', () => scope.slots.register(
            { name: 'shell.overlay', id: 'treekeeper-panel', order: 90, label: 'TreeKeeper' },
            () => h(TreeKeeperSurface)))
          // DTK-M2 session-scope entry. scope 'session' means the framework
          // guarantees a live Session binding, so sessionId is never the
          // panel's guessed `current`. The slots.inject wait also degrades
          // cleanly: on builds without this slot the contribution never mounts.
          scope.slots.inject('conversation.session.header.actions', () => scope.slots.register(
            { name: 'conversation.session.header.actions', id: 'treekeeper-open', order: 30, label: 'TreeKeeper' },
            SessionEntry))
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
        getFocusSessionId: () => focusStore.sessionId
      },
      enumerable: false
    })

    return plugin
  }
})
