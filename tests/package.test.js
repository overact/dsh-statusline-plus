const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, statSync } = require('node:fs')
const { resolve, relative } = require('node:path')

test('source checkout contains every declared bundle and module entry', () => {
  const root = resolve(__dirname, '..')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const patches = [].concat(pkg.dsh?.bundle?.patch || [])
  assert.ok(patches.length, 'An installable DSH bundle needs a patch')
  for (const file of [pkg.main, pkg.exports['.'], pkg.exports['./client'], ...patches]) {
    assert.equal(typeof file, 'string')
    const target = resolve(root, file)
    assert.ok(!relative(root, target).startsWith('..'), 'Package entry must stay inside the checkout')
    assert.ok(statSync(target).isFile(), 'Missing distributed entry: ' + file)
  }
})
