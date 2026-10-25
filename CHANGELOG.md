# Release notes

## Unreleased

- Quota fetchers now read the local Magpie gateway (`GET http://127.0.0.1:3425/v1/magpie/quotas`) when it is reachable, and fall back to the CPA files otherwise. Antigravity maps Magpie's `Gemini · 5 hours / 7 days` and `Claude & GPT · 5 hours / 7 days` windows; Codex maps Magpie's `5 hours / 7 days` windows to primary/secondary. A new `quotaSource` setting (`auto` | `magpie` | `cpa`, default `auto`) pins one source for deployments that run both gateways or only CPA; an explicitly selected `codexAccount` / `antigravityAccount` keeps `auto` on CPA for that provider. `MAGPIE_GATEWAY_URL` overrides the default loopback address.
- The header quota chip now resolves the subscription from the model ID namespace first (`antigravity/...`, `codex/...`, `opencode/...`) and the provider name second. When that subscription has no usable data (`no-credential`, `auth`, `invalid-response`, `not-found`), it tries the other enabled subscription kinds before showing "Subscription not found" instead of hiding the chip. A new `quotaShowAll` switch (default off) shows every enabled subscription chip side by side for gateways where model names do not identify the subscription.

## 0.1.6

- Antigravity quota now identifies as the Antigravity Hub client when it asks Google for the subscription summary. Google keys that response on the caller's `User-Agent`: the previous bare `antigravity` identity was treated as a legacy client and returned only the Claude/GPT group, so an account that uses Gemini looked like an untouched pool frozen at 100% remaining (or 0% used). The Hub identity returns both groups, including measured Gemini five-hour and weekly windows. Each CPA account is still read independently and keeps its own priority and status.
- Kimi Code keeps the more-consumed reading when the `usages` ratio pools and the legacy `usage`/`limits` counts describe the same window. The ratio pools can lag an exhausted quota (upstream reports `used_ratio: 0` while requests already fail with 403); a pair is matched by cadence and reset time, and the higher used percentage wins instead of claiming untouched quota.

## 0.1.5

- Show the balance of DSH's signed-in DeepSeek account (`deepseek-account`) in the header. The source now matches that billing provider and reads topped-up plus granted wallets through the Host `deepseekAccount` service, so no `DEEPSEEK_API_KEY` is needed. API-key models (`deepseek`, `deepseek-official`) keep using `/user/balance`, and the two balances never share a cache entry. A signed-out account reports "DeepSeek account not signed in"; the DeepSeek peak indicator now recognises the account provider too. Older stored profiles that still list only the previous `providerExact` aliases keep working through a client-side fallback.
- Quota responses now carry the Host response time, and the browser converts `fetchedAt` into its own clock. A Host clock that is seconds or minutes ahead no longer freezes the details age at 0s until the clocks catch up; cached responses keep their real age, and an absent or absurd timestamp hides the label instead of showing "Update time unknown". Opening details no longer forces a refresh: the footer shows the last successful fetch age and ticks once per second, while the explicit Refresh button still forces a query. The same behaviour applies to every quota source.
- Gift credit in a balance chip reads `¥51.43+3.23` (no repeated currency symbol), zero gift credit is omitted, and a zero-balance currency wallet is hidden when another wallet is funded.
- Match reference prices by the model ID after gateway/provider namespaces, including Magpie's `workbuddy-ai/deepseek-v4.1-flash`. Apply the same rule to the offline DeepSeek fallback and invalidate old session checkpoints so they are repriced. Routing IDs, display names and actual account billing are unchanged; unknown model versions remain unpriced.

## 0.1.4

- Declare DSH compatibility by lower bound only: `engines.dsh` and the `@deepseek-ai/dsh-home-paths` peer are now `>=0.2.0-rc.2`. DSH skips a plugin at startup when its declared range excludes the running version, so the old `<0.3.0-0` cap would have disabled the status line on the first 0.3.0 build. DSH evaluates the range with prereleases included, so 0.2.1 and later alpha/rc builds match without the extra `||` clause.
- Tested on DSH 0.2.1-rc.2; CI still runs the suite on 0.2.0-rc.2, the oldest supported version.
- No runtime behaviour changes from v0.1.3.

## 0.1.3

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
