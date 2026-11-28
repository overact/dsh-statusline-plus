'use strict'
// Reading a provider's connection out of DSH's own settings. The shapes below are
// the ones the installed Host publishes (verified against
// /home/feng/.dsh/profiles/web/cordis.patch.yml and the llm package schemas), so a
// shape change here is a shape change in the Host.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { connectionFor, sectionsOf, originOf } = require('../lib/provider-defaults.js')

function describeOf(...sections) {
  return { describe: () => sections }
}

const piAi = {
  ns: 'llm-pi-ai',
  value: { providers: { 'magpie-workbuddy': { baseURL: 'http://127.0.0.1:3425/v1', apiKeyEnv: 'MAGPIE_GATEWAY_KEY' } } },
}
const deepseek = {
  ns: 'llm-deepseek-api-key',
  value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/anthropic' },
}

test('a pi-ai provider gives its credential reference and its origin', () => {
  const found = connectionFor(sectionsOf(describeOf(piAi, deepseek)), 'magpie-workbuddy')
  assert.deepEqual(found, { apiKeyEnv: 'MAGPIE_GATEWAY_KEY', baseURL: 'http://127.0.0.1:3425', source: 'pi-ai' })
})

test('the DeepSeek row answers for its own routes, with the probe-able origin', () => {
  // The configured base URL is the Anthropic-compatible endpoint; a wallet probe
  // needs the origin, not `/anthropic`.
  for (const route of ['deepseek', 'deepseek-account', 'deepseek-official']) {
    const found = connectionFor(sectionsOf(describeOf(piAi, deepseek)), route)
    assert.deepEqual(found, { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', source: 'deepseek' }, route)
  }
})

test('an unknown route is not filled from somebody else\u2019s settings', () => {
  // A pi-ai section listing other providers must not lend its key to this route.
  assert.equal(connectionFor(sectionsOf(describeOf(piAi, deepseek)), 'acme-gateway'), null)
  assert.equal(connectionFor(sectionsOf(describeOf(piAi)), ''), null)
  assert.equal(connectionFor(sectionsOf(describeOf(piAi)), 'magpie-workbuddy/../../etc'), null)
})

test('a Host without describe(), or a throwing one, answers nothing instead of guessing', () => {
  assert.deepEqual(sectionsOf(null), [])
  assert.deepEqual(sectionsOf({}), [])
  assert.deepEqual(sectionsOf({ describe: () => { throw new Error('not ready') } }), [])
  assert.equal(connectionFor([], 'deepseek'), null)
})

test('a credential-shaped field is recognised without the apiKeyEnv name', () => {
  const odd = { ns: 'llm-deepseek', value: { tokenEnv: 'MY_DS_KEY', baseURL: 'https://api.deepseek.com/v1' } }
  const found = connectionFor(sectionsOf(describeOf(odd)), 'deepseek')
  assert.equal(found.baseURL, 'https://api.deepseek.com')
  // The value is a credential name whichever field carries it, so it is offered
  // under our own name rather than dropped.
  assert.equal(found.apiKeyEnv, 'MY_DS_KEY')
  assert.equal(found.source, 'deepseek')
})

test('a base URL that is not a URL yields no origin rather than a broken link', () => {
  assert.equal(originOf('not a url'), '')
  assert.equal(originOf(''), '')
  assert.equal(originOf(undefined), '')
  assert.equal(originOf('https://api.deepseek.com/v1/'), 'https://api.deepseek.com')
})
