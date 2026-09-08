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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { packageDirs, readPkg } from '../walk.mjs'

const SHIPPED = ['LICENSE', 'NOTICE']

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
  }
  return { failures }
}
