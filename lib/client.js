window.__ModuleLoader__.load({
  id: 'dsh-statusline-plus',
  factory: function (require) {
    var module = { exports: {} }
    var React = require('react')
    var ReactDOM = require('react-dom')
    var Primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var COMPONENT_ORDER = ['git', 'context', 'tps', 'cost', 'activity', 'tools']
    var COMPONENTS = {
      git: { field: 'showGit', label: 'layoutGit', fallback: true },
      context: { field: 'showContext', label: 'layoutContext', fallback: true },
      tps: { field: 'showTps', label: 'layoutTps', fallback: true },
      cost: { field: 'showCost', label: 'layoutCost', fallback: true },
      activity: { field: 'showActivity', label: 'layoutActivityLabel', fallback: true },
      tools: { field: 'showTools', label: 'layoutTools', fallback: false },
    }
    // Other plugins add bottom-row components by registering into DOCK_ITEM_SLOT
    // under a namespaced id ("plugin.item"); registering a built-in id replaces
    // that built-in. lib/config.js validates the same ids on the Host.
    var DOCK_ITEM_SLOT = 'statusline-plus.dock.item'
    var EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9._-]{0,31}$/i
    function isExtensionId(id) { return typeof id === 'string' && EXTENSION_ID_RE.test(id) }
    // A saved order keeps an extension's id while it is not loaded, so its
    // place survives a restart; built-ins missing from it are appended.
    function componentOrder(value) {
      var picked = Array.isArray(value) ? value.slice(0, 48).filter(function (id, i, all) { return (COMPONENT_ORDER.indexOf(id) !== -1 || isExtensionId(id)) && all.indexOf(id) === i }) : []
      return picked.concat(COMPONENT_ORDER.filter(function (id) { return picked.indexOf(id) === -1 }))
    }
    // The order to show: the saved one plus loaded extensions it has not seen yet,
    // at the end. When that would pass the 48-id cap, ids of extensions that are
    // not loaded give way, last saved first, so every shown item stays movable.
    function layoutOrder(value, extensions) {
      var order = componentOrder(value), loaded = (extensions || []).map(function (item) { return item.id })
      var fresh = loaded.filter(function (id) { return order.indexOf(id) === -1 })
      for (var i = order.length - 1; i >= 0 && order.length + fresh.length > 48; i--) {
        if (COMPONENT_ORDER.indexOf(order[i]) === -1 && loaded.indexOf(order[i]) === -1) order.splice(i, 1)
      }
      return order.concat(fresh)
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
    function finishOrderDrag(event, config, onChange, shown) {
      var list = event.currentTarget, drag = list.slpOrderDrag
      if (!drag || drag.pointerId !== event.pointerId) return
      moveOrderDrag(event)
      var base = shown || config.componentOrder
      var next = drag.active && drag.target ? reorderComponent(base, drag.source, drag.target, drag.after) : null
      clearOrderDrag(list)
      if (next && JSON.stringify(next) !== JSON.stringify(componentOrder(base))) onChange({ componentOrder: next })
    }
    // Drag a component inside the live bottom row. A press that moves less than
    // DOCK_DRAG_PX stays a click, so chips keep opening their panels; a drag
    // swallows the click that ends it, and Escape cancels.
    // While dragging, the row previews the result: the picked item, faint and
    // outlined, takes its new place and the others slide aside (CSS `order`
    // plus a short FLIP animation). A translucent copy, a size smaller and as
    // wide as its content, stays under the pointer at the point it was grabbed,
    // so nothing jumps when the drag starts, and keeps within the row's height. The preview's `order` stays until React
    // renders the saved order underneath.
    var DOCK_DRAG_PX = 6, DOCK_SHIFT_MS = 160, DOCK_GHOST_SCALE = 0.88
    var DOCK_GHOST_TEXT = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'fontVariantNumeric', 'letterSpacing', 'color']
    function dockItems(row) {
      return Array.from(row.children).filter(function (item) { return item.hasAttribute('data-component') && item.getClientRects().length > 0 })
    }
    // Layout boxes ignore running transforms: hit testing against an item in
    // mid-slide would flip the target back and forth.
    function dockLayoutBox(item) {
      var parent = item.offsetParent, base = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 }
      var left = base.left + (parent ? parent.clientLeft : 0) + item.offsetLeft, top = base.top + (parent ? parent.clientTop : 0) + item.offsetTop
      return { left: left, top: top, right: left + item.offsetWidth, bottom: top + item.offsetHeight, width: item.offsetWidth }
    }
    // The row wraps: the target is the nearest other item on the pointer's
    // line, and the picked item goes before or after its centre.
    function dockDropOrder(row, order, source, x, y) {
      var best = null
      dockItems(row).forEach(function (item) {
        var id = item.getAttribute('data-component')
        if (id === source) return
        var box = dockLayoutBox(item)
        var dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0
        var dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0
        if (!best || dy < best.dy || (dy === best.dy && dx < best.dx)) best = { id: id, dy: dy, dx: dx, after: x > box.left + box.width / 2 }
      })
      return best ? reorderComponent(order, source, best.id, best.after) : componentOrder(order)
    }
    function reducedMotion() {
      return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    }
    // Show `order` (null: the DOM order) and slide every moved item from where
    // it is drawn now, including mid-animation, to its new place.
    function previewDockOrder(row, order) {
      var items = dockItems(row), from = items.map(function (item) { return item.getBoundingClientRect() })
      items.forEach(function (item) { if (item.slpShift) { item.slpShift.cancel(); item.slpShift = null } })
      items.forEach(function (item) { item.style.order = order ? String(order.indexOf(item.getAttribute('data-component'))) : '' })
      if (reducedMotion()) return
      items.forEach(function (item, index) {
        var to = item.getBoundingClientRect(), dx = from[index].left - to.left, dy = from[index].top - to.top
        if ((dx || dy) && typeof item.animate === 'function') {
          item.slpShift = item.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: DOCK_SHIFT_MS, easing: 'cubic-bezier(.2,.8,.2,1)' })
        }
      })
    }
    function useDockDrag(row, order, onReorder) {
      var latest = React.useRef(null)
      latest.current = { order: order, onReorder: onReorder }
      var orderKey = JSON.stringify(order)
      // React has rendered the saved order: drop the preview's `order` styles.
      React.useLayoutEffect(function () {
        if (row && !row.hasAttribute('data-reordering')) dockItems(row).forEach(function (item) { item.style.order = '' })
      }, [row, orderKey])
      React.useEffect(function () {
        if (!row) return undefined
        var drag = null
        function lift(item) {
          var box = item.getBoundingClientRect(), style = getComputedStyle(item), ghost = item.cloneNode(true)
          ;['data-component', 'data-dragging', 'data-line-start', 'style'].forEach(function (name) { ghost.removeAttribute(name) })
          ghost.className = 'slp-dock-item slp-dock-ghost'
          ghost.setAttribute('aria-hidden', 'true')
          // Outside the row the copy loses every rule scoped to it (sizes,
          // tabular figures, colours), so each element takes its original's
          // text styles. A component is a handful of nodes.
          var originals = [item].concat(Array.from(item.querySelectorAll('*'))), copies = [ghost].concat(Array.from(ghost.querySelectorAll('*')))
          originals.forEach(function (node, index) {
            var computed = index ? getComputedStyle(node) : style, copy = copies[index]
            // Longhands: the computed `font` shorthand is empty once tabular figures are set.
            if (copy) DOCK_GHOST_TEXT.forEach(function (name) { copy.style[name] = computed[name] })
          })
          // Scaled down around the grabbed point, so that point stays under the pointer.
          ghost.style.transformOrigin = (drag.x - box.left) + 'px ' + (drag.y - box.top) + 'px'
          document.body.appendChild(ghost)
          return { node: ghost, dx: drag.x - box.left, dy: drag.y - box.top, height: box.height }
        }
        // The grabbed point stays under the pointer; vertically the copy keeps
        // within the row, so a wavering hand does not bob it up and down.
        function follow(ghost, event) {
          var rowBox = row.getBoundingClientRect()
          var top = Math.max(rowBox.top, Math.min(event.clientY - ghost.dy, rowBox.bottom - ghost.height))
          ghost.node.style.transform = 'translate(' + (event.clientX - ghost.dx) + 'px,' + top + 'px) scale(' + DOCK_GHOST_SCALE + ')'
        }
        function finish(commit) {
          if (!drag) return
          var done = drag
          drag = null
          document.removeEventListener('keydown', key, true)
          if (done.ghost && done.ghost.node.parentNode) done.ghost.node.parentNode.removeChild(done.ghost.node)
          row.removeAttribute('data-reordering')
          if (done.item) done.item.removeAttribute('data-dragging')
          if (row.hasPointerCapture && row.hasPointerCapture(done.pointerId)) row.releasePointerCapture(done.pointerId)
          if (!done.active) return
          var current = latest.current, before = JSON.stringify(componentOrder(current.order))
          if (commit && done.preview && JSON.stringify(done.preview) !== before) current.onReorder(done.preview)
          else previewDockOrder(row, null)
        }
        function down(event) {
          var item = event.target && event.target.closest && event.target.closest('.slp-dock-item')
          if (!item || item.parentElement !== row || event.button !== 0 || event.isPrimary === false) return
          finish(false)
          drag = { id: item.getAttribute('data-component'), item: item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false, preview: null, ghost: null }
        }
        function move(event) {
          if (!drag || drag.pointerId !== event.pointerId) return
          if (!drag.active) {
            if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DOCK_DRAG_PX) return
            drag.active = true
            if (row.setPointerCapture) row.setPointerCapture(event.pointerId)
            row.setAttribute('data-reordering', 'true')
            drag.item.setAttribute('data-dragging', 'true')
            var selection = window.getSelection && window.getSelection()
            if (selection && selection.removeAllRanges) selection.removeAllRanges()
            drag.ghost = lift(drag.item)
            // Escape is watched only while a drag is live, not on every keystroke.
            document.addEventListener('keydown', key, true)
          }
          event.preventDefault()
          follow(drag.ghost, event)
          var next = dockDropOrder(row, latest.current.order, drag.id, event.clientX, event.clientY)
          if (JSON.stringify(next) === JSON.stringify(drag.preview || componentOrder(latest.current.order))) return
          drag.preview = next
          previewDockOrder(row, next)
        }
        function up(event) {
          if (!drag || drag.pointerId !== event.pointerId) return
          if (drag.active) {
            // The click that ends a drag must not open the chip under the pointer.
            var swallow = function (click) { click.stopPropagation(); click.preventDefault() }
            window.addEventListener('click', swallow, true)
            setTimeout(function () { window.removeEventListener('click', swallow, true) }, 0)
          }
          finish(true)
        }
        function cancel() { finish(false) }
        function key(event) { if (event.key === 'Escape' && drag && drag.active) { event.stopPropagation(); finish(false) } }
        function lost(event) { if (drag && drag.active && drag.pointerId === event.pointerId) finish(false) }
        row.addEventListener('pointerdown', down)
        row.addEventListener('pointermove', move)
        row.addEventListener('pointerup', up)
        row.addEventListener('pointercancel', cancel)
        row.addEventListener('lostpointercapture', lost)
        return function () {
          finish(false)
          row.removeEventListener('pointerdown', down)
          row.removeEventListener('pointermove', move)
          row.removeEventListener('pointerup', up)
          row.removeEventListener('pointercancel', cancel)
          row.removeEventListener('lostpointercapture', lost)
        }
      }, [row])
    }
    function componentEnabled(config, id) {
      var spec = COMPONENTS[id]
      if (!spec) return !(Array.isArray(config.hiddenComponents) && config.hiddenComponents.indexOf(id) !== -1)
      var value = config[spec.field]
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
        // Presets arrange built-ins; extensions placed between them do not make a layout custom.
        var builtIns = function (order) { return componentOrder(order).filter(function (id) { return COMPONENTS[id] }) }
        return Object.keys(patch).every(function (key) { return key === 'componentOrder' ? JSON.stringify(builtIns(config[key])) === JSON.stringify(patch[key]) : !!config[key] === patch[key] })
      }) || 'custom'
    }

    var CSS = [
      // Shared typography and spacing for native statistics and plugin metrics.
      '[data-slot="conversation.composer.dock"]{display:flex!important;flex-direction:row!important;flex-wrap:wrap!important;justify-content:center!important;align-items:center!important;gap:4px var(--slp-gap,16px)!important;max-width:var(--dsh-chat-content-width)!important;width:100%!important;margin:0 auto!important;box-sizing:border-box!important;padding:0.2em 0 0!important;font-size:max(13px,var(--dsh-content-font-size-secondary,13px))!important;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))!important;color:var(--dsw-alias-label-tertiary)!important}',
      '[data-slot="conversation.composer.dock"] > [data-composer-stats]{width:auto!important;max-width:none!important;margin:0!important;padding:0!important;flex:0 1 auto!important;display:inline-flex!important;align-items:center!important;flex-wrap:wrap!important;gap:var(--slp-gap,16px)!important;font:inherit!important;min-height:24px}',
      '[data-slot="conversation.composer.dock"] > [data-composer-stats] :is(button,span):has(> svg){font:inherit!important;color:inherit;padding:2px 0!important;border-radius:4px}',
      '[data-slot="conversation.composer.dock"] > .slp-root{width:auto!important;max-width:100%!important;margin:0!important;padding:0!important;flex:0 1 auto!important;order:2}',
      // Flatten only the dock containing our row. The native ring remains owned
      // by DSH and keeps its portal/details; CSS places it last in native stats.
      'div:has(> [data-slot="conversation.composer.dock"] > .slp-root){--slp-gap:16px;flex-wrap:wrap;gap:4px var(--slp-gap);min-width:0;max-width:100%;font-size:max(13px,var(--dsh-content-font-size-secondary,13px));font-weight:400;font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary)}div:has(> [data-slot="conversation.composer.dock"] > .slp-root) > [data-slot="conversation.composer.dock"]{display:contents!important}div:has(> [data-slot="conversation.composer.dock"] > .slp-root) > span:has(button svg circle){order:1;flex:none}div:has(> [data-slot="conversation.composer.dock"] > .slp-root) > span:has(button svg circle) > button{font:inherit;color:inherit;padding:2px 0;border-radius:4px}',
      // DSH 0.2.1 renders each native stat pill straight into the slot with 8px
      // inline padding; inside the shared gap that doubles the spacing, so drop it.
      'div:has(> [data-slot="conversation.composer.dock"] > .slp-root) > [data-slot="conversation.composer.dock"] > [data-composer-stat] > :is(button,span){padding:2px 0!important;border-radius:4px}',
      // One floating surface for every popover in this plugin. The Host paints its own
      // menus with `--dsw-specific-menu` (a near-neutral translucent sheet) and a
      // blur; `--dsw-alias-bg-overlay` is the *neutral bluish* overlay scale, which
      // reads as a blue-grey card over a white composer. Every floating surface here
      // shares these three, so a tooltip cannot drift from a panel again.
      '.slp-root{--slp-surface:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));--slp-surface-blur:var(--dsw-menu-backdrop-filter,none);--slp-surface-shadow:var(--dsw-elevation-prominent,0 4px 12px rgba(0,0,0,.08));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);display:flex;flex-direction:column;align-items:center;gap:0.2em;max-width:var(--dsh-chat-content-width);width:auto;margin:0;box-sizing:border-box;padding:0;font-size:inherit;line-height:inherit;color:inherit}.slp-root[data-official-hidden="true"]{display:none!important}',
      // One motion ladder for every surface: tap 70ms, hover/state 120ms, panel 180ms.
      // Durations are tokens so a single edit keeps chips, panels and buttons in step.
      // Declared on :root because a panel is also mounted outside the status row.
      ':root{--slp-tap:70ms;--slp-ui:120ms;--slp-panel:180ms;--slp-ease:cubic-bezier(.16,1,.3,1);--slp-accent:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.slp-row{display:flex;align-items:center;gap:4px var(--slp-gap,16px);min-width:0;flex-wrap:wrap;justify-content:center;width:auto;max-width:100%;box-sizing:border-box}',
      '.slp-row > *{flex:0 1 auto;max-width:100%}.slp-row > [data-overflow="true"]{display:none!important}.slp-row-break{display:none;flex:0 0 100%;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none}',
      '.slp-row > *{position:relative}.slp-row > * + *::before{content:"";position:absolute;inset-inline-start:calc(var(--slp-gap,16px) / -2);top:50%;height:0.75em;transform:translateY(-50%);border-inline-start:1px solid var(--dsw-alias-border-l3)}.slp-row > *[data-line-start="true"]::before{display:none}',
      // An extension that renders nothing, or whose entry crashed and left only the Host's error anchor, takes no place.
      '.slp-dock-item:has(> [data-slot]:empty),.slp-dock-item:has(> [data-slot] > [data-slot-error]:only-child){display:none}.slp-ext-tag{flex:none;font-size:11px;padding:0 5px;border-radius:4px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 12%,transparent)}.slp-ext-sample{border:1px dashed color-mix(in srgb,var(--dsw-alias-label-tertiary) 50%,transparent);border-radius:4px;padding:0 6px}',
      '.slp-dock-item{display:inline-flex;align-items:center;min-width:0}.slp-dock-item:empty{display:none}.slp-dock-item > *{max-width:100%}.slp-row[data-reordering]{cursor:grabbing;user-select:none}.slp-row[data-reordering] *{cursor:grabbing!important}.slp-row[data-reordering] > *::before{display:none}.slp-dock-item[data-dragging="true"]{opacity:.35;outline:1px dashed var(--dsw-alias-label-tertiary,#888);outline-offset:3px;border-radius:6px}.slp-dock-ghost{position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;box-sizing:border-box;display:inline-flex;align-items:center;white-space:nowrap;opacity:.85;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 60%,transparent);box-shadow:0 2px 6px rgba(0,0,0,.1);will-change:transform}.slp-dock-ghost > *{opacity:.47;animation:slp-lift 120ms ease-out}@keyframes slp-lift{from{opacity:.3}}@media(prefers-reduced-motion:reduce){.slp-dock-ghost > *{animation:none}}.slp-dock-item.slp-budgeted{overflow:hidden;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 10px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 10px),transparent)}.slp-dock-item[data-budget="hidden"]{display:none}',
      // A chip's own reading is compact by design; the detail a click used to be needed for
      // is shown in place on hover or focus, with no layout change and no panel. The native
      // `title` is gone from these triggers so the browser's delayed tooltip cannot cover it;
      // the same sentence is the accessible name. A chip whose panel is open shows the panel,
      // not a duplicate line above it.
      '.slp-panel-advice{margin:6px 0 0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}'
      + '.slp-health{margin:10px 0 0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-label);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent)}'
      + '.slp-health strong{display:block;font-weight:600;margin-bottom:2px}'
      + '.slp-health ul{margin:0;padding-inline-start:16px}'
      + '.slp-health li{margin:2px 0;overflow-wrap:anywhere}'
      + '.slp-row [data-peek]{position:relative}'
      // `display:none` until shown: an absolutely positioned pseudo-element that
      // merely sits at opacity 0 still adds scrollable overflow, which a 320px row
      // cannot afford. The bubble grows from the chip's right edge leftwards, so it
      // can never push the document wider to the right.
      + '.slp-row [data-peek]:is(:hover,:focus-visible)::after{content:attr(data-peek);display:block;position:absolute;z-index:60;bottom:calc(100% + 6px);inset-inline-end:0;width:max-content;max-width:min(320px,calc(100vw - 32px));padding:6px 9px;border-radius:8px;background:var(--slp-surface,var(--dsw-specific-menu,var(--dsw-alias-bg-overlay)));-webkit-backdrop-filter:var(--slp-surface-blur,var(--dsw-menu-backdrop-filter,none));backdrop-filter:var(--slp-surface-blur,var(--dsw-menu-backdrop-filter,none));box-shadow:var(--slp-surface-shadow,var(--dsw-elevation-prominent,0 4px 12px rgba(0,0,0,.08)));color:var(--dsw-alias-label-primary);font-size:12px;font-weight:400;line-height:1.5;white-space:pre-line;overflow-wrap:anywhere;text-align:start;pointer-events:none;animation:slp-tip var(--slp-ui) var(--slp-ease) 120ms both}'
      + '.slp-row [data-peek][aria-expanded="true"]::after,.slp-row[data-reordering] [data-peek]::after{display:none}'
      + '@media(hover:none){.slp-row [data-peek]::after{display:none}}'
      + '@media(prefers-reduced-motion:reduce){.slp-row [data-peek]:is(:hover,:focus-visible)::after{animation:none}}',

      '.slp-group{display:inline-flex;align-items:center;white-space:nowrap;min-width:0;min-height:24px}',
      '.slp-git{max-width:100%;min-width:0}.slp-git > button{min-width:0;max-width:100%;flex-wrap:wrap;white-space:normal}.slp-git-branch,.slp-git-path{min-width:0;max-width:min(32ch,100%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}',
      '.slp-quota-root{position:relative;display:inline-flex;align-items:center;outline:none}',
      '.slp-quota-trigger{display:inline-flex;align-items:center;gap:8px;padding:1px 8px;font-variant-numeric:tabular-nums;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);cursor:pointer;font-size:inherit;font-family:inherit;line-height:1.5;color:var(--dsw-alias-label-secondary);user-select:none;white-space:nowrap;transition:border-color var(--slp-ui) var(--slp-ease),background var(--slp-ui) var(--slp-ease),color var(--slp-ui) var(--slp-ease)}',
      '.slp-quota-trigger:hover{border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}.slp-quota-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-quota-trigger[aria-expanded="true"]{border-color:var(--dsw-alias-border-l2)}.slp-quota-name{font-weight:500}.slp-quota-name-clipped{display:inline-block;max-width:9em;overflow:hidden;white-space:nowrap;vertical-align:bottom;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 10px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 10px),transparent)}.slp-quota-muted{opacity:.6}span.slp-quota-muted{cursor:default}',
      '.slp-header-group,.slp-quota-with-age,.slp-chip-metric{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;max-width:100%;font-size:max(13px,var(--dsh-content-font-size-secondary,13px));font-variant-numeric:tabular-nums}.slp-quota-age{font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}.slp-quota-age.slp-stale{color:var(--dsw-alias-state-warn-label)}',
      // A "no such subscription" chip is a transient status: 6 s readable, then a
      // 4 s linear fade, removed at 10 s (the JS deadline) instead of staying in
      // the header as a permanent, larger-font sentence.
      '.slp-chip-fade{animation:slp-chip-fade 10s linear forwards}@keyframes slp-chip-fade{0%,60%{opacity:1}100%{opacity:0}}',
      // Reset drawer: a clipped frame on the chip's bottom edge; the sheet slides
      // down out of it (300ms, decelerating) and back up (200ms, accelerating:
      // a fast start on the way out reads as a jump). It is its own compositor
      // layer, so the move and the backdrop blur stay off the main thread. The sheet is
      // the Host's menu material, like the details panel: translucent fill, blur, edge.
      '.slp-reset-drawer{position:fixed;z-index:120;box-sizing:border-box;overflow:hidden;padding:0 6px 8px;pointer-events:none}' +
        '.slp-reset-sheet{pointer-events:auto;box-sizing:border-box;width:fit-content;max-width:100%;will-change:transform;padding:5px 8px 6px;border-radius:0 0 10px 10px;background:var(--slp-surface,var(--dsw-specific-menu,var(--dsw-alias-bg-overlay)));-webkit-backdrop-filter:var(--slp-surface-blur,var(--dsw-menu-backdrop-filter,none));backdrop-filter:var(--slp-surface-blur,var(--dsw-menu-backdrop-filter,none));box-shadow:var(--slp-surface-shadow,var(--dsw-elevation-prominent,0 4px 12px rgba(0,0,0,.08)));color:var(--dsw-alias-label-primary);transform:translateY(0);animation:slp-drawer-in 300ms cubic-bezier(.16,1,.3,1)}' +
        '.slp-reset-drawer[data-phase="out"] .slp-reset-sheet{animation:slp-drawer-out 200ms cubic-bezier(.4,0,1,1) forwards;pointer-events:none}' +
        '@keyframes slp-drawer-in{from{transform:translateY(-100%)}to{transform:translateY(0)}}' +
        '@keyframes slp-drawer-out{from{transform:translateY(0)}to{transform:translateY(-100%)}}' +
        // One flowing line of text: wraps to a second line only when it must.
        '.slp-reset-line{margin:0;font-size:12px;line-height:17px;font-variant-numeric:tabular-nums;word-break:keep-all;overflow-wrap:anywhere}' +
        // Drawer: "Got it" floats right after the sentence. A float sits on the
        // sentence's last line when it has room, else at the right of the next
        // line, so a wrapped sentence still shares its last line with it.
        '.slp-reset-row{display:flow-root}.slp-reset-row>.slp-reset-ack{float:right;margin-left:8px}' +
        '.slp-reset-name{font-weight:600}.slp-reset-time{font-weight:600}' +
        '.slp-reset-src{color:inherit;text-decoration:none;border-radius:4px}.slp-reset-src:hover{text-decoration:underline;text-decoration-color:var(--dsw-alias-label-tertiary)}.slp-reset-src:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-reset-arrow{color:var(--dsw-alias-label-tertiary)}' +
        '.slp-reset-scope{color:var(--dsw-alias-label-tertiary)}' +
        '.slp-reset-link{color:var(--dsw-alias-label-tertiary);text-decoration:none;border-radius:4px;white-space:nowrap}.slp-reset-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}.slp-reset-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
        '.slp-reset-ack{display:inline-block;height:17px;padding:0 7px;border:0;border-radius:5px;vertical-align:top;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;line-height:17px;white-space:nowrap;cursor:pointer;transition:background-color 60ms}.slp-reset-ack:hover{background:var(--dsw-alias-interactive-bg-hover)}.slp-reset-ack:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
        // Details panel: one rounded box, tight lines. The original-post link
        // floats right after the sentence and scope: it shares their last line
        // whenever that line leaves room for it, so it never reads as part of
        // the scope and only takes a line of its own when it must.
        '.slp-reset-section{display:flex;flex-direction:column;gap:3px;margin-top:6px;padding:5px 8px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l1)}' +
        '.slp-reset-section .slp-reset-line{display:flow-root}' +
        '.slp-reset-link{float:right;margin-left:10px}' +
        '.slp-reset-kinds{display:flex;flex-wrap:wrap;gap:4px 16px}' +
        '@media (prefers-reduced-motion: reduce){.slp-reset-sheet,.slp-reset-drawer[data-phase="out"] .slp-reset-sheet{animation:none}}',
      '.slp-mq{display:inline-flex;align-items:center;gap:6px;min-width:0;font-variant-numeric:tabular-nums}.slp-mq-option{width:100%}.slp-mq-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.slp-mq-amount{flex:none;margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary)}.slp-mq-badge{flex:none;font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.slp-peak-trigger{font-size:max(13px,var(--dsh-content-font-size-secondary,13px));font-variant-numeric:tabular-nums}.slp-peak-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor}',
      '.slp-peak-trigger[data-peak="off"]{background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-state-success-primary) 24%,var(--dsw-alias-bg-layer-1)) 50%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-border-l1))}.slp-peak-trigger[data-peak="off"]:hover{background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,var(--dsw-alias-bg-layer-1)) 50%,transparent)}',
      '.slp-peak-trigger[data-peak="peak"]{background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-state-warn-label) 24%,var(--dsw-alias-bg-layer-1)) 50%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-label) 55%,var(--dsw-alias-border-l1))}.slp-peak-trigger[data-peak="peak"]:hover{background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-state-warn-label) 32%,var(--dsw-alias-bg-layer-1)) 50%,transparent)}.slp-panel.slp-peak-panel{background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 94%,transparent)}',
      // The peak panel is a reading column, not a full-width sheet: cap it even
      // when the fallback placement (no Host hook) lets it shrink-to-fit. The
      // selector must outrank the base `.slp-panel` max-width below.
      '.slp-panel.slp-peak-panel{max-width:min(380px,calc(100vw - 24px))}.slp-peak-panel p{margin:6px 0}.slp-peak-timeline{position:relative;display:flex;height:8px;border-radius:4px;overflow:hidden;margin:8px 0}',
      '.slp-peak-dot-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 36px;width:36px;height:36px;padding:0;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary);transition:background var(--slp-ui) var(--slp-ease),color var(--slp-ui) var(--slp-ease)}.slp-peak-dot-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.slp-peak-dot-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-peak-dot-btn[data-peak="peak"]{color:var(--dsw-alias-state-warn-label)}.slp-peak-dot-btn[data-peak="off"]{color:var(--dsw-alias-state-success-primary)}.slp-peak-dot-lg{display:block;width:12px;height:12px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 28%,transparent)}.slp-panel.slp-panel-fixed{position:fixed;top:auto;right:auto!important;left:8px;bottom:56px;max-height:calc(100vh - 80px);overflow:auto}',
      '.slp-panel.slp-peak-compact{min-width:0;width:max-content;max-width:min(240px,calc(100vw - 24px))}.slp-peak-compact p{margin:2px 0;color:var(--dsw-alias-label-secondary)}.slp-peak-compact .slp-peak-timeline{width:200px;max-width:100%;height:6px;margin:6px 0}.slp-peak-compact > strong{display:block;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}.slp-peak-compact > strong[data-peak="peak"]{color:var(--dsw-alias-state-warn-label)}.slp-peak-compact > strong[data-peak="off"]{color:var(--dsw-alias-state-success-primary)}.slp-peak-compact .slp-peak-link{font-size:12px}',
      '.slp-rs-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 36px;width:36px;height:36px;padding:0;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary)}.slp-rs-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.slp-rs-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-rs-btn[aria-busy="true"] .slp-rs-power{animation:slp-rs-spin 1s linear infinite}@keyframes slp-rs-spin{to{transform:rotate(360deg)}}.slp-rs-btn{position:relative}.slp-rs-btn[data-update="true"]::before{content:"";position:absolute;inset:6px;border-radius:50%;box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 55%,transparent);animation:slp-rs-glow 2.4s ease-out infinite;pointer-events:none}.slp-rs-update-badge{position:absolute;top:2px;right:2px;display:flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;box-sizing:border-box;color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 86%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,currentColor 30%,transparent);pointer-events:none;animation:slp-rs-arrow 2s ease-in-out infinite}.slp-rs-update-badge svg{display:block;width:10px;height:10px;flex:none}@keyframes slp-rs-arrow{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}@keyframes slp-rs-glow{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 55%,transparent)}70%,100%{box-shadow:0 0 0 8px transparent}}@media (prefers-reduced-motion:reduce){.slp-rs-btn[data-update="true"]::before,.slp-rs-update-badge{animation:none}}',
      '.slp-rs-toast{position:fixed;left:16px;bottom:64px;z-index:10000;max-width:min(340px,calc(100vw - 32px));box-sizing:border-box;padding:10px 12px;border-radius:8px;font-size:13px;line-height:18px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16))}.slp-rs-toast-title{font-weight:600}.slp-rs-toast-detail{margin-top:4px;white-space:pre-line;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#61666b)}.slp-rs-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}.slp-rs-actions:empty{display:none}',
      '.slp-rs-act{height:32px;padding:0 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#0000001a);background:transparent;color:var(--dsw-alias-label-primary,#0f1115)}.slp-rs-toast .slp-rs-act{height:28px;padding:0 10px}.slp-rs-act:hover{background:var(--dsw-alias-interactive-bg-hover)}.slp-rs-act:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}.slp-rs-act[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff)}.slp-rs-act[data-variant="danger"]{border-color:transparent;background:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.slp-rs-dialog{width:min(420px,calc(100vw - 32px));max-width:none;padding:20px;border:0;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16));font-size:13px}.slp-rs-dialog::backdrop{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4))}.slp-rs-dialog h2{margin:0;font-size:14px;font-weight:600}.slp-rs-dialog p{margin:6px 0 0;color:var(--dsw-alias-label-secondary,#61666b)}.slp-rs-dialog .slp-rs-actions{margin-top:20px;flex-wrap:wrap}.slp-rs-dialog p.slp-rs-update{margin-top:12px;padding:8px 10px;border-radius:8px;color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,currentColor 10%,transparent)}.slp-rs-act[data-variant="update"]{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}.slp-rs-dialog p.slp-rs-warn{margin-top:12px;padding:8px 10px;border-radius:8px;color:var(--dsw-alias-state-warn-label,#b54708);background:color-mix(in srgb,currentColor 10%,transparent)}.slp-rs-progress{width:min(460px,calc(100vw - 32px))}.slp-rs-dialog p.slp-rs-progress-hint{margin-top:6px}.slp-rs-steps{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}.slp-rs-step{display:flex;align-items:center;gap:10px;min-height:20px;color:var(--dsw-alias-label-tertiary)}.slp-rs-step-text{font-size:13px;line-height:18px}.slp-rs-step-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-weight:400}.slp-rs-step-dot{flex:none;width:16px;height:16px;border-radius:50%;border:2px solid currentColor;box-sizing:border-box;position:relative}.slp-rs-step[data-state="active"]{color:var(--dsw-alias-label-primary);font-weight:600}.slp-rs-step[data-state="active"] .slp-rs-step-dot{border-color:var(--dsw-alias-brand-primary,#4d6bfe);border-top-color:transparent;animation:slp-rs-spin .9s linear infinite}.slp-rs-step[data-state="done"]{color:var(--dsw-alias-label-secondary)}.slp-rs-step[data-state="done"] .slp-rs-step-dot{border-color:var(--dsw-alias-state-success-primary,#16a34a);background:var(--dsw-alias-state-success-primary,#16a34a)}.slp-rs-step[data-state="done"] .slp-rs-step-dot::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}.slp-rs-step[data-state="failed"]{color:var(--dsw-alias-state-error-primary,#d92d20);font-weight:600}.slp-rs-step[data-state="failed"] .slp-rs-step-dot{border-color:currentColor;background:currentColor}.slp-rs-step[data-state="failed"] .slp-rs-step-dot::after{content:"";position:absolute;left:3px;top:6px;width:6px;height:2px;background:#fff}.slp-rs-step[data-state="skipped"]{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}.slp-rs-step[data-state="skipped"] .slp-rs-step-dot{border-style:dashed}.slp-rs-bar{height:4px;margin-top:16px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-border-l2,#ccc) 55%,transparent);overflow:hidden;position:relative}.slp-rs-bar > span{display:block;width:38%;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4d6bfe);animation:slp-rs-progress 1.4s ease-in-out infinite}.slp-rs-progress[data-state="done"] .slp-rs-bar > span{width:100%;background:var(--dsw-alias-state-success-primary,#16a34a);animation:none}.slp-rs-progress[data-state="failed"] .slp-rs-bar > span,.slp-rs-progress[data-state="rolled-back"] .slp-rs-bar > span,.slp-rs-progress[data-state="stale"] .slp-rs-bar > span,.slp-rs-progress[data-state="refused"] .slp-rs-bar > span,.slp-rs-progress[data-state="unknown"] .slp-rs-bar > span{width:100%;background:var(--dsw-alias-state-error-primary,#d92d20);animation:none}.slp-rs-dialog p.slp-rs-elapsed{margin-top:8px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.slp-rs-dialog p.slp-rs-progress-detail{margin-top:8px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.slp-rs-dialog p.slp-rs-log{margin-top:8px;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;user-select:all}.slp-rs-progress .slp-rs-actions{margin-top:16px}@keyframes slp-rs-progress{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}@media (prefers-reduced-motion:reduce){.slp-rs-step[data-state="active"] .slp-rs-step-dot,.slp-rs-bar > span{animation:none}}@media (prefers-reduced-motion:reduce){.slp-rs-btn[aria-busy="true"] .slp-rs-power{animation:none}}',
      '.slp-peak-alert{color:var(--dsw-alias-state-warn-label)!important}.slp-peak-source{font-size:12px;color:var(--dsw-alias-label-tertiary)}.slp-peak-dot-btn{position:relative}.slp-peak-dot-btn[data-alert="true"]::after{content:"";position:absolute;top:8px;right:8px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}',
      '.slp-peak-cursor{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-label-primary)}.slp-peak-link{color:var(--dsw-alias-brand-primary)}',
      '.slp-panel-meta{display:inline-flex;flex-wrap:wrap;align-items:center;gap:0 6px;min-width:0}.slp-quota-source{white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary)}.slp-quota-source + .slp-quota-age::before{content:"· ";}',
      // Chip detail leaves in order of value: reset time, then bar, then name; the percentage always stays.
      '.slp-fold{display:inline-flex;align-items:center;min-width:0}.slp-fold:empty{display:none}',
      '.slp-fold[data-fold] .slp-codex-reset,.slp-fold[data-fold] .slp-peak-countdown{display:none}.slp-fold[data-fold="2"] .slp-codex-fill,.slp-fold[data-fold="3"] .slp-codex-fill{display:none}.slp-fold[data-fold="3"] .slp-quota-name{display:none}',
      '.slp-seg{display:inline-flex;align-items:center;gap:4px}',
      '.slp-seg-label{opacity:.8;flex:none}',
      '.slp-err{color:var(--dsw-alias-state-error-primary)}',
      '.slp-git-branch{font-variant-numeric:tabular-nums}',
      '.slp-git-trigger{display:inline-flex;align-items:center;gap:6px;font:inherit;color:inherit;border:0;border-radius:4px;background:none;padding:2px 0;cursor:pointer;font-variant-numeric:tabular-nums;transition:background var(--slp-ui) var(--slp-ease),color var(--slp-ui) var(--slp-ease)}.slp-git-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.slp-git-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}',
      '.slp-git-path{font:inherit;color:inherit;font-variant-numeric:tabular-nums}',
      '.slp-git-staged{color:var(--dsw-alias-state-success-primary)}',
      '.slp-git-unstaged{color:var(--dsw-alias-state-warn-primary)}',
      '.slp-git-conflict{color:var(--dsw-alias-state-error-primary);font-weight:500}',
      '.slp-git-added{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}',
      '.slp-git-deleted{color:var(--dsw-alias-state-error-primary);font-variant-numeric:tabular-nums}',
      '.slp-tps{font-variant-numeric:tabular-nums;white-space:nowrap}.slp-muted{color:var(--dsw-alias-label-tertiary)}',
      // The row matches the Host's own dock stat (ContextMeter): tertiary text, secondary on hover or while
      // its panel is open; coloured readings keep their colours. Muted goes a step fainter than that.
      '.slp-row :is(.slp-git-trigger,.slp-activity-trigger,.slp-cost-trigger,.slp-context-trigger)[aria-expanded="true"]{color:var(--dsw-alias-label-secondary)}.slp-row .slp-muted{color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 60%,transparent)}',
       '.slp-context{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;white-space:nowrap}',
       '.slp-context-label{color:inherit}',
       '.slp-context-pct.s{color:var(--dsw-alias-state-success-primary)}',
       '.slp-context-pct.w{color:var(--dsw-alias-state-warn-primary)}',
       '.slp-context-pct.d{color:var(--dsw-alias-state-error-primary)}',
      '.slp-context{flex-wrap:wrap;gap:4px 6px}.slp-activity-trigger,.slp-cost-trigger{font:inherit;color:inherit;background:none;border:0;border-radius:4px;padding:2px 0;cursor:pointer;max-width:100%;white-space:normal;text-align:start;font-variant-numeric:tabular-nums;transition:background var(--slp-ui) var(--slp-ease),color var(--slp-ui) var(--slp-ease)}.slp-activity-trigger:hover,.slp-cost-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.slp-activity-panel,.slp-cost-panel{bottom:calc(100% + 8px);white-space:normal}.slp-activity-item{display:flex;flex-wrap:wrap;gap:4px 10px;margin:6px 0}.slp-activity-item > span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}',
      // ---- 额度 chip 内的分段条 ----
      '.slp-codex-fill{display:inline-block;width:22px;height:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 20%,transparent);overflow:hidden;vertical-align:middle}',
      '.slp-codex-pct{min-width:24px;text-align:left;color:var(--dsw-alias-label-secondary)}',
       '.slp-codex-reset{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}',
      // ---- 毛玻璃详情面板 ----
      '@keyframes slp-pop{from{opacity:0;transform:translateY(-4px) scale(.97)}to{opacity:1;transform:none}}',
      '@keyframes slp-tip{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}',
      '@keyframes slp-shimmer{to{transform:translateX(100%)}}',
      '.slp-panel{position:absolute;right:0;z-index:9999;min-width:min(300px,calc(100vw - 24px));max-width:calc(100vw - 24px);box-sizing:border-box;overflow-wrap:anywhere;background:var(--slp-surface,var(--dsw-specific-menu,var(--dsw-alias-bg-overlay)));border-radius:10px;-webkit-backdrop-filter:var(--slp-surface-blur,var(--dsw-menu-backdrop-filter,none));backdrop-filter:var(--slp-surface-blur,var(--dsw-menu-backdrop-filter,none));box-shadow:var(--slp-surface-shadow,var(--dsw-elevation-prominent,0 4px 12px rgba(0,0,0,.08)));padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);animation:slp-pop var(--slp-panel) var(--slp-ease)}',
      '.slp-panel-down{top:calc(100% + 6px)}',
      // Header details are anchored sheets, not dialogs: cap them so a long
      // note or error wraps in a readable column instead of stretching the
      // panel to the viewport width (the fallback placement shrink-wraps it).
      '.slp-panel.slp-panel-down{max-width:min(380px,calc(100vw - 24px))}',
      // Portalled header panels: MenuSurface owns material and radius; this class owns placement and elevation.
      '.slp-anchored{position:fixed;z-index:100;box-sizing:border-box;max-width:var(--dsh-anchored-max-width,calc(100vw - 24px));max-height:var(--dsh-anchored-max-height,calc(100vh - 24px));overflow:hidden;outline:none;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent)}',
      '.slp-anchored>.slp-panel{position:relative;right:auto;z-index:auto;background:none;border-radius:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}',
      '@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))){.slp-panel{background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 46%,transparent);backdrop-filter:blur(26px) saturate(1.9);-webkit-backdrop-filter:blur(26px) saturate(1.9)}}',
      '.slp-panel-title{font-size:13px;line-height:18px;font-weight:600;margin:0 0 8px}.slp-panel-mode{margin-inline-start:6px;font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
      '.slp-bar{display:flex;align-items:center;gap:5px;font-size:12px;line-height:18px;white-space:nowrap;min-width:0}',
      '.slp-bar-swatch{flex:none;width:8px;height:8px;border-radius:2px}',
      '.slp-bar-label{flex:none;width:5.5em;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.slp-bar-track{flex:1 1 auto;min-width:48px;height:4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 20%,transparent);overflow:hidden}',
      '.slp-bar-fill{display:block;height:100%;border-radius:999px;min-width:4px;transition:width 300ms var(--slp-ease)}',
      '.slp-bar-val{flex:none;min-width:5em;text-align:left;white-space:nowrap}',
      '.slp-bar-pct{font-variant-numeric:tabular-nums;font-weight:500}',
      '.slp-bar-reset{font-size:10px;color:var(--dsw-alias-state-warn-label);font-variant-numeric:tabular-nums}',
      '.slp-panel-note{margin:4px 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}.slp-panel-note.slp-err{color:var(--dsw-alias-state-error-primary)}.slp-link-btn{font:inherit;color:var(--dsw-alias-brand-primary);background:none;border:0;padding:0;cursor:pointer}.slp-link-btn:hover{text-decoration:underline}.slp-link-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:2px}',
      '.slp-panel.slp-cost-panel{min-width:0;width:min(248px,calc(100vw - 24px))}.slp-cost-head{display:flex;align-items:center;justify-content:space-between;gap:6px}.slp-cost-head .slp-hint{margin:0}.slp-cost-amount{margin:4px 0 2px;font-size:18px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}.slp-cost-table{width:100%;border-collapse:collapse;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}.slp-cost-table th,.slp-cost-table td{padding:2px 0;text-align:end}.slp-cost-table th:first-child,.slp-cost-table td:first-child{text-align:start}.slp-cost-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.slp-cost-table th{font-weight:400}.slp-cost-panel .slp-panel-note{margin:4px 0 0;font-size:11px;line-height:16px}.slp-cost-reasons{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(min-width:481px){.slp-cost-panel .slp-hint:is(:hover,:focus)::after{inset-inline-start:auto;inset-inline-end:0;top:auto;bottom:calc(100% + 8px)}}',
      '.slp-cost-bar{display:flex;gap:1px;height:4px;margin:6px 0 4px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 20%,transparent)}.slp-cost-segment{flex:0 1 auto;min-width:0;height:100%;border-radius:1px}.slp-cost-label{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary)}.slp-cost-swatch{flex:none;width:7px;height:7px;border-radius:2px}.slp-cost-tint[data-kind="input"]{background:var(--dsw-alias-label-primary)}.slp-cost-tint[data-kind="cache"]{background:color-mix(in srgb,var(--slp-accent) 40%,var(--dsw-alias-bg-layer-2))}.slp-cost-tint[data-kind="output"]{background:var(--slp-accent)}',
      '.slp-cost-tokens{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.slp-panel.slp-subagent-panel{min-width:0;width:min(280px,calc(100vw - 24px));max-height:min(360px,calc(100dvh - 100px));overflow:auto}.slp-subagent-summary{margin:2px 0 2px;font-size:11px;color:var(--dsw-alias-label-secondary)}.slp-subagent-panel .slp-activity-item{display:block;margin:0;padding:7px 0}.slp-subagent-panel .slp-activity-item + .slp-activity-item{border-top:1px solid var(--dsw-alias-border-l1)}.slp-subagent-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;font-size:12px;font-weight:600;line-height:18px}.slp-subagent-model-row,.slp-subagent-state-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:3px;font-size:11px;line-height:1.4}.slp-subagent-model-row{justify-content:flex-start;gap:6px}.slp-subagent-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}.slp-subagent-effort{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);padding:1px 4px;border-radius:4px}.slp-subagent-state-row{color:var(--dsw-alias-label-tertiary)}.slp-subagent-state-row time{flex:none;font-variant-numeric:tabular-nums}.slp-subagent-status[data-running="true"]{color:var(--dsw-alias-state-success-primary)}',
      '.slp-balance{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;margin:2px 0 6px}.slp-balance > .slp-panel-note{flex-basis:100%;margin:0}.slp-balance-amount{font-size:18px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}.slp-balance-amount.slp-err{color:var(--dsw-alias-state-error-primary)}.slp-balance-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.slp-acct + .slp-acct{margin-top:8px;padding-top:8px;border-top:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}.slp-acct-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;font-weight:600;margin-bottom:3px}.slp-acct-state{font-size:11px;font-weight:400;opacity:.6}.slp-acct-state.slp-acct-current{color:var(--dsw-alias-brand-primary);opacity:1}.slp-acct-state.slp-err{opacity:1}',
      '.slp-panel-foot{margin-top:8px;padding-top:6px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px}',
      // ---- 设置页 ----
      '.slp-set{display:flex;flex-direction:column;gap:12px;padding:4px 2px}.slp-set-head{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:4px 12px}.slp-set-heading{display:flex;align-items:center;gap:6px;min-width:0}.slp-version{display:inline-block;flex:none;padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;font-weight:400;font-variant-numeric:tabular-nums;letter-spacing:.02em;white-space:nowrap}.slp-save-state{font-size:12px;color:var(--dsw-alias-label-tertiary)}.slp-set-actions{display:inline-flex;align-items:center;flex-wrap:wrap;gap:8px}.slp-btn.slp-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.slp-inline-seg{margin-inline-start:8px}.slp-check-row > .slp-check-text{font-size:12px;color:var(--dsw-alias-label-primary)}.slp-save-state.slp-err{color:var(--dsw-alias-state-error-primary)}',
      // ⓘ tooltip: shown on hover and on focus (keyboard, or tap on touch screens).
      '.slp-hint{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;margin-inline-start:6px;border-radius:50%;font-size:12px;font-weight:400;line-height:1;color:var(--dsw-alias-label-tertiary);cursor:help;vertical-align:middle}.slp-hint:hover,.slp-hint:focus{color:var(--dsw-alias-brand-primary);outline:none}.slp-hint:is(:hover,:focus)::after{content:attr(data-tip);position:absolute;z-index:30;top:calc(100% + 6px);inset-inline-start:-6px;width:max-content;max-width:min(320px,calc(100vw - 48px));padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent),0 10px 26px color-mix(in srgb,#000 16%,transparent);animation:slp-tip var(--slp-ui) var(--slp-ease) 300ms both;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:400;line-height:1.5;white-space:normal;text-align:start;pointer-events:none}.slp-check-row,.slp-field-label{display:inline-flex;align-items:center;min-width:0}.slp-check-row > .slp-check{min-width:0}',
      '.slp-set-title{margin:0;font-size:15px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.slp-set-desc{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.slp-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.slp-input{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 85%,transparent);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;transition:border-color var(--slp-ui) var(--slp-ease)}',
      '.slp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.slp-settings-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0}.slp-settings-heading{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}.slp-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:10px 16px}.slp-settings-body{display:flex;flex-direction:column;gap:10px;padding-top:10px}.slp-settings-fold > summary,.slp-provider-card > summary{cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;overflow-wrap:anywhere}.slp-provider-card{border-top:1px solid var(--dsw-alias-border-l1);padding:10px 0}.slp-provider-state{font-size:12px;color:var(--dsw-alias-label-tertiary);font-weight:400}.slp-check:has(input:disabled){opacity:.4}',
      '.slp-provider-card .slp-check{flex-wrap:wrap;max-width:100%}.slp-settings-body .slp-input{box-sizing:border-box;max-width:100%;min-width:0}.slp-set-desc{overflow-wrap:anywhere}',
      '@media(max-width:480px){div:has(> [data-slot="conversation.composer.dock"] > .slp-root):has(> span) > [data-slot="conversation.composer.dock"] > .slp-root{max-width:calc(100% - 76px)!important}.slp-git{max-width:min(100%,240px)}.slp-git-trigger{gap:4px;max-width:100%;overflow:hidden}.slp-git-path{flex:0 1 5em;max-width:5em;min-width:0;overflow:hidden;white-space:nowrap;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 10px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 10px),transparent)}.slp-git-branch{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.slp-git-trigger > :not(.slp-git-path):not(.slp-git-branch){flex:none}}',
      '@media(max-width:360px){.slp-git-path{display:none}}',
      '@media(max-width:480px),(pointer:coarse){.slp-btn-sm,.slp-btn-icon{min-width:32px;min-height:32px}.slp-drag-handle{min-width:28px;min-height:28px}.slp-git-trigger,.slp-context-trigger,.slp-cost-trigger,.slp-activity-trigger,.slp-quota-trigger,.slp-link-btn,.slp-peak-trigger{min-height:28px}.slp-check{min-height:32px;align-items:center}.slp-source-switch{height:32px}}',

      '.slp-provider-card > .slp-source-fields{padding-top:10px}.slp-source-heading{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;list-style:none}.slp-source-heading::-webkit-details-marker{display:none}.slp-source-title{flex:1 1 120px;min-width:0;max-width:100%;overflow-wrap:anywhere}.slp-source-title::before{content:"▸";display:inline-block;margin-inline-end:6px;color:var(--dsw-alias-label-tertiary)}.slp-provider-card[open] > summary .slp-source-title::before{content:"▾"}.slp-source-switch{position:relative;display:inline-flex;align-items:center;flex:none;width:32px;max-width:100%;height:24px;cursor:pointer}.slp-source-switch > input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:inherit;z-index:1}.slp-switch-track{position:relative;display:block;width:100%;height:18px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 15%,var(--dsw-alias-bg-layer-2));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);transition:background var(--slp-ui) var(--slp-ease)}.slp-switch-track::after{content:"";position:absolute;top:3px;inset-inline-start:3px;width:12px;max-width:calc(100% - 6px);height:12px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:inset-inline-start var(--slp-ui) var(--slp-ease),background var(--slp-ui) var(--slp-ease)}.slp-source-switch > input:checked + .slp-switch-track{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 25%,var(--dsw-alias-bg-layer-2));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-border-l2))}.slp-source-switch > input:checked + .slp-switch-track::after{inset-inline-start:max(3px,calc(100% - 15px));background:var(--dsw-alias-state-success-primary)}.slp-source-switch > input:focus-visible + .slp-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.slp-source-switch:has(input:disabled){cursor:default;opacity:.4}',
      '.slp-settings-heading,.slp-settings-group .slp-check,.slp-settings-group .slp-field{min-width:0;overflow-wrap:anywhere}.slp-check-text{min-width:0;overflow-wrap:anywhere}.slp-settings-group input[type="checkbox"]{flex-shrink:0}@media(max-width:480px){.slp-settings-group{padding:4px}.slp-settings-grid{column-gap:8px}.slp-settings-group .slp-check{flex-wrap:wrap}}',
      '.slp-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.slp-master{padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}.slp-master .slp-check{font-size:14px;font-weight:600}.slp-master .slp-check input{width:18px;height:18px}.slp-settings-group input[type="checkbox"]{margin:0}.slp-setting-branch{display:flex;flex-direction:column;gap:8px;min-width:0}.slp-setting-children{display:flex;flex-direction:column;gap:8px;min-width:0}.slp-dependent{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:10px}.slp-dependent:disabled{opacity:.6}.slp-source-fields{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:10px}.slp-source-fields:disabled{opacity:.6}',
      // Fieldsets reset their native box model before the child hierarchy styling.
      '.slp-setting-children{margin-inline-start:8px;padding-inline-start:12px;border-inline-start:2px solid var(--dsw-alias-border-l1)}.slp-btn{box-sizing:border-box;max-width:100%;white-space:normal;overflow-wrap:anywhere}',
      '.slp-btns{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.slp-input-num{width:96px}.slp-input-cred{width:min(260px,100%)}.slp-source-list{gap:0}',
      '.slp-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 85%,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;font-family:inherit;transition:border-color var(--slp-ui) var(--slp-ease),background var(--slp-ui) var(--slp-ease),color var(--slp-ui) var(--slp-ease),transform var(--slp-tap) var(--slp-ease)}',
      // Update affordance: accent outline plus a slow breathing dot, and the same
      // 70ms press as every other button. Absent entirely when there is nothing to install.
      '.slp-update{display:inline-flex;align-items:center;gap:6px;border-color:var(--slp-accent);color:var(--slp-accent)}.slp-update:hover:not(:disabled){border-color:var(--slp-accent);background:color-mix(in srgb,var(--slp-accent) 10%,transparent)}.slp-update:disabled{opacity:.6}.slp-update-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:slp-breathe 2.4s ease-in-out infinite}.slp-update-note{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '@keyframes slp-breathe{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}',
      '.slp-btn:hover{border-color:var(--dsw-alias-brand-primary)}.slp-btn:active:not(:disabled){transform:scale(.98)}.slp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}.slp-btn-sm{padding:3px 10px}.slp-btn-icon{padding:2px 7px}',
      '@media(max-width:480px){.slp-master{padding:4px 0}.slp-setting-children{margin-inline-start:0;padding-inline-start:2px;border-inline-start-width:1px}.slp-btn{padding-inline:4px}}',
      '.slp-msg{font-size:12px;padding:6px 10px;border-radius:8px;word-break:break-all}',
      '.slp-tools .slp-activity-trigger{overflow-wrap:anywhere}.slp-preview :is(.slp-tps,.slp-context-pct,.slp-activity-trigger,.slp-cost-trigger){white-space:normal;overflow-wrap:anywhere}',
      '.slp-layout-editor,.slp-layout-block{display:flex;flex-direction:column;gap:10px;min-width:0}.slp-subhead{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;min-width:0}.slp-subhead-title{display:inline-flex;align-items:center;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}.slp-segmented{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0;max-width:100%}.slp-preset-custom{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-inline-start:4px}.slp-order-list{padding:0 8px;margin:0;list-style:none;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.slp-order-item{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-width:0;padding:4px 0}.slp-order-item + .slp-order-item{border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}.slp-order-item > .slp-check{flex:1;min-width:0}.slp-order-actions{display:inline-flex;flex-wrap:wrap;gap:4px}.slp-btn:disabled{opacity:.4;cursor:default}.slp-preview{--slp-gap:16px;min-width:0;max-width:100%;padding:12px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:max(13px,var(--dsh-content-font-size-secondary,13px));line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;box-sizing:border-box}.slp-preview .slp-row{width:100%}.slp-tool-name{max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.slp-activity-meta{font-size:inherit;color:var(--dsw-alias-label-tertiary)}',
      '.slp-ok{color:var(--dsw-alias-state-success-primary)}',
      '.slp-preview .slp-group{white-space:normal;overflow-wrap:anywhere}.slp-order-actions{min-width:0;max-width:100%}@media(max-width:480px){.slp-preview{padding:4px 0}.slp-order-actions .slp-btn{padding-inline:3px}.slp-hint:is(:hover,:focus)::after{position:fixed;inset-inline:16px;top:auto;bottom:16px;width:auto;max-width:none}.slp-preview .slp-context{column-gap:2px}}',
      '.slp-layout-editor{overflow-wrap:anywhere}.slp-order-list{min-width:0;max-width:100%}',
      // ---- Context gauge details, unified quota states, scroll fade, motion ----
      '.slp-context-trigger{display:inline-flex;align-items:center;gap:6px;font:inherit;color:inherit;background:none;border:0;border-radius:4px;padding:2px 0;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums;transition:background var(--slp-ui) var(--slp-ease),color var(--slp-ui) var(--slp-ease)}.slp-context-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.slp-context-trigger:focus-visible,.slp-activity-trigger:focus-visible,.slp-cost-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}',
      '.slp-panel.slp-context-panel{bottom:calc(100% + 8px);min-width:0;width:min(248px,calc(100vw - 24px));white-space:normal}.slp-context-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.slp-context-big{font-size:13px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums}.slp-context-track{display:block;height:4px;margin:6px 0 4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 20%,transparent);overflow:hidden}.slp-context-fill{display:block;height:100%;border-radius:999px;min-width:2px}.slp-context-meta{display:flex;justify-content:space-between;gap:8px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}.slp-context-section{margin:8px 0 2px;padding-top:6px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);font-weight:500;color:var(--dsw-alias-label-secondary)}.slp-context-panel .slp-panel-note{margin:4px 0 0;font-size:11px;line-height:16px}.slp-cost-tint[data-kind="read"]{background:var(--dsw-alias-label-secondary)}.slp-cost-tint[data-kind="write"]{background:var(--dsw-alias-label-tertiary)}',
      '.slp-quota-trigger[data-state="error"],.slp-quota-trigger[data-state="retrying"],.slp-quota-trigger[data-state="exhausted"]{opacity:1}.slp-quota-reason{color:var(--dsw-alias-state-warn-label)}.slp-quota-trigger[data-state="error"] .slp-quota-reason{color:var(--dsw-alias-state-error-primary)}.slp-quota-retry{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.slp-quota-trigger[data-state="exhausted"] .slp-quota-retry{color:var(--dsw-alias-brand-primary)}.slp-quota-trigger[data-state="loading"]{cursor:default}',
      '.slp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}',
      '.slp-panel-scroll{max-height:min(55vh,360px);overflow-y:auto;overscroll-behavior:contain}.slp-panel-scroll[data-fade="bottom"]{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 20px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 20px),transparent)}.slp-panel-scroll[data-fade="top"]{-webkit-mask-image:linear-gradient(to top,#000 calc(100% - 20px),transparent);mask-image:linear-gradient(to top,#000 calc(100% - 20px),transparent)}.slp-panel-scroll[data-fade="both"]{-webkit-mask-image:linear-gradient(to bottom,transparent,#000 20px,#000 calc(100% - 20px),transparent);mask-image:linear-gradient(to bottom,transparent,#000 20px,#000 calc(100% - 20px),transparent)}',
      '.slp-panel-status{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warn-label)}.slp-panel-status[data-state="exhausted"]{color:var(--dsw-alias-state-error-primary)}',
      // First paint of the settings form: placeholder rows instead of a bare
      // "Loading…" line, so the page does not jump when the form arrives.
      '.slp-skel{display:flex;flex-direction:column;gap:10px;padding:4px 2px}.slp-skel-row{position:relative;height:10px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);overflow:hidden}.slp-skel-row::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent) 50%,transparent 70%);animation:slp-shimmer 1.2s linear infinite}',
      '@media (prefers-reduced-motion: reduce){.slp-chip-fade{animation:none}.slp-panel{animation:none}.slp-hint:is(:hover,:focus)::after{animation:none}.slp-skel-row::after{animation:none}.slp-update-dot{animation:none}.slp-root *,.slp-panel,.slp-panel *,.slp-quota-root *,.slp-set *,.slp-preview *{transition:none!important}}',
      '.slp-provider-state.slp-source-enabled{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 75%,var(--dsw-alias-label-secondary))}.slp-drag-handle{flex:none;width:20px;white-space:nowrap;letter-spacing:-.25em;max-width:100%;min-height:24px;padding:0;border:0;border-radius:4px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:grab;touch-action:none;user-select:none;box-sizing:border-box}.slp-drag-handle:hover{background:var(--dsw-alias-interactive-bg-hover)}.slp-drag-handle:active{cursor:grabbing}.slp-drag-handle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.slp-drag-handle:disabled{cursor:default}.slp-order-item[data-dragging="true"]{opacity:.6;background:var(--dsw-alias-bg-layer-2)}.slp-order-item[data-drop="before"]{box-shadow:0 -2px 0 var(--dsw-alias-brand-primary)}.slp-order-item[data-drop="after"]{box-shadow:0 2px 0 var(--dsw-alias-brand-primary)}',
    ].join('\n')

    // ---------------- 国际化（跟随 dsh 语言设置，默认跟随系统语言） ----------------
    var CTX = null
    var STR = {
      zh: {
        gitBranchNone: '(无分支)', gitStaged: '暂存', gitUnstaged: '未暂存',
        gitUntracked: '未跟踪', gitConflict: '冲突',
        gitTitle: 'git 工作区状态（点击刷新）',
        gitRetry: '点击重试', gitUntrackedUnknown: '未跟踪文件过多，未统计',
        gitErrNotFound: '未找到 git，请确认工作区所在机器已安装 git',
        gitErrUnsafe: 'git 拒绝读取此仓库：它属于其他用户。如果信任它，可运行 git config --global --add safe.directory <路径>',
        gitErrTooMany: 'git 输出过多，无法读取此仓库的状态',
        gitErrTimeout: 'git 未及时响应，仓库可能位于慢速磁盘或网络挂载上',
        gitErrInvalidCwd: '工作区路径无效，请检查设置中的路径',
        gitErrFailed: 'git 无法读取此仓库，可在该目录运行 git status 查看原因',
        gitErrNetwork: '无法连接 DSH 服务',
        gitStale: '刷新失败，显示上次结果', gitLinesUnknown: '行数统计不可用',
        gitDiffTitle: '暂存与未暂存改动量之和；不是相对 HEAD 的净变化，不含未跟踪文件',
         contextLabel: 'CTX',
        gitNoWorkspace: '未找到工作区路径',
        quotaFail: '额度获取失败', quotaNetworkShort: '网络异常', quotaTimeoutShort: '连接超时',
        quotaRateShort: '请求限流', quotaUnavailableShort: '暂不可用',
        quotaInvalidResponseShort: '响应异常', quotaNotFoundShort: '未找到', quotaDisabledShort: '已关闭',
        quotaUnauthorizedShort: '需要登录', quotaForbiddenShort: '请求被拒', quotaAbortedShort: '已取消', quotaBusyShort: '繁忙',
        quotaRetryExhaustedShort: '已重试3次', quotaRetryExhausted: '自动重试已用完；重新获得焦点、网络恢复或手动刷新可重试',
        opencodeShort: 'OpenCode',
        detailTitle: 'OpenCode 额度用量',
        refreshNow: '刷新', clickRetry: '点击重试', clickDetails: '点击查看详情并刷新',
        quotaUsedPct: '已用 {p}%', quotaLeftPct: '剩余 {p}%', quotaModeUsed: '已用', quotaModeLeft: '剩余',
        quotaAge: '{age}前更新', quotaStaleAge: '刷新失败 · {age}前更新',
        quotaSourceLabel: '来源 {source}', quotaSourceMagpie: 'Magpie', quotaSourceMagpieTitle: '读取本机 Magpie 网关汇总的额度',
        quotaSourceCpa: 'CPA 账号', quotaSourceCpaTitle: '用 CLI Proxy API 的账号文件直接查询上游',
        setQuotaSource: '额度来源', setQuotaSourceAuto: '不指定', setQuotaSourceDsh: 'DSH 登录',
        quotaSourceOfficial: '官方登录文件', quotaSourceOfficialTitle: '读取该订阅官方工具的登录文件，再查询官方接口',
        magpieAccounts: '共 {n} 个账号，显示第一个仍有额度的', quotaPlan: '套餐 {plan}', setSubscriptionPinOnly: '这个订阅没有 API Key，只查询额度。',
        setQuotaSourceHint: '不指定时依次尝试 Magpie、CPA 等工具，再读官方工具的登录文件。指定后只读这一个来源，不再回退。登录只读取，不会刷新或改写，令牌只发给该服务的官方接口。',
        antigravityGeminiHidden: '这个来源没有返回 Gemini 额度，显示的可能只是 Claude/GPT 额度；可通过 Magpie 查看完整额度。',
        quotaSourceDirect: '服务商接口', quotaSourceDirectTitle: '用你配置的密钥直接查询服务商接口',
        quotaSourceHost: 'DSH 账号', quotaSourceHostTitle: '通过 DSH 已登录的账号读取',
        quotaCacheExpired: '缓存已到期；下次 step、页面重新可见或点击时更新',
        quotaLoading: '正在获取额度…', quotaAuthShort: '凭据无效', quotaNoCredShort: '未配置', 
        quotaSignedOutShort: '未登录账号', quotaNoAccountShort: '账号服务不可用',
        quotaRetryInShort: '{s} 后重试', quotaRetryIn: '第 {n}/3 次自动重试将在 {s} 后进行',
        quotaShowingLast: '显示上次成功数据',
        contextTitle: '上下文占用', contextOpen: '点击查看上下文详情', contextPct: '已占用 {p}%', contextLeft: '剩余 {n}',
        contextHint: '按最近一次请求的提示词大小加上此后的增量估算，与原生圆环同源；仅供参考，不是计费数据。',
        contextSession: '本会话累计 token', contextUncached: '未缓存输入', contextCacheRead: '缓存读取', contextCacheWrite: '缓存写入', contextOutput: '输出',
        contextCacheMisses: '（{n} 次未命中）', contextCacheHit: '输入缓存命中 {p}%', contextCompactions: '已压缩 {n} 次', costPerHour: '每小时 {v}', contextCacheHitHint: '缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入），按本会话全部请求累计。',
        quotaRefreshFailed: '刷新失败，保留上次成功数据', quotaFetchedTitle: '上次成功获取：{time}；数据年龄：{age}',
        modelQuotaFailed: '配额读取失败：{reason}，将自动重试', modelQuotaStale: '本次刷新失败，读数来自上次成功获取',
        quotaAdviceNetwork: '网络不可用；恢复后会自动重试。', quotaAdviceTimeout: '请求超时；稍后会自动重试。',
        quotaAdviceRate: '被服务限流；等待后会自动重试，或把刷新间隔调长。', quotaAdviceAuth: '凭据被拒绝；请在设置中更新 API Key。',
        quotaAdviceNoCred: '还没有配置凭据；请在设置里填入 API Key。', quotaAdviceSignedOut: '需要登录；请在 DSH 中重新登录该账号。',
        quotaAdviceNoAccount: '没有找到可用账号；确认该订阅已关联账号。', quotaAdviceParse: '返回内容无法解析；接口可能已变化，请检查插件更新。',
        quotaAdviceNotFound: '没有这个接口；确认对应服务已启用，或插件版本已更新。', quotaAdviceDisabled: '该项已在设置里关闭。',
        quotaAdviceUnauthorized: '登录已失效；请重新登录。', quotaAdviceForbidden: '没有访问权限；检查账号权限或网络区域。',
        quotaAdviceAborted: '请求被取消；下次聚焦时会重新尝试。', quotaAdviceBusy: '服务繁忙；稍后会自动重试。',
        quotaAdviceUnknown: '暂时读不到；稍后会自动重试。',
        healthTitle: '运行状况', healthWire: '宿主与页面 bundle 的接口版本不一致：宿主 wire {host}，当前 bundle 期望 {client}。先刷新页面；若仍不一致，说明宿主半身未更新，需要重启 DSH。', healthFault: '「{slot}」渲染失败：{message}',
        tpsPrevious: 'TPS 上次', tpsAverage: '本次生成的平均速度', tpsEstimated: '字符估算', tpsMeasured: '按实际 output usage 结算', activityRunning: '运行 {n}', activityDone: '已停止 {n}', activityUnknown: '状态未知 {n}',
        activityTitle: '本会话的 Subagents', activityRunningState: '运行中', activityStoppedState: '已停止', activityUnknownState: '状态未知',
        activitySummary: 'Subagents {stopped}/{total}', activitySummaryTitle: '已结束 / 总数；{active} 运行 · {stopped} 已停止 · {unknown} 未知；点击查看详情。已停止不代表成功；停止 5 秒后淡出，15 秒后隐藏，仍计入进度。',
        activityOneShot: '单次', activityContinuable: '可继续', activityExternal: '外部任务', activityModeUnknown: '模式未知', activityLastModel: '最近实际使用模型', activityEffort: '最近使用的推理强度',
        toolsLabel: '工具', toolsTitle: '当前会话的工具调用', toolsTimingHint: '时间从调用记录到结果提交，包含审批与等待；不是精确执行耗时。不展示参数或结果正文。',
        toolsRunning: '等待结果', toolsCompleted: '已完成', toolsFailed: '失败', toolsCancelled: '已取消', toolsNotStarted: '未启动', toolsUnknown: '结果未知', toolsStopped: '已停止，结果未知', toolsIncomplete: '列表已截断，总数未知',
        layoutPresets: '布局预设', layoutBalanced: '均衡', layoutMinimal: '精简', layoutActivity: '活动优先', layoutCustom: '自定义',
        layoutHint: '预设只调整底部组件，不影响账号与顶部设置。拖动 ⋮⋮ 或用 ↑↓ 排序，也可以直接在输入框下方拖动组件；隐藏的组件保留位置。',
        layoutDrag: '拖动以排序：{name}', layoutDragHint: '拖动或按 ↑↓ 排序；Esc 取消拖动。',
        layoutExtension: '扩展', layoutReplaced: '已由扩展替换', layoutExtensionTitle: '来自其他插件：{id}',
        layoutOrder: '底部组件', layoutUp: '上移 {name}', layoutDown: '下移 {name}',
        layoutGit: 'Git 工作区', layoutContext: 'CTX 上下文', layoutTps: 'TPS 生成速度', layoutCost: '估算金额', layoutActivityLabel: 'Subagents', layoutTools: '工具活动',
        layoutPreview: '预览', layoutPreviewHint: '示例数据，可点击查看示例详情；不读取账号或会话。实际没有数据的组件会自动隐藏。', layoutPreviewAuto: '随面板宽度', layoutPreviewNarrow: '窄屏 320px', layoutPreviewEmpty: '底部组件均已关闭', costTitle: 'API 参考金额', costUnknown: '未计价', costPartial: '已计价小计',
        costPriced: '已计价 {n} 条', costUnpriced: '未计价 {n} 条', costKind: '类型', costTokens: 'Tokens', costAmount: '金额', costShare: '占比',
        costInput: 'Input', costCache: 'Cache', costOutput: 'Output', costBreakdownPending: '明细待宿主更新', costTokensPending: 'Token 统计待宿主更新',
        costToday: '今日合计 {amount} · {n} 个会话', costTodayUnreadDetail: '读不出 {n} 个会话',
        costTodayUnpriced: '({n} 次未计价)', costTodayLowerBound: '合计是下界',
        costAsOf: 'DeepSeek 人民币表 · {time}',
        configRejected: '宿主拒绝了这次修改，请检查配置（例如额度来源的地址或凭据引用）。',
        costNative: '官方目录 {version} · {time} · {n} 条', costFallback: '内置快照 · {time} · {n} 条',
        costReference: 'OpenRouter 参考价 · {n} 条', costFallbackReference: '内置参考价 · {n} 条',
        costReasonProvider: '无此平台的价格', costReasonModel: '无此模型的价格', costReasonUsage: '缺少或无效 usage', costReasonInconsistent: 'usage 计数不一致', costReasonWrite: '缓存写入单价未知', costReasonRead: '缓存读取单价未知', costReasonTime: '请求时间未知', costReasonHistory: '历史价格未知', costReasonTariff: '峰谷时段未知', costReasonSettlement: '缺少结算 usage', costReasonOverflow: '计价数值超出范围', costReasonPrice: '目录价格无效',
        costSourceNote: '（{list}）',
        setGroupDisplay: '底部状态行', setGroupHeader: '额度与峰谷时段', setGroupWorkspace: 'Git', setGroupSources: '额度来源与账号', setGroupAdvanced: '高级设置',
        setEnabled: '启用 StatusLine', setEnabledHint: '控制本插件的全部显示与刷新。',
        setHideBottomOnNarrow: '窄屏时隐藏底部状态行', setHideBottomOnNarrowHint: '输入区域宽度不超过 480px 时不启动本插件的底部组件；变宽后自动恢复。宿主统计、顶部额度与峰谷指示不受影响。',
        setFillFromDsh: '从 DSH 设置填充', setFillFromDshHint: '读取该厂商在 DSH 模型设置里已配置的凭据引用与地址，只填这张表单，不改你的配置。',
        setFillFromDshDone: '已填入 {v}', setFillFromDshNone: 'DSH 里没有这个厂商的设置', setFillFromDshWait: '读取中…',
        setQuotaOnStep: '每个 step 后按缓存刷新额度', setQuotaOnStepHint: '适用于所有额度来源；同一缓存窗口内不会重复请求，失败中的额度也不会被每一步重试；点击额度芯片仍会立即刷新。',
        setSourceStateHint: '“已启用”表示允许显示该来源；自动选择时只显示当前计费平台，不代表账号已登录或凭据有效。开启来源时会自动展开其配置。',
        setPercentMode: '额度百分比', setPercentModeHint: '顶部芯片与详情统一显示已用或剩余百分比；颜色始终按已用程度变化。',
        setReset: '恢复默认', setResetConfirm: '确认恢复默认？', setResetDone: '已恢复默认 {time}',
        setResetHint: '恢复显示、布局、刷新与高级设置的默认值；保留凭据引用、账号文件、仓库路径与各来源开关。',
        setCredInvalid: '只能填写凭据引用名（字母、数字、下划线），不要粘贴 API Key 明文',
        setQuotaAutoHint: '关闭时固定使用 OpenCode 额度来源。', setNativeContextHint: '原生圆环放在左侧原生统计组的末尾，显示占用比例；CTX 显示已用量 / 窗口容量。',
        setBalanceSource: '余额', setSubscriptionSource: '订阅额度', setSourceEnabled: '已启用', setSourceDisabled: '已停用',
        setDeepseekAccountNote: '模型使用 DeepSeek 账号登录（deepseek-account）时，自动读取登录账号的充值余额与赠送余额；API Key 仅用于 deepseek 提供商的按量余额。',
        setCodexAccount: 'Codex 账号文件名', setAntigravityAccount: 'Antigravity 账号文件名（可选）',
        setCodexAccountHint: '有多个 Codex 账号时需指定文件名。', setAntigravityAccountHint: '留空时按优先级自动选择账号。', setOpenCodeTest: '测试 OpenCode 额度',
        win5h: '5小时', winWeek: '本周', winMonth: '本月',
        codexWinWeek: '周', codexWinMonth: '月',
        codexShort: 'Codex',
        codexDetailTitle: 'Codex 额度用量',
        codexActiveLimit: '当前限额', codexCredits: '额度余额', codexCreditsUnlimited: '额度不限',
        codexFailAuth: 'Codex 凭据无效', codexFailRate: 'Codex 请求被限流，稍后再试',
        codexFailNetwork: 'Codex 网络错误', codexFailNoCred: '未找到 Codex 凭据',
        codexFail: 'Codex 获取失败',
        // The header slot is narrow; the details panel keeps the full name.
        antigravityShort: 'Agy',
        antigravityUnknown: '额度未知', antigravityThirdParty: '第三方 5小时', antigravityThirdPartyWeekly: '第三方 本周', quotaUnknownShort: '未知', subscriptionNotFound: '未找到订阅', antigravityPriority: '优先级 {n}',
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
        providerFailSignedOut: '未登录 DeepSeek 账号', providerFailNoAccount: 'DeepSeek 账号服务未启用',
        providerFail: '额度获取失败',
        providerBalanceTitle: '{label} 余额 {r}', providerTotal: '合计',
        providerGranted: '赠送余额 {v}', providerToppedUp: '充值余额 {v}',
        providerUnavailable: '账号当前不可用', providerAvailable: '账号可用',
        providerWindowTitle: '{label}: {v}', providerResetTitle: '重置剩余 {r}',
        peakStatus: '峰', offPeakStatus: '谷', peakUnknown: '时段未核实',
        peakToOff: '距谷', peakToPeak: '距峰', peakTitle: 'DeepSeek 官方峰谷时段',
        peakRule: '北京时间周一至周五（法定节假日除外）09:00–12:00、14:00–18:00 为峰；其他时间、周末与节假日全天为谷，谷价为峰的一半。',
        peakCalendarUnknown: '节假日日历尚未覆盖该年份，下一次峰段开始时间未确认。',
        peakHoliday: '中国法定节假日：{name}', peakWeekend: '周末全天为谷', peakHolidayUnnamed: '节假日',
        peakMakeupDay: '调休上班日：官方说明周末全天为谷，仍按谷显示',
        peakRuleChanged: '官网的峰谷说明与插件内置规则不一致，规则可能已变更，请核对官方说明。', peakRuleChangedShort: '规则可能已变更',
        peakRatesChanged: '官网价格与内置费率表不一致：{list}。估算可能已偏高或偏低，核对后再改内置表。', peakRatesUnreadable: '官方价格页的结构可能已变化，这次没能核对价格。',
        peakRatesStale: '内置费率表已 {n} 天没和官网核对过。', peakRateItem: '{what} {from} → {to} 元/百万', peakRateDiscount: '谷价折扣 {from} → {to}', peakChecked: '官网核对：{when}',

        peakSourceFetched: '节假日：官方日历（holiday-cn，每日更新）', peakSourceBuiltin: '节假日：插件内置日历',
        peakBeijing: '北京时间', peakLocal: '本地时间', peakNextSwitch: '下次切换（本地时间）',
        peakOfficial: '查看官方规则与最新价格', peakOfficialShort: '官方规则 ↗', setShowDeepseekPeak: 'DeepSeek 直连会话顶部显示峰/谷', setShowPeakDot: '左下角显示峰/谷指示点（无需打开会话）', setPeakCountdown: '显示峰/谷切换倒计时',
        setResetAlerts: '订阅额度重置提醒', setResetAlertsAuto: '自动', setResetAlertsOn: '开启', setResetAlertsOff: '关闭',
        setResetAlertsHint: '官方账号宣布 Codex、Antigravity、Claude、Grok 全员额度重置或发放重置卡时，从额度框下方划出提醒（数据来自 AIHOT，每 10 分钟检查一次）。自动：模型列表中有对应订阅的模型时才提醒，Grok 需手动勾选；开启：提醒勾选的订阅；关闭：不访问 AIHOT。只提醒未来 24 小时内将要发生、或最近 24 小时内已完成的重置；点「知道了」后不再划出，额度框详情里仍可查看。',
        setResetAlertSeconds: '提醒停留（秒）',
        resetDirectSoon: '{name} {when}重置额度', resetDirectDone: '{name} {when}重置额度', resetCreditSoon: '{name} {when}发放重置卡', resetCreditDone: '{name} {when}发放重置卡', resetDoneAt: '已于{time} ',
        resetToday: '今天', resetTomorrow: '明天', resetYesterday: '昨天', resetEstimateNote: '（estimated）',
        resetAt: '预计{time} ', resetAbout: '预计{time} 左右', resetBefore: '预计{time} 前', resetOnDate: '预计 {time}（北京时间）', resetEstimate: '可能在{time} ',
        resetTimeUnknown: '即将', resetSourceTitle: '来源：AIHOT', resetPost: '原帖 ↗', setResetGrokHint: 'Grok 只读取 AIHOT 的重置公告：不按模型自动判断，也不读取 Grok 的额度；默认不勾选，勾选后才提醒',
        resetAck: '知道了', resetAckHint: '不再自动划出这些提醒；点开额度框的详情仍可查看', resetSectionTitle: '额度重置',
        providerRedBelowTitle: '余额低于 {v} 变红',
        setProviderRedBelow: '余额低于变红', setProviderRedBelowPh: '如 10',
        setProviderCredential: 'API 凭据引用（非明文密钥）',
        setAutoSaveHint: '自动保存',
        setAutoSaving: '自动保存中…',
        setAutoSavedAt: '已自动保存 {time}',
        setAutoSaveFail: '保存失败，再次修改时重试',
        setUpdateTo: '更新到 {0}',
        setUpdateApplying: '更新中…',
        setUpdateApplied: '已更新 · 刷新页面',
        setUpdateRestart: '重启后生效',
        setUpdatePending: '已安装 · 刷新确认',
        setUpdateIncompatible: '新版 {0} 需要 DSH {1}',
        setUpdateIncompatibleTitle: '当前插件 {0}，DSH {1}。升级 DSH 后才能更新到 {2}',
        setUpdateFailed: '更新失败',
        setUpdateNoManager: '找不到可用的安装命令，请在终端执行 dsh plugin add dsh-statusline-plus@latest',
        setUpdateTitle: '当前 {0} → 最新 {1}',
        setGroupRestart: '重新加载与 DSH 更新',
        setShowRestartButton: '启用左下角的重新加载 / 重启 / DSH 更新按钮',
        setShowRestartButtonHint: '关闭后按钮隐藏，宿主也不再检查 DSH 新版本、不接受重启请求。宿主不支持的环境中按钮自动隐藏。',
        setUpdateRestartNow: '重启以生效',
        rsTitle: '重新加载 DSH（应用插件与配置改动）',
        rsConfirmTitle: '重新加载 DSH？',
        rsConfirmBody: '先热重载改动，会话不中断；若有改动必须重启才能生效，会接着重启服务，运行中的会话和回合将被中断。',
        rsConfirmBodySoft: '热重载插件与配置改动，会话不中断。',
        rsReload: '重新加载', rsRestart: '完全重启', rsCancel: '取消',
        rsReloading: '正在热重载插件与配置…',
        rsStopping: '正在重启服务…',
        rsWaiting: '等待服务重新上线…',
        rsBooting: '服务已拉起，正在加载插件与会话…',
        rsDone: '已就绪，正在刷新页面…',
        rsSlow: '耗时比平常长，仍在检测。',
        rsReloadNow: '立即刷新', rsRetry: '重试', rsDismiss: '关闭',
        rsFailTitle: '重启未完成',
        rsFailSystemctl: '系统未能重启服务，可以重试。日志：journalctl --user -u {0} -n 100',
        rsFailRequest: '请求被拒绝，或暂时无法连接到服务。',
        rsManualTitle: '需要手动重启',
        rsManual: '部分改动必须重启 DSH 才能生效（{0}），当前环境不支持一键重启。',
        rsUnknownTitle: '未能确认结果',
        rsActive: '当前有 {0} 个会话正在运行。热重载不会打断它们；完全重启会中断这些回合。',
        rsActiveUnknown: '无法确认是否有会话正在运行；完全重启会中断所有正在进行的回合。',
        rsConfirmNeededTitle: '还需要重启才能完全生效',
        rsConfirmNeeded: '热重载已完成，但部分改动要重启后才生效（{0}）。',
        rsConfirmNeededActive: '热重载已完成，但部分改动要重启后才生效（{0}）。{1} 个会话正在运行，重启会中断它们。',
        rsLater: '稍后', rsRestartNow: '立即重启',
        rsUpdateTitle: 'DSH 有新版本 {0}：点击更新或重新加载',
        rsUpdateInfo: 'DSH 有新版本 {0}（当前 {1}）。更新会安装新版、刷新 profile 依赖并重启服务，更新期间服务会停止。',
        rsUpdate: '更新 DSH',
        rsUpdating: '正在下载并安装 DSH {0}…',
        rsUpdatingHint: '更新期间服务会停止；完成后自动刷新页面。',
        rsProgressTitle: '正在更新 DSH {0}',
        rsProgressHint: '更新期间服务会停止；完成后页面自动刷新。',
        rsProgressDoneTitle: 'DSH 更新完成',
        rsProgressDoneHint: '新版本已启动，正在刷新页面。',
        rsProgressStoppedHint: '更新已停止；服务已恢复或等待恢复，可查看日志后重试。',
        rsProgressFailedTitle: 'DSH 更新失败',
        rsProgressRolledBackTitle: 'DSH 更新失败，已回滚',
        rsProgressLabel: '更新进度',
        rsStepStop: '停止服务',
        rsStepInstall: '下载并安装新版本',
        rsStepReconcile: '刷新 profile 依赖',
        rsStepStart: '启动并验证',
        rsElapsed: '已用时 {0} 秒',
        rsLogPath: '日志：{0}',
        rsCopyLog: '复制日志命令',
        rsCopied: '已复制',
        rsRetryUpdate: '重试更新',
        rsReconcileSkipped: '已跳过：未找到 pnpm',
        rsReconcileNotNeeded: '已跳过：无需刷新 profile 依赖',
        rsCheckExecStart: '请检查服务单元的 ExecStart 是否仍指向旧安装。',
        rsProgressRolledBack: '更新失败，已回滚到 {0}。服务已恢复。',
        rsProgressFailed: '更新失败，服务可能尚未恢复。',
        rsProgressStale: '重启后仍是旧版本 {0}（期望 {1}）。',
        rsProgressNoVersion: '新进程没有报告版本，无法确认更新已生效。',
        rsProgressUnknown: '更新结果未知（超时）。',
        rsErrInstall: '安装新版本失败。',
        rsErrReconcile: '刷新 profile 依赖失败。',
        rsErrStart: '新版本启动失败。',
        rsErrRollback: '回滚失败，服务可能未恢复。',
        rsErrHelper: '更新助手未能启动。',
        rsErrStop: '停止服务失败。',
        rsErrUnknown: '未知错误。',
        rsFailUpdate: '更新未完成；若安装已开始，服务会自动回滚并恢复。日志：journalctl --user -u {0} -n 100',
        rsUnknown: '一分钟内未确认服务恢复，已停止检测，未再次发起重启。',
        setProviderHint: '填写 DSH 凭据引用或环境变量名，不要填写 API Key 明文。内置引用：DEEPSEEK_API_KEY、KIMI_API_KEY、ZAI_API_KEY、ZAI_CODING_CN_API_KEY、OPENROUTER_API_KEY；按会话的计费 provider 匹配后切换显示。',
        setQuotaAuto: '按会话的计费平台自动选择额度来源',
        setQuotaShowAll: '同时显示所有订阅额度',
        setQuotaShowAllHint: '不按模型选择，并排显示已启用的 Codex / Antigravity / Claude / OpenCode，以及 Magpie 里读到的其他订阅。',
        setModelQuotaBar: '模型按钮显示额度条', setModelQuotaBarHint: '空会话里，输入框上方的模型按钮会带一条订阅额度细线；发出第一条消息后隐藏，把位置让给顶部芯片。',
        setModelQuotaRows: '模型列表显示各订阅额度', setModelQuotaRowsHint: '打开模型选择器时，每个模型按它对应的订阅显示额度细线；余额型来源显示金额。',
        modelQuotaBalance: '余额 {v}',
        setTitle: '状态栏',
        setDesc: '顶部显示额度与峰谷时段，输入框下方显示会话指标与 Git。', setApiKeyEnvPh: 'OPENCODE_GO_API_KEY',
        setUsageUrl: 'Usage API 地址（可选）', setUsageUrlPh: 'https://opencode.ai/zen/go/v1/usage',
        setCacheTtl: '额度缓存复用时间（秒）', setFetchTimeout: '额度请求超时（秒）',
        setCacheTtlHint: '默认 60 秒，实际最少 15 秒：这段时间内自动查询复用上次结果。到期不自动轮询，下一次 step、重新进入可见页面时才查询；点击额度绕过成功缓存。缩短可更及时，但查询更多；限流时仍需等待重试。',
        setGitCwd: '仓库目录覆盖（可选，默认用当前会话工作区）', setGitCwdPh: '如 ~/Projects/my-repo',
        setShowQuota: '显示顶部额度', setShowCwd: '显示仓库路径',
        tpsTitle: '生成中按文本/推理/工具参数的字符数估算 token 速率；完成后优先用真实 usage 按首 token 到完成时间结算，不含工具执行时间。显示四舍五入为整数，最快每 25ms 更新。',
        tpsHeld: '等待新速率，暂留最近有效值（非当前速率）', tpsCompleted: '已完成', tpsInterrupted: '已中断', tpsUnavailable: '连接恢复中', setLoading: '加载中…',
        saveFail: '保存失败', needSaveFirst: '（测试前需先保存）',
        testOk: '连接成功：5h {r}% · 周 {w}% · 月 {m}%',
        testFail: '连接失败',
      },
      en: {
        gitBranchNone: '(no branch)', gitStaged: 'staged', gitUnstaged: 'unstaged',
        gitUntracked: 'untracked', gitConflict: 'conflict',
        gitTitle: 'git workspace status (click to refresh)',
        gitRetry: 'Click to retry', gitUntrackedUnknown: 'Too many untracked files to count',
        gitErrNotFound: 'Git was not found. Check that it is installed on the machine holding this workspace',
        gitErrUnsafe: 'Git refuses to read this repository because another user owns it. If you trust it, run git config --global --add safe.directory <path>',
        gitErrTooMany: 'Git printed too much to read the status of this repository',
        gitErrTimeout: 'Git did not answer in time. The repository may be on a slow disk or network mount',
        gitErrInvalidCwd: 'The workspace path is invalid. Check the path in settings',
        gitErrFailed: 'Git could not read this repository. Run git status in that directory to see why',
        gitErrNetwork: 'Could not reach the DSH service',
        gitStale: 'Refresh failed; showing the last result', gitLinesUnknown: 'Line statistics unavailable',
        gitDiffTitle: 'Staged + unstaged changes, not net changes against HEAD; excludes untracked files',
         contextLabel: 'CTX',
        gitNoWorkspace: 'workspace path not found',
        quotaFail: 'quota fetch failed', quotaNetworkShort: 'network error', quotaTimeoutShort: 'timeout',
        quotaRateShort: 'rate limited', quotaUnavailableShort: 'unavailable',
        quotaInvalidResponseShort: 'bad response', quotaNotFoundShort: 'not found', quotaDisabledShort: 'disabled',
        quotaUnauthorizedShort: 'sign-in needed', quotaForbiddenShort: 'request rejected', quotaAbortedShort: 'cancelled', quotaBusyShort: 'busy',
        quotaRetryExhaustedShort: '3 retries used', quotaRetryExhausted: 'Automatic retries exhausted; refocus, reconnect or refresh to try again',
        opencodeShort: 'OpenCode',
        detailTitle: 'OpenCode usage',
        refreshNow: 'Refresh', clickRetry: 'click to retry', clickDetails: 'click for details and refresh',
        quotaUsedPct: '{p}% used', quotaLeftPct: '{p}% left', quotaModeUsed: 'used', quotaModeLeft: 'left',
        quotaAge: 'Updated {age} ago', quotaStaleAge: 'Refresh failed · updated {age} ago',
        quotaSourceLabel: 'Source: {source}', quotaSourceMagpie: 'Magpie', quotaSourceMagpieTitle: 'Read from the local Magpie gateway',
        quotaSourceCpa: 'CPA account', quotaSourceCpaTitle: 'Queried upstream with a CLI Proxy API account file',
        setQuotaSource: 'Quota source', setQuotaSourceAuto: 'None', setQuotaSourceDsh: 'DSH login',
        quotaSourceOfficial: 'Official login file', quotaSourceOfficialTitle: 'Read the official tool\'s login file, then queried the official endpoint',
        magpieAccounts: '{n} accounts; showing the first with quota left', quotaPlan: 'Plan: {plan}', setSubscriptionPinOnly: 'This subscription needs no API key; it only reads quota.',
        setQuotaSourceHint: 'With none selected, tools such as Magpie and CPA are tried first, then the official tool\'s login file. A selected source is the only one read, with no fallback. Logins are only read, never refreshed or rewritten, and a token goes only to that service\'s official endpoint.',
        antigravityGeminiHidden: 'This source returned no Gemini quota, so this may show only the Claude/GPT quota; Magpie shows the full quota.',
        quotaSourceDirect: 'Provider API', quotaSourceDirectTitle: 'Queried the provider directly with your configured key',
        quotaSourceHost: 'DSH account', quotaSourceHostTitle: 'Read through the account signed in to DSH',
        quotaCacheExpired: 'Cache expired; updates on the next step, when the page becomes visible, or on click',
        quotaLoading: 'Loading quota…', quotaAuthShort: 'auth failed', quotaNoCredShort: 'not set up', 
        quotaSignedOutShort: 'signed out', quotaNoAccountShort: 'account unavailable',
        quotaRetryInShort: 'retry in {s}', quotaRetryIn: 'Automatic retry {n}/3 in {s}',
        quotaShowingLast: 'showing the last successful data',
        contextTitle: 'Context usage', contextOpen: 'click for context details', contextPct: '{p}% used', contextLeft: '{n} left',
        contextHint: 'Estimated from the latest request’s prompt size plus later changes, the same source as the native ring. A reference, not billing data.',
        contextSession: 'Session token totals', contextUncached: 'Uncached input', contextCacheRead: 'Cache read', contextCacheWrite: 'Cache write', contextOutput: 'Output',
        contextCacheMisses: ' ({n} misses)', contextCacheHit: 'Input cache hit {p}%', contextCompactions: 'Compacted {n}×', costPerHour: '{v} per hour', contextCacheHitHint: 'Cache read ÷ (uncached input + cache read + cache write), summed over every request in this session.',
        quotaRefreshFailed: 'Refresh failed; retaining the last successful data', quotaFetchedTitle: 'Last successful fetch: {time}; data age: {age}',
        modelQuotaFailed: 'Quota read failed: {reason}; retrying automatically', modelQuotaStale: 'This refresh failed; the figure is from the last successful read',
        quotaAdviceNetwork: 'Network unavailable; retrying resumes automatically.', quotaAdviceTimeout: 'The request timed out; it retries automatically.',
        quotaAdviceRate: 'The service is rate limiting; it retries after a wait, or raise the refresh interval.', quotaAdviceAuth: 'The credential was rejected; update the API key in Settings.',
        quotaAdviceNoCred: 'No credential yet; add the API key in Settings.', quotaAdviceSignedOut: 'Sign-in needed; sign in to that account again in DSH.',
        quotaAdviceNoAccount: 'No account found; check that the subscription has one linked.', quotaAdviceParse: 'The response could not be parsed; the endpoint may have changed, check for a plugin update.',
        quotaAdviceNotFound: 'No such endpoint; check the service is enabled and the plugin is current.', quotaAdviceDisabled: 'Turned off in Settings.',
        quotaAdviceUnauthorized: 'The sign-in expired; sign in again.', quotaAdviceForbidden: 'Access denied; check the account permissions or network region.',
        quotaAdviceAborted: 'The request was cancelled; it retries when the page regains focus.', quotaAdviceBusy: 'The service is busy; it retries automatically.',
        quotaAdviceUnknown: 'No reading right now; it retries automatically.',
        healthTitle: 'Health', healthWire: 'Host and bundle disagree about the interface version: host wire {host}, this bundle expects {client}. Reload the page first; if it persists, the host half was not updated and DSH needs a restart.', healthFault: 'Failed in "{slot}": {message}',
        tpsPrevious: 'TPS last', tpsAverage: 'Average speed for this generation', tpsEstimated: 'Character estimate', tpsMeasured: 'Settled from actual output usage', activityRunning: '{n} running', activityDone: '{n} stopped', activityUnknown: '{n} unknown',
        activityTitle: 'Subagents of this session', activityRunningState: 'Running', activityStoppedState: 'Stopped', activityUnknownState: 'Status unknown',
        activitySummary: 'Subagents {stopped}/{total}', activitySummaryTitle: 'Finished / total; {active} running · {stopped} stopped · {unknown} unknown; click for details. Stopped does not imply success; fades after 5s and hides after 15s but still counts toward progress.',
        activityOneShot: 'One-shot', activityContinuable: 'Continuable', activityExternal: 'External task', activityModeUnknown: 'Mode unknown', activityLastModel: 'Last used model', activityEffort: 'Last used reasoning effort',
        toolsLabel: 'Tools', toolsTitle: 'Tool calls in this session', toolsTimingHint: 'Time spans the call record to result submission, including approvals and waiting; it is not exact execution time. Arguments and result bodies are excluded.',
        toolsRunning: 'Awaiting result', toolsCompleted: 'Completed', toolsFailed: 'Failed', toolsCancelled: 'Cancelled', toolsNotStarted: 'Not started', toolsUnknown: 'Outcome unknown', toolsStopped: 'Stopped; outcome unknown', toolsIncomplete: 'List truncated; total unknown',
        layoutPresets: 'Layout presets', layoutBalanced: 'Balanced', layoutMinimal: 'Minimal', layoutActivity: 'Activity first', layoutCustom: 'Custom',
        layoutHint: 'Presets change bottom components only, never accounts or header settings. Drag ⋮⋮ or use ↑↓ to reorder, or drag a component in the row below the composer; hidden components keep their position.',
        layoutDrag: 'Drag to reorder {name}', layoutDragHint: 'Drag or use arrow keys to reorder; Esc cancels dragging.',
        layoutExtension: 'Extension', layoutReplaced: 'Replaced by extension', layoutExtensionTitle: 'From another plugin: {id}',
        layoutOrder: 'Bottom components', layoutUp: 'Move {name} up', layoutDown: 'Move {name} down',
        layoutGit: 'Git workspace', layoutContext: 'CTX context', layoutTps: 'TPS generation speed', layoutCost: 'Estimated amount', layoutActivityLabel: 'Subagents', layoutTools: 'Tool activity',
        layoutPreview: 'Preview', layoutPreviewHint: 'Sample data; click for sample details. No accounts or sessions are read. Components without real data hide in the actual bar.', layoutPreviewAuto: 'Panel width', layoutPreviewNarrow: 'Narrow 320px', layoutPreviewEmpty: 'All bottom components are hidden', costTitle: 'API reference cost', costUnknown: 'Unpriced', costPartial: 'Priced subtotal',
        costPriced: '{n} priced', costUnpriced: '{n} unpriced', costKind: 'Type', costTokens: 'Tokens', costAmount: 'Amount', costShare: 'Share',
        costInput: 'Input', costCache: 'Cache', costOutput: 'Output', costBreakdownPending: 'Breakdown needs Host update', costTokensPending: 'Token counts need Host update',
        costToday: 'Today {amount} · {n} sessions', costTodayUnreadDetail: '{n} unread sessions',
        costTodayUnpriced: '({n} unpriced)', costTodayLowerBound: 'the total is a lower bound',
        costAsOf: 'DeepSeek CNY table · {time}',
        configRejected: 'The host rejected this change; check the configuration (for example a quota endpoint URL or credential reference).',
        costNative: 'Official catalog {version} · {time} · {n} records', costFallback: 'Built-in snapshot · {time} · {n} records',
        costReference: 'OpenRouter reference · {n} records', costFallbackReference: 'Built-in reference · {n} records',
        costReasonProvider: 'No price for this provider', costReasonModel: 'No price for this model', costReasonUsage: 'Missing or invalid usage', costReasonInconsistent: 'Inconsistent usage counts', costReasonWrite: 'Unknown cache-write price', costReasonRead: 'Unknown cache-read price', costReasonTime: 'Unknown request time', costReasonHistory: 'Unknown historical price', costReasonTariff: 'Unknown peak/off-peak window', costReasonSettlement: 'Missing settled usage', costReasonOverflow: 'Cost exceeds numeric limits', costReasonPrice: 'Invalid catalog price',
        costSourceNote: ' ({list})',
        setGroupDisplay: 'Bottom status line', setGroupHeader: 'Quota and peak hours', setGroupWorkspace: 'Git', setGroupSources: 'Quota sources and accounts', setGroupAdvanced: 'Advanced settings',
        setEnabled: 'Enable StatusLine', setEnabledHint: 'Controls all plugin displays and refreshes.',
        setHideBottomOnNarrow: 'Hide bottom status line on narrow screens', setHideBottomOnNarrowHint: 'Do not mount this plugin’s bottom components when the input area is at most 480px wide; restore them when wider. Native stats, header quotas and peak indicators remain available.',
        setFillFromDsh: 'Fill from DSH', setFillFromDshHint: 'Reads the credential reference and base URL this provider already has in DSH model settings. Fills this form only; your configuration is not touched.',
        setFillFromDshDone: 'Filled {v}', setFillFromDshNone: 'DSH has no settings for this provider', setFillFromDshWait: 'Reading…',
        setQuotaOnStep: 'Refresh quota after each step (cached)', setQuotaOnStepHint: 'Applies to every quota source; a cache window prevents duplicate requests, a failing source keeps its retry backoff, and clicking a quota chip still refreshes immediately.',
        setPercentMode: 'Quota percentage', setPercentModeHint: 'Header chips and details both show used or remaining percentage; colour always tracks consumption.',
        setReset: 'Reset to defaults', setResetConfirm: 'Confirm reset?', setResetDone: 'Defaults restored {time}',
        setResetHint: 'Restores display, layout, refresh and advanced defaults; keeps credential references, account files, the repository path and per-source switches.',
        setCredInvalid: 'Enter a credential reference name (letters, digits, underscore), never a literal API key',
        setSourceStateHint: 'Enabled means this source may be displayed. Auto-selection shows only the current billing provider; it does not verify login or credentials. Enabling a source opens its settings automatically.',
        setQuotaAutoHint: 'When off, always use the OpenCode quota source.', setNativeContextHint: 'The native ring comes last in the native stats group on the left and shows occupancy; CTX shows used tokens / window capacity.',
        setBalanceSource: 'Balance', setSubscriptionSource: 'Subscription quota', setSourceEnabled: 'Enabled', setSourceDisabled: 'Disabled',
        setDeepseekAccountNote: 'Models using the DeepSeek account login (deepseek-account) show the signed-in account’s topped-up and granted balance; the API key is only used for the deepseek pay-as-you-go provider.',
        setCodexAccount: 'Codex account filename', setAntigravityAccount: 'Antigravity account filename (optional)',
        setCodexAccountHint: 'Specify a filename when multiple Codex accounts are present.', setAntigravityAccountHint: 'Leave blank to select an account by priority.', setOpenCodeTest: 'Test OpenCode quota',
        win5h: '5 hours', winWeek: 'this week', winMonth: 'this month',
        codexWinWeek: 'w', codexWinMonth: 'm',
        codexShort: 'Codex',
        codexDetailTitle: 'Codex usage',
        codexActiveLimit: 'Active limit', codexCredits: 'Credits', codexCreditsUnlimited: 'Unlimited credits',
        codexFailAuth: 'Codex credential invalid', codexFailRate: 'Codex rate limited, retry later',
        codexFailNetwork: 'Codex network error', codexFailNoCred: 'no Codex credential found',
        codexFail: 'Codex fetch failed',
        antigravityShort: 'Agy',
        antigravityUnknown: 'quota unknown', antigravityThirdParty: 'third-party 5 hours', antigravityThirdPartyWeekly: 'third-party this week', quotaUnknownShort: 'unknown', subscriptionNotFound: 'Subscription not found', antigravityPriority: 'priority {n}',
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
        providerFailSignedOut: 'DeepSeek account not signed in', providerFailNoAccount: 'DeepSeek account service unavailable',
        providerFail: 'quota fetch failed',
        providerBalanceTitle: '{label} balance {r}', providerTotal: 'total',
        providerGranted: 'granted balance {v}', providerToppedUp: 'topped-up balance {v}',
        providerUnavailable: 'account currently unavailable', providerAvailable: 'account available',
        providerWindowTitle: '{label}: {v}', providerResetTitle: 'resets in {r}',
        peakStatus: 'Peak', offPeakStatus: 'Off-peak', peakUnknown: 'Schedule unknown',
        peakToOff: 'Off-peak in', peakToPeak: 'Peak in', peakTitle: 'DeepSeek peak / off-peak schedule',
        peakRule: 'Beijing time: Mon–Fri (excluding Chinese public holidays), 09:00–12:00 and 14:00–18:00 are peak windows. All other hours, weekends and holidays are off-peak at half the peak price.',
        peakCalendarUnknown: 'Holiday calendar does not cover this year; the next peak time is unconfirmed.',
        peakHoliday: 'Chinese public holiday: {name}', peakWeekend: 'Weekends are off-peak all day', peakHolidayUnnamed: 'Holiday',
        peakMakeupDay: 'Make-up workday: the official wording keeps all weekends off-peak, so it shows as off-peak',
        peakRuleChanged: 'The official peak wording no longer matches the built-in rule; it may have changed. Please check the official page.', peakRuleChangedShort: 'rule may have changed',
        peakRatesChanged: 'The official prices no longer match the built-in rate card: {list}. Estimates may read high or low; check the page before editing the card.', peakRatesUnreadable: 'The official pricing page is not shaped like a rate table any more, so prices were not checked this time.',
        peakRatesStale: 'The built-in rate card has not been checked against the official page for {n} days.', peakRateItem: '{what} {from} → {to} per million', peakRateDiscount: 'off-peak discount {from} → {to}', peakChecked: 'Official check: {when}',

        peakSourceFetched: 'Holidays: official calendar (holiday-cn, refreshed daily)', peakSourceBuiltin: 'Holidays: built-in calendar',
        peakBeijing: 'Beijing time', peakLocal: 'Local time', peakNextSwitch: 'Next switch (local time)',
        peakOfficial: 'Official rules and current prices', peakOfficialShort: 'Official rules ↗', setShowDeepseekPeak: 'Show peak / off-peak in direct DeepSeek session headers', setShowPeakDot: 'Peak / off-peak dot in the sidebar footer (no session needed)', setPeakCountdown: 'Show peak / off-peak countdown',
        setResetAlerts: 'Subscription reset notices', setResetAlertsAuto: 'Auto', setResetAlertsOn: 'On', setResetAlertsOff: 'Off',
        setResetAlertsHint: 'Slides a notice out of the quota chip when official accounts announce a provider-wide Codex, Antigravity, Claude or Grok quota reset or reset card (data from AIHOT, checked every 10 minutes). Auto: subscriptions with a model in your model list, plus Grok when ticked; On: the ticked subscriptions; Off: AIHOT is never contacted. Only resets due in the next 24 hours, or completed in the last 24 hours. "Got it" stops the notice sliding out; the chip details panel still shows it.',
        setResetAlertSeconds: 'Notice duration (s)',
        resetDirectSoon: '{name} resets {when}', resetDirectDone: '{name} was reset {when}', resetDoneAt: '{time}', resetCreditSoon: '{name} reset cards {when}', resetCreditDone: '{name} reset cards issued {when}',
        resetToday: 'today', resetTomorrow: 'tomorrow', resetYesterday: 'yesterday', resetEstimateNote: ' (estimated)',
        resetAt: '{time}', resetAbout: 'around {time}', resetBefore: 'by {time}', resetOnDate: 'on {time} (Beijing)', resetEstimate: 'around {time}',
        resetTimeUnknown: 'soon', resetSourceTitle: 'Source: AIHOT', resetPost: 'Post ↗', setResetGrokHint: 'Grok only reads the AIHOT reset feed: it is not detected from models and its quota is not read; unticked by default, tick it to be notified',
        resetAck: 'Got it', resetAckHint: 'Stop sliding these notices out; the quota details panel still shows them', resetSectionTitle: 'Quota resets',
        providerRedBelowTitle: 'turns red below {v}',
        setProviderRedBelow: 'Turn red when the balance is below', setProviderRedBelowPh: 'e.g. 10',
        setProviderCredential: 'API credential reference (not a literal key)',
        setAutoSaveHint: 'Auto-saves',
        setAutoSaving: 'Auto-saving…',
        setAutoSavedAt: 'Saved {time}',
        setAutoSaveFail: 'Save failed; edit again to retry',
        setUpdateTo: 'Update to {0}',
        setUpdateApplying: 'Updating…',
        setUpdateApplied: 'Updated · Refresh',
        setUpdateRestart: 'Restart to apply',
        setUpdatePending: 'Installed · Refresh to confirm',
        setUpdateIncompatible: 'Version {0} needs DSH {1}',
        setUpdateIncompatibleTitle: 'Plugin {0} on DSH {1}. Update DSH to get {2}',
        setUpdateFailed: 'Update failed',
        setUpdateNoManager: 'no installer found: run dsh plugin add dsh-statusline-plus@latest in a terminal',
        setUpdateTitle: 'Installed {0} → latest {1}',
        setGroupRestart: 'Reload and DSH update',
        setShowRestartButton: 'Enable the reload / restart / DSH update button in the sidebar footer',
        setShowRestartButtonHint: 'When off, the button is hidden and the Host neither checks for DSH releases nor accepts restart requests. It also hides itself where the Host supports none of them.',
        setUpdateRestartNow: 'Restart to apply',
        rsTitle: 'Reload DSH (apply plugin and config changes)',
        rsConfirmTitle: 'Reload DSH?',
        rsConfirmBody: 'Changes are hot-reloaded first and sessions keep running. If a change needs a restart, the service restarts next and running sessions and turns are interrupted.',
        rsConfirmBodySoft: 'Hot-reload plugin and config changes; sessions keep running.',
        rsReload: 'Reload', rsRestart: 'Full restart', rsCancel: 'Cancel',
        rsReloading: 'Hot-reloading plugins and config…',
        rsStopping: 'Restarting the service…',
        rsWaiting: 'Waiting for the service to come back…',
        rsBooting: 'Service started, loading plugins and sessions…',
        rsDone: 'Ready, reloading the page…',
        rsSlow: 'Taking longer than usual; still checking.',
        rsReloadNow: 'Reload now', rsRetry: 'Retry', rsDismiss: 'Dismiss',
        rsFailTitle: 'Restart did not finish',
        rsFailSystemctl: 'The system could not restart the service. You can retry. Log: journalctl --user -u {0} -n 100',
        rsFailRequest: 'The request was refused, or the service could not be reached.',
        rsManualTitle: 'Restart needed',
        rsManual: 'Some changes take effect only after DSH restarts ({0}); this environment cannot restart it from here.',
        rsUnknownTitle: 'Result not confirmed',
        rsActive: '{0} session(s) are running a turn. A reload leaves them alone; a full restart interrupts them.',
        rsActiveUnknown: 'Could not tell whether a session is running; a full restart interrupts any turn in progress.',
        rsConfirmNeededTitle: 'A restart is still needed',
        rsConfirmNeeded: 'The hot reload finished, but some changes take effect only after a restart ({0}).',
        rsConfirmNeededActive: 'The hot reload finished, but some changes take effect only after a restart ({0}). {1} session(s) are running and would be interrupted.',
        rsLater: 'Later', rsRestartNow: 'Restart now',
        rsUpdateTitle: 'DSH {0} is available: click to update or reload',
        rsUpdateInfo: 'DSH {0} is available (running {1}). Updating installs it, refreshes the profile dependencies and restarts the service; the service stops during the update.',
        rsUpdate: 'Update DSH',
        rsUpdating: 'Downloading and installing DSH {0}…',
        rsUpdatingHint: 'The service stops during the update; the page refreshes when it finishes.',
        rsProgressTitle: 'Updating DSH {0}',
        rsProgressHint: 'The service stops during the update; this page refreshes when it finishes.',
        rsProgressDoneTitle: 'DSH updated',
        rsProgressDoneHint: 'The new version is up; refreshing the page.',
        rsProgressStoppedHint: 'The update stopped. The service is back or still recovering; check the log and retry.',
        rsProgressFailedTitle: 'DSH update failed',
        rsProgressRolledBackTitle: 'DSH update failed; rolled back',
        rsProgressLabel: 'Update progress',
        rsStepStop: 'Stop the service',
        rsStepInstall: 'Download and install',
        rsStepReconcile: 'Refresh profile dependencies',
        rsStepStart: 'Start and verify',
        rsElapsed: '{0}s elapsed',
        rsLogPath: 'Log: {0}',
        rsCopyLog: 'Copy log command',
        rsCopied: 'Copied',
        rsRetryUpdate: 'Retry update',
        rsReconcileSkipped: 'Skipped: pnpm not found',
        rsReconcileNotNeeded: 'Skipped: no profile dependencies',
        rsCheckExecStart: 'Check whether the unit\'s ExecStart still points at an old installation.',
        rsProgressRolledBack: 'The update failed and rolled back to {0}. The service is back.',
        rsProgressFailed: 'The update failed; the service may not be running.',
        rsProgressStale: 'The restarted service is still {0} (expected {1}).',
        rsProgressNoVersion: 'The restarted process did not report a version, so the update cannot be confirmed.',
        rsProgressUnknown: 'The update result is unknown (timed out).',
        rsErrInstall: 'Installing the new version failed.',
        rsErrReconcile: 'Refreshing the profile dependencies failed.',
        rsErrStart: 'The new version did not start.',
        rsErrRollback: 'Rollback failed; the service may not be running.',
        rsErrHelper: 'The update helper did not start.',
        rsErrStop: 'Stopping the service failed.',
        rsErrUnknown: 'Unknown error.',
        rsFailUpdate: 'The update did not finish; if the install started, the service rolls back automatically. Log: journalctl --user -u {0} -n 100',
        rsUnknown: 'Recovery was not confirmed within a minute. Checks stopped; no second restart was requested.',
        setProviderHint: 'Enter a DSH credential reference or environment variable name, never the literal API key. Built-in references: DEEPSEEK_API_KEY, KIMI_API_KEY, ZAI_API_KEY, ZAI_CODING_CN_API_KEY, OPENROUTER_API_KEY. Sources match the session billing provider.',
        setQuotaAuto: 'Pick the quota source from the session billing provider',
        setQuotaShowAll: 'Show all subscription quotas',
        setQuotaShowAllHint: 'Ignore the model and show enabled Codex / Antigravity / Claude / OpenCode side by side, plus any other subscription Magpie reports.',
        setModelQuotaBar: 'Quota rail on the model button', setModelQuotaBarHint: 'In an empty session the model button above the composer carries a thin subscription rail; it hides once the first message starts the conversation and the header chip takes over.',
        setModelQuotaRows: 'Quota rails in the model picker', setModelQuotaRowsHint: 'Opening the model picker shows each model with the rail of its subscription; balance sources show their amount instead.',
        modelQuotaBalance: 'balance {v}',
        setTitle: 'Status line',
        setDesc: 'Quota and peak hours in the header; session metrics and Git below the composer.', setApiKeyEnvPh: 'OPENCODE_GO_API_KEY',
        setUsageUrl: 'Usage API URL (optional)', setUsageUrlPh: 'https://opencode.ai/zen/go/v1/usage',
        setCacheTtl: 'Quota cache reuse time (seconds)', setFetchTimeout: 'Quota request timeout (seconds)',
        setCacheTtlHint: 'Default 60s, effective minimum 15s: automatic queries reuse the last result during this time. Expiry does not start polling; a later step or becoming visible triggers a query. Clicking quota bypasses successful cache. Shorter values are fresher but make more requests; rate limits still require retry backoff.',
        setGitCwd: 'Repository directory override (optional, defaults to the session workspace)', setGitCwdPh: 'e.g. ~/Projects/my-repo',
        setShowQuota: 'Show header quota', setShowCwd: 'Show repository path',
        tpsTitle: 'Streaming rate estimates tokens from text/reasoning/tool-argument characters. Settled rate prefers provider output tokens over first-token-to-completion time, excluding tool execution. Rounded to an integer; display updates at most every 25ms.',
        tpsHeld: 'Waiting for a new rate; retaining the latest valid value (not current speed)', tpsCompleted: 'Completed', tpsInterrupted: 'Interrupted', tpsUnavailable: 'Reconnecting', setLoading: 'Loading…',
        saveFail: 'Save failed', needSaveFirst: ' (save before testing)',
        testOk: 'Connected: 5h {r}% · week {w}% · month {m}%',
        testFail: 'Connection failed',
      },
    }
    var LOCALE_NS = 'statusline'
    // Set by apply() when the Host exposes its locale service. The service owns
    // the active language and the fallback chain; the plugin only supplies the
    // dictionaries. Older Hosts keep the local STR lookup below.
    var translate = null
    function activeLocale() {
      var lang = 'en'
      try {
        if (CTX && typeof CTX.get === 'function') {
          var svc = CTX.get('locale')
          if (svc && typeof svc.getLocale === 'function') {
            var active = svc.getLocale().active
            if (active) lang = String(active).toLowerCase()
          }
        }
      } catch (e) { /* older shell */ }
      return lang
    }
    function currentLang() {
      var lang = activeLocale()
      if (lang.indexOf('zh') === 0) return 'zh'
      return lang.split('-')[0]
    }
    function t(key) {
      if (translate) return translate(key)
      var table = STR[currentLang()] || STR.en
      return table[key] !== undefined ? table[key] : key
    }
    // Re-render the slot roots when the Host switches language; the locale
    // service is a reactive store, not a network call.
    function useLocaleRevision() {
      var pair = React.useState(0)
      React.useEffect(function () {
        var svc = null
        try { svc = CTX && typeof CTX.get === 'function' ? CTX.get('locale') : null } catch (e) { svc = null }
        if (!svc || typeof svc.subscribe !== 'function') return undefined
        return svc.subscribe(function () { pair[1](function (n) { return n + 1 }) })
      }, [])
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
    // One cache lifetime and retry delay for the chip and the model rail; both
    // paths used to repeat the same floor/default and rate-limit constants.
    var QUOTA_TTL_FLOOR_MS = 15000, QUOTA_TTL_DEFAULT_MS = 60000
    var QUOTA_RETRY_MS = 15000, QUOTA_RATE_RETRY_MS = 60000
    function quotaTtlMs(value) { return Math.max(QUOTA_TTL_FLOOR_MS, quotaNumber(value) || QUOTA_TTL_DEFAULT_MS) }
    function quotaRetryMs(error) { return error === 'rate-limit' ? QUOTA_RATE_RETRY_MS : QUOTA_RETRY_MS }
    // A step may ask for fresh quota, but only after the same cache window the
    // automatic path uses; a failing source keeps its retry ladder instead of
    // being retried by every agent step.
    function quotaStepRefreshDue(lastOkAt, lastError, ttlMs, now) {
      if (lastError) return false
      if (!lastOkAt) return true
      return now - lastOkAt >= quotaTtlMs(ttlMs)
    }
    // Every entry this plugin registers carries an id starting "statusline-plus";
    // the slots it shares with other plugins also carry theirs, so an error from
    // someone else's entry must not be reported as ours.
    var OWN_ID_PREFIX = 'statusline-plus'
    function isOwnEntry(registration) {
      var id = registration && (registration.id || (registration.options && registration.options.id))
      return typeof id === 'string' && id.indexOf(OWN_ID_PREFIX) === 0 ? id : ''
    }
    // ---------------- health ----------------
    // A surface that fails silently is worse than one that fails: the Host retires
    // a slot entry that throws (the row just loses a chip), and a browser bundle
    // served from cache speaks an older contract than the host it talks to (the
    // row just renders less). Neither leaves a trace a user can act on. Both are
    // recorded here and reported once, in Settings.
    var WIRE_EXPECTED = 2
    var health = { wire: null, faults: [] }
    var healthListeners = []
    var healthVersion = 0
    function healthEmit() {
      healthVersion++
      healthListeners.slice().forEach(function (listener) { listener(healthVersion) })
    }
    function noteWire(hostWire) {
      if (hostWire === health.wire) return
      health.wire = hostWire === null || hostWire === undefined ? null : Number(hostWire)
      healthEmit()
    }
    function noteFault(key, message) {
      var text = String(message || '').slice(0, 200)
      for (var i = 0; i < health.faults.length; i++) {
        if (health.faults[i].key === key && health.faults[i].message === text) return
      }
      // One line per slot, newest first: a throw on every render must not grow
      // without bound or push the useful first failure out of the panel.
      health.faults = [{ key: key, message: text, at: Date.now() }].concat(health.faults).slice(0, 3)
      healthEmit()
    }
    function healthState() { return health }
    function useHealth() {
      var pair = React.useState(healthVersion)
      React.useEffect(function () {
        var listener = pair[1]
        healthListeners.push(listener)
        return function () { healthListeners = healthListeners.filter(function (fn) { return fn !== listener }) }
      }, [])
      return health
    }
    function publishConfig(config) {
      configSnapshot = config
      configListeners.slice().forEach(function (listener) { listener(config) })
    }
    function mutateSettings(ops) {
      // Current DSH config forms expose only `writable` (mirrored from
      // settings.describe); the older `mode: 'host'` field is gone, so testing it
      // refused every write. Readiness is covered by the loading snapshot, whose
      // `writable` starts false until the Host document arrives.
      var snapshot = settingsScope && settingsScope.getSnapshot()
      if (!snapshot || snapshot.writable !== true) {
        return Promise.resolve({ ok: false, error: 'Settings are not writable on this connection.' })
      }
      return settingsScope.mutate(ops).then(function (applied) {
        // mutate() resolves false when the Host refuses the write (its own pre-persistence
        // validation, or a revision clash). Ignoring that reported success on a rejected
        // edit, so a change the Host had thrown away looked saved.
        if (applied === false) return { ok: false, error: t('configRejected') }
        return { ok: true, config: settingsScope.getSnapshot().value }
      }).catch(function (error) { return { ok: false, error: String(error.message || error) } })
    }
    function apiSetConfig(patch) {
      return mutateSettings(Object.keys(patch).map(function (key) { return { op: 'set', path: [key], value: patch[key] } }))
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
      // The state only exists to re-render on visibilitychange; the value itself is
      // read live, so a stale entry can never latch the gate closed.
      var pair = React.useState(document.visibilityState !== 'hidden')
      React.useEffect(function () {
        if (enabled === false) return undefined
        // Re-seed on subscribe: while the gate was off no listener existed, so a tab
        // switch during that window is otherwise lost until the next visibilitychange.
        pair[1](document.visibilityState !== 'hidden')
        var change = function () { pair[1](document.visibilityState !== 'hidden') }
        document.addEventListener('visibilitychange', change)
        return function () { document.removeEventListener('visibilitychange', change) }
      }, [enabled])
      return enabled !== false && document.visibilityState !== 'hidden'
    }
    // DSH's boot graph carries the running release. The account provider turns
    // this display identity into its Platform client headers; it is never a
    // credential and the Host bounds every field again.
    function accountClientMetadata() {
      var version = null
      try {
        var release = window.__DSH_BOOT__ && window.__DSH_BOOT__.release
        if (release && typeof release.version === 'string' && release.version) version = release.version
      } catch (e) { /* an older shell may not publish a release in its boot graph */ }
      var metadata = {
        locale: activeLocale().indexOf('zh') === 0 ? 'zh-CN' : activeLocale().indexOf('en') === 0 ? 'en-US' : activeLocale(),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
      if (version) metadata.version = version
      return metadata
    }
    // fetchedAt is produced by the Host. Convert it into this browser's clock
    // using the Host's response timestamp, preserving cached-data age while
    // tolerating clock skew between the two machines.
    function normalizeQuotaTimestamps(result, receivedAt) {
      if (!result || !result.data || typeof result.data !== 'object') return result
      var serverNow = quotaNumber(result.serverNow)
      var fetchedAt = quotaNumber(result.data.fetchedAt)
      if (serverNow !== null && fetchedAt !== null) {
        result.data.fetchedAt = fetchedAt - (serverNow - receivedAt)
      }
      delete result.serverNow
      return result
    }
    function quotaRequest(resource, force, signal) {
      var endpoint = resource.kind === 'provider' ? 'provider-quota' : resource.kind === 'opencode' ? 'usage' : resource.kind + '-quota'
      var body = { id: resource.id, force: force === true }
      var modelProvider = String(resource.modelProvider || '').toLowerCase()
      if (modelProvider) {
        body.provider = modelProvider
        // Only the signed-in DeepSeek account provider needs Platform metadata.
        if (modelProvider === 'deepseek-account') body.account = accountClientMetadata()
      }
      return fetch('/statusline/api/' + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: signal,
      }).then(function (response) {
        var receivedAt = Date.now()
        return response.json().then(function (result) { return normalizeQuotaTimestamps(result, receivedAt) }, function () {
          // A Host that rejects the route before the plugin handler (DSH
          // 0.2.3-alpha authenticates registered routes itself) answers with
          // plain text. Keep the status as the stable code instead of losing it
          // as a JSON parse failure.
          return { ok: false, error: response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'invalid-response' }
        })
      })
        .catch(function (error) { return { ok: false,
          error: error && error.name === 'AbortError' ? 'aborted' : error && error.name === 'SyntaxError' ? 'invalid-response' : 'network' } })
    }
    function apiUsage(force, signal) {
      var opts = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direct: true, force: force === true }),
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
      // `timeout` and `any` shipped separately; guard each so a browser with only
      // `timeout` still gets the 10 s bound plus its own abort signal.
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        var deadline = AbortSignal.timeout(10000)
        opts.signal = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : deadline
      }
      if (signal && !opts.signal) opts.signal = signal
      return fetch('/statusline/api/git', opts)
        .then(function (r) { return r.json() })
        .catch(function (e) { return { ok: false, error: e && e.name === 'TimeoutError' ? 'git-timeout' : 'network' } })
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
    // Session-cumulative provider usage (the Host's `tokenUsage` projection).
    // Any missing or invalid bucket hides the whole breakdown; nothing is guessed.
    var CONTEXT_USAGE = [['uncachedInputTokens', 'input', 'contextUncached'], ['cacheReadTokens', 'read', 'contextCacheRead'],
      ['cacheWriteTokens', 'write', 'contextCacheWrite'], ['outputTokens', 'output', 'contextOutput']]
    function contextUsage(value) {
      if (!value || typeof value !== 'object') return null
      var out = { total: 0 }
      for (var i = 0; i < CONTEXT_USAGE.length; i++) {
        var n = value[CONTEXT_USAGE[i][0]]
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
        out[CONTEXT_USAGE[i][0]] = n
        out.total += n
      }
      var input = out.uncachedInputTokens + out.cacheReadTokens + out.cacheWriteTokens
      out.cacheHitPct = input > 0 ? Math.round(out.cacheReadTokens / input * 1000) / 10 : null
      return out
    }
    // Percentages in a split table must add up to 100. Rounding each share on its
    // own prints totals like 99.9% or 100.1%, which reads as an arithmetic bug in
    // a panel whose whole job is accounting. Largest remainder hands the leftover
    // tenths to the largest fractional parts, so every row still rounds to at most
    // one tenth away from its exact share.
    function largestRemainderPct(values) {
      var total = 0, i
      for (i = 0; i < values.length; i++) total += values[i]
      if (!(total > 0)) return values.map(function () { return 0 })
      var scaled = values.map(function (value) { return value / total * 1000 })
      var tenths = scaled.map(function (value) { return Math.floor(value) })
      var used = 0
      for (i = 0; i < tenths.length; i++) used += tenths[i]
      var order = scaled.map(function (value, index) { return { index: index, rest: value - Math.floor(value) } })
        .sort(function (a, b) { return b.rest - a.rest || a.index - b.index })
      // The sum of the dropped fractions is always below the row count, so one
      // pass settles every leftover tenth.
      for (var left = 1000 - used, k = 0; k < order.length && left > 0; k++, left--) tenths[order[k].index] += 1
      return tenths.map(function (value) { return value / 10 })
    }
    var CONTEXT_TONE = { s: 'var(--dsw-alias-state-success-primary)', w: 'var(--dsw-alias-state-warn-primary)', d: 'var(--dsw-alias-state-error-primary)' }
    function ContextPanel(props) {
      var tone = toneClass(props.pct), usage = props.usage
      var left = Math.max(0, props.contextWindow - props.usedTokens)
      var breakdown = null
      if (usage && usage.total > 0) {
        // Most providers never report cache writes; drop that row unless it has tokens.
        var shownUsage = CONTEXT_USAGE.filter(function (spec) { return spec[1] !== 'write' || usage[spec[0]] > 0 })
        var shares = largestRemainderPct(shownUsage.map(function (spec) { return usage[spec[0]] }))
        var segments = [], rows = shownUsage.map(function (spec, index) {
          var tokens = usage[spec[0]], share = shares[index]
          var label = t(spec[2])
          if (spec[1] === 'read' && Number(props.cacheMisses) > 0) label += tf('contextCacheMisses', { n: props.cacheMisses })
          // A slice with tokens always gets a segment, even when its rounded
          // share is 0.0% and the width therefore draws nothing.
          if (tokens > 0) segments.push(React.createElement('span', { key: spec[1], className: 'slp-cost-segment slp-cost-tint', 'data-kind': spec[1], style: { width: share + '%' } }))
          return React.createElement('tr', { key: spec[1] },
            React.createElement('td', null, React.createElement('span', { className: 'slp-cost-label' },
              React.createElement('span', { className: 'slp-cost-swatch slp-cost-tint', 'data-kind': spec[1], 'aria-hidden': true }), label)),
            React.createElement('td', { className: 'slp-cost-tokens', title: String(tokens) + ' tokens' }, formatTokens(tokens)),
            React.createElement('td', null, share + '%'))
        })
        breakdown = [
          React.createElement('p', { key: 'head', className: 'slp-context-section' }, t('contextSession')),
          React.createElement('div', { key: 'bar', className: 'slp-cost-bar', 'aria-hidden': true }, segments),
          React.createElement('table', { key: 'table', className: 'slp-cost-table', 'aria-label': t('contextSession') },
            React.createElement('thead', null, React.createElement('tr', null,
              ['costKind', 'costTokens', 'costShare'].map(function (label) { return React.createElement('th', { key: label, scope: 'col' }, t(label)) }))),
            React.createElement('tbody', null, rows)),
          usage.cacheHitPct !== null ? React.createElement('p', { key: 'hit', className: 'slp-panel-note', title: t('contextCacheHitHint') },
            tf('contextCacheHit', { p: usage.cacheHitPct })) : null]
      }
      var compacted = props.compactions > 0 ? React.createElement('p', { className: 'slp-panel-note' }, tf('contextCompactions', { n: props.compactions })) : null
      return React.createElement('div', { className: 'slp-panel slp-context-panel', role: 'region', 'aria-label': t('contextTitle') },
        React.createElement('div', { className: 'slp-context-head' },
          React.createElement('strong', null, t('contextTitle'), hint(t('contextHint'))),
          React.createElement('span', { className: 'slp-context-big slp-context-pct ' + tone }, tf('contextPct', { p: props.pct }))),
        React.createElement('span', { className: 'slp-context-track', role: 'meter', 'aria-label': t('contextTitle'),
          'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': props.pct },
          React.createElement('span', { className: 'slp-context-fill', style: { width: props.pct + '%', background: CONTEXT_TONE[tone] } })),
        React.createElement('div', { className: 'slp-context-meta' },
          React.createElement('span', { title: String(props.usedTokens) + ' / ' + String(props.contextWindow) + ' tokens' }, formatTokens(props.usedTokens) + ' / ' + formatTokens(props.contextWindow)),
          React.createElement('span', null, tf('contextLeft', { n: formatTokens(left) }))),
        breakdown, compacted)
    }
    // CTX chip: used / capacity (the native ring already shows the percentage);
    // click for the percentage bar and the session's cache read/write split.
    function ContextRow(props) {
      var dismiss = useDismissiblePanel()
      if (!props.enabled || props.usedTokens === null || props.contextWindow === null || props.contextWindow <= 0) return null
      var exact = String(props.usedTokens) + ' / ' + String(props.contextWindow) + ' tokens'
      return React.createElement('span', { className: 'slp-context slp-group', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { type: 'button', className: 'slp-context-trigger', 'aria-expanded': dismiss.open, 'data-peek': exact + ' · ' + t('contextOpen'), 'aria-label': t('contextLabel') + ' ' + exact,
          onClick: dismiss.toggle },
          React.createElement('span', { className: 'slp-context-label' }, t('contextLabel')),
          React.createElement('span', { className: 'slp-context-pct ' + toneClass(props.pct), title: exact }, formatTokens(props.usedTokens) + ' / ' + formatTokens(props.contextWindow))),
        dismiss.open ? React.createElement(ContextPanel, { usedTokens: props.usedTokens, contextWindow: props.contextWindow, pct: props.pct, usage: props.usage,
          compactions: props.compactions, cacheMisses: props.cacheMisses }) : null)
    }

    function fmtResetHours(sec) {
      sec = Math.max(0, Math.round(Number(sec) || 0))
      if (sec >= 48 * 3600) return (sec / 86400).toFixed(1) + 'd'
      if (sec >= 3600) return (sec / 3600).toFixed(1) + 'h'
      if (sec >= 60) return Math.ceil(sec / 60) + 'm'
      return sec + 's'
    }
    function fmtResetShort(sec) { return '(' + fmtResetHours(sec) + ')' }
    function minutesLabel(minutes, long) {
      var n = Number(minutes)
      if (!Number.isFinite(n) || n <= 0) return '—'
      if (long && n === 300) return t('win5h')
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
      // Round the number, then pick the unit from the rounded value: 999,999
      // rounds to 1000K, which reads as a different magnitude. Choose the unit
      // first and only fall back to a smaller one when rounding crosses over.
      var scaled = function (v) {
        return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
      }
      if (n < 1000) return String(n)
      var units = n < 1000000 ? ['K', n / 1000] : ['M', n / 1000000]
      if (units[0] === 'K' && Math.round(units[1]) >= 1000) units = ['M', n / 1000000]
      return scaled(units[1]) + units[0]
    }

    function quotaFreshness(data, ttlMs, staleError, now) {
      now = now === undefined ? Date.now() : now
      var at = data && quotaNumber(data.fetchedAt)
      // The timestamp comes from the Host, so a browser on another machine may
      // be a little behind it. Tolerate clock skew (show 0s) instead of turning
      // a valid fetch time into "unknown"; only an absent or absurd timestamp
      // loses the label, and then the panel hides it rather than guessing.
      if (at === null || at === undefined || at <= 0 || !Number.isFinite(new Date(at).getTime()) || at > now + 86400000) {
        return { label: null, title: null, stale: !!staleError, failed: !!staleError }
      }
      var age = Math.max(0, Math.floor((now - at) / 1000))
      var ttl = quotaNumber(ttlMs), stale = !!staleError || (ttl !== null && ttl > 0 && now - at >= ttl)
      var ageText = age < 60 ? age + 's' : age < 3600 ? Math.floor(age / 60) + 'm' : age < 86400 ? Math.floor(age / 3600) + 'h' : Math.floor(age / 86400) + 'd'
      var title = tf('quotaFetchedTitle', { time: new Date(at).toLocaleString(), age: ageText })
      if (staleError) title += ' · ' + t('quotaRefreshFailed') + ' (' + staleError + ')'
      else if (stale) title += ' · ' + t('quotaCacheExpired')
      // An expired cache is normal (expiry never polls), so only a failed
      // refresh reads as a warning; `stale` still reports both.
      return { label: tf(staleError ? 'quotaStaleAge' : 'quotaAge', { age: ageText }), title: title, stale: stale, failed: !!staleError }
    }
    function QuotaFreshness(props) {
      var hold = useHeldTitle()
      var state = quotaFreshness(props.data, props.ttlMs, props.staleError, props.now)
      if (!state.label) return null
      // The age in the text ticks every second while the panel is open.
      return React.createElement('span', Object.assign({ className: 'slp-quota-age' + (state.failed ? ' slp-stale' : '') },
        hold(state.title, [props.data && props.data.fetchedAt, state.stale, state.failed].join('|'))), state.label)
    }
    // One state per quota chip, shared by every source:
    // loading → fresh | stale (last good data, refresh failed) | retrying
    // (automatic retry scheduled) | exhausted (manual retry only) | error
    // (no data and no automatic retry: credentials, account choice, offline).
    var QUOTA_RETRYABLE = ['network', 'timeout', 'busy', 'rate-limit']
    // A missing subscription/credential is not a transient failure: the model's
    // own subscription is absent, so the chip says "Subscription not found".
    // It must never borrow another subscription's numbers.
    var QUOTA_ABSENT_ERRORS = ['no-credential', 'auth', 'invalid-response', 'not-found']
    function quotaState(props, now) {
      props = props || {}
      now = now === undefined ? Date.now() : now
      var failure = props.data ? props.staleError : props.error
      var retryAt = quotaNumber(props.retryAt)
      var retryInSec = retryAt !== null && failure ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : null
      var state = !props.data && !props.error ? 'loading'
        : !failure ? 'fresh'
          : retryInSec !== null ? 'retrying'
            : props.retryExhausted ? 'exhausted'
              : props.data ? 'stale' : 'error'
      return { state: state, reason: failure || null, retryable: !!failure && QUOTA_RETRYABLE.indexOf(failure) !== -1,
        retryInSec: retryInSec, attempt: retryInSec !== null ? Math.max(1, Math.min(3, props.retryAttempt || 1)) : 0 }
    }
    // Every failure code the Host can return gets its own short label; only an
    // unknown one falls back to "unavailable". The raw code stays in the tooltip.
    var QUOTA_REASON_KEYS = {
      network: 'quotaNetworkShort', timeout: 'quotaTimeoutShort', 'rate-limit': 'quotaRateShort',
      auth: 'quotaAuthShort', 'no-credential': 'quotaNoCredShort',
      'signed-out': 'quotaSignedOutShort', 'no-account': 'quotaNoAccountShort',
      'invalid-response': 'quotaInvalidResponseShort', 'invalid-json': 'quotaInvalidResponseShort',
      'body-too-large': 'quotaInvalidResponseShort', 'body-read-failed': 'quotaInvalidResponseShort',
      'method-not-allowed': 'quotaInvalidResponseShort', 'json-required': 'quotaInvalidResponseShort',
      'not-found': 'quotaNotFoundShort', disabled: 'quotaDisabledShort',
      unauthorized: 'quotaUnauthorizedShort', forbidden: 'quotaForbiddenShort', 'cross-origin': 'quotaForbiddenShort',
      aborted: 'quotaAbortedShort', busy: 'quotaBusyShort',
    }
    function quotaReasonShort(reason) {
      return t(QUOTA_REASON_KEYS[reason] || 'quotaUnavailableShort')
    }
    // A short label says what happened; this says what the reader can do about
    // it. Both live in the details panel: the chip stays a reading.
    var QUOTA_ADVICE_KEYS = {
      network: 'quotaAdviceNetwork', timeout: 'quotaAdviceTimeout', 'rate-limit': 'quotaAdviceRate',
      auth: 'quotaAdviceAuth', 'no-credential': 'quotaAdviceNoCred',
      'signed-out': 'quotaAdviceSignedOut', 'no-account': 'quotaAdviceNoAccount',
      'invalid-response': 'quotaAdviceParse', 'invalid-json': 'quotaAdviceParse',
      'body-too-large': 'quotaAdviceParse', 'body-read-failed': 'quotaAdviceParse',
      'method-not-allowed': 'quotaAdviceParse', 'json-required': 'quotaAdviceParse',
      'not-found': 'quotaAdviceNotFound', disabled: 'quotaAdviceDisabled',
      unauthorized: 'quotaAdviceUnauthorized', forbidden: 'quotaAdviceForbidden', 'cross-origin': 'quotaAdviceForbidden',
      aborted: 'quotaAdviceAborted', busy: 'quotaAdviceBusy',
    }
    function quotaAdvice(reason) {
      return t(QUOTA_ADVICE_KEYS[reason] || 'quotaAdviceUnknown')
    }
    // The raw code for tooltips and panel lines, without repeating a label that
    // already reads as the code ("timeout (timeout)").
    function quotaReasonDetail(reason) {
      var label = quotaReasonShort(reason)
      return label === reason ? label : label + ' (' + reason + ')'
    }
    function fmtRetryIn(sec) {
      sec = Math.max(0, Math.round(Number(sec) || 0))
      return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm' + (sec % 60 ? String(sec % 60).padStart(2, '0') + 's' : '')
    }
    // One sentence for the chip tooltip and the details panel.
    function quotaStatusText(status) {
      if (status.state === 'retrying') return tf('quotaRetryIn', { n: status.attempt, s: fmtRetryIn(status.retryInSec) })
      if (status.state === 'exhausted') return t('quotaRetryExhausted')
      return ''
    }
    // Per-second re-render only while a retry countdown is on a visible page.
    function useRetryClock(retryAt) {
      var visible = usePageVisible(!!retryAt), pair = React.useState(0)
      React.useEffect(function () {
        if (!retryAt || !visible) return undefined
        var timer = setInterval(function () { pair[1](function (n) { return n + 1 }) }, 1000)
        return function () { clearInterval(timer) }
      }, [retryAt, visible])
    }
    var QUOTA_CHIP_TICK_MS = 30000
    // A closed chip only shows reset times, so it ticks slowly; an open panel
    // shows its age in seconds and ticks every second.
    function useQuotaClock(enabled, intervalMs) {
      var visible = usePageVisible(enabled), pair = React.useState(Date.now())
      React.useEffect(function () {
        if (!visible) return undefined
        pair[1](Date.now())
        var timer = setInterval(function () { pair[1](Date.now()) }, intervalMs)
        return function () { clearInterval(timer) }
      }, [visible, intervalMs])
      // Ticks trigger rerenders, but a newly fetched timestamp is compared
      // with the current wall clock immediately.
      return Date.now()
    }

    // One lifecycle for all quota sources: one request, cancellation, silent refresh
    // and an actual visibility gate. Backend owns TTL and 429 backoff across tabs.
    function useQuotaResource(resource, config, stepCount) {
      var pair = React.useState(null), setResult = pair[1]
      var dispatch = React.useRef(function () {})
      var stepRefreshRef = React.useRef(function () {})
      var visible = usePageVisible(!!(config && config.enabled && config.showQuota))
      var enabled = !!(config && config.enabled && config.showQuota && visible && resource)
      var key = resource ? resource.key : ''
      var requestConfigKey = JSON.stringify([config && config.apiKeyEnv, config && config.usageUrl,
        config && config.cacheTtlMs, config && config.fetchTimeoutMs, config && config.codexAccount,
        config && config.antigravityAccount, config && config.quotaSources, resource && resource.provider])
      React.useEffect(function () {
        if (!enabled) return undefined
        var alive = true, controller = null, pending = false, pendingForce = false
        var retryTimer = null, retries = 0, lastError = null, lastOkAt = 0
        var sameRequest = function (old) { return old && old.key === key && old.requestConfigKey === requestConfigKey }
        var offline = function () { return window.navigator && window.navigator.onLine === false }
        var clearRetry = function () { if (retryTimer !== null) clearTimeout(retryTimer); retryTimer = null }
        var failure = function (error, silent) {
          lastError = error
          setResult(function (old) {
            return { key: key, requestConfigKey: requestConfigKey,
              data: silent && sameRequest(old) ? old.data : null, error: error, retryExhausted: false }
          })
        }
        setResult(function (old) { return sameRequest(old) ? old : null })
        var refresh = function (force, silent, retry) {
          if (!alive) return
          clearRetry()
          if (!retry) retries = 0
          // A new attempt ends any visible countdown; a fresh cycle also clears exhaustion.
          setResult(function (old) {
            if (!sameRequest(old) || (!old.retryAt && (retry || !old.retryExhausted))) return old
            return Object.assign({}, old, { retryAt: null, retryExhausted: retry ? old.retryExhausted : false })
          })
          if (offline()) { failure('network', true); return }
          if (controller) { pending = true; pendingForce = pendingForce || force; return }
          controller = new AbortController()
          quotaRequest(resource, force, controller.signal).then(function (result) {
            if (!alive) return
            if (result.ok) {
              retries = 0; lastError = null; lastOkAt = Date.now()
              setResult({ key: key, requestConfigKey: requestConfigKey, data: result.data, error: null })
            } else failure(result.error || 'network', silent)
          }).finally(function () {
            controller = null
            if (!alive) return
            if (pending) {
              var forceNext = pendingForce; pending = false; pendingForce = false
              refresh(forceNext, true)
            } else if (!offline() && retries < 3 && QUOTA_RETRYABLE.indexOf(lastError) !== -1) {
              // Respect the Host's 15s error cache and at least 60s for 429s.
              var delay = quotaRetryMs(lastError) * Math.pow(2, retries)
              var retryAt = Date.now() + delay, attempt = retries + 1
              setResult(function (old) { return sameRequest(old) ? Object.assign({}, old, { retryAt: retryAt, retryAttempt: attempt }) : old })
              retryTimer = setTimeout(function () {
                retryTimer = null; retries++; refresh(false, true, true)
              }, delay)
            } else if (retries >= 3 && QUOTA_RETRYABLE.indexOf(lastError) !== -1) {
              setResult(function (old) { return sameRequest(old) ? Object.assign({}, old, { retryExhausted: true }) : old })
            }
          })
        }
        var online = function () {
          if (lastError === 'aborted' || QUOTA_RETRYABLE.indexOf(lastError) !== -1) refresh(false, true)
        }
        var focused = function () {
          // Do not reset an active retry cycle or enqueue duplicate requests.
          if (document.visibilityState !== 'hidden' && !controller && retryTimer === null) online()
        }
        var disconnected = function () {
          clearRetry(); failure('network', true)
          if (controller) controller.abort()
        }
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('online', online)
          window.addEventListener('offline', disconnected)
          window.addEventListener('focus', focused)
        }
        dispatch.current = refresh
        var stepRefresh = function (force) {
          if (!alive || retryTimer !== null) return
          if (lastError) return
          if (!force && !quotaStepRefreshDue(lastOkAt, lastError, config && config.cacheTtlMs, Date.now())) return
          refresh(force, true, true)
        }
        stepRefreshRef.current = stepRefresh
        refresh(false, true)
        return function () {
          alive = false
          clearRetry()
          if (controller) controller.abort()
          if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('online', online)
            window.removeEventListener('offline', disconnected)
            window.removeEventListener('focus', focused)
          }
          dispatch.current = function () {}
          stepRefreshRef.current = function () {}
        }
      }, [enabled, key, requestConfigKey])
      var previousStep = React.useRef(null)
      React.useEffect(function () {
        var previous = previousStep.current
        previousStep.current = { key: key, count: stepCount }
        if (enabled && resource.onStep && previous && previous.key === key && stepCount > previous.count) stepRefreshRef.current(!resource.cacheOnStep)
      }, [enabled, key, stepCount, resource && resource.onStep, resource && resource.cacheOnStep])
      var result = pair[0] && pair[0].key === key && pair[0].requestConfigKey === requestConfigKey ? pair[0] : null
      return { data: result && result.data, error: result && !result.data ? result.error : null,
        staleError: result && result.data ? result.error : null,
        retryExhausted: !!(result && result.retryExhausted),
        retryAt: result && result.retryAt || null, retryAttempt: result && result.retryAttempt || 0,
        refresh: function () { dispatch.current(true, true) } }
    }

    // ---------------- 小组件 ----------------
    // A native tooltip whose text changes while shown is hidden and redrawn, so
    // a ticking countdown made it blink. While hovered, keep the text until
    // `key` (the state, never the clock) changes: a new fetch, an error or a
    // peak switch still shows at once. The next hover reads it fresh. `slot`
    // names the element when one component has several tooltips.
    function useHeldTitle() {
      var hoverTitle = React.useRef({})
      return function titleProps(live, key, slot) {
        slot = slot || 'trigger'
        var held = hoverTitle.current[slot]
        if (held && held.key !== key) held = hoverTitle.current[slot] = { key: key, text: live }
        return { title: held ? held.text : live,
          onPointerEnter: function () { hoverTitle.current[slot] = { key: key, text: live } },
          onPointerLeave: function () { delete hoverTitle.current[slot] } }
      }
    }
    function useDismissiblePanel() {
      var pair = React.useState(false)
      var open = pair[0]
      var setOpen = pair[1]
      var rootRef = React.useRef(null)
      var panelRef = React.useRef(null)
      function inside(node) {
        return [rootRef.current, panelRef.current].some(function (part) { return part && typeof part.contains === 'function' && part.contains(node) })
      }

      React.useEffect(function () {
        if (!open) return undefined
        // Keep details inside the viewport and the conversation's scroll
        // container. Only an open panel measures layout, on mount/resize.
        var clippedParents = [], scrollers = []
        // Edge fade on a scrolling body: only the edges with hidden content fade.
        function fadeEdges() {
          scrollers.forEach(function (node) {
            var top = node.scrollTop > 2, bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 2
            var fade = top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : null
            if (fade) { if (node.getAttribute('data-fade') !== fade) node.setAttribute('data-fade', fade) } else if (node.hasAttribute('data-fade')) node.removeAttribute('data-fade')
          })
        }
        function trackScrollers() {
          var root = panelRef.current || rootRef.current
          var found = root && typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll('.slp-panel-scroll')) : []
          found.forEach(function (node) {
            if (scrollers.indexOf(node) !== -1) return
            scrollers.push(node)
            node.addEventListener('scroll', fadeEdges, { passive: true })
            if (resize) resize.observe(node)
          })
          fadeEdges()
        }
        function fitPanel() {
          trackScrollers()
          var root = rootRef.current
          var panel = root && typeof root.querySelector === 'function' && root.querySelector('.slp-panel')
          if (!panel || typeof panel.getBoundingClientRect !== 'function') return
          // A fixed panel (the footer peak popover) already owns its placement
          // and a design max-width; fitting it to the viewport would replace
          // that cap with a wider one and let a long status line stretch it.
          if (typeof getComputedStyle === 'function' && getComputedStyle(panel).position === 'fixed') return
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
        var resize = typeof ResizeObserver === 'function' ? new ResizeObserver(fitPanel) : null
        fitPanel()
        if (resize && rootRef.current) {
          resize.observe(rootRef.current)
          clippedParents.forEach(function (parent) { resize.observe(parent) })
        }
        if (typeof window.addEventListener === 'function') window.addEventListener('resize', fitPanel)
        function onDown(e) {
          if (rootRef.current && e.target && typeof rootRef.current.contains === 'function' && !inside(e.target)) setOpen(false)
        }
        function onKey(e) {
          if (e.key === 'Escape') {
            e.stopPropagation()
            // Focus inside the closing panel returns to its trigger instead of the page.
            var root = rootRef.current, active = typeof document !== 'undefined' ? document.activeElement : null
            if (root && active && typeof root.contains === 'function' && inside(active)) {
              var trigger = root.querySelector('button')
              if (trigger && trigger !== active && typeof trigger.focus === 'function') trigger.focus()
            }
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
          scrollers.forEach(function (node) { node.removeEventListener('scroll', fadeEdges) })
          if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', fitPanel)
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('pointerdown', onDown)
            document.removeEventListener('keydown', onKey)
            document.removeEventListener('visibilitychange', onVis)
          }
        }
      }, [open])

      var onBlur = function (e) {
        if (rootRef.current && e.relatedTarget && typeof rootRef.current.contains === 'function' && !inside(e.relatedTarget)) setOpen(false)
      }

      var titleProps = useHeldTitle()

      return {
        open: open,
        setOpen: setOpen,
        toggle: function () { setOpen(function (value) { return !value }) },
        rootRef: rootRef,
        panelRef: panelRef,
        onBlur: onBlur,
        titleProps: titleProps,
      }
    }
    // The header actions slot is clipped and faded by its Host, whose contract
    // says overlays must portal. Focus moves in because the panel's controls
    // are no longer next to the trigger in tab order; Escape returns it.
    var ANCHOR_MEASURE = { visibility: 'hidden', left: 0, top: 0 }
    // Host primitives 0.2.2-rc.2 removed useAnchoredPosition without a public
    // replacement; calling the missing hook threw on click and the Host hid the
    // whole chip. Use the Host's hook when it exists, else this one. Header
    // chips sit at the top of the window, so the panel always opens below its
    // anchor and shrinks to the space left instead of flipping above.
    function useBelowAnchorPosition(options) {
      var pair = React.useState(null)
      var position = pair[0], setPosition = pair[1]
      var anchorRef = options.anchorRef, panelRef = options.panelRef, gap = options.gap, margin = options.margin
      React.useLayoutEffect(function () {
        if (!options.open) { setPosition(null); return undefined }
        var anchor = anchorRef.current, panel = panelRef.current
        var win = anchor && anchor.ownerDocument && anchor.ownerDocument.defaultView
        if (!anchor || !panel || !win) return undefined
        var root = anchor.ownerDocument.documentElement
        var previous = ['--dsh-anchored-max-width', '--dsh-anchored-max-height'].map(function (name) { return [name, panel.style.getPropertyValue(name)] })
        var active = true, frame = 0, last = null
        function place() {
          if (!active) return
          var rect = anchor.getBoundingClientRect()
          last = rect.left + ',' + rect.top + ',' + rect.width + ',' + rect.height
          var width = root.clientWidth || win.innerWidth, height = root.clientHeight || win.innerHeight
          var top = Math.max(margin, rect.bottom + gap)
          panel.style.setProperty('--dsh-anchored-max-width', Math.max(0, width - margin * 2) + 'px')
          panel.style.setProperty('--dsh-anchored-max-height', Math.max(0, height - top - margin) + 'px')
          var left = Math.max(margin, Math.min(rect.left, width - margin - panel.offsetWidth))
          setPosition(function (current) { return current && current.left === left && current.top === top ? current : { left: left, top: top } })
        }
        // Scroll and resize cover most moves; the frame check catches header
        // reflow (a neighbouring chip growing) that fires neither.
        function track() {
          if (!active) return
          var rect = anchor.getBoundingClientRect()
          if (rect.left + ',' + rect.top + ',' + rect.width + ',' + rect.height !== last) place()
          frame = win.requestAnimationFrame(track)
        }
        place()
        win.addEventListener('scroll', place, true)
        win.addEventListener('resize', place)
        var observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
        if (observer) { observer.observe(anchor); observer.observe(panel) }
        frame = win.requestAnimationFrame(track)
        return function () {
          active = false
          win.cancelAnimationFrame(frame)
          if (observer) observer.disconnect()
          win.removeEventListener('scroll', place, true)
          win.removeEventListener('resize', place)
          previous.forEach(function (entry) { panel.style.setProperty(entry[0], entry[1]) })
        }
      }, [options.open, anchorRef, panelRef, gap, margin])
      return position
    }
    var useAnchoredPosition = typeof Primitives.useAnchoredPosition === 'function' ? Primitives.useAnchoredPosition : useBelowAnchorPosition
    function AnchoredPanel(props) {
      var dismiss = props.dismiss
      var position = useAnchoredPosition({ open: true, anchorRef: dismiss.rootRef, panelRef: dismiss.panelRef, gap: 6, margin: 12 })
      var placed = !!position
      React.useEffect(function () {
        if (placed && dismiss.panelRef.current) dismiss.panelRef.current.focus({ preventScroll: true })
      }, [placed])
      return ReactDOM.createPortal(React.createElement(Primitives.MenuSurface, { ref: dismiss.panelRef, className: 'slp-anchored', phase: 'enter', tabIndex: -1, style: position || ANCHOR_MEASURE }, props.children), document.body)
    }

    // ---- Shared quota chip pieces ----
    // Every quota chip behaves the same: click opens details without touching
    // the cache, so the footer shows the last real fetch age; the explicit
    // Refresh button in the panel is what forces a new query.
    function useQuotaPanel(onPanelOpen) {
      var dismiss = useDismissiblePanel()
      // A ref, not the render closure: two clicks before a re-render must
      // toggle twice instead of "opening" twice.
      var openRef = React.useRef(false)
      openRef.current = dismiss.open
      dismiss.toggle = function () {
        var opening = !openRef.current
        openRef.current = opening
        dismiss.setOpen(opening)
      }
      // The chip above owns the clock; it ticks fast only while this panel is open.
      React.useEffect(function () { if (onPanelOpen) onPanelOpen(dismiss.open) }, [dismiss.open])
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
    function chipSegment(key, label, metric, resetSec, title, hold) {
      var text = title || (label ? label + ': ' : '') + metric.word
      // The reset countdown in the text ticks; the key is what it reports.
      return React.createElement('span', Object.assign({ key: key, className: 'slp-seg' },
        hold ? hold(text, String(metric.used), 'seg:' + key) : { title: text }),
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
    // Names the path the numbers took, so a wrong figure can be traced to it.
    var QUOTA_SOURCES = { magpie: 'quotaSourceMagpie', cpa: 'quotaSourceCpa', official: 'quotaSourceOfficial', direct: 'quotaSourceDirect', host: 'quotaSourceHost' }
    function QuotaSource(props) {
      var key = QUOTA_SOURCES[props.source]
      if (!key) return null
      return React.createElement('span', { className: 'slp-quota-source', title: t(key + 'Title') }, tf('quotaSourceLabel', { source: t(key) }))
    }
    function PanelFoot(props) {
      return React.createElement('div', { className: 'slp-panel-foot' },
        React.createElement('span', { className: 'slp-panel-meta' },
          React.createElement(QuotaSource, { source: props.source }),
          React.createElement(QuotaFreshness, { data: { fetchedAt: props.fetchedAt }, ttlMs: props.ttlMs, staleError: props.staleError, now: props.now })),
        props.refresh ? React.createElement('button', { type: 'button', className: 'slp-link-btn',
          onClick: function (e) { e.stopPropagation(); props.refresh() } }, t('refreshNow')) : null)
    }
    function percentMode(props) { return props && props.mode === 'left' ? 'left' : 'used' }
    // percentRows: the panel lists percentages, so its heading names how they read.
    function quotaPanel(title, body, props, fetchedAt, percentRows) {
      // Title and footer stay put; only a long body (many accounts) scrolls.
      var status = quotaState(props, props.now)
      var statusText = status.state === 'stale' ? t('quotaRefreshFailed') : quotaStatusText(status)
      return React.createElement('div', { className: 'slp-panel slp-panel-down', role: 'dialog', 'aria-label': title },
        React.createElement('p', { className: 'slp-panel-title' }, title,
          percentRows ? React.createElement('span', { className: 'slp-panel-mode' }, t(percentMode(props) === 'left' ? 'quotaModeLeft' : 'quotaModeUsed')) : null),
        React.createElement('div', { className: 'slp-panel-scroll' }, body),
        // Every details panel lists current resets, if there are any.
        React.createElement(ResetPanelSection, { kind: resetKindOfName(props.kind || (props.provider && props.provider.id)) }),
        statusText ? React.createElement('p', { className: 'slp-panel-status', 'data-state': status.state },
          (status.reason ? quotaReasonDetail(status.reason) + ' · ' : '') + statusText) : null,
        status.reason ? React.createElement('p', { className: 'slp-panel-advice', 'data-state': status.state }, quotaAdvice(status.reason)) : null,
        React.createElement(PanelFoot, { source: props.data && props.data.source, fetchedAt: fetchedAt, ttlMs: props.ttlMs, staleError: props.staleError, now: props.now, refresh: props.refresh }))
    }
    // Chip button + details panel. The freshness tooltip and a "!" for a
    // failed refresh (still showing the last good data) are added here.
    function quotaShell(dismiss, props, label, title, segments, panel, nameClass) {
      var fresh = props.data ? quotaFreshness(props.data, props.ttlMs, props.staleError, props.now) : null
      var status = quotaState(props, props.now)
      var statusText = status.state === 'retrying' || status.state === 'exhausted' ? quotaStatusText(status) : ''
      return React.createElement('span', { className: 'slp-quota-root', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', Object.assign({ type: 'button', className: 'slp-quota-trigger', 'aria-expanded': dismiss.open, 'aria-haspopup': 'dialog', 'data-state': status.state,
          onClick: dismiss.toggle }, dismiss.titleProps([title, fresh && fresh.title, statusText, t('clickDetails')].filter(Boolean).join(' · '),
            [status.state, status.attempt, props.staleError || '', props.data && props.data.fetchedAt].join('|'))),
          React.createElement('span', { className: 'slp-quota-name' + (nameClass ? ' ' + nameClass : '') }, label), segments,
          props.staleError ? React.createElement('span', { className: 'slp-err', 'aria-hidden': true }, '!') : null,
          // The "!" is visual only; screen readers get the reason as text.
          props.staleError ? React.createElement('span', { className: 'slp-sr' }, quotaReasonShort(props.staleError) + ', ' + t('quotaShowingLast')) : null),
        dismiss.open ? React.createElement(AnchoredPanel, { dismiss: dismiss }, panel) : null)
    }
    // No matching subscription: a readable message instead of silently hiding the
    // chip. `detail` keeps the underlying reason in the tooltip for diagnosis
    // without turning the chip into a different subscription's quota.
    // It is a status, not a reading: after 10 s it fades out and is removed, so a
    // stale "not found" never becomes a permanent, oversized header sentence.
    var UNAVAILABLE_FADE_MS = 10000
    function useAutoDismiss(ms) {
      var pair = React.useState(false), gone = pair[0], setGone = pair[1]
      React.useEffect(function () {
        var timer = setTimeout(function () { setGone(true) }, ms)
        return function () { clearTimeout(timer) }
      }, [ms])
      return gone
    }
    function QuotaUnavailable(props) {
      var gone = useAutoDismiss(UNAVAILABLE_FADE_MS)
      useResetAnchorSignal(gone)
      if (gone) return null
      // A reset drawer may slide out of it: it is the header's subscription chip.
      return React.createElement('span', { className: 'slp-quota-root slp-chip-metric slp-chip-fade', 'data-slp-reset-kind': '', 'data-slp-quota-ready': 'true' },
        React.createElement('span', { className: 'slp-quota-trigger slp-quota-muted', 'data-state': 'error', role: 'status',
          title: props.detail ? props.title + ' · ' + props.detail : props.title }, props.title))
    }
    function quotaUnavailable(title, detail, key) {
      return React.createElement(QuotaUnavailable, { key: key, title: title, detail: detail })
    }
    // Errors stay clickable for an immediate retry and say what happens next
    // (countdown, or "retries used"); loading is inert.
    function quotaPlaceholder(label, title, retry, recovery, hold) {
      if (!retry) return React.createElement('span', { className: 'slp-quota-root' },
        React.createElement('span', { className: 'slp-quota-trigger slp-quota-muted', 'data-state': 'loading', role: 'status', title: title }, label + ' …'))
      var status = recovery ? quotaState(recovery, recovery.now) : null
      var reason = status && status.reason
      var statusText = status ? quotaStatusText(status) : ''
      var next = status && status.state === 'retrying' ? tf('quotaRetryInShort', { s: fmtRetryIn(status.retryInSec) })
        : status && status.state === 'exhausted' ? t('quotaRetryExhaustedShort') : null
      var content = reason ? [label + ' ', React.createElement('span', { key: 'reason', className: 'slp-quota-reason' }, quotaReasonShort(reason)),
        next ? ' · ' : null, next ? React.createElement('span', { key: 'next', className: 'slp-quota-retry' }, next) : null] : label + ' ' + t('quotaUnknownShort')
      // The retry countdown ticks every second; the key is the retry state. The
      // raw Host code stays in the tooltip after the readable reason.
      var text = [[title, reason ? '(' + reason + ')' : ''].filter(Boolean).join(' '), statusText, t('clickRetry')].filter(Boolean).join(' · ')
      var titled = hold ? hold(text, [status && status.state, status && status.attempt, reason].join('|')) : { title: text }
      return React.createElement('span', { className: 'slp-quota-root' },
        React.createElement('button', Object.assign({ type: 'button', className: 'slp-quota-trigger' + (reason ? '' : ' slp-quota-muted'), 'data-state': reason ? status.state : 'error',
          'data-retry-exhausted': status && status.state === 'exhausted' ? 'true' : undefined,
          onClick: function () { retry() } }, titled), content))
    }
    function apiSessionModel(sessionId, signal) {
      if (!sessionId) return Promise.resolve({ ok: false, error: 'session-not-found' })
      return fetch('/statusline/api/session-model', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId }), signal: signal,
      }).then(function (response) { return response.json() }).catch(function () { return { ok: false, error: 'network' } })
    }
    // Native status maps key a session by its bare or `session-` prefixed id.
    function sessionStatusOf(statuses, sessionId) {
      return statuses && typeof statuses.get === 'function' && (statuses.get(sessionId) || statuses.get('session-' + sessionId))
    }
    // One descriptor per subscription kind. The chip, the model rail, the reset
    // drawer, the settings list and the labels all read this table, so a new
    // kind (or an alias such as Magpie's `agy-cli`) is one entry instead of
    // parallel lists that can drift.
    var SUBSCRIPTIONS = {
      codex: {
        name: 'Codex', short: 'codexShort', title: 'codexDetailTitle',
        color: 'var(--dsw-alias-state-success-primary)', setting: 'showCodexQuota', showDefault: false,
        model: /^codex[\/-]/i, provider: /codex|chatgpt/i, alias: /codex|chatgpt|openai/, reset: true, resetAuto: true,
      },
      antigravity: {
        name: 'Antigravity', sentence: 'Agy', short: 'antigravityShort', title: 'antigravityDetailTitle', unknown: 'antigravityUnknown',
        color: 'color-mix(in oklab, var(--dsw-alias-state-business-primary) 55%, var(--dsw-alias-state-error-primary))',
        setting: 'showAntigravityQuota', showDefault: false,
        model: /^(?:antigravity|agy)(?:[\/-]|$)/i, provider: /(?:antigravity|agy)(?:[\/-]|$)/i,
        alias: /antigravity|^agy(?:[\/-]|$)/, reset: true, resetAuto: true,
      },
      claude: {
        name: 'Claude',
        color: 'color-mix(in oklab, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-state-warn-primary))',
        setting: 'showClaudeQuota', showDefault: true,
        model: /^claude\//i, provider: /claude/i, alias: /claude|anthropic/, reset: true, resetAuto: true,
      },
      opencode: {
        name: 'OpenCode', short: 'opencodeShort', title: 'detailTitle',
        color: 'color-mix(in oklab, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-state-business-primary))',
        setting: 'showOpenCodeQuota', showDefault: true,
        model: /^opencode[\/-]/i, provider: /opencode/i, alias: /opencode/,
      },
      // Notices only: no quota reader and no model detection, so auto never asks about it.
      grok: {
        name: 'Grok', color: 'var(--dsw-alias-label-primary)', alias: /grok|xai|x-ai/,
        reset: true, resetAuto: false, quota: false,
      },
    }
    var SUBSCRIPTION_KINDS = Object.keys(SUBSCRIPTIONS)
    var QUOTA_SUBSCRIPTION_KINDS = SUBSCRIPTION_KINDS.filter(function (kind) { return SUBSCRIPTIONS[kind].quota !== false })
    var RESET_KINDS = SUBSCRIPTION_KINDS.filter(function (kind) { return SUBSCRIPTIONS[kind].reset })
    var RESET_AUTO_KINDS = RESET_KINDS.filter(function (kind) { return SUBSCRIPTIONS[kind].resetAuto })
    // A chip or Magpie id names a subscription, sometimes through an alias
    // (`agy-cli` is Antigravity, `anthropic` is Claude).
    function subscriptionKindOf(name) {
      var s = String(name || '').toLowerCase()
      for (var i = 0; i < SUBSCRIPTION_KINDS.length; i++) {
        if (SUBSCRIPTIONS[SUBSCRIPTION_KINDS[i]].alias.test(s)) return SUBSCRIPTION_KINDS[i]
      }
      return ''
    }
    // A gateway may expose subscription models under a neutral provider name
    // (magpie serves `antigravity/gemini-3.8-flash` as `magpie-workbuddy`), so
    // the model prefix is as authoritative as the billing provider.
    // Model ID first, provider second: the gateway namespace is the strongest
    // signal, and a neutral provider (magpie-workbuddy) must not hide it.
    // Magpie's local agy CLI is the same subscription under `agy-cli/`.
    function primarySubscriptionKind(model) {
      if (!model) return null
      var provider = String(model.provider || ''), id = String(model.model || '')
      for (var i = 0; i < SUBSCRIPTION_KINDS.length; i++) {
        var sub = SUBSCRIPTIONS[SUBSCRIPTION_KINDS[i]]
        if (sub.model && sub.model.test(id) || sub.provider && sub.provider.test(provider)) return SUBSCRIPTION_KINDS[i]
      }
      return null
    }
    // A subscription we have no dedicated reader for may still be in the user's
    // Magpie, whatever it is called: its name is the model namespace, or a gateway
    // provider such as magpie-workbuddy without the gateway part.
    function magpieSubscriptionHint(model) {
      if (!model) return ''
      var namespace = /^([\w.-]{1,64})\//.exec(String(model.model || ''))
      if (namespace) return namespace[1].toLowerCase()
      if (!looksLikeSubscription(model)) return ''
      var provider = String(model.provider || '').toLowerCase().replace(/^(magpie|cpa)(-|$)/, '')
      return /^[\w.-]{1,64}$/.test(provider) ? provider : ''
    }
    // Only show "Subscription not found" when the model looks like a gateway
    // subscription; DeepSeek and other API-key models simply have no chip.
    function looksLikeSubscription(model) {
      if (!model) return false
      var provider = String(model.provider || '')
      var id = String(model.model || '')
      return /magpie|cpa|codex|antigravity|opencode|workbuddy/i.test(provider) ||
        /^(codex|antigravity|opencode|workbuddy)[\/-]/i.test(id)
    }
    // Built-ins match only the billing provider; custom sources retain substring/prefix matching.
    function providerMatchesModel(provider, model) {
      if (!provider || !model) return false
      var mp = String(model.provider || '').toLowerCase()
      var mm = String(model.model || '').toLowerCase()
      if (!mp && !mm) return false
      // A stored profile may predate a built-in alias and carry its own
      // providerExact list. The signed-in DeepSeek account is still a billing
      // route of the DeepSeek source, so it must not depend on that old list.
      if (provider.id === 'deepseek' && mp === 'deepseek-account') return true
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
    // ---------------- 模型座位上的订阅额度 ----------------
    // The header chip only exists once a session has started, but the composer's
    // model button is there from the first paint. It carries the same reading as a
    // 3px rail on the button's bottom edge: on the button while the session is
    // empty, and on every row of the model picker. See
    // docs/features/model-quota-bar.md.
    //
    // The rail is written as inline background layers on the Host's own button:
    // its hover rule sets the `background` shorthand, which resets a
    // background-image written by a stylesheet rule (verified in Chromium).
    var usePaintEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

    // Subscription identity for the rail's tint. Token mixes, so both themes keep
    // working; a balance source never uses it for a proportion.
    // Non-subscription providers; Magpie reports the model namespace as the id.
    var PLAN_COLORS = {
      deepseek: 'var(--dsw-alias-brand-primary)', 'kimi-code': 'color-mix(in oklab, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-state-error-primary))',
      zai: 'var(--dsw-alias-state-warn-primary)', zhipu: 'var(--dsw-alias-state-warn-primary)', openrouter: 'var(--dsw-alias-label-tertiary)',
      workbuddy: 'color-mix(in oklab, var(--dsw-alias-state-business-primary) 55%, var(--dsw-alias-state-success-primary))',
      'workbuddy-ai': 'color-mix(in oklab, var(--dsw-alias-state-business-primary) 55%, var(--dsw-alias-state-success-primary))',
    }
    SUBSCRIPTION_KINDS.forEach(function (kind) { PLAN_COLORS[kind] = SUBSCRIPTIONS[kind].color })
    function planColor(key) {
      return PLAN_COLORS[key] || 'var(--dsw-alias-label-secondary)'
    }
    function planKeyOf(source) {
      if (!source) return ''
      if (source.kind === 'provider') return source.id
      // A Magpie subscription carries its own id (`workbuddy-ai`); a known alias
      // (`agy-cli`, `claude-code`) takes the subscription's own colour.
      if (source.kind === 'magpie') return subscriptionKindOf(source.id) || String(source.id || 'magpie')
      return source.kind
    }
    function quotaKindEnabled(config, kind) {
      var sub = SUBSCRIPTIONS[kind]
      if (!config || !sub || !sub.setting) return false
      return sub.showDefault ? config[sub.setting] !== false : !!config[sub.setting]
    }
    // The one model-to-subscription order: the header chip and the model seat's
    // rail both read it, so they cannot disagree about which source a model uses.
    // `subscriptionOnly` and `quietAbsent` are the chip's reading rules: a source
    // with no data is reported, never replaced by another subscription's figure.
    function modelQuotaSource(model, config) {
      if (!model || !config) return null
      var providers = config.providers || []
      for (var i = 0; i < providers.length; i++) {
        var provider = providers[i]
        if (provider && provider.enabled !== false && providerMatchesModel(provider, model)) {
          return { kind: 'provider', id: provider.id, provider: provider, modelProvider: model.provider,
            key: 'provider:' + provider.id, plan: provider.label || provider.id, subscriptionOnly: false, quietAbsent: false }
        }
      }
      var kind = primarySubscriptionKind(model)
      if (kind && quotaKindEnabled(config, kind)) {
        var sub = SUBSCRIPTIONS[kind]
        return { kind: kind, key: kind, plan: sub.short ? t(sub.short) : sub.name, subscriptionOnly: true, quietAbsent: false }
      }
      if (!kind) {
        var hint = magpieSubscriptionHint(model)
        if (hint) {
          return { kind: 'magpie', id: hint, provider: { id: hint, label: hint, noApiKey: true }, key: 'magpie:' + hint,
            plan: hint, subscriptionOnly: true, quietAbsent: !looksLikeSubscription(model) }
        }
      }
      return null
    }
    function enabledQuotaKinds(config) {
      return QUOTA_SUBSCRIPTION_KINDS.filter(function (kind) { return quotaKindEnabled(config, kind) })
    }
    // One number per subscription: the window that will block you first. A
    // balance has no denominator, so it reports its amount instead of a ratio;
    // only a warning state (unavailable or below the red line) becomes a rail.
    function modelQuotaMeter(data, mode) {
      if (!data) return null
      if (data.style === 'balance') {
        var wallets = Array.isArray(data.balances) && data.balances.length ? data.balances : [data]
        var main = wallets[0] || {}
        var remaining = quotaNumber(main.remaining)
        var currency = main.currency || data.currency || ''
        var redBelow = quotaNumber(data.redBelow)
        var low = data.isAvailable === false || (redBelow !== null && remaining !== null && remaining < redBelow)
        return { style: 'balance', text: remaining !== null ? fmtMoney(remaining, currency) : '', low: low }
      }
      var windows = validWindows(data)
      if (!windows.length) return null
      var shown = chipWindowsOf(data, windows)
      var worst = shown[0]
      for (var i = 1; i < shown.length; i++) if (shown[i].usedPercent > worst.usedPercent) worst = shown[i]
      var metric = quotaMetric(worst.usedPercent, worst.remainingPercent, mode)
      return { style: 'windows', pct: metric.shown, used: metric.used, exhausted: worst.exhausted === true, window: worst }
    }
    function meterPaint(meter, plan) {
      if (!meter) return null
      if (meter.style === 'balance') {
        return meter.low ? { pct: 1, key: 'balance:low', color: 'color-mix(in oklab, var(--dsw-alias-state-error-primary) 18%, transparent)' } : null
      }
      var pct = Math.max(0, Math.min(1, meter.pct / 100))
      // A window subscription has no amount text: this 3px fill is the whole
      // reading, so it carries the state colour at a strength the eye can pick
      // out. It stays a fill behind text, not a block.
      var color = meter.exhausted
        ? 'color-mix(in oklab, var(--dsw-alias-state-error-primary) 42%, transparent)'
        : 'color-mix(in oklab, ' + planColor(plan) + ' 42%, transparent)'
      return { pct: pct, key: 'windows:' + meter.pct + ':' + (meter.exhausted ? 'exhausted' : plan), color: color }
    }
    // A failed read is not "nothing to show". The subscription is known and the
    // seat is in use, so an empty rail would claim the model has no quota
    // reading at all — the same picture a user sees for a model whose source is
    // switched off. Paint a hatched track instead: unknown, and visibly so.
    function modelQuotaFailurePaint(source, error) {
      if (!source) return null
      // Quieter than a reading on purpose: a texture saying "no value" must not
      // out-shout the rows that do have one.
      return { failed: true, key: 'failed:' + (error || 'unknown'),
        color: 'color-mix(in oklab, var(--dsw-alias-state-warn-primary) 20%, transparent)' }
    }
    function applyModelRail(node, paint) {
      var span = 'calc(100% - 12px) 3px'
      if (paint.failed) {
        node.setAttribute('data-slp-model-rail', 'failed')
        // Hatching reads as "no reading" at 3px; a solid wash would read as a
        // value. The track underneath keeps the rail's position legible.
        node.style.backgroundImage = 'repeating-linear-gradient(135deg, ' + paint.color + ' 0 3px, transparent 3px 6px), ' +
          'linear-gradient(color-mix(in oklab, var(--dsw-alias-label-tertiary) 10%, transparent) 0 100%)'
        node.style.backgroundSize = span + ', ' + span
        node.style.backgroundPosition = '6px calc(100% - 3px), 6px calc(100% - 3px)'
        node.style.backgroundRepeat = 'no-repeat, no-repeat'
        return
      }
      node.setAttribute('data-slp-model-rail', paint.pct >= 1 ? 'full' : 'part')
      node.style.backgroundImage = 'linear-gradient(' + paint.color + ' 0 100%), linear-gradient(color-mix(in oklab, var(--dsw-alias-label-tertiary) 10%, transparent) 0 100%)'
      node.style.backgroundSize = 'calc((100% - 12px) * ' + paint.pct + ') 3px, calc(100% - 12px) 3px'
      node.style.backgroundPosition = '6px calc(100% - 3px), 6px calc(100% - 3px)'
      node.style.backgroundRepeat = 'no-repeat, no-repeat'
    }
    function clearModelRail(node) {
      node.removeAttribute('data-slp-model-rail')
      node.style.backgroundImage = ''
      node.style.backgroundSize = ''
      node.style.backgroundPosition = ''
      node.style.backgroundRepeat = ''
    }
    // One request per subscription, shared by the button and the picker rows: a
    // cold picker would otherwise ask once per model, and four Claude models are
    // one subscription.
    var modelQuotaStore = (function () {
      var entries = new Map(), listeners = new Set()
      function notify(key) { listeners.forEach(function (listener) { if (listener.key === key) listener.fn() }) }
      return {
        snapshot: function (key) { return entries.get(key) || null },
        read: function (resource, config) {
          if (!resource || !resource.key) return
          var entry = entries.get(resource.key)
          if (!entry) { entry = { data: null, error: null, at: 0, retryAt: 0, inflight: false }; entries.set(resource.key, entry) }
          if (entry.inflight) return
          var now = Date.now()
          var ttl = quotaTtlMs(config && config.cacheTtlMs)
          if (entry.retryAt && now < entry.retryAt) return
          if (entry.data && now - entry.at < ttl) return
          entry.inflight = true
          quotaRequest(resource, false).then(function (result) {
            entry.inflight = false
            if (result && result.ok) { entry.data = result.data; entry.error = null; entry.at = Date.now(); entry.retryAt = 0 }
            else {
              entry.error = (result && result.error) || 'network'
              // Stay behind the Host's 15 s error cache and 60 s for 429s.
              entry.retryAt = Date.now() + quotaRetryMs(entry.error)
            }
            notify(resource.key)
          })
        },
        subscribe: function (fn, key) {
          var listener = { fn: fn, key: key }
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
      }
    })()
    function useModelQuota(resource, config, active) {
      var pair = React.useState(0), bump = pair[1]
      var key = resource ? resource.key : ''
      React.useEffect(function () {
        if (!active || !key) return undefined
        var alive = true
        var off = modelQuotaStore.subscribe(function () { if (alive) bump(function (n) { return n + 1 }) }, key)
        var refresh = function () { modelQuotaStore.read(resource, config) }
        modelQuotaStore.read(resource, config)
        // A transient failure (a gateway still starting) recovers on the next
        // focus or reconnect; the store still enforces its cache and backoff.
        window.addEventListener('focus', refresh)
        window.addEventListener('online', refresh)
        return function () {
          alive = false
          off()
          window.removeEventListener('focus', refresh)
          window.removeEventListener('online', refresh)
        }
      }, [active, key])
      return key ? modelQuotaStore.snapshot(key) : null
    }
    // The composer dock mounts only in `variant === "composer"`; the Host renders
    // nothing there in a blank (hero) session. That public mount is the signal
    // that the conversation has started, so the button can drop its rail while
    // the picker keeps its rows.
    var composerStarted = false
    var composerStartedListeners = new Set()
    function setComposerStarted(value) {
      if (composerStarted === value) return
      composerStarted = value
      composerStartedListeners.forEach(function (fn) { fn() })
    }
    function useComposerStarted() {
      var pair = React.useState(composerStarted), value = pair[0], set = pair[1]
      // Layout effect: the dock reports itself before paint, so a conversation
      // never shows the rail for one frame.
      usePaintEffect(function () {
        var fn = function () { set(composerStarted) }
        composerStartedListeners.add(fn)
        fn()
        return function () { composerStartedListeners.delete(fn) }
      }, [])
      return value
    }
    function modelQuotaTitle(data, plan, mode) {
      if (!data) return ''
      var name = (typeof data.label === 'string' && data.label) || plan || ''
      if (data.style === 'balance') {
        var wallets = Array.isArray(data.balances) && data.balances.length ? data.balances : [data]
        var amounts = wallets.map(function (wallet) {
          var left = quotaNumber(wallet && wallet.remaining)
          return left === null ? '' : fmtMoney(left, (wallet && wallet.currency) || data.currency)
        }).filter(Boolean)
        return amounts.length ? name + ' · ' + tf('modelQuotaBalance', { v: amounts.join(' · ') }) : name
      }
      var windows = validWindows(data)
      if (!windows.length) return name
      return name + ' · ' + windows.map(function (win) {
        var label = windowLongLabel(win, windows, name)
        var text = label + ' ' + quotaMetric(win.usedPercent, win.remainingPercent, mode).word
        var reset = quotaNumber(win.resetInSec)
        return reset > 0 ? text + ' ' + fmtResetShort(reset) : text
      }).join(' · ')
    }
    // Tooltip for a rail whose subscription is known but whose reading failed.
    // No countdown: the store retries on its own ladder and a frozen "15s" would
    // be a lie by the time it is read.
    function modelQuotaFailTitle(error) {
      return tf('modelQuotaFailed', { reason: quotaReasonShort(error) })
    }
    // A figure that survived a failed refresh is still the last good reading, and
    // the tooltip says so, so it cannot pass for a fresh one.
    function modelQuotaStaleSuffix(entry) {
      return entry && entry.error && entry.data ? ' · ' + t('modelQuotaStale') : ''
    }
    function resolveBadgeText(text) {
      if (typeof text === 'string') return text
      if (!text || typeof text !== 'object') return ''
      return String(text[currentLang()] || text.en || '')
    }
    // The Host's own label renders `model.name` and an optional Tag badge; a
    // slot registration replaces that fallback, so both are reproduced here.
    function modelBadgeNode(model) {
      if (!model || !model.badge) return null
      var text = resolveBadgeText(model.badge.text)
      if (!text) return null
      if (Primitives && typeof Primitives.Tag === 'function') return React.createElement(Primitives.Tag, { tone: model.badge.tone }, text)
      return React.createElement('span', { className: 'slp-mq-badge' }, text)
    }
    // The Host's model rows set their highlight in `onMouseMove`, and model
    // rows deliberately have no `:hover` rule (the non-model cells do). A wheel
    // scroll moves a different row under a stationary pointer without firing
    // `mousemove`, so the old row keeps the highlight until the pointer moves.
    // Re-dispatch the event the Host already listens for on the row under the
    // pointer; the Host remains the only writer of its active/highlight state.
    var modelMenuScrollBound = typeof WeakSet === 'function' ? new WeakSet() : null
    function bindModelMenuScroll(label) {
      if (!modelMenuScrollBound || !label || typeof document === 'undefined') return
      var row = label.closest && label.closest('button, [role="menuitemradio"], [role="option"]')
      if (!row) return
      var scroller = row.parentElement
      while (scroller && scroller !== document.body) {
        var overflow = getComputedStyle(scroller).overflowY
        if (overflow === 'auto' || overflow === 'scroll') break
        scroller = scroller.parentElement
      }
      if (!scroller || scroller === document.body || modelMenuScrollBound.has(scroller)) return
      modelMenuScrollBound.add(scroller)
      var pointer = null, last = null, queued = false, wheelDriven = false, wheelTimer = 0
      var remember = function (event) { pointer = { x: event.clientX, y: event.clientY } }
      var rememberWheel = function (event) {
        remember(event)
        wheelDriven = true
        if (wheelTimer) clearTimeout(wheelTimer)
        wheelTimer = setTimeout(function () { wheelDriven = false }, 500)
      }
      var follow = function () {
        if (!scroller.isConnected || !pointer) return
        var node = document.elementFromPoint(pointer.x, pointer.y)
        var target = node && node.closest && node.closest('button, [role="menuitemradio"], [role="option"]')
        if (!target || !scroller.contains(target) || target === last) return
        last = target
        target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: pointer.x, clientY: pointer.y }))
      }
      var onScroll = function () {
        // Only a wheel-driven scroll should move the highlight; search,
        // keyboard and focus scrolls have their own active-row rules.
        if (!wheelDriven || queued) return
        queued = true
        requestAnimationFrame(function () { queued = false; follow() })
      }
      // Passive: the wheel's native scrolling is never delayed or prevented.
      scroller.addEventListener('pointermove', remember, { passive: true, capture: true })
      scroller.addEventListener('wheel', rememberWheel, { passive: true, capture: true })
      scroller.addEventListener('scroll', onScroll, { passive: true })
    }
    // Registered into `conversation.input.model.label`. `placement` is the
    // Host's: `trigger` (the composer button), `menu` (the picker's Model cell)
    // and `option` (one model row).
    function ModelQuotaLabelView(props) {
      useLocaleRevision()
      var config = useConfigSnapshot()
      var placement = props.placement === 'option' ? 'option' : props.placement === 'menu' ? 'menu' : 'trigger'
      var started = useComposerStarted()
      var model = { provider: props.provider && props.provider.id, model: props.model && props.model.id }
      var source = config && config.enabled && config.showQuota ? modelQuotaSource(model, config) : null
      var active = !!source && (placement === 'option' ? config.modelQuotaRows !== false
        : placement === 'trigger' ? config.modelQuotaBar !== false && !started : false)
      var entry = useModelQuota(source, config, active)
      var meter = entry && entry.data ? modelQuotaMeter(entry.data, config && config.quotaPercentMode) : null
      // A known subscription with no reading is a failure, not an absence. A
      // healthy balance paints nothing by design, so this is decided before
      // meterPaint rather than after it.
      var failure = active && !meter && entry && entry.error ? String(entry.error) : ''
      var paint = !active ? null : meter ? meterPaint(meter, planKeyOf(source)) : failure ? modelQuotaFailurePaint(source, failure) : null
      var showInfo = placement === 'option' || (placement === 'trigger' && !started)
      var hostRef = React.useRef(null)
      var paintKey = paint ? paint.key : ''
      React.useEffect(function () {
        if (placement === 'option' && hostRef.current) bindModelMenuScroll(hostRef.current)
      }, [placement])
      usePaintEffect(function () {
        var node = hostRef.current && hostRef.current.closest ? hostRef.current.closest('button') : null
        if (!node) return undefined
        if (!paint) return function () { clearModelRail(node) }
        applyModelRail(node, paint)
        return function () { clearModelRail(node) }
      }, [paintKey])
      var badge = modelBadgeNode(props.model)
      var title = ''
      if (showInfo) {
        if (entry && entry.data) title = modelQuotaTitle(entry.data, source && source.plan, config && config.quotaPercentMode) + modelQuotaStaleSuffix(entry)
        else if (failure) title = modelQuotaFailTitle(failure)
      }
      var amount = showInfo && meter && meter.style === 'balance' ? meter.text : ''
      return React.createElement('span', { className: 'slp-mq slp-mq-' + placement, ref: hostRef, title: title || undefined },
        placement === 'trigger' ? badge : null,
        placement === 'trigger' && badge ? ' ' : null,
        React.createElement('span', { className: 'slp-mq-name' }, String((props.model && props.model.name) || '')),
        placement !== 'trigger' && badge ? ' ' : null,
        placement !== 'trigger' ? badge : null,
        amount ? React.createElement('span', { className: 'slp-mq-amount' }, amount) : null)
    }
    // The Host re-renders the picker on every streamed step. The label's props
    // carry the same primitive identity then, so skip the subtree; the store's
    // subscription still re-renders it when its own quota key changes.
    function sameModelQuotaLabel(a, b) {
      if (a.placement !== b.placement || a.selected !== b.selected) return false
      var ap = a.provider || {}, bp = b.provider || {}, am = a.model || {}, bm = b.model || {}
      if (ap.id !== bp.id || am.id !== bm.id || am.name !== bm.name || am.provider !== bm.provider) return false
      var ab = am.badge, bb = bm.badge
      if (!ab || !bb) return ab === bb
      return ab.tone === bb.tone && ab.text === bb.text
    }
    var ModelQuotaLabel = typeof React.memo === 'function' ? React.memo(ModelQuotaLabelView, sameModelQuotaLabel) : ModelQuotaLabelView

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
    // Gift credit follows the amount it is added to, so it does not repeat the
    // currency symbol: "¥51.43+3.23", not "¥51.43+¥3.23".
    function fmtAmount(v) {
      var n = quotaNumber(v)
      return n === null ? '—' : n.toFixed(2)
    }

    // Reuses the local peak indicator's official schedule. Beijing is UTC+8;
    // UTC date arithmetic keeps the result independent of browser timezones.
    // Calendar coverage is explicit: an unknown year's weekday holiday must
    // never silently become a confirmed peak window.
    // Only the year on screen and the next one: the panel shows today and its next
    // switch, so a past year is dead weight that still has to be read and reviewed.
    var PEAK_HOLIDAYS = {
      2026: [
        ['01-01', '01-03', '元旦'], ['02-15', '02-23', '春节'],
        ['04-04', '04-06', '清明节'], ['05-01', '05-05', '劳动节'],
        ['06-19', '06-21', '端午节'], ['09-25', '09-27', '中秋节'],
        ['10-01', '10-07', '国庆节'],
      ],
      // The fetched calendar wins whenever it is published; this floor keeps the
      // offline reading correct instead of "unknown" for the whole year.
      2027: [
        ['01-01', '01-03', '元旦'], ['02-05', '02-13', '春节'],
        ['04-03', '04-05', '清明节'], ['05-01', '05-05', '劳动节'],
        ['06-09', '06-09', '端午节'], ['09-15', '09-15', '中秋节'],
        ['10-01', '10-07', '国庆节'],
      ],
    }
    function isDeepseekBilling(model) {
      return !!model && ['deepseek', 'deepseek-official', 'deepseek-account'].indexOf(String(model.provider || '').toLowerCase()) !== -1
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
      2026: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10'],
      2027: ['01-31', '02-14', '05-08', '09-26', '10-09'],
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
        // Wording and numbers are separate readings of the same page: a price cut
        // leaves the sentence intact, which is why this is not folded into ruleChanged.
        ratesChanged: !!(rule && rule.rates && rule.rates.status === 'changed'),
        ratesUnreadable: !!(rule && rule.rates && (rule.rates.status === 'unreadable' || rule.rates.status === 'implausible')),
        rateChanges: (rule && rule.rates && rule.rates.changes) || [],
        ruleCheckedAt: quotaNumber(rule && rule.checkedAt),
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
    function peakLocalTime(at) {
      var lang = activeLocale()
      return new Date(at).toLocaleString(lang.indexOf('zh') === 0 ? 'zh-CN' : lang)
    }
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
          status.ratesChanged ? React.createElement('p', { className: 'slp-peak-alert', 'data-alert': 'rates' }, tf('peakRatesChanged', { list: peakRatesLine(status) })) : null,
          status.ratesUnreadable ? React.createElement('p', { className: 'slp-peak-alert', 'data-alert': 'rates' }, t('peakRatesUnreadable')) : null,
          peakRatesStaleDays(status, now) !== null ? React.createElement('p', { className: 'slp-peak-source' }, tf('peakRatesStale', { n: peakRatesStaleDays(status, now) })) : null,
          React.createElement('a', { className: 'slp-peak-link', href: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', target: '_blank', rel: 'noopener noreferrer' }, t('peakOfficialShort')))
      }
      return React.createElement('div', { className: 'slp-panel slp-peak-panel ' + (props.className || 'slp-panel-down'), role: 'region', 'aria-label': t('peakTitle'), style: props.style },
        React.createElement('strong', null, t('peakTitle')),
        React.createElement('p', null, t('peakRule')),
        timeline,
        status.holiday ? React.createElement('p', null, tf('peakHoliday', { name: status.holiday })) : null,
        status.makeupWorkday ? React.createElement('p', null, t('peakMakeupDay')) : status.weekend ? React.createElement('p', null, t('peakWeekend')) : null,
        status.ruleChanged ? React.createElement('p', { className: 'slp-peak-alert' }, t('peakRuleChanged')) : null,
        status.ratesChanged ? React.createElement('p', { className: 'slp-peak-alert', 'data-alert': 'rates' }, tf('peakRatesChanged', { list: peakRatesLine(status) })) : null,
        status.ratesUnreadable ? React.createElement('p', { className: 'slp-peak-alert', 'data-alert': 'rates' }, t('peakRatesUnreadable')) : null,
        peakRatesStaleDays(status, now) !== null ? React.createElement('p', { className: 'slp-peak-source' }, tf('peakRatesStale', { n: peakRatesStaleDays(status, now) })) : null,
        status.calendarSource ? React.createElement('p', { className: 'slp-peak-source' }, t(status.calendarSource === 'fetched' ? 'peakSourceFetched' : 'peakSourceBuiltin')) : null,
        React.createElement('p', null, t('peakBeijing') + ': ' + status.beijingDate + ' ' + status.beijingTime + ' (UTC+8)'),
        React.createElement('p', null, t('peakLocal') + ': ' + peakLocalTime(now)),
        React.createElement('p', null, summary.next),
        status.nextSwitchAt !== null && props.countdown !== false ? React.createElement('p', null, t('peakNextSwitch') + ': ' + peakLocalTime(status.nextSwitchAt)) : null,
        React.createElement('a', { className: 'slp-peak-link', href: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', target: '_blank', rel: 'noopener noreferrer' }, t('peakOfficial')))
    }
    // What the built-in card says versus what the page says, in one line each.
    // The path (flash · peak · miss) is precise on purpose: this line is aimed at
    // someone deciding whether to edit the card.
    function fmtYuan(v) {
      var n = Number(v)
      if (!Number.isFinite(n)) return String(v)
      return String(Math.round(n * 1000) / 1000)
    }
    function peakRatesLine(status) {
      return (status.rateChanges || []).slice(0, 2).map(function (change) {
        if (change.what === 'discount') return tf('peakRateDiscount', { from: fmtYuan(change.from), to: fmtYuan(change.to) })
        return tf('peakRateItem', { what: String(change.what).split('.').join(' · '), from: fmtYuan(change.from), to: fmtYuan(change.to) })
      }).join('; ')
    }
    function peakRatesStaleDays(status, now) {
      var at = quotaNumber(status.ruleCheckedAt)
      if (at === null || !(at > 0)) return null
      var days = Math.floor((now - at) / 86400000)
      return days >= 7 ? days : null
    }
    function DeepseekPeakChip(props) {
      var visible = usePageVisible(props.enabled !== false)
      var dismiss = useDismissiblePanel()
      usePeakClock(props.enabled !== false && visible, props.countdown === false && !dismiss.open)
      var schedule = usePeakSchedule(props.enabled !== false)
      useResetAnchorSignal(props.enabled !== false && visible)
      var now = Date.now()
      if (props.enabled === false || !visible) return null
      var status = deepseekPeakStatus(now, schedule), summary = peakSummary(status, props.countdown)
      var color = status.isPeak === null ? 'var(--dsw-alias-label-tertiary)' : status.isPeak ? 'var(--dsw-alias-state-warn-label)' : 'var(--dsw-alias-state-success-primary)'
      var title = summary.label + ' · ' + summary.next + ' · ' + t('peakBeijing') + ' ' + status.beijingDate + ' ' + status.beijingTime
      // Last-resort reset anchor: after every quota chip in document order.
      return React.createElement('span', { className: 'slp-quota-root', ref: dismiss.rootRef, onBlur: dismiss.onBlur, 'data-slp-reset-kind': '', 'data-slp-reset-last': 'true', 'data-slp-quota-ready': 'true' },
        React.createElement('button', Object.assign({ className: 'slp-quota-trigger slp-peak-trigger', type: 'button', 'data-peak': peakTone(status),
          style: { color: color }, 'aria-expanded': dismiss.open, onClick: dismiss.toggle }, dismiss.titleProps(title, String(status.isPeak) + '|' + summary.label)),
          React.createElement('span', { className: 'slp-peak-dot', 'aria-hidden': true }), summary.label,
          props.countdown !== false && status.remainingSec !== null ? React.createElement('span', { className: 'slp-peak-countdown' }, peakCountdown(status.remainingSec)) : null),
        dismiss.open ? React.createElement(AnchoredPanel, { dismiss: dismiss }, React.createElement(PeakPanel, { status: status, now: now, countdown: props.countdown })) : null)
    }
    // Sidebar footer dot: visible without any session. A plain span, not an
    // <svg>: dsh-ui-tweaks recolours footer svgs to the grey label token.
    // Yellow = peak, green = off-peak, grey = calendar not covered. The panel
    // is fixed-positioned above the button so a clipping container cannot hide it.
    function PeakFooterDot() {
      useLocaleRevision()
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
      // Closed, this clock sleeps until the next switch, so entry re-renders to
      // read a current countdown; the hover time in the key takes that fresh
      // text before the tooltip shows, then holds it while the open panel ticks.
      var titled = dismiss.titleProps(title, [status.isPeak, summary.label, status.ruleChanged, hover[0]].join('|'))
      return React.createElement('span', { className: 'slp-quota-root slp-peak-foot', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { type: 'button', className: 'dsh-sidebar-footer-action slp-peak-dot-btn', 'data-peak': peakTone(status), 'data-alert': status.ruleChanged ? 'true' : undefined,
          title: titled.title, 'aria-label': title, 'aria-expanded': dismiss.open,
          onPointerEnter: function (event) { titled.onPointerEnter(event); hover[1](Date.now()) },
          onPointerLeave: titled.onPointerLeave,
          onClick: function (event) {
            var box = event.currentTarget.getBoundingClientRect(), height = window.innerHeight
            anchor[1](Number.isFinite(height) && box ? { left: Math.max(8, box.left), bottom: Math.max(8, height - box.top + 8) } : null)
            dismiss.setOpen(function (open) { return !open })
          } },
          React.createElement('span', { className: 'slp-peak-dot-lg', 'aria-hidden': true })),
        dismiss.open ? React.createElement(PeakPanel, { status: status, now: now, countdown: true, compact: true, className: 'slp-panel-fixed',
          style: anchor[0] ? { left: anchor[0].left + 'px', bottom: anchor[0].bottom + 'px' } : undefined }) : null)
    }
    // ---------------- Reload / restart ----------------
    // The flow, dialog and toast live at module scope on document.body: the
    // footer button and the settings page share one run, and the sidebar's
    // render cycle never touches them. Host side: lib/restart.js.
    var RESTART_API = '/statusline/api/restart'
    var RS_FAST_MS = 250, RS_MAX_MS = 1000, RS_SLOW_AFTER_MS = 15000, RS_DEADLINE_MS = 60000
    // The Host gives npm five minutes; then the restart itself.
    var RS_UPDATE_DEADLINE_MS = 15 * 60000
    var restartFlow = null
    var restartDialog = null
    var restartToastEl = null
    var restartListeners = []
    function notifyRestart() { for (var i = 0; i < restartListeners.length; i++) restartListeners[i]() }
    function apiRestartStatus(signal, withUpdate) {
      return fetch(RESTART_API + (withUpdate ? '?update=1' : ''), { cache: 'no-store', signal: signal }).then(function (response) {
        return response.json().then(function (body) { return { status: response.status, body: body } },
          function () { return { status: response.status, body: null } })
      })
    }
    /** Delay before the next status probe: fast while a reload normally finishes, then backing off. */
    function restartPollDelay(elapsedMs) {
      return elapsedMs < RS_SLOW_AFTER_MS ? RS_FAST_MS : RS_MAX_MS
    }
    // One Host job phase maps to the probe step (`restartStep`) and the visible
    // progress step (`restartProgressSteps`); an update error maps to the step
    // that failed and its sentence. Keeping both maps in one table stops the
    // status probe and the panel from disagreeing about the same job.
    var RESTART_STEPS = [['stop', 'rsStepStop'], ['install', 'rsStepInstall'], ['reconcile', 'rsStepReconcile'], ['start', 'rsStepStart']]
    var RESTART_PHASES = {
      queued: { step: 'stopping', ui: 'stop' }, stopping: { step: 'stopping', ui: 'stop' },
      installing: { step: 'updating', ui: 'install' }, reconciling: { step: 'reconciling', ui: 'reconcile' },
      starting: { step: 'starting', ui: 'start' }, verifying: { step: 'starting', ui: 'start' },
      healthy: { step: 'waiting', done: true }, 'rolling-back': { step: 'starting', ui: null, rollingBack: true },
      'rolled-back': { step: 'rolled-back', ui: null }, failed: { step: 'failed', ui: null },
    }
    var RESTART_ERRORS = {
      'install-failed': { ui: 'install', text: 'rsErrInstall' }, 'version-mismatch': { ui: 'install', text: 'rsErrInstall' },
      'profile-reconcile-failed': { ui: 'reconcile', text: 'rsErrReconcile' },
      'start-failed': { ui: 'start', text: 'rsErrStart' }, unhealthy: { ui: 'start', text: 'rsErrStart' },
      'rollback-failed': { ui: 'start', text: 'rsErrRollback' },
      'helper-start': { ui: 'stop', text: 'rsErrHelper' }, 'stop-failed': { ui: 'stop', text: 'rsErrStop' },
    }
    /**
     * What the page shows for one status probe of a run that started on process `pid`.
     * `expectedVersion` and `jobId` are used only by a DSH update: the new process
     * must report the requested version, and the job file follows the run across
     * the bounce.
     * @returns {{step: string, reason?: string}} step is one of waiting, booting,
     *   reloading, stopping, updating, reconciling, starting, done, failed,
     *   rolled-back, stale-version, manual, refused.
     */
    function restartStep(probe, pid, expectedVersion, jobId) {
      if (!probe) return { step: 'waiting' }
      if (probe.status === 401 || probe.status === 403) return { step: 'refused' }
      var data = probe.body && probe.body.data
      if (!data || typeof data !== 'object') return { step: 'booting' }
      var job = data.job && (!jobId || data.job.id === jobId) ? data.job : null
      var withJob = function (value) { if (job) value.job = job; return value }
      if (data.pid !== pid) {
        if (job && job.phase === 'rolled-back') {
          return withJob({ step: 'rolled-back', reason: job.error || 'update', previous: job.previousVersion || null })
        }
        if (data.ready === true && probe.status === 200) {
          if (expectedVersion && !data.hostVersion && job && job.phase === 'failed') {
            return withJob({ step: 'failed', reason: job.error || 'update' })
          }
          if (expectedVersion && typeof data.hostVersion !== 'string') {
            return withJob({ step: 'stale-version', actual: null, expected: expectedVersion, reason: job && job.error || null })
          }
          if (expectedVersion && data.hostVersion !== expectedVersion) {
            return withJob({ step: 'stale-version', actual: data.hostVersion, expected: expectedVersion, reason: job && job.error || null })
          }
          return withJob({ step: 'done' })
        }
        if (job && job.phase === 'failed') return withJob({ step: 'failed', reason: job.error || 'update' })
        return withJob({ step: 'booting' })
      }
      if (job) {
        var phase = RESTART_PHASES[job.phase]
        if (phase) {
          if (phase.step === 'rolled-back') return withJob({ step: 'rolled-back', reason: job.error || 'update', previous: job.previousVersion || null })
          if (phase.step === 'failed') return withJob({ step: 'failed', reason: job.error || 'update' })
          return withJob(Object.assign({ step: phase.step }, phase.rollingBack ? { rollingBack: true } : {}))
        }
      }
      if (data.phase === 'reloaded') return { step: 'done' }
      if (data.phase === 'failed') return { step: 'failed', reason: data.reason }
      if (data.phase === 'manual') return { step: 'manual', reason: data.reason }
      if (data.phase === 'confirm') return { step: 'confirm', reason: data.reason, active: typeof data.active === 'number' ? data.active : null }
      if (data.phase === 'restarting') return { step: 'stopping' }
      if (data.phase === 'updating') return { step: 'stopping' }
      return { step: 'reloading' }
    }
    /** Which step a fixed update error belongs to, for the progress panel. */
    function restartProgressErrorStep(job) {
      var hit = job && RESTART_ERRORS[job.error]
      return hit ? hit.ui : 'install'
    }
    /**
     * The four visible update steps and their state for one probe or job phase.
     * Pure so the client tests can pin the step map without a DOM.
     */
    function restartProgressSteps(job, step) {
      var order = RESTART_STEPS.map(function (entry) { return entry[0] })
      var phase = job && typeof job.phase === 'string' ? job.phase : null
      var rule = phase ? RESTART_PHASES[phase] : null
      var active = 'install', failed = false, done = false
      // The terminal step wins over a healthy job: a stale version means the
      // start/verify step failed even though the service is up.
      if (step === 'stale-version') { failed = true; active = 'start' }
      else if (step === 'refused') { failed = true; active = '' }
      else if (step === 'failed' || (step === 'rolled-back' && !job)) { failed = true; active = restartProgressErrorStep(job) }
      if (rule) {
        if (rule.ui) active = rule.ui
        else if (rule.ui === null) { failed = true; active = restartProgressErrorStep(job) }
        if (rule.done) done = true
      } else if (step === 'stopping') active = 'stop'
      else if (step === 'updating') active = 'install'
      else if (step === 'reconciling') active = 'reconcile'
      else if (step === 'starting' || step === 'waiting' || step === 'booting') active = 'start'
      else if (step === 'done' || step === 'reloaded') done = true
      else if (step === 'failed' || step === 'rolled-back') {
        failed = true
        active = restartProgressErrorStep(job)
      }
      var activeIndex = order.indexOf(active)
      if (done && !failed) activeIndex = order.length
      var steps = order.map(function (id, index) {
        var state
        if (job && (job.reconcileSkipped || job.reconcile === false) && id === 'reconcile') state = 'skipped'
        else if (failed) state = index < activeIndex ? 'done' : index === activeIndex ? 'failed' : 'pending'
        else if (done) state = 'done'
        else state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending'
        return { id: id, state: state }
      })
      return { steps: steps, active: active, failed: failed, done: done, skippedReconcile: !!(job && (job.reconcileSkipped || job.reconcile === false)) }
    }
    function rsEl(tag, attrs, children) {
      var node = document.createElement(tag)
      for (var key in attrs || {}) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue
        if (key === 'text') node.textContent = attrs[key]
        else node.setAttribute(key, attrs[key])
      }
      for (var i = 0; children && i < children.length; i++) if (children[i]) node.appendChild(children[i])
      return node
    }
    function rsAction(label, variant, onClick) {
      var button = rsEl('button', { type: 'button', 'class': 'slp-rs-act', 'data-variant': variant || 'plain', text: label })
      button.addEventListener('click', onClick)
      return button
    }
    function restartToast(view) {
      if (typeof document === 'undefined' || !document.body) return
      if (!restartToastEl) {
        restartToastEl = rsEl('div', { 'class': 'slp-rs-toast', 'data-plugin': 'dsh-statusline-plus' }, [
          rsEl('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, [
            rsEl('div', { 'class': 'slp-rs-toast-title' }), rsEl('div', { 'class': 'slp-rs-toast-detail' })]),
          rsEl('div', { 'class': 'slp-rs-actions' })])
        document.body.appendChild(restartToastEl)
      }
      if (restartToastEl.getAttribute('data-key') === view.key) return
      restartToastEl.setAttribute('data-key', view.key)
      var live = restartToastEl.firstChild, actions = restartToastEl.lastChild
      live.firstChild.textContent = view.title
      live.lastChild.textContent = view.detail || ''
      live.lastChild.hidden = !view.detail
      actions.textContent = ''
      for (var i = 0; view.actions && i < view.actions.length; i++) actions.appendChild(rsAction(view.actions[i][0], view.actions[i][1], view.actions[i][2]))
    }
    function closeRestartToast() {
      if (restartToastEl && restartToastEl.parentNode) restartToastEl.parentNode.removeChild(restartToastEl)
      restartToastEl = null
    }
    // The update flow keeps a modal progress panel instead of the small toast:
    // the Host stops for the whole install, so one static line looked hung.
    var restartProgress = null
    function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'" }
    function copyText(text, button) {
      var done = function () { if (button) button.textContent = t('rsCopied') }
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(done, function () {})
          return
        }
      } catch (error) { /* older browser */ }
      var area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', 'readonly')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try { document.execCommand('copy'); done() } catch (error) { /* selection is still visible */ }
      document.body.removeChild(area)
    }
    function restartProgressErrorText(job) {
      var hit = job && RESTART_ERRORS[job.error]
      return hit ? t(hit.text) : t('rsErrUnknown')
    }
    function createRestartProgress() {
      if (restartProgress || typeof document === 'undefined' || !document.body) return null
      var title = rsEl('h2', { id: 'slp-rs-progress-title', text: '' })
      var hint = rsEl('p', { id: 'slp-rs-progress-hint', 'class': 'slp-rs-progress-hint', text: '' })
      var list = rsEl('ol', { 'class': 'slp-rs-steps' })
      var steps = []
      for (var i = 0; i < RESTART_STEPS.length; i++) {
        var dot = rsEl('span', { 'class': 'slp-rs-step-dot', 'aria-hidden': 'true' })
        var label = rsEl('span', { 'class': 'slp-rs-step-text', text: t(RESTART_STEPS[i][1]) })
        var note = rsEl('span', { 'class': 'slp-rs-step-note' })
        note.hidden = true
        var item = rsEl('li', { 'class': 'slp-rs-step', 'data-step': RESTART_STEPS[i][0] }, [dot, label, note])
        list.appendChild(item)
        steps.push(item)
      }
      var bar = rsEl('div', { 'class': 'slp-rs-bar', role: 'progressbar', 'aria-label': t('rsProgressLabel') }, [rsEl('span')])
      var elapsed = rsEl('p', { 'class': 'slp-rs-elapsed', 'aria-hidden': 'true' })
      var detail = rsEl('p', { 'class': 'slp-rs-progress-detail', role: 'status', 'aria-live': 'polite' })
      var log = rsEl('p', { 'class': 'slp-rs-log' })
      log.hidden = true
      var actions = rsEl('div', { 'class': 'slp-rs-actions' })
      var node = rsEl('dialog', {
        'class': 'slp-rs-dialog slp-rs-progress', role: 'dialog',
        'aria-labelledby': 'slp-rs-progress-title', 'aria-describedby': 'slp-rs-progress-hint',
        'data-plugin': 'dsh-statusline-plus', tabindex: '-1',
      }, [title, hint, list, bar, elapsed, detail, log, actions])
      // A running update is not cancellable: npm must not be interrupted by a
      // stray Escape or backdrop click. The close actions appear on a result.
      node.addEventListener('cancel', function (event) { event.preventDefault() })
      document.body.appendChild(node)
      if (typeof node.showModal === 'function') node.showModal()
      try { node.focus() } catch (error) { /* focus is best effort */ }
      restartProgress = {
        node, title, hint, bar, elapsed, detail, log, actions, steps,
        last: null, actionKey: null, liveKey: null,
      }
      return restartProgress
    }
    function closeRestartProgress() {
      var panel = restartProgress
      if (!panel) return
      restartProgress = null
      try { if (panel.node.open) panel.node.close() } catch (error) { /* already closed */ }
      if (panel.node.parentNode) panel.node.parentNode.removeChild(panel.node)
    }
    function restartProgressDetail(view, state) {
      if (state === 'rolled-back') {
        var previous = view.job && view.job.previousVersion ? view.job.previousVersion : (view.previous || '?')
        return tf('rsProgressRolledBack', { 0: previous }) + ' ' + restartProgressErrorText(view.job)
      }
      if (state === 'failed') return t('rsProgressFailed') + ' ' + restartProgressErrorText(view.job)
      if (state === 'stale') return (view.actual ? tf('rsProgressStale', { 0: view.actual, 1: view.expected || '?' }) : t('rsProgressNoVersion')) + ' ' + t('rsCheckExecStart')
      if (state === 'refused') return t('rsFailRequest')
      if (state === 'unknown') return t('rsProgressUnknown')
      return ''
    }
    function restartProgressActions(view, state) {
      if (state === 'running') return []
      if (state === 'done') return []
      var logPath = view.job && view.job.logPath ? view.job.logPath : ''
      var actions = []
      if (logPath) actions.push([t('rsCopyLog'), '', function (event) {
        copyText('tail -n 120 ' + shellQuote(logPath), event.currentTarget)
      }])
      if (state === 'unknown') {
        actions.push([t('rsReloadNow'), 'primary', function () { window.location.reload() }])
      } else if (view.caps) {
        actions.push([t('rsRetryUpdate'), 'primary', function () {
          closeRestartProgress()
          runRestart('update', view.caps)
        }])
      }
      actions.push([t('rsDismiss'), '', closeRestartProgress])
      return actions
    }
    function updateRestartProgress(view) {
      var panel = restartProgress || createRestartProgress()
      if (!panel) return
      panel.last = view
      var model = restartProgressSteps(view.job, view.step)
      var state = view.state || (model.failed ? 'failed' : model.done ? 'done' : 'running')
      var title = state === 'done' ? t('rsProgressDoneTitle')
        : state === 'rolled-back' ? t('rsProgressRolledBackTitle')
          : state === 'failed' || state === 'stale' || state === 'refused' ? t('rsProgressFailedTitle')
            : state === 'unknown' ? t('rsUnknownTitle')
              : tf('rsProgressTitle', { 0: view.version || '' })
      panel.title.textContent = title
      panel.hint.textContent = state === 'running' ? t('rsProgressHint') : state === 'done' ? t('rsProgressDoneHint') : t('rsProgressStoppedHint')
      panel.node.setAttribute('data-state', state)
      for (var i = 0; i < panel.steps.length; i++) {
        var item = panel.steps[i], step = model.steps[i]
        item.setAttribute('data-state', step.state)
        item.setAttribute('aria-current', step.state === 'active' ? 'step' : 'false')
        var note = item.querySelector ? item.querySelector('.slp-rs-step-note') : null
        if (note && step.id === 'reconcile') {
          note.textContent = step.state === 'skipped'
            ? (view.job && view.job.reconcileSkipped ? t('rsReconcileSkipped') : t('rsReconcileNotNeeded'))
            : ''
          note.hidden = step.state !== 'skipped'
        }
      }
      panel.bar.setAttribute('data-state', model.failed ? 'failed' : model.done ? 'done' : 'running')
      var seconds = Math.max(0, Math.floor((view.elapsed || 0) / 1000))
      panel.elapsed.textContent = tf('rsElapsed', { 0: String(seconds) })
      var detail = restartProgressDetail(view, state)
      panel.detail.textContent = detail
      panel.detail.hidden = detail === ''
      var logPath = view.job && view.job.logPath ? view.job.logPath : ''
      var showLog = !!logPath && (state === 'failed' || state === 'rolled-back' || state === 'stale' || state === 'unknown')
      panel.log.textContent = showLog ? tf('rsLogPath', { 0: logPath }) : ''
      panel.log.hidden = !showLog
      var actions = restartProgressActions(view, state)
      var key = state + '|' + (view.job && view.job.error || '') + '|' + logPath + '|' + (view.actual || '')
      if (panel.actionKey !== key) {
        panel.actionKey = key
        panel.actions.textContent = ''
        for (var a = 0; a < actions.length; a++) panel.actions.appendChild(rsAction(actions[a][0], actions[a][1], actions[a][2]))
      }
    }
    function stopRestartFlow() {
      var flow = restartFlow
      if (!flow) return
      restartFlow = null
      clearTimeout(flow.timer)
      clearTimeout(flow.deadline)
      if (flow.ticker) clearInterval(flow.ticker)
      flow.controller.abort()
      notifyRestart()
    }
    /**
     * Run a reload ('reload': hot first, the Host escalates when it must) or a
     * full restart ('restart'), then reload the page once the Host is ready.
     * A run is never resubmitted automatically; an unknown outcome stops checking.
     */
    function runRestart(mode, caps) {
      if (restartFlow) return
      var isUpdate = mode === 'update'
      var started = Date.now()
      var version = isUpdate && caps && caps.update ? caps.update.latest : null
      var flow = {
        controller: new AbortController(), timer: null, deadline: null, ticker: null,
        jobId: null, job: null, lastView: null,
      }
      restartFlow = flow
      if (isUpdate) closeRestartProgress()
      notifyRestart()
      var unit = (caps && caps.unit) || 'dsh-web.service'
      var live = function () { return restartFlow === flow }
      var retry = function () { runRestart(mode, caps) }
      var finish = function (view) {
        if (!live()) return
        stopRestartFlow()
        restartToast(view)
      }
      var finishUpdate = function (view) {
        if (!live()) return
        var snapshot = {
          version: version || '',
          job: view.job || flow.job || null,
          step: view.step || 'updating',
          elapsed: Date.now() - started,
          state: view.state || 'failed',
          actual: view.actual || null,
          expected: version,
          caps: caps,
        }
        stopRestartFlow()
        updateRestartProgress(snapshot)
        if (snapshot.state === 'done') setTimeout(function () { window.location.reload() }, 500)
      }
      var show = function (step) {
        if (isUpdate) {
          var view = { version: version || '', job: flow.job, step: step, elapsed: Date.now() - started, state: 'running', caps: caps }
          flow.lastView = view
          updateRestartProgress(view)
          return
        }
        if (step === 'updating') {
          // An install has its own pace; no "slow" notice and no reload offer mid-install.
          restartToast({ key: 'updating', title: tf('rsUpdating', { 0: version || '' }), detail: t('rsUpdatingHint') })
          return
        }
        var slow = Date.now() - started >= RS_SLOW_AFTER_MS
        var title = t({ reloading: 'rsReloading', stopping: 'rsStopping', waiting: 'rsWaiting', booting: 'rsBooting' }[step] || 'rsReloading')
        restartToast({ key: step + (slow ? ':slow' : ''), title: title, detail: slow ? t('rsSlow') : '',
          actions: slow ? [[t('rsReloadNow'), 'primary', function () { window.location.reload() }]] : [] })
      }
      var poll = function (pid) {
        if (!live()) return
        apiRestartStatus(flow.controller.signal).then(function (probe) { return probe }, function () { return null }).then(function (probe) {
          if (!live()) return
          var next = restartStep(probe, pid, isUpdate ? version : null, flow.jobId)
          if (next.job) flow.job = next.job
          if (isUpdate && next.step === 'waiting') {
            // The Host is down, so the job file is not readable from here. Keep
            // the last known step; pretending the start began would be a lie.
            flow.timer = setTimeout(function () { poll(pid) }, restartPollDelay(Date.now() - started))
            return
          }
          if (next.step === 'done') {
            if (isUpdate) { finishUpdate({ state: 'done', step: 'done', job: flow.job }); return }
            finish({ key: 'done', title: t('rsDone') })
            window.location.reload()
            return
          }
          if (isUpdate && (next.step === 'rolled-back' || next.step === 'stale-version')) {
            finishUpdate({ state: next.step === 'rolled-back' ? 'rolled-back' : 'stale', step: next.step, job: flow.job, actual: next.actual || null })
            return
          }
          if (next.step === 'refused') {
            if (isUpdate) { finishUpdate({ state: 'refused', step: 'refused', job: flow.job }); return }
            finish({ key: 'refused', title: t('rsFailTitle'), detail: t('rsFailRequest'), actions: [[t('rsDismiss'), '', closeRestartToast]] })
            return
          }
          if (next.step === 'failed') {
            if (isUpdate) {
              // A start that failed before writing a job still has the Host's
              // fixed code; label the failed step with it instead of "unknown".
              var failedJob = flow.job || { error: String(next.reason || '').replace(/^update-/, '') }
              finishUpdate({ state: 'failed', step: 'failed', job: failedJob })
              return
            }
            finish({ key: 'failed', title: t('rsFailTitle'), detail: tf(String(next.reason || '').indexOf('update-') === 0 ? 'rsFailUpdate' : 'rsFailSystemctl', { 0: unit }),
              actions: [[t('rsDismiss'), '', closeRestartToast], [t('rsRetry'), 'primary', retry]] })
            return
          }
          if (next.step === 'confirm') {
            if (isUpdate) { finishUpdate({ state: 'failed', step: 'updating', job: flow.job }); return }
            // The Host stopped short of interrupting work it may not own; the user decides.
            finish({ key: 'confirm', title: t('rsConfirmNeededTitle'),
              detail: next.active ? tf('rsConfirmNeededActive', { 0: next.reason || '?', 1: next.active }) : tf('rsConfirmNeeded', { 0: next.reason || '?' }),
              actions: [[t('rsLater'), '', closeRestartToast], [t('rsRestartNow'), 'danger', function () { runRestart('restart', caps) }]] })
            return
          }
          if (next.step === 'manual') {
            if (isUpdate) { finishUpdate({ state: 'failed', step: 'updating', job: flow.job }); return }
            finish({ key: 'manual', title: t('rsManualTitle'), detail: tf('rsManual', { 0: next.reason || '?' }), actions: [[t('rsDismiss'), '', closeRestartToast]] })
            return
          }
          show(next.step)
          flow.timer = setTimeout(function () { poll(pid) }, restartPollDelay(Date.now() - started))
        })
      }
      show(isUpdate || mode === 'restart' ? 'stopping' : 'reloading')
      if (isUpdate) {
        flow.ticker = setInterval(function () {
          if (!live() || !flow.lastView) return
          var view = Object.assign({}, flow.lastView, { elapsed: Date.now() - started })
          flow.lastView = view
          updateRestartProgress(view)
        }, 1000)
      }
      // Independent of any request: a hung fetch must not keep the run open forever.
      flow.deadline = setTimeout(function () {
        if (isUpdate) {
          finishUpdate({ state: 'unknown', step: (flow.lastView && flow.lastView.step) || 'updating', job: flow.job })
          return
        }
        finish({ key: 'unknown', title: t('rsUnknownTitle'), detail: t('rsUnknown'),
          actions: [[t('rsDismiss'), '', closeRestartToast], [t('rsReloadNow'), 'primary', function () { window.location.reload() }]] })
      }, isUpdate ? RS_UPDATE_DEADLINE_MS : RS_DEADLINE_MS)
      // The baseline pid tells a new process from the old one still answering.
      apiRestartStatus(flow.controller.signal).then(function (probe) {
        var pid = probe && probe.body && probe.body.data && probe.body.data.pid
        if (!pid) throw new Error('status')
        return fetch(RESTART_API, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(version ? { mode: mode, version: version } : { mode: mode }), signal: flow.controller.signal }).then(function (response) {
          // 409 in-progress: another tab already started one; watch it instead.
          if (response.ok === false && response.status !== 409) throw new Error('post')
          return response.json().catch(function () { return null }).then(function (body) {
            if (body && body.data && typeof body.data.jobId === 'string') flow.jobId = body.data.jobId
            return pid
          })
        })
      }).then(function (pid) {
        if (!live()) return
        poll(pid)
      }, function () {
        if (!live()) return
        if (isUpdate) { finishUpdate({ state: 'refused', step: 'refused' }); return }
        finish({ key: 'refused', title: t('rsFailTitle'), detail: t('rsFailRequest'),
          actions: [[t('rsDismiss'), '', closeRestartToast], [t('rsRetry'), 'primary', retry]] })
      })
    }
    /** Confirm first: Cancel holds the focus so a reflexive Enter never restarts. */
    function openRestartDialog(trigger, caps) {
      if (restartDialog || restartFlow || typeof document === 'undefined' || !document.body) return
      closeRestartProgress()
      // Ask for the running count now, not at mount: it changes by the minute.
      // A failed probe still opens the dialog, with the cautious wording.
      var pending = { cancelled: false, close: function () { pending.cancelled = true } }
      restartDialog = pending
      apiRestartStatus().then(function (probe) {
        var data = probe && probe.body && probe.body.data
        return data && typeof data.active === 'number' ? data.active : null
      }, function () { return null }).then(function (active) {
        if (restartDialog === pending) restartDialog = null
        // Unloaded or closed while asking: open nothing.
        if (!pending.cancelled) showRestartDialog(trigger, caps, active)
      })
    }
    function showRestartDialog(trigger, caps, active) {
      if (restartDialog || restartFlow || typeof document === 'undefined' || !document.body) return
      var dialog = null
      // Capture on window: the Host binds Esc (stop the turn), and it must not see
      // the key that only meant "cancel this dialog".
      var onEscape = function (event) {
        if (event.key !== 'Escape' && event.key !== 'Esc') return
        event.preventDefault()
        event.stopPropagation()
        close(null)
      }
      var close = function (mode) {
        if (!dialog) return
        var node = dialog
        dialog = null
        restartDialog = null
        window.removeEventListener('keydown', onEscape, true)
        if (node.open) node.close()
        if (node.parentNode) node.parentNode.removeChild(node)
        if (trigger && typeof trigger.focus === 'function' && trigger.isConnected !== false) trigger.focus()
        if (mode) runRestart(mode, caps)
      }
      var cancel = rsAction(t('rsCancel'), '', function () { close(null) })
      var buttons = [cancel]
      if (caps.full) buttons.push(rsAction(t('rsRestart'), 'danger', function () { close('restart') }))
      if (caps.update) buttons.push(rsAction(t('rsUpdate'), 'update', function () { close('update') }))
      buttons.push(rsAction(t('rsReload'), 'primary', function () { close('reload') }))
      dialog = rsEl('dialog', { 'class': 'slp-rs-dialog', role: 'alertdialog', 'aria-labelledby': 'slp-rs-title', 'aria-describedby': 'slp-rs-desc', 'data-plugin': 'dsh-statusline-plus' }, [
        rsEl('h2', { id: 'slp-rs-title', text: t('rsConfirmTitle') }),
        rsEl('p', { id: 'slp-rs-desc', text: t(caps.full ? 'rsConfirmBody' : 'rsConfirmBodySoft') }),
        caps.update ? rsEl('p', { 'class': 'slp-rs-update', text: tf('rsUpdateInfo', { 0: caps.update.latest, 1: caps.update.installed }) }) : null,
        caps.full && active !== 0 ? rsEl('p', { 'class': 'slp-rs-warn', role: 'note',
          text: active === null ? t('rsActiveUnknown') : tf('rsActive', { 0: active }) }) : null,
        rsEl('div', { 'class': 'slp-rs-actions' }, buttons)])
      // Esc fires `cancel`; a press both starting and ending on the backdrop cancels.
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(null) })
      var downOnBackdrop = false
      dialog.addEventListener('mousedown', function (event) { downOnBackdrop = event.target === dialog })
      dialog.addEventListener('click', function (event) { if (downOnBackdrop && event.target === dialog) close(null); downOnBackdrop = false })
      restartDialog = { close: function () { close(null) } }
      document.body.appendChild(dialog)
      if (typeof dialog.showModal === 'function') dialog.showModal()
      cancel.focus()
      window.addEventListener('keydown', onEscape, true)
    }
    function disposeRestart() {
      stopRestartFlow()
      closeRestartProgress()
      if (restartDialog) restartDialog.close()
      closeRestartToast()
    }
    /** Reload/restart capability of the Host, asked once per mount; null until known or when unavailable. */
    function useRestartCaps(enabled) {
      var pair = React.useState(null)
      React.useEffect(function () {
        if (!enabled) return undefined
        var controller = new AbortController()
        apiRestartStatus(controller.signal, true).then(function (probe) {
          var data = probe && probe.body && probe.body.ok === true && probe.body.data
          var update = data && data.full && data.update && data.update.available === true && data.update.latest && data.update.helper === true
            ? { latest: String(data.update.latest), installed: String(data.update.installed || '?') } : null
          if (data && !data.disabled && (data.soft || data.full)) pair[1]({ soft: !!data.soft, full: !!data.full, unit: data.unit || null, update: update })
        }, function () { /* an older Host or a failed probe: no button */ })
        return function () { controller.abort() }
      }, [enabled])
      return pair[0]
    }
    function useRestartBusy() {
      var pair = React.useState(0)
      React.useEffect(function () {
        var listener = function () { pair[1](function (n) { return n + 1 }) }
        restartListeners.push(listener)
        return function () { restartListeners = restartListeners.filter(function (item) { return item !== listener }) }
      }, [])
      return restartFlow !== null
    }
    function RestartFooterButton() {
      useLocaleRevision()
      var config = useConfigSnapshot()
      var enabled = !!(config && config.enabled !== false && config.showRestartButton !== false)
      var caps = useRestartCaps(enabled)
      var busy = useRestartBusy()
      if (!enabled || !caps) return null
      var label = caps.update ? tf('rsUpdateTitle', { 0: caps.update.latest }) : t('rsTitle')
      return React.createElement('button', {
        type: 'button', className: 'dsh-sidebar-footer-action slp-rs-btn', title: label, 'aria-label': label,
        'data-update': caps.update && !busy ? 'true' : undefined,
        'aria-haspopup': 'dialog', 'aria-busy': busy ? 'true' : undefined,
        onClick: function (event) { if (!busy) openRestartDialog(event.currentTarget, caps) },
      }, React.createElement('svg', { className: 'slp-rs-power', viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
        React.createElement('path', { d: 'M12 2v8' }), React.createElement('path', { d: 'M6.3 6.3a8 8 0 1 0 11.4 0' })),
      caps.update && !busy ? React.createElement('span', { className: 'slp-rs-update-badge', 'data-update-badge': 'true', 'aria-hidden': true },
        React.createElement('svg', { viewBox: '0 0 12 12', width: 10, height: 10, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('path', { d: 'M6 10V2M2.6 5.4 6 2l3.4 3.4' }))) : null)
    }
    // A subscription with a reader of its own has a localized name and messages; any
    // other takes its name from the source or its Magpie row.
    var QUOTA_ERROR_SUFFIX = { auth: 'FailAuth', 'rate-limit': 'FailRate', network: 'FailNetwork', 'no-credential': 'FailNoCred' }
    function quotaErrorText(kind, error, provider) {
      if (kind === 'opencode') return t('quotaFail') + ': ' + error
      if (SUBSCRIPTIONS[kind] && SUBSCRIPTIONS[kind].short) return t(kind + (QUOTA_ERROR_SUFFIX[error] || 'Fail'))
      if (error === 'no-credential' && provider && provider.noApiKey) return t('subscriptionNotFound')
      if (error === 'signed-out') return t('providerFailSignedOut')
      if (error === 'no-account') return t('providerFailNoAccount')
      return t('provider' + (QUOTA_ERROR_SUFFIX[error] || 'Fail'))
    }
    function validWindows(target) {
      return (target && Array.isArray(target.windows) ? target.windows : []).filter(function (win) { return win && quotaNumber(win.usedPercent) !== null })
    }
    function windowLongLabel(win, windows, fallback) {
      if (win.label) return win.label
      // Only beside the Gemini group does the other group need its qualifier.
      if (win.group === 'third' && windows.some(function (other) { return other.group === 'gemini' })) return t(win.minutes === 300 ? 'antigravityThirdParty' : 'antigravityThirdPartyWeekly')
      return win.minutes ? minutesLabel(win.minutes, true) : fallback
    }
    // The chip shows the leading group's windows; the panel lists all of them.
    function chipWindowsOf(data, windows) {
      var group = windows.length ? windows[0].group : undefined
      var list = group ? windows.filter(function (win) { return win.group === group }) : windows
      return data.chipWindows ? list.slice(0, data.chipWindows) : list
    }
    function windowBars(target, fetchedAt, props, fallback) {
      var windows = validWindows(target)
      return windows.map(function (win, index) {
        return panelBar(win.id || index, windowLongLabel(win, windows, fallback), quotaMetric(win.usedPercent, win.remainingPercent, percentMode(props)), liveReset(win.resetInSec, fetchedAt, props.now))
      })
    }
    function accountRows(data, props, fallback) {
      return data.accounts.map(function (acct, idx) {
        var isCurrent = acct.fileName === data.selectedFileName && acct.status === 'available'
        var statusKey = acct.error ? 'antigravityStatusError' : acct.status === 'exhausted' ? 'antigravityStatusExhausted' : isCurrent ? 'antigravityStatusActive' : acct.status === 'available' ? 'antigravityStatusStandby' : 'antigravityStatusUnknown'
        var statusClass = isCurrent ? ' slp-acct-current' : acct.error || acct.status === 'exhausted' ? ' slp-err' : ''
        var head = [acct.email || acct.accountLabel || acct.fileName, '#' + (idx + 1)]
        if (acct.priority !== undefined && acct.priority !== null) head.push(tf('antigravityPriority', { n: acct.priority }))
        return React.createElement('div', { key: acct.fileName || acct.email, className: 'slp-acct' },
          React.createElement('div', { className: 'slp-acct-head' },
            React.createElement('span', null, head.filter(Boolean).join(' · ')),
            React.createElement('span', { className: 'slp-acct-state' + statusClass }, t(statusKey))),
          acct.error ? React.createElement('p', { key: 'err', className: 'slp-panel-note slp-err' }, t('antigravityFetchFail') + acct.error)
            : windowBars(acct, acct.fetchedAt || data.fetchedAt, props, fallback))
      })
    }
    function quotaNotes(data) {
      var notes = []
      if (data.plan) notes.push(tf('quotaPlan', { plan: data.plan }))
      if (data.activeLimit && String(data.activeLimit) !== 'none') notes.push(t('codexActiveLimit') + ': ' + data.activeLimit)
      if (data.credits && data.credits.unlimited) notes.push(t('codexCreditsUnlimited'))
      else if (data.credits && typeof data.credits.balance === 'number') notes.push(t('codexCredits') + ': $' + data.credits.balance)
      if (data.accountCount > 1 && !(Array.isArray(data.accounts) && data.accounts.length > 1)) notes.push(tf('magpieAccounts', { n: data.accountCount }))
      return notes
    }
    function windowsView(data, short, props) {
      var windows = validWindows(data)
      var titles = [], segs = chipWindowsOf(data, windows).map(function (win, index) {
        var metric = quotaMetric(win.usedPercent, win.remainingPercent, percentMode(props))
        var reset = liveReset(win.resetInSec, data.fetchedAt, props.now)
        var long = windowLongLabel(win, windows, short)
        var title = tf('providerWindowTitle', { label: long, v: metric.word })
        titles.push(title)
        if (reset > 0) title += ' · ' + tf('providerResetTitle', { r: fmtResetHours(reset) })
        return chipSegment(win.id || index, win.short || win.label || (win.minutes ? minutesLabel(win.minutes) : ''), metric, reset, title, props.holdTitle)
      })
      var manyAccounts = Array.isArray(data.accounts) && data.accounts.length > 1
      var rows = manyAccounts ? accountRows(data, props, short) : windowBars(data, data.fetchedAt, props, short)
      var notes = quotaNotes(data)
      if (data.geminiHidden) notes.push(t('antigravityGeminiHidden'))
      rows = rows.concat(notes.map(function (note, index) { return React.createElement('p', { key: 'note' + index, className: 'slp-panel-note' }, note) }))
      if (data.email) titles.unshift((data.priority !== undefined ? tf('antigravityPriority', { n: data.priority }) + ': ' : '') + data.email)
      return { segs: segs, rows: rows, titles: titles.concat(notes), manyAccounts: manyAccounts }
    }
    function balanceView(data, short) {
      var segs = [], rows = [], titles = []
      var allBalances = Array.isArray(data.balances) && data.balances.length ? data.balances : [data]
      // Platform reports an empty wallet for the unused currency. Hide zero
      // wallets when another currency is funded, but keep them when every
      // wallet is zero so a real empty balance still reads as ¥0.00.
      var fundedBalances = allBalances.filter(function (balance) {
        var remaining = quotaNumber(balance && balance.remaining)
        return remaining === null || remaining !== 0
      })
      var balances = fundedBalances.length ? fundedBalances : allBalances
      var redBelow = quotaNumber(data.redBelow)
      balances.forEach(function (balance, key) {
        if (!balance) return
        var remaining = quotaNumber(balance.remaining)
        var used = quotaNumber(balance.used)
        var currency = balance.currency || data.currency
        var granted = quotaNumber(balance.granted)
        var toppedUp = quotaNumber(balance.toppedUp)
        var showGift = granted !== null && granted > 0
        var isRed = data.isAvailable === false || (redBelow !== null && remaining !== null && remaining < redBelow)
        var text = remaining !== null ? fmtMoney(remaining, currency) : (used !== null ? tf('providerUsedShort', { u: fmtMoney(used, currency) }) : '—')
        var titleText = tf('providerBalanceTitle', { label: short + (currency ? ' (' + currency + ')' : ''), r: fmtMoney(remaining, currency) })
        if (used !== null) titleText += ' · ' + tf('providerUsedShort', { u: fmtMoney(used, currency) })
        if (toppedUp !== null) titleText += ' · ' + tf('providerToppedUp', { v: fmtMoney(toppedUp, currency) })
        if (showGift) titleText += ' · ' + tf('providerGranted', { v: fmtAmount(granted) })
        if (redBelow !== null) titleText += ' · ' + tf('providerRedBelowTitle', { v: fmtMoney(redBelow, currency) })
        titles.push(titleText)
        // The big number is the usable total; recharge and granted balances
        // stay on separate lines so a gift never looks like paid balance.
        // A zero gift has nothing to add, so it is omitted.
        var parts = []
        if (used !== null) parts.push(tf('providerUsedShort', { u: fmtMoney(used, currency) }))
        if (toppedUp !== null) parts.push(tf('providerToppedUp', { v: fmtMoney(toppedUp, currency) }))
        if (showGift) parts.push(tf('providerGranted', { v: fmtAmount(granted) }))
        rows.push(React.createElement('div', { key: key, className: 'slp-balance' },
          React.createElement('span', { className: 'slp-balance-amount' + (isRed ? ' slp-err' : '') }, text),
          currency ? React.createElement('span', { className: 'slp-balance-meta' }, currency + (remaining !== null ? ' · ' + t('providerTotal') : '')) : null,
          parts.map(function (part, index) {
            return React.createElement('p', { key: 'part' + index, className: 'slp-panel-note' }, part)
          })))
        // Keep the header compact: paid balance plus gift balance, e.g.
        // ¥51.43+3.23. The total stays in the title and the details panel.
        // Without a known paid/gift split, show the usable total unchanged.
        var chipText = toppedUp !== null && showGift
          ? fmtMoney(toppedUp, currency) + '+' + fmtAmount(granted)
          : text
        segs.push(React.createElement('span', { key: key, className: 'slp-seg' },
          React.createElement('span', {
            className: 'slp-seg-label',
            style: { color: isRed ? 'var(--dsw-alias-state-error-primary)' : undefined, fontWeight: isRed ? 600 : undefined },
          }, chipText)
        ))
      })
      if (redBelow !== null) rows.push(React.createElement('p', { key: 'red', className: 'slp-panel-note' }, tf('providerRedBelowTitle', { v: fmtMoney(redBelow, data.currency || balances[0] && balances[0].currency) })))
      if (typeof data.isAvailable === 'boolean') {
        titles.push(t(data.isAvailable ? 'providerAvailable' : 'providerUnavailable'))
        rows.push(React.createElement('p', { key: 'availability', className: 'slp-panel-note' }, t(data.isAvailable ? 'providerAvailable' : 'providerUnavailable')))
      }
      return { segs: segs, rows: rows, titles: titles }
    }
    // A gateway subscription can carry a long display name. Nine code points is
    // enough to identify it in the header; the details heading keeps the full
    // name. The clipped class fades the last few pixels instead of a hard cut.
    var QUOTA_NAME_MAX = 9
    function clipQuotaName(text) {
      var chars = Array.from(String(text === undefined || text === null ? '' : text))
      if (chars.length <= QUOTA_NAME_MAX) return { text: chars.join(''), clipped: false }
      return { text: chars.slice(0, QUOTA_NAME_MAX).join('').trimEnd(), clipped: true }
    }

    // Every quota chip: a wallet balance, or subscription windows in the shape
    // lib/quota-window.js describes. Click opens details; Refresh forces a query.
    function QuotaLine(props) {
      var dismiss = useQuotaPanel(props.onPanelOpen)
      var kind = SUBSCRIPTIONS[props.kind], provider = props.provider, data = props.data
      if (kind && !kind.short) kind = null
      // A generic Magpie row can still name a subscription this plugin knows
      // (`agy-cli` is Antigravity). Use its local name for the chip and panel;
      // unrelated ids keep Magpie's own label.
      var alias = !kind ? SUBSCRIPTIONS[subscriptionKindOf((data && data.id) || (provider && provider.id))] : null
      var short = kind ? t(kind.short) : alias && alias.short ? t(alias.short) : (data && data.label) || (provider && provider.label) || (provider && provider.id) || 'provider'
      // Unknown gateway subscription names can be arbitrarily long. Keep the
      // chip compact; a balance name and the details heading stay complete.
      var shown = !kind && !alias && data && data.style !== 'balance' ? clipQuotaName(short) : { text: short, clipped: false }
      if (props.error) return quotaPlaceholder(short, quotaErrorText(props.kind, props.error, provider), props.refresh, props, dismiss.titleProps)
      if (!data) return quotaPlaceholder(short, t('quotaLoading'))
      var balance = data.style === 'balance'
      var view = balance ? balanceView(data, short) : windowsView(data, short, Object.assign({}, props, { holdTitle: dismiss.titleProps }))
      if (!view.segs.length && kind && kind.unknown) return quotaPlaceholder(short, t(kind.unknown), props.refresh)
      var label = shown.text
      if (view.manyAccounts && data.priority !== undefined) {
        label += ' #' + (data.accounts.findIndex(function (account) { return account.fileName === data.selectedFileName }) + 1)
      }
      var heading = kind ? t(kind.title) : alias && alias.title ? t(alias.title) : short + ' · ' + t(balance ? 'setBalanceSource' : 'setSubscriptionSource')
      if (data.email && !view.manyAccounts) heading += ' (' + data.email + ')'
      return quotaShell(dismiss, props, label, view.titles.join(' · '), view.segs.length ? view.segs : React.createElement('span', { key: 'unknown' }, '—'),
        quotaPanel(heading, view.rows, props, data.fetchedAt, !balance), shown.clipped ? 'slp-quota-name-clipped' : '')
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

    var GIT_ERROR_TEXT = { 'git-not-found': 'gitErrNotFound', 'git-unsafe-repo': 'gitErrUnsafe', 'git-too-many-files': 'gitErrTooMany',
      'git-timeout': 'gitErrTimeout', 'git-invalid-cwd': 'gitErrInvalidCwd', 'git-failed': 'gitErrFailed', network: 'gitErrNetwork' }
    // One slow answer is common on a busy disk or a network mount, so these need a
    // second failure before the chip reports them.
    var GIT_TRANSIENT_ERRORS = ['git-timeout', 'network']
    var GIT_TRANSIENT_RETRY_MS = 16000 // Just past the Host's 15 s error cache.
    function gitErrorText(error) {
      return Object.prototype.hasOwnProperty.call(GIT_ERROR_TEXT, error) ? t(GIT_ERROR_TEXT[error]) : null
    }
    function gitErrorVisible(error, failures) {
      return gitErrorText(error) !== null && (GIT_TRANSIENT_ERRORS.indexOf(error) === -1 || failures >= 2)
    }
    // git 状态行：非仓库或取不到路径时不展示；是仓库却读不了时显示 ⎇ ? 并可重试
    function GitLine(props) {
      var data = props.data
      var path = props.path ? React.createElement('span', { key: 'p', className: 'slp-git-path', title: props.fullPath || props.path }, props.path) : null
      if ((!data || !data.isRepo) && props.errorVisible) {
        return React.createElement('span', { className: 'slp-group slp-git' },
          React.createElement('button', { type: 'button', className: 'slp-git-trigger', title: gitErrorText(props.error) + ' · ' + t('gitRetry'),
            style: { opacity: props.busy && props.manual ? 0.6 : 1 }, onClick: function () { props.refresh() } },
            path, React.createElement('span', { key: 'br', className: 'slp-git-branch slp-muted' }, '⎇ ?')))
      }
      if (!data || !data.isRepo) return null
      var children = []
      // 智能截断的仓库路径（showCwd 开启时显示；完整路径放 title）
      if (path) children.push(path)
      var branch = data.branch || t('gitBranchNone')
      if (data.ahead > 0) branch += ' ↑' + data.ahead
      if (data.behind > 0) branch += ' ↓' + data.behind
      children.push(React.createElement('span', { key: 'br', className: 'slp-git-branch', title: branch }, '⎇ ' + branch))
      var c = data.counts
      if (c.staged > 0) children.push(React.createElement('span', { key: 's', className: 'slp-git-staged' }, t('gitStaged') + ' ' + c.staged))
      if (c.unstaged > 0) children.push(React.createElement('span', { key: 'u', className: 'slp-git-unstaged' }, t('gitUnstaged') + ' ' + c.unstaged))
      if (data.untrackedUnknown) children.push(React.createElement('span', { key: 'ut', title: t('gitUntrackedUnknown') }, '??'))
      else if (c.untracked > 0) children.push(React.createElement('span', { key: 'ut', title: t('gitUntracked') }, '?' + c.untracked))
      if (c.conflict > 0) children.push(React.createElement('span', { key: 'c', className: 'slp-git-conflict' }, t('gitConflict') + ' ' + c.conflict))
      var lineStats = data.lineStats || {}
      if (Number(lineStats.added) > 0) children.push(React.createElement('span', { key: 'la', className: 'slp-git-added', title: t('gitDiffTitle') + ' · +' + lineStats.added }, '+' + compactCount(lineStats.added)))
      if (Number(lineStats.deleted) > 0) children.push(React.createElement('span', { key: 'ld', className: 'slp-git-deleted', title: t('gitDiffTitle') + ' · -' + lineStats.deleted }, '-' + compactCount(lineStats.deleted)))
      if (data.lineStatsError) children.push(React.createElement('span', { key: 'unknown', title: t('gitLinesUnknown') }, '+/− ?'))
      if (props.stale) children.push(React.createElement('span', { key: 'stale', className: 'slp-err', title: t('gitStale') + (gitErrorText(props.error) ? ' · ' + gitErrorText(props.error) : '') }, '!'))
      var titleExtra = c.untracked > 0 ? ' · ' + t('gitUntracked') + ' ' + c.untracked : ''
      return React.createElement('span', { className: 'slp-group slp-git' },
        React.createElement('button', {
          type: 'button',
          className: 'slp-git-trigger',
          title: t('gitTitle') + titleExtra,
          style: { opacity: props.busy && props.manual ? 0.6 : 1 },
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
    function childRunning(child, state, statuses, ids, records) {
      var status = statuses && typeof statuses.get === 'function' && statuses.get(child.id)
      if (status && typeof status.running === 'boolean') return status.running
      var summary = state && state.byId && state.byId[child.id]
      if (summary && ids && ids.has(child.id) && typeof summary.running === 'boolean') return summary.running
      // External children have no child Session at all, so the parent's own
      // settlement record is the only durable source: no settlement yet means
      // the activation is still live.
      var record = records && typeof records.get === 'function' ? records.get(child.id) : null
      return record && typeof record.settledAt === 'number' ? false : record ? true : null
    }
    // One character per child, with no model/timing reads or JSON allocation.
    function childRunningKey(catalog, state, statuses, records) {
      var ids = childIds(state), key = ''
      for (var child of catalog) {
        var running = childRunning(child, state, statuses, ids, records)
        key += running === true ? '1' : running === false ? '0' : '?'
      }
      return key
    }
    function childActivityRows(catalog, state, statuses, records) {
      var ids = childIds(state)
      return (Array.isArray(catalog) ? catalog : []).map(function (child) {
        var summary = state && state.byId && state.byId[child.id]
        // byId also contains synthetic catalog rows whose default false is
        // not a Host observation. Only ids members carry a real baseline.
        var running = childRunning(child, state, statuses, ids, records)
        var projection = state && state.projectionsBySession && state.projectionsBySession[child.id]
        var values = Object.assign({}, summary && summary.projectionValues, projection && projection.values)
        var usedModel = values.modelSelection && values.modelSelection.lastUsed
        var identity = values.subagent
        var record = records && typeof records.get === 'function' ? records.get(child.id) : null
        return { id: child.id, label: child.label || child.id, running: typeof running === 'boolean' ? running : null,
          mode: child.mode === 'one-shot' || child.mode === 'continuable' || child.mode === 'external' ? child.mode : identity && identity.mode || 'unknown',
          model: usedModel && typeof usedModel.model === 'string' ? usedModel.model : null,
          effort: usedModel && typeof usedModel.reasoningEffort === 'string' && usedModel.reasoningEffort ? usedModel.reasoningEffort : null,
          timing: values.subagentTiming || null, createdAt: child.createdAt || 0,
          recordedAt: record && typeof record.createdAt === 'number' ? record.createdAt : null,
          settledAt: record && typeof record.settledAt === 'number' ? record.settledAt : null }
      })
    }
    function childElapsed(row, now) {
      var timing = row.timing
      if (timing && typeof timing.settledMs === 'number' && Number.isFinite(timing.settledMs) && timing.settledMs >= 0) {
        var elapsed = timing.settledMs, active = timing.active
        if (active) {
          var end = row.running === true ? now : active.through
          if (!Number.isFinite(end) || !Number.isFinite(active.since)) return null
          elapsed += Math.max(0, end - active.since)
        }
        return Math.floor(elapsed / 1000)
      }
      // No child-session timing: fall back to the parent's catalog and
      // settlement record, which is all an external child ever has.
      if (typeof row.recordedAt !== 'number' || !Number.isFinite(row.recordedAt)) return null
      var stop = row.running === true ? now : row.settledAt
      if (typeof stop !== 'number' || !Number.isFinite(stop) || stop < row.recordedAt) return null
      return Math.floor((stop - row.recordedAt) / 1000)
    }
    function ActivityRow(props) {
      var catalog = typeof props.useProjection === 'function' ? props.useProjection('subagentCatalog') : null
      var settlement = typeof props.useProjection === 'function' ? props.useProjection('statuslineSubagents') : null
      var list = Array.isArray(catalog) ? catalog : []
      // Direct-child discovery and settlement from the parent's own log. It is
      // the only source for children without a Session (external backends).
      var records = new Map()
      if (settlement && Array.isArray(settlement.children)) {
        for (var record of settlement.children) records.set(record.id, record)
      }
      var dismiss = useDismissiblePanel(), visible = usePageVisible(true)
      // Status counters remain live while collapsed; hidden pages and collapsed
      // details do not walk models, efforts, or timing projections.
      var runningKey = typeof props.useSessions === 'function' ? props.useSessions(function (state) {
        return visible ? childRunningKey(list, state, null, records) : ''
      }) : ''
      var statusKey = typeof props.useSessionStatus === 'function' ? props.useSessionStatus(function (statuses) {
        return visible ? childRunningKey(list, null, statuses, records) : ''
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
            // The fade window belongs to the *stop*, not to this mount. Using the
            // mount time made every session switch, remount or transient "running"
            // flap replay the 5s fade plus 15s removal for children that settled
            // hours ago — the chip appearing out of nowhere and then leaving.
            if (!stops.has(child.id)) {
              var record = records.get(child.id)
              var settledAt = record && typeof record.settledAt === 'number' ? record.settledAt : null
              stops.set(child.id, settledAt === null ? wallNow : Math.min(wallNow, settledAt))
            }
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
      // External children have no Session to refresh; asking for one only
      // creates a failed projection load for an id the Host cannot resolve.
      var idsKey = JSON.stringify(shown.filter(function (row) { return row.mode !== 'external' }).map(function (row) { return row.id }))
      var detailsKey = typeof props.useSessions === 'function' ? props.useSessions(function (state) {
        return visible && dismiss.open ? JSON.stringify(childActivityRows(shown, state, null, records)) : ''
      }) : visible && dismiss.open ? JSON.stringify(childActivityRows(shown, null, null, records)) : ''
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
        React.createElement('button', { type: 'button', className: 'slp-activity-trigger', style: { opacity: rows.every(function (row) { return row.faded }) ? 0.6 : 1, transition: "opacity var(--slp-ui) var(--slp-ease)" }, 'data-peek': tf('activitySummaryTitle', { active: active, stopped: stopped, unknown: unknown }), 'aria-label': tf('activitySummaryTitle', { active: active, stopped: stopped, unknown: unknown }), 'aria-expanded': dismiss.open,
          onClick: dismiss.toggle }, label),
        dismiss.open ? React.createElement('div', { className: 'slp-panel slp-activity-panel slp-subagent-panel', role: 'region', 'aria-label': t('activityTitle') },
          React.createElement('strong', null, 'Subagents'),
          React.createElement('p', { className: 'slp-subagent-summary' }, [active ? tf('activityRunning', { n: active }) : null,
            stopped ? tf('activityDone', { n: stopped }) : null, unknown ? tf('activityUnknown', { n: unknown }) : null].filter(Boolean).join(' · ')),
          shown.map(function (row) {
            var seconds = childElapsed(row, now)
            return React.createElement('div', { key: row.id, className: 'slp-activity-item', style: { opacity: row.faded ? 0.6 : 1, transition: "opacity var(--slp-ui) var(--slp-ease)" } },
              React.createElement('span', { className: 'slp-subagent-title', title: row.label }, row.label),
              row.model || row.effort ? React.createElement('div', { className: 'slp-subagent-model-row' },
                React.createElement('span', { className: 'slp-subagent-model', title: t('activityLastModel') + ': ' + (row.model || '—') }, row.model || '—'),
                row.effort ? React.createElement('span', { className: 'slp-subagent-effort', title: t('activityEffort') + ': ' + row.effort }, row.effort) : null) : null,
              React.createElement('div', { className: 'slp-subagent-state-row' },
                React.createElement('span', null,
                  React.createElement('span', { className: 'slp-subagent-status', 'data-running': row.running }, t(row.running === true ? 'activityRunningState' : row.running === false ? 'activityStoppedState' : 'activityUnknownState')),
                  ' · ' + t(row.mode === 'one-shot' ? 'activityOneShot' : row.mode === 'continuable' ? 'activityContinuable' : row.mode === 'external' ? 'activityExternal' : 'activityModeUnknown')),
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
        var status = sessionStatusOf(statuses, props.sessionId)
        return status && typeof status.running === 'boolean' ? status.running : null
      }) : null
      var dismiss = useDismissiblePanel(), visible = usePageVisible(true)
      var rows = data && Array.isArray(data.tools) ? data.tools : []
      var pending = running === true ? rows.filter(function (row) { return row.status === 'running' }) : []
      var now = usePeakClock(!props.preview && visible && dismiss.open && pending.length > 0)
      // Show while a tool runs, while a running session has not reported a count
      // yet, or while the panel is open; otherwise there is nothing to say.
      var show = pending.length > 0 || (running === true && data.activeCount === null) || dismiss.open
      if (!visible || !data || !show) return null
      if (!pending.length && !rows.length) return null
      var names = pending.slice(0, 2).map(function (row) { return row.name || '—' }).join(' · ')
      var extra = running !== true ? 0 : typeof data.activeCount === 'number' ? Math.max(0, data.activeCount - 2) : null
      var count = running === false ? 0 : running !== true || typeof data.activeCount !== 'number' ? null : data.activeCount
      var label = t('toolsLabel') + ' ' + (count === null ? '?' : count)
      var title = t('toolsTitle') + (names ? ': ' + names + (extra ? ' +' + extra : extra === null ? ' +?' : '') : '') + '\n' + t('toolsTimingHint')
      var shown = pending.concat(rows.filter(function (row) { return pending.indexOf(row) === -1 }).slice().reverse()).slice(0, 12)
      var statusLabels = { running: 'toolsRunning', completed: 'toolsCompleted', failed: 'toolsFailed', cancelled: 'toolsCancelled', 'not-started': 'toolsNotStarted', unknown: 'toolsUnknown', stopped: 'toolsStopped' }
      return React.createElement('span', { className: 'slp-group slp-tools', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { type: 'button', className: 'slp-activity-trigger', 'data-peek': title, 'aria-label': label, 'aria-expanded': dismiss.open,
          onClick: dismiss.toggle }, label),
        dismiss.open ? React.createElement('div', { className: 'slp-panel slp-activity-panel', role: 'region', 'aria-label': t('toolsTitle') },
          React.createElement('strong', null, t('toolsTitle')),
          React.createElement('div', { className: 'slp-panel-scroll' }, shown.map(function (row) {
            var actual = running === true || row.status !== 'running' ? row : Object.assign({}, row, { status: running === false ? 'stopped' : 'unknown' })
            var seconds = toolElapsed(actual, props.preview ? row.startedAt + 12000 : now)
            return React.createElement('div', { key: row.callId, className: 'slp-activity-item' },
              React.createElement('span', { className: 'slp-tool-name', title: row.name || '' }, row.name || '—'),
              React.createElement('span', { className: actual.status === 'failed' ? 'slp-err' : '' }, t(statusLabels[actual.status] || 'toolsUnknown')),
              React.createElement('span', null, seconds === null ? '—' : peakCountdown(seconds)))
          })),
          data.truncated ? React.createElement('p', null, t('toolsIncomplete')) : null,
          rows.length > shown.length ? React.createElement('p', null, '+' + (rows.length - shown.length)) : null) : null)
    }
    function estimateMoney(value, symbol) {
      symbol = symbol || '¥'
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      return symbol + value.toFixed(2)
    }
    // Each request has one tariff, so a bucket carries one amount per currency.
    var COST_CURRENCIES = [['Cny', '¥'], ['Usd', '$']]
    function costAmounts(bucket) {
      return COST_CURRENCIES.map(function (currency) { return { key: currency[0], symbol: currency[1], amount: bucket['amount' + currency[0]] } })
        .filter(function (item) { return typeof item.amount === 'number' })
    }
    function estimateCost(bucket, compact) {
      if (!bucket || !bucket.pricedMessages) return t('costUnknown')
      var parts = costAmounts(bucket).map(function (item) { return estimateMoney(item.amount, item.symbol) })
      if (!parts.length) return t('costUnknown')
      var text = parts.join(' + ')
      return text + (!compact && bucket.unpricedMessages ? ' (' + t('costPartial') + ')' : '')
    }
    // Average spend per hour across the session's request span; short spans swing too much.
    function costPerHour(data) {
      var span = data && data.activeTo - data.activeFrom
      if (!(span >= 5 * 60000) || !data.session || !data.session.pricedMessages) return null
      var parts = costAmounts(data.session).map(function (item) { return estimateMoney(item.amount / (span / 3600000), item.symbol) })
      return parts.length ? tf('costPerHour', { v: '≈' + parts.join(' + ') }) : null
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
      return COST_CURRENCIES.map(function (currency) {
        var total = bucket['amount' + currency[0]]
        if (typeof total !== 'number') return null
        var segments = []
        var rows = [['input', 'costInput'], ['cache', 'costCache'], ['output', 'costOutput']].map(function (spec) {
          var part = bucket.breakdown[spec[0]], amount = part && part['amount' + currency[0]]
          if (!part || typeof amount !== 'number') return null
          var cost = estimateMoney(amount, currency[1])
          var tokens = part['tokens' + currency[0]], tokenText = typeof tokens === 'number' ? tokens < 1000 ? (tokens / 1000) + 'K' : formatTokens(tokens) : '—'
          var percent = total > 0 ? amount / total * 100 : 0
          var share = total > 0 ? Math.round(percent * 10) / 10 + '%' : '—'
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
    // Today's total across sessions. It is not part of the projection: the Host
    // reads it from the logs and caches it for a minute, so this only asks again
    // when the panel has been open that long.
    function useTodaySpend() {
      var pair = React.useState(null)
      React.useEffect(function () {
        var alive = true
        // Nothing to ask when the page has no fetch (tests, an embedded host).
        if (typeof fetch !== 'function') return undefined
        var load = function () {
          fetch('/statusline/api/today-spend', { headers: { accept: 'application/json' } })
            .then(function (response) { return response.json() })
            .then(function (body) { if (alive && body && body.ok && body.data && body.data.supported) pair[1](body.data) })
            .catch(function () { /* the per-session figure still stands */ })
        }
        load()
        var timer = setInterval(load, 60000)
        return function () { alive = false; clearInterval(timer) }
      }, [])
      return pair[0]
    }
    // The figure stays one line: the caveats are a tooltip, not a suffix, because a
    // wrapped second line in this panel is the expensive part, not the sentence.
    function todayCostText(today) {
      if (!today) return null
      var parts = []
      if (today.cnyUnits) parts.push(estimateMoney(today.cnyUnits / 100000000, '¥'))
      if (today.usdUnits) parts.push(estimateMoney(today.usdUnits / 100000000, '$'))
      if (!parts.length) return null
      var text = tf('costToday', { amount: parts.join(' + '), n: today.counted })
      // The unpriced count is short enough to belong on the line; it is the one
      // caveat worth reading without hovering.
      return today.unpriced ? text + ' · ' + tf('costTodayUnpriced', { n: today.unpriced }) : text
    }
    function todayCostDetail(today) {
      if (!today) return null
      var parts = []
      if (today.skipped) parts.push(tf('costTodayUnreadDetail', { n: today.skipped }))
      if (today.unpriced) parts.push(tf('costTodayLowerBound'))
      return parts.length ? parts.join(' · ') : null
    }
    function CostRow(props) {
      var data = typeof props.useProjection === 'function' ? props.useProjection('statuslineMetrics') : null
      var dismiss = useDismissiblePanel()
      var today = useTodaySpend()
      if (!data || !data.session || !(data.session.pricedMessages + data.session.unpricedMessages)) return null
      var coverage = tf('costPriced', { n: data.session.pricedMessages }) + (data.session.unpricedMessages ? ' · ' + tf('costUnpriced', { n: data.session.unpricedMessages }) : '')
      var panel = null
      if (dismiss.open) {
        var sources = data.session.sources || {}, official = sources.official, reference = sources.openrouter,
          fallback = sources.fallback, snapshotReference = sources['fallback-reference'],
          cnyFallback = sources['deepseek-fallback'] || !data.session.sources
        var vendors = data.session.vendors || {}, vendorNames = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google',
          zai: 'Z.ai', moonshotai: 'Moonshot', deepseek: 'DeepSeek', xai: 'xAI', mistral: 'Mistral', qwen: 'Qwen', openrouter: 'OpenRouter' }
        var details = [], perHour = costPerHour(data)
        if (official) {
          details.push(tf('costNative', { version: data.catalog && data.catalog.version || '—', time: data.catalog && data.catalog.generatedAt ? new Date(data.catalog.generatedAt).toLocaleString() : '—', n: official }))
        }
        if (reference) {
          details.push(tf('costReference', { n: reference }))
        }
        if (fallback) {
          details.push(tf('costFallback', { time: data.catalog && data.catalog.fallbackAsOf ? new Date(data.catalog.fallbackAsOf).toLocaleString() : '—', n: fallback }))
        }
        if (snapshotReference) {
          details.push(tf('costFallbackReference', { n: snapshotReference }))
        }
        if (cnyFallback) {
          details.push(tf('costAsOf', { time: data.pricingAsOf ? new Date(data.pricingAsOf).toLocaleString() : '—' }))
        }
        var vendorNote = Object.keys(vendors).sort(function (a, b) { return vendors[b] - vendors[a] || a.localeCompare(b) })
          .map(function (key) { return vendorNames[key] || key }).join(' · ')
        panel = React.createElement('div', { className: 'slp-panel slp-cost-panel', role: 'region', 'aria-label': t('costTitle') },
          React.createElement('div', { className: 'slp-cost-head' }, React.createElement('strong', null, t('costTitle')), details.length ? hint(details.join('\n')) : null),
          React.createElement('div', { className: 'slp-cost-amount' }, '≈' + estimateCost(data.session, true)),
          costBreakdownTables(data.session),
          perHour ? React.createElement('p', { className: 'slp-panel-note' }, perHour) : null,
          !data.session.breakdown && data.session.pricedMessages ? React.createElement('p', { className: 'slp-panel-note' }, t('costBreakdownPending')) : null,
          React.createElement('p', { className: 'slp-panel-note' }, coverage + (vendorNote ? tf('costSourceNote', { list: vendorNote }) : '')),
          todayCostText(today) ? React.createElement('p', { className: 'slp-panel-note slp-cost-today', 'data-sessions': String(today.counted),
            'data-complete': today.complete === false ? 'false' : 'true', title: todayCostDetail(today) || undefined }, todayCostText(today)) : null,
          data.session.unpricedMessages ? React.createElement('p', { className: 'slp-panel-note slp-cost-reasons', title: costReasons(data.session) }, costReasons(data.session)) : null)
      }
      return React.createElement('span', { className: 'slp-group slp-cost', ref: dismiss.rootRef, onBlur: dismiss.onBlur },
        React.createElement('button', { className: 'slp-cost-trigger', type: 'button', 'aria-expanded': dismiss.open,
          'data-peek': t('costTitle') + ' · ' + coverage + (data.session.unpricedMessages ? ' · ' + costReasons(data.session) : ''),
          'aria-label': t('costTitle') + ' ' + coverage,
          onClick: dismiss.toggle },
          '≈' + estimateCost(data.session, true)),
        panel)
    }

    function useWrapMarkers(node, enabled) {
      React.useEffect(function () {
        var row = node
        if (!enabled || !row) return undefined
        var root = row.closest('.slp-root')
        var dock = row.closest('[data-composer-dock]')
        var lastKey = null, ignoreMutations = 0
        var hiddenByOfficial = false, hiddenDockWidth = -1
        var breakNode = row.querySelector(':scope > .slp-row-break')
        var groups = function () { return Array.from(row.children).filter(function (child) { return child !== breakNode }) }
        var lineHeight = function () { return parseFloat(getComputedStyle(row).lineHeight) || 20 }
        // The official stats are siblings of the plugin root. A two-line native
        // area leaves no room for this row: hide the plugin rather than letting
        // it add a third line. A one-line native area leaves one plugin line.
        var officialHeight = function () {
          if (!dock || !root) return 0
          var tops = [], hasText = false
          var fallbackTop = Infinity, fallbackBottom = -Infinity
          var addTop = function (top) {
            if (!tops.some(function (seen) { return Math.abs(seen - top) <= 6 })) tops.push(top)
          }
          Array.from(dock.children).forEach(function (child) {
            if (child === root || child.contains(root) || root.contains(child)) return
            if (!child.getClientRects().length || getComputedStyle(child).display === 'none') return
            var childHasText = false
            var walker = document.createTreeWalker(child, 4)
            var text
            while ((text = walker.nextNode())) {
              if (!(text.nodeValue || '').trim()) continue
              var range = document.createRange()
              range.selectNodeContents(text)
              var rects = range.getClientRects()
              for (var i = 0; i < rects.length; i++) {
                if (rects[i].height > 0) { childHasText = true; hasText = true; addTop(rects[i].top) }
              }
            }
            if (!childHasText) {
              // An icon-only group has no text rect. Its box may be stretched to
              // the row height, so count only one line for it.
              var rect = child.getBoundingClientRect()
              if (rect.height > 0) {
                fallbackTop = Math.min(fallbackTop, rect.top)
                fallbackBottom = Math.max(fallbackBottom, rect.top + Math.min(rect.height, lineHeight()))
              }
            }
          })
          if (hasText) return Math.max(1, tops.length)
          if (Number.isFinite(fallbackTop)) return Math.max(1, Math.round((fallbackBottom - fallbackTop) / lineHeight()))
          return 0
        }
        var budget = function () {
          if (!dock || !root) return 2
          if (hiddenByOfficial) {
            // Do not un-hide on the row's own zero-width resize; wait for the
            // composer width to change. This breaks the hide/measure feedback.
            if (dock.clientWidth === hiddenDockWidth) return 0
            hiddenByOfficial = false
            root.removeAttribute('data-official-hidden')
          }
          var official = officialHeight()
          if (official >= 2) {
            hiddenByOfficial = true
            hiddenDockWidth = dock.clientWidth
            root.setAttribute('data-official-hidden', 'true')
            return 0
          }
          root.removeAttribute('data-official-hidden')
          return official === 1 ? 1 : 2
        }
        // Include text length so a changing value can reflow the row. Hiding an
        // item does not change this key, which keeps the ResizeObserver from
        // re-showing it in a loop.
        var key = function () {
          var parts = [row.clientWidth, dock ? dock.clientWidth : 0, hiddenByOfficial ? 'hidden' : 'shown']
          groups().forEach(function (child) { parts.push(child.className + ':' + (child.textContent || '').length) })
          return parts.join('|')
        }
        // A declared minColumns budget hides an item when the row cannot give it
        // that much room. One column is the advance of a digit in the row's own
        // font, measured rather than assumed. The decision reads the dock's width,
        // never the row's: hiding an item must not change the measurement that
        // hid it, or the row would oscillate on every resize.
        var measureCanvas = null
        var charAdvance = function () {
          var style = getComputedStyle(row)
          if (!measureCanvas) measureCanvas = document.createElement('canvas')
          var context = measureCanvas.getContext ? measureCanvas.getContext('2d') : null
          if (!context) return 8
          context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ')
          return context.measureText('0000').width / 4 || 8
        }
        var applyColumnBudget = function () {
          var basis = dock ? dock.clientWidth : row.clientWidth
          if (!basis) return
          var advance = charAdvance()
          groups().forEach(function (child) {
            var need = Number(child.getAttribute('data-min-columns') || 0)
            if (!(need > 0)) return
            if (basis >= need * advance) child.removeAttribute('data-budget')
            else child.setAttribute('data-budget', 'hidden')
          })
        }
        var topsOf = function (children) {
          var tops = []
          children.forEach(function (child) {
            // An empty dock item is display:none and must not start a line.
            if (!child.getClientRects().length) return
            var top = child.offsetTop
            if (!tops.some(function (seen) { return Math.abs(seen - top) <= 2 })) tops.push(top)
          })
          return tops.sort(function (a, b) { return a - b })
        }
        var mark = function () {
          var nextKey = key()
          if (nextKey === lastKey) return
          lastKey = nextKey
          applyColumnBudget()
          var maxLines = budget()
          if (!maxLines) { row.setAttribute('data-lines', '0'); return }
          var children = groups()
          children.forEach(function (child) { child.removeAttribute('data-overflow') })
          if (breakNode) breakNode.style.display = 'none'
          if (!row.clientWidth) return
          var tops = topsOf(children)
          if (tops.length > maxLines) {
            var cut = tops[maxLines]
            children.forEach(function (child) {
              if (child.getClientRects().length && child.offsetTop >= cut - 2) child.setAttribute('data-overflow', 'true')
            })
            tops = topsOf(children)
          }
          // A lonely group on line two wastes most of the line. Move the last
          // group of line one down so both lines carry information.
          if (breakNode && maxLines === 2 && tops.length === 2) {
            var secondTop = tops[1] - 2
            var first = children.filter(function (child) { return child.getClientRects().length && child.offsetTop < secondTop })
            var second = children.filter(function (child) { return child.getClientRects().length && child.offsetTop >= secondTop })
            if (first.length > 1 && second.length === 1) {
              var target = first[first.length - 1]
              if (breakNode.nextSibling !== target) { ignoreMutations++; row.insertBefore(breakNode, target) }
              breakNode.style.display = 'block'
              if (topsOf(children).length > 2) {
                breakNode.style.display = 'none'
                target.setAttribute('data-overflow', 'true')
              }
            }
          }
          row.setAttribute('data-lines', String(Math.min(maxLines, topsOf(children).length)))
          var current = null
          children.forEach(function (child) {
            // An empty or overflow item must not start a line or draw a separator.
            if (child === breakNode || !child.getClientRects().length) { child.removeAttribute('data-line-start'); return }
            var center = child.offsetTop + child.offsetHeight / 2
            var start = current === null || Math.abs(center - current) > 2 ? 'true' : 'false'
            if (child.getAttribute('data-line-start') !== start) child.setAttribute('data-line-start', start)
            current = center
          })
        }
        var resize = typeof ResizeObserver === 'function' ? new ResizeObserver(function (entries) {
          // A native stats change can change the official line count without
          // changing this row's width, so re-evaluate when the dock resizes.
          if (dock && entries.some(function (entry) { return entry.target === dock })) lastKey = null
          mark()
        }) : null
        var observe = function () {
          lastKey = null
          mark()
          if (resize) {
            resize.disconnect()
            resize.observe(row)
            groups().forEach(function (child) { resize.observe(child) })
            if (dock) resize.observe(dock)
          }
        }
        var mutation = typeof MutationObserver === 'function' ? new MutationObserver(function () {
          if (ignoreMutations) { ignoreMutations--; return }
          observe()
        }) : null
        observe()
        // A re-declared budget arrives as an attribute change on an existing node,
        // which a childList-only observer never sees. Only that attribute is
        // watched: the row writes data-overflow/data-budget itself and must not
        // wake its own observer.
        if (mutation) mutation.observe(row, { childList: true, attributes: true, attributeFilter: ['data-min-columns'] })
        return function () {
          if (resize) resize.disconnect()
          if (mutation) mutation.disconnect()
          if (root) root.removeAttribute('data-official-hidden')
        }
      }, [enabled, node])
    }

    // 上下文压力组：读取 dock 槽位提供的官方投影
    function ContextProjection(props) {
      var pressure = null, usage = null, metrics = null
      if (typeof props.useProjection === 'function') {
        try { pressure = props.useProjection('contextPressure') } catch (e) { pressure = null }
        // Optional: older Hosts lack token-meter's usage projection.
        try { usage = contextUsage(props.useProjection('tokenUsage')) } catch (e) { usage = null }
        try { metrics = props.useProjection('statuslineMetrics') } catch (e) { metrics = null }
      }
      var used = pressure && (pressure.projectedTokens !== undefined ? pressure.projectedTokens : pressure.pressureTokens)
      var windowSize = pressure && pressure.contextWindow
      var usedN = Number(used)
      var windowN = Number(windowSize)
      if (!Number.isFinite(usedN) || !Number.isFinite(windowN) || windowN <= 0) return null
      var pct = clampPct(usedN / windowN * 100)
      return React.createElement(ContextRow, { enabled: true, usedTokens: usedN, contextWindow: windowN, pct: pct, usage: usage,
        compactions: metrics && Number.isSafeInteger(metrics.compactions) ? metrics.compactions : 0,
        cacheMisses: metrics && metrics.session && Number.isSafeInteger(metrics.session.cacheMisses) ? metrics.session.cacheMisses : null })
    }

    // Native push, coalesced to at most 5 UI updates/sec for one integer; no polling.
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
          var remaining = 200 - (performance.now() - lastPaint)
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
      // Like cost and context, stay out of the row until there is a real reading.
      if (!available) return null
      var phase = data.phase
      var label = data.held ? t('tpsPrevious') : 'TPS'
      var text = label + ' ' + (data.estimated ? '≈' : '') + formatRate(rate) + ' tok/s'
      var status = phase === 'unavailable' ? t('tpsUnavailable') : phase === 'completed' ? t('tpsCompleted') : phase === 'interrupted' ? t('tpsInterrupted') : ''
      if (data.held) status += (status ? ' · ' : '') + t('tpsHeld')
      if (!data.held && (phase === 'completed' || phase === 'interrupted')) status += (status ? ' · ' : '') + t('tpsAverage')
      status += (status ? ' · ' : '') + t(data.estimated ? 'tpsEstimated' : 'tpsMeasured')
      return React.createElement('span', { className: 'slp-tps slp-group' + (data.held ? ' slp-muted' : ''), title: status + '\n' + t('tpsTitle') }, text)
    }

    // Real row and preview share component construction and order. Preview hooks
    // only read local samples; they never acquire a session or a quota resource.
    // `extensions` lists loaded dock items ({ id, label }); `renderExtension(id)`
    // draws one. An extension with a built-in id takes that built-in's place,
    // shown under the built-in's switch.
    function dockComponents(config, props, gitProps, extensions, renderExtension) {
      var loaded = {}
      ;(extensions || []).forEach(function (item) { loaded[item.id] = item })
      var factories = {
        git: function () { return gitProps && gitProps.hidden ? null : React.createElement(GitLine, Object.assign({ key: 'git' }, gitProps)) },
        context: function () { return React.createElement(ContextProjection, { key: 'context', useProjection: props.useProjection }) },
        tps: function () { return React.createElement(TpsRow, { key: 'tps', sessionId: props.sessionId, preview: props.preview }) },
        cost: function () { return React.createElement(CostRow, { key: 'cost', useProjection: props.useProjection }) },
        activity: function () { return React.createElement(ActivityRow, { key: 'activity', useProjection: props.useProjection, useSessions: props.useSessions, useSessionStatus: props.useSessionStatus, sessionId: props.sessionId, preview: props.preview }) },
        tools: function () { return React.createElement(ToolActivityRow, { key: 'tools', useProjection: props.useProjection, useSessionStatus: props.useSessionStatus, sessionId: props.sessionId, preview: props.preview }) },
      }
      return layoutOrder(config.componentOrder, extensions).filter(function (id) { return (COMPONENTS[id] || loaded[id]) && componentEnabled(config, id) }).map(function (id) {
        return loaded[id] && renderExtension ? renderExtension(id) : factories[id] ? factories[id]() : null
      }).filter(Boolean)
    }
    // Loaded dock extensions, live: plugins may register before or after this
    // one, and leave. Needs a Host whose slots service lists and watches entries;
    // an older Host has none and shows only built-ins.
    var dockSlots = null
    function dockSlotsCapable(slots) {
      return !!slots && typeof slots.entriesOfSlot === 'function' && typeof slots.subscribe === 'function' && typeof slots.getVersion === 'function'
    }
    var warnedDockIds = {}
    // One cell is about one digit in the row's font. The cap bounds how much of
    // the row one plugin can claim; 0 turns it off. The defaults are generous
    // enough that a normal chip is never clipped, and they are documented in
    // docs/extending/README.md as a contract, not an internal constant.
    var DOCK_MAX_CELLS_DEFAULT = 24, DOCK_MAX_CELLS_LIMIT = 48, DOCK_MIN_COLUMNS_LIMIT = 400, DOCK_DETAIL_LIMIT = 160
    function dockCellBudget(value) {
      if (value === undefined || value === null) return DOCK_MAX_CELLS_DEFAULT
      if (value === 0 || value === false || value === 'off') return 0
      var n = Number(value)
      if (!Number.isFinite(n)) return DOCK_MAX_CELLS_DEFAULT
      return Math.max(1, Math.min(DOCK_MAX_CELLS_LIMIT, Math.round(n)))
    }
    function dockMinColumns(value) {
      var n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return 0
      return Math.min(DOCK_MIN_COLUMNS_LIMIT, Math.round(n))
    }
    function dockDetail(value) {
      if (typeof value !== 'string') return ''
      return value.trim().slice(0, DOCK_DETAIL_LIMIT)
    }
    function dockExtensionsOf(slots) {
      var seen = {}
      return slots.entriesOfSlot(DOCK_ITEM_SLOT).map(function (entry) {
        var options = entry && entry.options || {}, id = options.id
        if (!(COMPONENTS[id] || isExtensionId(id))) {
          if (!warnedDockIds[id]) { warnedDockIds[id] = true; console.warn('[statusline-plus] ignoring dock item "' + id + '": use a namespaced id like "my-plugin.item"') }
          return null
        }
        if (seen[id]) return null
        seen[id] = true
        // A label runs in this plugin's render, outside the item's Host guard, so a
        // throwing one falls back to the id instead of taking the row down.
        var label = options.label
        if (typeof label === 'function') { try { label = label() } catch (e) { label = null } }
        return { id: id, label: typeof label === 'string' && label ? label : id,
          maxCells: dockCellBudget(options.maxCells), minColumns: dockMinColumns(options.minColumns), detail: dockDetail(options.detail) }
      }).filter(Boolean)
    }
    // The Host's renderSlot is stable per entry and its outlet follows the slot
    // itself, so a row re-render (every streamed step) skips other plugins' items.
    // Built on first use, so loading the bundle needs nothing beyond the hooks.
    var NO_OWNER_PROPS = {}, dockExtensionItem = null
    function DockExtensionItem() {
      return dockExtensionItem || (dockExtensionItem = React.memo(function DockExtensionItem(props) {
        return props.renderSlot(DOCK_ITEM_SLOT, NO_OWNER_PROPS, { only: props.id })
      }))
    }
    function useDockExtensions() {
      var slots = dockSlots, pair = React.useState(function () { return slots ? slots.getVersion(DOCK_ITEM_SLOT) : 0 })
      React.useEffect(function () {
        if (!slots) return undefined
        var sync = function () { pair[1](slots.getVersion(DOCK_ITEM_SLOT)) }
        var unsubscribe = slots.subscribe(DOCK_ITEM_SLOT, sync)
        sync() // a registration between render and subscribe
        return unsubscribe
      }, [slots])
      // The row re-renders on every streamed step; read the slot and run label
      // functions again only when registrations or the language change.
      return React.useMemo(function () { return slots ? dockExtensionsOf(slots) : [] }, [slots, pair[0], currentLang()])
    }
    function LayoutPreview(props) {
      var pair = React.useState(null), width = React.useState('auto')
      useWrapMarkers(pair[0], props.config.enabled !== false)
      var now = Date.now(), sample = {
        contextPressure: { projectedTokens: 127000, contextWindow: 1000000 },
        tokenUsage: { uncachedInputTokens: 12000, cacheReadTokens: 112000, cacheWriteTokens: 12000, outputTokens: 5600 },
        statuslineMetrics: { session: { pricedMessages: 8, unpricedMessages: 0, cacheMisses: 2, amountCny: 0.316,
          breakdown: { input: { amountCny: 0.1, tokensCny: 12000 }, cache: { amountCny: 0.06, tokensCny: 124000 }, output: { amountCny: 0.156, tokensCny: 5600 } } }, pricingAsOf: '2026-10-02T04:24:12Z' },
        subagentCatalog: [{ id: 'sample-worker', label: 'Worker', mode: 'continuable', createdAt: 2 }, { id: 'sample-reviewer', label: 'Reviewer', mode: 'one-shot', createdAt: 1 }],
        statuslineToolActivity: { activeCount: 1, tools: [{ callId: 'sample-call', name: 'read_file', status: 'running', startedAt: now - 12000, endedAt: null }], truncated: false },
      }
      var sampleSessions = { byId: {}, projectionsBySession: {
        'sample-worker': { values: { subagentTiming: { settledMs: 12000 }, modelSelection: { lastUsed: { model: 'deepseek-flash', reasoningEffort: 'high' }, next: null } } },
        'sample-reviewer': { values: { subagentTiming: { settledMs: 8000 } } },
      } }
      var extensions = useDockExtensions()
      var groups = props.config.enabled === false ? [] : dockComponents(props.config, { preview: true,
        useProjection: function (key) { return sample[key] || null },
        useSessions: function (select) { return select(sampleSessions) },
        useSessionStatus: function (select) { return select(new Map([['sample-worker', { running: true }], ['sample-reviewer', { running: false }]])) },
      }, { data: { isRepo: true, branch: 'main', counts: { staged: 0, unstaged: 1, untracked: 0, conflict: 0 } }, path: props.config.showCwd === false ? null : 'project/demo', fullPath: '/sample/project/demo', refresh: function () {} },
      extensions, function (id) {
        // Extensions need a live session; the preview marks their place by name.
        var item = extensions.find(function (entry) { return entry.id === id })
        return React.createElement('span', { key: id, className: 'slp-group slp-ext-sample', title: tf('layoutExtensionTitle', { id: id }) }, item ? item.label : id)
      })
      return React.createElement('div', { className: 'slp-layout-block' },
        React.createElement('div', { className: 'slp-subhead' },
          React.createElement('span', { className: 'slp-subhead-title' }, t('layoutPreview'), hint(t('layoutPreviewHint'))),
          React.createElement('span', { className: 'slp-segmented', role: 'group' }, ['auto', '320'].map(function (value) {
            return React.createElement('button', { type: 'button', key: value, className: 'slp-btn slp-btn-sm', 'aria-pressed': width[0] === value,
              onClick: function () { width[1](value) } }, t(value === 'auto' ? 'layoutPreviewAuto' : 'layoutPreviewNarrow'))
          }))),
        React.createElement('div', { className: 'slp-preview', style: width[0] === '320' ? { width: '320px' } : null, role: 'region', 'aria-label': t('layoutPreview') },
          groups.length ? React.createElement('div', { className: 'slp-row', ref: pair[1] }, groups,
            React.createElement('span', { key: '__slp-row-break', className: 'slp-row-break', 'aria-hidden': 'true' })) : React.createElement('span', { className: 'slp-muted' }, t('layoutPreviewEmpty'))))
    }
    function LayoutEditor(props) {
      var extensions = useDockExtensions(), loaded = {}
      extensions.forEach(function (item) { loaded[item.id] = item })
      // Built-ins and loaded extensions; an unloaded extension keeps its saved place unseen.
      var shown = layoutOrder(props.config.componentOrder, extensions)
      var order = shown.filter(function (id) { return COMPONENTS[id] || loaded[id] }), preset = matchingPreset(props.config)
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
          onPointerUp: function (event) { finishOrderDrag(event, props.config, props.onChange, shown) },
          onPointerCancel: function (event) { clearOrderDrag(event.currentTarget) },
          onLostPointerCapture: function (event) { clearOrderDrag(event.currentTarget) },
          onKeyDown: function (event) { if (event.key === 'Escape' && event.currentTarget.slpOrderDrag) { event.preventDefault(); event.stopPropagation(); clearOrderDrag(event.currentTarget) } },
        }, order.map(function (id, index) {
          var builtIn = COMPONENTS[id], extension = loaded[id]
          var name = builtIn ? t(builtIn.label) : extension.label
          function move(delta) { var other = order[index + delta]; if (other === undefined) return; props.onChange({ componentOrder: reorderComponent(shown, id, other, delta > 0) }) }
          function toggle(on) {
            if (builtIn) { var patch = {}; patch[builtIn.field] = on; props.onChange(patch); return }
            var hidden = (props.config.hiddenComponents || []).filter(function (item) { return item !== id })
            props.onChange({ hiddenComponents: on ? hidden : hidden.concat(id) })
          }
          return React.createElement('li', { className: 'slp-order-item', key: id, 'data-component': id },
            React.createElement('button', { type: 'button', className: 'slp-drag-handle', 'aria-label': tf('layoutDrag', { name: name }), title: t('layoutDragHint'),
              onPointerDown: function (event) { startOrderDrag(event, id) },
              onKeyDown: function (event) { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); clearOrderDrag(event.currentTarget.closest('.slp-order-list')); move(event.key === 'ArrowUp' ? -1 : 1) } },
            }, '⋮⋮'),
            React.createElement('label', { className: 'slp-check' },
              React.createElement('input', { type: 'checkbox', name: builtIn ? builtIn.field : 'hiddenComponents', checked: componentEnabled(props.config, id), 'aria-label': name,
                onChange: function (event) { toggle(event.target.checked) } }),
              React.createElement('span', { className: 'slp-check-text' }, name),
              // Where an item comes from: another plugin, or another plugin standing in for a built-in.
              extension ? React.createElement('span', { className: 'slp-ext-tag', title: tf('layoutExtensionTitle', { id: id }) }, t(builtIn ? 'layoutReplaced' : 'layoutExtension')) : null),
            id === 'context' ? hint(t('setNativeContextHint')) : null,
            React.createElement('span', { className: 'slp-order-actions' },
              React.createElement('button', { type: 'button', className: 'slp-btn slp-btn-icon', 'aria-label': tf('layoutUp', { name: name }), disabled: index === 0, onClick: function () { move(-1) } }, '↑'),
              React.createElement('button', { type: 'button', className: 'slp-btn slp-btn-icon', 'aria-label': tf('layoutDown', { name: name }), disabled: index === order.length - 1, onClick: function () { move(1) } }, '↓')))
        })),
        React.createElement(LayoutPreview, { config: props.config }))
    }

    // ---------------- 主面板（composer.dock 多行） ----------------
    function StatusPanel(props) {
      useLocaleRevision()
      // The dock is mounted only in a started conversation, so this is the
      // public signal the model button uses to drop its quota rail.
      usePaintEffect(function () {
        setComposerStarted(true)
        return function () { setComposerStarted(false) }
      }, [])
      var config = useConfigSnapshot()
      var probe = React.useState(null), width = React.useState(null)
      var hideOnNarrow = !!(config && config.enabled !== false && config.hideBottomOnNarrow)
      React.useEffect(function () {
        if (!hideOnNarrow || !probe[0]) { width[1](null); return undefined }
        // The slot can be display:contents and the dock shrinks to its contents.
        // Measure its sibling input card so suppressing the row cannot latch it.
        var dock = probe[0].closest('[data-composer-dock]')
        var target = dock && dock.parentElement.querySelector('[data-composer-card]') || dock || probe[0].parentElement
        var measure = function () { width[1](target.getBoundingClientRect().width) }
        var observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer) observer.observe(target)
        window.addEventListener('resize', measure)
        measure()
        return function () { if (observer) observer.disconnect(); window.removeEventListener('resize', measure) }
      }, [hideOnNarrow, probe[0]])
      if (!config || config.enabled === false) return null
      // Wait for measurement before starting live resources. The hidden probe
      // survives suppression so sidebar/container resizes can restore the row.
      var suppressed = hideOnNarrow && (width[0] === null || width[0] <= 480)
      var panel = suppressed ? null : React.createElement(LiveStatusPanel, Object.assign({}, props, { config: config }))
      return hideOnNarrow ? React.createElement(React.Fragment, null,
        React.createElement('span', { ref: probe[1], 'aria-hidden': true, style: { display: 'none' } }), panel) : panel
    }

    function LiveStatusPanel(props) {
      var config = props.config
      var rowNode = React.useState(null)
      useWrapMarkers(rowNode[0], !!(config && config.enabled))
      var [gitState, setGitState] = React.useState({ busy: false, data: null, error: null })
      // git 刷新状态引用：避免定时器/step 回调捕获过期闭包
      var gitCwdRef = React.useRef(null)
      var gitInflightRef = React.useRef(null) // 在途请求对应的 session/cwd/request
      var gitLastRef = React.useRef(null)
      var gitFailuresRef = React.useRef({ key: null, count: 0 })
      var gitTimerRef = React.useRef(null)
      var stepSessionRef = React.useRef(null)
      var stepBaselineRef = React.useRef(null)

      // Subscribe to the official global workspace hook so workspace changes
      // invalidate the resolved path and trigger the Git effect again.
      var wsSnapshot = null
      if (typeof props.useWorkspaces === 'function') {
        try { wsSnapshot = props.useWorkspaces(function (x) { return x }) } catch (e) { wsSnapshot = null }
      }

      // 解析当前会话工作区路径：配置显式指定 > Host 当前工作目录 > 会话摘要 > workspace 兜底。
      // workingDirectory 投影跟随 working_directory 工具的 cd；会话摘要的 cwd 是最初目录。
      var workingCwd = null
      if (typeof props.useProjection === 'function') {
        try { workingCwd = props.useProjection('workingDirectory') } catch (e) { workingCwd = null }
      }
      // The Host's ContextMeter renders nothing until the token meter reports
      // both pressure and a context window. Read the same projection so the row
      // can wait for the first usage sample instead of showing a lone TPS.
      var contextPressure = null
      if (typeof props.useProjection === 'function') {
        try { contextPressure = props.useProjection('contextPressure') } catch (e) { contextPressure = null }
      }
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
      if (!sessionCwd && typeof workingCwd === 'string' && workingCwd) sessionCwd = workingCwd
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
          // Keep what is on screen while asking again, so a retry cannot make the chip blink.
          var same = old && old.cwd === cwd && old.sessionId === sessionId
          // Only a click dims the chip. A refresh that follows activity keeps the
          // chip at full strength, so an agent turn cannot make it flicker.
          return { busy: true, manual: force === true, data: same ? old.data : null, stale: same && old.stale, error: same ? old.error : null,
            errorVisible: same && old.errorVisible, cwd: cwd, sessionId: sessionId }
        })
        apiGit(cwd, sessionId, request.controller.signal, force).then(function (result) {
          if (gitInflightRef.current !== request) return
          var failures = gitFailuresRef.current
          failures.count = result.ok ? 0 : failures.key === key ? failures.count + 1 : 1
          failures.key = key
          var count = failures.count
          // Refreshes follow activity, so an idle session would otherwise never ask a second time.
          request.retryTransient = !result.ok && count === 1 && GIT_TRANSIENT_ERRORS.indexOf(result.error) !== -1
          setGitState(function (old) {
            var retained = old && old.cwd === cwd && old.sessionId === sessionId ? old.data : null
            return { busy: false, manual: false, data: result.ok ? result.data : retained,
              stale: !result.ok && !!retained, error: result.ok ? null : result.error,
              errorVisible: !result.ok && gitErrorVisible(result.error, count), cwd: cwd, sessionId: sessionId }
          })
        }).finally(function () {
          if (gitInflightRef.current !== request) return
          gitInflightRef.current = null
          gitLastRef.current = { key: key, at: Date.now() }
          if (request.pendingForce) refreshGitRef.current(true)
          else if (request.pending) refreshGitRef.current(false, true)
          else if (request.retryTransient && gitTimerRef.current === null) {
            gitTimerRef.current = setTimeout(function () {
              gitTimerRef.current = null
              refreshGitRef.current(false, true)
            }, GIT_TRANSIENT_RETRY_MS)
          }
        })
      }
      refreshGitRef.current = refreshGit
      // 首次挂载 / 工作区或会话变化：立即拉取
      React.useEffect(function () {
        if (!config || config.enabled === false || !config.showGit || !resolvedCwd || !pageVisible) {
          // A momentarily unresolved directory must not blank a chip that already
          // shows this session's repository; only a real answer may replace it.
          setGitState(function (old) {
            var sameSession = old && (old.sessionId === (props.sessionId || null) || !old.sessionId)
            return sameSession && old.data ? Object.assign({}, old, { busy: false, manual: false })
              : { busy: false, manual: false, data: null, error: t('gitNoWorkspace') }
          })
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

      // 窗口重新获得焦点时立即补一次刷新（切走期间工作区可能已变化）。切回标签页
      // 由上面依赖 pageVisible 的 effect 负责；这里读 ref，始终用最新一次渲染的刷新函数。
      React.useEffect(function () {
        if (!config || config.enabled === false || !config.showGit) return undefined
        var onFocus = function () { refreshGitRef.current() }
        window.addEventListener('focus', onFocus)
        return function () {
          window.removeEventListener('focus', onFocus)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [config && config.enabled, config && config.showGit, props.sessionId, resolvedCwd, pageVisible])

      // 会话 step 结束（sessionStats.steps 投影在 step/end 时 +1）时刷新：
      // agent 的 bash 操作常改动工作区，step 后立即补一次让 git 信息保持及时
      var stepStats = props.useProjection ? props.useProjection('sessionStats') : null
      var stepCount = stepStats && typeof stepStats.steps === 'number' ? stepStats.steps : null
      // 首条消息结算前不显示 Git：让它在 context / cost 出现的同一时刻进场，
      // 而不是新会话里孤零零地先占一行。挂载时仍会预取，首次显示无需再等。
      var metrics = props.useProjection ? props.useProjection('statuslineMetrics') : null
      var settledMessages = metrics && metrics.session
        ? (metrics.session.pricedMessages || 0) + (metrics.session.unpricedMessages || 0) : 0
      var gitHidden = !!metrics && settledMessages === 0
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

      // A dragged order shows at once and is saved; the Host's answer then
      // replaces it, and a refused write puts the saved order back.
      var pendingOrder = React.useState(null)
      var savedOrder = JSON.stringify(componentOrder(config && config.componentOrder))
      React.useEffect(function () { pendingOrder[1](null) }, [savedOrder])
      // Extensions render through the declared child slot; without it (an older
      // Host) the row has only built-ins.
      var extensions = useDockExtensions()
      if (typeof props.renderSlot !== 'function') extensions = []
      var shownOrder = layoutOrder(pendingOrder[0] || (config && config.componentOrder), extensions)
      useDockDrag(rowNode[0], shownOrder, function (next) {
        pendingOrder[1](next)
        apiSetConfig({ componentOrder: next }).then(function (result) { if (!result.ok) pendingOrder[1](null) })
      })

      if (!config || config.enabled === false) return null
      // A new session knows its window but has no usage yet: the official meter
      // is still hidden, so hide the row too and let both enter on the first
      // usage sample. A Host without the projection keeps the old behaviour.
      var officialVisible = contextPressure == null || contextPressure.contextWindow === undefined ||
        (contextPressure.projectedTokens !== undefined ? contextPressure.projectedTokens : contextPressure.pressureTokens) !== undefined
      if (!officialVisible) return null
      // 所有启用的信息组放进同一个 flex 行：放得下就一行，
      // 放不下时 flex-wrap 把整组依次换到下一行，不硬性拆分多行。
      // The answer belongs to this session's directory. A state recorded before
      // the session bound still describes the same directory, and an unresolved
      // directory keeps the last answer instead of blanking the chip.
      var sameGitSession = gitState.sessionId === (props.sessionId || null) || !gitState.sessionId
      var currentGit = sameGitSession && (gitState.cwd === resolvedCwd || !resolvedCwd) ? gitState : {}
      var cwdShown = currentGit.data && currentGit.data.repoRoot || sessionCwd || resolvedCwd
      // SSH repos: label by host + remote path, not the local anchor directory name
      var remoteRepo = currentGit.data && currentGit.data.remote
      var pathShown = remoteRepo ? remoteRepo.host + ':' + formatPathSegs(remoteRepo.root, 2) : cwdShown && formatPathSegs(cwdShown, 2)
      var pathFull = remoteRepo ? remoteRepo.host + ':' + remoteRepo.root : cwdShown
      var groups = dockComponents(pendingOrder[0] ? Object.assign({}, config, { componentOrder: pendingOrder[0] }) : config, props, {
          hidden: gitHidden,
          data: currentGit.data,
          busy: currentGit.busy,
          manual: currentGit.manual,
          stale: currentGit.stale,
          error: currentGit.error,
          errorVisible: currentGit.errorVisible,
          refresh: function () { refreshGit(true) },
          path: config.showCwd && pathShown ? pathShown : null,
          fullPath: pathFull,
      }, extensions, function (id) {
        // The Host's per-entry guard keeps a crashing extension to its own item.
        return React.createElement(DockExtensionItem(), { key: id, id: id, renderSlot: props.renderSlot })
      })
      if (groups.length === 0) return null
      var extensionById = {}
      extensions.forEach(function (item) { if (item) extensionById[item.id] = item })
      // Each component sits in an item named by its id, which the drag reads.
      return React.createElement('div', { className: 'slp-root' },
        React.createElement('div', { className: 'slp-row', ref: rowNode[1], key: 'r-main' }, groups.map(function (group) {
          var ext = extensionById[group.key]
          var wrapper = { key: group.key, className: 'slp-dock-item', 'data-component': group.key }
          // A declared budget is applied by the row rather than trusted to the
          // item: only the row knows how much room is actually there.
          if (ext && ext.maxCells) {
            wrapper.className += ' slp-budgeted'
            wrapper.style = { maxWidth: ext.maxCells + 'ch' }
          }
          if (ext && ext.minColumns) wrapper['data-min-columns'] = ext.minColumns
          if (ext && ext.detail) wrapper.title = ext.detail
          return React.createElement('span', wrapper, group)
        }), React.createElement('span', { key: '__slp-row-break', className: 'slp-row-break', 'aria-hidden': 'true' }))
      )
    }

    // ---------------- 头部 chip（session.header.actions） ----------------
    // The Host sizes this slot from its content (flex: 0 0 auto) inside a clipping
    // title cluster, so @container has no width to query here. Try each form from
    // fullest down and keep the first that clears the cluster's clip and fade.
    var FOLD_FADE_PX = 24
    function clipAncestor(node) {
      for (var parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        var overflow = getComputedStyle(parent).overflowX
        if (overflow === 'clip' || overflow === 'hidden') return parent
      }
      return null
    }
    function pickFoldLevel(apply, fits, maxLevel) {
      for (var level = 0; level < maxLevel; level++) {
        apply(level)
        if (fits()) return level
      }
      apply(maxLevel)
      return maxLevel
    }
    function ChipFold(props) {
      var ref = React.useRef(null)
      React.useLayoutEffect(function () {
        var root = ref.current, clip = root && clipAncestor(root)
        if (!clip || typeof ResizeObserver !== 'function') return
        function apply(level) {
          if (level) root.setAttribute('data-fold', String(level))
          else root.removeAttribute('data-fold')
        }
        function measure() {
          // Several subscriptions side by side need their names to stay readable.
          var maxLevel = root.querySelectorAll('.slp-quota-with-age').length > 1 ? 2 : 3
          pickFoldLevel(apply, function () { return root.getBoundingClientRect().right <= clip.getBoundingClientRect().right - FOLD_FADE_PX }, maxLevel)
        }
        measure()
        // Folding resizes the observed chip, so re-measure outside the observer
        // callback to avoid a "ResizeObserver loop" error on the page.
        var timer = null
        var observer = new ResizeObserver(function () {
          if (timer === null) timer = setTimeout(function () { timer = null; measure() }, 0)
        })
        observer.observe(clip)
        observer.observe(root)
        return function () { observer.disconnect(); if (timer !== null) clearTimeout(timer) }
      }, [])
      return React.createElement('span', { className: 'slp-fold', ref: ref }, props.children)
    }
    var CLAUDE_PROVIDER = { id: 'claude', label: SUBSCRIPTIONS.claude.name, noApiKey: true }
    function HeaderChip(props) {
      useLocaleRevision()
      var config = useConfigSnapshot()
      var anyEnabled = !!(config && config.enabled && (config.showQuota || config.showDeepseekPeak !== false))
      var visible = usePageVisible(anyEnabled)
      var stats = props.useProjection ? props.useProjection('sessionStats') : null
      var count = stats && typeof stats.steps === 'number' ? stats.steps : null
      var running = typeof props.useSessionStatus === 'function' ? props.useSessionStatus(function (statuses) {
        var status = sessionStatusOf(statuses, props.sessionId)
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
      var model = selected || modelState.model
      if (selected) modelState = { status: 'resolved', model: selected }
      if (model) noteResetModel(model)
      var onStep = quotaRefreshOnStep(config)
      function makeResource(kind) { return { kind: kind, key: kind, onStep: onStep, cacheOnStep: true } }
      function sessionResource(resource) { resource.key += ':' + (props.sessionId || ''); return resource }
      var enabledKinds = enabledQuotaKinds(config)
      var quotaChip = null
      if (config.showQuota) {
        if (config.quotaShowAll) {
          var all = enabledKinds.map(makeResource).map(sessionResource)
          quotaChip = renderSubscriptionChips(all, config, activity, sessionResource({ kind: 'magpie', key: 'magpie:all', onStep: onStep, cacheOnStep: true }))
        } else if (config.quotaAuto === false) {
          if (quotaKindEnabled(config, 'opencode')) {
            quotaChip = React.createElement(QuotaChip, { resource: sessionResource(makeResource('opencode')), config: config, stepCount: activity })
          }
        } else if (modelState.status === 'resolved' && model) {
          var source = modelQuotaSource(model, config)
          if (source) {
            quotaChip = React.createElement(QuotaChip, {
              key: 'quota:' + (props.sessionId || '') + ':' + source.key,
              resource: sessionResource({ kind: source.kind, id: source.id, provider: source.provider,
                modelProvider: source.modelProvider, key: source.key, onStep: onStep, cacheOnStep: true }),
              config: config, stepCount: activity,
              subscriptionOnly: source.subscriptionOnly, quietAbsent: source.quietAbsent,
            })
          } else if (!primarySubscriptionKind(model) && looksLikeSubscription(model)) {
            // Only a subscription-looking model with no reader at all says "not
            // found"; a source that exists but is switched off shows nothing.
            // A new model gets a fresh 10 s status, not the previous one's remainder.
            quotaChip = quotaUnavailable(t('subscriptionNotFound'), null,
              'nf:' + String(model.provider || '') + '/' + String(model.model || ''))
          }
        }
      }
      // No matching source (or model still resolving): show nothing rather than a placeholder.
      if (config.showDeepseekPeak !== false && isDeepseekBilling(model)) return React.createElement('span', { className: 'slp-header-group' },
        quotaChip, React.createElement(DeepseekPeakChip, { countdown: config.deepseekPeakCountdown !== false }))
      return quotaChip
    }
    function QuotaChip(props) {
      var quota = useQuotaResource(props.resource, props.config, props.stepCount)
      useRetryClock(quota.retryAt)
      var panelOpen = React.useState(false)
      var now = useQuotaClock(!!quota.data, panelOpen[0] ? 1000 : QUOTA_CHIP_TICK_MS)
      var settled = !!(quota.data || quota.error)
      useResetAnchorSignal(settled)
      // A model selects exactly one subscription. When its own source has no
      // usable credential or response, say so instead of carrying the chip over
      // to another enabled subscription (e.g. Codex for a Gemini model).
      // quietAbsent: having no such subscription is normal, so nothing shows until
      // there is data. A stopped Magpie says the same for a Magpie-only subscription.
      if (props.quietAbsent && !quota.data && (!quota.error || props.resource.kind === 'magpie' || QUOTA_ABSENT_ERRORS.indexOf(quota.error) !== -1)) return null
      if (props.subscriptionOnly && !quota.data && quota.error && QUOTA_ABSENT_ERRORS.indexOf(quota.error) !== -1) {
        return quotaUnavailable(t('subscriptionNotFound'), quotaReasonDetail(quota.error), 'nf:' + props.resource.key)
      }
      var kind = props.resource.kind
      return React.createElement('span', { className: 'slp-quota-with-age', 'data-slp-quota-kind': kind,
        // Every quota chip can carry a reset drawer; '' when no feed matches it.
        'data-slp-reset-kind': resetKindOfName(kind === 'magpie' || kind === 'provider' ? props.resource.id : kind),
        'data-slp-quota-ready': settled ? 'true' : 'false' },
        React.createElement(QuotaLine, { kind: kind, onPanelOpen: panelOpen[1], provider: kind === 'claude' ? CLAUDE_PROVIDER : props.resource.provider, data: quota.data, error: quota.error, staleError: quota.staleError, retryExhausted: quota.retryExhausted,
          retryAt: quota.retryAt, retryAttempt: quota.retryAttempt,
          ttlMs: quotaTtlMs(props.config.cacheTtlMs), now: now, refresh: quota.refresh,
          mode: props.config.quotaPercentMode === 'left' ? 'left' : 'used' }))
    }
    function renderSubscriptionChips(resources, config, stepCount, extras) {
      return React.createElement('span', { className: 'slp-header-group' },
        resources.map(function (resource) {
          return React.createElement(QuotaChip, { key: resource.key, resource: resource, config: config, stepCount: stepCount, quietAbsent: resource.kind === 'claude' })
        }),
        React.createElement(MagpieExtraChips, { key: 'magpie-extras', resource: extras, config: config, stepCount: stepCount }))
    }
    // Everything else in this user's Magpie. No dedicated reader, so no name list:
    // only the subscriptions with their own chips above are left out.
    var DEDICATED_SUBSCRIPTION_RE = new RegExp('^(?:' + QUOTA_SUBSCRIPTION_KINDS.join('|') + '|anthropic)')
    function MagpieExtraChips(props) {
      var quota = useQuotaResource(props.resource, props.config, props.stepCount)
      var list = quota.data && Array.isArray(quota.data.subscriptions) ? quota.data.subscriptions : []
      return list.filter(function (item) { return item && !DEDICATED_SUBSCRIPTION_RE.test(String(item.id)) }).map(function (item) {
        return React.createElement(MagpieExtraChip, { key: item.id, item: item, quota: quota, config: props.config })
      })
    }
    function MagpieExtraChip(props) {
      var item = props.item, quota = props.quota
      var panelOpen = React.useState(false)
      var now = useQuotaClock(true, panelOpen[0] ? 1000 : QUOTA_CHIP_TICK_MS)
      useResetAnchorSignal(true)
      return React.createElement('span', { className: 'slp-quota-with-age', 'data-slp-quota-kind': String(item.id || 'magpie'),
        'data-slp-reset-kind': resetKindOfName(item.id), 'data-slp-quota-ready': 'true' },
        React.createElement(QuotaLine, { onPanelOpen: panelOpen[1], provider: { id: item.id, label: item.label, noApiKey: true },
          data: Object.assign({}, item, { fetchedAt: quota.data.fetchedAt, source: quota.data.source }),
          ttlMs: quotaTtlMs(props.config.cacheTtlMs), now: now, refresh: quota.refresh,
          mode: props.config.quotaPercentMode === 'left' ? 'left' : 'used' }))
    }

    // ---------------- 订阅额度重置提醒（AIHOT） ----------------
    // Provider-wide resets announced by official accounts, not the user's own
    // rolling windows. The Host reads the feed (10 min, ETag) and picks what is
    // relevant now; this side holds one shared list. Two views read it: a drawer
    // that slides out of a header chip, and a box in every details panel.
    // "Got it" stops the drawer; the panels keep the notice. RESET_KINDS,
    // RESET_AUTO_KINDS and the names come from
    // SUBSCRIPTIONS above, so the reset feed and the chips cannot disagree.
    var RESET_POLL_MS = 10 * 60000
    var RESET_MIN_POLL_MS = 60000
    var RESET_LEAVE_MS = 200
    // The drawer may grow past its chip to keep the sentence on one line, up
    // to this many times the chip's width; beyond that it wraps.
    var RESET_STRETCH = 1.5
    // Chips announce themselves (mount, data arrives, unmount) so a waiting
    // drawer and an open one react to the header instead of polling or timing it.
    var resetAnchorStore = { revision: 0, listeners: [], pending: false }
    function noteResetAnchors() {
      if (resetAnchorStore.pending) return
      resetAnchorStore.pending = true
      // After the commit, so the DOM already shows the change.
      setTimeout(function () {
        resetAnchorStore.pending = false
        resetAnchorStore.revision++
        resetAnchorStore.listeners.slice().forEach(function (fn) { fn(resetAnchorStore.revision) })
      }, 0)
    }
    function useResetAnchorSignal(dep) {
      React.useEffect(function () { noteResetAnchors(); return noteResetAnchors }, [dep])
    }
    // The page has finished loading: the load event, web fonts, then one idle
    // moment so the session content renders first. Events, not a fixed delay.
    var resetPageReady = null
    function whenResetPageReady() {
      if (resetPageReady) return resetPageReady
      resetPageReady = new Promise(function (resolve) {
        if (document.readyState === 'complete') resolve()
        else window.addEventListener('load', function () { resolve() }, { once: true })
      }).then(function () {
        return document.fonts && document.fonts.ready ? document.fonts.ready.catch(function () {}) : null
      }).then(function () {
        return new Promise(function (resolve) {
          if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(function () { resolve() }, { timeout: 1500 })
          else setTimeout(resolve, 0)
        })
      })
      return resetPageReady
    }
    function useResetPageReady() {
      var pair = React.useState(false)
      React.useEffect(function () {
        var alive = true
        whenResetPageReady().then(function () { if (alive) pair[1](true) })
        return function () { alive = false }
      }, [])
      return pair[0]
    }
    function useResetAnchorRevision() {
      var pair = React.useState(resetAnchorStore.revision)
      React.useEffect(function () {
        var listener = pair[1]
        resetAnchorStore.listeners.push(listener)
        return function () { resetAnchorStore.listeners = resetAnchorStore.listeners.filter(function (fn) { return fn !== listener }) }
      }, [])
      return pair[0]
    }
    // A chip's subscription for reset purposes, by kind or by Magpie/provider id.
    // Only feed kinds qualify: an OpenCode chip stays unanchorable (`''`), and
    // the shared alias table makes `agy-cli` the same Antigravity subscription.
    function resetKindOfName(name) {
      var s = String(name || '').toLowerCase()
      for (var i = 0; i < RESET_KINDS.length; i++) {
        if (SUBSCRIPTIONS[RESET_KINDS[i]].alias.test(s)) return RESET_KINDS[i]
      }
      return ''
    }
    var RESET_ACK_KEY = 'statusline-plus:reset-ack'
    // One reset event is one notice, even while AIHOT refines it from announced
    // to confirmed: the subscription and event id identify it. The drawer and
    // "Got it" follow the event, so a confirmation never slides out again.
    function resetNoticeKey(notice) { return notice.kind + '|' + notice.id }
    var resetAckMemory = []
    function resetAcks() {
      try {
        var list = JSON.parse(window.localStorage.getItem(RESET_ACK_KEY) || '[]')
        return Array.isArray(list) ? list.filter(function (item) { return typeof item === 'string' }) : []
      } catch (e) { return resetAckMemory }
    }
    function ackResetNotice(notice) {
      var key = resetNoticeKey(notice)
      resetAckMemory = resetAcks().filter(function (item) { return item !== key }).concat([key]).slice(-64)
      try { window.localStorage.setItem(RESET_ACK_KEY, JSON.stringify(resetAckMemory)) } catch (e) { /* memory only */ }
    }
    // Unacknowledged notices slide out once per page, never on every poll or
    // session switch. The open drawer belongs to the session view it slid out
    // of, so leaving that view closes it.
    var resetShownThisPage = {}
    var resetViewSession = null
    var resetViewRevision = 0
    var resetViewListeners = []
    // The Host names a session bare or `session-` prefixed; both are one view.
    function resetViewKey(sessionId) {
      return sessionId ? String(sessionId).replace(/^session-/, '') : ''
    }
    function notifyResetView() {
      resetViewRevision++
      resetViewListeners.slice().forEach(function (fn) { fn(resetViewRevision) })
    }
    function enterResetView(sessionId) {
      var key = resetViewKey(sessionId)
      if (!key || key === resetViewSession) return
      var first = resetViewSession === null
      resetViewSession = key
      // The first session on the page is not a switch: a drawer that slid out
      // before the header mounted must stay.
      if (first) return
      notifyResetView()
    }
    function leaveResetView(sessionId) {
      var key = resetViewKey(sessionId)
      if (!key || key !== resetViewSession) return
      resetViewSession = null
      notifyResetView()
    }
    function useResetViewRevision() {
      var pair = React.useState(resetViewRevision)
      React.useEffect(function () {
        var listener = pair[1]
        resetViewListeners.push(listener)
        return function () { resetViewListeners = resetViewListeners.filter(function (fn) { return fn !== listener }) }
      }, [])
      return pair[0]
    }

    // The one shared list. The Host already filtered it to the 24 h windows.
    // The signature is the content, not just the event key: an announcement keeps
    // its id while AIHOT refines its time or scope.
    var resetStore = { notices: [], signature: '', listeners: [] }
    function publishResetNotices(list) {
      var signature = JSON.stringify(list)
      if (signature === resetStore.signature) return
      resetStore.notices = list
      resetStore.signature = signature
      resetStore.listeners.slice().forEach(function (fn) { fn(list) })
    }
    function useResetNotices() {
      var pair = React.useState(resetStore.notices)
      React.useEffect(function () {
        var listener = pair[1]
        resetStore.listeners.push(listener)
        listener(resetStore.notices)
        return function () { resetStore.listeners = resetStore.listeners.filter(function (fn) { return fn !== listener }) }
      }, [])
      return pair[0]
    }

    // Models the header has resolved in this page, so auto mode works even
    // where the Host's model catalog is unreachable.
    var resetModelKinds = {}
    // Set by the polling host: a subscription found only now is asked about now,
    // not at the next 10-minute poll.
    var resetPollNow = null
    function noteResetModel(model) {
      var kind = primarySubscriptionKind(model)
      if (!kind || RESET_AUTO_KINDS.indexOf(kind) === -1 || resetModelKinds[kind]) return
      resetModelKinds[kind] = true
      if (resetPollNow) setTimeout(resetPollNow, 0)
    }
    // The Host's catalog is the model list the picker shows, read through its
    // public remote API and kept for one poll interval.
    var resetCatalog = { kinds: null, loadedAt: 0, inflight: null }
    function remoteSessionApi() {
      try {
        var direct = CTX && typeof CTX.get === 'function' ? CTX.get('remote.session') : null
        if (direct && typeof direct.modelCatalog === 'function') return direct
      } catch (e) { /* not provided */ }
      try {
        var remote = CTX && typeof CTX.get === 'function' ? CTX.get('remote') : null
        if (remote && remote.session && typeof remote.session.modelCatalog === 'function') return remote.session
      } catch (e) { /* not provided */ }
      return null
    }
    function catalogResetKinds() {
      if (resetCatalog.kinds && Date.now() - resetCatalog.loadedAt < RESET_POLL_MS) return Promise.resolve(resetCatalog.kinds)
      if (resetCatalog.inflight) return resetCatalog.inflight
      var api = remoteSessionApi()
      if (!api) return Promise.resolve(resetCatalog.kinds || [])
      resetCatalog.inflight = Promise.resolve().then(function () { return api.modelCatalog() }).then(function (result) {
        var value = result && result.ok === true ? result.value : result && Array.isArray(result.groups) ? result : null
        if (!value || !Array.isArray(value.groups)) return resetCatalog.kinds || []
        var found = {}
        value.groups.forEach(function (group) {
          (group && Array.isArray(group.models) ? group.models : []).forEach(function (model) {
            var kind = primarySubscriptionKind({ provider: group.id, model: model && model.id })
            if (kind) found[kind] = true
          })
        })
        resetCatalog.kinds = RESET_AUTO_KINDS.filter(function (kind) { return found[kind] })
        resetCatalog.loadedAt = Date.now()
        return resetCatalog.kinds
      }).catch(function () { return resetCatalog.kinds || [] }).then(function (kinds) {
        resetCatalog.inflight = null
        return kinds
      })
      return resetCatalog.inflight
    }
    // auto: the subscriptions found among the models, plus Grok when ticked.
    // on: exactly the ticked ones. off: none, and nothing is requested.
    function resetAlertKinds(config) {
      var mode = config && config.enabled !== false ? config.resetAlerts || 'on' : 'off'
      if (mode === 'off') return Promise.resolve([])
      var picked = Array.isArray(config.resetAlertKinds) ? config.resetAlertKinds : RESET_AUTO_KINDS
      if (mode === 'on') return Promise.resolve(RESET_KINDS.filter(function (kind) { return picked.indexOf(kind) !== -1 }))
      return catalogResetKinds().then(function (kinds) {
        return RESET_KINDS.filter(function (kind) {
          return kind === 'grok' ? picked.indexOf('grok') !== -1 : kinds.indexOf(kind) !== -1 || resetModelKinds[kind]
        })
      })
    }
    function apiResetNotices(kinds) {
      return fetch('/statusline/api/reset-notices?kinds=' + encodeURIComponent(kinds.join(',')))
        .then(function (response) { return response.json() })
        .catch(function () { return { ok: false, error: 'network' } })
    }
    // Several slots mount the host (sidebar footer, every session header); only
    // the oldest live one polls and renders, so a page shows one drawer.
    var resetHosts = [], resetHostSeq = 0, resetHostListeners = []
    function useResetLeader() {
      var idRef = React.useRef(0)
      if (!idRef.current) idRef.current = ++resetHostSeq
      var pair = React.useState(false)
      React.useEffect(function () {
        var id = idRef.current
        function sync() { pair[1](resetHosts[0] === id) }
        resetHosts.push(id)
        resetHostListeners.push(sync)
        resetHostListeners.slice().forEach(function (fn) { fn() })
        return function () {
          resetHosts = resetHosts.filter(function (item) { return item !== id })
          resetHostListeners = resetHostListeners.filter(function (fn) { return fn !== sync })
          resetHostListeners.slice().forEach(function (fn) { fn() })
        }
      }, [])
      return pair[0]
    }
    function ResetNoticeHost(props) {
      var sessionId = props && props.sessionId
      React.useEffect(function () {
        enterResetView(sessionId)
        return function () { leaveResetView(sessionId) }
      }, [sessionId])
      var config = useConfigSnapshot()
      var leader = useResetLeader()
      var active = !!(leader && config && config.enabled !== false && (config.resetAlerts || 'on') !== 'off')
      var visible = usePageVisible(active)
      var notices = useResetNotices()
      var showing = React.useState(null)
      // The drawer belongs to the session view it slid out of. A switch closes
      // it, and its notices stay marked as shown, so the new session does not
      // get the same drawer again.
      var view = useResetViewRevision()
      var viewRef = React.useRef(view)
      React.useEffect(function () {
        if (view === viewRef.current) return
        viewRef.current = view
        showing[1](null)
      }, [view])
      var configRef = React.useRef(config)
      configRef.current = config
      var modeKey = config ? [config.resetAlerts || 'on', (config.resetAlertKinds || []).join(',')].join('|') : ''
      React.useEffect(function () {
        if (!leader) return undefined
        if (!active) { publishResetNotices([]); return undefined }
        if (!visible) return undefined
        var alive = true, timer = 0
        // Ask again just after the Host's own next read of the feed, so a
        // change shows within one interval rather than two stacked ones.
        function schedule(result) {
          var data = result && result.ok === true ? result.data : null
          var wait = data && typeof data.nextCheckAt === 'number' && typeof result.serverNow === 'number'
            ? data.nextCheckAt - result.serverNow + 2000 : RESET_POLL_MS
          timer = setTimeout(poll, Math.min(RESET_POLL_MS + 2000, Math.max(RESET_MIN_POLL_MS, wait)))
        }
        function poll() {
          resetAlertKinds(configRef.current).then(function (kinds) {
            if (!alive) return null
            if (!kinds.length) { publishResetNotices([]); return null }
            return apiResetNotices(kinds)
          }).then(function (result) {
            if (!alive) return
            if (result && result.ok === true && result.data && Array.isArray(result.data.notices)) {
              publishResetNotices(result.data.notices.filter(function (notice) { return notice && typeof notice.id === 'string' && SUBSCRIPTIONS[notice.kind] && SUBSCRIPTIONS[notice.kind].reset }))
            }
            schedule(result)
          })
        }
        var pollNow = function () { if (alive) { clearTimeout(timer); poll() } }
        resetPollNow = pollNow
        poll()
        return function () {
          alive = false
          clearTimeout(timer)
          if (resetPollNow === pollNow) resetPollNow = null
        }
      }, [leader, active, visible, modeKey])
      // The next drawer: every notice not acknowledged and not yet shown on this
      // page, together in one drawer (one line each, one "Got it"), once a
      // header chip can carry it. Until then it waits for chips to announce
      // themselves; the details panels list the notices meanwhile.
      var anchors = useResetAnchorRevision()
      var pageReady = useResetPageReady()
      React.useEffect(function () {
        if (!active || !visible || !pageReady || showing[0]) return
        var acks = resetAcks()
        var pending = notices.filter(function (notice) {
          var key = resetNoticeKey(notice)
          return !resetShownThisPage[key] && acks.indexOf(key) === -1
        })
        if (!pending.length || !resetAnchor(resetKindsOf(pending))) return
        pending.forEach(function (notice) { resetShownThisPage[resetNoticeKey(notice)] = true })
        showing[1](pending)
      }, [active, visible, pageReady, notices, showing[0], anchors])
      if (!active || !showing[0]) return null
      var group = showing[0]
      return React.createElement(ResetDrawer, {
        key: group.map(resetNoticeKey).join(','), notices: group,
        seconds: typeof config.resetAlertSeconds === 'number' ? config.resetAlertSeconds : 5,
        onAck: function () { group.forEach(ackResetNotice) },
        onDone: function () { showing[1](null) },
      })
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n }
    function resetClock(ms) {
      var date = new Date(ms)
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }
    // "今天 13:35" / "明天 09:00" / "11/24 13:35", in the viewer's time zone.
    function resetDay(ms) {
      var day = new Date(ms), today = new Date()
      var diff = Math.round((new Date(day.getFullYear(), day.getMonth(), day.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000)
      if (diff === 0) return t('resetToday')
      if (diff === 1) return t('resetTomorrow')
      if (diff === -1) return t('resetYesterday')
      return (day.getMonth() + 1) + '/' + day.getDate()
    }
    function resetTime(ms) { return resetDay(ms) + ' ' + resetClock(ms) }
    // One sentence a user can read without knowing the feed: the subscription
    // in its colour, the time phrase in bold, then the action.
    // "Codex 已于今天 09:23 重置额度", "Codex 预计明天 18:00 前重置额度".
    // `brief` (the drawer) leaves the estimate note to the panel and the tooltip.
    function resetSentenceParts(notice, brief) {
      var credit = notice.type === 'reset_credit'
      var when, note = '', key
      if (notice.phase === 'confirmed') {
        when = tf('resetDoneAt', { time: resetTime(notice.at) })
        key = credit ? 'resetCreditDone' : 'resetDirectDone'
      } else {
        var w = notice.window
        key = credit ? 'resetCreditSoon' : 'resetDirectSoon'
        if (!w) when = t('resetTimeUnknown')
        else {
          var sameDay = new Date(w.from).toDateString() === new Date(w.through).toDateString()
          var range = w.from === w.through ? resetTime(w.from) : resetTime(w.from) + '–' + (sameDay ? resetClock(w.through) : resetTime(w.through))
          if (w.precision === 'estimate') { when = tf('resetEstimate', { time: range }); note = t('resetEstimateNote') }
          else if (w.precision === 'approximate') when = tf('resetAbout', { time: resetTime(w.from) })
          else if (w.precision === 'deadline') when = tf('resetBefore', { time: resetTime(w.through) })
          // A date-only promise is a Beijing calendar day.
          else if (w.precision === 'date') { var bj = new Date(w.from + 8 * 3600000); when = tf('resetOnDate', { time: (bj.getUTCMonth() + 1) + '/' + bj.getUTCDate() }) }
          else when = tf('resetAt', { time: range })
        }
      }
      return { template: t(key), name: SUBSCRIPTIONS[notice.kind] ? (SUBSCRIPTIONS[notice.kind].sentence || SUBSCRIPTIONS[notice.kind].name) : notice.kind, when: when, note: brief ? '' : note }
    }
    function resetSentence(notice, brief) {
      var parts = resetSentenceParts(notice, brief)
      return parts.template.split('{name}').join(parts.name).split('{when}').join(parts.when) + parts.note
    }
    function resetSentenceNodes(notice, brief) {
      var parts = resetSentenceParts(notice, brief), out = []
      parts.template.split(/(\{name\}|\{when\})/).forEach(function (piece, i) {
        if (piece === '{name}') out.push(React.createElement('span', { key: i, className: 'slp-reset-name', style: { color: planColor(notice.kind) } }, parts.name))
        else if (piece === '{when}') out.push(React.createElement('b', { key: i, className: 'slp-reset-time' }, parts.when))
        else if (piece) out.push(piece)
      })
      if (parts.note) out.push(parts.note)
      return out
    }
    // Every details panel: one rounded box, one flowing line per notice (own
    // subscription first), acknowledged or not. The sentence is the AIHOT link;
    // only the original post keeps a word of its own. Nothing current, no box.
    function ResetPanelSection(props) {
      var own = props.kind
      var notices = useResetNotices().slice().sort(function (a, b) { return (a.kind === own ? 0 : 1) - (b.kind === own ? 0 : 1) })
      if (!notices.length) return null
      return React.createElement('div', { className: 'slp-reset-section', role: 'group', 'aria-label': t('resetSectionTitle'), 'data-reset-section': own || 'all' },
        notices.map(function (notice) {
          var sentence = resetSentenceNodes(notice)
          return React.createElement('p', { key: resetNoticeKey(notice), className: 'slp-reset-line', 'data-notice': notice.phase, 'data-kind': notice.kind },
            React.createElement('span', { className: 'slp-reset-main' },
              notice.url
                ? React.createElement('a', { className: 'slp-reset-text slp-reset-src', href: notice.url, target: '_blank', rel: 'noopener noreferrer', title: t('resetSourceTitle') },
                    sentence, React.createElement('span', { className: 'slp-reset-arrow', 'aria-hidden': true }, ' ↗'))
                : React.createElement('span', { className: 'slp-reset-text' }, sentence),
              notice.scope ? React.createElement('span', { className: 'slp-reset-scope' }, ' · ' + notice.scope) : null),
            notice.postUrl ? React.createElement('a', { className: 'slp-reset-link', href: notice.postUrl, target: '_blank', rel: 'noopener noreferrer' }, t('resetPost')) : null)
        }))
    }
    // The chip a drawer slides out of: the notice's own subscription when it is
    // in the header (waiting while it loads), otherwise whichever subscription
    // chip the header shows, "Subscription not found" included, then the
    // DeepSeek peak chip. No chip, no drawer: the details panels still list it.
    function resetKindsOf(notices) {
      var kinds = []
      notices.forEach(function (notice) { if (kinds.indexOf(notice.kind) === -1) kinds.push(notice.kind) })
      return kinds
    }
    // `kinds`: the drawer's subscriptions; a chip of any of them is its own.
    function resetAnchor(kinds) {
      var nodes = document.querySelectorAll('[data-slp-reset-kind]')
      var own = null, other = null, last = null
      for (var i = 0; i < nodes.length; i++) {
        var rect = nodes[i].getBoundingClientRect()
        if (!(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight / 2)) continue
        var ready = nodes[i].getAttribute('data-slp-quota-ready') === 'true'
        if (kinds.indexOf(nodes[i].getAttribute('data-slp-reset-kind')) !== -1) { if (!own || ready) own = nodes[i] }
        else if (ready && nodes[i].hasAttribute('data-slp-reset-last')) last = last || nodes[i]
        else if (ready && !other) other = nodes[i]
      }
      if (own) return own.getAttribute('data-slp-quota-ready') === 'true' ? own : null
      return other || last
    }
    // A drawer, not a floating card: a clipped frame sits on the chip's bottom
    // edge and the sheet slides down out of it. Never shown without a chip.
    function ResetDrawer(props) {
      useLocaleRevision()
      var notices = props.notices
      var kinds = resetKindsOf(notices)
      var kindsKey = kinds.join(',')
      var noticesKey = notices.map(function (notice) { return resetNoticeKey(notice) + ':' + notice.phase }).join(',')
      var phase = React.useState('in')
      var place = React.useState(null)
      var paused = React.useRef(false)
      var remaining = React.useRef(Math.max(3, props.seconds) * 1000)
      var startedAt = React.useRef(0)
      var timer = React.useRef(0)
      var boxRef = React.useRef(null)
      var watch = React.useRef(null)
      var onDone = props.onDone
      // Placement follows events, not frames: the chip resizing, its header
      // reflowing, the window resizing, scrolling, or a chip coming or going.
      // The frame has 6px side padding for the shadow. The sheet starts at the
      // chip's left edge, is at least as wide as the chip and at most
      // RESET_STRETCH times it (within the window). If the chip leaves the
      // header (a faded "not found"), the drawer moves to another or collapses.
      var anchors = useResetAnchorRevision()
      React.useLayoutEffect(function () {
        var anchor = null, observer = null
        function measure() {
          if (!anchor || !anchor.isConnected) anchor = resetAnchor(kinds)
          var rect = anchor ? anchor.getBoundingClientRect() : null
          if (!rect || !(rect.width > 0)) { leave(); return }
          var width = Math.round(rect.width), room = (document.documentElement.clientWidth || window.innerWidth) - Math.round(rect.left) - 8
          var next = { top: rect.bottom + 2, left: Math.round(rect.left) - 6, width: width, cap: Math.max(width, Math.floor(Math.min(width * RESET_STRETCH, room))) }
          place[1](function (current) {
            return current && current.top === next.top && current.left === next.left && current.width === next.width && current.cap === next.cap ? current : next
          })
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          if (anchor) { observer.observe(anchor); if (anchor.parentElement) observer.observe(anchor.parentElement) }
        }
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return function () {
          if (observer) observer.disconnect()
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [kindsKey, anchors])
      // One line when the sentence and "Got it" fit in the cap. Otherwise only
      // the button moves to a second line; the sentence wraps only when it
      // alone is wider than the cap. A wrapped sheet would keep the full cap
      // width, so it is shrunk to its widest line.
      var where = place[0]
      React.useLayoutEffect(function () {
        var box = boxRef.current, sheet = box && box.querySelector('.slp-reset-sheet')
        if (!sheet || !where) return
        sheet.style.width = ''
        var texts = sheet.querySelectorAll('.slp-reset-text'), ack = sheet.querySelector('.slp-reset-ack')
        var last = texts[texts.length - 1]
        if (!last || !ack || ack.getBoundingClientRect().top < last.getBoundingClientRect().bottom - 4) return
        // The text's own line boxes, not the paragraph (which spans the float).
        var left = sheet.getBoundingClientRect().left, right = 0, range = document.createRange()
        for (var n = 0; n < texts.length; n++) {
          range.selectNodeContents(texts[n])
          var rects = range.getClientRects()
          for (var i = 0; i < rects.length; i++) right = Math.max(right, rects[i].right)
        }
        var pad = parseFloat(getComputedStyle(sheet).paddingRight) || 0
        sheet.style.width = Math.max(where.width, Math.ceil(right - left + pad)) + 'px'
      }, [where, noticesKey, currentLang()])
      function unwatch() {
        if (!watch.current) return
        document.removeEventListener('pointermove', watch.current, true)
        window.removeEventListener('blur', watch.current)
        watch.current = null
      }
      var left = React.useRef(false)
      function leave() {
        if (left.current) return
        left.current = true
        clearTimeout(timer.current)
        unwatch()
        phase[1]('out')
        // Unmounted when the exit animation ends, not by a timer started before
        // it: a timer can remove the sheet a frame or two early, which reads as
        // a jump. The timer only backs up a missed animationend.
        timer.current = setTimeout(onDone, reducedMotion() ? 0 : RESET_LEAVE_MS + 120)
      }
      function exited(event) {
        if (event.animationName !== 'slp-drawer-out' || !left.current) return
        clearTimeout(timer.current)
        onDone()
      }
      function run() {
        if (left.current) return
        clearTimeout(timer.current)
        startedAt.current = Date.now()
        timer.current = setTimeout(leave, remaining.current)
      }
      React.useEffect(function () {
        run()
        return function () { clearTimeout(timer.current); unwatch() }
      }, [])
      // Reading pauses the countdown; leaving resumes it with what was left.
      // pointerleave alone is not enough: it never fires when the pointer leaves
      // the window, or when the drawer moves from under a still pointer. While
      // paused, a move outside it or the window losing focus resumes it too.
      function pause() {
        if (paused.current || phase[0] === 'out') return
        paused.current = true
        clearTimeout(timer.current)
        remaining.current = Math.max(1500, remaining.current - (Date.now() - startedAt.current))
        watch.current = function (event) {
          var box = boxRef.current
          if (event.type === 'blur' || !box || !box.contains(event.target)) resume(event)
        }
        document.addEventListener('pointermove', watch.current, true)
        window.addEventListener('blur', watch.current)
      }
      function resume(event) {
        if (!paused.current || phase[0] === 'out') return
        if (event && event.type === 'blur' && event.target !== window && boxRef.current && boxRef.current.contains(event.relatedTarget)) return
        // Keyboard focus inside holds the drawer until it moves out.
        if (event && event.type === 'pointermove' && boxRef.current && boxRef.current.contains(document.activeElement)) return
        unwatch()
        paused.current = false
        run()
      }
      var style = where ? { top: where.top + 'px', left: where.left + 'px', width: (where.cap + 12) + 'px' } : { visibility: 'hidden', top: 0, left: 0 }
      return ReactDOM.createPortal(React.createElement('div', {
        ref: boxRef, className: 'slp-reset-drawer', role: 'status', 'aria-live': 'polite',
        'data-phase': phase[0], 'data-kind': kindsKey, 'data-count': notices.length, 'data-notice-id': notices.map(function (notice) { return notice.id }).join(','),
        style: style, onPointerEnter: pause, onPointerLeave: resume, onFocus: pause, onBlur: resume, onAnimationEnd: exited,
      },
        // The Host's menu material: the same translucent fill, blur and edge as
        // the details panel, in both themes.
        React.createElement('div', { className: 'slp-reset-sheet', 'data-menu-material': 'translucent', style: where ? { minWidth: where.width + 'px' } : undefined },
          // One line per notice, then one "Got it" for all of them, floating
          // right on the last line when there is room (see the width effect).
          React.createElement('p', { className: 'slp-reset-line slp-reset-row' },
            notices.map(function (notice, index) {
              var title = [resetSentence(notice), notice.scope, notice.url ? t('resetSourceTitle') : ''].filter(Boolean).join(' · ')
              // The sentence is the source link: no separate "AIHOT" word to wrap.
              return [index ? React.createElement('br', { key: 'br' + index }) : null,
                notice.url
                  ? React.createElement('a', { key: resetNoticeKey(notice), className: 'slp-reset-text slp-reset-src', href: notice.url, target: '_blank', rel: 'noopener noreferrer', title: title, 'data-notice': notice.phase },
                      resetSentenceNodes(notice, true), React.createElement('span', { className: 'slp-reset-arrow', 'aria-hidden': true }, '\u00a0↗'))
                  : React.createElement('span', { key: resetNoticeKey(notice), className: 'slp-reset-text', title: title, 'data-notice': notice.phase }, resetSentenceNodes(notice, true))]
            }),
            React.createElement('button', { type: 'button', className: 'slp-reset-ack', title: t('resetAckHint'),
              onClick: function () { props.onAck(); leave() } }, t('resetAck'))))), document.body)
    }

    // ---------------- 设置页（settings.section） ----------------
    var CRED_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
    // Reset clears preferences only. Credential references, account files, the
    // repository override and source cards stay, so quotas keep working.
    var RESET_KEYS = ['enabled', 'hideBottomOnNarrow', 'cacheTtlMs', 'fetchTimeoutMs', 'showQuota', 'modelQuotaBar', 'modelQuotaRows', 'quotaAuto', 'quotaShowAll', 'quotaOnStep', 'quotaPercentMode', 'quotaSources',
      'codexQuotaOnTurn', 'antigravityQuotaOnTurn', 'resetAlerts', 'resetAlertKinds', 'resetAlertSeconds', 'showDeepseekPeak', 'deepseekPeakCountdown', 'showPeakDot', 'showRestartButton',
      'showGit', 'showCwd', 'showContext', 'showTps', 'showCost', 'showActivity', 'showTools', 'componentOrder', 'hiddenComponents']
    // Unset (not set): the Host schema supplies defaults, so none are duplicated here.
    function apiResetConfig(keys) {
      return mutateSettings(keys.map(function (key) { return { op: 'unset', path: [key] } }))
    }
    // The update check runs on the Host: it reads the registry at most once a
    // minute and knows which profile the running copy belongs to.
    function apiVersion(force, signal) {
      return fetch('/statusline/api/version' + (force ? '?force=1' : ''), { signal: signal })
        .then(function (response) { return response.json() })
        .catch(function (error) {
          return { ok: false, error: error && error.name === 'AbortError' ? 'aborted' : 'network' }
        })
    }
    function apiApplyUpdate(version) {
      return fetch('/statusline/api/version', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: version }),
      }).then(function (response) { return response.json() })
        .catch(function () { return { ok: false, error: 'network' } })
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
    // The form state, debounced save, two-step reset and OpenCode test. The page
    // below only lays the form out; these lifetimes stay in one place.
    function useSettingsForm(config) {
      var [form, setForm] = React.useState(null)
      var [msg, setMsg] = React.useState(null)
      var [saveState, setSaveState] = React.useState({ kind: 'idle' })
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
            var w = r2.ok && r2.data && Array.isArray(r2.data.windows) && r2.data.windows
            if (!w) { setMsg({ kind: 'err', text: (r2.ok ? '' : r2.error) || t('testFail') }); return }
            var pct = function (id) { var win = w.find(function (item) { return item.id === id }); return win ? win.usedPercent : '—' }
            setMsg({ kind: 'ok', text: tf('testOk', { r: pct('rolling'), w: pct('weekly'), m: pct('monthly') }) })
          })
        })
      }
      return { form: form, up: up, reset: reset, resetArmed: resetArmed, saveState: saveState, msg: msg, test: test }
    }

    // One registry read per settings visit, one install at a time, and the
    // swap/restart follow-up. The page only renders the button this returns.
    function useUpdateInstall({ canRestart, restartCaps }) {
      var [update, setUpdate] = React.useState({ kind: 'idle' })
      var [version, setVersion] = React.useState(null)
      var updateArmTimer = React.useRef(null)
      var alive = React.useRef(true)
      React.useEffect(function () {
        var listening = true
        apiVersion(false).then(function (result) {
          if (!listening || !result || result.ok !== true || !result.data) return
          var data = result.data
          var running = typeof data.loaded === 'string' ? data.loaded : typeof data.installed === 'string' ? data.installed : null
          if (running) setVersion(running)
          if (data.install && data.install.linked) return
          if (!data.error && data.updateAvailable === true && data.compatible !== false) {
            setUpdate({ kind: 'available', installed: data.installed, latest: data.latest, instanceId: data.instanceId })
          } else if (data.restartRequired === true) {
            setUpdate({ kind: 'done', installed: data.loaded, latest: data.installed })
          } else if (!data.error && data.updateAvailable === true) {
            setUpdate({ kind: 'incompatible', installed: data.installed, latest: data.latest, engines: data.latestEngines, host: data.host })
          }
        })
        return function () { listening = false }
      }, [])
      React.useEffect(function () {
        alive.current = true
        return function () {
          alive.current = false
          if (updateArmTimer.current) { clearTimeout(updateArmTimer.current); updateArmTimer.current = null }
        }
      }, [])
      function onUpdateClick(event) {
        if (update.kind === 'hot' || update.kind === 'pending') { window.location.reload(); return }
        // An install waiting for the next start can take it now, where the Host can restart.
        if (update.kind === 'done' && canRestart) { openRestartDialog(event.currentTarget, restartCaps); return }
        if (update.kind === 'error') { setUpdate(Object.assign({}, update, { kind: 'available' })); return }
        if (update.kind !== 'available') return
        var target = update.latest
        var bootId = update.instanceId
        setUpdate({ kind: 'applying', installed: update.installed, latest: target })
        apiApplyUpdate(target).then(function (result) {
          if (!alive.current) return
          if (!result || result.ok !== true) {
            setUpdate({ kind: 'error', installed: update.installed, latest: target,
              output: (result && (result.output || (result.error === 'no-package-manager' ? t('setUpdateNoManager') : result.error))) || 'install-failed' })
            return
          }
          setUpdate({ kind: 'verifying', installed: update.installed, latest: target })
          if (!bootId) { setUpdate({ kind: 'pending', installed: update.installed, latest: target }); return }
          waitForSwap(bootId, target, update.installed)
        })
      }
      function waitForSwap(bootId, latest, installed) {
        var deadline = Date.now() + 8000
        function tick() {
          if (!alive.current) return
          apiVersion(false).then(function (result) {
            if (!alive.current) return
            var data = result && result.ok === true ? result.data : null
            if (data && data.instanceId && data.instanceId !== bootId) {
              setVersion(latest)
              setUpdate({ kind: 'hot', installed: installed, latest: latest })
              return
            }
            if (data && data.hotFailed) { setUpdate({ kind: 'done', installed: installed, latest: latest }); return }
            if (Date.now() >= deadline) { setUpdate({ kind: 'pending', installed: installed, latest: latest }); return }
            updateArmTimer.current = setTimeout(tick, 500)
          })
        }
        tick()
      }
      function updateButton() {
        if (update.kind === 'idle') return null
        if (update.kind === 'incompatible') {
          return React.createElement('span', {
            className: 'slp-update-note',
            title: tf('setUpdateIncompatibleTitle', { 0: update.installed, 1: update.host || '?', 2: update.latest }),
          }, tf('setUpdateIncompatible', { 0: update.latest, 1: update.engines }))
        }
        var busy = update.kind === 'applying' || update.kind === 'verifying'
        var labels = { applying: 'setUpdateApplying', verifying: 'setUpdateApplying', hot: 'setUpdateApplied', pending: 'setUpdatePending', error: 'setUpdateFailed' }
        var label = labels[update.kind] ? t(labels[update.kind])
          : update.kind === 'done' ? t(canRestart ? 'setUpdateRestartNow' : 'setUpdateRestart')
            : tf('setUpdateTo', { 0: update.latest })
        var title = update.kind === 'error'
          ? (update.output || t('setUpdateFailed'))
          : tf('setUpdateTitle', { 0: update.installed, 1: update.latest })
        return React.createElement('button', {
          type: 'button', name: 'update',
          className: 'slp-btn slp-btn-sm slp-update'
            + (update.kind === 'done' ? ' slp-ok' : '')
            + (update.kind === 'error' ? ' slp-err' : ''),
          disabled: busy || (update.kind === 'done' && !canRestart),
          title: title,
          onClick: onUpdateClick,
        },
          update.kind === 'available' ? React.createElement('span', { className: 'slp-update-dot', 'aria-hidden': true }) : null,
          label)
      }
      return { updateButton: updateButton, version: version }
    }

    // One line per problem, in Settings, where someone can act on it. Nothing is
    // shown when the two halves agree and every surface mounted.
    function HealthBanner() {
      var state = useHealth()
      var mismatch = state.wire !== null && state.wire !== undefined && state.wire !== WIRE_EXPECTED
      if (!mismatch && !state.faults.length) return null
      var lines = []
      if (mismatch) lines.push({ key: 'wire', text: tf('healthWire', { host: String(state.wire), client: String(WIRE_EXPECTED) }) })
      state.faults.forEach(function (fault) { lines.push({ key: fault.key + fault.at, text: tf('healthFault', { slot: fault.key, message: fault.message }) }) })
      return React.createElement('div', { className: 'slp-health', role: 'status', 'aria-live': 'polite' },
        React.createElement('strong', null, t('healthTitle')),
        React.createElement('ul', null, lines.map(function (line) { return React.createElement('li', { key: line.key }, line.text) })))
    }
    function SettingsPage() {
      useLocaleRevision()
      var config = useConfigSnapshot()
      var { form, up, reset, resetArmed, saveState, msg, test } = useSettingsForm(config)
      var [sourceOpen, setSourceOpen] = React.useState({})
      // Per-provider result of a "fill from DSH" lookup, keyed by provider id.
      var [fillNotes, setFillNotes] = React.useState({})
      var restartCaps = useRestartCaps(!!(config && config.enabled !== false && config.showRestartButton !== false))
      var updateInstall = useUpdateInstall({ canRestart: !!(restartCaps && restartCaps.full), restartCaps: restartCaps })
      var updateButton = updateInstall.updateButton, version = updateInstall.version
      if (form === null) return React.createElement('div', { className: 'slp-skel', 'aria-busy': 'true' },
        React.createElement('span', { className: 'slp-sr' }, t('setLoading')),
        React.createElement('div', { className: 'slp-skel-row', style: { width: '100%' } }),
        React.createElement('div', { className: 'slp-skel-row', style: { width: '72%' } }),
        React.createElement('div', { className: 'slp-skel-row', style: { width: '88%' } }))
      var percentMode = form.quotaPercentMode === 'left' ? 'left' : 'used'
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
      // One segmented control: data attribute, label, current value, options, setter.
      function segmented(attr, labelKey, current, options, onPick) {
        return React.createElement('span', { className: 'slp-segmented slp-inline-seg', role: 'group', 'aria-label': t(labelKey) },
          options.map(function (pair) {
            var props = { type: 'button', key: pair[0] || 'none', className: 'slp-btn slp-btn-sm', 'aria-pressed': current === pair[0],
              onClick: function () { if (current !== pair[0]) onPick(pair[0]) } }
            props[attr] = pair[0] || 'none'
            return React.createElement('button', props, t(pair[1]))
          }))
      }
      // The user's pin for one subscription. None keeps the shared reading order.
      function sourcePin(id, options) {
        var pins = form.quotaSources && typeof form.quotaSources === 'object' ? form.quotaSources : {}
        var current = options.some(function (pair) { return pair[0] === pins[id] }) ? pins[id] : ''
        return React.createElement('span', { className: 'slp-check-row', key: 'source-pin' },
          React.createElement('span', { className: 'slp-check-text' }, t('setQuotaSource')),
          segmented('data-source', 'setQuotaSource', current, [['', 'setQuotaSourceAuto']].concat(options), function (value) {
            var next = Object.assign({}, pins)
            if (value) next[id] = value; else delete next[id]
            up({ quotaSources: next })
          }),
          hint(t('setQuotaSourceHint')))
      }
      var PIN_TOOLS = [['magpie', 'quotaSourceMagpie'], ['cpa', 'quotaSourceCpa'], ['official', 'quotaSourceOfficial']]
      var PIN_API = [['magpie', 'quotaSourceMagpie'], ['direct', 'quotaSourceDirect']]
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
            React.createElement('span', { className: 'slp-source-title' }, name, React.createElement('span', { className: 'slp-provider-state' + (enabled === false ? '' : ' slp-source-enabled') }, ' · ' + t(enabled === false ? 'setSourceDisabled' : 'setSourceEnabled'))),
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
        var cardKey = p.id || String(idx)
        var note = fillNotes[cardKey] || null
        function noteFill(ok, text) {
          var next = {}
          Object.keys(fillNotes).forEach(function (key) { next[key] = fillNotes[key] })
          next[cardKey] = { ok: ok, text: text }
          setFillNotes(next)
        }
        // What DSH already knows, filled into this form. It reads the Host's own
        // settings for the route; nothing is written back to the profile.
        function fillFromDsh() {
          var match = p.match || {}
          var route = (Array.isArray(match.providerExact) && match.providerExact[0]) || p.id || ''
          if (!route) { noteFill(false, t('setFillFromDshNone')); return }
          noteFill(true, t('setFillFromDshWait'))
          fetch('/statusline/api/provider-defaults', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: route }),
          }).then(function (response) { return response.json() }).then(function (body) {
            if (!body || !body.ok || !body.data) { noteFill(false, t('setFillFromDshNone')); return }
            var data = body.data, patch = {}
            if (data.apiKeyEnv) patch.apiKeyEnv = data.apiKeyEnv
            if (data.baseURL && !p.usageUrl) patch.usageUrl = data.baseURL
            if (!Object.keys(patch).length) { noteFill(false, t('setFillFromDshNone')); return }
            patchProvider(patch)
            noteFill(true, tf('setFillFromDshDone', { v: data.apiKeyEnv || data.baseURL || '' }))
          }).catch(function () { noteFill(false, t('setFillFromDshNone')) })
        }
        return account(p.id || String(idx), p.label || p.id, [
          React.createElement('p', { className: 'slp-set-desc', key: 'kind' }, t(p.style === 'windows' ? 'setSubscriptionSource' : 'setBalanceSource')),
          p.id === 'deepseek' ? React.createElement('p', { className: 'slp-set-desc', key: 'account' }, t('setDeepseekAccountNote')) : null,
          p.style === 'windows' ? sourcePin(p.id, PIN_API) : null,
          credentialField('cred:' + (p.id || idx), p.apiKeyEnv, p.apiKeyEnv || 'API_KEY_REFERENCE',
            function (value) { patchProvider({ apiKeyEnv: value }) }),
          React.createElement('div', { className: 'slp-btns', key: 'fill' },
            React.createElement('button', { type: 'button', name: 'fillFromDsh', className: 'slp-btn slp-btn-sm',
              title: t('setFillFromDshHint'), onClick: fillFromDsh }, t('setFillFromDsh')),
            note ? React.createElement('span', { className: 'slp-msg ' + (note.ok ? 'slp-ok' : 'slp-err'), role: 'status' }, note.text) : null),
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
      // Reset notices: one row with Auto / On / Off; On lists the subscriptions.
      function resetAlertSetting() {
        var mode = form.resetAlerts === 'on' || form.resetAlerts === 'off' ? form.resetAlerts : 'on'
        var kinds = Array.isArray(form.resetAlertKinds) ? form.resetAlertKinds : RESET_AUTO_KINDS
        // auto detects the first three from models; only Grok is a choice there.
        var listed = mode === 'on' ? RESET_KINDS : mode === 'auto' ? ['grok'] : []
        var seconds = typeof form.resetAlertSeconds === 'number' ? form.resetAlertSeconds : 5
        var row = React.createElement('span', { className: 'slp-check-row', key: 'reset-mode' },
          React.createElement('span', { className: 'slp-check-text' }, t('setResetAlerts')),
          segmented('data-reset-mode', 'setResetAlerts', mode, [['auto', 'setResetAlertsAuto'], ['on', 'setResetAlertsOn'], ['off', 'setResetAlertsOff']], function (value) {
            up({ resetAlerts: value })
          }),
          hint(t('setResetAlertsHint')))
        var children = [
          listed.length ? React.createElement('span', { className: 'slp-reset-kinds', key: 'kinds' }, listed.map(function (kind) {
            var box = React.createElement('label', { className: 'slp-check', key: kind },
              React.createElement('input', { type: 'checkbox', name: 'resetAlertKind:' + kind, checked: kinds.indexOf(kind) !== -1,
                onChange: function (event) {
                  var on = event.target.checked
                  up({ resetAlertKinds: RESET_KINDS.filter(function (item) { return item === kind ? on : kinds.indexOf(item) !== -1 }) })
                } }),
              React.createElement('span', { className: 'slp-check-text' }, SUBSCRIPTIONS[kind].name))
            // Grok: reset notices only, never detected from models, no quota read.
            return kind === 'grok' ? React.createElement('span', { className: 'slp-check-row', key: kind }, box, hint(t('setResetGrokHint'))) : box
          })) : null,
          React.createElement('label', { className: 'slp-field', key: 'reset-seconds' },
            React.createElement('span', { className: 'slp-field-label' }, t('setResetAlertSeconds')),
            React.createElement('input', { className: 'slp-input slp-input-num', type: 'number', name: 'resetAlertSeconds', min: 3, max: 60, step: 1,
              inputMode: 'numeric', key: 'reset-seconds:' + seconds, defaultValue: String(seconds),
              onBlur: function (event) {
                var next = parseSeconds(event.target.value, 3, 60)
                event.target.value = String(next === null ? seconds : next)
                if (next !== null && next !== seconds) up({ resetAlertSeconds: next })
              },
              onKeyDown: function (event) { if (event.key === 'Enter') event.currentTarget.blur() } })),
        ]
        return React.createElement('div', { className: 'slp-setting-branch', key: 'reset-alerts' }, row,
          React.createElement('fieldset', { className: 'slp-dependent slp-setting-children', disabled: mode === 'off' }, children))
      }
      var saveText = saveState.kind === 'saving' ? t('setAutoSaving')
        : saveState.kind === 'ok' ? tf('setAutoSavedAt', { time: saveState.at })
          : saveState.kind === 'reset' ? tf('setResetDone', { time: saveState.at }) : t(saveState.kind === 'err' ? 'setAutoSaveFail' : 'setAutoSaveHint')
      return React.createElement('div', { className: 'slp-set' },
        React.createElement('div', { className: 'slp-set-head' },
          React.createElement('div', { className: 'slp-set-heading' },
            React.createElement('p', { className: 'slp-set-title' }, t('setTitle')),
            version ? React.createElement('span', { className: 'slp-version', title: 'Statusline Plus v' + version, role: 'status' }, 'v' + version) : null),
          React.createElement('span', { className: 'slp-set-actions' },
            updateButton(),
            React.createElement('span', { className: 'slp-save-state' + (saveState.kind === 'err' ? ' slp-err' : saveState.kind === 'ok' ? ' slp-ok' : ''), role: 'status', title: saveState.error || undefined }, saveText),
            React.createElement('button', { type: 'button', name: 'reset', className: 'slp-btn slp-btn-sm' + (resetArmed ? ' slp-btn-danger' : ''),
              title: t('setResetHint'), onClick: reset }, t(resetArmed ? 'setResetConfirm' : 'setReset')))),
        React.createElement('p', { className: 'slp-set-desc' }, t('setDesc')),
        React.createElement(HealthBanner, null),
        React.createElement('div', { className: 'slp-master' }, check('enabled', 'setEnabled', true, t('setEnabledHint'))),
        React.createElement('fieldset', { className: 'slp-dependent', disabled: form.enabled === false },
          section('setGroupDisplay', React.createElement('div', null,
            check('hideBottomOnNarrow', 'setHideBottomOnNarrow', false, t('setHideBottomOnNarrowHint')),
            React.createElement(LayoutEditor, { config: form, onChange: up }))),
          section('setGroupHeader', React.createElement('div', { className: 'slp-settings-grid' },
            branch(check('showQuota', 'setShowQuota', true), [
              check('quotaAuto', 'setQuotaAuto', true, t('setQuotaAutoHint')),
              check('quotaShowAll', 'setQuotaShowAll', false, t('setQuotaShowAllHint')),
              check('modelQuotaBar', 'setModelQuotaBar', true, t('setModelQuotaBarHint')),
              check('modelQuotaRows', 'setModelQuotaRows', true, t('setModelQuotaRowsHint')),
              React.createElement('span', { className: 'slp-check-row', key: 'step-refresh' },
                React.createElement('label', { className: 'slp-check' },
                  React.createElement('input', { type: 'checkbox', name: 'quotaOnStep', checked: quotaRefreshOnStep(form),
                    onChange: function (event) { up({ quotaOnStep: event.target.checked }) } }),
                  React.createElement('span', { className: 'slp-check-text' }, t('setQuotaOnStep'))),
                hint(t('setQuotaOnStepHint'))),
              React.createElement('span', { className: 'slp-check-row', key: 'percent-mode' },
                React.createElement('span', { className: 'slp-check-text' }, t('setPercentMode')),
                segmented('data-mode', 'setPercentMode', percentMode, [['used', 'quotaModeUsed'], ['left', 'quotaModeLeft']], function (value) {
                  up({ quotaPercentMode: value })
                }),
                hint(t('setPercentModeHint')))], form.showQuota === false),
            React.createElement('div', { className: 'slp-setting-branch', key: 'peak' },
              check('showPeakDot', 'setShowPeakDot', true),
              branch(check('showDeepseekPeak', 'setShowDeepseekPeak', true),
                check('deepseekPeakCountdown', 'setPeakCountdown', true), form.showDeepseekPeak === false)),
            resetAlertSetting())),
          section('setGroupRestart', React.createElement('div', null,
            check('showRestartButton', 'setShowRestartButton', true, t('setShowRestartButtonHint')))),
          section('setGroupWorkspace', React.createElement('fieldset', { className: 'slp-dependent', disabled: form.showGit === false }, [
            check('showCwd', 'setShowCwd', true),
            field('gitCwd', 'setGitCwd', { placeholder: t('setGitCwdPh') })])),
          section('setGroupSources', React.createElement('fieldset', { className: 'slp-dependent slp-source-list', disabled: form.showQuota === false }, [
            providerCards,
            account('codex', 'Codex', [
              sourcePin('codex', PIN_TOOLS.concat([['dsh', 'setQuotaSourceDsh']])),
              field('codexAccount', 'setCodexAccount', { placeholder: 'codex-account.json', title: t('setCodexAccountHint') })], form.showCodexQuota, function (checked) { up({ showCodexQuota: checked }) }),
            account('claude', 'Claude', [
              React.createElement('p', { className: 'slp-set-desc', key: 'kind' }, t('setSubscriptionPinOnly')),
              sourcePin('claude', PIN_TOOLS)], form.showClaudeQuota, function (checked) { up({ showClaudeQuota: checked }) }),
            account('antigravity', 'Antigravity', [
              sourcePin('antigravity', PIN_TOOLS),
              field('antigravityAccount', 'setAntigravityAccount', { placeholder: t('setAntigravityAccountHint') })], form.showAntigravityQuota, function (checked) { up({ showAntigravityQuota: checked }) }),
            account('opencode', 'OpenCode', [
              sourcePin('opencode', PIN_API),
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
      // Register this plugin's dictionaries with the Host locale service when it
      // exists. The service owns language selection and the fallback chain; the
      // plugin still supplies every translation. An older Host keeps STR below.
      var locale = null
      try { locale = ctx.get('locale') } catch (e) { locale = null }
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        try {
          ctx.effect(function () { return locale.register(LOCALE_NS, STR) })
          translate = locale.bind(LOCALE_NS)
        } catch (e) { translate = null }
      }
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

      // Which contract does this process speak? A mismatch means one half of the
      // pair was not reloaded, which used to show only as surfaces quietly
      // rendering less.
      try {
        fetch('/statusline/api/wire', { headers: { accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.json() : null })
          .then(function (body) { if (body && body.ok) noteWire(body.wire) })
          .catch(function () { /* offline or an older Host: no banner */ })
      } catch (e) { /* no fetch in this Host */ }

      // The Host retires a slot entry that throws. Without this subscription the
      // only trace is a console error in a page nobody is looking at.
      if (slots && typeof slots.onEntryError === 'function') {
        ctx.effect(function () {
          var off = slots.onEntryError(function (key, registration, error) {
            var id = isOwnEntry(registration)
            if (!id) return
            var message = error && (error.message || String(error))
            noteFault(String(key), message)
            console.warn('[statusline-plus] "' + id + '" failed in ' + key + ': ' + message)
          })
          return function () { if (typeof off === 'function') off() }
        })
      }

      dockSlots = dockSlotsCapable(slots) ? slots : null
      var dockChildren = {}
      dockChildren[DOCK_ITEM_SLOT] = { kind: 'list', scope: 'session', inline: true }
      if (slots !== undefined) {
        // 输入框下方：紧凑单行优先，按组自然换行
        slots.inject('conversation.composer.dock', function () {
          return slots.register(
            Object.assign({ name: 'conversation.composer.dock', id: 'statusline-plus', order: 10, label: 'StatusLine' },
              // Other plugins' bottom-row components; see docs/extending/README.md.
              dockSlots ? { children: dockChildren } : {}),
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
                renderSlot: dockSlots && typeof props.renderSlot === 'function' ? props.renderSlot : null,
              })
            }
          )
        })
        // 会话头部标题行：紧凑额度 chip（session 作用域槽位注入 sessionId，用于按模型自动切换）
        slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            { name: 'conversation.session.header.actions', id: 'statusline-plus-chip', order: 30, label: 'Quota' },
            function (props) {
              return React.createElement(ChipFold, null, React.createElement(HeaderChip, {
                sessionId: props && props.sessionId,
                useProjection: props && typeof props.useProjection === 'function' ? props.useProjection : null,
                useSessionStatus: props && typeof props.useSessionStatus === 'function' ? props.useSessionStatus : null,
              }))
            }
          )
        })
        // 重置提醒的第二个挂载点：侧栏收起或窄屏时会话头部仍在。只渲染 portal，不占位。
        slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            { name: 'conversation.session.header.actions', id: 'statusline-plus-reset', order: 31, label: 'Reset notices' },
            function (props) { return React.createElement(ResetNoticeHost, { sessionId: props && props.sessionId }) }
          )
        })
        // 模型选择器：空会话的按钮，以及列表每一行的订阅额度细条
        slots.inject('conversation.input.model.label', function () {
          return slots.register(
            { name: 'conversation.input.model.label', id: 'statusline-plus-model-quota', order: 20, label: 'Model quota' },
            function (props) { return React.createElement(ModelQuotaLabel, props) }
          )
        })
        // 侧栏左下角：峰/谷指示点（无需打开会话）
        slots.inject('sidebar.footer.action', function () {
          return slots.register(
            { name: 'sidebar.footer.action', id: 'statusline-plus-peak', order: 1000, label: 'Peak' },
            function () { return React.createElement(PeakFooterDot, null) }
          )
        })
        // 订阅额度重置提醒：侧栏常驻挂载，无需打开会话；页面内只有一个实例轮询与显示
        slots.inject('sidebar.footer.action', function () {
          return slots.register(
            { name: 'sidebar.footer.action', id: 'statusline-plus-reset', order: 1002, label: 'Reset notices' },
            function () { return React.createElement(ResetNoticeHost, null) }
          )
        })
        // 侧栏左下角：重新加载 / 重启（宿主两者都不支持时不显示）
        slots.inject('sidebar.footer.action', function () {
          return slots.register(
            { name: 'sidebar.footer.action', id: 'statusline-plus-restart', order: 1001, label: 'Restart' },
            function () { return React.createElement(RestartFooterButton, null) }
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
          disposeRestart()
        }
      })
    }

    module.exports = { name: 'dsh-statusline-plus', inject: ['slots', 'configForms'], apply: apply }
    return module.exports
  },
})
