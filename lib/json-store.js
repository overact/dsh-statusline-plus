'use strict'
/** JSON state files shared by the reset, peak and update caches. */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** A same-directory atomic write; owner-only mode survives a replace. */
function writeJsonAtomic(path, value, { pretty = false, log = null } = {}) {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0) + (pretty ? '\n' : ''), { mode: 0o600 })
    renameSync(tmp, path)
    try { chmodSync(path, 0o600) } catch { /* best effort */ }
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* the temp file may not exist */ }
    if (log) log(error)
    else throw error
  }
}
export { readJsonFile, writeJsonAtomic }
