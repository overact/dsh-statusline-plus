# Health: what the plugin says when one of its own surfaces fails

Two things can make this plugin render less than it should without leaving a trace a
user can act on. Both are now reported in Settings, in one banner, and nothing is
shown when everything is fine.

## 1. The browser bundle and the host half disagree

`lib/index.js` carries `WIRE_VERSION`; `lib/client.js` carries the number it was
written against (`WIRE_EXPECTED`). `GET /statusline/api/wire` answers with the host
number, and the bundle compares them on `apply()`.

They disagree after an update where only one half was replaced — the usual case being
a browser that served its bundle from cache while the Host already runs the new
module. The symptom is not an error: it is a row that silently renders less, or a
panel that loses a field. The banner names both numbers and says to reload first, then
restart DSH, because only the user can tell which half is stale.

Bump `WIRE_VERSION` **when** you change a route payload, a projection field or a slot
contract the bundle reads. Do not bump it for a purely internal change: a false
warning trains people to ignore the banner.

- Route: `lib/index.js`, `/statusline/api/wire` (no I/O — it answers a constant).
- Client: `noteWire`, `WIRE_EXPECTED`, `HealthBanner`.
- Fixture: `mountResponsiveFixture(page, { wire })`; `verify-ui --panel responsive`
  asserts the banner at a mismatched number and its absence at a matching one.

## 2. A slot entry threw

The Host retires a slot entry that throws: the surface it rendered disappears and the
only trace is a console error in a page nobody is watching. `apply()` subscribes to
`slots.onEntryError` and keeps the last three failures for **our own** entries.

Entries in `conversation.composer.dock`, `conversation.session.header.actions` and
`sidebar.footer.action` include other plugins' work, so a failure is recorded only
when the entry id starts with `statusline-plus` (`isOwnEntry`). Another plugin's bug is
not ours to display, and reporting it would send users to the wrong settings page.

Repeated failures of the same slot and message are recorded once — a throw on every
render must not push the first, useful failure out of the panel.

- Client: `noteFault`, `isOwnEntry`, `healthState`, `HealthBanner`.
- Tests: `tests/client-lifecycle.test.js` (own-entry filter, dedupe, three-line cap).

## Rules

- The banner is a status, never a countdown or a retry button. It reports what the page
  knows; acting on it is a reload or a restart.
- No banner when the halves agree and every entry mounted. Silence is the normal state.
- The wire number is a contract number, not the package version; they move
  independently and a mismatch means the two halves are from different builds.

## Tests

`npm run verify -- --files lib/client.js lib/index.js --ui responsive`.
`tests/client-lifecycle.test.js` (health cases).
