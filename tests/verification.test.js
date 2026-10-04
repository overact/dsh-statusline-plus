'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { selectChecks, excerpt, redact } = require('../scripts/verification.mjs')

test('check selection keeps pricing dependencies, native integration and the requested UI scope', () => {
  const pricing = selectChecks(['lib/model-pricing.js'])
  assert.deepEqual(pricing.tests, ['tests/dsh-integration.test.js', 'tests/model-pricing.test.js', 'tests/session-metrics.test.js'])
  assert.equal(pricing.panel, null)
  const client = selectChecks(['lib/client.js'], { ui: 'cost' })
  assert.deepEqual(client.tests, ['tests/client-lifecycle.test.js'])
  assert.equal(client.panel, 'cost')
})

test('unknown runtime files, manifest edits and completion checks use the whole suite', () => {
  assert.equal(selectChecks(['lib/new-service.js']).full, true)
  assert.equal(selectChecks(['package.json']).full, true)
  const full = selectChecks([], { all: true })
  assert.equal(full.full, true)
  assert.equal(full.syntax, true)
  assert.equal(full.panel, 'all')
})

test('style-only checks retain UI verification and reject broader file scopes', () => {
  const style = selectChecks(['lib/client.js'], { styleOnly: true, ui: 'cost' })
  assert.deepEqual(style.tests, [])
  assert.equal(style.panel, 'cost')
  assert.throws(() => selectChecks(['lib/client.js', 'lib/session-metrics.js'], { styleOnly: true }))
  assert.throws(() => selectChecks([], { all: true, styleOnly: true }))
})

test('documentation changes do not trigger tests or a browser', () => {
  const docs = selectChecks(['README.md', 'AGENTS.md'])
  assert.equal(docs.syntax, false)
  assert.equal(docs.full, false)
  assert.equal(docs.panel, null)
  assert.deepEqual(docs.tests, [])
})

test('failure summaries cap long single lines and redact credentials', () => {
  const output = 'x'.repeat(10000) + '\nError: https://localhost/?token=secret-value Bearer bearer-value\n' + 'y'.repeat(10000)
  const result = excerpt(output, 200)
  assert.ok(result.length < 300)
  assert.match(result, /Error:/)
  assert.doesNotMatch(result, /secret-value|bearer-value/)
  assert.equal(redact('{"token":"hidden"}'), '{"token":"[redacted]"}')
})
