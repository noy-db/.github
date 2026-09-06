// codemod-rows — a repo answers for the codemod rows that name ITS packages.
//
// Ported from noy-db-as's scripts/check-codemod-rows.mjs. WHY IT LIVES IN THE
// SATELLITE, not in hub: `@noy-db/hub` ships migration maps under `codemods/`,
// and hub's own suite used to check every row against the source of the package
// it names. When the as-*/on-*/at-* families were extracted on 2026-09-01 those
// packages left, so hub can no longer answer for them. It did NOT silently skip
// them — a suite reporting "22 rows checked" while examining three is worse than
// one that fails — it DECLARED the extraction and asserted the declaration both
// ways. The other half of that arrangement is this gate: the receiving repo
// verifies its own rows.
//
// A codemod row is a promise to a consumer migrating versions: "`from` became
// `to` in this package". Nothing compiles a migration map. If a rename is later
// reverted or renamed again, the row goes quietly wrong and the first person to
// discover it is a consumer following it.
//
// ⚠️ Reads the maps from the INSTALLED @noy-db/hub, never from a copy — a
// vendored map is a second source of truth that drifts silently, which is the
// class of defect these repos already carry scars from. That is also why an
// unresolvable hub returns `no-hub` (the CLI exits 2) rather than "0 problems":
// "nothing to check" and "nothing was checkABLE" are different answers, and
// only one of them means the gate ran.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { packageDirs, readPkg, walkTs } from '../walk.mjs'

/** hub's `codemods/` directory as resolved from one of this repo's packages. */
function findCodemodDir(dirs) {
  for (const dir of dirs) {
    try {
      const req = createRequire(join(dir, 'package.json'))
      // NOT `resolve('@noy-db/hub/package.json')` — hub's exports map does not
      // expose it, and that throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the
      // entry point and walk up to the package root instead.
      let d = dirname(req.resolve('@noy-db/hub'))
      for (let i = 0; i < 5 && d !== '/'; i++) {
        if (existsSync(join(d, 'package.json')) && basename(d) === 'hub') break
        d = dirname(d)
      }
      const codemods = join(d, 'codemods')
      if (existsSync(codemods)) return codemods
    } catch {
      /* keep looking — another package may declare hub */
    }
  }
  return null
}

const wordRe = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)

export function runCodemodRows(root, cfg) {
  const dirs = packageDirs(root, cfg.layout)
  const codemodDir = findCodemodDir(dirs)
  if (!codemodDir) return { failures: [], status: 'no-hub' }

  const localPackages = new Map(
    dirs.map((dir) => [readPkg(dir).name, dir]).filter(([name]) => name?.startsWith('@noy-db/')),
  )

  const failures = []
  for (const file of readdirSync(codemodDir).filter((f) => f.endsWith('.json'))) {
    const map = JSON.parse(readFileSync(join(codemodDir, file), 'utf8'))
    for (const row of map.renames ?? []) {
      const dir = localPackages.get(row.package)
      if (!dir) continue // another repo answers for this row
      // `option-key` and `method` name a field on an options bag and a getter
      // on a class — neither is an export, so an export-surface assertion would
      // call them wrong. Only identifier/type rows are answerable this way.
      if (row.kind !== 'identifier' && row.kind !== 'type') continue

      let source = ''
      walkTs(join(dir, 'src'), (_p, code) => {
        source += code + '\n'
      })
      const where = basename(dir)

      // The NEW name must be present — UNLESS `toPackage` says ownership moved
      // to another package. `AsCSVImportOptions -> FormatImportOptions` carries
      // `toPackage: "@noy-db/hub/as"`, so the type is hub's now and its absence
      // here is CORRECT, not a defect.
      if (row.to && !row.toPackage && !wordRe(row.to).test(source))
        failures.push(
          `${file} · ${row.package}: promises "${row.from}" → "${row.to}", but "${row.to}" appears nowhere in ${where}/src`,
        )

      // The OLD name must be gone — but ONLY for rows the map itself marks
      // `safeGlobalReplace`. The others are BARE NOUNS (`toString`,
      // `fromString`, `fromObject`) that mean something else elsewhere:
      // `toString` is a JavaScript builtin, so a word-boundary match hits
      // `obj.toString()` in any file. The map annotates its own unsafe entries
      // precisely so a consumer does not blanket-replace them, and a checker
      // that ignores the annotation reports four confident false positives —
      // which is exactly what the first version of this check did.
      if (row.from && row.safeGlobalReplace === true && wordRe(row.from).test(source))
        failures.push(
          `${file} · ${row.package}: promises "${row.from}" was renamed, but "${row.from}" is STILL present in ${where}/src`,
        )
    }
  }

  return { failures, status: 'ok' }
}
