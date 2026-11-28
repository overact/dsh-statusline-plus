# Adding items to the bottom row from another plugin

Status Line Plus declares a child slot for its bottom status row. Another DSH Web
plugin can register a React component there. The component then sits in the row
with the built-ins: users drag it, reorder it and switch it off in Settings like any
other item. This page is written for the agent or developer building that plugin.

| | |
| --- | --- |
| Slot | `statusline-plus.dock.item` (a session-scoped, inline list) |
| Requires | Status Line Plus with this slot, on a DSH whose slots have `entriesOfSlot`, `subscribe` and `getVersion` (0.2.x). Elsewhere the slot is never declared and your item simply never shows. |
| Not available yet | Header chip and sidebar slots; data items read from a JSON file. |

## Minimal plugin

The client bundle of your plugin (its `dsh.client` entry), in the same module format
as any DSH Web plugin:

```js
window.__ModuleLoader__.load({
  id: 'my-plugin',
  factory: function (require) {
    var React = require('react')

    function BuildStatus(props) {
      // props.sessionId is the session this row belongs to.
      return React.createElement('span', { title: 'Last CI run' }, 'CI ✓')
    }

    return {
      apply: function (ctx) {
        var slots = ctx.get('slots')
        // inject waits until Status Line Plus declares the slot, so load order does not matter.
        slots.inject('statusline-plus.dock.item', function () {
          return slots.register({
            name: 'statusline-plus.dock.item',
            id: 'my-plugin.ci',  // namespaced: "<plugin>.<item>"
            order: 100,          // initial place among extensions; users can reorder
            label: 'CI status',  // shown in Settings; may be a function returning a string
          }, BuildStatus)
        })
      },
    }
  },
})
```

`register` returns a disposer. Returning it from the `inject` callback lets the Host
remove the item when your plugin unloads or hot-reloads.

## Budget

The row is shared with built-ins and other plugins, so an item declares how much of it
it may take. All three options are optional.

| Option | Type | Meaning |
| --- | --- | --- |
| `maxCells` | integer 1–48, or `0` | Width cap in character cells. Default **24**. `0` turns the cap off. A cell is one digit in the row's font. Content past the cap is clipped with a faded right edge. |
| `minColumns` | integer 0–400 | Hide the item when the row cannot give it this many cells. Default `0` (always show). |
| `detail` | string, ≤160 chars | One line of explanation, used as the item's tooltip. Trimmed. |

```js
slots.register({
  name: 'statusline-plus.dock.item',
  id: 'my-plugin.ci',
  order: 100,
  label: 'CI status',
  maxCells: 12,      // "CI ✓ main 3m" fits; anything longer is clipped
  minColumns: 24,    // on a phone-width row, leave it out instead of squeezing
  detail: 'Last CI run on this branch', // shown on hover
}, BuildStatus)
```

The row applies these, not your component: it is the only place that knows how much room
is left. `maxCells` becomes a `max-width` on your item's wrapper, `minColumns` removes
the wrapper from flow (so it takes no line and no separator), and `detail` becomes the
wrapper's `title`.

An item that declares nothing still gets the 24-cell cap. That default exists because an
unbounded item can push the whole row onto a third line; pass `maxCells: 0` if your
reading genuinely needs more and you have checked it at 320px.

A `minColumns` decision is re-measured on resize and when you change the declaration.
It is never applied to a hidden item's own width, so it cannot oscillate.

## Rules

- **Ids.** Use `<plugin>.<item>`, both parts `[a-z0-9]` followed by up to 31 of
  `[a-z0-9-]` (the item part may also use `.` and `_`). Ids without a dot are reserved
  for built-ins and are ignored with one console warning. The id is what users' saved
  order and visibility refer to, so keep it stable across versions.
- **Replacing a built-in.** Register with a built-in id (`git`, `context`, `tps`,
  `cost`, `activity`, `tools`) to stand in for that component. Yours renders in its
  place, follows its `show*` switch and its position, and Settings tags it
  "Replaced". When your registration goes away, the built-in returns.
- **Order and visibility.** A new extension appears at the end of the row. A user's
  drag saves it into `componentOrder`; switching it off adds it to
  `hiddenComponents`, which Reset clears. You do not write these settings.
- **Rendering.** Render a compact inline element of row height: plain text, or a
  `<button>` that opens your own panel. Render `null` when there is nothing to show;
  the row then skips the item and its separator. The row sets text colour (tertiary,
  secondary on hover); leave colour unset unless the value is a status colour. Keep
  within the budget above rather than expecting the row to make room afterwards.
- **Failures.** The Host guards each item. A component that throws is retired until your
  plugin registers it again: it leaves the row and Settings, and a crashed replacement
  gives the place back to the built-in. The rest of the row keeps working. A label
  function that throws shows your id instead.
- **Live work.** Poll or subscribe only while mounted, and stop when the page is
  hidden. Fetch through your own plugin's Host routes; the row gives you no network
  access of its own.

## Do not

- Do not reach into Status Line Plus internals, its CSS classes or its config.
  Only the slot name, the id rules and the props above are a contract.
- Do not run commands or read files from the browser component. Do that work in your
  plugin's Host side and read the result through a route.
- Do not register many items for one feature. One id per thing a user would want to
  move or hide on its own.

## Testing your item

Check that it appears in the row and in Settings → bottom row with the "Extension"
tag, that dragging it and switching it off survive a reload, that a long reading is
clipped by `maxCells` rather than pushing the row, that a raised `minColumns` hides it
on a narrow window, and that unloading your plugin removes it. Status Line Plus's own
coverage of the slot is the `dock-extension` check in `scripts/verify-ui.mjs`, which
exercises the budget cap and the column minimum.
