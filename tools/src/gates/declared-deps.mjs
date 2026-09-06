// declared-deps — every package declares what it actually uses.
//
// Ported from noy-db-as's scripts/check-declared-deps.mjs. WHY IT EXISTS, and
// why the obvious alternative does not work:
//
// The as-* packages were extracted from the noy-db monorepo, where nine of them
// used `happy-dom` as their vitest environment and NONE declared it. It
// resolved only because other workspace members — packages that stayed behind —
// declared it, at three different majors. The suites had been running for
// months against whichever version won hoisting.
//
// ⚠️ Declaring it did NOT fix that. MEASURED, 2026-09-01: with one package's
// declaration deleted, the full suite still PASSES — the very test that needs a
// happy-dom environment runs green — because a SIBLING declaring it is enough
// for pnpm's store to satisfy it. The hoisting prop did not go away when the
// packages left the monorepo; it moved into the new repo.
//
// So there is no runtime signal to rely on, in either repo, ever. A green suite
// cannot tell you a package declares what it uses. Only a static check can, and
// that is this file.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { packageDirs, readPkg, walkTs } from '../walk.mjs'

// Provided by the workspace root by convention, not per package. This is the
// one exemption, and it is deliberately tiny: a rule that over-fires teaches
// people to declare dependencies they do not have, which is its own defect.
const ROOT_TOOLING = new Set(['vitest', 'tsup', 'typescript', 'eslint'])

const IMPORT = /^\s*(?:import|export)\b[^;\n]*?from\s+['"]([^'"]+)['"]/gm
const BARE_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
// vitest takes its environment from a config field OR a docblock pragma. The
// pragma is syntactically a comment, so an import scan cannot see it — and that
// is the exact form hub used, which is how this class stayed hidden.
const ENV_FIELD = /environment:\s*['"]([a-z-]+)['"]/g
const ENV_PRAGMA = /@vitest-environment\s+([a-z-]+)/g

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const bare = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])

export function runDeclaredDeps(root, cfg) {
  const failures = []

  for (const dir of packageDirs(root, cfg.layout)) {
    const pj = readPkg(dir)
    const declared = new Set(
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((f) =>
        Object.keys(pj[f] ?? {}),
      ),
    )
    const used = new Map() // specifier -> first file that used it
    const sources = [] // [path, text]

    // walkTs skips .d.ts, which an import scan has no business reading anyway:
    // a declaration file's imports are types the build erases.
    for (const sub of ['src', '__tests__']) walkTs(join(dir, sub), (p, code) => sources.push([p, code]))

    for (const [file, code] of sources) {
      for (const re of [IMPORT, BARE_IMPORT, DYNAMIC, REQUIRE]) {
        re.lastIndex = 0 // these are /g and therefore stateful across packages
        let m
        while ((m = re.exec(code)) !== null) {
          const spec = m[1]
          if (spec.startsWith('.') || spec.startsWith('node:')) continue
          const name = bare(spec)
          if (name === pj.name) continue // a package may reference itself
          if (!used.has(name)) used.set(name, file)
        }
      }
    }

    // Test environments: from any config file at the package root, and from
    // docblock pragmas inside the source files themselves.
    const configs = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => n.endsWith('.config.ts') || n.endsWith('.config.mts'))
          .map((n) => [join(dir, n), readFileSync(join(dir, n), 'utf8')])
      : []
    for (const [file, code] of [...configs, ...sources]) {
      for (const re of [ENV_FIELD, ENV_PRAGMA]) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(code)) !== null) if (m[1] !== 'node' && !used.has(m[1])) used.set(m[1], file)
      }
    }

    for (const [name, file] of used)
      if (!declared.has(name) && !ROOT_TOOLING.has(name))
        failures.push(`${pj.name}: uses "${name}" but does not declare it  (${relative(root, file)})`)
  }

  return { failures }
}
