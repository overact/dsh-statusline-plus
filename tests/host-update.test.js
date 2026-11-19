'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { HOST_PACKAGE, hostPackageDir, resolveHostInstall, createHostUpdater, globalPrefix, updatePath } = require('../lib/host-update.js')
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

const supported = (dir, version, root = '/x') => async () => ({ supported: true, dir, root, version })

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

function tempPaths() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slp-update-')))
  return { dir, job: join(dir, 'job.json'), spec: join(dir, 'spec.json'), log: join(dir, 'update.log') }
}

function fakeLaunch({ code = 0, output = '' } = {}) {
  const calls = []
  const launch = async (command, args) => { calls.push([command, ...args]); return { code, output } }
  return { calls, launch }
}

function fakeExec({ available = true } = {}) {
  return async (command, args) => {
    if (command === 'systemd-run' && args[0] === '--version') {
      if (!available) throw new Error('ENOENT')
      return 'systemd 259'
    }
    throw new Error('unexpected command: ' + command)
  }
}

test('an update starts one transient systemd helper for the offered version', async () => {
  const host = globalRoot('0.2.2-rc.1')
  const paths = tempPaths()
  const launch = fakeLaunch()
  const updater = createHostUpdater({
    resolve: supported(host.dir, '0.2.2-rc.1', host.root),
    latest: async () => ({ version: '0.2.2' }),
    exec: fakeExec(),
    runCommand: launch.launch,
    paths,
  })
  assert.equal((await updater.start({ version: '0.2.2', unit: 'dsh-web.service' })).error, 'not-offered', 'nothing starts before a check offered it')
  await updater.check()
  assert.equal((await updater.start({ version: '9.9.9', unit: 'dsh-web.service' })).error, 'not-offered', 'an arbitrary version is refused')
  writeFileSync(paths.log, 'old run\n')
  const started = await updater.start({ version: '0.2.2', unit: 'dsh-web.service', jobId: 'job-1', profile: { name: 'web', dir: host.dir } })
  assert.equal(started.ok, true)
  assert.equal(started.jobId, 'job-1')
  assert.equal(launch.calls.length, 1)
  const [command, ...args] = launch.calls[0]
  assert.equal(command, 'systemd-run')
  assert.ok(args.includes('--user'))
  assert.ok(args.includes('--no-block'))
  assert.ok(args.includes('--unit=statusline-update-job-1'))
  assert.equal(args[args.length - 1], paths.spec)
  const spec = JSON.parse(readFileSync(paths.spec, 'utf8'))
  assert.equal(spec.version, '0.2.2')
  assert.equal(spec.previousVersion, '0.2.2-rc.1')
  assert.equal(spec.unit, 'dsh-web.service')
  assert.equal(spec.profile, 'web')
  assert.equal(spec.reconcile, true)
  assert.equal(spec.root, host.root)
  assert.equal(spec.prefix, globalPrefix(host.root))
  assert.equal(globalPrefix('/home/u/.npm-global/lib/node_modules'), '/home/u/.npm-global')
  assert.equal(globalPrefix('/usr/local/lib/node_modules'), '/usr/local')
  const path = updatePath({ PATH: '/usr/bin', HOME: '/home/u' }, '/opt/node/bin/node')
  assert.ok(path.split(':').includes('/home/u/.local/bin'))
  assert.ok(path.split(':').includes('/opt/node/bin'))
  assert.ok(path.split(':').includes('/usr/bin'))
  assert.equal(updatePath({ PATH: '/a:/home/u/.local/bin', HOME: '/home/u' }, '/opt/node/bin/node').split(':').filter(item => item === '/home/u/.local/bin').length, 1)
  assert.match(spec.npm, /npm$/)
  assert.equal(updater.readJob().id, 'job-1')
  assert.equal(updater.readJob().phase, 'queued')
  assert.equal(readFileSync(paths.log, 'utf8'), '', 'the run log is truncated at start')
})

test('an unavailable helper or a failed launch is recorded, never guessed', async () => {
  const host = globalRoot('0.2.2-rc.1')
  const noHelper = createHostUpdater({
    resolve: supported(host.dir, '0.2.2-rc.1', host.root),
    latest: async () => ({ version: '0.2.2' }),
    exec: fakeExec({ available: false }),
    runCommand: fakeLaunch().launch,
    paths: tempPaths(),
  })
  await noHelper.check()
  assert.equal((await noHelper.start({ version: '0.2.2', unit: 'dsh-web.service' })).error, 'no-systemd-run')

  const paths = tempPaths()
  const failing = createHostUpdater({
    resolve: supported(host.dir, '0.2.2-rc.1', host.root),
    latest: async () => ({ version: '0.2.2' }),
    exec: fakeExec(),
    runCommand: fakeLaunch({ code: 1, output: 'unit refused' }).launch,
    paths,
  })
  await failing.check()
  const result = await failing.start({ version: '0.2.2', unit: 'dsh-web.service', jobId: 'job-2' })
  assert.equal(result.error, 'helper-start')
  assert.equal(failing.readJob().phase, 'failed')
  assert.equal(failing.readJob().error, 'helper-start')
  assert.match(failing.readJob().output, /unit refused/)
})

test('the start validates the unit and the newer installed version', async () => {
  let installed = '0.2.2-rc.1'
  const updater = createHostUpdater({
    resolve: async () => ({ supported: true, dir: '/x', root: '/x', version: installed }),
    latest: async () => ({ version: '0.2.2' }),
    exec: fakeExec(),
    runCommand: fakeLaunch().launch,
    paths: tempPaths(),
  })
  await updater.check()
  assert.equal((await updater.start({ version: '0.2.2', unit: 'not a unit' })).error, 'no-unit')
  installed = '0.2.2'
  assert.equal((await updater.start({ version: '0.2.2', unit: 'dsh-web.service' })).error, 'not-newer')
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

test('an update starts the helper and leaves systemctl to it; a refused start stays in the Host', async () => {
  Object.assign(restartState(), { seq: 0, phase: 'idle', reason: null })
  const none = systemctl()
  let started = null
  const controller = createRestartController({ ctx: { get: () => undefined }, unit: 'dsh-web.service', spawn: none.spawn, defer: fn => setImmediate(fn),
    hostUpdater: {
      check: async () => ({}),
      start: async options => { started = options; return { ok: true, jobId: 'job-1' } },
      readJob: () => ({ id: 'job-1', phase: 'queued' }),
    } })
  const requested = controller.request('update', { version: '0.2.2' })
  assert.equal(requested.ok, true)
  assert.equal(typeof requested.jobId, 'string')
  assert.equal(controller.status().phase, 'updating')
  assert.deepEqual(controller.status().job, { id: 'job-1', phase: 'queued' })
  assert.deepEqual(controller.request('reload'), { ok: false, error: 'in-progress' })
  await settle()
  assert.equal(started.version, '0.2.2')
  assert.equal(none.calls.length, 0, 'the Host does not run systemctl for an update')

  Object.assign(restartState(), { seq: 0, phase: 'idle', reason: null })
  const failing = createRestartController({ ctx: { get: () => undefined }, unit: 'dsh-web.service', spawn: none.spawn, defer: fn => setImmediate(fn),
    hostUpdater: { check: async () => ({}), start: async () => ({ ok: false, error: 'install-failed' }) } })
  failing.request('update', { version: '0.2.2' })
  await settle()
  assert.deepEqual({ phase: failing.status().phase, reason: failing.status().reason }, { phase: 'failed', reason: 'update-install-failed' })
})

test('no unit, no DSH update: it would need a restart nobody can perform', async () => {
  const controller = createRestartController({ ctx: { get: () => undefined }, unit: null, hostUpdater: { check: async () => ({ available: true }) } })
  assert.deepEqual(controller.request('update', { version: '0.2.2' }), { ok: false, error: 'update-unavailable' })
  assert.equal(await controller.updateStatus(), null)
})
