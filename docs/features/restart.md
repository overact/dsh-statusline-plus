# Reload, restart and DSH update

A power button in the sidebar footer, beside the peak dot, applies plugin and config
changes to the running Host, cheapest first, and updates DSH itself where that is safe.
The page reloads once the Host is ready. It replaces the separate `dsh-restart-button`
plugin.

## Code

| Area | Symbols |
| --- | --- |
| Reload and restart | `createRestartController`, `reconcileProfile`, `planAfterReload`, `activeSessionCount`, `restartUnit`, `systemdUnitOf` in `lib/restart.js` |
| DSH update | `createHostUpdater`, `resolveHostInstall`, `fetchDistTag`, `hostPackageDir` in `lib/host-update.js` |
| Route | `restart` route, `hostReady`, `hostUpdater` in `lib/index.js` |
| Page | `RestartFooterButton`, `useRestartCaps`, `openRestartDialog`, `runRestart`, `restartStep`, `restartPollDelay` in `lib/client.js` |

## What each environment gets

| Host | Reload | Full restart | DSH update |
| --- | --- | --- | --- |
| Linux or WSL, DSH as a systemd user service, global npm install writable by the user | Yes | Yes | Yes |
| Same, but npm prefix owned by root, or DSH installed with pnpm, npx or `link:` | Yes | Yes | No |
| Started from a terminal (no service manager) | With HMR | No | No |
| Windows, including the desktop app | With HMR | No | No |
| macOS desktop app | With HMR | No | No |

Every missing choice is hidden, not disabled. A Host offering none of them shows no button.

Windows has no supervisor that starts DSH again after it exits, and it locks the files of
a running program, so `npm install -g` over a running Host typically fails with `EBUSY`.
The desktop apps update themselves.

## Three actions

| | Reload | Full restart | Update DSH |
| --- | --- | --- | --- |
| How | `hmr.runExclusive(() => hmr.reconcileProfile())` | `systemctl --user --no-block restart <unit>` | `npm install -g @deepseek-ai/dsh@<version>`, then a full restart |
| Process | Same pid; changed modules are swapped | New process | New process |
| Sessions | Keep running | Interrupted | Keep running during the install, interrupted by the restart |
| Typical time | About a second | Stop (under a second here) plus a full boot | npm install plus a full restart |
| Needs | `hmr` in the profile | This process in a systemd user unit | A unit, plus the conditions under [DSH update](#dsh-update) |
| Covers | Plugin code, profile `package.json`, patch files | Everything, including DSH itself | A new DSH version |

`reconcileProfile` compares every loaded profile module with the disk, so it also catches a
change the file watcher missed or one outside the `hmr` roots, such as a package
reinstalled under `node_modules`. It cannot replace DSH's own modules. Its restart reasons
are `no-hmr`, `host-module`, `unmanaged-plugin`, `package-moved` and `module-comparison`; a
reconcile that throws means the replaced plugin may not be running.

### After a reload

`planAfterReload(outcome, canRestart, active)` decides:

- `done`: the soft reload covered everything;
- `restart`: a restart is needed and no session is running a turn, so it restarts at once;
- `confirm`: a restart is needed but a turn is running, or the Host cannot tell. The page
  asks "Restart now / Later". The user agreed to a reload, not to cutting off a turn;
- `manual`: a restart is needed but this Host cannot do it.

A full restart skips the soft step. Use it for a stuck process.

## Confirmation dialog

Buttons, left to right: Cancel (focused, so a reflexive Enter does nothing), Full restart,
Update DSH, Reload. Esc and a press that starts and ends on the backdrop cancel. Above the
buttons:

- with an update, a line naming the latest and running versions. The version stays out of
  the button so a long prerelease name cannot widen the row;
- where a full restart is possible and a session is running or the count is unknown, a
  warning with the number of running sessions.

`activeSessionCount` counts top-level agents (`agents.roots()`) whose `status` is
`running`; subagents belong to a running parent and are not counted again. `agents` is not
injected, so it is reached through `ctx.get()`, and a missing service reads as unknown
(`null`). The dialog asks for a fresh count each time it opens.

## DSH update

Offered only when all of these hold, otherwise nothing about it appears:

- the Host was started from the global npm copy: `process.argv[1]` resolves into the
  directory `npm root -g` names, using the npm beside the running node, because the
  service's PATH may differ from a shell's;
- that global root is writable by this user, since a root-owned prefix would need sudo;
- the Host runs in a systemd user unit, because new DSH code always needs a full restart.

### Checking for a release

There is no timer and nothing pushes a release. The button asks once when it mounts, that
is on each page load, with `GET restart?update=1`; the settings page asks the same way.
The Host then:

1. reads the registry's dist-tags document, `/-/package/@deepseek-ai/dsh/dist-tags`. It is
   about 70 bytes, not a manifest and never a tarball, and runs asynchronously with an 8 s
   deadline;
2. takes its `latest` tag, the same channel as `dsh-update`;
3. caches the answer for one minute, after a failure too, so several tabs or a burst of
   reloads read the registry once.

`npm root -g` runs once per process (about 0.1 s and 65 MB for that moment). A failed read
is unknown, never "up to date". Only a strictly newer version is offered, so a prerelease
ahead of `latest` is not downgraded. A page left open does not learn of a release until
it reloads.

### Installing

With an update available, the button turns brand-coloured, with a dot and a pulsing ring
(static under reduced motion), and its tooltip names the version. Choosing Update DSH:

1. the Host installs only the version its last check offered, never one from the request;
2. npm runs with a five-minute limit. It rolls back a failed install, and the service keeps
   serving meanwhile;
3. the Host confirms that the installed `package.json` has that version;
4. it restarts the unit, and the page reloads when the new process is ready.

A failed install restarts nothing: the old DSH keeps running, and the toast names the
journal command. The page allows six minutes before calling the outcome unknown.

The running process's files are replaced during the install, and anything it loads lazily
in that window may come from the new copy. The restart follows at once to keep that short.

## Switch

`showRestartButton` (default on) has its own settings section, "Reload and DSH update",
and switches the whole feature. Off hides the button, makes the Host answer `GET restart`
with only `{ disabled: true }` (no registry read), and refuse every POST with 409
`disabled`. "Restart to apply" after a self-update then stays disabled.

## Capability detection

The unit is read from `/proc/self/cgroup`: the last `*.service` below `user@<uid>.service`.
Nothing is hard-coded, and a desktop app, Windows, a terminal or a system service reports
no unit. The button shows when the Host offers reload or restart and the switch is on.

## State

The run's state lives on `globalThis[Symbol.for('dsh-statusline-plus.restart')]`, not in
the module. A soft reload can evict this module and dispose the fiber that started it; the
old closure still escalates, and the replacement copy's route reports that run. `seq`
guards against a late callback rewriting a newer run. Phases: `idle`, `reloading`,
`reloaded`, `confirm`, `manual`, `updating`, `restarting`, `failed` (reason `systemctl`,
`internal` or `update-<code>`). One run at a time; a second request gets 409 `in-progress`.

The POST answers 202 before any work starts (deferred 80 ms), because every action can end
the request's own handler. `--no-block` makes systemctl return once the job is queued, so
its exit code means "accepted" and it is never killed by the stop of its own cgroup.
`reset-failed` runs first to clear the start-rate counter, so repeated restarts are not
refused.

## Page

`runRestart` reads the pid, posts, then probes `GET restart` every 250 ms for 15 s and
every second after. It never resubmits, and its deadline is 60 s, or six minutes for an
update. `restartStep` maps a probe:

- same pid: follow `phase` (`reloading`, `reloaded` → done, `confirm`, `manual`,
  `updating`, `restarting`, `failed`);
- connection refused: the bounce;
- a new pid: done only with HTTP 200 and `ready`, which waits for `loader.await()`, so the
  session list is loaded before the page reloads. A 503 or a missing route is still
  booting.

After a self-update of this plugin, the settings header's "Restart to apply" opens the
same dialog where a full restart is available, and stays disabled elsewhere.

## Tests

`tests/restart.test.js`, `tests/host-update.test.js`, and the restart cases at the end of
`tests/client-lifecycle.test.js`. No test runs a real systemctl or npm install.
