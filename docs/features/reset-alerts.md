# Subscription reset notices

Codex, Antigravity, Claude and Grok sometimes reset everyone's quota, or hand out reset cards,
outside the normal windows. Official accounts announce these on X. AIHOT
(aihot.news) collects those posts into an anonymous, read-only feed, and this plugin
turns a relevant one into a short drawer under the header quota chip, plus a box in every
details panel.

These notices are **not** the user's own rolling windows. Those reset times come from each
subscription's quota source and appear in the chip's detail panel
([quota/README.md](quota/README.md)).

## Source and thanks

All reset data comes from **AIHOT**, the Chinese AI news site at
[aihot.news](https://aihot.news). It watches the official accounts, works out each
reset's scope, time and status, and publishes the result as an open feed:

- API documentation: [aihot.news/agent?tab=api](https://aihot.news/agent?tab=api)
- Endpoints used: `https://aihot.news/api/v1/codex-resets/recent`, `antigravity-resets`,
  `claude-resets` and `grok-bot-resets`
- Each notice links to its AIHOT page (the sentence itself, ↗), and the details panel also
  links to the original post on X.

Thank you to AIHOT for collecting these announcements and keeping the feed open to
anonymous clients, with `ETag` revalidation that makes polite polling cheap. This feature
could not exist without it. Please follow its terms (below) and polling guidance.

## Code

| Part | Location |
| --- | --- |
| Feed, parser, notice rule, cache | `lib/reset-feed.js` (`ResetFeed`, `parseResetFeed`, `pickResetNotices`) |
| Route | `reset-notices` in `lib/index.js` |
| Subscriptions to ask for | `resetAlertKinds`, `catalogResetKinds`, `noteResetModel` in `lib/client.js` |
| Shared list | `resetStore`, `publishResetNotices` (compares content, so a refined time or scope under the same id updates), `useResetNotices` |
| Drawer | `ResetNoticeHost`, `ResetDrawer` (a group of notices), `resetAnchor(kinds)`, `resetKindsOf`, `ackResetNotice`, `noteResetAnchors` |
| Chip ↔ subscription | `resetKindOfName`; chips carry `data-slp-reset-kind` and `data-slp-quota-ready` |
| Details panel | `ResetPanelSection`, inserted by `quotaPanel` in every details panel |
| Wording | `resetSentenceParts` (one source), `resetSentence` (tooltip text), `resetSentenceNodes` (coloured name, bold time), `resetDay` |
| Settings | `resetAlerts`, `resetAlertKinds`, `resetAlertSeconds`; `resetAlertSetting` in `SettingsPage` |

## Feed protocol

`GET https://aihot.news/api/v1/{codex,antigravity,claude,grok-bot}-resets/recent`. There is no key
or token. The response (`schemaVersion: 1`) carries `events[]`: `id`, `type`
(`direct_reset` | `reset_credit`), `status` (`announced` | `confirmed`), `createdAt`,
`confirmedAt`, `schedule` (the official time: `precision` exact / approximate /
deadline / date / window, `from`, `through`), `estimate` (AIHOT's own window, only while
unconfirmed), `presentation.status` and `.scopeLabel`, `posts[].url` and `url`. Times are
ISO with `+08:00`.

- **Polling.** AIHOT scans about every 10 minutes and asks clients not to poll faster. The
  Host keeps one entry per subscription and refreshes it only when it is 10 minutes old,
  sending the last `ETag` as `If-None-Match`. An unchanged feed returns `304` with an
  empty body, and the cached events are reused. The cache, with its ETag, lives in
  `statusline-reset-cache.json` under the DSH home, so a restart does not download again.
  The cache keeps the feed's own events and re-parses them on read, so there is one
  format, not two.
- **Browser timing.** The route returns `nextCheckAt`, the earliest time the Host will read
  any requested feed again. The page asks just after it (2 s later, at least 1 minute,
  at most 10). A change on AIHOT therefore reaches the page within about 10 minutes. Two
  independent 10-minute timers would allow up to 20.
- **Errors.** A `429` waits for `Retry-After`, and at least 10 minutes. Other failures wait
  5 minutes. The route never fails because of the feed; it returns what it has.
- **Terms.** Per AIHOT's API page: personal, non-profit and internal use is free. External commercial products
  need written permission. Keep the client honest: a fixed User-Agent naming this
  plugin, and no retries in parallel.
- **Grok** uses the `grok-bot` feed. Only its reset notices are read: auto mode does not
  detect Grok from models, and the plugin reads no Grok quota. It is a checkbox in both
  modes and starts unticked.

## Which notices show

`pickResetNotices(events, now)`:

- a **confirmed** reset whose `confirmedAt` falls in the last 24 h;
- an **announced** reset whose window overlaps the next 24 h. The window is the official
  `schedule`, or AIHOT's `estimate` when there is none. A `deadline` counts from the
  post, because "before X" can land at any time until then. Announced events that
  `presentation.status` marks `expired_unconfirmed` or `likely_completed` are dropped;
- an announced reset with no time at all, when it was posted in the last 24 h.

Anything older never shows. Many resets go straight to `confirmed`: the post that
announces them reports them done. A rule limited to announcements would miss most
resets. The live history had 18 of 64 Codex events, 15 of 15 Antigravity and 13 of 17
Claude in that shape.

A notice's key is `id|phase`, so an announcement and its later confirmation are two notices.

| | Drawer | Details panel |
| --- | --- | --- |
| Not acknowledged | Slides out once per session view: page load, and each switch to another session | Listed in every details panel, own subscription first |
| After "Got it" | Never again (`statusline-plus:reset-ack` in `localStorage`; memory where blocked) | Still listed |
| Outside the 24 h windows | — | Gone |

Several pending notices share **one drawer**: one line per notice, in the Host's order
(upcoming first, then confirmed newest first), and one "Got it" that acknowledges all of
them. Its anchor is a chip of any of their subscriptions. A notice arriving while the
drawer is open waits for it to close, then gets a drawer of its own. One drawer per
notice in sequence was dropped: two notices took twice the time to read.

## Which subscriptions

| `resetAlerts` | Asks for |
| --- | --- |
| `auto` (default) | Codex, Antigravity and Claude when they have a model in the Host's model catalog (`remote.session.modelCatalog()`, the list the picker shows) or the header has resolved one on this page; plus Grok when ticked. A user with none makes no request to AIHOT |
| `on` | `resetAlertKinds` (default: all but Grok) |
| `off` | Nothing; the route answers `disabled` |

Kinds come from `primarySubscriptionKind`, the same mapping as the quota chip. On a Host
without the catalog API, auto falls back to the models the header has seen. A subscription
seen there for the first time is asked about at once (`resetPollNow`), not at the next poll.

## The drawer

- **Always out of a chip.** The drawer slides out of the header chip of its own
  subscription. Without one, it uses any quota chip the header has, including one with no
  reset feed (OpenCode, an OpenRouter balance) and "Subscription not found". After those
  it uses the DeepSeek peak chip, the only chip for a direct DeepSeek model. With no chip
  at all it does not show; the details panels still list the notice. Every such chip
  carries `data-slp-reset-kind`, empty when no feed matches. Leaving it off unknown chips
  was a bug: a session on an OpenCode model never showed a drawer.
- **When it slides out.** Until "Got it", once per session view: on page load and again each
  time another session opens (`enterResetView`, keyed by the header's `sessionId`).
  Remounting the same session's header (a layout change) is not a new view. A drawer
  still open across the switch is not shown twice. After "Got it", never.
- **After the page has loaded.** Nothing slides out before the `load` event, web fonts
  (`document.fonts.ready`) and one browser idle moment (`requestIdleCallback`, at most 1.5s),
  so the session content renders first (`whenResetPageReady`). The fixture page is already
  loaded, so the UI check cannot exercise this wait.
- **Event-driven, no fixed delay.** Chips announce themselves (`noteResetAnchors`) when they
  mount, settle (data or error) and unmount. A waiting notice re-checks then. While its own
  chip is still loading it waits, because the chip's width is not final. There is no
  page-load wait and no fixed delay. An open drawer re-anchors on the same signal, and
  collapses if its chip leaves (a faded "not found").
- **A drawer, not a card.** A clipped frame sits 2px under the chip, starting at its left
  edge. The sheet slides down out of it in 300ms (`cubic-bezier(.16,1,.3,1)`, decelerating)
  and back up in 200ms (`cubic-bezier(.4,0,1,1)`, accelerating), with square top corners and
  rounded bottom ones. The exit used to start fast (`.32,.72,0,1`): most of the distance
  went in the first frames, which read as a jump. The drawer unmounts on the exit's
  `animationend`; a timer started before React applied the exit could cut it a frame or two
  early, and it remains only as a backup. The sheet has `will-change: transform`, so the
  move and its backdrop blur run on the compositor. Reduced motion removes the
  slide and keeps the timing.
- **Width: one line first.** The sheet is at least as wide as the chip and grows with its
  content up to `RESET_STRETCH` (1.5) times the chip, within the window. If the sentence
  and "Got it" fit, it is one line. If not, only "Got it" moves to a second line. The
  sentence wraps only when it alone is wider than the cap. A wrapped sheet is shrunk to
  its widest text line, so a moved button leaves no empty width.
- **Material.** The sheet is the Host's menu material, like the details panel:
  `data-menu-material="translucent"`, `--dsw-specific-menu` (a 70%-opaque fill),
  `--dsw-menu-backdrop-filter` (blur) and `--dsw-elevation-prominent`.
- **One sentence per notice.** Who, what and when, one line each (`<br>` between them),
  then a single "Got it" at the right edge. The ↗ is joined to
  the last word with a no-break space. The button floats right after the sentence: on the
  sentence's last line when there is room, otherwise right-aligned on the next line. A
  flex row was tried and dropped: a wrapped sentence filled the row, so the button could
  never share its last line and the drawer gained a line. The subscription
  name is in its plan colour (`planColor`; Grok uses the label colour) and the time phrase
  ("已于今天 09:23", "预计明天 18:00 前") is bold. Phrase-level wrapping
  (`word-break: keep-all`) never splits a Chinese word. The sentence is the AIHOT link;
  its tooltip carries the full sentence, the scope and the source. At a 167px Codex chip:
  "Codex 已于今天 09:23 重置额度 ↗" is one line (205px) with the button below it. The
  longest case (Antigravity, a time range, a reset card) wraps at 250px into two lines,
  with the button at the right of the second.
- **Wording.** "Codex 已于今天 09:23 重置额度", "Codex 预计明天 18:00 前重置额度",
  "Codex 预计今天 13:35 左右重置额度", "Antigravity 可能在今天 13:24–16:24 发放重置卡".
  Days read 今天/明天/昨天, otherwise M/D, in the viewer's time zone. A `date`-only
  promise is a Beijing date and says so. An AIHOT estimate reads "可能在"; the panel
  adds "（AIHOT 推算）".
- **Placement follows events.** Measured on open, then on a `ResizeObserver` of the chip
  and its header, window resize, scroll, and chip announcements. Never per frame.
- **Time.** It stays `resetAlertSeconds` (5). Hover or focus holds it, and leaving resumes
  the remaining time. While held, a pointer move outside it or the window losing focus also
  resumes it, because `pointerleave` does not fire when the pointer leaves the window.
- **One instance.** It is mounted in the sidebar footer and in every session header; only
  the oldest live mount polls and renders. Panels read the same list.
- **Links.** Only `https://aihot.news/…` (source) and `https://x.com/…` or
  `twitter.com` (original post) are rendered; anything else in the feed is dropped.

## Details panel

Every details panel with current notices shows one rounded box under its rows. The box
has one flowing line per notice, wrapping only when needed. The sentence is the AIHOT link
(↗), followed by the scope and "原帖 ↗". The panel's own subscription comes first. Notices stay until
they leave the 24h windows, acknowledged or not, so a dismissed drawer can always be
found again.

## Tests

`tests/reset-feed.test.js` (parser, 24 h rule, ETag/304, 429, cache restart, Grok,
`nextCheckAt`). `npm run verify -- --files lib/reset-feed.js lib/client.js --ui reset`: the
drawer waiting while its chip loads, sliding out of a clipped frame on the Codex chip,
between the chip's width and 1.5 times it, the sentence on one line when it fits the cap,
the menu material, hover hold and resume, once per session view (again after a session
switch, not after a same-session remount), the coloured name and bold time, the
details-panel box, an Antigravity notice sliding out of the Codex chip, two notices in one drawer with one
"Got it" that acknowledges both, the DeepSeek peak chip as the last anchor, and no drawer at all without a chip. `window.slpLocale = 'zh-CN'`
renders the fixture in Chinese. Each fixture mount loads a fresh plugin copy, so the check
disposes the previous one first; otherwise its drawer host keeps polling.
