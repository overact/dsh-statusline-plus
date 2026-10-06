import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { artifacts, excerpt, root, runCheck, selectChecks } from './verification.mjs'

function options(args) {
  const value = { files: [], all: false, ui: 'auto', styleOnly: false, plan: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--files') {
      const first = value.files.length
      while (args[i + 1] && !args[i + 1].startsWith('--')) value.files.push(args[++i])
      if (first === value.files.length) throw new Error('--files requires paths relative to the project')
    } else if (arg === '--all') value.all = true
    else if (arg === '--ui') value.ui = args[++i]
    else if (arg === '--style-only') value.styleOnly = true
    else if (arg === '--plan') value.plan = true
    else throw new Error('Unknown option: ' + arg)
  }
  if (!['auto', 'none', 'cost', 'subagents', 'responsive', 'all'].includes(value.ui)) throw new Error('--ui must be auto, none, cost, subagents, responsive or all')
  if (value.styleOnly && value.ui === 'none') throw new Error('--style-only keeps the browser check enabled')
  if (value.files.some(file => file.startsWith('/') || file.split('/').includes('..'))) throw new Error('--files paths must stay inside the project')
  return value
}

try {
  const opts = options(process.argv.slice(2))
  const files = opts.files.length ? opts.files.map(file => file.replace(/^\.\//, '')) : [...new Set([
    ...execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\0'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'),
  ].filter(file => file && !file.startsWith('.claude/') && !file.startsWith('output/')))]
  const plan = selectChecks(files, opts)
  if (plan.tests.some(file => !existsSync(resolve(root, file)))) plan.full = true
  if (opts.plan) console.log(JSON.stringify({ ok: true, files, ...plan }))
  else {
    const folder = await artifacts(), checks = []
    const run = async (label, command, args) => {
      const report = await runCheck(label, command, args, folder)
      checks.push(report)
      if (!report.ok) throw new Error(report.error)
    }
    try {
      if (plan.syntax) await run('syntax', 'npm', ['run', 'check'])
      if (plan.full) await run('tests', 'npm', ['test'])
      else if (plan.tests.length) await run('tests', process.execPath, ['--test', '--test-reporter=tap', '--experimental-test-isolation=none', ...plan.tests])
      if (plan.panel) await run('ui', process.execPath, ['scripts/verify-ui.mjs', '--panel', plan.panel, '--output', folder])
      console.log(JSON.stringify({ ok: true, files, checks }))
    } catch {
      console.log(JSON.stringify({ ok: false, files, checks })); process.exitCode = 1
    }
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: excerpt(error.message) })); process.exitCode = 1
}
