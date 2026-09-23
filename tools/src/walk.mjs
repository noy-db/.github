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

/**
 * The `cannotRun` message when a gate's package walk found nothing, else null.
 *
 * ⛔ WHY THIS IS NOT "fail when empty" EVERYWHERE: noy-db/.github#23's own
 * refinement rejected a family-wide emptiness predicate. `codemod-rows` walks an
 * empty scope as its NORMAL state (three of four hub maps legitimately name no
 * package in a given repo), while `prose-examples`' empty scope is broken. So
 * whether emptiness is legitimate is EACH GATE'S call — this helper only writes
 * the sentence, and a gate opts in by calling it.
 *
 * The three causes are named because in the output that motivated the issue they
 * are indistinguishable from a clean repo: a renamed `packages/`, a layout
 * misdeclared in family.config.json, and a checkout at the wrong depth.
 */
export function emptyWalk(dirs, cfg) {
  if (dirs.length > 0) return null
  const where = cfg.layout === 'workspace' ? 'packages/' : 'the repo root'
  return `walked ZERO packages under ${where} — the gate examined nothing, so this is not a clean repo. ` +
    `A renamed directory, a layout misdeclared in family.config.json, or a shallow checkout all look exactly like this.`
}

/** How a gate names what it walked, for the green line. Pure. */
export const scopeOf = (n, cfg, noun = 'package(s)') =>
  `${n} ${noun} under ${cfg.layout === 'workspace' ? 'packages/' : 'the repo root'}`

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
