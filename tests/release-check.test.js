'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const load = () => import(pathToFileURL(resolve(__dirname, '../scripts/release-check.mjs')).href)

test('README badge and CHANGELOG heading identify the current version', async () => {
  const { badgeVersion, hasChangelogHeading } = await load()
  assert.equal(badgeVersion('[![Version](https://img.shields.io/badge/version-0.1.6-blue)]'), '0.1.6')
  assert.equal(badgeVersion('no badge here'), null)
  assert.equal(hasChangelogHeading('# Notes\n\n## 0.1.6\n\n- fix\n', '0.1.6'), true)
  assert.equal(hasChangelogHeading('# Notes\n\n## v0.1.6\n', '0.1.6'), true)
  assert.equal(hasChangelogHeading('# Notes\n\n## 0.1.5\n', '0.1.6'), false)
})

test('release assets require both names and one shared digest', async () => {
  const { releaseAssetNames, validateAssets } = await load()
  assert.deepEqual(releaseAssetNames('0.1.6'), ['dsh-statusline-plus-0.1.6.tgz', 'dsh-statusline-plus.tgz'])
  const digest = 'sha256:abc'
  assert.equal(validateAssets([
    { name: 'dsh-statusline-plus-0.1.6.tgz', digest },
    { name: 'dsh-statusline-plus.tgz', digest },
  ], '0.1.6').ok, true)
  assert.equal(validateAssets([
    { name: 'dsh-statusline-plus-0.1.6.tgz', digest },
  ], '0.1.6').ok, false)
  assert.equal(validateAssets([
    { name: 'dsh-statusline-plus-0.1.6.tgz', digest },
    { name: 'dsh-statusline-plus.tgz', digest: 'sha256:def' },
  ], '0.1.6').ok, false)
  assert.equal(validateAssets([
    { name: 'dsh-statusline-plus-0.1.6.tgz', digest: '' },
    { name: 'dsh-statusline-plus.tgz', digest: '' },
  ], '0.1.6').ok, false)
})

test('npm tags keep stable versions on latest and prereleases off it', async () => {
  const { validateNpmTags } = await load()
  assert.deepEqual(validateNpmTags('0.1.8', { latest: '0.1.8' }), { ok: true, detail: 'latest=0.1.8' })
  assert.equal(validateNpmTags('0.1.8', { latest: '0.1.7' }).ok, false)
  assert.equal(validateNpmTags('0.1.9', { latest: '0.1.8' }).ok, false)
  assert.equal(validateNpmTags('0.2.0-alpha.1', { latest: '0.1.8', alpha: '0.2.0-alpha.1' }).ok, true)
  assert.equal(validateNpmTags('0.2.0-alpha.1', { latest: '0.2.0-alpha.1', alpha: '0.2.0-alpha.1' }).ok, false)
  assert.equal(validateNpmTags('0.1.8', { latest: '0.1.7', beta: '0.1.8' }).detail, 'latest=0.1.7')
  assert.equal(validateNpmTags('0.1.9', null).ok, false)
})

test('repository slug accepts package and remote URL shapes', async () => {
  const { repoSlug } = await load()
  assert.equal(repoSlug({ repository: { url: 'git+https://github.com/overact/dsh-statusline-plus.git' } }), 'overact/dsh-statusline-plus')
  assert.equal(repoSlug({}, 'git@github.com:overact/dsh-statusline-plus.git'), 'overact/dsh-statusline-plus')
  assert.equal(repoSlug({ repository: { url: 'https://github.com/a/b' } }), 'a/b')
  assert.equal(repoSlug({}, 'https://example.com/a/b.git'), null)
})
