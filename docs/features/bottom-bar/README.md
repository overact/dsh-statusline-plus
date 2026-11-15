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
- **Narrow screens.** With `hideBottomOnNarrow`, the row unmounts at an input width of
  480 px or less, which also stops its client activity. It measures the sibling
  `[data-composer-card]`, because the dock shrinks to its contents and would latch the
  row hidden. A hidden probe survives suppression so a resize can restore the row.
  Header quotas and native stats stay.
- **Hidden pages.** Components stop live work through `usePageVisible`.
- **Order.** `componentOrder` drops unknown ids and appends missing ones, so a component
  added in a new version appears for users with a saved order.
- **Text colour.** The row matches the Host's own dock stat (`ContextMeter`): plain
  text is `--dsw-alias-label-tertiary`, and a trigger turns `--dsw-alias-label-secondary`
  on hover or while its panel is open. Coloured readings (Git counts, context and cost
  colours) keep their own colours. `.slp-muted` in the row is a step fainter than
  tertiary so it still reads as muted. The settings preview uses the same colour.
- **Drag in the row.** Each live component sits in a `.slp-dock-item` named by its id;
  the settings preview has no wrappers. A press that moves under 6 px stays a click, so
  chips still open; a drag swallows the click that ends it, and Escape cancels.
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
2. Add the `show*` default to `DEFAULT_CONFIG` and the schema in `lib/config.js`, and the
   key to `RESET_KEYS`.
3. Add a preview sample and locale strings.
4. Add a page in this folder and a row in [the index](../../README.md).

## Tests

`npm run verify -- --files lib/client.js --ui responsive` covers responsive layout,
in-row dragging (`dock-drag`) and
resource cleanup. `tests/client-lifecycle.test.js` covers the component logic.
