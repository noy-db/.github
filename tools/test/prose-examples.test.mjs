import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

// ─── the build-order vacuity guard ──────────────────────────────────────────

test('no built entry point is cannot-run — every import would be an ignored TS2307', (t) => {
  const root = copyHere(t, 'workspace-prose')
  rmSync(join(root, 'packages', 'lib', 'dist'), { recursive: true, force: true })
  const res = gate(root)
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /ZERO exported names/)
})

// ─── the preamble convention ────────────────────────────────────────────────

test('an import-less block with no preamble is a finding', (t) => {
  const root = copyHere(t, 'workspace-prose')
  setReadme(root, ['# @fixture/lib', '', '```ts', "const out: string = shipped('x')", '```', ''].join('\n'))
  const res = gate(root)
  // ⭐ TWO findings, and the pair is the point rather than noise. The block is
  // missing a preamble AND it names `shipped`, which the package publishes.
  // The two rules disagree about the remedy on purpose: the preamble rule says
  // "declare the elided binding", the missing-import rule says "a name we
  // publish is an IMPORT, and declaring it would document an ambient that is
  // not ambient". For a published name the import wins, so a reader who sees
  // both is being told the preamble is the wrong fix here.
  assert.equal(res.failures.length, 2, JSON.stringify(res.failures))
  assert.ok(res.failures.some((f) => /no <!-- prose-preamble -->/.test(f)))
  assert.ok(res.failures.some((f) => /TS2304.*shipped/.test(f)))
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

test('a block that is not TypeScript is named, not silently swallowed', (t) => {
  // ⛔ The reason pass 1 exists: tsc abandons SEMANTIC checking for the whole
  // program on any syntactic diagnostic, so one mislabelled fence would
  // silence every other block and the gate would report success.
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
  const named = res.failures.filter((f) => /not parseable as TypeScript/.test(f))
  assert.equal(named.length, 1, JSON.stringify(res.failures))
  assert.match(named[0], /README\.md:4/)
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
