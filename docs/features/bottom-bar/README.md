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
| Wrap markers | `useWrapMarkers` |

Settings: `componentOrder`, `hideBottomOnNarrow`, and each component's `show*` switch.

## Behavior

- **Wrapping.** All groups sit in one flex row and wrap whole. `useWrapMarkers` sets
  `data-line-start` so separators can follow the actual lines.
- **Empty groups.** A component with no real reading renders nothing rather than a
  placeholder.
- **Narrow screens.** With `hideBottomOnNarrow`, the row unmounts at an input width of
  480 px or less, which also stops its client activity. It measures the sibling
  `[data-composer-card]`, because the dock shrinks to its contents and would latch the
  row hidden. A hidden probe survives suppression so a resize can restore the row.
  Header quotas and native stats stay.
- **Hidden pages.** Components stop live work through `usePageVisible`.
- **Order.** `componentOrder` drops unknown ids and appends missing ones, so a component
  added in a new version appears for users with a saved order.
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

`npm run verify -- --files lib/client.js --ui responsive` covers responsive layout and
resource cleanup. `tests/client-lifecycle.test.js` covers the component logic.
