'use strict'
// Test-only access to module internals. The Host no longer carries a test API.
module.exports = {
  ...require('../lib/config'),
  ...require('../lib/session-log'),
  ...require('../lib/quota-http'),
  ...require('../lib/git-status'),
  ...require('../lib/quota-codex'),
  ...require('../lib/quota-antigravity'),
  ...require('../lib/quota-magpie'),
  ...require('../lib/quota-claude'),
  ...require('../lib/quota-providers'),
  ...require('../lib/quota-order'),
  ...require('../lib/cpa-credentials'),
  ...require('../lib/tps'),
}
