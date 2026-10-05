# Release notes

## Unreleased

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
