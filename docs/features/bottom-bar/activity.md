# Subagent and tool activity

Two components showing what the session is doing now. **Subagents** lists direct child
agents with model, effort, state and elapsed time. **Tools** shows the running count, with
recent calls and durations in its panel.

## Code

| Part | Location |
| --- | --- |
| Subagents | `ActivityRow`, `childRunningKey`, `childActivityRows`, `childElapsed` in `lib/client.js` |
| Subagents, fold | `createSubagentActivityProjection` in `lib/subagent-activity.js` |
| Tools, display | `ToolActivityRow`, `toolElapsed` in `lib/client.js` |
| Tools, fold | `createToolActivityProjection` in `lib/tool-activity.js` |

Settings: `showActivity`, `showTools`.

## Subagents

The list comes from the Host's `subagentCatalog` projection, so it holds direct children
only. A child's running state comes from session status, or from the session list when
status has no answer, or from the parent's settlement fold when the child has no Session at
all (external backends such as Claude Code and Codex). With none of these it counts as
unknown (`?`).

Rows for stopped children fade after 5 s and leave the panel after 15 s, on one deadline
timer however many children exist. The `stopped/total` summary still counts them, so fading
never changes the figures. Stop times are absolute, so a hidden tab does no work and stays
correct on return.

Collapsed, the component reads only status counters. Models, efforts and timing are read
only for the rows shown (at most 12) while the panel is open, and cold sessions get
`refreshProjections` at that point. External children have no Session, so they are skipped
there: asking for one only creates a failed projection load for an id the Host cannot
resolve.

### Children without a Session

An external backend records its child in the parent catalog with `mode: "external"` and
never creates a local Session, so the session list, the status map and the child's own
projections have nothing to answer with. The Host's session list skips these ids on purpose
(`projectList`), which is why a plugin reading only those sources shows every external child
as unknown forever.

`statuslineSubagents` (`lib/subagent-activity.js`) folds the two durable edges the parent
does have: `subagent/catalog` when a child is established, and the `user/message` whose
`source.kind` is `subagent-settled` when an activation settles. A child with no settlement
record yet reads as running; the record supplies the stop time and the elapsed duration.
That is the only reading consistent with a live activation, and a settlement lost to a hard
Host stop leaves the child reading as running. Inherited fork history is excluded, and the
fold keeps at most 64 children, evicting a settled one first.

Rows for external children use the same fade and the same `stopped/total` count as local
ones, so the chip disappears once the last child settles instead of staying forever.

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

`npm run verify -- --files lib/tool-activity.js lib/subagent-activity.js --ui subagents`.
`tests/tool-activity.test.js`, `tests/subagent-activity.test.js`,
`tests/client-lifecycle.test.js`, `tests/dsh-integration.test.js`.
