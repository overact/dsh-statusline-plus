'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const load = () => import(pathToFileURL(resolve(__dirname, '../scripts/release-preflight.mjs')).href)
const job = conclusion => [{ steps: [{ name: 'Syntax and full test suite', conclusion: 'success' }, { name: 'Offline browser smoke check', conclusion }] }]

test('only a successful run whose browser step ran proves a commit', async () => {
  const { runProvesBrowser } = await load()
  assert.equal(runProvesBrowser({ status: 'completed', conclusion: 'success', jobs: job('success') }).ok, true)
  assert.match(runProvesBrowser({ status: 'completed', conclusion: 'success', jobs: job('skipped') }).detail, /skipped/, 'a push that skipped the UI proves nothing')
  assert.match(runProvesBrowser({ status: 'completed', conclusion: 'failure', jobs: job('failure') }).detail, /failure/)
  assert.match(runProvesBrowser({ status: 'in_progress', conclusion: '' }).detail, /running/)
  assert.match(runProvesBrowser(null).detail, /no Verify run/)
  assert.match(runProvesBrowser({ status: 'completed', conclusion: 'success', jobs: [] }).detail, /not found/)
})

test('any proving run wins over a newer one that skipped the browser step', async () => {
  const { bestRun } = await load()
  const skipped = { status: 'completed', conclusion: 'success', jobs: job('skipped') }
  const full = { status: 'completed', conclusion: 'success', jobs: job('success') }
  assert.equal(bestRun([skipped, full]), full)
  assert.equal(bestRun([skipped]), skipped)
  assert.equal(bestRun([]), null)
})
