window.__ModuleLoader__.load({
  id: 'dsh-statusline-plus',
  factory: function (require) {
    var module = { exports: {} }
    var React = require('react')
    var COMPONENT_ORDER = ['git', 'context', 'tps', 'cost', 'activity', 'tools']
    var COMPONENTS = {
      git: { field: 'showGit', label: 'layoutGit', fallback: true },
      context: { field: 'showContext', label: 'layoutContext', fallback: true },
      tps: { field: 'showTps', label: 'layoutTps', fallback: false },
      cost: { field: 'showCost', label: 'layoutCost', fallback: true },
      activity: { field: 'showActivity', label: 'layoutActivityLabel', fallback: true },
      tools: { field: 'showTools', label: 'layoutTools', fallback: true },
    }
    function componentOrder(value) {
      var picked = Array.isArray(value) ? value.slice(0, 32).filter(function (id, i, all) { return COMPONENT_ORDER.indexOf(id) !== -1 && all.indexOf(id) === i }) : []
      return picked.concat(COMPONENT_ORDER.filter(function (id) { return picked.indexOf(id) === -1 }))
    }
    function reorderComponent(value, source, target, after) {
      var order = componentOrder(value)
      if (source === target || order.indexOf(source) === -1 || order.indexOf(target) === -1) return order
      order.splice(order.indexOf(source), 1)
      order.splice(order.indexOf(target) + (after ? 1 : 0), 0, source)
      return order
    }
    function clearOrderDrag(list) {
      var drag = list && list.slpOrderDrag
      if (!drag) return
      delete list.slpOrderDrag
      Array.from(list.children).forEach(function (row) { row.removeAttribute('data-dragging'); row.removeAttribute('data-drop') })
      if (drag.handle.hasPointerCapture && drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
    }
    function startOrderDrag(event, id) {
      var handle = event.currentTarget, list = handle.closest('.slp-order-list')
      if (!list || event.button !== 0 || event.isPrimary === false || handle.matches(':disabled')) return
      clearOrderDrag(list)
      event.preventDefault()
      handle.focus()
      list.slpOrderDrag = { source: id, pointerId: event.pointerId, handle: handle, startY: event.clientY, active: false, target: null }
      if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId)
    }
    function moveOrderDrag(event) {
      var list = event.currentTarget, drag = list.slpOrderDrag
      if (!drag || drag.pointerId !== event.pointerId) return
      if (!drag.active && Math.abs(event.clientY - drag.startY) < 4) return
      drag.active = true
      event.preventDefault()
      var box = list.getBoundingClientRect(), rows = Array.from(list.children)
      rows.forEach(function (row) {
        row.removeAttribute('data-drop')
        row.setAttribute('data-dragging', row.getAttribute('data-component') === drag.source ? 'true' : 'false')
      })
      drag.target = null
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top - 8 || event.clientY > box.bottom + 8) return
      var row = rows.find(function (item) { return event.clientY <= item.getBoundingClientRect().bottom }) || rows[rows.length - 1]
      if (!row) return
      var bounds = row.getBoundingClientRect()
      drag.target = row.getAttribute('data-component')
      drag.after = event.clientY >= bounds.top + bounds.height / 2
      row.setAttribute('data-drop', drag.after ? 'after' : 'before')
    }
    function finishOrderDrag(event, config, onChange) {
      var list = event.currentTarget, drag = list.slpOrderDrag
      if (!drag || drag.pointerId !== event.pointerId) return
      moveOrderDrag(event)
      var next = drag.active && drag.target ? reorderComponent(config.componentOrder, drag.source, drag.target, drag.after) : null
      clearOrderDrag(list)
      if (next && JSON.stringify(next) !== JSON.stringify(componentOrder(config.componentOrder))) onChange({ componentOrder: next })
    }
    function componentEnabled(config, id) {
      var spec = COMPONENTS[id], value = config[spec.field]
      return value === undefined ? spec.fallback : !!value
    }
    function layoutPreset(id) {
      var patch = { showGit: true, showContext: true, showCost: true, showTps: true, showActivity: true, showTools: true, componentOrder: COMPONENT_ORDER.slice() }
      if (id === 'minimal') Object.assign(patch, { showTps: false, showActivity: false, showTools: false })
      else if (id === 'activity') patch.componentOrder = ['tools', 'activity', 'git', 'context', 'tps', 'cost']
      else if (id !== 'balanced') return null
      return patch
    }
    function matchingPreset(config) {
      return ['balanced', 'minimal', 'activity'].find(function (id) {
        var patch = layoutPreset(id)
        return Object.keys(patch).every(function (key) { return key === 'componentOrder' ? JSON.stringify(componentOrder(config[key])) === JSON.stringify(patch[key]) : !!config[key] === patch[key] })
      }) || 'custom'
    }

    var CSS = [
      // Shared typography and spacing for native statistics and plugin metrics.
      '[data-slot="conversation.composer.dock"]{display:flex!important;flex-direction:row!important;flex-wrap:wrap!important;justify-content:center!important;align-items:center!important;gap:4px var(--slp-gap,16px)!important;max-width:var(--dsh-chat-content-width)!important;width:100%!important;margin:0 auto!important;box-sizing:border-box!important;padding:0.2em 0 0!important;font-size:max(13px,var(--dsh-content-font-size-secondary,13px))!important;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))!important;color:var(--dsw-alias-label-secondary)!important}',
      '[data-slot="conversation.composer.dock"] > [data-composer-stats]{width:auto!important;max-width:none!important;margin:0!important;padding:0!important;flex:0 1 auto!important;display:inline-flex!important;align-items:center!important;flex-wrap:wrap!important;gap:var(--slp-gap,16px)!important;font:inherit!important;min-height:24px}',
      '[data-slot="conversation.composer.dock"] > [data-composer-stats] :is(button,span):has(> svg){font:inherit!important;color:inherit;padding:2px 0!important;border-radius:4px}',
      '[data-slot="conversation.composer.dock"] > .slp-root{width:auto!important;max-width:100%!important;margin:0!important;padding:0!important;flex:0 1 auto!important;order:2}',
      // Flatten only the dock containing our row. The native ring remains owned
      // by DSH and keeps its portal/details; CSS places it last in native stats.
      'div:has(> [data-slot="conversation.composer.dock"] > .slp-root){--slp-gap:16px;flex-wrap:wrap;gap:4px var(--slp-gap);min-width:0;max-width:100%;font-size:max(13px,var(--dsh-content-font-size-secondary,13px));font-weight:400;font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-secondary)}div:has(> [data-slot="conversation.composer.dock"] > .slp-root) > [data-slot="conversation.composer.dock"]{display:contents!important}div:has(> [data-slot="conversation.composer.dock"] > .slp-root) > span:has(button svg circle){order:1;flex:none}div:has(> [data-slot="conversation.composer.dock"] > .slp-root) > span:has(button svg circle) > button{font:inherit;color:inherit;padding:2px 0;border-radius:4px}',
      '.slp-root{display:flex;flex-direction:column;align-items:center;gap:0.2em;max-width:var(--dsh-chat-content-width);width:auto;margin:0;box-sizing:border-box;padding:0;font-size:inherit;line-height:inherit;color:inherit}',
      '.slp-row{display:flex;align-items:center;gap:4px var(--slp-gap,16px);min-width:0;flex-wrap:wrap;justify-content:center;width:auto;max-width:100%;box-sizing:border-box}',
      '.slp-row > *{flex:0 1 auto;max-width:100%}',
      '.slp-row > *{position:relative}.slp-row > * + *::before{content:"";position:absolute;inset-inline-start:calc(var(--slp-gap,16px) / -2);top:50%;height:0.75em;transform:translateY(-50%);border-inline-start:1px solid var(--dsw-alias-border-l3)}.slp-row > *[data-line-start="true"]::before{display:none}',
      '.slp-group{display:inline-flex;align-items:center;white-space:nowrap;min-width:0;min-height:24px}',
      '.slp-git{max-width:100%;min-width:0}.slp-git > button{min-width:0;max-width:100%;flex-wrap:wrap;white-space:normal}.slp-git-branch,.slp-git-path{min-width:0;max-width:min(32ch,100%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}',
      '.slp-quota-root{position:relative;display:inline-flex;align-items:center;outline:none}',
      '.slp-quota-trigger{display:inline-flex;align-items:center;gap:8px;padding:1px 8px;font-variant-numeric:tabular-nums;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);cursor:pointer;font-size:inherit;font-family:inherit;line-height:1.5;color:var(--dsw-alias-label-secondary);user-select:none;white-space:nowrap;transition:border-color .15s ease,opacity .15s ease,background .15s ease}',
      '.slp-quota-trigger:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 75%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}.slp-quota-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-quota-trigger[aria-expanded="true"]{border-color:var(--dsw-alias-border-l2)}.slp-quota-name{font-weight:500}.slp-quota-muted{opacity:.65}span.slp-quota-muted{cursor:default}',
      '.slp-header-group,.slp-quota-with-age{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;max-width:100%;font-size:max(13px,var(--dsh-content-font-size-secondary,13px))}.slp-quota-age{font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}.slp-quota-age.slp-stale{color:var(--dsw-alias-state-warn-label)}',
      '.slp-peak-trigger{font-size:max(13px,var(--dsh-content-font-size-secondary,13px));font-variant-numeric:tabular-nums}.slp-peak-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor}',
      '.slp-peak-trigger[data-peak="off"]{background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-state-success-primary) 24%,var(--dsw-alias-bg-layer-1)) 50%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-border-l1))}.slp-peak-trigger[data-peak="off"]:hover{background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,var(--dsw-alias-bg-layer-1)) 50%,transparent)}',
      '.slp-peak-trigger[data-peak="peak"]{background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-state-warn-label) 24%,var(--dsw-alias-bg-layer-1)) 50%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-label) 55%,var(--dsw-alias-border-l1))}.slp-peak-trigger[data-peak="peak"]:hover{background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-state-warn-label) 32%,var(--dsw-alias-bg-layer-1)) 50%,transparent)}.slp-panel.slp-peak-panel{background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 94%,transparent)}',
      '.slp-peak-panel{max-width:min(380px,calc(100vw - 24px))}.slp-peak-panel p{margin:6px 0}.slp-peak-timeline{position:relative;display:flex;height:8px;border-radius:4px;overflow:hidden;margin:8px 0}',
      '.slp-peak-dot-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 36px;width:36px;height:36px;padding:0;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary)}.slp-peak-dot-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.slp-peak-dot-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-peak-dot-btn[data-peak="peak"]{color:var(--dsw-alias-state-warn-label)}.slp-peak-dot-btn[data-peak="off"]{color:var(--dsw-alias-state-success-primary)}.slp-peak-dot-lg{display:block;width:12px;height:12px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 28%,transparent)}.slp-panel.slp-panel-fixed{position:fixed;top:auto;right:auto!important;left:8px;bottom:56px;max-height:calc(100vh - 80px);overflow:auto}',
      '.slp-panel.slp-peak-compact{min-width:0;width:max-content;max-width:min(240px,calc(100vw - 24px));padding:8px 10px;font-size:12px;line-height:1.5}.slp-peak-compact p{margin:2px 0;color:var(--dsw-alias-label-secondary)}.slp-peak-compact .slp-peak-timeline{width:200px;max-width:100%;height:6px;margin:6px 0}.slp-peak-compact > strong{display:block;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}.slp-peak-compact > strong[data-peak="peak"]{color:var(--dsw-alias-state-warn-label)}.slp-peak-compact > strong[data-peak="off"]{color:var(--dsw-alias-state-success-primary)}.slp-peak-compact .slp-peak-link{font-size:12px}',
      '.slp-peak-alert{color:var(--dsw-alias-state-warn-label)!important}.slp-peak-source{font-size:12px;color:var(--dsw-alias-label-tertiary)}.slp-peak-dot-btn{position:relative}.slp-peak-dot-btn[data-alert="true"]::after{content:"";position:absolute;top:8px;right:8px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}',
      '.slp-peak-cursor{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-label-primary)}.slp-peak-link{color:var(--dsw-alias-brand-primary)}',
      '.slp-seg{display:inline-flex;align-items:center;gap:4px}',
      '.slp-seg-label{opacity:.8;flex:none}',
      '.slp-err{color:var(--dsw-alias-state-error-primary)}',
      '.slp-git-branch{font-variant-numeric:tabular-nums}',
      '.slp-git-trigger{display:inline-flex;align-items:center;gap:6px;font:inherit;color:inherit;border:0;border-radius:4px;background:none;padding:2px 0;cursor:pointer;font-variant-numeric:tabular-nums}.slp-git-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.slp-git-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}',
      '.slp-git-path{font:inherit;color:inherit;font-variant-numeric:tabular-nums}',
      '.slp-git-staged{color:var(--dsw-alias-state-success-primary)}',
      '.slp-git-unstaged{color:var(--dsw-alias-state-warn-primary)}',
      '.slp-git-conflict{color:var(--dsw-alias-state-error-primary);font-weight:500}',
      '.slp-git-added{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}',
      '.slp-git-deleted{color:var(--dsw-alias-state-error-primary);font-variant-numeric:tabular-nums}',
      '.slp-tps{font-variant-numeric:tabular-nums;white-space:nowrap}.slp-muted{color:var(--dsw-alias-label-tertiary)}',
       '.slp-context{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;white-space:nowrap}',
       '.slp-context-label{color:inherit}',
       '.slp-context-pct.s{color:var(--dsw-alias-state-success-primary)}',
       '.slp-context-pct.w{color:var(--dsw-alias-state-warn-primary)}',
       '.slp-context-pct.d{color:var(--dsw-alias-state-error-primary)}',
      '.slp-context{flex-wrap:wrap;gap:4px 6px}.slp-activity-trigger,.slp-cost-trigger{font:inherit;color:inherit;background:none;border:0;border-radius:4px;padding:2px 0;cursor:pointer;max-width:100%;white-space:normal;text-align:start;font-variant-numeric:tabular-nums}.slp-activity-trigger:hover,.slp-cost-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.slp-activity-panel,.slp-cost-panel{bottom:calc(100% + 8px);white-space:normal}.slp-activity-item{display:flex;flex-wrap:wrap;gap:4px 10px;margin:6px 0}.slp-activity-item > span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}',
      // ---- 额度 chip 内的分段条 ----
      '.slp-codex-fill{display:inline-block;width:22px;height:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent);overflow:hidden;vertical-align:middle}',
      '.slp-codex-pct{min-width:24px;text-align:left;color:var(--dsw-alias-label-secondary)}',
       '.slp-codex-reset{color:var(--dsw-alias-state-warn-label);font-size:11px;font-variant-numeric:tabular-nums}',
      // ---- 毛玻璃详情面板 ----
      '@keyframes slp-pop{from{opacity:0;transform:translateY(-4px) scale(.97)}to{opacity:1;transform:none}}',
      '.slp-panel{position:absolute;right:0;z-index:9999;min-width:min(300px,calc(100vw - 24px));max-width:calc(100vw - 24px);box-sizing:border-box;overflow-wrap:anywhere;background:var(--dsw-alias-bg-overlay);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent);border-radius:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 12px 32px rgba(0,0,0,.35);padding:10px 12px;font-size:max(13px,var(--dsh-content-font-size-secondary,13px));color:var(--dsw-alias-label-primary);animation:slp-pop .14s ease-out}',
      '.slp-panel-down{top:calc(100% + 6px)}',
      '@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))){.slp-panel{background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 46%,transparent);backdrop-filter:blur(26px) saturate(1.9);-webkit-backdrop-filter:blur(26px) saturate(1.9)}}',
      '.slp-panel-title{font-size:inherit;font-weight:600;margin:0 0 8px}.slp-panel-mode{margin-inline-start:6px;font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
      '.slp-bar{display:flex;align-items:center;gap:5px;font-size:12px;line-height:18px;white-space:nowrap;min-width:0}',
      '.slp-bar-swatch{flex:none;width:8px;height:8px;border-radius:2px}',
      '.slp-bar-label{flex:none;width:5.5em;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.slp-bar-track{flex:1 1 auto;min-width:48px;height:5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent);overflow:hidden}',
      '.slp-bar-fill{display:block;height:100%;border-radius:999px;min-width:4px;transition:width .35s ease}',
      '.slp-bar-val{flex:none;min-width:5em;text-align:left;white-space:nowrap}',
      '.slp-bar-pct{font-variant-numeric:tabular-nums;font-weight:500}',
      '.slp-bar-reset{font-size:10px;color:var(--dsw-alias-state-warn-label);font-variant-numeric:tabular-nums}',
      '.slp-panel-note{margin:4px 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}.slp-panel-note.slp-err{color:var(--dsw-alias-state-error-primary)}.slp-link-btn{font:inherit;color:var(--dsw-alias-brand-primary);background:none;border:0;padding:0;cursor:pointer}.slp-link-btn:hover{text-decoration:underline}.slp-link-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:2px}',
      '.slp-panel.slp-cost-panel{min-width:0;width:min(224px,calc(100vw - 24px));padding:7px 9px;font-size:12px;line-height:18px}.slp-cost-head{display:flex;align-items:center;justify-content:space-between;gap:6px}.slp-cost-head .slp-hint{margin:0}.slp-cost-amount{margin:3px 0;font-size:16px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums}.slp-cost-table{width:100%;border-collapse:collapse;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}.slp-cost-table th,.slp-cost-table td{padding:2px 0;text-align:end}.slp-cost-table th:first-child,.slp-cost-table td:first-child{text-align:start}.slp-cost-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.slp-cost-table th{font-weight:400}.slp-cost-panel .slp-panel-note{margin:4px 0 0;font-size:11px;line-height:16px}.slp-cost-reasons{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(min-width:481px){.slp-cost-panel .slp-hint:is(:hover,:focus)::after{inset-inline-start:auto;inset-inline-end:0;top:auto;bottom:calc(100% + 8px)}}',
      '.slp-cost-bar{display:flex;gap:1px;height:4px;margin:6px 0 4px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover)}.slp-cost-segment{flex:0 1 auto;min-width:0;height:100%;border-radius:1px}.slp-cost-label{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary)}.slp-cost-swatch{flex:none;width:7px;height:7px;border-radius:2px}.slp-cost-tint[data-kind="input"]{background:var(--dsw-static-neutral-bluish-400,#94a3b8)}.slp-cost-tint[data-kind="cache"]{background:#a78bfa}.slp-cost-tint[data-kind="output"]{background:var(--dsw-static-blue-450,#4086ff)}',
      '.slp-cost-tokens{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.slp-panel.slp-subagent-panel{min-width:0;width:min(280px,calc(100vw - 24px));padding:9px 11px;max-height:min(360px,calc(100dvh - 100px));overflow:auto}.slp-subagent-summary{margin:4px 0 7px;font-size:11px;color:var(--dsw-alias-label-secondary)}.slp-subagent-panel .slp-activity-item{display:block;margin:0;padding:7px 0}.slp-subagent-panel .slp-activity-item + .slp-activity-item{border-top:1px solid var(--dsw-alias-border-l1)}.slp-subagent-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;font-size:13px;font-weight:600;line-height:1.4}.slp-subagent-model-row,.slp-subagent-state-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:3px;font-size:11px;line-height:1.4}.slp-subagent-model-row{justify-content:flex-start;gap:6px}.slp-subagent-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}.slp-subagent-effort{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);padding:1px 4px;border-radius:4px}.slp-subagent-state-row{color:var(--dsw-alias-label-tertiary)}.slp-subagent-state-row time{flex:none;font-variant-numeric:tabular-nums}.slp-subagent-status[data-running="true"]{color:var(--dsw-alias-state-success-primary)}',
      '.slp-balance{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;margin:2px 0 6px}.slp-balance > .slp-panel-note{flex-basis:100%;margin:0}.slp-balance-amount{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}.slp-balance-amount.slp-err{color:var(--dsw-alias-state-error-primary)}.slp-balance-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.slp-acct + .slp-acct{margin-top:8px;padding-top:8px;border-top:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}.slp-acct-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;font-weight:600;margin-bottom:3px}.slp-acct-state{font-size:11px;font-weight:400;opacity:.7}.slp-acct-state.slp-acct-current{color:var(--dsw-alias-brand-primary);opacity:1}.slp-acct-state.slp-err{opacity:1}',
      '.slp-panel-foot{margin-top:8px;padding-top:6px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px}',
      // ---- 设置页 ----
      '.slp-set{display:flex;flex-direction:column;gap:12px;padding:4px 2px}.slp-set-head{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:4px 12px}.slp-save-state{font-size:12px;color:var(--dsw-alias-label-tertiary)}.slp-set-actions{display:inline-flex;align-items:center;flex-wrap:wrap;gap:8px}.slp-btn.slp-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.slp-inline-seg{margin-inline-start:8px}.slp-check-row > .slp-check-text{font-size:12px;color:var(--dsw-alias-label-primary)}.slp-save-state.slp-err{color:var(--dsw-alias-state-error-primary)}',
      // ⓘ tooltip: shown on hover and on focus (keyboard, or tap on touch screens).
      '.slp-hint{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;margin-inline-start:6px;border-radius:50%;font-size:12px;font-weight:400;line-height:1;color:var(--dsw-alias-label-tertiary);cursor:help;vertical-align:middle}.slp-hint:hover,.slp-hint:focus{color:var(--dsw-alias-brand-primary);outline:none}.slp-hint:is(:hover,:focus)::after{content:attr(data-tip);position:absolute;z-index:30;top:calc(100% + 6px);inset-inline-start:-6px;width:max-content;max-width:min(320px,calc(100vw - 48px));padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.25);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:400;line-height:1.5;white-space:normal;text-align:start;pointer-events:none}.slp-check-row,.slp-field-label{display:inline-flex;align-items:center;min-width:0}.slp-check-row > .slp-check{min-width:0}',
      '.slp-set-title{margin:0;font-size:15px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.slp-set-desc{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.slp-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.slp-input{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 85%,transparent);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}',
      '.slp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.slp-settings-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0}.slp-settings-heading{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}.slp-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:10px 16px}.slp-settings-body{display:flex;flex-direction:column;gap:10px;padding-top:10px}.slp-settings-fold > summary,.slp-provider-card > summary{cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;overflow-wrap:anywhere}.slp-provider-card{border-top:1px solid var(--dsw-alias-border-l1);padding:10px 0}.slp-provider-state{font-size:12px;color:var(--dsw-alias-label-tertiary);font-weight:400}.slp-check:has(input:disabled){opacity:.55}',
      '.slp-provider-card .slp-check{flex-wrap:wrap;max-width:100%}.slp-settings-body .slp-input{box-sizing:border-box;max-width:100%;min-width:0}.slp-set-desc{overflow-wrap:anywhere}',
      '.slp-provider-card > .slp-source-fields{padding-top:10px}.slp-source-heading{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;list-style:none}.slp-source-heading::-webkit-details-marker{display:none}.slp-source-title{flex:1 1 120px;min-width:0;max-width:100%;overflow-wrap:anywhere}.slp-source-title::before{content:"▸";display:inline-block;margin-inline-end:6px;color:var(--dsw-alias-label-tertiary)}.slp-provider-card[open] > summary .slp-source-title::before{content:"▾"}.slp-source-switch{position:relative;display:inline-flex;align-items:center;flex:none;width:32px;max-width:100%;height:24px;cursor:pointer}.slp-source-switch > input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:inherit;z-index:1}.slp-switch-track{position:relative;display:block;width:100%;height:18px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 15%,var(--dsw-alias-bg-layer-2));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);transition:background .15s}.slp-switch-track::after{content:"";position:absolute;top:3px;inset-inline-start:3px;width:12px;max-width:calc(100% - 6px);height:12px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:inset-inline-start .15s,background .15s}.slp-source-switch > input:checked + .slp-switch-track{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 25%,var(--dsw-alias-bg-layer-2));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-border-l2))}.slp-source-switch > input:checked + .slp-switch-track::after{inset-inline-start:max(3px,calc(100% - 15px));background:var(--dsw-alias-state-success-primary)}.slp-source-switch > input:focus-visible + .slp-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.slp-source-switch:has(input:disabled){cursor:default;opacity:.55}',
      '.slp-settings-heading,.slp-settings-group .slp-check,.slp-settings-group .slp-field{min-width:0;overflow-wrap:anywhere}.slp-check-text{min-width:0;overflow-wrap:anywhere}.slp-settings-group input[type="checkbox"]{flex-shrink:0}@media(max-width:480px){.slp-settings-group{padding:4px}.slp-settings-grid{column-gap:8px}.slp-settings-group .slp-check{flex-wrap:wrap}}',
      '.slp-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.slp-master{padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}.slp-master .slp-check{font-size:14px;font-weight:600}.slp-master .slp-check input{width:18px;height:18px}.slp-settings-group input[type="checkbox"]{margin:0}.slp-setting-branch{display:flex;flex-direction:column;gap:8px;min-width:0}.slp-setting-children{display:flex;flex-direction:column;gap:8px;min-width:0}.slp-dependent{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:10px}.slp-dependent:disabled{opacity:.6}.slp-source-fields{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:10px}.slp-source-fields:disabled{opacity:.6}',
      // Fieldsets reset their native box model before the child hierarchy styling.
      '.slp-setting-children{margin-inline-start:8px;padding-inline-start:12px;border-inline-start:2px solid var(--dsw-alias-border-l1)}.slp-btn{box-sizing:border-box;max-width:100%;white-space:normal;overflow-wrap:anywhere}',
      '.slp-btns{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.slp-input-num{width:96px}.slp-input-cred{width:min(260px,100%)}.slp-source-list{gap:0}',
      '.slp-btn{padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 85%,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;font-family:inherit}',
      '.slp-btn:hover{border-color:var(--dsw-alias-brand-primary)}.slp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}.slp-btn-sm{padding:3px 10px}.slp-btn-icon{padding:2px 7px}',
      '@media(max-width:480px){.slp-master{padding:4px 0}.slp-setting-children{margin-inline-start:0;padding-inline-start:2px;border-inline-start-width:1px}.slp-btn{padding-inline:4px}}',
      '.slp-msg{font-size:12px;padding:6px 10px;border-radius:6px;word-break:break-all}',
      '.slp-tools .slp-activity-trigger{overflow-wrap:anywhere}.slp-preview :is(.slp-tps,.slp-context-pct,.slp-activity-trigger,.slp-cost-trigger){white-space:normal;overflow-wrap:anywhere}',
      '.slp-layout-editor,.slp-layout-block{display:flex;flex-direction:column;gap:10px;min-width:0}.slp-subhead{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;min-width:0}.slp-subhead-title{display:inline-flex;align-items:center;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}.slp-segmented{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0;max-width:100%}.slp-preset-custom{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-inline-start:4px}.slp-order-list{padding:0 8px;margin:0;list-style:none;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.slp-order-item{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-width:0;padding:4px 0}.slp-order-item + .slp-order-item{border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}.slp-order-item > .slp-check{flex:1;min-width:0}.slp-order-actions{display:inline-flex;flex-wrap:wrap;gap:4px}.slp-btn:disabled{opacity:.4;cursor:default}.slp-preview{--slp-gap:16px;min-width:0;max-width:100%;padding:12px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:max(13px,var(--dsh-content-font-size-secondary,13px));line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;box-sizing:border-box}.slp-preview .slp-row{width:100%}.slp-tool-name{max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.slp-activity-meta{font-size:inherit;color:var(--dsw-alias-label-tertiary)}',
      '.slp-ok{color:var(--dsw-alias-state-success-primary)}',
      '.slp-preview .slp-group{white-space:normal;overflow-wrap:anywhere}.slp-order-actions{min-width:0;max-width:100%}@media(max-width:480px){.slp-preview{padding:4px 0}.slp-order-actions .slp-btn{padding-inline:3px}.slp-hint:is(:hover,:focus)::after{position:fixed;inset-inline:16px;top:auto;bottom:16px;width:auto;max-width:none}.slp-preview .slp-context{column-gap:2px}}',
      '.slp-layout-editor{overflow-wrap:anywhere}.slp-order-list{min-width:0;max-width:100%}',
      '.slp-provider-state.slp-source-enabled{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 75%,var(--dsw-alias-label-secondary))}.slp-drag-handle{flex:none;width:20px;white-space:nowrap;letter-spacing:-.25em;max-width:100%;min-height:24px;padding:0;border:0;border-radius:4px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:grab;touch-action:none;user-select:none;box-sizing:border-box}.slp-drag-handle:hover{background:var(--dsw-alias-interactive-bg-hover)}.slp-drag-handle:active{cursor:grabbing}.slp-drag-handle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-drag-handle:disabled{cursor:default}.slp-order-item[data-dragging="true"]{opacity:.55;background:var(--dsw-alias-bg-layer-2)}.slp-order-item[data-drop="before"]{box-shadow:0 -2px 0 var(--dsw-alias-brand-primary)}.slp-order-item[data-drop="after"]{box-shadow:0 2px 0 var(--dsw-alias-brand-primary)}',
    ].join('\n')

    // ---------------- 国际化（跟随 dsh 语言设置，默认跟随系统语言） ----------------
    var CTX = null
    var STR = {
      zh: {
        gitBranchNone: '(无分支)', gitStaged: '暂存', gitUnstaged: '未暂存',
        gitUntracked: '未跟踪', gitConflict: '冲突',
        gitTitle: 'git 工作区状态（点击刷新）',
        gitStale: '刷新失败，显示上次结果', gitLinesUnknown: '行数统计不可用',
        gitDiffTitle: '暂存与未暂存改动量之和；不是相对 HEAD 的净变化，不含未跟踪文件',
         contextLabel: 'CTX',
        gitNoWorkspace: '未找到工作区路径',
        quotaFail: '额度获取失败',
        quotaLoadingShort: '额度 …', opencodeShort: 'OpenCode',
        quotaTitle: 'OpenCode 额度用量', detailTitle: 'OpenCode 额度用量',
        refreshNow: '刷新', clickRetry: '点击重试', clickDetails: '点击查看详情并刷新',
        quotaUsedPct: '已用 {p}%', quotaLeftPct: '剩余 {p}%', quotaModeUsed: '已用', quotaModeLeft: '剩余',
        quotaAge: '{age}前更新', quotaStaleAge: '缓存已过期 · {age}', quotaTimeUnknown: '更新时间未知',
        quotaRefreshFailed: '刷新失败，保留上次成功数据', quotaFetchedTitle: '上次成功获取：{time}；数据年龄：{age}',
        tpsPrevious: 'TPS 上次', tpsAverage: '本次生成的平均速度', tpsEstimated: '字符估算', tpsMeasured: '按实际 output usage 结算', activityRunning: '运行 {n}', activityDone: '已停止 {n}', activityUnknown: '状态未知 {n}',
        activityTitle: '本会话的 Subagents', activityRunningState: '运行中', activityStoppedState: '已停止', activityUnknownState: '状态未知',
        activitySummary: 'Subagents {stopped}/{total}', activitySummaryTitle: '已结束 / 总数；{active} 运行 · {stopped} 已停止 · {unknown} 未知；点击查看详情。已停止不代表成功；停止 5 秒后淡出，15 秒后隐藏，仍计入进度。',
        activityOneShot: '单次', activityContinuable: '可继续', activityModeUnknown: '模式未知', activityLastModel: '最近实际使用模型', activityEffort: '最近使用的推理强度',
        toolsLabel: '工具', toolsTitle: '当前会话的工具调用', toolsTimingHint: '时间从调用记录到结果提交，包含审批与等待；不是精确执行耗时。不展示参数或结果正文。',
        toolsRunning: '等待结果', toolsCompleted: '已完成', toolsFailed: '失败', toolsCancelled: '已取消', toolsNotStarted: '未启动', toolsUnknown: '结果未知', toolsStopped: '已停止，结果未知', toolsIncomplete: '列表已截断，总数未知',
        layoutPresets: '布局预设', layoutBalanced: '均衡', layoutMinimal: '精简', layoutActivity: '活动优先', layoutCustom: '自定义',
        layoutHint: '预设只调整底部组件，不影响账号与顶部设置。拖动 ⋮⋮ 或用 ↑↓ 排序；隐藏的组件保留位置。',
        layoutDrag: '拖动以排序：{name}', layoutDragHint: '拖动或按 ↑↓ 排序；Esc 取消拖动。',
        layoutOrder: '底部组件', layoutUp: '上移 {name}', layoutDown: '下移 {name}',
        layoutGit: 'Git 工作区', layoutContext: 'CTX 上下文', layoutTps: 'TPS 生成速度', layoutCost: '估算金额', layoutActivityLabel: 'Subagents', layoutTools: '工具活动',
        layoutPreview: '预览', layoutPreviewHint: '示例数据，可点击查看示例详情；不读取账号或会话。实际没有数据的组件会自动隐藏。', layoutPreviewAuto: '随面板宽度', layoutPreviewNarrow: '窄屏 320px', layoutPreviewEmpty: '底部组件均已关闭', costTitle: 'API 参考金额', costUnknown: '未计价', costPartial: '已计价小计',
        costPriced: '已计价 {n} 条', costUnpriced: '未计价 {n} 条', costKind: '类型', costTokens: 'Tokens', costAmount: '金额', costShare: '占比',
        costInput: 'Input', costCache: 'Cache', costOutput: 'Output', costBreakdownPending: '明细待宿主更新', costTokensPending: 'Token 统计待宿主更新',
        costBreakdownHint: 'Input 为未缓存输入；Cache 含缓存读取与写入。Token 数量对应已计价请求，使用 K／M 单位。占比按已计价金额计算；金额有区间时，占比按中值估算。不同币种分别计算。',
        costCoverage: '已计价 {priced} 条，未计价 {unpriced} 条', costScope: '实际 usage 按底层模型厂商的公开 API 单价估算，订阅与直连使用同一参考价；DeepSeek 按请求时段计峰谷价。不含 Subagents，不代表实际扣款。不同币种分别累计，不作汇率换算。',
        costAsOf: 'DeepSeek 人民币 fallback 核验时间：{time}；此前记录不套用此价格。',
        costNative: '宿主 pi-ai {version} · 目录生成于 {time} · {n} 条', costFallback: '价格快照 fallback · {time} · {n} 条',
        costReasonProvider: '无此平台的价格', costReasonModel: '无此模型的价格', costReasonUsage: '缺少或无效 usage', costReasonInconsistent: 'usage 计数不一致', costReasonWrite: '缓存写入单价未知', costReasonRead: '缓存读取单价未知', costReasonTime: '请求时间未知', costReasonHistory: '历史价格未知', costReasonTariff: '峰谷时段未知', costReasonSettlement: '缺少结算 usage', costReasonOverflow: '计价数值超出范围', costReasonPrice: '目录价格无效',
        setGroupDisplay: '底部状态行', setGroupHeader: '额度与峰谷时段', setGroupWorkspace: 'Git', setGroupSources: '额度来源与账号', setGroupAdvanced: '高级设置',
        setEnabled: '启用 StatusLine', setEnabledHint: '控制本插件的全部显示与刷新。',
        setQuotaOnStep: '每个 step 后刷新额度', setQuotaOnStepHint: '适用于所有额度来源；自动刷新遵守缓存，点击额度芯片仍会立即刷新。',
        setSourceStateHint: '“已启用”表示允许显示该来源；自动选择时只显示当前计费平台，不代表账号已登录或凭据有效。开启来源时会自动展开其配置。',
        setPercentMode: '额度百分比', setPercentModeHint: '顶部芯片与详情统一显示已用或剩余百分比；颜色始终按已用程度变化。',
        setReset: '恢复默认', setResetConfirm: '确认恢复默认？', setResetDone: '已恢复默认 {time}',
        setResetHint: '恢复显示、布局、刷新与高级设置的默认值；保留凭据引用、账号文件、仓库路径与各来源开关。',
        setCredInvalid: '只能填写凭据引用名（字母、数字、下划线），不要粘贴 API Key 明文',
        setQuotaAutoHint: '关闭时固定使用 OpenCode 额度来源。', setNativeContextHint: '原生圆环放在左侧原生统计组的末尾，显示占用比例；CTX 显示已用量 / 窗口容量。',
        setBalanceSource: '余额', setSubscriptionSource: '订阅额度', setSourceEnabled: '已启用', setSourceDisabled: '已停用',
        setCodexAccount: 'Codex 账号文件名', setAntigravityAccount: 'Antigravity 账号文件名（可选）',
        setCodexAccountHint: '有多个 Codex 账号时需指定文件名。', setAntigravityAccountHint: '留空时按优先级自动选择账号。', setOpenCodeTest: '测试 OpenCode 额度',
        win5h: '5小时', winWeek: '本周', winMonth: '本月',
        codexWinWeek: '周', codexWinMonth: '月',
        codexShort: 'Codex',
        codexUnknown: '额度未知', codexDetailTitle: 'Codex 额度用量',
        codexAccountRequired: '有多个 Codex 账号，请在状态栏设置中指定账号文件',
        codexPlan: '套餐', codexActiveLimit: '当前限额', codexCredits: '额度余额', codexCreditsUnlimited: '额度不限',
        codexFailAuth: 'Codex 凭据无效', codexFailRate: 'Codex 请求被限流，稍后再试',
        codexFailNetwork: 'Codex 网络错误', codexFailNoCred: '未找到 Codex 凭据',
        codexFail: 'Codex 获取失败',
        antigravityShort: 'Antigravity',
        antigravity5h: '5h',
        antigravityWeekly: '周',
        antigravityUnknown: '额度未知', antigravityThirdParty: '3P / Claude', antigravityPriority: '优先级 {n}',
        antigravityAccountRequired: '有多个 Antigravity 账号，请在状态栏设置中指定账号文件',
        antigravityFailAuth: 'Antigravity 凭据无效', antigravityFailRate: 'Antigravity 请求被限流，稍后再试',
        antigravityFailNetwork: 'Antigravity 网络错误', antigravityFailNoCred: '未找到 Antigravity 凭据',
        antigravityFail: 'Antigravity 获取失败',
        antigravityDetailTitle: 'Antigravity 额度用量',
        antigravityStatusActive: '预计可用',
        antigravityStatusUnknown: '未知', antigravityStatusError: '查询失败',
        antigravityStatusExhausted: '已耗尽',
        antigravityStatusStandby: '待命',
        antigravityFetchFail: '获取失败: ',
        providerFailAuth: '凭据无效', providerFailRate: '请求被限流，稍后再试',
        providerUsedShort: '已用 {u}',
        providerFailNetwork: '网络错误', providerFailNoCred: '未配置该额度源的 API Key',
        providerFail: '额度获取失败', providerLoading: '额度 …',
        providerBalanceTitle: '{label} 余额 {r}',
        providerGranted: '赠送余额 {v}', providerToppedUp: '充值余额 {v}',
        providerUnavailable: '账号当前不可用', providerAvailable: '账号可用',
        providerWindowTitle: '{label}: {v}', providerResetTitle: '重置剩余 {r}',
        peakStatus: '高峰价', offPeakStatus: '平峰', peakUnknown: '时段未核实',
        peakToOff: '距平峰', peakToPeak: '距高峰', peakTitle: 'DeepSeek 官方峰/平峰时段',
        peakRule: '北京时间周一至周五（法定节假日除外）09:00–12:00、14:00–18:00 为高峰；其他时间、周末与节假日全天为平峰，平峰价格为高峰的一半。',
        peakCalendarUnknown: '节假日日历尚未覆盖该年份，下一次高峰时间未确认。',
        peakHoliday: '中国法定节假日：{name}', peakWeekend: '周末全天平峰', peakHolidayUnnamed: '节假日',
        peakMakeupDay: '调休上班日：官方说明周末全天为平峰，仍按平峰显示',
        peakRuleChanged: '官网的峰谷说明与插件内置规则不一致，规则可能已变更，请核对官方说明。', peakRuleChangedShort: '规则可能已变更',
        peakSourceFetched: '节假日：官方日历（holiday-cn，每日更新）', peakSourceBuiltin: '节假日：插件内置日历',
        peakBeijing: '北京时间', peakLocal: '本地时间', peakNextSwitch: '下次切换（本地时间）',
        peakOfficial: '查看官方规则与最新价格', peakOfficialShort: '官方规则 ↗', setShowDeepseekPeak: 'DeepSeek 直连会话顶部显示峰/平峰', setShowPeakDot: '左下角显示峰/平峰指示点（无需打开会话）', setPeakCountdown: '显示峰/平峰切换倒计时',
        providerRedBelowTitle: '余额低于 {v} 变红',
        setProviderRedBelow: '余额低于变红', setProviderRedBelowPh: '如 10',
        setProviderCredential: 'API 凭据引用（非明文密钥）',
        setAutoSaveHint: '自动保存',
        setAutoSaving: '自动保存中…',
        setAutoSavedAt: '已自动保存 {time}',
        setAutoSaveFail: '保存失败，再次修改时重试',
        setProviderHint: '填写 DSH 凭据引用或环境变量名，不要填写 API Key 明文。内置引用：DEEPSEEK_API_KEY、KIMI_API_KEY、ZAI_API_KEY、ZAI_CODING_CN_API_KEY、OPENROUTER_API_KEY；按会话的计费 provider 匹配后切换显示。',
        setQuotaAuto: '按会话的计费平台自动选择额度来源',
        setTitle: '状态栏',
        setDesc: '顶部显示额度与峰谷时段，输入框下方显示会话指标与 Git。', setApiKeyEnvPh: 'OPENCODE_GO_API_KEY',
        setUsageUrl: 'Usage API 地址（可选）', setUsageUrlPh: 'https://opencode.ai/zen/go/v1/usage',
        setCacheTtl: '额度缓存复用时间（秒）', setFetchTimeout: '额度请求超时（秒）',
        setCacheTtlHint: '默认 60 秒，实际最少 15 秒：这段时间内自动查询复用上次结果。到期不自动轮询，下一次 step、重新进入可见页面时才查询；点击额度绕过成功缓存。缩短可更及时，但查询更多；限流时仍需等待重试。',
        setGitCwd: '仓库目录覆盖（可选，默认用当前会话工作区）', setGitCwdPh: '如 ~/Projects/my-repo',
        setShowQuota: '显示顶部额度', setShowCwd: '显示仓库路径',
        tpsTitle: '生成中按文本/推理/工具参数的字符数估算 token 速率；完成后优先用真实 usage 按首 token 到完成时间结算，不含工具执行时间。显示四舍五入为整数，最快每 25ms 更新。',
        tpsHeld: '等待新速率，暂留最近有效值（非当前速率）', tpsCompleted: '已完成', tpsInterrupted: '已中断', tpsWaiting: '等待足够的输出增量', tpsUnavailable: '连接恢复中', setLoading: '加载中…',
        saveFail: '保存失败', needSaveFirst: '（测试前需先保存）',
        testOk: '连接成功：5h {r}% · 周 {w}% · 月 {m}%',
        testFail: '连接失败',
      },
      en: {
        gitBranchNone: '(no branch)', gitStaged: 'staged', gitUnstaged: 'unstaged',
        gitUntracked: 'untracked', gitConflict: 'conflict',
        gitTitle: 'git workspace status (click to refresh)',
        gitStale: 'Refresh failed; showing the last result', gitLinesUnknown: 'Line statistics unavailable',
        gitDiffTitle: 'Staged + unstaged changes, not net changes against HEAD; excludes untracked files',
         contextLabel: 'CTX',
        gitNoWorkspace: 'workspace path not found',
        quotaFail: 'quota fetch failed',
        quotaLoadingShort: 'quota …', opencodeShort: 'OpenCode',
        quotaTitle: 'OpenCode usage', detailTitle: 'OpenCode usage',
        refreshNow: 'Refresh', clickRetry: 'click to retry', clickDetails: 'click for details and refresh',
        quotaUsedPct: '{p}% used', quotaLeftPct: '{p}% left', quotaModeUsed: 'used', quotaModeLeft: 'left',
        quotaAge: 'Updated {age} ago', quotaStaleAge: 'Expired cache · {age}', quotaTimeUnknown: 'Update time unknown',
        quotaRefreshFailed: 'Refresh failed; retaining the last successful data', quotaFetchedTitle: 'Last successful fetch: {time}; data age: {age}',
        tpsPrevious: 'TPS last', tpsAverage: 'Average speed for this generation', tpsEstimated: 'Character estimate', tpsMeasured: 'Settled from actual output usage', activityRunning: '{n} running', activityDone: '{n} stopped', activityUnknown: '{n} unknown',
        activityTitle: 'Subagents of this session', activityRunningState: 'Running', activityStoppedState: 'Stopped', activityUnknownState: 'Status unknown',
        activitySummary: 'Subagents {stopped}/{total}', activitySummaryTitle: 'Finished / total; {active} running · {stopped} stopped · {unknown} unknown; click for details. Stopped does not imply success; fades after 5s and hides after 15s but still counts toward progress.',
        activityOneShot: 'One-shot', activityContinuable: 'Continuable', activityModeUnknown: 'Mode unknown', activityLastModel: 'Last used model', activityEffort: 'Last used reasoning effort',
        toolsLabel: 'Tools', toolsTitle: 'Tool calls in this session', toolsTimingHint: 'Time spans the call record to result submission, including approvals and waiting; it is not exact execution time. Arguments and result bodies are excluded.',
        toolsRunning: 'Awaiting result', toolsCompleted: 'Completed', toolsFailed: 'Failed', toolsCancelled: 'Cancelled', toolsNotStarted: 'Not started', toolsUnknown: 'Outcome unknown', toolsStopped: 'Stopped; outcome unknown', toolsIncomplete: 'List truncated; total unknown',
        layoutPresets: 'Layout presets', layoutBalanced: 'Balanced', layoutMinimal: 'Minimal', layoutActivity: 'Activity first', layoutCustom: 'Custom',
        layoutHint: 'Presets change bottom components only, never accounts or header settings. Drag ⋮⋮ or use ↑↓ to reorder; hidden components keep their position.',
        layoutDrag: 'Drag to reorder {name}', layoutDragHint: 'Drag or use arrow keys to reorder; Esc cancels dragging.',
        layoutOrder: 'Bottom components', layoutUp: 'Move {name} up', layoutDown: 'Move {name} down',
        layoutGit: 'Git workspace', layoutContext: 'CTX context', layoutTps: 'TPS generation speed', layoutCost: 'Estimated amount', layoutActivityLabel: 'Subagents', layoutTools: 'Tool activity',
        layoutPreview: 'Preview', layoutPreviewHint: 'Sample data; click for sample details. No accounts or sessions are read. Components without real data hide in the actual bar.', layoutPreviewAuto: 'Panel width', layoutPreviewNarrow: 'Narrow 320px', layoutPreviewEmpty: 'All bottom components are hidden', costTitle: 'API reference cost', costUnknown: 'Unpriced', costPartial: 'Priced subtotal',
        costPriced: '{n} priced', costUnpriced: '{n} unpriced', costKind: 'Type', costTokens: 'Tokens', costAmount: 'Amount', costShare: 'Share',
        costInput: 'Input', costCache: 'Cache', costOutput: 'Output', costBreakdownPending: 'Breakdown needs Host update', costTokensPending: 'Token counts need Host update',
        costBreakdownHint: 'Input is uncached input; Cache includes reads and writes. Token counts cover priced requests and use K/M units. Shares use priced amounts, or interval midpoints for ranges. Currencies are calculated separately.',
        costCoverage: '{priced} priced records, {unpriced} unpriced records', costScope: 'Actual usage valued at the underlying model vendor’s public API price, with the same reference rates for subscriptions and direct API access. DeepSeek uses each request’s peak/off-peak time. Subagents are excluded; this is not an account charge. Currencies are accumulated separately without conversion.',
        costAsOf: 'DeepSeek CNY fallback verified: {time}; earlier records are not priced with this tariff.',
        costNative: 'Host pi-ai {version} · catalog generated {time} · {n} records', costFallback: 'Price snapshot fallback · {time} · {n} records',
        costReasonProvider: 'No price for this provider', costReasonModel: 'No price for this model', costReasonUsage: 'Missing or invalid usage', costReasonInconsistent: 'Inconsistent usage counts', costReasonWrite: 'Unknown cache-write price', costReasonRead: 'Unknown cache-read price', costReasonTime: 'Unknown request time', costReasonHistory: 'Unknown historical price', costReasonTariff: 'Unknown peak/off-peak window', costReasonSettlement: 'Missing settled usage', costReasonOverflow: 'Cost exceeds numeric limits', costReasonPrice: 'Invalid catalog price',
        setGroupDisplay: 'Bottom status line', setGroupHeader: 'Quota and peak hours', setGroupWorkspace: 'Git', setGroupSources: 'Quota sources and accounts', setGroupAdvanced: 'Advanced settings',
        setEnabled: 'Enable StatusLine', setEnabledHint: 'Controls all plugin displays and refreshes.',
        setQuotaOnStep: 'Refresh quota after each step', setQuotaOnStepHint: 'Applies to every quota source; automatic refresh respects caching, and clicking a quota chip still refreshes immediately.',
        setPercentMode: 'Quota percentage', setPercentModeHint: 'Header chips and details both show used or remaining percentage; colour always tracks consumption.',
        setReset: 'Reset to defaults', setResetConfirm: 'Confirm reset?', setResetDone: 'Defaults restored {time}',
        setResetHint: 'Restores display, layout, refresh and advanced defaults; keeps credential references, account files, the repository path and per-source switches.',
        setCredInvalid: 'Enter a credential reference name (letters, digits, underscore), never a literal API key',
        setSourceStateHint: 'Enabled means this source may be displayed. Auto-selection shows only the current billing provider; it does not verify login or credentials. Enabling a source opens its settings automatically.',
        setQuotaAutoHint: 'When off, always use the OpenCode quota source.', setNativeContextHint: 'The native ring comes last in the native stats group on the left and shows occupancy; CTX shows used tokens / window capacity.',
        setBalanceSource: 'Balance', setSubscriptionSource: 'Subscription quota', setSourceEnabled: 'Enabled', setSourceDisabled: 'Disabled',
        setCodexAccount: 'Codex account filename', setAntigravityAccount: 'Antigravity account filename (optional)',
        setCodexAccountHint: 'Specify a filename when multiple Codex accounts are present.', setAntigravityAccountHint: 'Leave blank to select an account by priority.', setOpenCodeTest: 'Test OpenCode quota',
        win5h: '5 hours', winWeek: 'this week', winMonth: 'this month',
        codexWinWeek: 'w', codexWinMonth: 'm',
        codexShort: 'Codex',
        codexUnknown: 'quota unknown', codexDetailTitle: 'Codex usage',
        codexAccountRequired: 'Multiple Codex accounts found; choose the account file in StatusLine settings',
        codexPlan: 'Plan', codexActiveLimit: 'Active limit', codexCredits: 'Credits', codexCreditsUnlimited: 'Unlimited credits',
        codexFailAuth: 'Codex credential invalid', codexFailRate: 'Codex rate limited, retry later',
        codexFailNetwork: 'Codex network error', codexFailNoCred: 'no Codex credential found',
        codexFail: 'Codex fetch failed',
        antigravityShort: 'Antigravity',
        antigravity5h: '5h',
        antigravityWeekly: 'w',
        antigravityUnknown: 'quota unknown', antigravityThirdParty: '3P / Claude', antigravityPriority: 'priority {n}',
        antigravityAccountRequired: 'Multiple Antigravity accounts found; choose the account file in StatusLine settings',
        antigravityFailAuth: 'Antigravity credential invalid', antigravityFailRate: 'Antigravity rate limited, retry later',
        antigravityFailNetwork: 'Antigravity network error', antigravityFailNoCred: 'no Antigravity credential found',
        antigravityFail: 'Antigravity fetch failed',
        antigravityDetailTitle: 'Antigravity usage',
        antigravityStatusActive: 'Likely available',
        antigravityStatusUnknown: 'Unknown', antigravityStatusError: 'Fetch failed',
        antigravityStatusExhausted: 'Exhausted',
        antigravityStatusStandby: 'Standby',
        antigravityFetchFail: 'Fetch failed: ',
        providerFailAuth: 'credential invalid', providerFailRate: 'rate limited, retry later',
        providerUsedShort: 'used {u}',
        providerFailNetwork: 'network error', providerFailNoCred: 'no API key configured for this provider',
        providerFail: 'quota fetch failed', providerLoading: 'quota …',
        providerBalanceTitle: '{label} balance {r}',
        providerGranted: 'granted balance {v}', providerToppedUp: 'topped-up balance {v}',
        providerUnavailable: 'account currently unavailable', providerAvailable: 'account available',
        providerWindowTitle: '{label}: {v}', providerResetTitle: 'resets in {r}',
        peakStatus: 'Peak rate', offPeakStatus: 'Off-peak', peakUnknown: 'Schedule unknown',
        peakToOff: 'Off-peak in', peakToPeak: 'Peak in', peakTitle: 'DeepSeek peak / off-peak schedule',
        peakRule: 'Beijing time: Mon–Fri (excluding Chinese public holidays), 09:00–12:00 and 14:00–18:00 are peak windows. All other hours, weekends and holidays are off-peak at half the peak price.',
        peakCalendarUnknown: 'Holiday calendar does not cover this year; the next peak time is unconfirmed.',
        peakHoliday: 'Chinese public holiday: {name}', peakWeekend: 'Weekends are off-peak all day', peakHolidayUnnamed: 'Holiday',
        peakMakeupDay: 'Make-up workday: the official wording keeps all weekends off-peak, so it shows as off-peak',
        peakRuleChanged: 'The official peak wording no longer matches the built-in rule; it may have changed. Please check the official page.', peakRuleChangedShort: 'rule may have changed',
        peakSourceFetched: 'Holidays: official calendar (holiday-cn, refreshed daily)', peakSourceBuiltin: 'Holidays: built-in calendar',
        peakBeijing: 'Beijing time', peakLocal: 'Local time', peakNextSwitch: 'Next switch (local time)',
        peakOfficial: 'Official rules and current prices', peakOfficialShort: 'Official rules ↗', setShowDeepseekPeak: 'Show peak / off-peak in direct DeepSeek session headers', setShowPeakDot: 'Peak / off-peak dot in the sidebar footer (no session needed)', setPeakCountdown: 'Show peak / off-peak countdown',
        providerRedBelowTitle: 'red below {v}',
        setProviderRedBelow: 'red below', setProviderRedBelowPh: 'e.g. 10',
        setProviderCredential: 'API credential reference (not a literal key)',
        setAutoSaveHint: 'Auto-saves',
        setAutoSaving: 'Auto-saving…',
        setAutoSavedAt: 'Saved {time}',
        setAutoSaveFail: 'Save failed; edit again to retry',
        setProviderHint: 'Enter a DSH credential reference or environment variable name, never the literal API key. Built-in references: DEEPSEEK_API_KEY, KIMI_API_KEY, ZAI_API_KEY, ZAI_CODING_CN_API_KEY, OPENROUTER_API_KEY. Sources match the session billing provider.',
        setQuotaAuto: 'Pick the quota source from the session billing provider',
        setTitle: 'Status line',
        setDesc: 'Quota and peak hours in the header; session metrics and Git below the composer.', setApiKeyEnvPh: 'OPENCODE_GO_API_KEY',
        setUsageUrl: 'Usage API URL (optional)', setUsageUrlPh: 'https://opencode.ai/zen/go/v1/usage',
        setCacheTtl: 'Quota cache reuse time (seconds)', setFetchTimeout: 'Quota request timeout (seconds)',
        setCacheTtlHint: 'Default 60s, effective minimum 15s: automatic queries reuse the last result during this time. Expiry does not start polling; a later step or becoming visible triggers a query. Clicking quota bypasses successful cache. Shorter values are fresher but make more requests; rate limits still require retry backoff.',
        setGitCwd: 'Repository directory override (optional, defaults to the session workspace)', setGitCwdPh: 'e.g. ~/Projects/my-repo',
        setShowQuota: 'Show header quota', setShowCwd: 'Show repository path',
        tpsTitle: 'Streaming rate estimates tokens from text/reasoning/tool-argument characters. Settled rate prefers provider output tokens over first-token-to-completion time, excluding tool execution. Rounded to an integer; display updates at most every 25ms.',
        tpsHeld: 'Waiting for a new rate; retaining the latest valid value (not current speed)', tpsCompleted: 'Completed', tpsInterrupted: 'Interrupted', tpsWaiting: 'Waiting for enough output deltas', tpsUnavailable: 'Reconnecting', setLoading: 'Loading…',
        saveFail: 'Save failed', needSaveFirst: ' (save before testing)',
        testOk: 'Connected: 5h {r}% · week {w}% · month {m}%',
        testFail: 'Connection failed',
      },
    }
    function currentLang() {
      var lang = 'en'
      try {
        if (CTX && typeof CTX.get === 'function') {
          var svc = CTX.get('locale')
          if (svc && typeof svc.getLocale === 'function') {
            var active = svc.getLocale().active
            if (active) lang = String(active).toLowerCase()
          }
        }
      } catch (e) { /* fall through */ }
      if (lang.indexOf('zh') === 0) return 'zh'
      return 'en'
    }
    function t(key) {
      var table = currentLang() === 'zh' ? STR.zh : STR.en
      return table[key] !== undefined ? table[key] : key
    }
    function tf(key, vars) {
      var s = t(key)
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) {
          s = s.split('{' + k + '}').join(String(vars[k]))
        }
      }
      return s
    }

    // ---------------- API ----------------
    var settingsScope = null
    var configSnapshot = null
    var configListeners = []
    function quotaRefreshOnStep(config) {
      if (!config) return false
      if (typeof config.quotaOnStep === 'boolean') return config.quotaOnStep
      return config.codexQuotaOnTurn !== false && config.antigravityQuotaOnTurn !== false &&
        !(config.providers || []).some(function (provider) { return provider.onTurn === false })
    }
    function publishConfig(config) {
      configSnapshot = config
      configListeners.slice().forEach(function (listener) { listener(config) })
    }
    function apiSetConfig(patch) {
      if (!settingsScope || settingsScope.getSnapshot().mode !== 'host' || !settingsScope.getSnapshot().writable) {
        return Promise.resolve({ ok: false, error: 'Settings are not writable on this connection.' })
      }
      var ops = Object.keys(patch).map(function (key) { return { op: 'set', path: [key], value: patch[key] } })
      return settingsScope.mutate(ops).then(function () {
        return { ok: true, config: settingsScope.getSnapshot().value }
      }).catch(function (error) { return { ok: false, error: String(error.message || error) } })
    }
    function useConfigSnapshot() {
      var pair = React.useState(configSnapshot)
      React.useEffect(function () {
        var listener = pair[1]
        configListeners.push(listener)
        listener(configSnapshot)
        return function () { configListeners = configListeners.filter(function (fn) { return fn !== listener }) }
      }, [])
      return pair[0]
    }
    function usePageVisible(enabled) {
      var pair = React.useState(document.visibilityState !== 'hidden')
      React.useEffect(function () {
        if (enabled === false) return undefined
        var change = function () { pair[1](document.visibilityState !== 'hidden') }
        document.addEventListener('visibilitychange', change)
        return function () { document.removeEventListener('visibilitychange', change) }
      }, [enabled])
      return enabled !== false && document.visibilityState !== 'hidden' && pair[0]
    }
    function quotaRequest(resource, force, signal) {
      var endpoint = resource.kind === 'provider' ? 'provider-quota' : resource.kind === 'opencode' ? 'usage' : resource.kind + '-quota'
      return fetch('/statusline/api/' + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: resource.id, force: force === true }), signal: signal,
      }).then(function (response) { return response.json() })
        .catch(function (error) { return { ok: false, error: error.message || 'network' } })
    }
    function apiUsage(force, signal) {
      var opts = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(force ? { force: true } : {}),
      }
      if (signal) opts.signal = signal
      return fetch('/statusline/api/usage', opts).then(function (r) { return r.json() })
        .catch(function (e) { return { ok: false, error: (e && e.message) || String(e) } })
    }
    function apiGit(cwd, sessionId, signal, force) {
      var opts = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: cwd, sessionId: sessionId || undefined, force: force === true || undefined }),
      }
      // 网络挂载（sshfs）上 git status 可能很慢，10 秒超时避免挂死
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        opts.signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
      }
      if (signal && !opts.signal) opts.signal = signal
      return fetch('/statusline/api/git', opts)
        .then(function (r) { return r.json() })
        .catch(function (e) { return { ok: false, error: (e && e.message) || String(e) } })
    }
    function toneClass(pct) {
       return pct >= 80 ? 'd' : pct >= 50 ? 'w' : 's'
     }
    // 行数上万时压缩显示（196067 → 196k），精确值放 title
    function compactCount(n) {
      n = Number(n) || 0
      if (n < 10000) return String(n)
      if (n < 999500) return Math.round(n / 1000) + 'k'
      return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    }
     function formatPathSegs(path, maxSegs) {
      // 路径只保留最后 maxSegs 级（超出前缀 …/），完整路径放 title
      path = String(path || '').replace(/[\\/]+$/, '')
      var segs = path.split(/[\\/]/).filter(Boolean)
      if (segs.length <= maxSegs) return path
      return segs.slice(-maxSegs).join('/')
    }
     function ContextRow(props) {
       if (!props.enabled || props.usedTokens === null || props.contextWindow === null || props.contextWindow <= 0) return null
       return React.createElement('span', { className: 'slp-context slp-group' },
         React.createElement('span', { className: 'slp-context-label' }, t('contextLabel')),
         React.createElement('span', { className: 'slp-context-pct ' + toneClass(props.pct), title: String(props.usedTokens) + ' / ' + String(props.contextWindow) + ' tokens' }, formatTokens(props.usedTokens) + ' / ' + formatTokens(props.contextWindow))
       )
     }

    function fmtResetHours(sec) {
      sec = Math.max(0, Math.round(Number(sec) || 0))
      if (sec >= 48 * 3600) return (sec / 86400).toFixed(1) + 'd'
      if (sec >= 3600) return (sec / 3600).toFixed(1) + 'h'
      if (sec >= 60) return Math.ceil(sec / 60) + 'm'
      return sec + 's'
    }
    function fmtResetShort(sec) { return '(' + fmtResetHours(sec) + ')' }
    function codexWindowLabel(minutes, long) {
      var n = Number(minutes)
      if (!Number.isFinite(n) || n <= 0) return '—'
      if (n === 7 * 1440) return t(long ? 'winWeek' : 'codexWinWeek')
      if (n === 30 * 1440) return t(long ? 'winMonth' : 'codexWinMonth')
      return n < 60 ? n + 'm' : n < 1440 ? (n / 60) + 'h' : (n / 1440) + 'd'
    }
    function pctColor(pct) {
      if (pct >= 85) return 'var(--dsw-alias-state-error-primary)'
      if (pct >= 60) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-success-primary)'
    }
    function clampPct(v) {
      v = Math.round(Number(v) || 0)
      return Math.max(0, Math.min(100, v))
    }
    function formatRate(v) {
      v = Number(v) || 0
      return String(Math.round(v))
    }
    // 紧凑 token 计数：517 / 12.2K / 517K / 1.2M（与官方 StatsLine 一致）
    function formatTokens(n) {
      n = Number(n) || 0
      var scaled = function (v) {
        return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
      }
      if (n < 1000) return String(n)
      if (n < 1000000) return scaled(n / 1000) + 'K'
      return scaled(n / 1000000) + 'M'
    }
    function fmtTime(ts) {
      var d = new Date(ts)
      var p = function (n) { return n < 10 ? '0' + n : String(n) }
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    function quotaFreshness(data, ttlMs, staleError, now) {
      now = now === undefined ? Date.now() : now
      var at = data && quotaNumber(data.fetchedAt)
      if (at === null || at === undefined || at <= 0 || at > now + 5000 || !Number.isFinite(new Date(at).getTime())) {
        return { label: t('quotaTimeUnknown'), title: staleError ? t('quotaRefreshFailed') : t('quotaTimeUnknown'), stale: !!staleError }
      }
      var age = Math.max(0, Math.floor((now - at) / 1000))
      var ttl = quotaNumber(ttlMs), stale = !!staleError || (ttl !== null && ttl > 0 && now - at >= ttl)
      var ageText = age < 60 ? age + 's' : age < 3600 ? Math.floor(age / 60) + 'm' : age < 86400 ? Math.floor(age / 3600) + 'h' : Math.floor(age / 86400) + 'd'
      var title = tf('quotaFetchedTitle', { time: new Date(at).toLocaleString(), age: ageText })
      if (staleError) title += ' · ' + t('quotaRefreshFailed')
      return { label: tf(stale ? 'quotaStaleAge' : 'quotaAge', { age: ageText }), title: title, stale: stale }
    }
    function QuotaFreshness(props) {
      var state = quotaFreshness(props.data, props.ttlMs, props.staleError, props.now)
      return React.createElement('span', { className: 'slp-quota-age' + (state.stale ? ' slp-stale' : ''), title: state.title }, state.label)
    }
    function useQuotaClock(enabled) {
      var visible = usePageVisible(enabled), pair = React.useState(Date.now())
      React.useEffect(function () {
        if (!visible) return undefined
        pair[1](Date.now())
        var timer = setInterval(function () { pair[1](Date.now()) }, 30000)
        return function () { clearInterval(timer) }
      }, [visible])
      // Ticks trigger rerenders, but a newly fetched timestamp is compared
      // with the current wall clock immediately.
      return Date.now()
    }

    // 把 usage 数据归一成窗口数组（含实时倒计时）
    function normalizeWindows(data, now) {
      var keys = [
        { key: 'rolling', short: '5h', labelKey: 'win5h' },
        { key: 'weekly', short: '7d', labelKey: 'winWeek' },
        { key: 'monthly', short: '30d', labelKey: 'winMonth' },
      ]
      return keys.map(function (w) {
        var o = (data && data.windows && data.windows[w.key]) || {}
        var resetInSec = Math.max(0, Math.round(Number(o.resetInSec) || 0))
        if (data && data.fetchedAt && resetInSec > 0) {
          resetInSec = Math.max(0, resetInSec - Math.floor((now - data.fetchedAt) / 1000))
        }
        var rawPct = o.percent !== undefined ? o.percent : o.usagePercent
        if (typeof rawPct !== 'number' || !Number.isFinite(rawPct) || rawPct < 0 || rawPct > 100) return null
        var pct = clampPct(rawPct)
        return {
          key: w.key, label: t(w.labelKey), short: w.short,
          pct: pct,
          color: pctColor(pct),
          resetInSec: resetInSec > 0 ? resetInSec : (o.resetsAt ? Math.max(0, Math.round((new Date(o.resetsAt).getTime() - now) / 1000)) : 0),
          used: o.used, total: o.total,
        }
      }).filter(Boolean)
    }

    // One lifecycle for all quota sources: one request, cancellation, silent refresh
    // and an actual visibility gate. Backend owns TTL and 429 backoff across tabs.
    function useQuotaResource(resource, config, stepCount) {
      var pair = React.useState(null), setResult = pair[1]
      var dispatch = React.useRef(function () {})
      var visible = usePageVisible(!!(config && config.enabled && config.showQuota))
      var enabled = !!(config && config.enabled && config.showQuota && visible && resource)
      var key = resource ? resource.key : ''
      var requestConfigKey = JSON.stringify([config && config.apiKeyEnv, config && config.usageUrl,
        config && config.cacheTtlMs, config && config.fetchTimeoutMs, config && config.codexAccount,
        config && config.antigravityAccount, resource && resource.provider])
      React.useEffect(function () {
        if (!enabled) return undefined
        var alive = true, controller = null, pending = false
        setResult(null)
        var refresh = function (force, silent) {
          if (!alive) return
          if (controller) { pending = pending || force; return }
          controller = new AbortController()
          quotaRequest(resource, force, controller.signal).then(function (result) {
            if (!alive) return
            if (result.ok) setResult({ key: key, data: result.data, error: null })
            else setResult(function (old) {
              return { key: key, data: silent && old && old.key === key ? old.data : null, error: result.error || 'network' }
            })
          }).finally(function () {
            controller = null
            if (alive && pending) { pending = false; refresh(true, true) }
          })
        }
        dispatch.current = refresh
        refresh(false, false)
        return function () {
          alive = false
          if (controller) controller.abort()
          dispatch.current = function () {}
        }
      }, [enabled, key, requestConfigKey])
      var previousStep = React.useRef(null)
      React.useEffect(function () {
        var previous = previousStep.current
        previousStep.current = { key: key, count: stepCount }
        if (enabled && resource.onStep && previous && previous.key === key && stepCount > previous.count) dispatch.current(!resource.cacheOnStep, true)
      }, [enabled, key, stepCount, resource && resource.onStep, resource && resource.cacheOnStep])
      var result = pair[0] && pair[0].key === key ? pair[0] : null
      return { data: result && result.data, error: result && !result.data ? result.error : null,
        staleError: result && result.data ? result.error : null,
        refresh: function () { dispatch.current(true, true) } }
    }

    // ---------------- 小组件 ----------------
    function useDismissiblePanel() {
      var pair = React.useState(false)
      var open = pair[0]
      var setOpen = pair[1]
      var rootRef = React.useRef(null)

      React.useEffect(function () {
        if (!open) return undefined
        // Keep details inside the viewport and the conversation's scroll
        // container. Only an open panel measures layout, on mount/resize.
        var clippedParents = []
        function fitPanel() {
          var root = rootRef.current
          var panel = root && typeof root.querySelector === 'function' && root.querySelector('.slp-panel')
          if (!panel || typeof panel.getBoundingClientRect !== 'function') return
          var left = 12, right = document.documentElement.clientWidth - 12
          if (typeof getComputedStyle === 'function') {
            for (var parent = root.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
              if (!/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(parent).overflowX)) continue
              if (clippedParents.indexOf(parent) === -1) clippedParents.push(parent)
              var bounds = parent.getBoundingClientRect()
              if (bounds.width <= 0) continue
              left = Math.max(left, bounds.left + 12)
              right = Math.min(right, bounds.right - 12)
            }
          }
          panel.style.maxWidth = Math.max(0, right - left) + 'px'
          panel.style.right = ''
          var box = panel.getBoundingClientRect()
          // The opening animation scales around the center; fit its final size.
          var inset = ((panel.offsetWidth || box.width) - box.width) / 2
          var shift = box.right + inset > right ? box.right + inset - right : box.left - inset < left ? box.left - inset - left : 0
          panel.style.right = shift + 'px'
        }
        fitPanel()
        var resize = typeof ResizeObserver === 'function' ? new ResizeObserver(fitPanel) : null
        if (resize && rootRef.current) {
          resize.observe(rootRef.current)
          clippedParents.forEach(function (parent) { resize.observe(parent) })
        }
        if (typeof window.addEventListener === 'function') window.addEventListener('resize', fitPanel)
        function onDown(e) {
          if (rootRef.current && e.target && typeof rootRef.current.contains === 'function') {
            if (!rootRef.current.contains(e.target)) {
              setOpen(false)
            }
          }
        }
        function onKey(e) {
          if (e.key === 'Escape') {
            e.stopPropagation()
            setOpen(false)
          }
        }
        function onVis() {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
            setOpen(false)
          }
        }
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('pointerdown', onDown)
          document.addEventListener('keydown', onKey)
          document.addEventListener('visibilitychange', onVis)
        }
        return function () {
          if (resize) resize.disconnect()
          if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', fitPanel)
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('pointerdown', onDown)
            document.removeEventListener('keydown', onKey)
            document.removeEventListener('visibilitychange', onVis)
          }
        }
      }, [open])

      var onBlur = function (e) {
        if (rootRef.current && e.relatedTarget && typeof rootRef.current.contains === 'function') {
          if (!rootRef.current.contains(e.relatedTarget)) {
            setOpen(false)
          }
        }
      }

      return {
        open: open,
        setOpen: setOpen,
        rootRef: rootRef,
        onBlur: onBlur,
      }
    }

    // ---- Shared quota chip pieces ----
    // Every quota chip behaves the same: click opens details and forces one
    // refresh on open; closing never bypasses the cache.
    function useQuotaPanel(refresh) {
      var dismiss = useDismissiblePanel()
      // A ref, not the render closure: two clicks before a re-render must
      // toggle twice instead of "opening" twice and forcing two refreshes.
      var openRef = React.useRef(false)
      openRef.current = dismiss.open
      dismiss.toggle = function () {
        var opening = !openRef.current
        openRef.current = opening
        dismiss.setOpen(opening)
        if (opening && refresh) refresh()
      }
      return dismiss
    }
    // Reset countdown relative to the fetch time, so cached data keeps counting down.
    function liveReset(sec, fetchedAt, now) {
      sec = quotaNumber(sec)
      if (sec === null || sec <= 0) return 0
      var at = quotaNumber(fetchedAt)
      if (at === null) return sec
      return Math.max(0, sec - Math.floor(((now === undefined ? Date.now() : now) - at) / 1000))
    }
    // One number per window, read the same way in chip, tooltip and details:
    // consumed ('used') or remaining ('left'). Bars fill by the shown number;
    // colour always tracks consumption so a nearly exhausted quota stays red.
    function quotaMetric(used, remaining, mode) {
      used = clampPct(used)
      var left = quotaNumber(remaining) === null ? 100 - used : clampPct(remaining)
      var shown = mode === 'left' ? left : used
      return { used: used, shown: shown, word: tf(mode === 'left' ? 'quotaLeftPct' : 'quotaUsedPct', { p: shown }) }
    }
    function chipSegment(key, label, metric, resetSec, title) {
      return React.createElement('span', { key: key, className: 'slp-seg', title: title || (label ? label + ': ' : '') + metric.word },
        label ? React.createElement('span', { className: 'slp-seg-label' }, label) : null,
        React.createElement('span', { className: 'slp-codex-fill' },
          React.createElement('span', { style: { display: 'block', width: metric.shown + '%', height: '100%', background: pctColor(metric.used) } })),
        React.createElement('span', { className: 'slp-codex-pct' }, metric.shown + '%'),
        resetSec > 0 ? React.createElement('span', { className: 'slp-codex-reset' }, fmtResetShort(resetSec)) : null)
    }
    function panelBar(key, label, metric, resetSec) {
      var color = pctColor(metric.used)
      return React.createElement('div', { className: 'slp-bar', key: key, title: label + ': ' + metric.word },
        React.createElement('span', { className: 'slp-bar-swatch', style: { background: color } }),
        React.createElement('span', { className: 'slp-bar-label', title: label }, label),
        React.createElement('span', { className: 'slp-bar-track' },
          React.createElement('span', { className: 'slp-bar-fill', style: { width: metric.shown + '%', background: color } })),
        React.createElement('span', { className: 'slp-bar-val' },
          React.createElement('span', { className: 'slp-bar-pct' }, metric.shown + '%'),
          resetSec > 0 ? ' · ' : null,
          resetSec > 0 ? React.createElement('span', { className: 'slp-bar-reset' }, fmtResetShort(resetSec)) : null))
    }
    function PanelFoot(props) {
      return React.createElement('div', { className: 'slp-panel-foot' },
        React.createElement(QuotaFreshness, { data: { fetchedAt: props.fetchedAt }, ttlMs: props.ttlMs, staleError: props.staleError, now: props.now }),
        props.refresh ? React.createElement('button', { type: 'button', className: 'slp-link-btn',
          onClick: function (e) { e.stopPropagation(); props.refresh() } }, t('refreshNow')) : null)
    }
    function percentMode(props) { return props && props.mode === 'left' ? 'left' : 'used' }
    // percentRows: the panel lists percentages, so its heading names how they read.
    function quotaPanel(title, body, props, fetchedAt, percentRows) {
      return React.createElement('div', { className: 'slp-panel slp-panel-down', role: 'dialog', 'aria-label': title },
        React.createElement('p', { className: 'slp-panel-title' }, title,
          percentRows ? React.createElement('span', { className: 'slp-panel-mode' }, t(percentMode(props) === 'left' ? 'quotaModeLeft' : 'quotaModeUsed')) : null),
        body,
        React.createElement(PanelFoot, { fetchedAt: fetchedAt, ttlMs: props.ttlMs, staleError: props.staleError, now: props.now, refresh: props.refresh }))
    }
    // Chip button + details panel. The freshness tooltip and a "!" for a
    // failed refresh (still showing the last good data) are added here.
    function quotaShell(dismiss, props, label, title, segments, panel) {
      var fresh = props.data ? quotaFreshness(props.data, props.ttlMs, props.staleError, props.now) : null
      return React.createElement('span', { className: 'slp-quota-root', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { type: 'button', className: 'slp-quota-trigger', 'aria-expanded': dismiss.open, 'aria-haspopup': 'dialog',
          title: [title, fresh && fresh.title, t('clickDetails')].filter(Boolean).join(' · '), onClick: dismiss.toggle },
          React.createElement('span', { className: 'slp-quota-name' }, label), segments,
          props.staleError ? React.createElement('span', { className: 'slp-err', 'aria-hidden': true }, '!') : null),
        dismiss.open ? panel : null)
    }
    // Errors stay clickable for an immediate retry; loading is inert.
    function quotaPlaceholder(label, title, retry) {
      return React.createElement('span', { className: 'slp-quota-root' }, retry
        ? React.createElement('button', { type: 'button', className: 'slp-quota-trigger slp-quota-muted', title: title + ' · ' + t('clickRetry'),
          onClick: function () { retry() } }, label + ' ?')
        : React.createElement('span', { className: 'slp-quota-trigger slp-quota-muted', title: title }, label + ' …'))
    }
    function OpenCodeQuotaLine(props) {
      var dismiss = useQuotaPanel(props.refresh)
      if (props.error) return quotaPlaceholder(t('opencodeShort'), t('quotaFail') + ': ' + props.error, props.refresh)
      if (!props.data) return quotaPlaceholder(t('opencodeShort'), t('quotaLoadingShort'))
      var windows = normalizeWindows(props.data, props.now === undefined ? Date.now() : props.now)
      var mode = percentMode(props)
      var segments = windows.map(function (w) { var m = quotaMetric(w.pct, null, mode); return chipSegment(w.key, w.short, m, w.resetInSec, w.label + ': ' + m.word) })
      var rows = windows.map(function (w) { return panelBar(w.key, w.label, quotaMetric(w.pct, null, mode), w.resetInSec) })
      return quotaShell(dismiss, props, t('opencodeShort'), t('quotaTitle'), segments.length ? segments : '—',
        quotaPanel(t('detailTitle'), rows, props, props.data.fetchedAt, true))
    }

    function apiSessionModel(sessionId, signal) {
      if (!sessionId) return Promise.resolve({ ok: false, error: 'session-not-found' })
      return fetch('/statusline/api/session-model', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId }), signal: signal,
      }).then(function (response) { return response.json() }).catch(function () { return { ok: false, error: 'network' } })
    }
    function isCodexModel(model) {
      return !!(model && /codex|chatgpt/i.test(String(model.provider || '')))
    }
    function isAntigravityModel(model) {
      return !!(model && /antigravity/i.test(String(model.provider || '')))
    }
    // Built-ins match only the billing provider; custom sources retain substring/prefix matching.
    function providerMatchesModel(provider, model) {
      if (!provider || !model) return false
      var mp = String(model.provider || '').toLowerCase()
      var mm = String(model.model || '').toLowerCase()
      if (!mp && !mm) return false
      var exact = provider.match && provider.match.providerExact
      if (Array.isArray(exact) && exact.length) {
        return exact.some(function (name) { return name && String(name).toLowerCase() === mp })
      }
      var subs = (provider.match && provider.match.providerSub) || []
      for (var i = 0; i < subs.length; i++) {
        var s = String(subs[i] || '').toLowerCase()
        if (s && (mp.indexOf(s) !== -1 || mm.indexOf(s) !== -1)) return true
      }
      var prefixes = (provider.match && provider.match.modelPrefix) || []
      for (var j = 0; j < prefixes.length; j++) {
        var p = String(prefixes[j] || '').toLowerCase()
        if (p && mm.indexOf(p) === 0) return true
      }
      return false
    }
    function quotaNumber(v) {
      if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null
      var n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    function fmtMoney(v, currency) {
      var n = quotaNumber(v)
      if (n === null) return '—'
      var code = String(currency || 'USD').toUpperCase()
      var prefix = code === 'USD' ? '$' : code === 'CNY' ? '¥' : code + ' '
      return prefix + n.toFixed(2)
    }

    // Reuses the local peak indicator's official schedule. Beijing is UTC+8;
    // UTC date arithmetic keeps the result independent of browser timezones.
    // Calendar coverage is explicit: an unknown year's weekday holiday must
    // never silently become a confirmed peak window.
    var PEAK_HOLIDAYS = {
      2025: [
        ['01-01', '01-01', '元旦'], ['01-28', '02-04', '春节'],
        ['04-04', '04-06', '清明节'], ['05-01', '05-05', '劳动节'],
        ['05-31', '06-02', '端午节'], ['10-01', '10-08', '国庆节 / 中秋节'],
      ],
      2026: [
        ['01-01', '01-03', '元旦'], ['02-15', '02-23', '春节'],
        ['04-04', '04-06', '清明节'], ['05-01', '05-05', '劳动节'],
        ['06-19', '06-21', '端午节'], ['09-25', '09-27', '中秋节'],
        ['10-01', '10-07', '国庆节'],
      ],
    }
    function isDeepseekBilling(model) {
      return !!model && ['deepseek', 'deepseek-official'].indexOf(String(model.provider || '').toLowerCase()) !== -1
    }
    function peakCountdown(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—'
      var total = Math.floor(seconds), days = Math.floor(total / 86400)
      var pad = function (n) { return String(n).padStart(2, '0') }
      return (days ? days + 'd ' : '') + pad(Math.floor(total / 3600) % 24) + ':' + pad(Math.floor(total / 60) % 60) + ':' + pad(total % 60)
    }
    // Make-up workdays (调休上班的周末). DeepSeek's wording keeps every weekend
    // off-peak, so they only earn a note in the details.
    var PEAK_MAKEUP_DAYS = {
      2025: ['01-26', '02-08', '04-27', '09-28', '10-11'],
      2026: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10'],
    }
    // Holiday calendar for one Beijing year: the Host's fetched holiday-cn
    // copy when published, else the built-in ranges, else null (unknown year).
    var fetchedCalendars = typeof WeakMap === 'function' ? new WeakMap() : null
    function peakCalendar(year, schedule) {
      var fetched = schedule && schedule.holidays && schedule.holidays[year]
      if (fetched && fetched.published && Array.isArray(fetched.off)) {
        var cached = fetchedCalendars && fetchedCalendars.get(fetched)
        if (!cached) {
          var off = new Set(fetched.off), work = new Set(fetched.work || []), names = fetched.names || {}
          cached = { source: 'fetched', holiday: function (date) { return off.has(date) ? names[date] || t('peakHolidayUnnamed') : null }, makeup: function (date) { return work.has(date) } }
          if (fetchedCalendars) fetchedCalendars.set(fetched, cached)
        }
        return cached
      }
      var ranges = PEAK_HOLIDAYS[year]
      if (!ranges) return null
      return { source: 'builtin',
        holiday: function (date) { var hit = ranges.find(function (range) { return date.slice(5) >= range[0] && date.slice(5) <= range[1] }); return hit ? hit[2] : null },
        makeup: function (date) { return (PEAK_MAKEUP_DAYS[year] || []).indexOf(date.slice(5)) !== -1 } }
    }
    function deepseekPeakStatus(now, schedule) {
      if (now === undefined) now = Date.now()
      var unknown = { isPeak: null, calendarKnown: false, holiday: null, now: now, beijingDate: '', beijingTime: '',
        dayProgressPercent: 0, windows: [], nextSwitchAt: null, remainingSec: null }
      if (typeof now !== 'number' || !Number.isFinite(now)) return unknown
      var shifted = new Date(now + 8 * 3600000)
      if (!Number.isFinite(shifted.getTime())) return unknown
      var date = shifted.toISOString().slice(0, 10), year = shifted.getUTCFullYear()
      var calendar = peakCalendar(year, schedule), weekend = shifted.getUTCDay() === 0 || shifted.getUTCDay() === 6
      var holiday = calendar && calendar.holiday(date)
      var seconds = shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds()
      var windows = schedule && schedule.windows || [[9, 12], [14, 18]]
      var inside = windows.some(function (window) { return seconds >= window[0] * 3600 && seconds < window[1] * 3600 })
      var isPeak = weekend || holiday || !inside ? false : calendar ? true : null
      var rule = schedule && schedule.rule
      var result = { isPeak: isPeak, calendarKnown: !!calendar, holiday: holiday || null, weekend: weekend, now: now,
        makeupWorkday: !!(calendar && weekend && calendar.makeup(date)), calendarSource: calendar ? calendar.source : null,
        ruleChanged: !!(rule && (rule.status === 'changed' || rule.status === 'unreadable')),
        beijingDate: date, beijingTime: shifted.toISOString().slice(11, 19), dayProgressPercent: seconds / 864,
        windows: calendar && !weekend && !holiday ? windows : [], nextSwitchAt: null, remainingSec: null }
      if (isPeak === null) return result
      var dayStart = Date.UTC(year, shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 3600000
      if (isPeak) result.nextSwitchAt = dayStart + windows.find(function (window) { return seconds >= window[0] * 3600 && seconds < window[1] * 3600 })[1] * 3600000
      else {
        for (var offset = 0; offset <= 16 && result.nextSwitchAt === null; offset++) {
          var day = new Date(dayStart + offset * 86400000 + 8 * 3600000)
          var nextCalendar = peakCalendar(day.getUTCFullYear(), schedule)
          if (!nextCalendar) break
          var dow = day.getUTCDay()
          if (dow === 0 || dow === 6 || nextCalendar.holiday(day.toISOString().slice(0, 10))) continue
          for (var hour of windows.map(function (window) { return window[0] })) {
            var start = dayStart + offset * 86400000 + hour * 3600000
            if (start > now) { result.nextSwitchAt = start; break }
          }
        }
      }
      if (result.nextSwitchAt !== null) result.remainingSec = Math.max(0, Math.ceil((result.nextSwitchAt - now) / 1000))
      return result
    }
    // Host-fetched holiday calendar + official-rule check, loaded once per
    // page and again after 6 h. Absent or failed: the built-in data applies.
    var peakSchedule = { data: null, loadedAt: 0, loading: false, listeners: [] }
    function loadPeakSchedule() {
      if (peakSchedule.loading || Date.now() - peakSchedule.loadedAt < 6 * 3600000) return
      peakSchedule.loading = true
      fetch('/statusline/api/peak-schedule').then(function (response) { return response.json() }).then(function (result) {
        if (result && result.ok && result.data && typeof result.data === 'object') {
          peakSchedule.data = result.data
          peakSchedule.listeners.slice().forEach(function (listener) { listener(result.data) })
        }
      }).catch(function () { /* built-in calendar applies */ }).finally(function () {
        peakSchedule.loading = false
        peakSchedule.loadedAt = Date.now()
      })
    }
    function usePeakSchedule(enabled) {
      var pair = React.useState(peakSchedule.data)
      React.useEffect(function () {
        if (!enabled) return undefined
        var listener = pair[1]
        peakSchedule.listeners.push(listener)
        listener(peakSchedule.data)
        loadPeakSchedule()
        return function () { peakSchedule.listeners = peakSchedule.listeners.filter(function (fn) { return fn !== listener }) }
      }, [enabled])
      return pair[0]
    }
    // Re-render clock. Every second while a countdown is on screen; when
    // slow, only at the next peak/off-peak switch (at most every 60 s).
    function usePeakClock(enabled, slow) {
      var pair = React.useState(Date.now())
      React.useEffect(function () {
        if (!enabled) return undefined
        pair[1](Date.now())
        if (!slow) {
          var timer = setInterval(function () { pair[1](Date.now()) }, 1000)
          return function () { clearInterval(timer) }
        }
        var handle = null
        var schedule = function () {
          var now = Date.now(), next = deepseekPeakStatus(now, peakSchedule.data).nextSwitchAt
          handle = setTimeout(function () { pair[1](Date.now()); schedule() }, next === null ? 60000 : Math.min(60000, Math.max(1000, next - now + 50)))
        }
        schedule()
        return function () { clearTimeout(handle) }
      }, [enabled, !!slow])
      return pair[0]
    }
    function peakTone(status) { return status.isPeak === null ? 'unknown' : status.isPeak ? 'peak' : 'off' }
    function peakLocalTime(at) { return new Date(at).toLocaleString(currentLang() === 'zh' ? 'zh-CN' : 'en-US') }
    // Status word plus "next switch" text, shared by the header chip and the footer dot.
    function peakSummary(status, countdown) {
      var label = t(status.isPeak === null ? 'peakUnknown' : status.isPeak ? 'peakStatus' : 'offPeakStatus')
      var next = status.nextSwitchAt !== null
        ? countdown !== false ? t(status.isPeak ? 'peakToOff' : 'peakToPeak') + ' ' + peakCountdown(status.remainingSec) : t('peakNextSwitch') + ': ' + peakLocalTime(status.nextSwitchAt)
        : t('peakCalendarUnknown')
      return { label: label, next: next }
    }
    function PeakPanel(props) {
      var status = props.status, now = props.now, summary = peakSummary(status, props.countdown)
      var segments = [], cursor = 0
      status.windows.forEach(function (window, index) {
        if (window[0] > cursor) segments.push(React.createElement('span', { key: 'off' + index, style: { width: (window[0] - cursor) / 24 * 100 + '%', background: 'var(--dsw-alias-state-success-primary)' } }))
        segments.push(React.createElement('span', { key: 'peak' + index, title: window[0] + ':00–' + window[1] + ':00', style: { width: (window[1] - window[0]) / 24 * 100 + '%', background: 'var(--dsw-alias-state-warn-label)' } }))
        cursor = window[1]
      })
      segments.push(React.createElement('span', { key: 'tail', style: { width: (24 - cursor) / 24 * 100 + '%', background: !status.calendarKnown && !status.weekend ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-success-primary)' } }))
      var timeline = React.createElement('div', { className: 'slp-peak-timeline', title: t('peakRule'), 'aria-label': t('peakBeijing') + ' 00:00–24:00' }, segments,
        React.createElement('span', { className: 'slp-peak-cursor', style: { left: Math.min(99.5, status.dayProgressPercent) + '%' } }))
      if (props.compact) {
        // Footer popover: status + countdown, the day bar, one clock line; the full rule lives in the bar tooltip.
        var note = status.holiday ? tf('peakHoliday', { name: status.holiday }) : status.makeupWorkday ? t('peakMakeupDay') : status.weekend ? t('peakWeekend') : null
        return React.createElement('div', { className: 'slp-panel slp-peak-panel slp-peak-compact ' + (props.className || ''), role: 'region', 'aria-label': t('peakTitle'), style: props.style },
          React.createElement('strong', { 'data-peak': peakTone(status) }, summary.label + ' · ' + summary.next),
          timeline,
          React.createElement('p', null, t('peakBeijing') + ' ' + status.beijingTime.slice(0, 5) + ' · ' + t('peakLocal') + ' ' + new Date(now).toTimeString().slice(0, 5)),
          note ? React.createElement('p', null, note) : null,
          status.ruleChanged ? React.createElement('p', { className: 'slp-peak-alert' }, t('peakRuleChanged')) : null,
          React.createElement('a', { className: 'slp-peak-link', href: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', target: '_blank', rel: 'noopener noreferrer' }, t('peakOfficialShort')))
      }
      return React.createElement('div', { className: 'slp-panel slp-peak-panel ' + (props.className || 'slp-panel-down'), role: 'region', 'aria-label': t('peakTitle'), style: props.style },
        React.createElement('strong', null, t('peakTitle')),
        React.createElement('p', null, t('peakRule')),
        timeline,
        status.holiday ? React.createElement('p', null, tf('peakHoliday', { name: status.holiday })) : null,
        status.makeupWorkday ? React.createElement('p', null, t('peakMakeupDay')) : status.weekend ? React.createElement('p', null, t('peakWeekend')) : null,
        status.ruleChanged ? React.createElement('p', { className: 'slp-peak-alert' }, t('peakRuleChanged')) : null,
        status.calendarSource ? React.createElement('p', { className: 'slp-peak-source' }, t(status.calendarSource === 'fetched' ? 'peakSourceFetched' : 'peakSourceBuiltin')) : null,
        React.createElement('p', null, t('peakBeijing') + ': ' + status.beijingDate + ' ' + status.beijingTime + ' (UTC+8)'),
        React.createElement('p', null, t('peakLocal') + ': ' + peakLocalTime(now)),
        React.createElement('p', null, summary.next),
        status.nextSwitchAt !== null && props.countdown !== false ? React.createElement('p', null, t('peakNextSwitch') + ': ' + peakLocalTime(status.nextSwitchAt)) : null,
        React.createElement('a', { className: 'slp-peak-link', href: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', target: '_blank', rel: 'noopener noreferrer' }, t('peakOfficial')))
    }
    function DeepseekPeakChip(props) {
      var visible = usePageVisible(props.enabled !== false)
      var dismiss = useDismissiblePanel()
      usePeakClock(props.enabled !== false && visible, props.countdown === false && !dismiss.open)
      var schedule = usePeakSchedule(props.enabled !== false)
      var now = Date.now()
      if (props.enabled === false || !visible) return null
      var status = deepseekPeakStatus(now, schedule), summary = peakSummary(status, props.countdown)
      var color = status.isPeak === null ? 'var(--dsw-alias-label-tertiary)' : status.isPeak ? 'var(--dsw-alias-state-warn-label)' : 'var(--dsw-alias-state-success-primary)'
      var title = summary.label + ' · ' + summary.next + ' · ' + t('peakBeijing') + ' ' + status.beijingDate + ' ' + status.beijingTime
      return React.createElement('span', { className: 'slp-quota-root', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { className: 'slp-quota-trigger slp-peak-trigger', type: 'button', title: title, 'data-peak': peakTone(status),
          style: { color: color }, 'aria-expanded': dismiss.open, onClick: function () { dismiss.setOpen(function (open) { return !open }) } },
          React.createElement('span', { className: 'slp-peak-dot', 'aria-hidden': true }), summary.label,
          props.countdown !== false && status.remainingSec !== null ? React.createElement('span', { className: 'slp-peak-countdown' }, peakCountdown(status.remainingSec)) : null),
        dismiss.open ? React.createElement(PeakPanel, { status: status, now: now, countdown: props.countdown }) : null)
    }
    // Sidebar footer dot: visible without any session. A plain span, not an
    // <svg>: dsh-ui-tweaks recolours footer svgs to the grey label token.
    // Yellow = peak, green = off-peak, grey = calendar not covered. The panel
    // is fixed-positioned above the button so a clipping container cannot hide it.
    function PeakFooterDot() {
      var config = useConfigSnapshot()
      var enabled = !!(config && config.enabled !== false && config.showPeakDot !== false)
      var visible = usePageVisible(enabled)
      var dismiss = useDismissiblePanel()
      // Closed, nothing on screen counts down: wake only at the next switch.
      usePeakClock(enabled && visible, !dismiss.open)
      var hover = React.useState(0)
      var anchor = React.useState(null)
      var schedule = usePeakSchedule(enabled)
      if (!enabled) return null
      var now = Date.now()
      var status = deepseekPeakStatus(now, schedule), summary = peakSummary(status, true)
      var title = summary.label + ' · ' + summary.next + (status.ruleChanged ? ' · ' + t('peakRuleChangedShort') : '')
      return React.createElement('span', { className: 'slp-quota-root slp-peak-foot', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { type: 'button', className: 'dsh-sidebar-footer-action slp-peak-dot-btn', 'data-peak': peakTone(status), 'data-alert': status.ruleChanged ? 'true' : undefined,
          title: title, 'aria-label': title, 'aria-expanded': dismiss.open,
          // Re-render on hover so the tooltip countdown is current.
          onPointerEnter: function () { hover[1](Date.now()) },
          onClick: function (event) {
            var box = event.currentTarget.getBoundingClientRect(), height = window.innerHeight
            anchor[1](Number.isFinite(height) && box ? { left: Math.max(8, box.left), bottom: Math.max(8, height - box.top + 8) } : null)
            dismiss.setOpen(function (open) { return !open })
          } },
          React.createElement('span', { className: 'slp-peak-dot-lg', 'aria-hidden': true })),
        dismiss.open ? React.createElement(PeakPanel, { status: status, now: now, countdown: true, compact: true, className: 'slp-panel-fixed',
          style: anchor[0] ? { left: anchor[0].left + 'px', bottom: anchor[0].bottom + 'px' } : undefined }) : null)
    }
    // 自定义额度源行：balance 只显示余额（可配置低于阈值变红），
    // windows 复用 Codex 的分段条形态；点击展开详情并强制刷新一次。
    function ProviderQuotaLine(props) {
      var dismiss = useQuotaPanel(props.refresh)
      var provider = props.provider
      var data = props.data
      var short = provider && provider.label ? provider.label : (provider && provider.id) || 'provider'
      if (props.error) {
        var errMap = { auth: 'providerFailAuth', 'rate-limit': 'providerFailRate', network: 'providerFailNetwork', 'no-credential': 'providerFailNoCred', 'invalid-response': 'providerFail' }
        return quotaPlaceholder(short, t(errMap[props.error] || 'providerFail'), props.refresh)
      }
      if (!data) return quotaPlaceholder(short, t('providerLoading'))
      var segs = [], rows = [], titles = []
      if (data.style === 'windows' && Array.isArray(data.windows)) {
        data.windows.forEach(function (win, key) {
          if (!win || quotaNumber(win.usedPercent) === null) return
          var metric = quotaMetric(win.usedPercent, win.remainingPercent, percentMode(props))
          var reset = liveReset(win.resetInSec, data.fetchedAt, props.now)
          var titleText = tf('providerWindowTitle', { label: win.label || short, v: metric.word })
          if (reset > 0) titleText += ' · ' + tf('providerResetTitle', { r: fmtResetHours(reset) })
          segs.push(chipSegment(key, win.label || '', metric, reset, titleText))
          rows.push(panelBar(key, win.label || short, metric, reset))
        })
      } else if (data.style === 'balance') {
        var balances = Array.isArray(data.balances) && data.balances.length ? data.balances : [data]
        var redBelow = quotaNumber(data.redBelow)
        balances.forEach(function (balance, key) {
          if (!balance) return
          var remaining = quotaNumber(balance.remaining)
          var used = quotaNumber(balance.used)
          var currency = balance.currency || data.currency
          var isRed = data.isAvailable === false || (redBelow !== null && remaining !== null && remaining < redBelow)
          var text = remaining !== null ? fmtMoney(remaining, currency) : (used !== null ? tf('providerUsedShort', { u: fmtMoney(used, currency) }) : '—')
          var titleText = tf('providerBalanceTitle', { label: short + (currency ? ' (' + currency + ')' : ''), r: fmtMoney(remaining, currency) })
          if (used !== null) titleText += ' · ' + tf('providerUsedShort', { u: fmtMoney(used, currency) })
          if (quotaNumber(balance.granted) !== null) titleText += ' · ' + tf('providerGranted', { v: fmtMoney(balance.granted, currency) })
          if (quotaNumber(balance.toppedUp) !== null) titleText += ' · ' + tf('providerToppedUp', { v: fmtMoney(balance.toppedUp, currency) })
          if (redBelow !== null) titleText += ' · ' + tf('providerRedBelowTitle', { v: fmtMoney(redBelow, currency) })
          titles.push(titleText)
          var parts = []
          if (used !== null) parts.push(tf('providerUsedShort', { u: fmtMoney(used, currency) }))
          if (quotaNumber(balance.granted) !== null) parts.push(tf('providerGranted', { v: fmtMoney(balance.granted, currency) }))
          if (quotaNumber(balance.toppedUp) !== null) parts.push(tf('providerToppedUp', { v: fmtMoney(balance.toppedUp, currency) }))
          rows.push(React.createElement('div', { key: key, className: 'slp-balance' },
            React.createElement('span', { className: 'slp-balance-amount' + (isRed ? ' slp-err' : '') }, text),
            currency ? React.createElement('span', { className: 'slp-balance-meta' }, currency) : null,
            parts.length ? React.createElement('p', { className: 'slp-panel-note' }, parts.join(' · ')) : null))
          segs.push(React.createElement('span', { key: key, className: 'slp-seg' },
            React.createElement('span', {
              className: 'slp-seg-label',
              style: { color: isRed ? 'var(--dsw-alias-state-error-primary)' : undefined, fontWeight: isRed ? 600 : undefined },
            }, text)
          ))
        })
        if (redBelow !== null) rows.push(React.createElement('p', { key: 'red', className: 'slp-panel-note' }, tf('providerRedBelowTitle', { v: fmtMoney(redBelow, data.currency || balances[0] && balances[0].currency) })))
        if (typeof data.isAvailable === 'boolean') {
          titles.push(t(data.isAvailable ? 'providerAvailable' : 'providerUnavailable'))
          rows.push(React.createElement('p', { key: 'availability', className: 'slp-panel-note' }, t(data.isAvailable ? 'providerAvailable' : 'providerUnavailable')))
        }
      }
      if (!segs.length) segs.push(React.createElement('span', { key: 'unknown' }, '—'))
      var heading = short + ' · ' + t(data.style === 'windows' ? 'setSubscriptionSource' : 'setBalanceSource')
      return quotaShell(dismiss, props, short, titles.join(' · '), segs, quotaPanel(heading, rows, props, data.fetchedAt, data.style === 'windows'))
    }
    // 当前会话模型查询（宿主读会话日志 request/header，10s 按会话缓存）。
    // 新会话不继承其他会话的模型；在宿主返回权威结果前保持 loading，
    // 避免把错误的 provider quota 请求到另一个会话上；
    // 同一会话在 step/turn 刷新时保持已解析的模型状态（stale-while-revalidate），
    // 避免头部芯片因短暂重置为 loading 导致卸载闪烁。
    function useSessionModel(sessionId, refreshKey, enabled) {
      var resolveInitial = function (sid) {
        if (!sid || !enabled) return { status: 'unknown', model: null, error: null, sessionId: sid }
        return { status: 'loading', model: null, error: null, sessionId: sid }
      }
      var [state, setState] = React.useState(function () { return resolveInitial(sessionId) })
      var prevSessionRef = React.useRef(sessionId)

      React.useEffect(function () {
        var alive = true
        var sessionChanged = prevSessionRef.current !== sessionId
        prevSessionRef.current = sessionId

        if (!enabled || !sessionId) {
          setState({ status: 'unknown', model: null, error: null, sessionId: sessionId })
          return function () { alive = false }
        }

        if (sessionChanged) {
          setState(resolveInitial(sessionId))
        }

        var controller = new AbortController()
        apiSessionModel(sessionId, controller.signal).then(function (result) {
          if (!alive) return
          if (result && result.ok) {
            setState(function (prev) {
              if (prev && prev.sessionId === sessionId && prev.status === 'resolved' && !prev.error) {
                var prevM = prev.model
                var nextM = result.data
                if (prevM === nextM) return prev
                if (prevM && nextM && prevM.model === nextM.model && prevM.provider === nextM.provider) {
                  return prev
                }
              }
              return { status: 'resolved', model: result.data || null, error: null, sessionId: sessionId }
            })
          } else if (sessionChanged) {
            setState({ status: 'unknown', model: null, error: (result && result.error) || 'network', sessionId: sessionId })
          }
        })
        return function () { alive = false; controller.abort() }
      }, [sessionId, refreshKey, enabled])

      return state.sessionId === sessionId ? state : resolveInitial(sessionId)
    }

    function CodexQuotaLine(props) {
      var dismiss = useQuotaPanel(props.refresh)
      var data = props.data
      if (props.error) {
        var errMap = { auth: 'codexFailAuth', 'rate-limit': 'codexFailRate', network: 'codexFailNetwork', 'no-credential': 'codexFailNoCred', 'account-required': 'codexAccountRequired' }
        return quotaPlaceholder(t('codexShort'), t(errMap[props.error] || 'codexFail'), props.refresh)
      }
      if (!data) return quotaPlaceholder(t('codexShort'), t('codexUnknown'))
      var segs = [], rows = [], titleParts = []
      ;[['p', data.primary], ['s', data.secondary]].forEach(function (pair) {
        var win = pair[1]
        if (!win || quotaNumber(win.usedPercent) === null) return
        var metric = quotaMetric(win.usedPercent, null, percentMode(props))
        var reset = liveReset(win.resetAfterSeconds, data.fetchedAt, props.now)
        titleParts.push(codexWindowLabel(win.windowMinutes, true) + ': ' + metric.word)
        segs.push(chipSegment(pair[0], codexWindowLabel(win.windowMinutes), metric, reset))
        rows.push(panelBar(pair[0], codexWindowLabel(win.windowMinutes, true), metric, reset))
      })
      var notes = []
      if (data.planType) notes.push(t('codexPlan') + ': ' + data.planType)
      if (data.activeLimit && String(data.activeLimit) !== 'none') notes.push(t('codexActiveLimit') + ': ' + data.activeLimit)
      var credits = data.credits
      if (credits && credits.unlimited) notes.push(t('codexCreditsUnlimited'))
      else if (credits && typeof credits.balance === 'number') notes.push(t('codexCredits') + ': $' + credits.balance)
      notes.forEach(function (note, i) { rows.push(React.createElement('p', { key: 'n' + i, className: 'slp-panel-note' }, note)) })
      return quotaShell(dismiss, props, t('codexShort'), titleParts.concat(notes).join(' · '), segs.length ? segs : '—',
        quotaPanel(t('codexDetailTitle'), rows, props, data.fetchedAt, true))
    }

    var ANTIGRAVITY_WINDOWS = [['5h', 'gemini5h', 'win5h'], ['wk', 'geminiWeekly', 'winWeek'], ['3p', 'thirdParty', 'antigravityThirdParty']]
    function AntigravityDetailPanel(props) {
      var data = props.data
      var accounts = data && Array.isArray(data.accounts) && data.accounts.length > 1 ? data.accounts : null
      function renderBars(target) {
        if (target && target.error) {
          return [React.createElement('p', { key: 'err', className: 'slp-panel-note slp-err' }, t('antigravityFetchFail') + target.error)]
        }
        var fetchedAt = target && target.fetchedAt || data && data.fetchedAt
        return ANTIGRAVITY_WINDOWS.map(function (spec) {
          var item = target && target[spec[1]]
          if (!item) return null
          return panelBar(spec[0], t(spec[2]), quotaMetric(item.usedPercent, item.remainingPercent, percentMode(props)), liveReset(item.resetInSec, fetchedAt, props.now))
        }).filter(Boolean)
      }
      var content
      if (accounts) {
        content = accounts.map(function (acct, idx) {
          var isCurrent = acct.fileName === data.selectedFileName && acct.status === 'available'
          var statusKey = acct.error ? 'antigravityStatusError' : acct.status === 'exhausted' ? 'antigravityStatusExhausted' : isCurrent ? 'antigravityStatusActive' : acct.status === 'available' ? 'antigravityStatusStandby' : 'antigravityStatusUnknown'
          var statusClass = isCurrent ? ' slp-acct-current' : acct.error || acct.status === 'exhausted' ? ' slp-err' : ''
          return React.createElement('div', { key: acct.fileName || acct.email, className: 'slp-acct' },
            React.createElement('div', { className: 'slp-acct-head' },
              React.createElement('span', null, (acct.email || acct.fileName) + ' · #' + (idx + 1) + ' · ' + tf('antigravityPriority', { n: acct.priority })),
              React.createElement('span', { className: 'slp-acct-state' + statusClass }, t(statusKey))),
            renderBars(acct))
        })
      } else {
        content = renderBars(data)
      }
      var title = t('antigravityDetailTitle') + (data && data.email && !accounts ? ' (' + data.email + ')' : '')
      return quotaPanel(title, content, props, data && data.fetchedAt, true)
    }

    // Antigravity 额度行：`Antigravity 5h ▮ 14% (3.1h) 周 ▮ 20% (1.0d)`，点击展开详情并刷新一次
    function AntigravityQuotaLine(props) {
      var dismiss = useQuotaPanel(props.refresh)
      var data = props.data
      if (props.error) {
        var errMap = { auth: 'antigravityFailAuth', 'rate-limit': 'antigravityFailRate', network: 'antigravityFailNetwork', 'no-credential': 'antigravityFailNoCred', 'account-required': 'antigravityAccountRequired' }
        return quotaPlaceholder(t('antigravityShort'), t(errMap[props.error] || 'antigravityFail'), props.refresh)
      }
      if (!data) return quotaPlaceholder(t('antigravityShort'), t('antigravityUnknown'))
      var segments = [], titleParts = []
      ANTIGRAVITY_WINDOWS.slice(0, 2).forEach(function (spec) {
        var item = data[spec[1]]
        if (!item) return
        var metric = quotaMetric(item.usedPercent, item.remainingPercent, percentMode(props))
        segments.push(chipSegment(spec[0], t(spec[0] === '5h' ? 'antigravity5h' : 'antigravityWeekly'), metric, liveReset(item.resetInSec, data.fetchedAt, props.now)))
        titleParts.push(t(spec[2]) + ': ' + metric.word)
      })
      if (!segments.length) return quotaPlaceholder(t('antigravityShort'), t('antigravityUnknown'), props.refresh)
      if (data.email) titleParts.unshift((data.priority !== undefined ? tf('antigravityPriority', { n: data.priority }) + ': ' : '') + data.email)
      var labelText = t('antigravityShort')
      if (data.accounts && data.accounts.length > 1 && data.priority !== undefined) {
        labelText += ' #' + (data.accounts.findIndex(function (account) { return account.fileName === data.selectedFileName }) + 1)
      }
      return quotaShell(dismiss, props, labelText, titleParts.join(' · '), segments,
        React.createElement(AntigravityDetailPanel, { data: data, refresh: props.refresh, ttlMs: props.ttlMs, staleError: props.staleError, now: props.now, mode: props.mode }))
    }

    // git 状态行：没有找到 git 信息（非仓库/取不到路径/失败）时默认不展示
    function GitLine(props) {
      var data = props.data
      if (!data || !data.isRepo) return null
      var children = []
      // 智能截断的仓库路径（showCwd 开启时显示；完整路径放 title）
      if (props.path) {
        children.push(React.createElement('span', { key: 'p', className: 'slp-git-path', title: props.fullPath || props.path }, props.path))
      }
      var branch = data.branch || t('gitBranchNone')
      if (data.ahead > 0) branch += ' ↑' + data.ahead
      if (data.behind > 0) branch += ' ↓' + data.behind
      children.push(React.createElement('span', { key: 'br', className: 'slp-git-branch', title: branch }, '⎇ ' + branch))
      var c = data.counts
      if (c.staged > 0) children.push(React.createElement('span', { key: 's', className: 'slp-git-staged' }, t('gitStaged') + ' ' + c.staged))
      if (c.unstaged > 0) children.push(React.createElement('span', { key: 'u', className: 'slp-git-unstaged' }, t('gitUnstaged') + ' ' + c.unstaged))
      if (c.untracked > 0) children.push(React.createElement('span', { key: 'ut', title: t('gitUntracked') }, '?' + c.untracked))
      if (c.conflict > 0) children.push(React.createElement('span', { key: 'c', className: 'slp-git-conflict' }, t('gitConflict') + ' ' + c.conflict))
      var lineStats = data.lineStats || {}
      if (Number(lineStats.added) > 0) children.push(React.createElement('span', { key: 'la', className: 'slp-git-added', title: t('gitDiffTitle') + ' · +' + lineStats.added }, '+' + compactCount(lineStats.added)))
      if (Number(lineStats.deleted) > 0) children.push(React.createElement('span', { key: 'ld', className: 'slp-git-deleted', title: t('gitDiffTitle') + ' · -' + lineStats.deleted }, '-' + compactCount(lineStats.deleted)))
      if (data.lineStatsError) children.push(React.createElement('span', { key: 'unknown', title: t('gitLinesUnknown') }, '+/− ?'))
      if (props.stale) children.push(React.createElement('span', { key: 'stale', className: 'slp-err', title: t('gitStale') }, '!'))
      var titleExtra = c.untracked > 0 ? ' · ' + t('gitUntracked') + ' ' + c.untracked : ''
      return React.createElement('span', { className: 'slp-group slp-git' },
        React.createElement('button', {
          type: 'button',
          className: 'slp-git-trigger',
          title: t('gitTitle') + titleExtra,
          style: { opacity: props.busy ? 0.6 : 1 },
          onClick: function () { props.refresh() },
        }, children)
      )
    }

    var childBaselineIds = new WeakMap()
    function childIds(state) {
      var ids = state && state.ids
      if (!Array.isArray(ids)) return null
      var cached = childBaselineIds.get(ids)
      if (!cached) { cached = new Set(ids); childBaselineIds.set(ids, cached) }
      return cached
    }
    function childRunning(child, state, statuses, ids) {
      var status = statuses && typeof statuses.get === 'function' && statuses.get(child.id)
      if (status && typeof status.running === 'boolean') return status.running
      var summary = state && state.byId && state.byId[child.id]
      return summary && ids && ids.has(child.id) && typeof summary.running === 'boolean' ? summary.running : null
    }
    // One character per child, with no model/timing reads or JSON allocation.
    function childRunningKey(catalog, state, statuses) {
      var ids = childIds(state), key = ''
      for (var child of catalog) {
        var running = childRunning(child, state, statuses, ids)
        key += running === true ? '1' : running === false ? '0' : '?'
      }
      return key
    }
    function childActivityRows(catalog, state, statuses) {
      var ids = childIds(state)
      return (Array.isArray(catalog) ? catalog : []).map(function (child) {
        var summary = state && state.byId && state.byId[child.id]
        // byId also contains synthetic catalog rows whose default false is
        // not a Host observation. Only ids members carry a real baseline.
        var running = childRunning(child, state, statuses, ids)
        var projection = state && state.projectionsBySession && state.projectionsBySession[child.id]
        var values = Object.assign({}, summary && summary.projectionValues, projection && projection.values)
        var usedModel = values.modelSelection && values.modelSelection.lastUsed
        var identity = values.subagent
        return { id: child.id, label: child.label || child.id, running: typeof running === 'boolean' ? running : null,
          mode: child.mode === 'one-shot' || child.mode === 'continuable' ? child.mode : identity && identity.mode || 'unknown',
          model: usedModel && typeof usedModel.model === 'string' ? usedModel.model : null,
          effort: usedModel && typeof usedModel.reasoningEffort === 'string' && usedModel.reasoningEffort ? usedModel.reasoningEffort : null,
          timing: values.subagentTiming || null, createdAt: child.createdAt || 0 }
      })
    }
    function childElapsed(row, now) {
      var timing = row.timing
      if (!timing || typeof timing.settledMs !== 'number' || !Number.isFinite(timing.settledMs) || timing.settledMs < 0) return null
      var elapsed = timing.settledMs, active = timing.active
      if (active) {
        var end = row.running === true ? now : active.through
        if (!Number.isFinite(end) || !Number.isFinite(active.since)) return null
        elapsed += Math.max(0, end - active.since)
      }
      return Math.floor(elapsed / 1000)
    }
    function ActivityRow(props) {
      var catalog = typeof props.useProjection === 'function' ? props.useProjection('subagentCatalog') : null
      var list = Array.isArray(catalog) ? catalog : []
      var dismiss = useDismissiblePanel(), visible = usePageVisible(true)
      // Status counters remain live while collapsed; hidden pages and collapsed
      // details do not walk models, efforts, or timing projections.
      var runningKey = typeof props.useSessions === 'function' ? props.useSessions(function (state) {
        return visible ? childRunningKey(list, state, null) : ''
      }) : ''
      var statusKey = typeof props.useSessionStatus === 'function' ? props.useSessionStatus(function (statuses) {
        return visible ? childRunningKey(list, null, statuses) : ''
      }) : null
      var lifecycle = React.useRef(null), repaint = React.useState(0)[1], wallNow = Date.now()
      if (!lifecycle.current || lifecycle.current.sessionId !== props.sessionId) lifecycle.current = { sessionId: props.sessionId, stops: new Map() }
      var stops = lifecycle.current.stops, present = new Set(), nextAt = null, rows = []
      var active = 0, stopped = 0, unknown = 0
      if (visible) {
        list.forEach(function (child, index) {
          var flag = statusKey && statusKey[index] !== '?' ? statusKey[index] : runningKey && runningKey[index]
          var running = flag === '1' ? true : flag === '0' ? false : null, faded = false
          present.add(child.id)
          // Progress includes expired detail rows; fading must not change N/N.
          if (running === true) active++
          else if (running === false) stopped++
          else unknown++
          if (props.preview || running !== false) stops.delete(child.id)
          else {
            if (!stops.has(child.id)) stops.set(child.id, wallNow)
            var stoppedAt = stops.get(child.id), age = Math.max(0, wallNow - stoppedAt)
            if (age >= 15000) return
            faded = age >= 5000
            var boundary = stoppedAt + (faded ? 15000 : 5000)
            nextAt = nextAt === null ? boundary : Math.min(nextAt, boundary)
          }
          rows.push(Object.assign({}, child, { running: running, faded: faded }))
        })
        stops.forEach(function (_, id) { if (!present.has(id)) stops.delete(id) })
      }
      // One deadline timer, even with many children. Hidden tabs retain absolute
      // stop times but do no work; resuming a child clears its old deadline.
      React.useEffect(function () {
        if (props.preview || !visible || nextAt === null) return undefined
        var timer = setTimeout(function () { repaint(function (n) { return n + 1 }) }, Math.max(0, nextAt - Date.now()))
        return function () { clearTimeout(timer) }
      }, [visible, nextAt, props.preview, props.sessionId])
      var now = usePeakClock(!props.preview && visible && dismiss.open && active > 0)
      // Running agents first, followed by recent agents; only visible details
      // need cold-session timing reads.
      var shown = dismiss.open && visible ? rows.slice().reverse().sort(function (a, b) { return Number(b.running === true) - Number(a.running === true) || (b.createdAt || 0) - (a.createdAt || 0) }).slice(0, 12) : []
      var idsKey = JSON.stringify(shown.map(function (row) { return row.id }))
      var detailsKey = typeof props.useSessions === 'function' ? props.useSessions(function (state) {
        return visible && dismiss.open ? JSON.stringify(childActivityRows(shown, state, null)) : ''
      }) : visible && dismiss.open ? JSON.stringify(childActivityRows(shown, null, null)) : ''
      if (detailsKey) {
        var details = JSON.parse(detailsKey)
        shown = shown.map(function (row, index) { return Object.assign({}, details[index], { running: row.running, faded: row.faded }) })
      }
      React.useEffect(function () {
        if (props.preview || !visible || !dismiss.open || !CTX) return undefined
        var sessions
        try { sessions = CTX.get('sessions') } catch (_) { return undefined }
        if (!sessions || typeof sessions.refreshProjections !== 'function') return undefined
        JSON.parse(idsKey).forEach(function (id) { Promise.resolve(sessions.refreshProjections(id)).catch(function () {}) })
        return undefined
      }, [visible, dismiss.open, idsKey, props.preview])
      if (!visible || !Array.isArray(catalog) || !rows.length) return null
      var label = tf('activitySummary', { stopped: stopped, total: list.length }) + (unknown ? ' · ?' + unknown : '')
      return React.createElement('span', { className: 'slp-group slp-activity', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { type: 'button', className: 'slp-activity-trigger', style: { opacity: rows.every(function (row) { return row.faded }) ? 0.5 : 1, transition: 'opacity .2s' }, title: tf('activitySummaryTitle', { active: active, stopped: stopped, unknown: unknown }), 'aria-expanded': dismiss.open,
          onClick: function () { dismiss.setOpen(function (open) { return !open }) } }, label),
        dismiss.open ? React.createElement('div', { className: 'slp-panel slp-activity-panel slp-subagent-panel', role: 'region', 'aria-label': t('activityTitle') },
          React.createElement('strong', null, 'Subagents'),
          React.createElement('p', { className: 'slp-subagent-summary' }, [active ? tf('activityRunning', { n: active }) : null,
            stopped ? tf('activityDone', { n: stopped }) : null, unknown ? tf('activityUnknown', { n: unknown }) : null].filter(Boolean).join(' · ')),
          shown.map(function (row) {
            var seconds = childElapsed(row, now)
            return React.createElement('div', { key: row.id, className: 'slp-activity-item', style: { opacity: row.faded ? 0.5 : 1, transition: 'opacity .2s' } },
              React.createElement('span', { className: 'slp-subagent-title', title: row.label }, row.label),
              row.model || row.effort ? React.createElement('div', { className: 'slp-subagent-model-row' },
                React.createElement('span', { className: 'slp-subagent-model', title: t('activityLastModel') + ': ' + (row.model || '—') }, row.model || '—'),
                row.effort ? React.createElement('span', { className: 'slp-subagent-effort', title: t('activityEffort') + ': ' + row.effort }, row.effort) : null) : null,
              React.createElement('div', { className: 'slp-subagent-state-row' },
                React.createElement('span', null,
                  React.createElement('span', { className: 'slp-subagent-status', 'data-running': row.running }, t(row.running === true ? 'activityRunningState' : row.running === false ? 'activityStoppedState' : 'activityUnknownState')),
                  ' · ' + t(row.mode === 'one-shot' ? 'activityOneShot' : row.mode === 'continuable' ? 'activityContinuable' : 'activityModeUnknown')),
                React.createElement('time', null, seconds === null ? '—' : peakCountdown(seconds))))
          }),
          rows.length > shown.length ? React.createElement('p', null, '+' + (rows.length - shown.length)) : null) : null)
    }
    function toolElapsed(row, now) {
      if (typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt)) return null
      var end = row.status === 'running' ? now : row.endedAt
      return typeof end === 'number' && Number.isFinite(end) && end >= row.startedAt ? Math.floor((end - row.startedAt) / 1000) : null
    }
    function ToolActivityRow(props) {
      var data = typeof props.useProjection === 'function' ? props.useProjection('statuslineToolActivity') : null
      var running = props.preview ? true : typeof props.useSessionStatus === 'function' ? props.useSessionStatus(function (statuses) {
        var status = statuses && typeof statuses.get === 'function' && (statuses.get(props.sessionId) || statuses.get('session-' + props.sessionId))
        return status && typeof status.running === 'boolean' ? status.running : null
      }) : null
      var dismiss = useDismissiblePanel(), visible = usePageVisible(true)
      var rows = data && Array.isArray(data.tools) ? data.tools : []
      var pending = running === true ? rows.filter(function (row) { return row.status === 'running' }) : []
      var now = usePeakClock(!props.preview && visible && dismiss.open && pending.length > 0)
      if (!visible || !data || (!pending.length && (running !== true || data.activeCount !== null)) && !dismiss.open) return null
      if (!pending.length && !rows.length) return null
      var names = pending.slice(0, 2).map(function (row) { return row.name || '—' }).join(' · ')
      var extra = running !== true ? 0 : typeof data.activeCount === 'number' ? Math.max(0, data.activeCount - 2) : null
      var count = running === false ? 0 : running !== true || typeof data.activeCount !== 'number' ? null : data.activeCount
      var label = t('toolsLabel') + ' ' + (count === null ? '?' : count)
      var title = t('toolsTitle') + (names ? ': ' + names + (extra ? ' +' + extra : extra === null ? ' +?' : '') : '') + '\n' + t('toolsTimingHint')
      var shown = pending.concat(rows.filter(function (row) { return pending.indexOf(row) === -1 }).slice().reverse()).slice(0, 12)
      var statusLabels = { running: 'toolsRunning', completed: 'toolsCompleted', failed: 'toolsFailed', cancelled: 'toolsCancelled', 'not-started': 'toolsNotStarted', unknown: 'toolsUnknown', stopped: 'toolsStopped' }
      return React.createElement('span', { className: 'slp-group slp-tools', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { type: 'button', className: 'slp-activity-trigger', title: title, 'aria-expanded': dismiss.open,
          onClick: function () { dismiss.setOpen(function (open) { return !open }) } }, label),
        dismiss.open ? React.createElement('div', { className: 'slp-panel slp-activity-panel', role: 'region', 'aria-label': t('toolsTitle') },
          React.createElement('strong', null, t('toolsTitle')),
          shown.map(function (row) {
            var actual = running === true || row.status !== 'running' ? row : Object.assign({}, row, { status: running === false ? 'stopped' : 'unknown' })
            var seconds = toolElapsed(actual, props.preview ? row.startedAt + 12000 : now)
            return React.createElement('div', { key: row.callId, className: 'slp-activity-item' },
              React.createElement('span', { className: 'slp-tool-name', title: row.name || '' }, row.name || '—'),
              React.createElement('span', { className: actual.status === 'failed' ? 'slp-err' : '' }, t(statusLabels[actual.status] || 'toolsUnknown')),
              React.createElement('span', null, seconds === null ? '—' : peakCountdown(seconds)))
          }),
          data.truncated ? React.createElement('p', null, t('toolsIncomplete')) : null,
          rows.length > shown.length ? React.createElement('p', null, '+' + (rows.length - shown.length)) : null,
          React.createElement('p', { className: 'slp-set-desc' }, t('toolsTimingHint'))) : null)
    }
    function estimateMoney(value, symbol) {
      symbol = symbol || '¥'
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      return symbol + value.toFixed(2)
    }
    function estimateCost(bucket, compact) {
      if (!bucket || !bucket.pricedMessages) return t('costUnknown')
      var parts = []
      ;[['amountCny', 'minCny', 'maxCny', '¥'], ['amountUsd', 'minUsd', 'maxUsd', '$']].forEach(function (currency) {
        var amount = bucket[currency[0]], min = bucket[currency[1]], max = bucket[currency[2]]
        if (typeof amount === 'number') parts.push(estimateMoney(amount, currency[3]))
        else if (typeof min === 'number' && typeof max === 'number') parts.push(estimateMoney(min, currency[3]) + '–' + estimateMoney(max, currency[3]))
      })
      if (!parts.length) return t('costUnknown')
      var text = parts.join(' + ')
      return text + (!compact && bucket.unpricedMessages ? ' (' + t('costPartial') + ')' : '')
    }
    function costReasons(bucket) {
      var labels = { 'unsupported-provider': 'costReasonProvider', 'unsupported-model': 'costReasonModel',
        'missing-or-invalid-usage': 'costReasonUsage', 'inconsistent-usage': 'costReasonInconsistent',
        'cache-write-rate-unknown': 'costReasonWrite', 'cache-read-rate-unknown': 'costReasonRead',
        'request-time-unknown': 'costReasonTime', 'historical-price-unknown': 'costReasonHistory',
        'tariff-window-unknown': 'costReasonTariff', 'missing-settlement': 'costReasonSettlement',
        'usage-overflow': 'costReasonOverflow', 'cost-overflow': 'costReasonOverflow', 'invalid-price': 'costReasonPrice' }
      return Object.keys(bucket.reasons || {}).map(function (reason) { return (labels[reason] ? t(labels[reason]) : t('costUnknown')) + ' ×' + bucket.reasons[reason] }).join(' · ')
    }
    function costBreakdownTables(bucket) {
      if (!bucket.breakdown) return null
      return [['Cny', '¥'], ['Usd', '$']].map(function (currency) {
        var min = bucket['min' + currency[0]], max = bucket['max' + currency[0]], amount = bucket['amount' + currency[0]]
        if (typeof amount === 'number') min = max = amount
        if (typeof min !== 'number' || typeof max !== 'number') return null
        var total = (min + max) / 2, ranged = min !== max
        var segments = []
        var rows = [['input', 'costInput'], ['cache', 'costCache'], ['output', 'costOutput']].map(function (spec) {
          var part = bucket.breakdown[spec[0]], low = part && part['min' + currency[0]], high = part && part['max' + currency[0]]
          if (!part || typeof low !== 'number' || typeof high !== 'number') return null
          var cost = estimateMoney(low, currency[1]) + (low !== high ? '–' + estimateMoney(high, currency[1]) : '')
          var tokens = part['tokens' + currency[0]], tokenText = typeof tokens === 'number' ? tokens < 1000 ? (tokens / 1000) + 'K' : formatTokens(tokens) : '—'
          var percent = total > 0 ? (low + high) / 2 / total * 100 : 0
          var share = total > 0 ? (ranged ? '≈' : '') + Math.round(percent * 10) / 10 + '%' : '—'
          if (percent > 0) segments.push(React.createElement('span', { key: spec[0], className: 'slp-cost-segment slp-cost-tint', 'data-kind': spec[0], style: { width: percent + '%' } }))
          return React.createElement('tr', { key: spec[0] }, React.createElement('td', null,
            React.createElement('span', { className: 'slp-cost-label' },
              React.createElement('span', { className: 'slp-cost-swatch slp-cost-tint', 'data-kind': spec[0], 'aria-hidden': true }), t(spec[1]))),
            React.createElement('td', { className: 'slp-cost-tokens', title: typeof tokens === 'number' ? String(tokens) + ' tokens' : t('costTokensPending') }, tokenText),
            React.createElement('td', null, cost), React.createElement('td', null, share))
        })
        if (rows.some(function (row) { return !row })) return null
        return React.createElement('div', { key: currency[0], className: 'slp-cost-breakdown' },
          React.createElement('div', { className: 'slp-cost-bar', 'aria-hidden': true }, segments),
          React.createElement('table', { className: 'slp-cost-table', 'aria-label': t('costTitle') + ' ' + currency[1] },
            React.createElement('thead', null, React.createElement('tr', null,
              ['costKind', 'costTokens', 'costAmount', 'costShare'].map(function (label) { return React.createElement('th', { key: label, scope: 'col' }, t(label)) }))),
            React.createElement('tbody', null, rows)))
      })
    }
    function CostRow(props) {
      var data = typeof props.useProjection === 'function' ? props.useProjection('statuslineMetrics') : null
      var dismiss = useDismissiblePanel()
      if (!data || !data.session || !(data.session.pricedMessages + data.session.unpricedMessages)) return null
      var coverage = tf('costPriced', { n: data.session.pricedMessages }) + (data.session.unpricedMessages ? ' · ' + tf('costUnpriced', { n: data.session.unpricedMessages }) : '')
      var panel = null
      if (dismiss.open) {
        var sources = data.session.sources || {}, native = sources['pi-ai'], fallback = sources.fallback, cnyFallback = sources['deepseek-fallback'] || !data.session.sources
        var details = [t('costScope'), t('costBreakdownHint')], sourceLabels = []
        if (native) {
          sourceLabels.push('pi-ai')
          details.push(tf('costNative', { version: data.catalog && data.catalog.version || '—', time: data.catalog && data.catalog.generatedAt ? new Date(data.catalog.generatedAt).toLocaleString() : '—', n: native }))
        }
        if (fallback) {
          sourceLabels.push('fallback')
          details.push(tf('costFallback', { time: data.catalog && data.catalog.fallbackAsOf ? new Date(data.catalog.fallbackAsOf).toLocaleString() : '—', n: fallback }))
        }
        if (cnyFallback) {
          if (!fallback) sourceLabels.push('fallback')
          details.push(tf('costAsOf', { time: data.pricingAsOf ? new Date(data.pricingAsOf).toLocaleString() : '—' }))
        }
        panel = React.createElement('div', { className: 'slp-panel slp-cost-panel', role: 'region', 'aria-label': t('costTitle') },
          React.createElement('div', { className: 'slp-cost-head' }, React.createElement('strong', null, t('costTitle')), hint(details.join('\n'))),
          React.createElement('div', { className: 'slp-cost-amount' }, '≈' + estimateCost(data.session, true)),
          costBreakdownTables(data.session),
          !data.session.breakdown && data.session.pricedMessages ? React.createElement('p', { className: 'slp-panel-note' }, t('costBreakdownPending')) : null,
          React.createElement('p', { className: 'slp-panel-note' }, coverage + (sourceLabels.length ? ' · ' + sourceLabels.join(' + ') : '')),
          data.session.unpricedMessages ? React.createElement('p', { className: 'slp-panel-note slp-cost-reasons', title: costReasons(data.session) }, costReasons(data.session)) : null)
      }
      return React.createElement('span', { className: 'slp-group slp-cost', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { className: 'slp-cost-trigger', type: 'button', 'aria-expanded': dismiss.open,
          title: t('costTitle') + ' · ' + coverage + (data.session.unpricedMessages ? ' · ' + costReasons(data.session) : ''),
          onClick: function () { dismiss.setOpen(function (open) { return !open }) } },
          '≈' + estimateCost(data.session, true)),
        panel)
    }

    function useWrapMarkers(node, enabled) {
      React.useEffect(function () {
        var row = node
        if (!enabled || !row) return undefined
        var mark = function () {
          var top = null
          Array.from(row.children).forEach(function (child) {
            var nextTop = child.offsetTop + child.offsetHeight / 2
            var start = top === null || Math.abs(nextTop - top) > 2 ? 'true' : 'false'
            // Unchanged writes still invalidate style; skip them.
            if (child.getAttribute('data-line-start') !== start) child.setAttribute('data-line-start', start)
            top = nextTop
          })
        }
        var resize = typeof ResizeObserver === 'function' ? new ResizeObserver(mark) : null
        var observe = function () { mark(); if (resize) { resize.disconnect(); resize.observe(row); Array.from(row.children).forEach(function (child) { resize.observe(child) }) } }
        var mutation = typeof MutationObserver === 'function' ? new MutationObserver(observe) : null
        observe()
        if (mutation) mutation.observe(row, { childList: true })
        return function () { if (resize) resize.disconnect(); if (mutation) mutation.disconnect() }
      }, [enabled, node])
    }

    // 上下文压力组：读取 dock 槽位提供的官方投影
    function ContextProjection(props) {
      var pressure = null
      if (typeof props.useProjection === 'function') {
        try { pressure = props.useProjection('contextPressure') } catch (e) { pressure = null }
      }
      var used = pressure && (pressure.projectedTokens !== undefined ? pressure.projectedTokens : pressure.pressureTokens)
      var windowSize = pressure && pressure.contextWindow
      var usedN = Number(used)
      var windowN = Number(windowSize)
      if (!Number.isFinite(usedN) || !Number.isFinite(windowN) || windowN <= 0) return null
      var pct = clampPct(usedN / windowN * 100)
      return React.createElement(ContextRow, { enabled: true, usedTokens: usedN, contextWindow: windowN, pct: pct })
    }

    // Native push, coalesced to at most 40 UI updates/sec; no polling.
    function useLiveTps(sessionId, enabled) {
      var visible = usePageVisible(enabled)
      var pair = React.useState(null), setResult = pair[1]
      var retained = React.useRef(null)
      React.useEffect(function () {
        if (!visible || !sessionId || typeof EventSource !== 'function') return undefined
        var alive = true, timer = null, pending = null, lastPaint = -Infinity
        if (!retained.current || retained.current.sessionId !== sessionId) retained.current = null
        setResult(retained.current)
        function paint() {
          timer = null
          if (!alive || !pending) return
          lastPaint = performance.now()
          var next = pending
          pending = null
          setResult(function (old) {
            if (old && old.sessionId === sessionId && old.phase === next.phase && old.tokensPerSecond === next.tokensPerSecond && old.estimated === next.estimated && old.held === next.held) return old
            return next
          })
        }
        function receive(data) {
          var rate = data.tokensPerSecond
          var valid = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0
          if (valid) data.tokensPerSecond = Math.round(rate)
          var previous = retained.current
          data.held = !valid && !!previous && typeof previous.tokensPerSecond === 'number'
          if (data.held) {
            data.tokensPerSecond = previous.tokensPerSecond
            data.estimated = previous.estimated
          }
          retained.current = data
          pending = data
          var remaining = 25 - (performance.now() - lastPaint)
          if (timer === null) {
            if (remaining <= 0) paint()
            else timer = setTimeout(paint, remaining)
          }
        }
        // Native Agent IDs use session-UUID while UI scope IDs may be bare UUID.
        // Request the native spelling so a page refresh also fixes older hosts;
        // newer hosts normalize both spellings internally.
        var uuid = sessionId.match(/^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
        var requestId = uuid ? 'session-' + uuid[1].toLowerCase() : sessionId
        var source = new EventSource('/statusline/api/tps?sessionId=' + encodeURIComponent(requestId))
        source.onmessage = function (event) {
          if (!alive) return
          try {
            var data = JSON.parse(event.data)
            if (data.sessionId !== requestId) return
            data.sessionId = sessionId
            receive(data)
          } catch (_) { /* a malformed event is not a speed measurement */ }
        }
        source.onerror = function () {
          if (alive) receive({ sessionId: sessionId, phase: 'unavailable', tokensPerSecond: null })
        }
        return function () { alive = false; if (timer !== null) clearTimeout(timer); source.close() }
      }, [visible, sessionId])
      return visible && pair[0] && pair[0].sessionId === sessionId ? pair[0] : null
    }
    function TpsRow(props) {
      var live = useLiveTps(props.sessionId, !props.preview)
      var data = props.preview ? { tokensPerSecond: 302, estimated: false, phase: 'completed' } : live
      var rate = data && data.tokensPerSecond
      var available = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0
      var phase = data && data.phase
      var label = data && data.held ? t('tpsPrevious') : 'TPS'
      var text = available ? label + ' ' + (data.estimated ? '≈' : '') + formatRate(rate) + ' tok/s' : label + ' —'
      var status = phase === 'unavailable' ? t('tpsUnavailable') : phase === 'completed' ? t('tpsCompleted') : phase === 'interrupted' ? t('tpsInterrupted') : !available ? t('tpsWaiting') : ''
      if (data && data.held) status += (status ? ' · ' : '') + t('tpsHeld')
      if (available && !data.held && (phase === 'completed' || phase === 'interrupted')) status += (status ? ' · ' : '') + t('tpsAverage')
      if (available) status += (status ? ' · ' : '') + t(data.estimated ? 'tpsEstimated' : 'tpsMeasured')
      return React.createElement('span', { className: 'slp-tps slp-group' + (!available || data.held ? ' slp-muted' : ''), title: (status ? status + '\n' : '') + t('tpsTitle') }, text)
    }

    // Real row and preview share component construction and order. Preview hooks
    // only read local samples; they never acquire a session or a quota resource.
    function dockComponents(config, props, gitProps) {
      var factories = {
        git: function () { return React.createElement(GitLine, Object.assign({ key: 'git' }, gitProps)) },
        context: function () { return React.createElement(ContextProjection, { key: 'context', useProjection: props.useProjection }) },
        tps: function () { return React.createElement(TpsRow, { key: 'tps', sessionId: props.sessionId, preview: props.preview }) },
        cost: function () { return React.createElement(CostRow, { key: 'cost', useProjection: props.useProjection }) },
        activity: function () { return React.createElement(ActivityRow, { key: 'activity', useProjection: props.useProjection, useSessions: props.useSessions, useSessionStatus: props.useSessionStatus, sessionId: props.sessionId, preview: props.preview }) },
        tools: function () { return React.createElement(ToolActivityRow, { key: 'tools', useProjection: props.useProjection, useSessionStatus: props.useSessionStatus, sessionId: props.sessionId, preview: props.preview }) },
      }
      return componentOrder(config.componentOrder).filter(function (id) { return componentEnabled(config, id) }).map(function (id) { return factories[id]() })
    }
    function LayoutPreview(props) {
      var pair = React.useState(null), width = React.useState('auto')
      useWrapMarkers(pair[0], props.config.enabled !== false)
      var now = Date.now(), sample = {
        contextPressure: { projectedTokens: 127000, contextWindow: 1000000 },
        statuslineMetrics: { session: { pricedMessages: 8, unpricedMessages: 0, amountCny: 0.316,
          breakdown: { input: { amountCny: 0.1, minCny: 0.1, maxCny: 0.1, tokensCny: 12000 }, cache: { amountCny: 0.06, minCny: 0.06, maxCny: 0.06, tokensCny: 124000 }, output: { amountCny: 0.156, minCny: 0.156, maxCny: 0.156, tokensCny: 5600 } } }, pricingAsOf: '2026-10-02T04:24:12Z' },
        subagentCatalog: [{ id: 'sample-worker', label: 'Worker', mode: 'continuable', createdAt: 2 }, { id: 'sample-reviewer', label: 'Reviewer', mode: 'one-shot', createdAt: 1 }],
        statuslineToolActivity: { activeCount: 1, tools: [{ callId: 'sample-call', name: 'read_file', status: 'running', startedAt: now - 12000, endedAt: null }], truncated: false },
      }
      var sampleSessions = { byId: {}, projectionsBySession: {
        'sample-worker': { values: { subagentTiming: { settledMs: 12000 }, modelSelection: { lastUsed: { model: 'deepseek-flash', reasoningEffort: 'high' }, next: null } } },
        'sample-reviewer': { values: { subagentTiming: { settledMs: 8000 } } },
      } }
      var groups = props.config.enabled === false ? [] : dockComponents(props.config, { preview: true,
        useProjection: function (key) { return sample[key] || null },
        useSessions: function (select) { return select(sampleSessions) },
        useSessionStatus: function (select) { return select(new Map([['sample-worker', { running: true }], ['sample-reviewer', { running: false }]])) },
      }, { data: { isRepo: true, branch: 'main', counts: { staged: 0, unstaged: 1, untracked: 0, conflict: 0 } }, path: props.config.showCwd === false ? null : 'project/demo', fullPath: '/sample/project/demo', refresh: function () {} })
      return React.createElement('div', { className: 'slp-layout-block' },
        React.createElement('div', { className: 'slp-subhead' },
          React.createElement('span', { className: 'slp-subhead-title' }, t('layoutPreview'), hint(t('layoutPreviewHint'))),
          React.createElement('span', { className: 'slp-segmented', role: 'group' }, ['auto', '320'].map(function (value) {
            return React.createElement('button', { type: 'button', key: value, className: 'slp-btn slp-btn-sm', 'aria-pressed': width[0] === value,
              onClick: function () { width[1](value) } }, t(value === 'auto' ? 'layoutPreviewAuto' : 'layoutPreviewNarrow'))
          }))),
        React.createElement('div', { className: 'slp-preview', style: width[0] === '320' ? { width: '320px' } : null, role: 'region', 'aria-label': t('layoutPreview') },
          groups.length ? React.createElement('div', { className: 'slp-row', ref: pair[1] }, groups) : React.createElement('span', { className: 'slp-muted' }, t('layoutPreviewEmpty'))))
    }
    function LayoutEditor(props) {
      var order = componentOrder(props.config.componentOrder), preset = matchingPreset(props.config)
      return React.createElement('div', { className: 'slp-layout-editor' },
        React.createElement('div', { className: 'slp-subhead' },
          React.createElement('span', { className: 'slp-subhead-title' }, t('layoutPresets'), hint(t('layoutHint'))),
          React.createElement('span', { className: 'slp-segmented', role: 'group', 'aria-label': t('layoutPresets') }, ['balanced', 'minimal', 'activity'].map(function (id) {
            return React.createElement('button', { type: 'button', key: id, className: 'slp-btn slp-btn-sm', 'aria-pressed': preset === id,
              onClick: function () { props.onChange(layoutPreset(id)) } }, t(id === 'minimal' ? 'layoutMinimal' : id === 'activity' ? 'layoutActivity' : 'layoutBalanced'))
          }), preset === 'custom' ? React.createElement('span', { className: 'slp-preset-custom' }, t('layoutCustom')) : null)),
        // The component list is the most-used control, so it is always visible.
        React.createElement('ol', { className: 'slp-order-list', 'aria-label': t('layoutOrder'),
          onPointerMove: moveOrderDrag,
          onPointerUp: function (event) { finishOrderDrag(event, props.config, props.onChange) },
          onPointerCancel: function (event) { clearOrderDrag(event.currentTarget) },
          onLostPointerCapture: function (event) { clearOrderDrag(event.currentTarget) },
          onKeyDown: function (event) { if (event.key === 'Escape' && event.currentTarget.slpOrderDrag) { event.preventDefault(); event.stopPropagation(); clearOrderDrag(event.currentTarget) } },
        }, order.map(function (id, index) {
          var name = t(COMPONENTS[id].label)
          function move(delta) { var next = order.slice(), other = index + delta; if (other < 0 || other >= next.length) return; next[index] = next[other]; next[other] = id; props.onChange({ componentOrder: next }) }
          return React.createElement('li', { className: 'slp-order-item', key: id, 'data-component': id },
            React.createElement('button', { type: 'button', className: 'slp-drag-handle', 'aria-label': tf('layoutDrag', { name: name }), title: t('layoutDragHint'),
              onPointerDown: function (event) { startOrderDrag(event, id) },
              onKeyDown: function (event) { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); clearOrderDrag(event.currentTarget.closest('.slp-order-list')); move(event.key === 'ArrowUp' ? -1 : 1) } },
            }, '⋮⋮'),
            React.createElement('label', { className: 'slp-check' },
              React.createElement('input', { type: 'checkbox', name: COMPONENTS[id].field, checked: componentEnabled(props.config, id), 'aria-label': name,
                onChange: function (event) { var patch = {}; patch[COMPONENTS[id].field] = event.target.checked; props.onChange(patch) } }),
              React.createElement('span', { className: 'slp-check-text' }, name)),
            id === 'context' ? hint(t('setNativeContextHint')) : null,
            React.createElement('span', { className: 'slp-order-actions' },
              React.createElement('button', { type: 'button', className: 'slp-btn slp-btn-icon', 'aria-label': tf('layoutUp', { name: name }), disabled: index === 0, onClick: function () { move(-1) } }, '↑'),
              React.createElement('button', { type: 'button', className: 'slp-btn slp-btn-icon', 'aria-label': tf('layoutDown', { name: name }), disabled: index === order.length - 1, onClick: function () { move(1) } }, '↓')))
        })),
        React.createElement(LayoutPreview, { config: props.config }))
    }

    // ---------------- 主面板（composer.dock 多行） ----------------
    function StatusPanel(props) {
      var config = useConfigSnapshot()
      var rowNode = React.useState(null)
      useWrapMarkers(rowNode[0], !!(config && config.enabled))
      var [gitState, setGitState] = React.useState({ busy: false, data: null, error: null })
      // git 刷新状态引用：避免定时器/step 回调捕获过期闭包
      var gitCwdRef = React.useRef(null)
      var gitInflightRef = React.useRef(null) // 在途请求对应的 session/cwd/request
      var gitLastRef = React.useRef(null)
      var gitTimerRef = React.useRef(null)
      var stepSessionRef = React.useRef(null)
      var stepBaselineRef = React.useRef(null)

      // Subscribe to the official global workspace hook so workspace changes
      // invalidate the resolved path and trigger the Git effect again.
      var wsSnapshot = null
      if (typeof props.useWorkspaces === 'function') {
        try { wsSnapshot = props.useWorkspaces(function (x) { return x }) } catch (e) { wsSnapshot = null }
      }

      // 解析当前会话工作区路径：配置显式指定 > 会话摘要 > workspace 兜底。
      var sessionCwdFromList = null
      if (typeof props.useSessions === 'function' && props.sessionId) {
        try {
          sessionCwdFromList = props.useSessions(function (x) {
            var summary = x && x.byId ? x.byId[props.sessionId] : null
            return summary && summary.cwd ? summary.cwd : null
          })
        } catch (e) { sessionCwdFromList = null }
      }
      var sessionCwd = null
      if (config && config.gitCwd) sessionCwd = config.gitCwd
      if (!sessionCwd && sessionCwdFromList) sessionCwd = sessionCwdFromList
      var resolvedCwd = sessionCwd
      if (!resolvedCwd && props.workspacePathOf) resolvedCwd = props.workspacePathOf(props.sessionId, wsSnapshot)
      // Keep the ref in sync only after the current render has resolved the
      // workspace. The old ordering wrote the previous render's value here,
      // so the initial Git request was silently skipped.
      gitCwdRef.current = resolvedCwd || null

      var refreshGitRef = React.useRef(null)
      var pageVisible = usePageVisible(!!(config && config.enabled && config.showGit))
      var refreshGit = function (force, trailing) {
        var cwd = gitCwdRef.current
        var sessionId = props.sessionId || null
        if (!cwd || !pageVisible || !config || !config.enabled || !config.showGit) return
        var key = sessionId + '\0' + cwd
        var previous = gitInflightRef.current
        if (previous && previous.key === key) {
          if (trailing) previous.pending = true
          if (force) previous.pendingForce = true
          return
        }
        if (force && gitTimerRef.current !== null) { clearTimeout(gitTimerRef.current); gitTimerRef.current = null }
        var last = gitLastRef.current, remaining = last && last.key === key ? 1000 - (Date.now() - last.at) : 0
        if (!force && remaining > 0) {
          if (gitTimerRef.current === null) gitTimerRef.current = setTimeout(function () {
            gitTimerRef.current = null
            refreshGitRef.current(false, true)
          }, remaining)
          return
        }
        if (previous) previous.controller.abort()
        var request = { key: key, controller: new AbortController(), pending: false }
        gitInflightRef.current = request
        setGitState(function (old) {
          return { busy: true, data: old && old.cwd === cwd && old.sessionId === sessionId ? old.data : null, error: null, cwd: cwd, sessionId: sessionId }
        })
        apiGit(cwd, sessionId, request.controller.signal, force).then(function (result) {
          if (gitInflightRef.current !== request) return
          setGitState(function (old) {
            var retained = old && old.cwd === cwd && old.sessionId === sessionId ? old.data : null
            return { busy: false, data: result.ok ? result.data : retained,
              stale: !result.ok && !!retained, error: result.ok ? null : result.error, cwd: cwd, sessionId: sessionId }
          })
        }).finally(function () {
          if (gitInflightRef.current !== request) return
          gitInflightRef.current = null
          gitLastRef.current = { key: key, at: Date.now() }
          if (request.pendingForce) refreshGitRef.current(true)
          else if (request.pending) refreshGitRef.current(false, true)
        })
      }
      refreshGitRef.current = refreshGit
      // 首次挂载 / 工作区或会话变化：立即拉取
      React.useEffect(function () {
        if (!config || config.enabled === false || !config.showGit || !resolvedCwd || !pageVisible) {
          setGitState({ busy: false, data: null, error: t('gitNoWorkspace') })
          return undefined
        }
        refreshGit()
        return function () {
          if (gitInflightRef.current) gitInflightRef.current.controller.abort()
          gitInflightRef.current = null
          if (gitTimerRef.current !== null) clearTimeout(gitTimerRef.current)
          gitTimerRef.current = null
          gitLastRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [config && config.enabled, config && config.showGit, props.sessionId, resolvedCwd, pageVisible])

      // 切回标签页 / 窗口重新获得焦点时立即补一次刷新（切走期间工作区可能已变化）
      React.useEffect(function () {
        if (!config || config.enabled === false || !config.showGit) return undefined
        var onVis = function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') refreshGit()
        }
        var onFocus = function () { refreshGit() }
        document.addEventListener('visibilitychange', onVis)
        window.addEventListener('focus', onFocus)
        return function () {
          document.removeEventListener('visibilitychange', onVis)
          window.removeEventListener('focus', onFocus)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [config && config.enabled, config && config.showGit, props.sessionId, resolvedCwd, pageVisible])

      // 会话 step 结束（sessionStats.steps 投影在 step/end 时 +1）时刷新：
      // agent 的 bash 操作常改动工作区，step 后立即补一次让 git 信息保持及时
      var stepStats = props.useProjection ? props.useProjection('sessionStats') : null
      var stepCount = stepStats && typeof stepStats.steps === 'number' ? stepStats.steps : null
      React.useEffect(function () {
        if (!config || config.enabled === false || !config.showGit || !resolvedCwd || !pageVisible) return undefined
        if (stepCount === null) return undefined
        var newSession = stepSessionRef.current !== props.sessionId
        stepSessionRef.current = props.sessionId
        if (newSession) {
          // 新会话（含挂载）：重建基线；立即补一次刷新，覆盖会话切换后 steps 未归零的情况
          // （与挂载拉取的重复请求由 gitInflightRef 合并，不会发两个）
          stepBaselineRef.current = stepCount
          refreshGit()
          return undefined
        }
        if (stepCount <= stepBaselineRef.current) return undefined
        stepBaselineRef.current = stepCount
        refreshGit(false, true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [config && config.enabled, config && config.showGit, stepCount, resolvedCwd, props.sessionId, pageVisible])

      if (!config || config.enabled === false) return null
      // 所有启用的信息组放进同一个 flex 行：放得下就一行，
      // 放不下时 flex-wrap 把整组依次换到下一行，不硬性拆分多行。
      var currentGit = gitState.cwd === resolvedCwd && gitState.sessionId === (props.sessionId || null) ? gitState : {}
      var cwdShown = currentGit.data && currentGit.data.repoRoot || sessionCwd || resolvedCwd
      // SSH repos: label by host + remote path, not the local anchor directory name
      var remoteRepo = currentGit.data && currentGit.data.remote
      var pathShown = remoteRepo ? remoteRepo.host + ':' + formatPathSegs(remoteRepo.root, 2) : cwdShown && formatPathSegs(cwdShown, 2)
      var pathFull = remoteRepo ? remoteRepo.host + ':' + remoteRepo.root : cwdShown
      var groups = dockComponents(config, props, {
          data: currentGit.data,
          busy: currentGit.busy,
          stale: currentGit.stale,
          refresh: function () { refreshGit(true) },
          path: config.showCwd && pathShown ? pathShown : null,
          fullPath: pathFull,
      })
      if (groups.length === 0) return null
      return React.createElement('div', { className: 'slp-root' },
        React.createElement('div', { className: 'slp-row', ref: rowNode[1], key: 'r-main' }, groups)
      )
    }

    // ---------------- 头部 chip（session.header.actions） ----------------
    function HeaderChip(props) {
      var config = useConfigSnapshot()
      var anyEnabled = !!(config && config.enabled && (config.showQuota || config.showDeepseekPeak !== false))
      var visible = usePageVisible(anyEnabled)
      var stats = props.useProjection ? props.useProjection('sessionStats') : null
      var count = stats && typeof stats.steps === 'number' ? stats.steps : null
      var running = typeof props.useSessionStatus === 'function' ? props.useSessionStatus(function (statuses) {
        var status = statuses && typeof statuses.get === 'function' && (statuses.get(props.sessionId) || statuses.get('session-' + props.sessionId))
        return !!(status && status.running === true)
      }) : false
      // The native selection is the model the next request will use, known
      // before any request exists; the log lookup is only a fallback.
      var selection = props.useProjection ? props.useProjection('modelSelection') : null
      var selected = selection && (selection.next || selection.lastUsed)
      selected = selected && selected.provider ? { provider: selected.provider, model: selected.model } : null
      // Rises when a turn starts as well as when a step ends, so a new
      // session resolves its quota as the first step begins.
      var activity = (count || 0) * 2 + (running ? 1 : 0)
      var enabled = !!(anyEnabled && visible)
      var modelState = useSessionModel(props.sessionId, activity, enabled && !selected && (config.quotaAuto !== false || config.showDeepseekPeak !== false))
      if (!enabled) return null
      var resource = null
      var model = selected || modelState.model
      if (selected) modelState = { status: 'resolved', model: selected }
      var onStep = quotaRefreshOnStep(config)
      if (config.showQuota && config.showOpenCodeQuota !== false && config.quotaAuto === false) resource = { kind: 'opencode', key: 'opencode', onStep: onStep, cacheOnStep: true }
      else if (config.showQuota && config.quotaAuto !== false && modelState.status === 'resolved' && model) {
        var match = (config.providers || []).find(function (p) { return p.enabled !== false && providerMatchesModel(p, model) })
        if (match) resource = { kind: 'provider', id: match.id, provider: match, key: 'provider:' + match.id,
          onStep: onStep,
          cacheOnStep: true }
        else if (isCodexModel(model) && config.showCodexQuota) resource = { kind: 'codex', key: 'codex', onStep: onStep, cacheOnStep: true }
        else if (isAntigravityModel(model) && config.showAntigravityQuota) resource = { kind: 'antigravity', key: 'antigravity', onStep: onStep, cacheOnStep: true }
        else if (config.showOpenCodeQuota !== false && /opencode/i.test(String(model.provider || ''))) resource = { kind: 'opencode', key: 'opencode', onStep: onStep, cacheOnStep: true }
      }
      var quotaChip = null
      if (resource) {
        resource.key += ':' + (props.sessionId || '')
        quotaChip = React.createElement(QuotaChip, { resource: resource, config: config, stepCount: activity })
      }
      // No matching source (or model still resolving): show nothing rather than a placeholder.
      if (config.showDeepseekPeak !== false && isDeepseekBilling(model)) return React.createElement('span', { className: 'slp-header-group' },
        quotaChip, React.createElement(DeepseekPeakChip, { countdown: config.deepseekPeakCountdown !== false }))
      return quotaChip
    }
    function QuotaChip(props) {
      var quota = useQuotaResource(props.resource, props.config, props.stepCount)
      var now = useQuotaClock(!!quota.data)
      var kind = props.resource.kind
      var component = kind === 'codex' ? CodexQuotaLine : kind === 'antigravity' ? AntigravityQuotaLine : kind === 'provider' ? ProviderQuotaLine : OpenCodeQuotaLine
      return React.createElement('span', { className: 'slp-quota-with-age' },
        React.createElement(component, { provider: props.resource.provider, data: quota.data, error: quota.error, staleError: quota.staleError,
          ttlMs: Math.max(15000, props.config.cacheTtlMs || 60000), now: now, refresh: quota.refresh,
          mode: props.config.quotaPercentMode === 'left' ? 'left' : 'used' }))
    }

    // ---------------- 设置页（settings.section） ----------------
    var CRED_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
    // Reset clears preferences only. Credential references, account files, the
    // repository override and source cards stay, so quotas keep working.
    var RESET_KEYS = ['enabled', 'intervalSec', 'cacheTtlMs', 'fetchTimeoutMs', 'showQuota', 'quotaAuto', 'quotaOnStep', 'quotaPercentMode',
      'codexQuotaOnTurn', 'antigravityQuotaOnTurn', 'showDeepseekPeak', 'deepseekPeakCountdown', 'showPeakDot',
      'showGit', 'showCwd', 'showContext', 'showTps', 'showCost', 'showActivity', 'showTools', 'componentOrder']
    // Unset (not set): the Host schema supplies defaults, so none are duplicated here.
    function apiResetConfig(keys) {
      if (!settingsScope || settingsScope.getSnapshot().mode !== 'host' || !settingsScope.getSnapshot().writable) {
        return Promise.resolve({ ok: false, error: 'Settings are not writable on this connection.' })
      }
      return settingsScope.mutate(keys.map(function (key) { return { op: 'unset', path: [key] } })).then(function () {
        return { ok: true, config: settingsScope.getSnapshot().value }
      }).catch(function (error) { return { ok: false, error: String(error.message || error) } })
    }
    // ⓘ hint: long explanations live in a hover/focus tooltip instead of paragraphs.
    function hint(text) {
      return React.createElement('span', { className: 'slp-hint', tabIndex: 0, role: 'img', 'aria-label': text, 'data-tip': text,
        onClick: function (event) { event.preventDefault(); event.stopPropagation() } }, 'ⓘ')
    }
    // Committed seconds for a number field, or null to restore the shown value.
    function parseSeconds(raw, min, max) {
      var text = String(raw === undefined || raw === null ? '' : raw).trim()
      if (!text) return null
      var n = Number(text)
      if (!Number.isFinite(n)) return null
      return Math.min(max, Math.max(min, Math.round(n)))
    }
    function SettingsPage() {
      var config = useConfigSnapshot()
      var [form, setForm] = React.useState(null)
      var [msg, setMsg] = React.useState(null)
      var [saveState, setSaveState] = React.useState({ kind: 'idle' })
      var [sourceOpen, setSourceOpen] = React.useState({})
      var [resetArmed, setResetArmed] = React.useState(false)
      var resetTimer = React.useRef(null)
      var saveTimer = React.useRef(null)
      var formRef = React.useRef(null)
      var savingRef = React.useRef(null)
      var dirtyPatch = React.useRef({})
      var alive = React.useRef(true)
      var testController = React.useRef(null)
      React.useEffect(function () {
        if (config) {
          var next = Object.assign({}, config, dirtyPatch.current)
          formRef.current = next
          setForm(next)
        }
      }, [config])
      React.useEffect(function () {
        alive.current = true
        return function () {
          alive.current = false
          if (testController.current) testController.current.abort()
          if (saveTimer.current) clearTimeout(saveTimer.current)
          if (resetTimer.current) clearTimeout(resetTimer.current)
          doSave()
        }
      }, [])
      function doSave() {
        if (savingRef.current) return savingRef.current
        var snapshot = Object.assign({}, dirtyPatch.current)
        if (!Object.keys(snapshot).length) return Promise.resolve({ ok: true, config: configSnapshot })
        if (alive.current) setSaveState({ kind: 'saving' })
        savingRef.current = apiSetConfig(snapshot).then(function (result) {
          savingRef.current = null
          if (result.ok) {
            Object.keys(snapshot).forEach(function (key) {
              if (dirtyPatch.current[key] === snapshot[key]) delete dirtyPatch.current[key]
            })
            if (alive.current) setSaveState({ kind: 'ok', at: new Date().toLocaleTimeString() })
            if (Object.keys(dirtyPatch.current).length) return doSave()
          } else if (alive.current) setSaveState({ kind: 'err', error: result.error || 'network' })
          return result
        })
        return savingRef.current
      }
      var up = function (patch) {
        Object.assign(dirtyPatch.current, patch)
        formRef.current = Object.assign({}, formRef.current, patch)
        setForm(formRef.current)
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(function () { saveTimer.current = null; doSave() }, 700)
      }
      if (form === null) return React.createElement('div', { className: 'slp-set' }, t('setLoading'))
      // Two-step reset: the first click arms the button for 4 s.
      var reset = function () {
        if (resetTimer.current) clearTimeout(resetTimer.current)
        if (!resetArmed) {
          setResetArmed(true)
          resetTimer.current = setTimeout(function () { resetTimer.current = null; setResetArmed(false) }, 4000)
          return
        }
        resetTimer.current = null
        setResetArmed(false)
        // Drop pending edits to reset keys so a debounced save cannot restore them.
        RESET_KEYS.forEach(function (key) { delete dirtyPatch.current[key] })
        setSaveState({ kind: 'saving' })
        Promise.resolve(savingRef.current).then(function () { return apiResetConfig(RESET_KEYS) }).then(function (result) {
          if (!alive.current) return
          if (!result.ok) { setSaveState({ kind: 'err', error: result.error }); return }
          var next = Object.assign({}, formRef.current)
          RESET_KEYS.forEach(function (key) {
            if (result.config && Object.prototype.hasOwnProperty.call(result.config, key)) next[key] = result.config[key]
            else delete next[key]
          })
          formRef.current = next
          setForm(next)
          setSaveState({ kind: 'reset', at: new Date().toLocaleTimeString() })
        })
      }
      var percentMode = form.quotaPercentMode === 'left' ? 'left' : 'used'
      var test = function () {
        setMsg(null)
        // 先保存表单，再用保存后的配置测试，避免"先填值直接测试→报未配置"的假象
        doSave().then(function (r) {
          if (!alive.current) return
          if (!r.ok) {
            setMsg({ kind: 'err', text: (r.error || t('saveFail')) + t('needSaveFirst') })
            return
          }
          setForm(r.config)
          if (testController.current) testController.current.abort()
          var controller = new AbortController()
          testController.current = controller
          apiUsage(true, controller.signal).then(function (r2) {
            if (!alive.current || testController.current !== controller) return
            var w = r2.ok && r2.data && r2.data.windows
            if (!w) { setMsg({ kind: 'err', text: (r2.ok ? '' : r2.error) || t('testFail') }); return }
            var pct = function (x) { return x ? Math.round(Number(x.percent !== undefined ? x.percent : x.usagePercent)) || 0 : '—' }
            setMsg({ kind: 'ok', text: tf('testOk', { r: pct(w.rolling), w: pct(w.weekly), m: pct(w.monthly) }) })
          })
        })
      }
      function check(key, labelKey, fallback, hintText) {
        var box = React.createElement('label', { className: 'slp-check', key: key },
          React.createElement('input', { type: 'checkbox', name: key,
            checked: form[key] === undefined ? fallback : !!form[key],
            onChange: function (event) { var patch = {}; patch[key] = event.target.checked; up(patch) } }),
          React.createElement('span', { className: 'slp-check-text' }, t(labelKey)))
        return hintText ? React.createElement('span', { className: 'slp-check-row', key: key }, box, hint(hintText)) : box
      }
      function field(key, labelKey, options) {
        return React.createElement('label', { className: 'slp-field', key: key }, t(labelKey),
          React.createElement('input', Object.assign({ className: 'slp-input', type: 'text' }, options || {}, {
            name: key, value: form[key] === undefined || form[key] === null ? '' : String(form[key]),
            onChange: function (event) { var patch = {}; patch[key] = event.target.value; up(patch) } })))
      }
      // Seconds fields commit on blur/Enter. Saving per keystroke clamped
      // partial input (typing "30" became "15", then "150").
      function secondsField(key, labelKey, min, max, fallbackMs, hintText) {
        var stored = typeof form[key] === 'number' ? form[key] : fallbackMs
        var shown = Math.min(max, Math.max(min, Math.round(stored / 1000)))
        function commit(event) {
          var seconds = parseSeconds(event.target.value, min, max)
          event.target.value = String(seconds === null ? shown : seconds)
          if (seconds !== null && seconds * 1000 !== stored) { var patch = {}; patch[key] = seconds * 1000; up(patch) }
        }
        return React.createElement('label', { className: 'slp-field', key: key },
          React.createElement('span', { className: 'slp-field-label' }, t(labelKey), hintText ? hint(hintText) : null),
          React.createElement('input', { className: 'slp-input slp-input-num', type: 'number', name: key, min: min, max: max, step: 1,
            inputMode: 'numeric', key: key + ':' + shown, defaultValue: String(shown), onBlur: commit,
            onKeyDown: function (event) { if (event.key === 'Enter') event.currentTarget.blur() } }))
      }
      // Credential references are names, never keys: invalid input is refused
      // with a visible reason instead of a silently ignored keystroke.
      function credentialField(name, value, placeholder, save) {
        return React.createElement('label', { className: 'slp-field', key: name },
          React.createElement('span', { className: 'slp-field-label' }, t('setProviderCredential'), hint(t('setProviderHint'))),
          React.createElement('input', {
            className: 'slp-input slp-input-cred', type: 'text', autoComplete: 'off', spellCheck: false, pattern: '[A-Za-z_][A-Za-z0-9_]*',
            name: name, value: value || '', placeholder: placeholder,
            onChange: function (event) {
              var next = event.target.value, valid = !next || CRED_NAME_RE.test(next)
              if (typeof event.target.setCustomValidity === 'function') {
                event.target.setCustomValidity(valid ? '' : t('setCredInvalid'))
                if (!valid) event.target.reportValidity()
              }
              if (valid) save(next)
            } }))
      }
      function section(labelKey, children, hintText) {
        return React.createElement('section', { className: 'slp-settings-group', 'aria-label': t(labelKey), key: labelKey },
          React.createElement('h2', { className: 'slp-settings-heading' }, t(labelKey), hintText ? hint(hintText) : null), children)
      }
      function sourceState(enabled) {
        return React.createElement('span', { className: 'slp-provider-state' + (enabled === false ? '' : ' slp-source-enabled') }, ' · ' + t(enabled === false ? 'setSourceDisabled' : 'setSourceEnabled'))
      }
      function account(id, name, children, enabled, onChange) {
        var isEnabled = enabled !== false
        return React.createElement('details', { className: 'slp-provider-card', key: id, 'data-source': id,
          open: sourceOpen[id] === true,
          onToggle: function (event) {
            var open = event.currentTarget.open
            setSourceOpen(function (previous) {
              if (previous[id] === open) return previous
              var next = Object.assign({}, previous); next[id] = open; return next
            })
          } },
          React.createElement('summary', { className: 'slp-source-heading' },
            React.createElement('span', { className: 'slp-source-title' }, name, sourceState(enabled)),
            React.createElement('label', { className: 'slp-source-switch',
              onClick: function (event) { event.stopPropagation() } },
              React.createElement('input', { type: 'checkbox', role: 'switch', name: 'source:' + id,
                checked: isEnabled, 'aria-label': name,
                onChange: function (event) {
                  var checked = event.target.checked
                  if (checked) setSourceOpen(function (previous) {
                    var next = Object.assign({}, previous); next[id] = true; return next
                  })
                  onChange(checked)
                } }),
              React.createElement('span', { className: 'slp-switch-track', 'aria-hidden': true }))),
          React.createElement('fieldset', { className: 'slp-source-fields slp-settings-body', disabled: !isEnabled }, children))
      }
      function branch(parent, children, disabled) {
        return React.createElement('div', { className: 'slp-setting-branch' }, parent,
          React.createElement('fieldset', { className: 'slp-dependent slp-setting-children', disabled: !!disabled }, children))
      }
      var providerCards = (Array.isArray(form.providers) ? form.providers : []).map(function (p, idx) {
        function patchProvider(patch) {
          var next = (form.providers || []).slice()
          next[idx] = Object.assign({}, p, patch)
          up({ providers: next })
        }
        return account(p.id || String(idx), p.label || p.id, [
          React.createElement('p', { className: 'slp-set-desc', key: 'kind' }, t(p.style === 'windows' ? 'setSubscriptionSource' : 'setBalanceSource')),
          credentialField('cred:' + (p.id || idx), p.apiKeyEnv,
            ({ deepseek: 'DEEPSEEK_API_KEY', 'kimi-code': 'KIMI_API_KEY', zai: 'ZAI_API_KEY', zhipu: 'ZAI_CODING_CN_API_KEY', openrouter: 'OPENROUTER_API_KEY' })[p.id] || 'API_KEY_REFERENCE',
            function (value) { patchProvider({ apiKeyEnv: value }) }),
          (p.style || 'balance') === 'balance' ? React.createElement('label', { className: 'slp-field', key: 'red' },
            t('setProviderRedBelow'),
            React.createElement('input', {
              className: 'slp-input slp-input-num', type: 'number', min: 0, step: 'any',
              value: p.redBelow === undefined || p.redBelow === null ? '' : String(p.redBelow),
              placeholder: t('setProviderRedBelowPh'),
              onChange: function (e) {
                var raw = e.target.value
                var next = (form.providers || []).slice()
                next[idx] = Object.assign({}, p)
                if (raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) delete next[idx].redBelow
                else next[idx].redBelow = Number(raw)
                up({ providers: next })
              },
            })) : null,
        ], p.enabled, function (checked) { patchProvider({ enabled: checked }) })
      })
      var saveText = saveState.kind === 'saving' ? t('setAutoSaving')
        : saveState.kind === 'ok' ? tf('setAutoSavedAt', { time: saveState.at })
          : saveState.kind === 'reset' ? tf('setResetDone', { time: saveState.at })
            : saveState.kind === 'err' ? t('setAutoSaveFail') : t('setAutoSaveHint')
      return React.createElement('div', { className: 'slp-set' },
        React.createElement('div', { className: 'slp-set-head' },
          React.createElement('p', { className: 'slp-set-title' }, t('setTitle')),
          React.createElement('span', { className: 'slp-set-actions' },
            React.createElement('span', { className: 'slp-save-state' + (saveState.kind === 'err' ? ' slp-err' : ''), role: 'status', title: saveState.error || undefined }, saveText),
            React.createElement('button', { type: 'button', name: 'reset', className: 'slp-btn slp-btn-sm' + (resetArmed ? ' slp-btn-danger' : ''),
              title: t('setResetHint'), onClick: reset }, t(resetArmed ? 'setResetConfirm' : 'setReset')))),
        React.createElement('p', { className: 'slp-set-desc' }, t('setDesc')),
        React.createElement('div', { className: 'slp-master' }, check('enabled', 'setEnabled', true, t('setEnabledHint'))),
        React.createElement('fieldset', { className: 'slp-dependent', disabled: form.enabled === false },
          section('setGroupDisplay', React.createElement(LayoutEditor, { config: form, onChange: up })),
          section('setGroupHeader', React.createElement('div', { className: 'slp-settings-grid' },
            branch(check('showQuota', 'setShowQuota', true), [
              check('quotaAuto', 'setQuotaAuto', true, t('setQuotaAutoHint')),
              React.createElement('span', { className: 'slp-check-row', key: 'step-refresh' },
                React.createElement('label', { className: 'slp-check' },
                  React.createElement('input', { type: 'checkbox', name: 'quotaOnStep', checked: quotaRefreshOnStep(form),
                    onChange: function (event) { up({ quotaOnStep: event.target.checked }) } }),
                  React.createElement('span', { className: 'slp-check-text' }, t('setQuotaOnStep'))),
                hint(t('setQuotaOnStepHint'))),
              React.createElement('span', { className: 'slp-check-row', key: 'percent-mode' },
                React.createElement('span', { className: 'slp-check-text' }, t('setPercentMode')),
                React.createElement('span', { className: 'slp-segmented slp-inline-seg', role: 'group', 'aria-label': t('setPercentMode') }, ['used', 'left'].map(function (mode) {
                  return React.createElement('button', { type: 'button', key: mode, className: 'slp-btn slp-btn-sm', 'data-mode': mode, 'aria-pressed': percentMode === mode,
                    onClick: function () { if (percentMode !== mode) up({ quotaPercentMode: mode }) } }, t(mode === 'left' ? 'quotaModeLeft' : 'quotaModeUsed'))
                })),
                hint(t('setPercentModeHint')))], form.showQuota === false),
            React.createElement('div', { className: 'slp-setting-branch', key: 'peak' },
              check('showPeakDot', 'setShowPeakDot', true),
              branch(check('showDeepseekPeak', 'setShowDeepseekPeak', true),
                check('deepseekPeakCountdown', 'setPeakCountdown', true), form.showDeepseekPeak === false)))),
          section('setGroupWorkspace', React.createElement('fieldset', { className: 'slp-dependent', disabled: form.showGit === false }, [
            check('showCwd', 'setShowCwd', true),
            field('gitCwd', 'setGitCwd', { placeholder: t('setGitCwdPh') })])),
          section('setGroupSources', React.createElement('fieldset', { className: 'slp-dependent slp-source-list', disabled: form.showQuota === false }, [
            providerCards,
            account('codex', 'Codex', [
              field('codexAccount', 'setCodexAccount', { placeholder: 'codex-account.json', title: t('setCodexAccountHint') })], form.showCodexQuota, function (checked) { up({ showCodexQuota: checked }) }),
            account('antigravity', 'Antigravity', [
              field('antigravityAccount', 'setAntigravityAccount', { placeholder: t('setAntigravityAccountHint') })], form.showAntigravityQuota, function (checked) { up({ showAntigravityQuota: checked }) }),
            account('opencode', 'OpenCode', [
              credentialField('apiKeyEnv', form.apiKeyEnv, t('setApiKeyEnvPh'), function (value) { up({ apiKeyEnv: value }) }),
              field('usageUrl', 'setUsageUrl', { placeholder: t('setUsageUrlPh') }),
              React.createElement('div', { className: 'slp-btns', key: 'test' },
                React.createElement('button', { type: 'button', className: 'slp-btn', onClick: test }, t('setOpenCodeTest')),
                msg ? React.createElement('span', { className: 'slp-msg ' + (msg.kind === 'ok' ? 'slp-ok' : 'slp-err'), role: 'status' }, msg.text) : null)],
            form.showOpenCodeQuota, function (checked) { up({ showOpenCodeQuota: checked }) })]),
            t('setSourceStateHint')),
          React.createElement('details', { className: 'slp-settings-group slp-settings-fold' },
            React.createElement('summary', null, t('setGroupAdvanced')),
            React.createElement('div', { className: 'slp-settings-body slp-settings-grid' },
              secondsField('cacheTtlMs', 'setCacheTtl', 15, 3600, 60000, t('setCacheTtlHint')),
              secondsField('fetchTimeoutMs', 'setFetchTimeout', 1, 60, 10000)))))
    }

    function apply(ctx) {
      CTX = ctx
      settingsScope = ctx.configForms.get('statusline-plus')
      var updateConfig = function () { publishConfig(settingsScope.getSnapshot().value || null) }
      ctx.effect(function () {
        updateConfig()
        return settingsScope.subscribe(updateConfig)
      })
      var slots = ctx.get('slots')
      // Workspace path resolution is driven by the official useWorkspaces hook.
      var workspacePathOf = function (sessionId, snapshot) {
        if (!snapshot || !snapshot.items) return null
        var items = snapshot.items
        for (var i = 0; i < items.length; i++) {
          var w = items[i]
          if (w && w.sessionIds && sessionId && w.sessionIds.indexOf(sessionId) !== -1) return w.path || null
        }
        return null
      }

      var styleTag = document.createElement('style')
      styleTag.setAttribute('data-plugin', 'dsh-statusline-plus')
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)

      if (slots !== undefined) {
        // 输入框下方：紧凑单行优先，按组自然换行
        slots.inject('conversation.composer.dock', function () {
          return slots.register(
            { name: 'conversation.composer.dock', id: 'statusline-plus', order: 10, label: 'StatusLine' },
            function (props) {
              // rc.6 的 composer.dock 插槽传 {session, input}（zone），sessionId 要从 session 对象取
              var sid = props.sessionId
              if (!sid && props.session) sid = props.session.sessionId || props.session.id
              return React.createElement(StatusPanel, {
                sessionId: sid,
                useSessions: typeof props.useSessions === 'function' ? props.useSessions : null,
                useWorkspaces: typeof props.useWorkspaces === 'function' ? props.useWorkspaces : null,
                useProjection: typeof props.useProjection === 'function' ? props.useProjection : null,
                useSessionStatus: typeof props.useSessionStatus === 'function' ? props.useSessionStatus : null,
                workspacePathOf: workspacePathOf,
              })
            }
          )
        })
        // 会话头部标题行：紧凑额度 chip（session 作用域槽位注入 sessionId，用于按模型自动切换）
        slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            { name: 'conversation.session.header.actions', id: 'statusline-plus-chip', order: 30, label: 'Quota' },
            function (props) {
              return React.createElement(HeaderChip, {
                sessionId: props && props.sessionId,
                useProjection: props && typeof props.useProjection === 'function' ? props.useProjection : null,
                useSessionStatus: props && typeof props.useSessionStatus === 'function' ? props.useSessionStatus : null,
              })
            }
          )
        })
        // 侧栏左下角：峰/平峰指示点（无需打开会话）
        slots.inject('sidebar.footer.action', function () {
          return slots.register(
            { name: 'sidebar.footer.action', id: 'statusline-plus-peak', order: 1000, label: 'Peak' },
            function () { return React.createElement(PeakFooterDot, null) }
          )
        })
        // 设置页
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'statusline-plus', order: 30, label: 'StatusLine' },
            function () { return React.createElement(SettingsPage, null) }
          )
        })
      } else {
        // 无 inject 声明时 slots 服务可能尚未就绪（ctx.get 返回 undefined 不抛错）——
        // 整个状态行会静默不注册。检查 package.json 的 dsh.client.inject。
        console.warn('[statusline-plus] slots service unavailable at apply time; check dsh.client.inject in package.json')
      }

      ctx.effect(function () {
        return function () {
          if (styleTag.parentNode) styleTag.parentNode.removeChild(styleTag)
        }
      })
    }

    module.exports = { name: 'dsh-statusline-plus', inject: ['slots', 'configForms'], apply: apply }
    return module.exports
  },
})
