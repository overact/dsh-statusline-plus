// Syntax-check every shipped module and project script, so a new lib/ file can
// never be left out of `npm run check`.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './verification.mjs'

const files = [
  ...readdirSync(join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => join('lib', name)),
  ...readdirSync(join(root, 'scripts')).filter(name => name.endsWith('.mjs')).map(name => join('scripts', name)),
].sort()
for (const file of files) execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' })
console.log('syntax ok: ' + files.length + ' files')
