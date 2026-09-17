import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { runProseExamples, collectPublishedNames } from '../src/gates/prose-examples.mjs'
import { FIXTURES, TOOLS } from './helpers.mjs'

/**
 * A throwaway fixture copy placed UNDER `tools/`, not in os.tmpdir().
 *
 * ⛔ Load-bearing, and the shared `copyFixture` cannot be used here. This gate
 * resolves the repo's OWN `typescript` (never `npx`, which would fetch one and
 * check the prose against a compiler the repo never uses). Node resolution
 * walks up parent directories, so a copy under `tools/` finds
 * `tools/node_modules/typescript`; a copy in /tmp finds nothing and every test
 * would pass vacuously through the `cannot-run` branch — which is exactly the
 * failure mode this gate exists to refuse.
 */
function copyHere(t, name) {
  const dir = mkdtempSync(join(TOOLS, `.prose-fixture-${name}-`))
  cpSync(join(FIXTURES, name), dir, { recursive: true, verbatimSymlinks: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const gate = (root) => runProseExamples(root, loadConfig(root))
const readme = (root) => join(root, 'packages', 'lib', 'README.md')
const setReadme = (root, body) => writeFileSync(readme(root), body)

test('the fixture as committed is green — a self-contained block that compiles', (t) => {
  const root = copyHere(t, 'workspace-prose')
  const res = gate(root)
  assert.equal(res.status, undefined, `expected a real run, got cannot-run: ${res.cannotRun}`)
  assert.deepEqual(res.failures, [])
})

// ─── the TS2304 rule ────────────────────────────────────────────────────────

test('⭐ a published name used with NO import is a finding, not probe noise', (t) => {
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, [
    '# @fixture/lib', '',
    '```ts',
    "import { shipped } from '@fixture/lib'",
    '',
    "const out: string = shipped('hello')",
    'const n: number = alsoShipped()',   // published by the package, never imported
    'console.log(out, n)',
    '```', '',
  ].join('\n'))
  const res = gate(root)
  assert.equal(res.status, undefined, `expected a real run, got: ${res.cannotRun}`)
  assert.equal(res.failures.length, 1, `expected exactly one finding, got ${JSON.stringify(res.failures)}`)
  assert.match(res.failures[0], /alsoShipped/)
  assert.match(res.failures[0], /TS2304/)
  // The line must point at the prose, not at a probe file.
  assert.match(res.failures[0], /README\.md:7/)
})

test('a name we do NOT publish stays exempt — the exemption is narrowed, not removed', (t) => {
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, [
    '# @fixture/lib', '',
    '```ts',
    "import { shipped } from '@fixture/lib'",
    '',
    'const out: string = shipped(userSuppliedValue)', // reader's own binding
    'console.log(out)',
    '```', '',
  ].join('\n'))
  assert.deepEqual(gate(root).failures, [])
})

// ─── the empty-scope guard ──────────────────────────────────────────────────

test('⭐ zero blocks is cannot-run (exit 2), never a clean pass', (t) => {
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, '# @fixture/lib\n\nProse with no fenced code at all.\n')
  const res = gate(root)
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /ZERO fenced blocks/)
  assert.deepEqual(res.failures, [], 'cannot-run reports no findings — it did not get far enough to have any')
})

test('the empty-scope guard does not need a compiler — a broken scope must not be masked', (t) => {
  // Ordering assertion: reading prose needs no tsc, so a repo with neither a
  // compiler NOR any blocks must report the BLOCKS problem. The more specific
  // failure has to win, or the message sends a reader to the wrong problem.
  const root = mkdtempSync(join(TOOLS, '.prose-fixture-bare-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(join(FIXTURES, 'workspace-prose'), root, { recursive: true, verbatimSymlinks: true })
  setReadme(root, '# @fixture/lib\n\nNo blocks here.\n')
  const res = gate(root)
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /ZERO fenced blocks/)
})

// ─── the departed-package rule ──────────────────────────────────────────────

test('⭐ an import of a package the workspace neither holds nor declares is a finding', (t) => {
  // The TS2307 ignore exists for a sibling that is not built HERE. A package
  // that exists NOWHERE produces the same code, and until this rule the gate
  // could not tell them apart — a README kept teaching `@noy-db/to-memory` for
  // a day after the directory left the repo, green throughout.
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, ['# @fixture/lib', '', '```ts', "import { gone } from '@fixture/gone'", "const out: string = gone('x')", '```', ''].join('\n'))
  const res = gate(root)
  assert.equal(res.status, undefined, `expected a real run, got cannot-run: ${res.cannotRun}`)
  assert.equal(res.failures.length, 1, JSON.stringify(res.failures))
  assert.match(res.failures[0], /TS2307.*@fixture\/gone/)
})

test('an import of a DECLARED sibling that is not built here stays ignored', (t) => {
  // The other half: declaring the package is how the workspace vouches for
  // it. Same TS2307, no finding — the ignore keeps its legitimate case.
  const root = copyHere(t, 'workspace-prose')
  const pkgPath = join(root, 'packages', 'lib', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.devDependencies = { '@fixture/sibling': '1.0.0' }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  setReadme(root, ['# @fixture/lib', '', '```ts', "import { sib } from '@fixture/sibling/sub'", "const out: string = sib('x')", '```', ''].join('\n'))
  const res = gate(root)
  assert.equal(res.status, undefined, `expected a real run, got cannot-run: ${res.cannotRun}`)
  assert.deepEqual(res.failures, [])
})

// ─── the build-order vacuity guard ──────────────────────────────────────────

test('no built entry point is cannot-run — every import would be an ignored TS2307', (t) => {
  const root = copyHere(t, 'workspace-prose')
  rmSync(join(root, 'packages', 'lib', 'dist'), { recursive: true, force: true })
  const res = gate(root)
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /ZERO exported names/)
})

// ─── the preamble convention ────────────────────────────────────────────────

test('an import-less block naming a PUBLISHED symbol is a missing import, not a preamble ask', (t) => {
  // ⭐ The preamble rule fires on a DIAGNOSTIC, not on the marker's absence.
  // `shipped` is published, so the remedy is an import — and a preamble that
  // declared it would document an ambient that is not ambient. Only one
  // finding, and it is the right one.
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, ['# @fixture/lib', '', '```ts', "const out: string = shipped('x')", '```', ''].join('\n'))
  const res = gate(root)
  assert.equal(res.failures.length, 1, JSON.stringify(res.failures))
  assert.match(res.failures[0], /TS2304.*shipped/)
})

test('an import-less block using a NON-published binding reports only the preamble', (t) => {
  // The other half of the pair above: with no published name involved, the
  // preamble rule is the whole finding and its remedy is the right one.
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, ['# @fixture/lib', '', '```ts', 'const out: string = readersOwnHelper()', '```', ''].join('\n'))
  const res = gate(root)
  assert.equal(res.failures.length, 1, JSON.stringify(res.failures))
  assert.match(res.failures[0], /no <!-- prose-preamble -->/)
})

test('a preamble that TYPES the elided binding makes an import-less block compile', (t) => {
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, [
    '# @fixture/lib', '',
    '<!-- prose-preamble',
    "import type { ShippedOptions } from '@fixture/lib'",
    'declare const opts: ShippedOptions',
    '-->', '',
    '```ts',
    "const mode: 'fast' | 'safe' = opts.mode",
    'console.log(mode)',
    '```', '',
  ].join('\n'))
  assert.deepEqual(gate(root).failures, [])
})

test('a preamble that only IMPORTS, leaving the binding untyped, does not launder the block', (t) => {
  // The convention's whole point: `declare const x: T`, never a bare import.
  // An untyped binding makes the call compile vacuously, which is the
  // laundering the preamble was introduced to stop.
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, [
    '# @fixture/lib', '',
    '<!-- prose-preamble',
    "import type { ShippedOptions } from '@fixture/lib'",
    'declare const opts: ShippedOptions',
    '-->', '',
    '```ts',
    "const mode: number = opts.mode",  // mode is a string union — a real error
    '```', '',
  ].join('\n'))
  const res = gate(root)
  assert.equal(res.failures.length, 1, JSON.stringify(res.failures))
  assert.match(res.failures[0], /TS2322/)
})

// ─── pass 1: unparseable blocks ─────────────────────────────────────────────

test('⭐ a block that is not TypeScript is EXCLUDED and NAMED, never failed', (t) => {
  // ⛔ Illustrative-only is a CONSEQUENCE of not being a program, not an
  // opt-out. Excluding is required, not merely kind: tsc abandons SEMANTIC
  // checking for the whole program on any syntactic diagnostic, so one
  // mislabelled fence would silence every other block. Naming it is what stops
  // the exclusion growing silently into a gate that checks nothing.
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, [
    '# @fixture/lib', '',
    '```ts',
    'with<Name>(  :: not typescript at all',
    '```', '',
    '```ts',
    "import { shipped } from '@fixture/lib'",
    "const out: string = shipped('hello')",
    'console.log(out)',
    '```', '',
  ].join('\n'))
  const res = gate(root)
  assert.deepEqual(res.failures, [], 'an unparseable block is not a failure')
  assert.ok(res.notes.some((n) => /README\.md:4/.test(n)), `named in notes: ${JSON.stringify(res.notes)}`)
  assert.ok(res.notes.some((n) => /excluded as not-a-program/.test(n)))
})

test('the block AFTER an unparseable one is still checked — the exclusion is why', (t) => {
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, [
    '# @fixture/lib', '',
    '```ts',
    'with<Name>(  :: not typescript at all',
    '```', '',
    '```ts',
    "import { shipped } from '@fixture/lib'",
    "const n: number = shipped('hello')",   // a REAL error, must survive
    '```', '',
  ].join('\n'))
  const res = gate(root)
  assert.equal(res.failures.length, 1, JSON.stringify(res.failures))
  assert.match(res.failures[0], /TS2322/)
})

test('⭐ a declaration-only block is excluded and named, not failed as a broken program', (t) => {
  // `at` ships five "## API" signature listings. They PARSE, so pass 1's
  // syntactic filter never sees them; what they produce is TS2391 per
  // signature. A surface listing is documentation, not a program that runs.
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, [
    '# @fixture/lib', '', '## API', '',
    '```ts',
    'export function encryptThing(input: string): Promise<string>',
    'export function decryptThing(input: string): Promise<string>',
    '```', '',
  ].join('\n'))
  const res = gate(root)
  assert.deepEqual(res.failures, [], JSON.stringify(res.failures))
  assert.ok(res.notes.some((n) => /README\.md:6/.test(n)), JSON.stringify(res.notes))
})

test('a signature listing with a REAL error alongside it is still failed', (t) => {
  // The decl-only exclusion must not be earnable by adding one signature to a
  // block that is otherwise a broken program.
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, [
    '# @fixture/lib', '',
    '```ts',
    "import { shipped } from '@fixture/lib'",
    'export function encryptThing(input: string): Promise<string>',
    "const n: number = shipped('x')",
    '```', '',
  ].join('\n'))
  const res = gate(root)
  assert.ok(res.failures.some((f) => /TS2322/.test(f)), JSON.stringify(res.failures))
})

// ─── collectPublishedNames ──────────────────────────────────────────────────

test('collectPublishedNames reads every published entry point, values and types', (t) => {
  const root = copyHere(t, 'workspace-prose')
  const names = collectPublishedNames([join(root, 'packages', 'lib')])
  assert.ok(names.has('shipped'))
  assert.ok(names.has('alsoShipped'))
  assert.ok(names.has('ShippedOptions'), 'an exported TYPE is a published name too')
  assert.ok(!names.has('userSuppliedValue'))
})

test('collectPublishedNames ignores a package whose entry point is not built', (t) => {
  const root = copyHere(t, 'workspace-prose')
  rmSync(join(root, 'packages', 'lib', 'dist'), { recursive: true, force: true })
  assert.equal(collectPublishedNames([join(root, 'packages', 'lib')]).size, 0)
})

// ─── the probe leaves nothing behind ────────────────────────────────────────

test('the probe directory is removed even when the run fails', (t) => {
  // A left-behind probe would be committed by the next `git add -A`, and it
  // contains a generated tsconfig that looks authored.
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, ['# @fixture/lib', '', '```ts', "const n: number = 'not a number'", '```', ''].join('\n'))
  const res = gate(root)
  assert.ok(res.failures.length > 0, 'the mutation must actually fail, or this proves nothing')
  assert.equal(existsSync(join(root, 'packages', 'lib', '.prose-examples')), false)
})

// ─── fixture hygiene, repo-wide ─────────────────────────────────────────────

test('⛔ no fixture symlink resolves inside itself — a cycle breaks setup-family for EVERY repo', () => {
  // THE INCIDENT (2026-09-16). This gate's first fixture committed
  // `packages/lib/node_modules/@fixture/lib -> ../..`, pointing back at the
  // package that CONTAINS it. Local tests passed; `npm test` passed; the gate
  // passed on five real trees. Then `setup-family` staged the .github repo for
  // every consumer and died on "Too many levels of symbolic links", failing the
  // config job — the FIRST job — in every repo on @v1 at once.
  //
  // ⭐ The symlink was not only harmful, it was unnecessary: a package
  // self-references through its own `name` + `exports`, with no node_modules
  // entry at all. The fixture resolves `@fixture/lib` today with nothing there.
  //
  // Scoped to the whole fixtures tree, not to this gate's: the blast radius is
  // the action, so any fixture can cause it.
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) { out.push(p); continue }
      if (e.isDirectory()) walk(p, out)
    }
    return out
  }
  const offenders = []
  for (const link of walk(FIXTURES)) {
    const target = resolve(dirname(link), readlinkSync(link))
    // A link that resolves to one of its own ancestors is a cycle: walking into
    // it re-enters the link, forever.
    if (link === target || link.startsWith(target + sep)) offenders.push(`${link} -> ${readlinkSync(link)}`)
  }
  assert.deepEqual(offenders, [])
})

test('⛔ a declared type package the probe cannot resolve is cannot-run, never green', (t) => {
  // THE LIVE CASE: a package declares @types/node, so the gate asks for
  // `types: ['node']`, and the probe cannot resolve it — a partial install, a
  // pruned CI cache, a workspace whose types were never hoisted.
  //
  // ⛔ TS2688 carries NO FILE, so the diagnostic parser drops it, and tsc's
  // semantic checking is compromised for the whole program. Without this
  // branch the gate reports SUCCESS on a program it barely looked at.
  //
  // Found while testing something else entirely: an assertion that a real
  // TS2322 still fires FAILED, because the fixture had no @types/node and
  // every block was passing vacuously. The gate could not see its own
  // blindness — the class it exists to refuse.
  const root = copyHere(t, 'workspace-prose')
  const manifest = join(root, 'packages', 'lib', 'package.json')
  const json = JSON.parse(readFileSync(manifest, 'utf8'))
  json.devDependencies = { '@types/node': '^22.0.0' }   // declared, never installed
  writeFileSync(manifest, JSON.stringify(json, null, 2) + '\n')

  const res = gate(root)
  assert.equal(res.status, 'cannot-run', JSON.stringify(res))
  assert.match(res.cannotRun, /TS2688/)
  assert.deepEqual(res.failures, [], 'it did not get far enough to have findings')
})

test('…and the same tree WITHOUT the unresolvable declaration is green — the guard is not blanket', (t) => {
  const root = copyHere(t, 'workspace-prose')
  const res = gate(root)
  assert.equal(res.status, undefined)
  assert.deepEqual(res.failures, [])
})
