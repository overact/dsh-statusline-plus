# Release notes

## Unreleased

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
