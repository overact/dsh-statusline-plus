import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../', import.meta.url))

export function redact(value) {
  return String(value).replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]')
    .replace(/("(?:token|apiKey|access_token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[\w.~-]+/gi, '$1[redacted]')
}

export function excerpt(value, limit = 2400) {
  const safe = redact(value), failure = safe.search(/(?:not ok\b|Error:|ERR_)/)
  const text = failure < 0 ? safe.slice(-limit) : safe.slice(failure, failure + limit)
  return text.length < safe.length ? text + '\n[see log for remaining output]' : text
}

export function selectChecks(files, { all = false, ui = 'auto', styleOnly = false } = {}) {
  const tests = new Set(), panels = new Set()
  let full = all
  const add = (...names) => names.forEach(name => tests.add(`tests/${name}.test.js`))
  const mappings = {
    'model-pricing': ['model-pricing', 'session-metrics', 'dsh-integration'],
    'session-metrics': ['session-metrics', 'dsh-integration'],
    'peak-schedule': ['peak-schedule', 'peak', 'session-metrics'],
    'tps': ['tps', 'statusline', 'client-lifecycle'],
    'tool-activity': ['tool-activity', 'dsh-integration', 'client-lifecycle'],
    'request-pool': ['request-pool', 'statusline'],
    'provider-presets': ['provider-quota', 'statusline', 'client-lifecycle'],
  }
  for (const file of files) {
    if (file === 'lib/client.js') { add('client-lifecycle'); panels.add('all') }
    else if (file === 'package.json' || file === 'cordis.patch.yml' || file === 'lib/index.js') { full = true; panels.add('all') }
    else if (/^lib\/.+\.js$/.test(file)) {
      const mapped = mappings[file.slice(4, -3)]
      if (mapped) add(...mapped)
      else full = true
    } else if (/^tests\/.+\.test\.js$/.test(file)) tests.add(file)
    else if (file.startsWith('tests/')) full = true
    else if (file.startsWith('tools/ui/') || /^scripts\/(?:verify-ui|ui-fixture|screenshots)\.mjs$/.test(file)) panels.add('all')
    else if (/^scripts\/.*\.mjs$/.test(file)) add('verification')
  }
  if (styleOnly) {
    if (all || !files.length || files.some(file => file !== 'lib/client.js')) throw new Error('--style-only requires only lib/client.js; use it only for CSS edits')
    tests.clear(); full = false
  }
  const panel = ui === 'none' ? null : ui !== 'auto' ? ui : all || panels.size ? 'all' : null
  return { syntax: all || files.some(file => /\.(?:js|mjs|json|yml)$/.test(file)), full, tests: [...tests].sort(), panel }
}

export async function artifacts(base = 'output/playwright/verification') {
  const folder = resolve(root, base, new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(folder, { recursive: true })
  return folder
}

export async function runCheck(label, command, args, folder) {
  const started = performance.now()
  const result = await new Promise(resolveResult => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', truncated = false
    const collect = chunk => {
      if (output.length < 8 * 1024 * 1024) output += chunk.toString()
      else truncated = true
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.once('error', error => { collect(error.message); resolveResult({ code: 1, output }) })
    child.once('close', code => resolveResult({ code: code ?? 1, output: output + (truncated ? '\n[log size limit reached]' : '') }))
  })
  const log = resolve(folder, label + '.log')
  await writeFile(log, redact(result.output))
  const report = { check: label, ok: result.code === 0, durationMs: Math.round(performance.now() - started), log: relative(root, log) }
  if (report.ok && !result.output.trim()) {
    report.ok = false
    report.error = 'The subprocess returned no report; check execution permissions and inspect the log'
  }
  const count = result.output.match(/^# tests (\d+)$/m)
  if (count) report.tests = Number(count[1])
  if (label === 'tests' && report.ok && (!count || Number(count[1]) === 0)) {
    report.ok = false
    report.error = 'The test process produced no test summary; inspect the log before treating the check as passed'
  }
  if (!report.ok && !report.error) report.error = excerpt(result.output)
  if (label === 'ui' && report.ok) {
    try {
      const ui = JSON.parse(result.output.trim())
      if (!ui.ok) { report.ok = false; report.error = excerpt(ui.error || 'UI verification failed') }
      else report.panels = ui.checks
    } catch { report.ok = false; report.error = 'UI subprocess returned no valid JSON report' }
  }
  return report
}
