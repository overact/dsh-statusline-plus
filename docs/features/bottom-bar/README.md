# Bottom status row

The row beside the composer holds six components, each with its own switch: Git, context,
TPS, cost, subagents and tools. This page covers the row itself. Each component has a page
in this folder.

## Code

| Part | Location in `lib/client.js` |
| --- | --- |
| Mount and narrow check | `StatusPanel` |
| Row, Git refresh | `LiveStatusPanel` |
| Component list and order | `COMPONENTS`, `componentOrder`, `dockComponents` |
| Presets | `layoutPreset`, `matchingPreset` |
| Settings editor | `LayoutEditor`, `LayoutPreview` |
| Drag in the live row | `useDockDrag`, `dockDropTarget`, `.slp-dock-item` |
| Wrap markers | `useWrapMarkers` |

Settings: `componentOrder`, `hideBottomOnNarrow`, and each component's `show*` switch.

## Behavior

- **Wrapping.** All groups sit in one flex row and wrap whole. `useWrapMarkers` sets
  `data-line-start` so separators can follow the actual lines.
- **Empty groups.** A component with no real reading renders nothing rather than a
  placeholder. A failure is different from having nothing to show: Git reports a repository it
  cannot read as `⎇ ?`. See [Git](git.md#errors).
- **Entry timing.** The live row waits for the same first usage sample as the Host's
  `ContextMeter`: a new session knows its context window but has no usage yet, so the row
  stays out instead of showing a lone TPS. A Host without `contextPressure` keeps the row
  ungated.
- **Narrow screens.** With `hideBottomOnNarrow`, the row unmounts at an input width of
  480 px or less, which also stops its client activity. It measures the sibling
  `[data-composer-card]`, because the dock shrinks to its contents and would latch the
  row hidden. A hidden probe survives suppression so a resize can restore the row.
  Header quotas and native stats stay.
- **Two lines, then hide.** The live row wraps at most twice. A group that would begin a
  third line gets `data-overflow="true"` and is removed from the flow, so no empty row is
  reserved. When the second line would hold only one group, a zero-height flex break moves
  the last group of line one down so both lines carry information. This budget covers this
  plugin's groups; the Host's own ContextMeter is a sibling. At ≤480px the plugin row
  reserves 76px for a direct native `<span>` so the official reading shares line one
  instead of adding a third line; the plugin does not hide host content.
- **Git on narrow screens.** At ≤480px the repository path shrinks to 5em and fades its
  right edge; branch and counts keep priority. At ≤360px the path is hidden entirely.
- **Touch targets.** On coarse pointers and ≤480px, small buttons get a 32px minimum and
  row links a 28px minimum; settings check rows are 32px tall.
- **Hidden pages.** Components stop live work through `usePageVisible`.
- **Order.** `componentOrder` drops unknown ids and appends missing built-ins, so a
  component added in a new version appears for users with a saved order. Namespaced
  extension ids (`plugin.item`) are kept even while their plugin is absent, so the place
  survives an uninstall and reinstall; `layoutOrder` appends loaded extensions not yet
  saved. The list is capped at 48 ids; when a new extension would pass it, ids of
  extensions that are not loaded give way, last saved first, so every shown item stays
  movable. Reset clears `hiddenComponents` with the other layout keys.
- **Extensions.** Other plugins register into the child slot `statusline-plus.dock.item`
  ([guide](../../extending/README.md)). `useDockExtensions` follows the slot through
  `subscribe`/`getVersion` and reads winners from `entriesOfSlot` only when the slot
  version or language changes; each item renders with `renderSlot(slot, {}, { only: id })`
  inside its `.slp-dock-item`, through a memoized `DockExtensionItem`. The row re-renders
  on every streamed step, and the Host's `renderSlot` is stable per entry and its outlet
  follows the slot itself, so other plugins' items do not re-render with it. Built-ins still render
  directly, since Git needs internal state and the preview needs samples. An extension
  registered under a built-in id replaces that built-in and uses its `show*` switch;
  others hide through `hiddenComponents`. Settings tags them "Extension" or "Replaced",
  and the preview shows a dashed label. The Host wraps the slot output in a
  `display:contents` `span[data-slot]`, so an item is hidden when that anchor is empty
  (the component rendered `null`) or holds only the `[data-slot-error]` crash marker.
  A crashed entry is retired by the Host and leaves `entriesOfSlot`, so it drops out of
  Settings and a crashed replacement gives the place back to the built-in. A label
  function runs outside the Host's entry guard, so `dockExtensionsOf` catches it and
  falls back to the id.
  On a Host without those slot methods no child slot is declared and only built-ins show.
- **Text colour.** The row matches the Host's own dock stat (`ContextMeter`): plain
  text is `--dsw-alias-label-tertiary`, and a trigger turns `--dsw-alias-label-secondary`
  on hover or while its panel is open. Coloured readings (Git counts, context and cost
  colours) keep their own colours. `.slp-muted` in the row is a step fainter than
  tertiary so it still reads as muted. The settings preview uses the same colour.
- **Drag in the row.** Each live component sits in a `.slp-dock-item` named by its id;
  the settings preview has no wrappers. A press that moves under 6 px stays a click, so
  chips still open; a drag swallows the click that ends it, and Escape cancels (the `keydown` listener exists only while a drag is live).
  While dragging, the row previews the result: the picked item, faint with a dashed
  outline, takes its new place through CSS `order` and the others slide aside
  (`previewDockOrder`, a 160 ms FLIP animation; none under reduced motion). Hit
  testing uses layout boxes (`dockLayoutBox`), not the moving ones, so a target cannot
  flip mid-slide. A translucent copy (`.slp-dock-ghost`, no pointer events, as wide as
  its content) is scaled to `DOCK_GHOST_SCALE` around the grabbed point, so that point
  stays under the pointer and nothing jumps when the drag starts; it stays within the
  row's height. Outside the row it loses every rule scoped to it, so each element takes
  its original's text longhands (`DOCK_GHOST_TEXT`); the computed `font` shorthand is
  empty once tabular figures are set, so it cannot be copied. (Moving it above-right of the pointer
  was tried and lost the sense of position.) On drop the order is written to
  `componentOrder` and shown at once; the preview's `order` styles stay until React
  renders that order, so nothing jumps. A refused write restores the saved order. The
  settings list follows through the same config. Empty items are `display:none`, and
  `useWrapMarkers` skips them; separators hide while dragging.
- **Presets** change only bottom components: `balanced`, `minimal` and `activity`. Any
  other combination reads as `custom`.

## Preview

`LayoutPreview` builds the row with the same `dockComponents` from local samples. Preview
hooks must stay local: they never acquire a session or a quota resource, so a component
needing a new projection also needs a sample there.

## Adding a component

1. Add it to `COMPONENTS` and `COMPONENT_ORDER`, and a factory to `dockComponents`.
2. Add the `show*` default to `DEFAULT_CONFIG` in `lib/config.js`; the key lists and the
   boolean schema follow from it. Add the key to `RESET_KEYS`.
3. Add a preview sample and locale strings.
4. Add a page in this folder and a row in [the index](../../README.md).

## Tests

`npm run verify -- --files lib/client.js --ui responsive` covers responsive layout,
in-row dragging (`dock-drag`), other plugins' items (`dock-extension`: render, crash,
`null`, replace, hide, drag, late and removed registrations) and
resource cleanup. `tests/client-lifecycle.test.js` covers the component logic.
