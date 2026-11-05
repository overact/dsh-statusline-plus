# TPS

Shows streaming output speed for the session. Off by default (`showTps`).

## Code

`TpsTracker`, `streamTps`, `estimateTextTokens` in `lib/tps.js`; the `tps` route and the
`agent/assistant-stream` and `session/event` listeners in `lib/index.js`; `useLiveTps` and
`TpsRow` in `lib/client.js`.

## How it measures

Native stream frames are transient, so the tracker listens to them rather than to session
projections. It keeps counters per attempt.

- **While streaming** the value is an estimate from text length, marked `≈`. CJK counts
  0.75 per character and other text 1/3.5. Fractional counts are intentional, because
  splitting a delta must not inflate the rate.
- **After settling** it uses the provider's `outputTokens` when reported, shown as measured.
- Text, reasoning and tool-argument deltas count. Tool names do not, because they are
  metadata and may repeat.
- A rate needs at least 500 ms of observation. High rates are never clamped.

## Rules

- **Counters only.** Generated text is never retained or logged, and logs are never polled.
- The browser receives pushes through `EventSource`, painted at most 5 times a second, with
  no polling. The tracker has a limit of 64 sessions and 64 subscribers; past that, a new
  subscriber fails with `busy`.
- With no reading, the chip stays out of the row. Between requests it shows the previous
  value, muted and labeled as held.
- `showTps` off makes the route answer 204 and resets the tracker.

## Pitfalls

- **Session ID spelling.** Native Agent IDs are `session-<uuid>`, while UI IDs may be a bare
  UUID. The client requests the native spelling, `canonicalSessionId` normalizes on the
  Host, and both spellings must keep working for older Hosts.
- **Agent replacement.** Revisions restart when an Agent is replaced. The tracker tells
  lifecycles apart through weak ownership, which retains no Agents or transcripts.
- **Compact records.** `firstStreamTokenTime` and `lastStreamUsage` read compact stream
  records in place. DSH 0.2.0's `assistant/attempt` has no top-level usage, so it comes from
  the stream's last usage chunk. Reasoning is already folded into output, so do not add it.

## Tests

`tests/tps.test.js`, `tests/statusline.test.js`, `tests/client-lifecycle.test.js`.
