# Git chip

Shows the repository path, branch, ahead/behind, staged, unstaged, untracked and conflict
counts, and added/deleted lines for the session's workspace, locally or over SSH.

## Code

`GitLine`, `GIT_ERROR_TEXT`, `gitErrorVisible` and the refresh logic in `LiveStatusPanel`
(`lib/client.js`); `fetchGitStatus`, `resolveGitRepo`, `gitFailureCode`, `readGitStatus`,
`parseGitStatusV2`, `parseNumstat`, `createGitLookups` (`lib/git-status.js`); the `git` route
and `GIT_ERRORS` (`lib/index.js`).

Settings: `showGit`, `showCwd`, `gitCwd`.

## Which directory

`gitCwd` if set, then the session's current working directory (the Host's
`workingDirectory` projection, which follows the `working_directory` tool), then the session
summary's `cwd`, then the workspace containing the session. The current directory is
authoritative: the plugin never infers a repository from history. On a Host without the
`workingDirectory` projection the summary's original `cwd` is used.

`gitCwd` is a plugin-wide override, not a per-session one: while it is set, every session's
chip is pinned to that directory and no longer follows `working_directory` changes. Leave it
empty (the default) to follow the session. A relative or malformed value is sanitized away,
so the chip falls back to following instead of staying pinned to nothing.

Git resolves the repository from that directory, so the chip follows the session across
projects: a subdirectory of a repository shows that repository's root, and a nested
sub-project repository (a repository inside the workspace repository) shows its own root.
The Host commits a `cd` only through the `working_directory` tool, so a `cd` inside a shell
command does not move the chip.

## When it refreshes

There is no polling. It refreshes on mount, on a change of session or directory, when a step
ends (`sessionStats.steps` rises), when the page regains visibility or focus, and on click.
The one automatic retry is after a slow answer; see **Errors**. Requests for one session and
directory merge, and at most one runs per second; a trailing refresh runs after the current
one. A refresh keeps what is on screen until its answer arrives, so a retry cannot make the
chip blink. Only a click dims the chip while its request runs; a refresh that follows
activity keeps it at full strength, so an agent turn cannot make it flicker. A directory
that is momentarily unresolved (a session-list or workspace refresh) keeps the last answer
for that session instead of blanking the chip.

**First appearance.** On a fresh session the chip stays out of the row until the first
message settles, so it appears together with context and cost instead of sitting alone while
the first reply streams. The mount refresh still runs, so that first paint is immediate; a
resumed session with its own settled messages shows the chip at once, while a fork holding
only inherited history waits for its first new message, matching the cost scope. The gate
reads the plugin's own `statuslineMetrics` projection; if that read is unavailable the chip
shows as before.

## Rules

- **Stay out of the user's way.** Every command runs with `--no-optional-locks` and
  `core.fsmonitor=false`, so a status check never takes the index lock or starts a daemon.
  Keep this in `gitCommand` for any new command.
- **Line counts** come from `git diff HEAD --numstat --no-ext-diff`, one round trip for
  staged and unstaged together. A repository with no commits has no `HEAD`, so it uses
  `--cached`. Binary files report `-` and are left out; untracked files appear only in the
  untracked count.
- **Partial failure.** If only the line count fails, the rest still shows with
  `lineStatsError` and `+/− ?`. If a refresh fails, the old data stays and is marked stale.
- **"No repository" is not data.** An earlier `isRepo: false` must not hold back `⎇ ?` when a
  later read fails, so `GitLine` treats it the same as having no data.

## SSH

With a negotiated `sshRemoteHostBridge`, commands go through its routed subprocess.
`repoRoot` stays the local anchor path, used for links, while the label uses
`remote.host` and `remote.root`. A root outside the workspace anchor reads as `git-failed`, and
a remote shell without Git (exit 127) as `git-not-found`. The bridge appearing or leaving clears
the Git caches.

## Caching

Each spawn is a round trip over SSH and status runs after every step, so `createGitLookups`
keeps found roots and the Git path for 60 s. Only found roots are kept, so a new `git init`
shows at once. A root that stops working is resolved again. A repository nested inside a
cached one waits for the TTL or a manual refresh.

## Errors

Being outside a repository is normal, so the chip stays hidden. A repository Git cannot read
shows `⎇ ?`, muted, with the reason in its tooltip. Clicking it retries. If earlier data
exists, that data stays with a `!` whose tooltip names the reason.

| Situation | Route result | Chip with no earlier data |
| --- | --- | --- |
| Not a repository, or a directory that no longer exists outside one | `isRepo: false` | Hidden |
| `safe.directory` refusal | `git-unsafe-repo` | `⎇ ?` |
| Corrupt `.git/index`, or corrupt `.git/HEAD` locally | `git-failed` | `⎇ ?` |
| Git missing | `git-not-found` | `⎇ ?` |
| Invalid path | `git-invalid-cwd` | `⎇ ?` |
| Tracked changes alone overflow the output limit | `git-too-many-files` | `⎇ ?` |
| Git does not answer in time | `git-timeout` | `⎇ ?` after a second failure |
| The route cannot be reached | `network` (browser only) | `⎇ ?` after a second failure |

Rules for this table:

- **Deleted directory.** A directory that no longer exists falls back to its nearest existing
  parent, so a directory removed inside a repository still shows that repository. Outside a
  repository the result is `isRepo: false` and the chip hides.

- **Stable codes.** The route answers only with `GIT_ERRORS`, and the wording is in the client's
  locale table. Git's own output can name private paths, so it stays on the Host. A new code
  also needs an entry in `GIT_ERROR_TEXT`.
- **Locale.** `gitFailureCode` reads Git's English wording, so every command runs with
  `LC_ALL=C`. The SSH route forwards it. Any failure it does not recognize reads as `git-failed`.
- **Damaged `HEAD`.** Git itself says "not a git repository" here, so `hasGitEntry` looks for a
  `.git` entry on the way up. Only a worktree pointer file or a directory still holding part of
  a gitdir (`HEAD`, `config`, `objects`, `refs`) counts, so a stray empty `.git` directory above
  the session directory reads as no repository and the chip hides. A remote workspace has no
  cheap way to look, so there it still reads as no repository.
- **Slow answers.** One timeout is common on a network mount. Refreshes follow activity, so an
  idle session would never ask twice; the client retries once after 16 s, just past the Host's
  15 s error cache.
- **`safe.directory`.** The tooltip names the command. The plugin never changes Git config,
  because trusting a repository is the user's decision.

## Too many untracked files

Status output over 262144 bytes, such as a large unignored directory, would otherwise lose the
whole chip. `readGitStatus` reads again with `--untracked-files=no`, so the branch, the tracked
counts and the line counts still show, and the untracked count reads `??`. A full run that
overflows still costs its whole duration, so the overflow is remembered in the lookups for
their TTL. A manual refresh tries the full run again.

## Tests

`tests/statusline.test.js` runs the failure cases against real Git where it can, and covers the
chip's states. `tests/dsh-integration.test.js` covers the route's error codes. The browser smoke
panels do not cover this chip's states, so check a display change in a real page.
