# Release notes

## Unreleased

- Accept DSH 0.2.1 prereleases (alpha, rc) in the declared compatibility and `dsh-home-paths` peer range. The old `>=0.2.0-rc.2 <0.3.0-0` silently excluded them under npm's prerelease rule; the range now adds `|| >=0.2.1-alpha.1 <0.3.0-0`.
- Test against DSH 0.2.1-rc.1 by default, and keep a CI run on 0.2.0-rc.2, the oldest supported version.

## 0.1.2

Each release now also carries a version-free `dsh-statusline-plus.tgz`, so `releases/latest/download/dsh-statusline-plus.tgz` always installs the newest release; versioned assets remain for pinned installs.

- Visual pass: every panel shares one shell (10px radius, hairline border, a softer two-layer shadow, 10×12px inset, 12px body and 13px titles) and a quicker ease-out entrance. Quota reset times are no longer amber; CTX keeps its green / amber / red pressure colour. Progress tracks are visible on light and dark surfaces.
- DSH 0.2.1 renders the native activity and usage pills straight into the composer dock with their own 8px inline padding, which doubled the spacing (32px) beside the shared 16px gap. The pills' inline padding is dropped while this row is present, so every item is 16px apart.
- TPS stays out of the bottom row until the session has a real reading, instead of showing `TPS —` before the native components appear.
- Cost details show the average spend per hour over the session's request span (first dispatch to latest reply, at least five minutes). Context details show how many times this session was compacted, once it has been.
- Details panels are shorter: the context estimate note moves behind an ⓘ next to the title, the tool timing note stays in the trigger tooltip only, and the cache-write row is hidden when the provider reports none. The session-metrics fold marker is bumped so checkpoints refold with the new span and compaction fields.

- Internal: the Host side is split from one 2,300-line `lib/index.js` into focused modules (settings, Git state, session log, one module per quota source, shared HTTP deadlines and route guards); dead code and duplicated helpers removed. Wire formats, settings keys and the UI are unchanged.
- Token-speed tracking returns immediately per streamed chunk when it is turned off (the default).
- `npm run check` syntax-checks every `lib/` and `scripts/` file instead of a hand-kept list.

- Antigravity: summaries that carry only the Claude/GPT group (no Gemini group, seen since 2026-10) now show its 5-hour and weekly windows in the chip, the details and account availability, instead of `Antigravity ?`. A single group reads plainly as "5 hours / this week"; the "third-party" qualifier appears only beside a Gemini group; a summary with only the weekly window no longer reads as an invalid response. A chip with no usable window says "unknown" rather than "?".
- Antigravity: account order follows the priority CPA writes as a string (`"100"`), instead of collapsing every account to priority 0.
- Click CTX for context details: occupancy bar and percentage, remaining room, and the session's uncached input / cache read / cache write / output tokens with the input cache-hit rate (from the Host's `tokenUsage` projection; hidden when the Host does not provide it).
- Give every quota chip one state: loading, fresh, stale (last good data), retrying with a live countdown and attempt number, exhausted (click to retry), or error with a short reason (auth failed, not set up, choose account). Error chips are no longer dimmed like loading chips, loading chips say "Loading quota…", and quota details state the failure and the next step.
- An expired quota cache now reads as a normal age ("Updated 2m ago"); only a failed refresh shows the warning colour and "Refresh failed".
- Long quota and tool lists scroll inside their panels with an edge fade, keeping the title and footer in place. Escape from inside a panel returns focus to its trigger; reduced-motion preferences disable panel animations and transitions.
- Give quota requests a plugin-owned HTTP connection pool with a 5-second address-attempt window, without changing Host defaults. Update quotas as soon as a query succeeds; the window does not delay refreshes. Release the pool when the plugin unloads.
- Allow Codex quota requests up to 15 seconds overall so a slower connection can still complete TLS and return usage.
- Resume exhausted quota recovery when the visible page regains focus; keep the three-retry limit and successful data, and explain network failures and exhausted retries in quota chips.
- Retry transient quota failures at most three times, with backoff and offline/online recovery. Preserve successful data while retrying; credential and invalid-response errors do not retry.
- Measure the input area's width for narrow-screen suppression, including sidebar resizes; hide only this plugin's bottom components and keep native statistics available.
- Log quota transport failures with elapsed time and allowlisted connection codes, without URLs, credentials or exception text.
- Report Host-refused settings resets as failures, preserving the accepted preferences.
- Apply the Host's Connection admission checks to all standalone plugin routes, including browser authentication and the Host/Origin fence.
- A changed or unreadable official peak-rule sentence is now a warning, not an invalidation: it no longer decides whether a message is priced, so pricing and the peak indicator stop disagreeing on that axis. Only a weekday inside a peak window in a year with no calendar stays unknown. Before this, an affected message was left unpriced while the indicator still showed a definite peak or off-peak state.
- Bump the session-metrics fold marker so checkpoints persisted under the old rule-invalidation policy refold instead of serving their old unpriced totals.
- Release the settings listener with the plugin scope, like every other listener and route, so repeated Harness reloads never leave a duplicate handler.

## 0.1.1

- Include the bundle patch in the public source checkout. The 0.1.0 tarball already contains it; use 0.1.1 for a source-tag installation.
- Check declared distribution entry files in CI before publishing.

## 0.1.0

First public release. Earlier private snapshots used a separate development version sequence.

- Account quota and balance panels for DeepSeek, Kimi, Z.ai, Codex, OpenCode, OpenRouter and Antigravity.
- Integrated DeepSeek peak/off-peak indicator and holiday calendar.
- Offline public API reference costs from the Host's model catalog, with Input/Cache/Output tokens, amounts and shares.
- Compact Subagents details with model and reasoning effort; finished/total progress, fade and expiry.
- Git state, context consumption, native tool activity and streaming speed.
- Native settings, component ordering and preview; bounded caches and visible-page timers.

Compatible manifest range: DSH `>=0.2.0-rc.2 <0.3.0-0`. Verified runtime: `0.2.0-rc.2`.
