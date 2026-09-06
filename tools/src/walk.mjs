// Package discovery and source walking, shared by every gate.
//
// `packageDirs` deliberately KEEPS private packages — a gate that skips them
// cannot see a private package importing across a seam. Filtering by `private`
// is each gate's own decision, made where the reason is visible.
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function packageDirs(root, layout) {
  if (layout === 'single') return [root]
  const base = layout === 'workspace' ? join(root, 'packages') : root
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((n) => !n.startsWith('.') && n !== 'node_modules' && n !== 'scripts')
    .map((n) => join(base, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'package.json')))
}

export const readPkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

export function walkTs(dir, cb) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkTs(p, cb)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) cb(p, readFileSync(p, 'utf8'))
  }
}

// Covers static imports (from/import), dynamic import(), require(), and bare
// side-effect imports (`import '@noy-db/hub'`). Group 1 is the subpath, or
// undefined for the root barrel.
// ⚠️ It carries /g, so it is STATEFUL: reset `lastIndex` before a `.test()`, or
// build a fresh RegExp from `.source` before an `exec` loop.
export const HUB_IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"]@noy-db\/hub(\/[^'"]*)?['"]/g
