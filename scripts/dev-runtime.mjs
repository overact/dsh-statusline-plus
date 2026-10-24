#!/usr/bin/env node
/**
 * Report whether the active DSH profile hot-reloads this checkout.
 *
 * A linked plugin only needs a Host restart when the profile's `hmr` layer does
 * not watch its `lib/`. Read that profile config instead of assuming either way.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-statusline-plus'

function stripComment(value) {
  const hash = value.indexOf('#')
  return (hash === -1 ? value : value.slice(0, hash)).trim()
}

function unquote(value) {
  const text = stripComment(value)
  if (text.length >= 2 && (text[0] === '"' && text.at(-1) === '"' || text[0] === "'" && text.at(-1) === "'")) {
    return text.slice(1, -1)
  }
  return text
}

function resolveRoot(value, base) {
  const text = unquote(value)
  if (!text) return null
  const expanded = text === '~' ? homedir() : text.startsWith('~/') ? resolve(homedir(), text.slice(2)) : text
  return resolve(base, expanded)
}

/**
 * Extract the `root:` entries of every `id: hmr` block.
 * The profile patch is small YAML; this reads only the hmr roots rather than
 * taking a YAML dependency for one lookup.
 */
export function parseHmrRoots(text, profileDir) {
  const lines = String(text || '').split(/\r?\n/)
  const roots = []
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].match(/^(\s*)-\s+id:\s*hmr\s*$/)
    if (!start) continue
    const blockIndent = start[1].length
    let base = profileDir
    let rootIndent = null
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim() || line.trim().startsWith('#')) continue
      const indent = line.match(/^\s*/)[0].length
      if (indent <= blockIndent) break
      const baseMatch = line.match(/^\s*base:\s*(.+?)\s*$/)
      if (baseMatch) {
        const value = unquote(baseMatch[1])
        base = resolveRoot(value, profileDir) || profileDir
        continue
      }
      const rootMatch = line.match(/^\s*root:\s*(.*)$/)
      if (rootMatch) {
        rootIndent = indent
        const inline = stripComment(rootMatch[1])
        if (inline.startsWith('[') && inline.endsWith(']')) {
          for (const part of inline.slice(1, -1).split(',')) {
            const root = resolveRoot(part, base)
            if (root) roots.push(root)
          }
        }
        continue
      }
      if (rootIndent !== null && indent > rootIndent) {
        const item = line.match(/^\s*-\s*(.+?)\s*$/)
        if (item) {
          const root = resolveRoot(item[1], base)
          if (root) roots.push(root)
        }
        continue
      }
      if (rootIndent !== null) rootIndent = null
    }
  }
  return roots
}

export function coversPath(roots, target) {
  const normalized = resolve(target)
  return roots.some(root => {
    const normalizedRoot = resolve(root)
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + sep)
  })
}

export function resolveProfileDir(explicit) {
  return resolve(explicit || process.env.DSH_PROFILE_DIR || resolve(homedir(), '.dsh/profiles/web'))
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** Resolve the profile's dependency entry and, when present, its node_modules link. */
export function readProfileLink(profileDir, name = PLUGIN_NAME) {
  const pkg = readJson(resolve(profileDir, 'package.json'))
  const spec = pkg && pkg.dependencies && pkg.dependencies[name]
  let target = null
  if (typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))) {
    target = resolve(profileDir, spec.slice(5))
  }
  try {
    const real = realpathSync(resolve(profileDir, 'node_modules', name))
    if (real) target = real
  } catch { /* not installed under this profile */ }
  return { spec: typeof spec === 'string' ? spec : null, target }
}

function parseArgs(argv) {
  const args = { profile: '', json: false, check: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') args.json = true
    else if (arg === '--check') args.check = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--profile') args.profile = argv[++i] || ''
    else if (arg.startsWith('--profile=')) args.profile = arg.slice('--profile='.length)
    else throw new Error('unknown argument: ' + arg)
  }
  return args
}

function usage() {
  return [
    'Usage: npm run dev:runtime -- [--profile <dir>] [--json] [--check]',
    '',
    'Reports whether the active DSH profile hot-reloads this checkout.',
    '--profile  profile directory (default: DSH_PROFILE_DIR or ~/.dsh/profiles/web)',
    '--json     machine-readable result',
    '--check    exit 1 when the profile does not watch this checkout lib/',
  ].join('\n')
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) { console.log(usage()); return 0 }
  const profileDir = resolveProfileDir(args.profile)
  const patchPath = resolve(profileDir, 'cordis.patch.yml')
  let text
  try { text = readFileSync(patchPath, 'utf8') } catch (error) {
    console.error('Cannot read profile patch: ' + patchPath)
    console.error(error && error.message ? error.message : String(error))
    return 2
  }
  const libPath = resolve(REPO_ROOT, 'lib')
  const roots = parseHmrRoots(text, profileDir)
  const active = coversPath(roots, libPath)
  const link = readProfileLink(profileDir)
  const linkMatches = link.target ? resolve(link.target) === REPO_ROOT : false
  const result = { profileDir, patchPath, checkout: REPO_ROOT, libPath, roots, active, link, linkMatches }

  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log('Profile:  ' + profileDir)
    console.log('Checkout: ' + REPO_ROOT)
    console.log('Link:     ' + (link.target ? link.target + (linkMatches ? ' (matches checkout)' : ' (different checkout)') : 'not found in profile dependencies'))
    console.log('HMR:      ' + (active ? 'active for ' + libPath : 'not covering ' + libPath))
    if (roots.length) console.log('Roots:    ' + roots.join(', '))
    console.log(active
      ? 'Result:   host-side edits hot-reload; no restart needed.'
      : 'Result:   restart the Host after host-side changes, or add this checkout to the profile hmr roots.')
  }
  return args.check && !active ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (error) {
    console.error(error && error.message ? error.message : String(error))
    process.exitCode = 2
  }
}
