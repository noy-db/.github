// prose-examples — do our SHIPPED examples actually compile?
//
// WHY IT EXISTS: a presence check answers "does this method exist". Every
// defect core found on 2026-08-28 answered that YES and was still wrong,
// because the method existed and the ARGUMENT did not — `createNoydb({ userId
// })` when the option is `user`, shipped in every tarball and the documented
// origin of three consumer bug reports. A reader cannot guess an option's name
// from an example that omits it. A compiler sees all of it.
//
// Ported from noy-db/core's `scripts/check-prose-examples.mjs`, which the
// family ruled the reference implementation (family#26), with the rules `on`
// and `at` added from running their own. Everything marked ⛔ below is a
// counter-argument someone paid for; a port that drops one is green and blind.
//
// ## The traps, each measured, each still live
//
// ⛔ ONE PROGRAM PER BLOCK, never a concatenated file. Two blocks in the same
//    README importing the same name become TS2300 — a duplicate the harness
//    invented, not a defect in the prose. (`at`, family#26.) It also gives the
//    two-program split below for free.
// ⛔ COMPILE INSIDE THE OWNING PACKAGE, never at the repo root. A flat pnpm
//    workspace has no hoisted `@noy-db/*` at the root, so a root-level program
//    TS2307s every import while the same blocks compile one directory down.
//    (`at`, family#26.) The layout comes from family.config.json.
// ⛔ TWO PROGRAMS, split on whether the package declares @types/node. `types`
//    is never left to DEFAULT (that pulls in every @types/* in scope and hides
//    the gap) and never a blanket `[]` (that strips ambient globals, so a
//    package correctly declaring @types/node cannot use `process`).
// ⛔ A SYNTACTIC DIAGNOSTIC ABANDONS SEMANTIC CHECKING FOR THE WHOLE PROGRAM.
//    One mislabelled fence silenced 74 of 79 blocks and the gate reported "all
//    examples compile". Pass 1 finds unparseable blocks and EXCLUDES them by
//    name; pass 2 checks the rest.
// ⛔ ABSENCE IS NOT A PASS, twice over — see `cannotRun` below.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { packageDirs, readPkg } from '../walk.mjs'
import { prepareBlocks } from './prose-examples/blocks.mjs'

const PROBE_DIR = '.prose-examples'

// Ignored because they are properties of the PROBE, not claims about our API.
// An illustrative snippet legitimately elides a variable; it does NOT
// legitimately name an export that does not exist.
const IGNORED = new Set([
  'TS2304',  // cannot find name            — elided variable
  'TS2307',  // cannot find module          — sibling package not built here
  'TS2552',  // cannot find name (did-you-mean form of 2304)
  'TS18004', // no value in scope for shorthand property `{ store, user }`
  'TS18046', // 'x' is of type 'unknown'    — cascade from an elided type
  'TS2834',  // relative import needs extension — the snippet's neighbour is elided
  'TS2448',  // used before declaration      — prose narrates out of order
  'TS2454',  // used before assigned         — same
])

// ⭐ …EXCEPT when the missing name is one WE PUBLISH. Raised by `on`
// (family#26) from `on-shamir`'s README calling `encodeShareBase32` with no
// import — a symbol the package genuinely re-exports, so a reader copying the
// block gets a broken program, filed under TS2304 and dropped. core measured
// the same class the same day (`by-peer` calling `withSync()` in a block that
// already had three imports).
//
// ⛔ The preamble convention is NOT the answer for this class. An honest
// preamble would have to `declare const withSync` — documenting an ambient
// that is not ambient, and cementing the defect. A name the family exports is
// a MISSING IMPORT. This NARROWS the exemption; reader-supplied values
// (`userSecret`, `opts`, `mockClient`) are absent from the published surface
// and stay ignored.
const NAMED = /Cannot find name '([^']+)'/

/** Names exported from any PUBLISHED entry point of any package in this repo. */
export function collectPublishedNames(dirs) {
  const names = new Set()
  for (const dir of dirs) {
    let json
    try { json = readPkg(dir) } catch { continue }
    for (const entry of Object.values(json.exports ?? {})) {
      const types = typeof entry === 'string' ? null : entry?.types
      if (!types) continue
      const dts = resolve(dir, types)
      if (!existsSync(dts)) continue
      const text = readFileSync(dts, 'utf8')
      // `export { a, b as c, type D }` and `export type { E }`
      for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
        for (const raw of m[1].split(',')) {
          const part = raw.trim().replace(/^type\s+/, '')
          if (!part) continue
          const alias = part.split(/\s+as\s+/)
          const name = (alias[1] ?? alias[0]).trim()
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
        }
      }
      for (const m of text.matchAll(/export\s+declare\s+(?:abstract\s+)?(?:function|const|class|let|var|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
      for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
    }
  }
  return names
}

/** Does this package declare @types/node? Decides which of the two programs a block joins. */
const declaresNodeTypes = (json) =>
  Boolean({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies }['@types/node'])

/** Resolve the repo's OWN typescript. Never `npx`, which would silently fetch one. */
function resolveTsc(root) {
  try {
    return createRequire(join(root, 'noop.js')).resolve('typescript/bin/tsc')
  } catch {
    return null
  }
}

const parse = (raw, probeToBlock) =>
  raw.split('\n').flatMap((l) => {
    const m = l.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/)
    if (!m) return []
    const b = probeToBlock.get(m[1]) ?? probeToBlock.get(m[1].replace(/^\.\//, ''))
    return b ? [{ b, row: Number(m[2]), code: m[3], msg: m[4] }] : []
  })


/**
 * Blocks that are NOT PROGRAMS, and so are excluded from checking and NAMED in
 * the output rather than failed. Illustrative-only is a CONSEQUENCE of this
 * test, never an opt-out a writer can claim by adding a marker.
 *
 * Two kinds:
 *
 * ⛔ SYNTACTIC (TS1xxx) — a template like `with<Name>(…)`. These MUST be
 *    excluded rather than merely ignored: tsc abandons semantic checking for
 *    the whole program on any syntactic diagnostic, so one of these silences
 *    every other block in the same program. Measured on core: 5 templates
 *    suppressed checking of all 79 blocks while the gate reported success.
 *
 * ⛔ DECLARATION-ONLY — an "## API" block of bare signatures. It PARSES, so
 *    pass 1's syntactic filter never sees it; what it produces is TS2391
 *    ("function implementation is missing") per signature. `at` carries five
 *    such blocks, excluded by its own census and by the convention, and the
 *    first version of this gate failed all five. A signature listing is
 *    documentation of a surface, not a program that can run.
 *
 *    The test is deliberately narrow: at least one TS2391/TS2392, and NOTHING
 *    outside the set of diagnostics a signature listing legitimately produces.
 *    A block with a real type error alongside its signatures is still a
 *    failing block — the exclusion cannot be earned by adding one signature.
 */
const SYNTACTIC = /^TS1\d{3}$/
const DECL_ONLY_MARKER = new Set(['TS2391', 'TS2392'])
// What a bare signature listing legitimately produces besides the marker:
// unresolved type names it references, and modules it does not import.
const DECL_ONLY_TOLERATED = new Set(['TS2391', 'TS2392', 'TS2304', 'TS2552', 'TS2307'])

export function blocksToExclude(pass1) {
  const byProbe = new Map()
  for (const d of pass1) {
    if (!byProbe.has(d.b.probe)) byProbe.set(d.b.probe, [])
    byProbe.get(d.b.probe).push(d)
  }
  const skip = new Set()
  for (const [probe, ds] of byProbe) {
    if (ds.some((d) => SYNTACTIC.test(d.code))) { skip.add(probe); continue }
    if (ds.some((d) => DECL_ONLY_MARKER.has(d.code)) && ds.every((d) => DECL_ONLY_TOLERATED.has(d.code))) skip.add(probe)
  }
  return skip
}

/**
 * @returns {{ failures: string[], notes: string[], status?: string, cannotRun?: string }}
 */
export function runProseExamples(root, cfg) {
  const dirs = packageDirs(root, cfg.layout)

  // ── Sources: prose that ships ───────────────────────────────────────────
  // A file is owned by the directory it lives in: a package README compiles
  // inside that package, the root README at the root. That is `at`'s rule, and
  // it is what makes a flat workspace resolve `@noy-db/*` at all.
  const owned = new Map() // ownerDir -> [{ file, isSource }]
  const add = (ownerDir, file, isSource = false) => {
    if (!existsSync(file)) return
    if (!owned.has(ownerDir)) owned.set(ownerDir, [])
    owned.get(ownerDir).push({ file, isSource })
  }
  add(root, join(root, 'README.md'))
  for (const dir of dirs) add(dir, join(dir, 'README.md'))
  // JSDoc module comments on published entry points ship inside the .d.ts, so
  // they are shipped prose too. `on` measured four of its six defects there.
  for (const src of cfg.proseSources ?? []) add(dirname(resolve(root, src)), resolve(root, src), true)

  // ── Extract blocks and apply the preamble convention ────────────────────
  const blocks = []
  const missingPreamble = []
  const failures = []
  const notes = []
  for (const [ownerDir, files] of owned) {
    for (const { file, isSource } of files) {
      let prepared
      try { prepared = prepareBlocks(readFileSync(file, 'utf8'), { isSource, requirePreamble: true }) }
      catch (e) { failures.push(`${relative(root, file)}: ${e.message}`); continue }
      if (prepared.missingPreamble) missingPreamble.push({ rel: relative(root, file), file })
      for (const b of prepared.blocks) blocks.push({ ...b, file, ownerDir })
    }
  }

  // ⛔ EMPTY SCOPE IS A FAILURE, NOT A PASS. Proposed by `on` (family#26) after
  // measuring that core had the build-order guard below and not this one: the
  // two fail for opposite reasons and neither implies the other. Without it a
  // run that finds no blocks prints a clean line and exits 0 having examined
  // NOTHING — and extraction is exactly the event that empties a scope
  // silently, a glob that stops matching being indistinguishable from prose
  // that is clean.
  if (blocks.length === 0) {
    return {
      failures: [],
      notes: [],
      status: 'cannot-run',
      cannotRun: `found ZERO fenced blocks across ${[...owned.values()].flat().length} prose file(s) — the gate examined nothing. That is a broken scope, not clean prose.`,
    }
  }

  // Ordered AFTER the empty-scope guard on purpose: reading prose needs no
  // compiler, and a missing one must not MASK a broken scope — the more
  // specific failure has to win, or the message sends a reader to the wrong
  // problem.
  const tsc = resolveTsc(root)
  if (!tsc) {
    // ⛔ NOT a silent skip. `npx tsc` would DOWNLOAD a compiler and check the
    // prose against a version the repo never uses — green, and against the
    // wrong thing.
    return { failures: [], notes: [], status: 'cannot-run', cannotRun: 'cannot resolve the repo\'s own `typescript` — install dependencies first' }
  }

  // ⛔ BUILD-ORDER VACUITY GUARD (`as`'s, ported on `on`'s recommendation).
  // Every import resolves through the package's own `types` entry. If it does
  // not exist yet, every import is an IGNORED TS2307, every symbol is `any`,
  // and the run passes having examined nothing.
  const published = collectPublishedNames(dirs)
  if (published.size === 0) {
    return {
      failures: [],
      notes: [],
      status: 'cannot-run',
      cannotRun: 'resolved ZERO exported names from any package entry point — every import would be an ignored TS2307 and the run would be vacuous. Build first.',
    }
  }

  // ── Compile, per owning directory, one program per block ────────────────
  //
  // ⛔ EVERY DIRECTORY IS ITS OWN TWO-PASS RUN, and its output is parsed ALONE.
  // The first version accumulated one `raw` across directories and recomputed
  // the excluded set from the whole of it each time, so a block excluded in the
  // first package was RE-REPORTED once per later package: 86 findings on core's
  // tree where its own gate names 3, and one `at` block reported five times.
  // Found by the root running this against the four real trees — the fixture
  // could not show it, because a fixture has one package.
  const probeToBlock = new Map()
  const diagnostics = []
  const excluded = []
  try {
    for (const [ownerDir] of owned) {
      const mine = blocks.filter((b) => b.ownerDir === ownerDir)
      if (mine.length === 0) continue
      const out = join(ownerDir, PROBE_DIR)
      rmSync(out, { recursive: true, force: true })
      mkdirSync(out, { recursive: true })
      // ⛔ THE PROBE WRITES NO package.json, AND THE FILES ARE `.mts`.
      // The examples are ESM (top-level await throughout), and a probe that
      // inherits a CommonJS default reports TS1309 on every one — a
      // MODULE-FORMAT diagnostic sharing the TS1xxx range with real parse
      // errors, which silently exempted 74 of 79 blocks on core's first build.
      // The obvious fix, a `{ "type": "module" }` in the probe directory,
      // SHADOWS the owning package's own manifest: Node and tsc walk up from
      // the probe file, find a manifest with no `name` and no `exports`, and
      // SELF-REFERENCE stops working — so a README importing its own package
      // (`import type { Noydb } from '@noy-db/hub'` inside packages/hub) gets
      // an untyped `db`, and the block compiles vacuously rather than failing.
      // Measured on core: hub's `queryAcross` example became TS2347 "untyped
      // function calls may not accept type arguments", and in-nuxt lost the
      // `NuxtConfig` augmentation that makes its `noydb:` key checkable.
      // `.mts` is unambiguously ESM whatever the nearest manifest says, so it
      // buys the module format without shadowing anything.
      // Snippets for browser bundlers legitimately assume `import.meta.env`.
      // Model the app environment they target rather than weakening API
      // checking — without this, every such block is a TS2339 on ImportMeta,
      // which is a property of the probe and not a claim about our surface.
      writeFileSync(join(out, 'ambient.d.ts'), 'interface ImportMeta { readonly env: Record<string, string> }\n')
      let nodeTyped = false
      try { nodeTyped = declaresNodeTypes(readPkg(ownerDir)) } catch { /* the root has no manifest of its own */ }

      const local = new Map()
      mine.forEach((b, i) => {
        // ⛔ ONE FILE PER BLOCK. Concatenating a README's blocks makes two that
        // import the same name collide as TS2300 — a defect the harness
        // invented. (`at`.)
        const probe = join(out, `b${i}.mts`)
        writeFileSync(probe, b.code)
        b.probe = relative(ownerDir, probe)
        local.set(b.probe, b)
        probeToBlock.set(b.probe, b)
      })
      const files = mine.map((b) => b.probe)

      const pass1 = parse(compile(tsc, ownerDir, out, files, nodeTyped, new Set()), local)
      const skip = blocksToExclude(pass1)
      for (const probe of skip) excluded.push(local.get(probe))
      diagnostics.push(...parse(compile(tsc, ownerDir, out, files, nodeTyped, skip), local))
    }
  } finally {
    for (const ownerDir of owned.keys()) rmSync(join(ownerDir, PROBE_DIR), { recursive: true, force: true })
  }

  /** A TS2304/TS2552 naming something we publish is a missing import, not probe noise. */
  const isMissingImport = (d) => {
    if (d.code !== 'TS2304' && d.code !== 'TS2552') return false
    const name = NAMED.exec(d.msg)?.[1]
    return name !== undefined && published.has(name)
  }

  for (const d of diagnostics) {
    if (/^TS1\d{3}$/.test(d.code)) continue
    if (!isMissingImport(d) && IGNORED.has(d.code)) continue
    // `line + row - 1 - preambleLines`; a row inside the preamble reports at
    // the preamble's own line rather than a phantom offset into the block.
    const row = d.b.preambleLines > 0 && d.row <= d.b.preambleLines
      ? d.b.preambleLine
      : d.b.line + d.row - 1 - d.b.preambleLines
    failures.push(`${relative(root, d.b.file)}:${row}  ${d.code}  ${d.msg}`)
  }

  // ⛔ THE PREAMBLE RULE FIRES ON A DIAGNOSTIC, NOT ON THE MARKER'S ABSENCE.
  // The first version demanded a preamble from the mere EXISTENCE of an
  // import-less block, which failed `as` on four blocks that have no free names
  // at all — there was nothing for a preamble to declare. The rule the
  // convention actually states is "declare the elided binding", so the trigger
  // is a binding that was elided: an ignored TS2304/TS2552 (a free name we do
  // NOT publish; a published one is a missing import, reported above).
  const freeNames = new Set(
    diagnostics
      .filter((d) => (d.code === 'TS2304' || d.code === 'TS2552') && !isMissingImport(d))
      .map((d) => d.b.file),
  )
  for (const { rel, file } of missingPreamble) {
    if (!freeNames.has(file)) continue
    failures.push(`${rel}: has import-less fenced blocks that use undeclared bindings, and no <!-- prose-preamble -->; those bindings compile as \`any\`, which is the laundering the convention exists to stop`)
  }

  // Named, never counted: the exclusion cannot grow silently. Illustrative-only
  // is a CONSEQUENCE of not being a program, not an opt-out a writer can claim.
  if (excluded.length > 0) {
    notes.push(`${excluded.length} block(s) excluded as not-a-program (signature listings, templates):`)
    for (const b of excluded) notes.push(`  ${relative(root, b.file)}:${b.line}`)
  }

  return { failures, notes }
}

function compile(tsc, cwd, out, files, nodeTyped, exclude) {
  const use = files.filter((f) => !exclude.has(f))
  if (use.length === 0) return ''
  const cfgPath = join(out, 'tsconfig.json')
  writeFileSync(cfgPath, JSON.stringify({
    compilerOptions: {
      module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022',
      strict: true, noImplicitAny: false, noEmit: true, skipLibCheck: true,
      // ⛔ EXPLICIT, never defaulted and never a blanket []. See the header.
      types: nodeTyped ? ['node'] : [],
    },
    // `ambient.d.ts` joins EVERY program — see where it is written.
    files: [...use.map((f) => relative(out, join(cwd, f))), 'ambient.d.ts'],
  }, null, 2))
  try {
    execFileSync(process.execPath, [tsc, '-p', relative(cwd, cfgPath)], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return ''
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}
