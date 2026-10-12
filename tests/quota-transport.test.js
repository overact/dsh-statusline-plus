'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const http = require('node:http')
const { getGlobalDispatcher } = require('undici')
const { createQuotaDispatcher } = require('../lib/quota-transport.js')

test('quota dispatcher applies its local connection window, reuses connections and honors cancellation', async t => {
  const defaults = [net.getDefaultAutoSelectFamily(), net.getDefaultAutoSelectFamilyAttemptTimeout(), getGlobalDispatcher()]
  const parallel = []
  const agent = createQuotaDispatcher(), server = http.createServer((req, res) => {
    if (req.url === '/parallel') {
      parallel.push(res)
      if (parallel.length === 3) parallel.forEach(response => response.end('{"ok":true}'))
    } else if (req.url !== '/pending') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}') }
  })
  const connections = [], originalConnect = net.connect
  t.mock.method(net, 'connect', function (options, ...args) {
    if (Number(options.port) === server.address()?.port) connections.push(options)
    return originalConnect.call(this, options, ...args)
  })
  t.after(async () => { await agent.destroy(); await new Promise(resolve => server.close(resolve)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port
  for (let i = 0; i < 3; i++) {
    const response = await fetch(url, { dispatcher: agent })
    assert.deepEqual(await response.json(), { ok: true })
  }
  assert.ok(connections.length > 0 && connections.length < 3, 'three sequential requests reuse connections')
  assert.ok(connections.every(options => options.autoSelectFamily && options.autoSelectFamilyAttemptTimeout === 5000),
    'actual Node socket calls receive the plugin connection window')
  assert.deepEqual([net.getDefaultAutoSelectFamily(), net.getDefaultAutoSelectFamilyAttemptTimeout(), getGlobalDispatcher()], defaults,
    'the Host defaults and global dispatcher are untouched')
  const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(url + '/parallel', {
    dispatcher: agent, signal: AbortSignal.timeout(1000),
  }).then(response => response.json())))
  assert.equal(responses.length, 3, 'the existing three-account fanout is not serialized by the connection pool')
  await assert.rejects(fetch(url + '/pending', { dispatcher: agent, signal: AbortSignal.timeout(30) }), { name: 'TimeoutError' })
  await agent.destroy()
  assert.equal(agent.destroyed, true)
  await assert.rejects(fetch(url, { dispatcher: agent }), 'a disposed plugin cannot open another connection')
})
