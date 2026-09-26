import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFixture } from './helpers.mjs'
import { rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { runArchitecture } from '../src/gates/architecture.mjs'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

// Assert on the SET of rule names and the basenames of `where` — never on
// message text, which is prose and is meant to be rewritten.
function gate(name, overrides = {}) {
  const root = join(FIXTURES, name)
  const { failures } = runArchitecture(root, { ...loadConfig(root), ...overrides })
  return {
    failures,
    rules: failures.map((f) => f.rule).sort(),
    wheres: failures.map((f) => basename(f.where)).sort(),
  }
}

test('flat-to: to-only, hub-peer-range and no-crypto-deps all fire on to-bad', () => {
  const { rules, wheres } = gate('flat-to')
  assert.deepEqual(rules, ['hub-peer-range', 'no-crypto-deps', 'to-only'])
  assert.deepEqual(wheres, ['index.ts', 'to-bad', 'to-bad'])
})

test('flat-as: value-import of the store contract and a missing conformance fixture', () => {
  const { rules, wheres } = gate('flat-as')
  assert.deepEqual(rules, ['as-conformance-fixture', 'no-runtime-store-import'])
  assert.deepEqual(wheres, ['as-bad', 'index.ts'])
})

test('flat-as: a VALUE import of the hub root barrel and of /as is allowed', () => {
  // The as-* layer binds its own port and legitimately reads shared types and
  // error predicates from the root barrel. noy-db-as's own check-architecture
  // says so in as many words: its rule is NOT noy-db-to's `to-only`, and a
  // verbatim port "fails on correct code here". Measured against the real tree
  // (task 5, finding A): 16 false failures on noy-db-as, 18 on noy-db-on.
  const { failures } = gate('flat-as')
  assert.deepEqual(failures.filter((f) => f.where.startsWith('as-good')), [])
})

test('flat-as: `import type` from the store contract is allowed', () => {
  // Assert on the FULL `where`, not its basename: a source-file failure reports
  // `as-good/src/index.ts`, whose basename is `index.ts` and never `as-good`, so
  // a basename filter here would read 0 whether or not type-detection works.
  const { failures } = gate('flat-as')
  assert.deepEqual(
    failures.filter((f) => f.where.startsWith('as-good')),
    [],
  )
})

test('flat-on: a package that imports hub nowhere owes no peer', () => {
  const { rules, wheres } = gate('flat-on')
  assert.deepEqual(rules, [])
  assert.deepEqual(wheres, [])
})

test('flat-on: a package that DOES import hub without a peer fails hub-peer-range', () => {
  const { rules, wheres } = gate('flat-on', { exempt: [] })
  assert.deepEqual(rules, ['hub-peer-range'])
  assert.deepEqual(wheres, ['on-no-hub-but-imports'])
})

test('single-cargo: /cargo and /pod pass, /to trips the seam rule once', () => {
  const { rules, wheres } = gate('single-cargo')
  assert.deepEqual(rules, ['klum-only-seam'])
  assert.deepEqual(wheres, ['b.ts'])
})

test('one-way: a @noy-db package importing either lobby fails; the lobby itself does not', () => {
  const { rules, wheres } = gate('flat-one-way')
  assert.deepEqual(rules, ['one-way', 'one-way'])
  assert.deepEqual(wheres, ['a.ts', 'b.ts'])
})

test('failures carry root-relative `where` paths, not absolute ones', () => {
  const root = join(FIXTURES, 'flat-to')
  const { failures } = runArchitecture(root, loadConfig(root))
  for (const f of failures) assert.equal(f.where.startsWith('/'), false)
})

test('flat-as: only a VALUE import of /to is a seam failure — nothing else is', () => {
  // The whole predicate, stated as a set: of the four hub subpaths as-good and
  // as-aws-s3 import between them (root, /as, /introspection, type-only /to),
  // none fails; as-bad's value /to import is the single failure.
  const { rules, wheres } = gate('flat-as', { conformanceKit: null })
  assert.deepEqual(rules, ['no-runtime-store-import'])
  assert.deepEqual(wheres, ['index.ts'])
})

test('flat-on: the on-* layer may value-import the root barrel too', () => {
  const { rules } = gate('flat-on')
  assert.deepEqual(rules, [])
})

test('a type-only import never fails a seam rule, whatever the subpath', () => {
  // Types erase at build and move no data, so they cross no runtime boundary.
  // This holds for `to-only` and `klum-only-seam` as much as for the as-* rule.
  const { failures } = gate('flat-to')
  assert.deepEqual(failures.filter((f) => f.where.endsWith('type-only.ts')), [])
  const cargo = gate('single-cargo')
  assert.deepEqual(cargo.failures.filter((f) => f.where.endsWith('c.ts')), [])
})

test('single-to-root: allowHubRoot lets a /to-binding repo import the root barrel', () => {
  // doi-db's own check-architecture: ALLOWED_HUB = new Set(['@noy-db/hub',
  // '@noy-db/hub/to']), because hub's contract (#935) requires isConflictError
  // and /to does not export it.
  const { rules } = gate('single-to-root')
  assert.deepEqual(rules, [])
})

test('single-to-root: without allowHubRoot the root import is a to-only failure', () => {
  const { rules, wheres } = gate('single-to-root', { allowHubRoot: false })
  assert.deepEqual(rules, ['to-only'])
  assert.deepEqual(wheres, ['dispatch.ts'])
})

// ── noy-db/.github#23 ─────────────────────────────────────────────────────────
test('a tree whose package walk finds NOTHING is cannot-run, not clean', (t) => {
  const root = copyFixture(t, 'workspace')
  rmSync(join(root, 'packages'), { recursive: true, force: true })
  const res = runArchitecture(root, loadConfig(root))
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /ZERO/)
  assert.deepEqual(res.failures, [])
})

test('a green names the scope it checked', (t) => {
  const root = copyFixture(t, 'workspace')
  const res = runArchitecture(root, loadConfig(root))
  assert.match(res.scope, /package\(s\)/)
})

// ── package-seam (family#41) ─────────────────────────────────────────────────

const seamCfg = (root, packageSeams) => ({ ...loadConfig(root), packageSeams })

test('package-seam: an UNDECLARED cross-repo package import fails', (t) => {
  const root = copyFixture(t, 'flat-as')
  const f = join(root, 'as-good/src/index.ts')
  writeFileSync(f, "import { meter } from '@noy-db/to-meter'\n" + readFileSync(f, 'utf8'))
  const failures = runArchitecture(root, seamCfg(root, {})).failures
  const seam = failures.filter((x) => x.rule === 'package-seam')
  assert.equal(seam.length, 1)
  assert.match(seam[0].msg, /@noy-db\/to-meter/)
  assert.match(seam[0].msg, /packageSeams/)
})

test('package-seam: declaring it makes the same import pass', (t) => {
  const root = copyFixture(t, 'flat-as')
  const f = join(root, 'as-good/src/index.ts')
  writeFileSync(f, "import { meter } from '@noy-db/to-meter'\n" + readFileSync(f, 'utf8'))
  const failures = runArchitecture(root, seamCfg(root, { '@noy-db/to-meter': 'dependency' })).failures
  assert.deepEqual(failures.filter((x) => x.rule === 'package-seam'), [])
})

test('package-seam: a TYPE-ONLY import is not a seam', (t) => {
  // This file already paid for getting this wrong: its first version produced 35
  // false failures on correct code, 14 of the 16 on `as` being `import type`.
  // Measured again here — `in-nuxt`'s only `@noy-db/to-meter` reference is
  // `import type { MeterSnapshot }`, so that package rightly owes no row.
  const root = copyFixture(t, 'flat-as')
  const f = join(root, 'as-good/src/index.ts')
  writeFileSync(f, "import type { MeterSnapshot } from '@noy-db/to-meter'\n" + readFileSync(f, 'utf8'))
  assert.deepEqual(runArchitecture(root, seamCfg(root, {})).failures.filter((x) => x.rule === 'package-seam'), [])
})

test('package-seam: an import inside a COMMENT is not a seam', (t) => {
  // family#64 in a second instrument: declared-deps reported a dependency named
  // `peer` from prose. A new specifier scan must not re-earn that bug.
  const root = copyFixture(t, 'flat-as')
  const f = join(root, 'as-good/src/index.ts')
  writeFileSync(f, "// see import('@noy-db/to-meter') for the shape\n" + readFileSync(f, 'utf8'))
  assert.deepEqual(runArchitecture(root, seamCfg(root, {})).failures.filter((x) => x.rule === 'package-seam'), [])
})

test('package-seam: a .vue importer is found — walkTs alone would miss it', (t) => {
  // All four importers of the @noy-db/in-devtools seam are .vue files, so a rule
  // built on walkTs would have missed the exact seam family#41 was filed about.
  const root = copyFixture(t, 'flat-as')
  mkdirSync(join(root, 'as-good/src/ui'), { recursive: true })
  writeFileSync(join(root, 'as-good/src/ui/Panel.vue'),
    "<script setup lang=\"ts\">\nimport { open } from '@noy-db/in-devtools'\n</script>\n<template><div /></template>\n")
  const seam = runArchitecture(root, seamCfg(root, {})).failures.filter((x) => x.rule === 'package-seam')
  assert.equal(seam.length, 1)
  assert.match(seam[0].msg, /in-devtools/)
  assert.match(seam[0].where, /Panel\.vue$/)
})

test('package-seam: a STALE declaration nothing imports fails', (t) => {
  // A registry row nobody binds reads as a live obligation; that is how a row rots
  // into a lie.
  const root = copyFixture(t, 'flat-as')
  const failures = runArchitecture(root, seamCfg(root, { '@noy-db/in-devtools': 'peer' })).failures
  const seam = failures.filter((x) => x.rule === 'package-seam')
  assert.equal(seam.length, 1)
  assert.match(seam[0].msg, /no package here imports it/)
})

test('package-seam: optional-peer must actually be marked optional', (t) => {
  const root = copyFixture(t, 'flat-as')
  const f = join(root, 'as-good/src/index.ts')
  writeFileSync(f, "import { x } from '@noy-db/to-meter'\n" + readFileSync(f, 'utf8'))
  const pj = join(root, 'as-good/package.json')
  const j = JSON.parse(readFileSync(pj, 'utf8'))
  j.peerDependencies = { ...j.peerDependencies, '@noy-db/to-meter': '^0.9.0' }
  writeFileSync(pj, JSON.stringify(j, null, 2))
  const failures = runArchitecture(root, seamCfg(root, { '@noy-db/to-meter': 'optional-peer' })).failures
  assert.match(failures.find((x) => x.rule === 'package-seam').msg, /peerDependenciesMeta.*optional is not true/)
})

test('package-seam: an exact pin its own declared range does not admit fails', (t) => {
  const root = copyFixture(t, 'flat-as')
  const f = join(root, 'as-good/src/index.ts')
  writeFileSync(f, "import { x } from '@noy-db/to-meter'\n" + readFileSync(f, 'utf8'))
  const pj = join(root, 'as-good/package.json')
  const j = JSON.parse(readFileSync(pj, 'utf8'))
  j.peerDependencies = { ...j.peerDependencies, '@noy-db/to-meter': '^0.8.0' }
  j.devDependencies = { ...j.devDependencies, '@noy-db/to-meter': '0.9.0-pre.2' }
  writeFileSync(pj, JSON.stringify(j, null, 2))
  const failures = runArchitecture(root, seamCfg(root, { '@noy-db/to-meter': 'peer' })).failures
  const seam = failures.find((x) => x.rule === 'package-seam' && /does not admit/.test(x.msg))
  assert.ok(seam, 'a pin outside its own range is a partial bump waiting to happen')
  assert.match(seam.msg, /0\.9\.0-pre\.2/)
})

test('package-seam: CONTROL — a pin its range DOES admit passes', (t) => {
  const root = copyFixture(t, 'flat-as')
  const f = join(root, 'as-good/src/index.ts')
  writeFileSync(f, "import { x } from '@noy-db/to-meter'\n" + readFileSync(f, 'utf8'))
  const pj = join(root, 'as-good/package.json')
  const j = JSON.parse(readFileSync(pj, 'utf8'))
  j.peerDependencies = { ...j.peerDependencies, '@noy-db/to-meter': '^0.8.0 || ^0.9.0-pre.1' }
  j.devDependencies = { ...j.devDependencies, '@noy-db/to-meter': '0.9.0-pre.2' }
  writeFileSync(pj, JSON.stringify(j, null, 2))
  const failures = runArchitecture(root, seamCfg(root, { '@noy-db/to-meter': 'peer' })).failures
  assert.deepEqual(failures.filter((x) => x.rule === 'package-seam'), [])
})
