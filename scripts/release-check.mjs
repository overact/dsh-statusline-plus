#!/usr/bin/env node
/**
 * Check that the current package version is consistently released.
 *
 * This catches the drift seen before 0.1.6: a tag without a GitHub Release,
 * a stale README badge, or two release assets with different contents.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REQUIRED_ASSETS = ['dsh-statusline-plus.tgz']

export function badgeVersion(readme) {
  const match = String(readme || '').match(/badge\/version-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-/)
  return match ? match[1] : null
}

export function hasChangelogHeading(changelog, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^##\\s+v?' + escaped + '\\s*$', 'm').test(String(changelog || ''))
}

export function releaseAssetNames(version) {
  return ['dsh-statusline-plus-' + version + '.tgz', ...REQUIRED_ASSETS]
}

export function validateAssets(assets, version) {
  const list = Array.isArray(assets) ? assets : []
  const names = releaseAssetNames(version)
  const missing = names.filter(name => !list.some(asset => asset && asset.name === name))
  const found = names.map(name => list.find(asset => asset && asset.name === name)).filter(Boolean)
  const digests = found.map(asset => asset.digest || '')
  const sameDigest = found.length === names.length && digests.every(digest => digest && digest === digests[0])
  return { ok: missing.length === 0 && sameDigest, names, missing, found, digests, sameDigest }
}

export function validateNpmTags(version, distTags) {
  const tags = distTags && typeof distTags === 'object' && !Array.isArray(distTags) ? distTags : null
  if (!tags) return { ok: false, detail: 'no dist-tags returned' }
  const matching = Object.keys(tags).filter(tag => tags[tag] === version)
  if (matching.length === 0) return { ok: false, detail: 'version not published' }
  if (version.includes('-')) {
    if (matching.includes('latest')) return { ok: false, detail: 'prerelease on latest' }
    return { ok: true, detail: 'dist-tag ' + matching.join(', ') }
  }
  return tags.latest === version
    ? { ok: true, detail: 'latest=' + version }
    : { ok: false, detail: 'latest=' + (tags.latest || 'none') }
}

export function repoSlug(pkg, remote) {
  const fromPackage = pkg && pkg.repository && pkg.repository.url
  for (const candidate of [fromPackage, remote]) {
    if (typeof candidate !== 'string') continue
    const match = candidate.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/)
    if (match) return match[1] + '/' + match[2]
  }
  return null
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function tryRun(command, args) {
  try { return { ok: true, value: run(command, args) } } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : ''
    return { ok: false, value: '', error: stderr || (error && error.message) || String(error) }
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, file), 'utf8'))
}

function parseArgs(argv) {
  const args = { offline: false, json: false, help: false }
  for (const arg of argv) {
    if (arg === '--offline') args.offline = true
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return args
}

function usage() {
  return [
    'Usage: npm run release:check -- [--offline] [--json]',
    '',
    'Checks the current package version against README, CHANGELOG, the git tag,',
    'the npm dist-tags, the GitHub Release assets and releases/latest.',
    '--offline  local checks only (skip npm and gh checks)',
    '--json     machine-readable result',
  ].join('\n')
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) { console.log(usage()); return 0 }
  const checks = []
  const add = (name, ok, detail, skipped = false) => checks.push({ name, ok: !!ok, skipped: !!skipped, detail: detail || '' })

  const pkg = readJson('package.json')
  const version = String(pkg.version || '')
  add('package.json version', VERSION_PATTERN.test(version), version || '(missing or invalid)')

  if (!VERSION_PATTERN.test(version)) {
    return finish({ version, checks, json: args.json })
  }

  const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8')
  const badge = badgeVersion(readme)
  add('README version badge', badge === version, badge ? 'badge ' + badge : 'badge not found')

  const changelog = readFileSync(resolve(REPO_ROOT, 'CHANGELOG.md'), 'utf8')
  add('CHANGELOG heading', hasChangelogHeading(changelog, version), '## ' + version)

  const tagName = 'v' + version
  const tag = tryRun('git', ['tag', '--list', tagName])
  add('git tag ' + tagName, tag.ok && tag.value === tagName, tag.ok ? (tag.value || 'not found') : tag.error)

  if (tag.ok && tag.value === tagName) {
    const tagVersion = tryRun('git', ['show', tagName + ':package.json'])
    let parsed = null
    try { parsed = JSON.parse(tagVersion.value) } catch { /* reported below */ }
    add('tag package version', parsed && parsed.version === version, parsed && parsed.version ? parsed.version : 'unreadable')
    const ancestor = tryRun('git', ['merge-base', '--is-ancestor', tagName, 'HEAD'])
    add('tag reachable from HEAD', ancestor.ok, ancestor.ok ? 'yes' : 'tag is not an ancestor of HEAD')
  } else {
    add('tag package version', false, 'skipped: tag missing')
    add('tag reachable from HEAD', false, 'skipped: tag missing')
  }

  const remote = tryRun('git', ['remote', 'get-url', 'origin'])
  const slug = repoSlug(pkg, remote.value)
  add('GitHub repository', !!slug, slug || 'cannot derive from package repository or origin')

  if (args.offline) {
    add('npm publication', true, 'skipped: --offline', true)
  } else {
    const view = tryRun('npm', ['view', pkg.name, 'dist-tags', '--json'])
    let distTags = null
    try { distTags = JSON.parse(view.value) } catch { /* reported below */ }
    const npmState = validateNpmTags(version, distTags)
    add('npm publication', view.ok && npmState.ok, view.ok ? npmState.detail : view.error)
  }

  if (args.offline) {
    add('GitHub Release', true, 'skipped: --offline', true)
    add('release assets', true, 'skipped: --offline', true)
    add('releases/latest', true, 'skipped: --offline', true)
  } else if (!slug) {
    add('GitHub Release', false, 'skipped: repository unknown')
    add('release assets', false, 'skipped: repository unknown')
    add('releases/latest', false, 'skipped: repository unknown')
  } else {
    const gh = tryRun('gh', ['--version'])
    if (!gh.ok) {
      add('gh CLI', false, 'not installed or not on PATH; rerun with --offline for local checks only')
      add('GitHub Release', true, 'skipped: gh unavailable', true)
      add('release assets', true, 'skipped: gh unavailable', true)
      add('releases/latest', true, 'skipped: gh unavailable', true)
    } else {
      const release = tryRun('gh', ['release', 'view', tagName, '--json', 'tagName,isDraft,isPrerelease,assets'])
      let releaseJson = null
      try { releaseJson = JSON.parse(release.value) } catch { /* reported below */ }
      const releaseOk = release.ok && releaseJson && releaseJson.tagName === tagName && !releaseJson.isDraft && !releaseJson.isPrerelease
      add('GitHub Release ' + tagName, releaseOk, releaseJson
        ? 'draft=' + !!releaseJson.isDraft + ' prerelease=' + !!releaseJson.isPrerelease
        : (release.error || 'not found'))
      const assets = validateAssets(releaseJson && releaseJson.assets, version)
      add('release assets', assets.ok && releaseOk, assets.ok
        ? assets.names.join(', ') + ' (same digest)'
        : 'missing ' + (assets.missing.join(', ') || 'none') + '; sameDigest=' + assets.sameDigest)
      const latest = tryRun('gh', ['api', 'repos/' + slug + '/releases/latest', '--jq', '.tag_name'])
      add('releases/latest', latest.ok && latest.value === tagName, latest.ok ? latest.value : latest.error)
    }
  }

  return finish({ version, checks, json: args.json })
}

function finish({ version, checks, json }) {
  const ok = checks.every(check => check.skipped || check.ok)
  const skipped = checks.filter(check => check.skipped).length
  if (json) console.log(JSON.stringify({ ok, version, skipped, checks }, null, 2))
  else {
    console.log('release:check v' + version)
    for (const check of checks) {
      const mark = check.skipped ? '- ' : check.ok ? '✓ ' : '✗ '
      console.log(mark + check.name + (check.detail ? ' — ' + check.detail : ''))
    }
    console.log(ok ? (skipped ? 'PASS (' + skipped + ' skipped)' : 'PASS') : 'FAIL')
    if (!ok) {
      console.log('Fix the failed items, then run this check again. Release order: bump package.json/README/CHANGELOG, commit, tag (the Release workflow publishes npm), publish both tgz assets, mark the release latest.')
    }
  }
  return ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (error) {
    console.error(error && error.message ? error.message : String(error))
    process.exitCode = 2
  }
}
