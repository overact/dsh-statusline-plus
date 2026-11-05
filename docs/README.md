# Project documentation

Read this before changing a feature. It maps each area to the page holding its rules,
reasons and pitfalls. Installation and the settings table for users are in the
[root README](../README.md). The code and tests decide current behavior; these pages
record what they cannot show, so correct a page in the same change when it goes stale.

## Where to read

| You are changing | Read |
| --- | --- |
| Module boundaries, routes, pools, Host compatibility | [architecture.md](architecture.md) |
| Which quota chip appears, refresh, retries, error text | [features/quota/README.md](features/quota/README.md) |
| A quota source, its endpoint, parser or reading order | [features/quota/sources.md](features/quota/sources.md) |
| DeepSeek peak status, countdown, holiday calendar | [features/peak-hours.md](features/peak-hours.md) |
| Bottom row order, wrapping, presets, preview | [features/bottom-bar/README.md](features/bottom-bar/README.md) |
| Git chip | [features/bottom-bar/git.md](features/bottom-bar/git.md) |
| Context chip | [features/bottom-bar/context.md](features/bottom-bar/context.md) |
| TPS | [features/bottom-bar/tps.md](features/bottom-bar/tps.md) |
| Cost estimate, rate cards | [features/bottom-bar/cost.md](features/bottom-bar/cost.md) |
| Subagent and tool activity | [features/bottom-bar/activity.md](features/bottom-bar/activity.md) |
| Settings page, saving, validation, reset | [features/settings.md](features/settings.md) |
| Update button and in-place install | [features/self-update.md](features/self-update.md) |
| Publishing a version | [development/releasing.md](development/releasing.md) |

## Layout

```text
docs/
|-- README.md                 This index
|-- architecture.md           How the host and browser halves fit together
|-- features/
|   |-- quota/                Header chips: behavior, then source protocols
|   |-- peak-hours.md         DeepSeek peak indicators
|   |-- bottom-bar/           Composer row: layout, then one page per component
|   |-- settings.md           Settings page
|   `-- self-update.md        Update button
|-- development/releasing.md  Release steps and checks
|-- images/                   README screenshots, written by `npm run screenshots`
`-- market/                   Market listing metadata
```

A new user-visible feature gets a page under `features/` and a row in the table above.

## Rules for every change

This plugin is a product with many users, so judge a change against all their
environments, including the ones below.

- A user may have no Magpie, CPA, official CLI, or `pnpm` on PATH. Each is optional.
- A user may be on any DSH version from `engines.dsh` onward.
- Unknown stays unknown. Show nothing or a marked unknown rather than a guessed value.
- Credentials stay on the Host, and each goes only to its own service's fixed endpoint.
- Debug and document with sample data: percentages and error codes, never tokens, full
  emails or real account data.

Choose checks with `npm run verify -- --files <paths>`; commands are in the root README's
**Development verification** section.
