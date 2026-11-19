'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { runHostUpdate, validateSpec } = require('../lib/host-update-runner.js')

function tempDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'slp-runner-')))
}

function specFor(root, overrides = {}) {
  return {
    id: 'job-1',
    version: '0.2.2',
    previousVersion: '0.2.2-rc.1',
    unit: 'dsh-web.service',
    profile: 'web',
    profileDir: root,
    root,
    prefix: root,
    node: 'node',
    npm: 'npm',
    systemctl: 'systemctl',
    jobPath: join(root, 'job.json'),
    logPath: join(root, 'update.log'),
    reconcile: true,
    hostPid: 7,
    env: {},
    ...overrides,
  }
}

/**
 * A fake command runner. `npm install` writes the requested version's manifest
 * into the fake global root; `systemctl show` reports a running process.
 */
function scripted({ failInstall = false, failReconcile = false, failStop = false, health = 'active', writesVersion } = {}) {
  const calls = []
  let clock = 0
  let rolledBack = false
  let reconcileCalls = 0
  const state = { health }
  const run = async (command, args) => {
    calls.push([command, ...args])
    if (command === 'systemctl') {
      if (args.includes('stop') && failStop) return { code: 1, output: 'Failed to stop dsh-web.service: timeout' }
      if (args.includes('show')) {
        if (state.health === 'failed' && !rolledBack) return { code: 0, output: 'ActiveState=failed\nSubState=failed\nMainPID=0\n' }
        return { code: 0, output: 'ActiveState=active\nSubState=running\nMainPID=42\n' }
      }
      return { code: 0, output: '' }
    }
    if (command === 'npm' && args[0] === 'install') {
      if (failInstall) return { code: 1, output: 'npm ERR! boom' }
      const install = args.find(arg => arg.startsWith('@deepseek-ai/dsh@'))
      const requested = install.slice('@deepseek-ai/dsh@'.length)
      const version = requested === '0.2.2' && writesVersion ? writesVersion : requested
      if (requested === '0.2.2-rc.1') rolledBack = true
      const root = args[args.indexOf('--prefix') + 1]
      const dir = join(root, '@deepseek-ai', 'dsh')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
      return { code: 0, output: '' }
    }
    if (command === 'node' && args[0] && args[0].endsWith(join('@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      reconcileCalls += 1
      return failReconcile && reconcileCalls === 1 ? { code: 1, output: 'pnpm ERR! reconcile' } : { code: 0, output: '' }
    }
    throw new Error('unexpected command: ' + command + ' ' + args.join(' '))
  }
  return {
    calls,
    run,
    sleep: async ms => { clock += ms },
    now: () => clock,
  }
}

test('a clean update stops, installs, reconciles the profile, starts and verifies', async () => {
  const root = tempDir()
  const fake = scripted()
  const result = await runHostUpdate(specFor(root), fake)
  assert.equal(result.ok, true)
  const job = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'))
  assert.equal(job.phase, 'healthy')
  assert.equal(job.rolledBack, undefined)
  const install = fake.calls.find(call => call[0] === 'npm')
  assert.ok(install.includes('@deepseek-ai/dsh@0.2.2'))
  assert.ok(install.includes('--prefix'))
  assert.ok(install.includes(root))
  const reconcile = fake.calls.find(call => call[0] === 'node')
  assert.ok(reconcile.includes('plugin'))
  assert.ok(reconcile.includes('--profile'))
  assert.ok(reconcile.includes('web'))
  assert.ok(reconcile.includes('install'))
  assert.ok(fake.calls.some(call => call[0] === 'systemctl' && call.includes('stop')))
  assert.ok(fake.calls.some(call => call[0] === 'systemctl' && call.includes('start')))
})

test('a failed install never runs the profile reconcile and puts the old service back', async () => {
  const root = tempDir()
  const fake = scripted({ failInstall: true })
  const result = await runHostUpdate(specFor(root), fake)
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, false)
  const job = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'))
  assert.equal(job.phase, 'failed')
  assert.equal(job.error, 'install-failed')
  assert.equal(job.restored, true)
  assert.equal(fake.calls.some(call => call[0] === 'node'), false, 'nothing reconciles a version that did not install')
  assert.ok(fake.calls.some(call => call[0] === 'systemctl' && call.includes('start')))
})

test('a stop that times out still tries to put the old service back', async () => {
  const root = tempDir()
  const fake = scripted({ failStop: true })
  const result = await runHostUpdate(specFor(root), fake)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'stop-failed')
  const job = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'))
  assert.equal(job.phase, 'failed')
  assert.equal(job.error, 'stop-failed')
  assert.equal(job.restored, true)
  assert.ok(fake.calls.some(call => call[0] === 'systemctl' && call.includes('start')))
})

test('a failed profile reconcile rolls the previous version back and starts it', async () => {
  const root = tempDir()
  const fake = scripted({ failReconcile: true })
  const result = await runHostUpdate(specFor(root), fake)
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  const job = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'))
  assert.equal(job.phase, 'rolled-back')
  assert.equal(job.error, 'profile-reconcile-failed')
  const installs = fake.calls.filter(call => call[0] === 'npm')
  assert.ok(installs.some(call => call.includes('@deepseek-ai/dsh@0.2.2-rc.1')), 'the previous version is reinstalled')
  assert.equal(fake.calls.filter(call => call[0] === 'node').length, 2, 'the profile is reconciled again with the old CLI')
})

test('an unhealthy new process rolls back instead of leaving the unit down', async () => {
  const root = tempDir()
  const fake = scripted({ health: 'failed' })
  const result = await runHostUpdate(specFor(root), fake)
  assert.equal(result.rolledBack, true)
  const job = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'))
  assert.equal(job.phase, 'rolled-back')
  assert.equal(job.error, 'unhealthy')
})

test('a missing pnpm skips only the profile reconcile and still verifies the host', async () => {
  const root = tempDir()
  const fake = scripted()
  const original = fake.run
  fake.run = async (command, args) => {
    if (command === 'node') return { code: 127, output: 'dsh: pnpm was not found' }
    return original(command, args)
  }
  const result = await runHostUpdate(specFor(root), fake)
  assert.equal(result.ok, true)
  const job = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'))
  assert.equal(job.reconcileSkipped, 'pnpm-not-found')
  assert.equal(job.phase, 'healthy')
})

test('a mismatched installed version is treated as a failed install and rolled back', async () => {
  const root = tempDir()
  const fake = scripted({ writesVersion: '0.2.1' })
  const result = await runHostUpdate(specFor(root), fake)
  assert.equal(result.rolledBack, true)
  const job = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'))
  assert.equal(job.error, 'version-mismatch')
})

test('no profile reconcile means no dsh plugin command at all', async () => {
  const root = tempDir()
  const fake = scripted()
  const result = await runHostUpdate(specFor(root, { reconcile: false, profile: null, profileDir: null }), fake)
  assert.equal(result.ok, true)
  assert.equal(fake.calls.some(call => call[0] === 'node'), false)
})

test('the spec rejects a version, unit or profile that could reach a shell boundary', () => {
  assert.throws(() => validateSpec(specFor('/tmp', { version: '0.2.2; rm -rf /' })), /invalid-version/)
  assert.throws(() => validateSpec(specFor('/tmp', { unit: 'bad unit' })), /invalid-unit/)
  assert.throws(() => validateSpec(specFor('/tmp', { profile: '../web' })), /invalid-profile/)
  assert.throws(() => validateSpec(specFor('/tmp', { root: 'relative' })), /invalid-spec/)
  assert.throws(() => validateSpec(specFor('/tmp', { prefix: 'relative' })), /invalid-spec/)
})
