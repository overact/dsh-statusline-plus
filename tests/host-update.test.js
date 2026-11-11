'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { HOST_PACKAGE, hostPackageDir, resolveHostInstall, createHostUpdater } = require('../lib/host-update.js')
const { createRestartController, restartState } = require('../lib/restart.js')

/** A fake global npm root holding @deepseek-ai/dsh at `version`, plus its bin symlink. */
function globalRoot(version) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'slp-host-')))
  const root = join(base, 'lib', 'node_modules')
  const dir = join(root, '@deepseek-ai', 'dsh')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: HOST_PACKAGE, version }))
  writeFileSync(join(dir, 'lib', 'bin.js'), '')
  mkdirSync(join(base, 'bin'))
  symlinkSync(join(dir, 'lib', 'bin.js'), join(base, 'bin', 'dsh'))
  return { base, root, dir, entry: join(base, 'bin', 'dsh') }
}

const supported = (dir, version) => async () => ({ supported: true, dir, root: '/x', version })

test('the Host package is found through the dsh symlink', () => {
  const host = globalRoot('0.2.2')
  assert.equal(hostPackageDir(host.entry), host.dir)
  assert.equal(hostPackageDir('/nonexistent/bin.js'), null)
  assert.equal(hostPackageDir(''), null)
})

test('only the global npm install of the running Host can update itself', async () => {
  const host = globalRoot('0.2.2')
  const exec = root => async () => root
  const ok = await resolveHostInstall({ entry: host.entry, npm: 'npm', exec: exec(host.root), access: () => {} })
  assert.deepEqual(ok, { supported: true, dir: host.dir, root: host.root, version: '0.2.2' })
  const other = globalRoot('0.2.2')
  assert.equal((await resolveHostInstall({ entry: host.entry, exec: exec(other.root), access: () => {} })).reason, 'not-global', 'a Host run from another copy')
  assert.equal((await resolveHostInstall({ entry: host.entry, exec: async () => { throw new Error('ENOENT') }, access: () => {} })).reason, 'no-npm')
  assert.equal((await resolveHostInstall({ entry: host.entry, exec: exec(host.root), access: () => { throw new Error('EACCES') } })).reason, 'not-writable', 'a root-owned prefix')
  assert.equal((await resolveHostInstall({ entry: '/usr/lib/electron/app.js', exec: exec(host.root), access: () => {} })).reason, 'not-npm-host', 'the desktop app')
})

test('an update is offered only for a newer version, and the answer is cached', async () => {
  let reads = 0
  const updater = createHostUpdater({ resolve: supported('/x', '0.2.2-rc.1'), latest: async () => { reads++; return { version: '0.2.2' } } })
  assert.deepEqual(await updater.check(), { supported: true, installed: '0.2.2-rc.1', latest: '0.2.2', available: true })
  await updater.check()
  assert.equal(reads, 1)
  await updater.check({ force: true })
  assert.equal(reads, 2)
  const same = createHostUpdater({ resolve: supported('/x', '0.2.2'), latest: async () => ({ version: '0.2.2' }) })
  assert.equal((await same.check()).available, false)
  const older = createHostUpdater({ resolve: supported('/x', '0.2.2-rc.1'), latest: async () => ({ version: '0.2.1' }) })
  assert.equal((await older.check()).available, false, 'a prerelease ahead of latest is not downgraded')
})

test('a registry failure is unknown, not "up to date"', async () => {
  const updater = createHostUpdater({ resolve: supported('/x', '0.2.2'), latest: async () => { throw new Error('offline') } })
  assert.deepEqual(await updater.check(), { supported: true, installed: '0.2.2', latest: null, available: false, error: 'registry' })
  const unsupported = createHostUpdater({ resolve: async () => ({ supported: false, reason: 'not-global' }), latest: async () => { throw new Error('not asked') } })
  assert.deepEqual(await unsupported.check(), { supported: false, reason: 'not-global', available: false })
})

function fakeNpm(host, { code = 0, writes } = {}) {
  const calls = []
  const spawn = (command, args) => {
    calls.push(args)
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      if (writes) writeFileSync(join(host.dir, 'package.json'), JSON.stringify({ name: HOST_PACKAGE, version: writes }))
      child.stderr.emit('data', code ? 'npm ERR! boom' : '')
      child.emit('close', code)
    })
    return child
  }
  return { calls, spawn }
}

test('the install runs npm -g for exactly the offered version and checks the result', async () => {
  const host = globalRoot('0.2.2-rc.1')
  const npm = fakeNpm(host, { writes: '0.2.2' })
  const updater = createHostUpdater({ resolve: supported(host.dir, '0.2.2-rc.1'), latest: async () => ({ version: '0.2.2' }), spawn: npm.spawn })
  assert.equal((await updater.install('0.2.2')).message, 'not-offered', 'nothing installs before a check offered it')
  await updater.check()
  assert.equal((await updater.install('9.9.9')).message, 'not-offered', 'an arbitrary version is refused')
  assert.equal(await updater.install('0.2.2'), null)
  assert.deepEqual(npm.calls, [['install', '-g', '@deepseek-ai/dsh@0.2.2', '--no-fund', '--no-audit']])
})

test('a failed or mismatched install is reported with its output', async () => {
  const host = globalRoot('0.2.2-rc.1')
  const failing = createHostUpdater({ resolve: supported(host.dir, '0.2.2-rc.1'), latest: async () => ({ version: '0.2.2' }), spawn: fakeNpm(host, { code: 1 }).spawn })
  await failing.check()
  const error = await failing.install('0.2.2')
  assert.equal(error.message, 'install-failed')
  assert.match(error.output, /boom/)
  const silent = createHostUpdater({ resolve: supported(host.dir, '0.2.2-rc.1'), latest: async () => ({ version: '0.2.2' }), spawn: fakeNpm(host).spawn })
  await silent.check()
  assert.equal((await silent.install('0.2.2')).message, 'version-mismatch')
})

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
function systemctl() {
  const calls = []
  const spawn = (command, args) => {
    calls.push(args.join(' '))
    const child = new EventEmitter()
    setImmediate(() => child.emit('close', 0, null))
    return child
  }
  return { calls, spawn }
}

test('an update installs, then restarts; a failed install restarts nothing', async () => {
  Object.assign(restartState(), { seq: 0, phase: 'idle', reason: null })
  const ok = systemctl()
  let installed = null
  const controller = createRestartController({ ctx: { get: () => undefined }, unit: 'dsh-web.service', spawn: ok.spawn, defer: fn => setImmediate(fn),
    hostUpdater: { check: async () => ({}), install: async version => { installed = version; return null } } })
  assert.equal(controller.request('update', { version: '0.2.2' }).ok, true)
  assert.equal(controller.status().phase, 'updating')
  assert.deepEqual(controller.request('reload'), { ok: false, error: 'in-progress' })
  await settle()
  assert.equal(installed, '0.2.2')
  assert.equal(ok.calls.length, 2)

  Object.assign(restartState(), { seq: 0, phase: 'idle', reason: null })
  const none = systemctl()
  const failing = createRestartController({ ctx: { get: () => undefined }, unit: 'dsh-web.service', spawn: none.spawn, defer: fn => setImmediate(fn),
    hostUpdater: { check: async () => ({}), install: async () => new Error('install-failed') } })
  failing.request('update', { version: '0.2.2' })
  await settle()
  assert.deepEqual({ phase: failing.status().phase, reason: failing.status().reason }, { phase: 'failed', reason: 'update-install-failed' })
  assert.equal(none.calls.length, 0)
})

test('no unit, no DSH update: it would need a restart nobody can perform', async () => {
  const controller = createRestartController({ ctx: { get: () => undefined }, unit: null, hostUpdater: { check: async () => ({ available: true }) } })
  assert.deepEqual(controller.request('update', { version: '0.2.2' }), { ok: false, error: 'update-unavailable' })
  assert.equal(await controller.updateStatus(), null)
})
