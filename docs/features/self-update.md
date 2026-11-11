# Self-update

When npm publishes a newer version, the settings header shows a button naming it. One click
installs in place, and the Host swaps the new copy into the running profile.

## Code

`createUpdateChecker`, `applyUpdate`, `resolveInstall`, `enginesAllow`, `compareVersions` in
`lib/update.js`; the `version` route and `hotApplyUpdate` in `lib/index.js`; the update state
in `SettingsPage` (`lib/client.js`).

## Checking

The page asks once per settings visit, never on a timer, and the Host caches the registry
answer for a minute. Only that answer is cached: `updateAvailable`, `compatible` and
`restartRequired` are worked out on each call, because an install changes them inside the
minute. A cached `updateAvailable` once offered the version just installed.

The check always offers `latest` and installs it directly, however many versions that skips.
Settings are read compatibly on load, with no per-version migration chain. No earlier version
is offered when `latest` needs a newer Host.

The settings header shows the first that applies:

1. **Button: update to a version.** A newer version exists and the running Host accepts it
   (`compatible` null, meaning unknown, counts as accepted).
2. **Disabled: restart to apply.** `restartRequired`, meaning the version on disk is newer than
   the one loaded when this module was evaluated. It stays until the new copy is really running.
3. **Note: the version and the DSH it needs.** A newer version exists, but `compatible` is false.
4. **Nothing.** The install is linked, because a development checkout is not the registry's to
   replace; the registry failed, because an error must not read as "up to date"; or the plugin
   is current. A linked install shows nothing even with a restart pending.

The check asks the registry directly, so it works on any Host running this plugin.
`STATUSLINE_REGISTRY` overrides the registry for tests.

## Installing

`POST version` refuses a linked install, a version not newer than the installed one, and a
concurrent install. Then `applyUpdate` tries installers in this order:

1. `dsh plugin add` through the running CLI, when the Host runs from
   `@deepseek-ai/dsh`. `hostCliEntry` resolves `process.argv[1]` first, because a Host started
   through the `dsh` command reports that symlink instead of `bin.js`.
2. The Host's own pnpm, from `profileContext.packageManager`. This is the desktop route: its
   entry is `dsh-desktop-host`, so step 1 does not apply, and pnpm is not on PATH. The command,
   its prefix arguments and its environment all come from the Host; without
   `ELECTRON_RUN_AS_NODE` the command would start the app.
3. `pnpm` from PATH.

The first success ends the loop. If all fail, the first real failure is reported, ahead of
an installer that could not start. When no installer exists at all, the response names the
`dsh plugin` command to run by hand.

The plugin does not call `pluginManager`: under HMR `installBundle` refuses an installed
package, and `updateBundle` removes it first, which would kill the request that asked. Steps 2
and 3 therefore run `pnpm add` without the profile lock and compatibility check that step 1
gets from `dsh plugin`. The button is already hidden for an incompatible version.

Never fetch an installer here. `npx pnpm` was removed: it pulled an unpinned pnpm that could
differ from the Host's by a major version, and on Windows its copy had no working entry.

## Applying

The install is an overlay rather than remove-then-install, because unloading this plugin
would kill the request that asked for the update.

`hotApplyUpdate` then runs `hmr.reconcileProfile()` 80 ms after the response is sent, because
applying disposes this plugin's own fiber. The page polls the `version` route for 8 seconds:

- a new `instanceId` means the swap happened: "Updated · Refresh", which reloads the page;
- `hotFailed` means this instance could not swap, including a profile without HMR: "Restart to
  apply", which opens the [restart](restart.md) dialog where the Host runs in a systemd user
  unit and stays disabled elsewhere;
- neither by the deadline means the swap may still be running: "Installed · Refresh to confirm".
  Reloading runs the check again, which shows no button or "Restart to apply". The deadline
  alone must not claim a restart is needed.

## Rules

- The install is deliberately not tied to the request's signal: aborting because a tab closed
  would leave `node_modules` half-written.
- Installer output is capped by `OUTPUT_LIMIT`, and the whole install by `INSTALL_TIMEOUT_MS`.
- `resolveInstall` recognizes `<home>/profiles/<profile>/node_modules/dsh-statusline-plus`.
  Any other path counts as linked. Check this first if a Host changes its profile layout.

## Tests

`tests/update.test.js`, `tests/client-lifecycle.test.js`. Consumer verification is in
[releasing](../development/releasing.md).
