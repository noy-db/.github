// check-license — every publishable manifest declares the repo's licence tier,
// and the two files that make the declaration true actually ship.
//
// WHY IT EXISTS: three repos extracted on 2026-09-01 (as/on/at) listed LICENSE
// in `files` with no file on disk. Every in-repo gate passed; npm silently
// omits a listed path that does not exist; the first cut from each repo would
// have published 24 of 25 packages licence-less while declaring "MIT". The
// defect is invisible to anything that reads the manifest alone, so this gate
// reads the disk. It closes noy-db/{as,on,at}#1 by construction.
//
// The tier is CONFIG, not a constant: open repos are Apache-2.0, premium repos
// (lobby, daemon, as-xlsx-pro) are FSL-1.1-Apache-2.0. Default Apache-2.0 so a
// repo that says nothing gets the open tier, never a silent pass.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageDirs, readPkg } from '../walk.mjs'

const SHIPPED = ['LICENSE', 'NOTICE']

// ── README prose ─────────────────────────────────────────────────────────────
// WHY: every `0.8.0` package in core/to/as/at/ui shipped a README whose
// `## License` section said MIT while manifest and LICENSE said Apache-2.0 —
// ~57 packages on public npm, found by `at` on published tarballs 2026-09-15.
// npmjs.com renders the README, so each page showed MIT in the body and
// Apache-2.0 in the sidebar. The manifest/LICENSE/files triad above was correct
// for all of them; prose was never in scope, and that is the gap this closes.
//
// Scope is deliberately narrow: ONLY the licence section, ONLY a README that
// has one. A README with no licence section is not a failure — the gate asserts
// consistency, not presence. Do not widen this to "README must mention the
// licence"; a package README is the silo's document.
const LICENCE_HEADING = /^#{2,}\s+Licen[cs]e\b/i
const ANY_HEADING = /^#{2,}\s/
// SPDX ids a section could plausibly name instead of the tier. Matched as
// whole words so "Apache-2.0" does not trip on "Apache".
const OTHER_IDS = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'GPL-3.0', 'LGPL-3.0', 'MPL-2.0', 'Unlicense', 'Apache-2.0', 'FSL-1.1-Apache-2.0']

/** The lines of a README's licence section, or null when it has none. Pure. */
export function licenceSection(markdown) {
  const out = []
  let inside = false
  let found = false
  for (const line of markdown.split('\n')) {
    if (LICENCE_HEADING.test(line)) { inside = true; found = true; continue }
    if (inside && ANY_HEADING.test(line)) inside = false
    if (inside) out.push(line)
  }
  return found ? out : null
}

/** Ids named in the section that are NOT the tier. Pure. */
export function foreignLicenceIds(sectionLines, tier) {
  const text = sectionLines.join('\n')
  return OTHER_IDS.filter((id) => id !== tier && new RegExp(`(^|[^A-Za-z0-9.-])${id.replace(/[.]/g, '\\.')}(?![A-Za-z0-9.-])`).test(text))
}

export function runCheckLicense(root, cfg) {
  const failures = []
  const tier = cfg.license ?? 'Apache-2.0'
  const rel = (dir) => dir.slice(root.length + 1) || '.'

  const pkgs = packageDirs(root, cfg.layout)
    .map((dir) => ({ dir, json: readPkg(dir) }))
    .filter(({ json }) => cfg.layout === 'single' || !json.private)

  for (const { dir, json } of pkgs) {
    const where = `${rel(dir)} (${json.name})`
    if (json.license !== tier) {
      failures.push(`${where} declares "license": ${JSON.stringify(json.license)}; expected "${tier}"`)
    }
    for (const file of SHIPPED) {
      if (!existsSync(join(dir, file))) failures.push(`${where}: ${file} is missing on disk`)
      // npm ships LICENSE/NOTICE by default ONLY when `files` is absent. Once a
      // manifest lists `files`, anything not listed does not ship — including
      // the file this gate just found on disk.
      else if (Array.isArray(json.files) && !json.files.includes(file)) {
        failures.push(`${where}: ${file} exists but is not in "files" — it would not ship`)
      }
    }
    const readme = join(dir, 'README.md')
    if (existsSync(readme)) {
      const section = licenceSection(readFileSync(readme, 'utf8'))
      if (section) {
        const foreign = foreignLicenceIds(section, tier)
        if (foreign.length)
          failures.push(`${where}: README "## License" names ${foreign.join(', ')} but the manifest says "${tier}" — npmjs.com renders the README, so the page contradicts itself`)
      }
    }
  }
  return { failures }
}
