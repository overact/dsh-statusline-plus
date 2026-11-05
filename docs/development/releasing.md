# Releasing

Maintainer notes for this plugin. User-facing installation stays in the README.

## Release order

1. Bump `version` in `package.json`, the README version badge and the CHANGELOG heading; move the `Unreleased` notes under the new heading.
2. Commit `chore(release): <version>`, create the annotated tag `v<version>`, and run `git push origin main v<version>`.
3. The tag runs `.github/workflows/release.yml`, in this order, each step only if the last passed:
   1. **Verify:** the whole of `verify.yml` on that commit, including the oldest supported DSH and the browser checks. A plain push may skip the browser checks; this run never does.
   2. **npm:** checks the tag against `package.json`, the README badge and the CHANGELOG, then publishes with provenance. A version already on npm is skipped.
   3. **GitHub Release:** builds the two byte-identical assets, `dsh-statusline-plus-<version>.tgz` and `dsh-statusline-plus.tgz`, and creates the latest release. Its notes are the version's CHANGELOG section. Edit them with `gh release edit` if the release deserves a better summary.
4. Run `npm run release:check` to confirm package, README badge, CHANGELOG, tag, npm dist-tag, Release assets and `releases/latest` all agree.

## When the tag run fails

- **Failed at Verify, or at npm's checks:** nothing was published. Fix it on `main`, move the tag with `git tag -fa v<version> -m v<version>`, and run `git push origin main` and then `git push -f origin v<version>`.
- **Failed at or after publishing:** never move the tag, because npm cannot republish a version. Re-run the workflow's failed jobs. A re-run skips what is already on npm, refreshes the assets and leaves the release notes alone. If the published code itself is wrong, release a new version.

## Fresh-install check

Optional, and worth running when the suite or the DSH dependency changed: it finds on your machine what would otherwise fail the tag run. The local `node_modules` can hold a newer DSH than the version `package.json` pins, and that pinned version is what CI tests. There is no lockfile, so CI always installs fresh. Run what CI runs on a committed copy of the release:

```sh
dir=$(mktemp -d)
git archive HEAD | tar x -C "$dir"
cd "$dir"
git init -q && git add -A && git -c user.name=check -c user.email=check@example.invalid commit -qm check
HOME="$dir/.home" npm install --ignore-scripts --no-audit --no-fund --no-package-lock
HOME="$dir/.home" npm run verify:all -- --ui none
```

The `git init` matters because Git tests read the checkout as a repository. The empty `HOME` keeps your login files out of the run. Delete the directory afterwards.

## npm trusted publishing

The workflow authenticates through OIDC trusted publishing; there is no `NPM_TOKEN` and no long-lived token in CI.

One-time setup on npmjs.com:

1. Open the package's [publishing access page](https://www.npmjs.com/package/dsh-statusline-plus/access).
2. Add a **Trusted Publisher** → **GitHub Actions**:
   - Organization or user: `overact`
   - Repository: `dsh-statusline-plus`
   - Workflow filename: `release.yml` (filename only)
   - Environment: leave empty
3. Under **Allowed actions**, enable **`npm publish`**. Configurations created after September 2026 allow only `npm stage publish` by default, so a missing direct-publish grant fails the workflow with 403.

npm removes bypass-2FA tokens for direct publishing in January 2027; OIDC trusted publishing is the supported replacement, not a temporary workaround.

### Stage-only alternative

To keep a manual approval before each publish, change the workflow step from `npm publish` to `npm stage publish`. Trusted publishers always allow staging, so no extra grant is needed. The tag run then leaves the version staged; publish it with 2FA through the npm website or `npm stage approve <id>`, and inspect pending items with `npm stage list`.

The `0.0.0-stage` entry that `npm view dsh-statusline-plus versions` shows is npm's staging placeholder (`stub: true`), not a release; it never occupies `latest`.

### Hardening after the first OIDC publish

On the same publishing access page, select **Require two-factor authentication and disallow tokens** and save. Manual publishes then use the 2FA code, and long-lived tokens can no longer publish.

## Checks

`npm run release:check` verifies the current package version against the README badge, changelog, git tag, npm dist-tags, GitHub Release assets and `releases/latest`. Use `--offline` to skip the npm and GitHub checks.
