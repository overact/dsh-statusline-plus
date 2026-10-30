# Releasing

Maintainer notes for this plugin. User-facing installation stays in the README.

## Release order

1. Bump `version` in `package.json`, the README version badge and the CHANGELOG heading; move the `Unreleased` notes under the new heading.
2. Run `npm run verify:all` (tests plus the browser panels).
3. Commit `chore(release): <version>`, create the annotated tag `v<version>`, and push `main` and the tag.
4. The tag runs `.github/workflows/release.yml`: it verifies the suite, checks that the tag matches `package.json`, and publishes `dsh-statusline-plus@<version>` to npm with provenance. A version that already exists on npm is skipped, so re-running is safe.
5. Upload the two GitHub Release assets — `dsh-statusline-plus-<version>.tgz` and `dsh-statusline-plus.tgz`, byte-identical — and mark the release latest.
6. Run `npm run release:check` to confirm package, README badge, CHANGELOG, tag, npm dist-tag, Release assets and `releases/latest` all agree.

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
