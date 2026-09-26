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

/**
 * Lines of the `## <version>` section, or null when the heading is absent. Pure.
 *
 * ⛔ THE SECTION ENDS AT A HEADING OF THE SAME OR SHALLOWER DEPTH, never at any
 * `#{2,}` (family#66). Keep a Changelog's own shape is `## [x.y.z]` with `### Added`
 * / `### Fixed` subsections, and the old terminator treated the first `###` as the
 * end of the section — so a 66-line entry organised that way reported "a heading
 * with no notes", and that refused two correct releases on 2026-09-26. `as` and
 * `at` failed; `to`, `on`, `in` and `ui` passed only because they happen to put
 * bullets directly under the version heading.
 * ⭐ The `#{2,}` breadth is still right for FINDING the heading — a repo may use
 * `###` for versions — so the depth is captured from the match and the terminator
 * built from it. Finding and ending are different questions.
 *
 * ⛔ FENCED CODE IS NOT MARKDOWN. A `# install deps` line inside a triple-backtick block is a
 * shell comment, and reading it as an h1 silently truncates the section. Nothing
 * had hit this yet — hub's changelog already carries four fenced blocks, so it was
 * one shell comment away — and a latent bug in the same loop is cheaper to fix now
 * than to diagnose later from "the section looks empty".
 */
export function versionSection(markdown, version) {
  // End-anchored: `## 0.8.0-pre.0` must not satisfy 0.8.0 (the unanchored form
  // let every repo cut 0.8.0 green with only a pre-release heading).
  const head = new RegExp(`^(#{2,})\\s+\\[?${esc(version)}\\]?( |$)`)
  const fence = /^\s*(```|~~~)/
  let inside = false
  let found = false
  let closer = null
  let fenced = false
  const out = []
  for (const line of markdown.split('\n')) {
    if (fence.test(line)) {
      fenced = !fenced
      if (inside) out.push(line)
      continue
    }
    if (!fenced) {
      const m = head.exec(line)
      if (m) { inside = true; found = true; closer = new RegExp(`^#{1,${m[1].length}}\\s`); continue }
      if (inside && closer.test(line)) inside = false
    }
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
    // A flat repo may keep ONE root CHANGELOG.md for every package (as/on/at
    // do; to and ui are per-package). A package with no changelog of its own
    // is covered by the root one; a package with neither is the failure.
    // Measured 2026-09-16: the first census flagged as/on/at 100% for this.
    let file = join(dir, 'CHANGELOG.md')
    if (!existsSync(file)) file = join(root, 'CHANGELOG.md')
    if (!existsSync(file)) { failures.push(`${where}: no CHANGELOG.md at all (neither its own nor a root one)`); continue }
    const section = versionSection(readFileSync(file, 'utf8'), version)
    if (section === null) failures.push(`${where}: CHANGELOG.md has no "## ${version}" section`)
    else if (!hasContent(section)) failures.push(`${where}: the ${version} section has no content — a heading with no notes`)
  }
  return { failures, checked: pkgs.length }
}
