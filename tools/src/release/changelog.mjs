// changelog-census — does EVERY publishable package carry a non-empty
// CHANGELOG section for the version being cut?
//
// ⛔ WHY A CENSUS AND NOT A GREP: release.yml's original check was
//   grep -rqE "^## +\[?<v>\]?( |$)" --include=CHANGELOG.md .
// — EXISTENTIAL over the whole repo. One file's heading satisfied it for all
// 36 of core's packages, and two packages with NO CHANGELOG.md at all were
// invisible to a check that iterates `git ls-files '*CHANGELOG.md'`. Found by
// core 2026-09-16 (family#30) after the 0.8.0 cut shipped 56 of 58 package
// changelogs without a section. The denominator has to be the packages, not
// the files — the same walker every other gate uses.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageDirs, readPkg } from '../walk.mjs'

const esc = (v) => v.replace(/[.+]/g, '\\$&')

/** Lines of the `## <version>` section, or null when the heading is absent. Pure. */
export function versionSection(markdown, version) {
  // End-anchored: `## 0.8.0-pre.0` must not satisfy 0.8.0 (the unanchored form
  // let every repo cut 0.8.0 green with only a pre-release heading).
  const head = new RegExp(`^#{2,}\\s+\\[?${esc(version)}\\]?( |$)`)
  const any = /^#{2,}\s/
  let inside = false
  let found = false
  const out = []
  for (const line of markdown.split('\n')) {
    if (head.test(line)) { inside = true; found = true; continue }
    if (inside && any.test(line)) inside = false
    if (inside) out.push(line)
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return found ? out : null
}

/** Content = non-blank lines. Prose is notes; a bullet is not required. */
export const hasContent = (lines) => lines.some((l) => l.trim() !== '')

export function runChangelogCensus(root, cfg, version) {
  const failures = []
  const rel = (dir) => dir.slice(root.length + 1) || '.'
  const pkgs = packageDirs(root, cfg.layout)
    .map((dir) => ({ dir, json: readPkg(dir) }))
    .filter(({ json }) => cfg.layout === 'single' || !json.private)
  for (const { dir, json } of pkgs) {
    const where = `${rel(dir)} (${json.name})`
    const file = join(dir, 'CHANGELOG.md')
    if (!existsSync(file)) { failures.push(`${where}: no CHANGELOG.md at all`); continue }
    const section = versionSection(readFileSync(file, 'utf8'), version)
    if (section === null) failures.push(`${where}: CHANGELOG.md has no "## ${version}" section`)
    else if (!hasContent(section)) failures.push(`${where}: the ${version} section has no content — a heading with no notes`)
  }
  return { failures, checked: pkgs.length }
}
