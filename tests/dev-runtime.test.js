'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const load = () => import(pathToFileURL(resolve(__dirname, '../scripts/dev-runtime.mjs')).href)

test('HMR roots parse relative, absolute and commented entries', async () => {
  const { parseHmrRoots } = await load()
  const roots = parseHmrRoots([
    '- id: hmr',
    '  config:',
    '    base: /profiles/web',
    '    root:',
    '      - dev-plugins/decision/lib',
    '      # the linked checkout',
    '      - /work/statusline/lib',
    '      - "quoted/lib"',
    '- id: next',
    '  config: {}',
  ].join('\n'), '/profiles/web')
  assert.deepEqual(roots, [
    '/profiles/web/dev-plugins/decision/lib',
    '/work/statusline/lib',
    '/profiles/web/quoted/lib',
  ])
})

test('HMR roots accept an inline list and a missing hmr block', async () => {
  const { parseHmrRoots } = await load()
  assert.deepEqual(parseHmrRoots([
    '- id: hmr',
    '  config:',
    '    base: /profiles/web',
    '    root: [a/lib, /b/lib]',
  ].join('\n'), '/profiles/web'), ['/profiles/web/a/lib', '/b/lib'])
  assert.deepEqual(parseHmrRoots('- id: other\n  config: {}\n', '/profiles/web'), [])
})

test('HMR coverage accepts the directory itself and its parents, not siblings', async () => {
  const { coversPath } = await load()
  const roots = ['/work/statusline-plugin/lib']
  assert.equal(coversPath(roots, '/work/statusline-plugin/lib'), true)
  assert.equal(coversPath(roots, '/work/statusline-plugin/lib/quota.js'), true)
  assert.equal(coversPath(['/work/statusline-plugin'], '/work/statusline-plugin/lib'), true)
  assert.equal(coversPath(['/work/statusline-plugin/lib/other'], '/work/statusline-plugin/lib'), false)
  assert.equal(coversPath([], '/work/statusline-plugin/lib'), false)
})

test('profile link resolves a link: dependency and reports a missing one', async t => {
  const { readProfileLink } = await load()
  const root = mkdtempSync(join(tmpdir(), 'slp-dev-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-statusline-plus': 'link:/work/statusline-plugin' },
  }))
  const link = readProfileLink(root)
  assert.equal(link.spec, 'link:/work/statusline-plugin')
  assert.equal(resolve(link.target), '/work/statusline-plugin')
  assert.equal(readProfileLink(join(root, 'missing')).target, null)
})

test('dev runtime profile directory honours the explicit override and env', async () => {
  const { resolveProfileDir } = await load()
  const before = process.env.DSH_PROFILE_DIR
  try {
    assert.equal(resolveProfileDir('/tmp/profile'), '/tmp/profile')
    process.env.DSH_PROFILE_DIR = '/tmp/from-env'
    assert.equal(resolveProfileDir(), '/tmp/from-env')
    delete process.env.DSH_PROFILE_DIR
    assert.match(resolveProfileDir(), /\.dsh\/profiles\/web$/)
  } finally {
    if (before === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = before
  }
})
