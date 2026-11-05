# Subagent and tool activity

Two components showing what the session is doing now. **Subagents** lists direct child
agents with model, effort, state and elapsed time. **Tools** shows the running count, with
recent calls and durations in its panel.

## Code

| Part | Location |
| --- | --- |
| Subagents | `ActivityRow`, `childRunningKey`, `childActivityRows`, `childElapsed` in `lib/client.js` |
| Tools, display | `ToolActivityRow`, `toolElapsed` in `lib/client.js` |
| Tools, fold | `createToolActivityProjection` in `lib/tool-activity.js` |

Settings: `showActivity`, `showTools`.

## Subagents

The list comes from the Host's `subagentCatalog` projection, so it holds direct children
only. A child's running state comes from session status, or from the session list when
status has no answer. With neither it counts as unknown (`?`).

Rows for stopped children fade after 5 s and leave the panel after 15 s, on one deadline
timer however many children exist. The `stopped/total` summary still counts them, so fading
never changes the figures. Stop times are absolute, so a hidden tab does no work and stays
correct on return.

Collapsed, the component reads only status counters. Models, efforts and timing are read
only for the rows shown (at most 12) while the panel is open, and cold sessions get
`refreshProjections` at that point.

## Tools

The fold tracks calls for this session's own events, with history capped at 64 calls and
inherited events excluded. It evicts settled calls first and sets `truncated`.

**A boundary proves that waiting ended, not that the tool succeeded.** When a step or turn
starts or ends with a call still running, the call becomes `stopped`, with its outcome
explicitly unknown. Keep `stopped` distinct from `completed` in any wording.

Each state has a reason:

- `activeCount: null` means a running call was evicted from history, so the chip shows `?`
  rather than a count that may be wrong. The next boundary clears it.
- A result with a malformed error flag reads as `unknown`, never as success.
- The browser combines the fold with live session status: when the session is not running,
  `running` rows display as `stopped` or `unknown`.
- A synthetic `TOOL_NOT_STARTED` result without a `tool/call` is not an execution.
- Durations run from the call record, so they include approval and waiting. The tooltip says
  so.

Changing the fold requires a `stateVersion` bump. See
[architecture](../../architecture.md#session-projections).

## Tests

`npm run verify -- --files lib/tool-activity.js --ui subagents`.
`tests/tool-activity.test.js`, `tests/client-lifecycle.test.js`,
`tests/dsh-integration.test.js`.
