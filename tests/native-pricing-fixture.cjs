'use strict'
const { createRequire } = require('node:module')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

// Verify against the installed Host dependency, independently of the plugin's
// catalog loader; a runtime upgrade must not require pinning an old version.
function hostPiVersion() {
  const host = createRequire(process.env.DSH_PACKAGE_DIR ? join(process.env.DSH_PACKAGE_DIR, 'package.json') : require.resolve('@deepseek-ai/dsh/package.json'))
  const adapter = createRequire(host.resolve('@deepseek-ai/dsh-llm-pi-ai'))
  const file = adapter.resolve.paths('@earendil-works/pi-ai')
    .map(base => join(base, '@earendil-works/pi-ai/package.json')).find(existsSync)
  if (!file) throw new Error('Host pi-ai manifest is unavailable')
  return JSON.parse(readFileSync(file, 'utf8')).version
}
module.exports = { hostPiVersion }
