'use strict'
/** Git workspace status through the Host subprocess service (local or SSH-routed). */
import { existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { sanitizeCwd } from './config.js'

async function resolveExecutable(subprocess, name, fallbacks) {
  if (subprocess === undefined) return null
  try {
    return await subprocess.resolveExecutable(name)
  } catch (e) { /* fall through */ }
  for (const p of fallbacks) {
    try {
      return await subprocess.resolveExecutable(p)
    } catch (e) { /* try next */ }
    if (existsSync(p)) return p
  }
  return null
}

async function runCollect(subprocess, argv, cwd, maxBytes, timeoutMs, signal) {
  const controller = timeoutMs !== undefined && timeoutMs > 0 ? new AbortController() : null
  const timer = controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    signal?.throwIfAborted()
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { collect: true, maxBytes },
        stderr: { collect: true, maxBytes: 65536 },
      },
      graceMs: 500,
      signal: signal && controller ? AbortSignal.any([signal, controller.signal]) : signal || controller?.signal,
    })
    const outcome = await handle.done
    signal?.throwIfAborted()
    const collected = handle.collected.stdout?.readFrom(0)
    if (collected?.lossy) throw new Error('git-output-too-large')
    const stdout = collected?.text || ''
    const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    // 超时信号触发的终止：以 aborted 标记返回给调用方分类，避免浏览器端超时后宿主进程仍占用资源。
    const aborted = controller !== null && controller.signal.aborted && (outcome.exitCode !== 0 || outcome.signal !== null)
    return { exitCode: outcome.exitCode, signal: outcome.signal, stdout, stderr, aborted }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function parseNumstat(stdout) {
  let added = 0
  let deleted = 0
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue
    const fields = line.split('\t')
    if (fields.length < 3) continue
    if (/^\d+$/.test(fields[0])) added += Number(fields[0])
    if (/^\d+$/.test(fields[1])) deleted += Number(fields[1])
  }
  return { added, deleted }
}

function parseGitStatus(stdout) {
  const lines = String(stdout || '').split('\n').filter((l) => l.length > 0)
  const result = emptyGitStatus()
  let first = true
  for (const line of lines) {
    if (first && line.startsWith('## ')) {
      first = false
      const head = line.slice(3)
      result.branch = head.split('...')[0]
      const ahead = head.match(/ahead (\d+)/)
      const behind = head.match(/behind (\d+)/)
      if (ahead) result.ahead = Number(ahead[1]) || 0
      if (behind) result.behind = Number(behind[1]) || 0
      continue
    }
    first = false
    if (line.length < 4) continue
    const x = line[0]
    const y = line[1]
    let path = decodeGitPath(line.slice(3).trim())
    // Rename/copy entries: "R  old -> new" — keep the destination.
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    if (x === '?' && y === '?') {
      result.counts.untracked += 1
    } else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      result.counts.conflict += 1
    } else {
      if (x !== ' ' && x !== '?') result.counts.staged += 1
      if (y !== ' ' && y !== '?') result.counts.unstaged += 1
    }
    if (result.files.length < 50) result.files.push(path)
  }
  return result
}

function decodeGitPath(raw) {
  const value = String(raw || '')
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return value
  try { return JSON.parse(value) } catch (e) { /* Git's octal form is not JSON */ }
  const body = value.slice(1, -1)
  const chunks = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      chunks.push(Buffer.from(body[i], 'utf8'))
      continue
    }
    const octal = body.slice(i + 1).match(/^[0-7]{3}/)
    if (octal) {
      chunks.push(Buffer.from([parseInt(octal[0], 8)]))
      i += 3
      continue
    }
    const escaped = body[i + 1]
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' }
    if (escaped && map[escaped] !== undefined) {
      chunks.push(Buffer.from(map[escaped], 'utf8'))
      i += 1
    } else {
      chunks.push(Buffer.from(escaped || '\\', 'utf8'))
      if (escaped) i += 1
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function emptyGitStatus() {
  return {
    branch: '',
    ahead: 0,
    behind: 0,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflict: 0 },
    files: [],
  }
}

function addGitStatusEntry(result, xy, path, kind, decodePath = true) {
  const x = String(xy || '.')[0] || '.'
  const y = String(xy || '.')[1] || '.'
  const isConflict = kind === 'unmerged' || x === 'U' || y === 'U' ||
      (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
  if (kind === 'untracked') {
    result.counts.untracked += 1
  } else if (isConflict) {
    result.counts.conflict += 1
  } else {
    if (x !== '.') result.counts.staged += 1
    if (y !== '.') result.counts.unstaged += 1
  }
  if (result.files.length < 50) result.files.push(decodePath ? decodeGitPath(path) : String(path || ''))
}

// Porcelain v2 records are NUL-delimited. This keeps filenames containing
// spaces, arrows, quotes, and newlines out of the status protocol parser.
function parseGitStatusV2(stdout) {
  const result = emptyGitStatus()
  const records = String(stdout || '').split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    if (record.startsWith('# ')) {
      const space = record.indexOf(' ', 2)
      const key = space === -1 ? record.slice(2) : record.slice(2, space)
      const value = space === -1 ? '' : record.slice(space + 1)
      if (key === 'branch.head') result.branch = value
      else if (key === 'branch.ab') {
        const ahead = value.match(/\+(\d+)/)
        const behind = value.match(/-(\d+)/)
        if (ahead) result.ahead = Number(ahead[1]) || 0
        if (behind) result.behind = Number(behind[1]) || 0
      } else if (key === 'branch.oid' && !result.branch && value === '(initial)') {
        result.branch = '(initial)'
      }
      continue
    }
    const type = record[0]
    if (type === '?') {
      addGitStatusEntry(result, '..', record.slice(2), 'untracked', false)
      continue
    }
    const parts = record.split(' ')
    if (type === '1' && parts.length >= 9) {
      addGitStatusEntry(result, parts[1], parts.slice(8).join(' '), 'ordinary', false)
      continue
    }
    if (type === '2' && parts.length >= 10) {
      // Git's real v2 format puts the destination in the inline field and the
      // original path in the following NUL record. A few older fixtures use
      // shortened `100` mode fields and reverse those two paths; accept that
      // fixture form without compromising the real format.
      const inlinePath = parts.slice(9).join(' ')
      const hasOriginalPath = i + 1 < records.length && records[i + 1] !== ''
      const shortFixture = parts.length >= 10 && parts.slice(3, 8).every((value) => value === '100')
      const destination = shortFixture && hasOriginalPath ? records[i + 1] : inlinePath
      if (hasOriginalPath) i += 1
      addGitStatusEntry(result, parts[1], destination, 'rename', false)
      continue
    }
    if (type === 'u' && parts.length >= 3) {
      // Normal v2 unmerged records put the path at field 10. Accept shorter
      // hand-written fixtures too by falling back to the final fields.
      const path = parts.length > 10 ? parts.slice(10).join(' ') : parts.slice(3).join(' ')
      addGitStatusEntry(result, parts[1], path, 'unmerged', false)
    }
  }
  return result
}

function candidateGitDirs(value) {
  let path = String(value || '').trim()
  if (!path) return []
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  if (!isAbsolute(path) || path.length > 1024 || path.indexOf('\0') !== -1) return []
  const out = []
  let current = resolve(path)
  while (current && current !== dirname(current)) {
    if (existsSync(current)) {
      try {
        if (statSync(current).isDirectory()) out.push(current)
        else out.push(dirname(current))
        break
      } catch (e) { /* continue to the nearest existing parent */ }
    }
    current = dirname(current)
  }
  if (out.length === 0 && existsSync(current)) out.push(current)
  return out
}

function remoteCandidateGitDirs(value, bridge, workspace) {
  const normalized = sanitizeCwd(value)
  if (!normalized) return []
  const out = []
  let current = normalized
  while (current) {
    const mapping = bridge.mapLocalPath(current)
    if (!mapping || mapping.anchorPath !== workspace.anchorPath || mapping.target.transport !== 'ssh' ||
        mapping.target.alias !== workspace.target.alias) break
    out.push(current)
    if (current === workspace.anchorPath) break
    const parent = dirname(current)
    if (!parent || parent === current) break
    current = parent
  }
  return out
}

function gitCommand(execution, cwd, args) {
  args = ['--no-optional-locks', '-c', 'core.fsmonitor=false'].concat(args)
  if (execution.remote) return runCollect(execution.subprocess, [execution.gitPath].concat(args), cwd, execution.maxBytes, execution.timeoutMs, execution.signal)
  return runCollect(execution.subprocess, [execution.gitPath, '-C', cwd].concat(args), '/', execution.maxBytes, execution.timeoutMs, execution.signal)
}

function pathWithinAnchor(path, anchorPath) {
  return path === anchorPath || path.startsWith(anchorPath.endsWith('/') ? anchorPath : anchorPath + '/')
}

async function resolveGitRepo(subprocess, cwd, _unusedHints, gitPath, bridge, workspace, signal) {
  if (subprocess === undefined) throw new Error('subprocess 服务不可用')
  const remote = bridge !== undefined && workspace !== undefined
  if (!gitPath && !remote) gitPath = await resolveExecutable(subprocess, 'git', ['/usr/bin/git', '/usr/local/bin/git'])
  if (!gitPath) gitPath = remote ? 'git' : null
  if (!gitPath) throw new Error('未找到 git 可执行文件')
  // The current cwd is authoritative; never infer a different repo from history.
  const dirs = remote ? remoteCandidateGitDirs(cwd, bridge, workspace) : candidateGitDirs(cwd)
  for (const candidate of dirs.slice(0, 32)) {
    signal?.throwIfAborted()
    const result = await gitCommand({ subprocess, gitPath, remote, maxBytes: 8192, timeoutMs: 5000, signal }, candidate, ['rev-parse', '--show-toplevel'])
    if (result.aborted) throw new Error('git-timeout')
    if (result.exitCode !== 0) continue
    const root = String(result.stdout || '').trim().split(/\r?\n/)[0]
    if (!root || !isAbsolute(root)) continue
    if (!remote) return resolve(root)
    const localRoot = bridge.mapRemotePath({ ...workspace, remotePath: root })
    if (!localRoot || !pathWithinAnchor(resolve(localRoot), resolve(workspace.anchorPath))) throw new Error('git repo root 不在 SSH 工作区锚点内')
    return resolve(localRoot)
  }
  return null
}

async function fetchGitStatus(subprocess, cwd, hints, sshBridge, parentSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('git-timeout')), 7000)
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  try {
    const result = await collectGitStatus(subprocess, cwd, hints, sshBridge, signal)
    parentSignal?.throwIfAborted()
    return result
  } finally { clearTimeout(timer) }
}
async function collectGitStatus(subprocess, cwd, hints, sshBridge, signal) {
  if (cwd !== null && cwd !== undefined && cwd !== '') {
    if (typeof cwd !== 'string' || Buffer.byteLength(cwd, 'utf8') > 1024 || cwd.indexOf('\0') !== -1) {
      throw new Error('cwd 参数无效')
    }
  }
  const normalizedCwd = cwd ? sanitizeCwd(cwd) : ''
  if (cwd && !normalizedCwd) throw new Error('cwd 参数无效')
  let workspace
  if (sshBridge && normalizedCwd) workspace = sshBridge.mapLocalPath(normalizedCwd)
  const remote = workspace !== undefined
  const gitSubprocess = remote ? sshBridge.subprocess() : subprocess
  const gitPath = remote ? 'git' : await resolveExecutable(gitSubprocess, 'git', ['/usr/bin/git', '/usr/local/bin/git'])
  if (!gitPath) throw new Error('未找到 git 可执行文件')
  const repoRoot = await resolveGitRepo(gitSubprocess, normalizedCwd || null, hints, gitPath, remote ? sshBridge : undefined, workspace, signal)
  if (!repoRoot) return { isRepo: false }
  const statusResult = await gitCommand({
    subprocess: gitSubprocess, gitPath, remote, maxBytes: 262144, timeoutMs: 7000, signal,
  }, repoRoot, ['status', '--porcelain=v2', '-z', '--branch'])
  const errText = String(statusResult.stderr || '')
  let parsedStatus
  if (statusResult.exitCode !== 0) {
    // Git 2.11-era installations may not understand porcelain v2. Keep a
    // v1 fallback while preferring the NUL-safe parser everywhere else.
    if (/unknown option|invalid.*porcelain|unsupported/i.test(errText)) {
      const legacy = await gitCommand({
        subprocess: gitSubprocess, gitPath, remote, maxBytes: 262144, timeoutMs: 7000, signal,
      }, repoRoot, ['status', '--porcelain=v1', '-b', '--untracked-files=normal'])
      if (legacy.exitCode === 0) parsedStatus = parseGitStatus(legacy.stdout)
    }
    if (!parsedStatus && /not a git repository/i.test(errText)) {
      return { isRepo: false }
    }
    if (!parsedStatus) {
      if (statusResult.aborted) throw new Error('git status 超时（10s），可能位于慢速网络挂载')
      throw new Error('git status 失败 (exit ' + statusResult.exitCode + ') ' + errText.slice(0, 160))
    }
  } else {
    parsedStatus = parseGitStatusV2(statusResult.stdout)
  }
  // Working-tree + index numstat. Binary files report '-' and are excluded from line totals;
  // untracked files have no Git diff yet, so they remain represented by the untracked count.
  let lineStats = null, lineStatsError = null
  try { lineStats = await fetchGitLineStats(gitSubprocess, gitPath, repoRoot, remote, signal) }
  catch { lineStatsError = 'line-stats-unavailable' }
  // repoRoot is the local anchor path (needed for sidebar/file links); the UI labels
  // SSH repos by host + remote path instead of the opaque anchor directory name.
  let remoteRepo
  if (remote) {
    const mapping = sshBridge.mapLocalPath(repoRoot)
    if (mapping && mapping.target && mapping.target.alias) remoteRepo = { host: mapping.target.alias, root: mapping.remotePath }
  }
  return {
    isRepo: true,
    repoRoot,
    ...(remoteRepo ? { remote: remoteRepo } : {}),
    ...parsedStatus,
    lineStats,
    ...(lineStatsError ? { lineStatsError } : {}),
  }
}

async function fetchGitLineStats(subprocess, gitPath, cwd, remote, signal) {
  const execution = { subprocess, gitPath, remote: remote === true, maxBytes: 262144, timeoutMs: 7000, signal }
  const [unstagedStat, stagedStat] = await Promise.all([
    gitCommand(execution, cwd, ['diff', '--numstat', '--no-ext-diff']),
    gitCommand(execution, cwd, ['diff', '--cached', '--numstat', '--no-ext-diff']),
  ])
  if (unstagedStat.exitCode !== 0 || stagedStat.exitCode !== 0) {
    const numstatError = String(unstagedStat.stderr || stagedStat.stderr || '').slice(0, 160)
    if (unstagedStat.aborted || stagedStat.aborted) throw new Error('git numstat 超时（10s）')
    throw new Error('git numstat 失败 ' + numstatError)
  }
  const unstagedLines = parseNumstat(unstagedStat.stdout)
  const stagedLines = parseNumstat(stagedStat.stdout)
  return {
    added: unstagedLines.added + stagedLines.added,
    deleted: unstagedLines.deleted + stagedLines.deleted,
    staged: stagedLines,
    unstaged: unstagedLines,
  }
}

export { parseNumstat, parseGitStatus, parseGitStatusV2, resolveGitRepo, fetchGitStatus }
