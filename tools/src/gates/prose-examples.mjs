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
 * @returns {{ failures: string[], status?: string, cannotRun?: string }}
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
  for (const [ownerDir, files] of owned) {
    for (const { file, isSource } of files) {
      let prepared
      try { prepared = prepareBlocks(readFileSync(file, 'utf8'), { isSource, requirePreamble: true }) }
      catch (e) { failures.push(`${relative(root, file)}: ${e.message}`); continue }
      if (prepared.missingPreamble) missingPreamble.push(relative(root, file))
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
    return { failures: [], status: 'cannot-run', cannotRun: 'cannot resolve the repo\'s own `typescript` — install dependencies first' }
  }

  // ⛔ BUILD-ORDER VACUITY GUARD (`as`'s, ported on `on`'s recommendation).
  // Every import resolves through the package's own `types` entry. If it does
  // not exist yet, every import is an IGNORED TS2307, every symbol is `any`,
  // and the run passes having examined nothing.
  const published = collectPublishedNames(dirs)
  if (published.size === 0) {
    return {
      failures: [],
      status: 'cannot-run',
      cannotRun: 'resolved ZERO exported names from any package entry point — every import would be an ignored TS2307 and the run would be vacuous. Build first.',
    }
  }

  // ── Compile, per owning directory, one program per block ────────────────
  const probeToBlock = new Map()
  let raw = ''
  try {
    for (const [ownerDir, _files] of owned) {
      const mine = blocks.filter((b) => b.ownerDir === ownerDir)
      if (mine.length === 0) continue
      const out = join(ownerDir, PROBE_DIR)
      rmSync(out, { recursive: true, force: true })
      mkdirSync(out, { recursive: true })
      // The examples are ESM (top-level await throughout). Without this the
      // probe inherits a CommonJS default and every such block reports TS1309 —
      // a MODULE-FORMAT diagnostic sharing the TS1xxx range with real parse
      // errors, which silently exempted 74 of 79 blocks on core's first build.
      writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }))
      let nodeTyped = false
      try { nodeTyped = declaresNodeTypes(readPkg(ownerDir)) } catch { /* root has no manifest of its own */ }

      mine.forEach((b, i) => {
        // ⛔ ONE FILE PER BLOCK. Concatenating a README's blocks makes two that
        // import the same name collide as TS2300 — a defect the harness
        // invented. (`at`.)
        const probe = join(out, `b${i}.ts`)
        writeFileSync(probe, b.code)
        probeToBlock.set(relative(ownerDir, probe), b)
        probeToBlock.set(probe, b)
        b.probe = relative(ownerDir, probe)
      })

      raw += compile(tsc, ownerDir, out, mine.map((b) => b.probe), nodeTyped, new Set())
      const unparseable = new Set(
        parse(raw, probeToBlock).filter((d) => /^TS1\d{3}$/.test(d.code)).map((d) => d.b.probe),
      )
      if (unparseable.size > 0) {
        raw += compile(tsc, ownerDir, out, mine.map((b) => b.probe), nodeTyped, unparseable)
        for (const probe of unparseable) {
          const b = probeToBlock.get(probe)
          failures.push(`${relative(root, b.file)}:${b.line}: not parseable as TypeScript — re-fence it as \`\`\`text (a signature listing is not a program)`)
        }
      }
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

  for (const d of parse(raw, probeToBlock)) {
    if (/^TS1\d{3}$/.test(d.code)) continue
    if (!isMissingImport(d) && IGNORED.has(d.code)) continue
    // `line + row - 1 - preambleLines`; a row inside the preamble reports at
    // the preamble's own line rather than a phantom offset into the block.
    const row = d.b.preambleLines > 0 && d.row <= d.b.preambleLines
      ? d.b.preambleLine
      : d.b.line + d.row - 1 - d.b.preambleLines
    failures.push(`${relative(root, d.b.file)}:${row}  ${d.code}  ${d.msg}`)
  }

  for (const file of missingPreamble) {
    failures.push(`${file}: has import-less fenced blocks and no <!-- prose-preamble -->; those blocks compile with nothing typed`)
  }

  return { failures }
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
    files: use.map((f) => relative(out, join(cwd, f))),
  }, null, 2))
  try {
    execFileSync(process.execPath, [tsc, '-p', relative(cwd, cfgPath)], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return ''
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}
