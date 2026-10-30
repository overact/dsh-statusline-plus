'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const {
  PACKAGE_NAME, compareVersions, enginesAllow, readInstalled, resolveInstall, hostVersion,
  createUpdateChecker, applyUpdate, fetchLatest,
} = require('../lib/update.js')
process.env.SLP_TEST = '1'
const { __test } = require('../lib/index.js')
const { hotApplyUpdate } = __test

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))

function withFetch(handler, run) {
  const previous = global.fetch
  const calls = []
  global.fetch = async (url, options) => { calls.push({ url, options }); return handler(url, options) }
  return Promise.resolve(run(calls)).finally(() => { global.fetch = previous })
}

function withHostVersion(version, run) {
  const previous = process.env.DSH_VERSION
  if (version === undefined) delete process.env.DSH_VERSION
  else process.env.DSH_VERSION = version
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = previous
  })
}

function registryResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function fakeSubprocess(overrides = {}) {
  const runs = []
  return {
    runs,
    resolveExecutable: async name => (name === 'pnpm' ? '/usr/bin/pnpm' : null),
    spawn: options => {
      runs.push(options)
      return {
        done: Promise.resolve({ exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: overrides.stdout || '' }) },
          stderr: { readFrom: () => ({ text: overrides.stderr || '' }) },
        },
      }
    },
  }
}

test('versions compare numerically and a release outranks its own prerelease', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('0.1.9', '0.1.9'), 0)
  assert.equal(compareVersions('0.1.9', '0.1.10'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('', '0.0.1'), -1)
})

test('the engines gate understands this package range and reports unknown ranges', () => {
  assert.equal(enginesAllow('>=0.2.0-rc.2', '0.2.1-rc.5'), true)
  assert.equal(enginesAllow('>=0.2.0-rc.2', '0.1.9'), false)
  assert.equal(enginesAllow('^0.2.0', '0.2.5'), true)
  assert.equal(enginesAllow('>=0.2.0 <0.3.0', '0.2.1'), true)
  assert.equal(enginesAllow('>=0.2.0 <0.3.0', '0.3.0'), false)
  assert.equal(enginesAllow('workspace:*', '0.2.1'), null)
  assert.equal(enginesAllow(undefined, '0.2.1'), null)
  assert.equal(enginesAllow('>=0.2.0', null), null)
})

test('the running copy reports its own manifest and is recognised as a linked checkout', () => {
  const installed = readInstalled()
  assert.equal(installed.version, manifest.version)
  assert.equal(installed.name, PACKAGE_NAME)
  const install = resolveInstall()
  // Tests run from the source tree, which is not the registry's to replace.
  assert.equal(install.linked, true)
  assert.equal(install.dir, null)
})

test('the host version comes from the environment before anything else', async () => {
  await withHostVersion('9.9.9-test', () => {
    assert.equal(hostVersion(), '9.9.9-test')
  })
})

test('an update is offered only when the registry is newer and the host admits it', async () => {
  await withHostVersion('0.2.1-rc.5', () => withFetch(
    () => registryResponse({ version: '99.0.0', engines: { dsh: '>=0.2.0-rc.2' } }),
    async calls => {
      const check = createUpdateChecker({ ttlMs: 60000 })
      const first = await check({})
      assert.equal(first.updateAvailable, true)
      assert.equal(first.compatible, true)
      assert.equal(first.latest, '99.0.0')
      assert.equal(first.installed, manifest.version)
      assert.equal(first.error, null)
      // A second read inside the window must not touch the registry again.
      const second = await check({})
      assert.equal(second.updateAvailable, true)
      assert.equal(calls.length, 1)
      // force bypasses the cache.
      await check({ force: true })
      assert.equal(calls.length, 2)
      assert.match(calls[0].url, /registry\.npmjs\.org\/dsh-statusline-plus\/latest$/)
    },
  ))
})

test('the default cache window is one minute', async () => {
  let clock = 0
  await withHostVersion('0.2.1-rc.5', () => withFetch(
    () => registryResponse({ version: '0.1.10', engines: { dsh: '>=0.2.0-rc.2' } }),
    async calls => {
      const check = createUpdateChecker({ now: () => clock })
      await check({})
      clock = 59_000
      await check({})
      assert.equal(calls.length, 1, 'inside the minute the registry is not asked again')
      clock = 61_000
      await check({})
      assert.equal(calls.length, 2, 'after the minute the next visit re-checks')
    },
  ))
})

test('a version the running host would refuse is not offered', async () => {
  await withHostVersion('0.2.0', () => withFetch(
    () => registryResponse({ version: '99.0.0', engines: { dsh: '>=0.2.1-rc.2' } }),
    async () => {
      const result = await createUpdateChecker({ ttlMs: 0 })({})
      assert.equal(result.compatible, false)
      assert.equal(result.updateAvailable, true, 'the version is newer; compatibility is a separate fact')
    },
  ))
})

test('an older or equal registry version is not an update', async () => {
  await withHostVersion('0.2.1-rc.5', () => withFetch(
    () => registryResponse({ version: manifest.version }),
    async () => {
      const result = await createUpdateChecker({ ttlMs: 0 })({})
      assert.equal(result.updateAvailable, false)
    },
  ))
})

test('a registry failure hides the button instead of claiming the copy is current', async () => {
  await withHostVersion('0.2.1-rc.5', () => withFetch(
    () => registryResponse({}, 503),
    async () => {
      const result = await createUpdateChecker({ ttlMs: 0 })({})
      assert.equal(result.error, 'registry')
      assert.equal(result.updateAvailable, false)
      assert.equal(result.installed, manifest.version)
    },
  ))
})

test('fetchLatest rejects a manifest without a version', async () => {
  await withFetch(() => registryResponse({ name: PACKAGE_NAME }), async () => {
    await assert.rejects(() => fetchLatest({}), /no version/)
  })
})

test('the overlay install runs pnpm in the profile directory', async () => {
  const subprocess = fakeSubprocess({ stdout: '+ dsh-statusline-plus 0.1.10' })
  const result = await applyUpdate({ version: '0.1.10', profileDir: '/profiles/web', subprocess })
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /0\.1\.10/)
  assert.equal(subprocess.runs.length, 1)
  assert.deepEqual(subprocess.runs[0].argv, ['add', 'dsh-statusline-plus@0.1.10'])
  assert.equal(subprocess.runs[0].cwd, '/profiles/web')
})

test('a failing install keeps its diagnostics and its exit code', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: 'ERR_PNPM_FETCH_404' })
  const result = await applyUpdate({ version: '0.1.10', profileDir: '/profiles/web', subprocess })
  assert.equal(result.exitCode, 1)
  assert.match(result.output, /ERR_PNPM_FETCH_404/)
})

test('an install without a package manager or a profile is refused before spawning', async () => {
  const bare = { resolveExecutable: async () => { throw new Error('missing') }, spawn: () => { throw new Error('must not spawn') } }
  await assert.rejects(() => applyUpdate({ version: '0.1.10', profileDir: '/profiles/web', subprocess: bare }), /no-package-manager/)
  await assert.rejects(() => applyUpdate({ version: '0.1.10', profileDir: '', subprocess: bare }), /no-profile/)
  await assert.rejects(() => applyUpdate({ version: '0.1.10', profileDir: '/profiles/web' }), /no-subprocess/)
})


test('a hot apply reconciles the profile instead of asking for a restart', async () => {
  const calls = []
  const ctx = {
    get: name => name === 'hmr'
      ? { runExclusive: run => run(), reconcileProfile: async () => { calls.push('reconcile'); return { warnings: [], pending: [] } } }
      : undefined,
  }
  assert.deepEqual(await hotApplyUpdate(ctx), { applied: true })
  assert.deepEqual(calls, ['reconcile'])
})

test('a profile without HMR keeps the restart path', async () => {
  assert.deepEqual(await hotApplyUpdate({ get: () => undefined }), { applied: false, reason: 'no-hmr' })
  assert.deepEqual(await hotApplyUpdate({ get: () => ({ runExclusive: 1 }) }), { applied: false, reason: 'no-hmr' })
})

test('a reconcile that still needs a restart reports why', async () => {
  const ctx = { get: () => ({ runExclusive: run => run(), reconcileProfile: async () => ({ warnings: [], pending: [{ reason: 'native-addon' }] }) }) }
  assert.deepEqual(await hotApplyUpdate(ctx), { applied: false, reason: 'native-addon' })
  const direct = { get: () => ({ runExclusive: run => run(), reconcileProfile: async () => ({ warnings: [], restartReason: 'loader' }) }) }
  assert.deepEqual(await hotApplyUpdate(direct), { applied: false, reason: 'loader' })
})

test('a failing HMR lookup or reconcile falls back instead of failing the install', async () => {
  assert.deepEqual(await hotApplyUpdate({ get: () => { throw new Error('cannot get property "hmr" without inject') } }), { applied: false, reason: 'no-hmr' })
  const broken = { get: () => ({ runExclusive: run => run(), reconcileProfile: async () => { throw new Error('boom') } }) }
  const outcome = await hotApplyUpdate(broken)
  assert.equal(outcome.applied, false)
  assert.match(outcome.reason, /boom/)
})
