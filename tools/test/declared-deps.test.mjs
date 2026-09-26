import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { runDeclaredDeps } from '../src/gates/declared-deps.mjs'
import { copyFixture, FIXTURES } from './helpers.mjs'

const gate = (root, overrides = {}) => runDeclaredDeps(root, { ...loadConfig(root), ...overrides }).failures

const SRC = 'packages/a/src/index.ts'

test('workspace: a package importing only what it declares is green', () => {
  assert.deepEqual(gate(join(FIXTURES, 'workspace')), [])
})

test('workspace: an import of an undeclared package fails, naming the package and the file', (t) => {
  const root = copyFixture(t, 'workspace')
  appendFileSync(join(root, SRC), "\nimport { chunk } from 'lodash'\nexport const c = chunk\n")
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /@noy-db\/a: uses "lodash"/)
  assert.match(failures[0], /index\.ts/)
})

test('workspace: root tooling is exempt — vitest, tsup, typescript, eslint', (t) => {
  const root = copyFixture(t, 'workspace')
  for (const name of ['vitest', 'tsup', 'typescript', 'eslint'])
    appendFileSync(join(root, SRC), `\nimport '${name}'\n`)
  assert.deepEqual(gate(root), [])
})

test('workspace: a @vitest-environment pragma counts as a use, though no import can see it', (t) => {
  const root = copyFixture(t, 'workspace')
  const p = join(root, SRC)
  writeFileSync(p, '/** @vitest-environment happy-dom */\n' + readFileSync(p, 'utf8'))
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /uses "happy-dom"/)
})

test('workspace: a subpath import resolves to its bare package name', (t) => {
  const root = copyFixture(t, 'workspace')
  appendFileSync(join(root, SRC), "\nimport '@scope/pkg/deep/path'\n")
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /uses "@scope\/pkg"/)
})

// ── noy-db/.github#23 ─────────────────────────────────────────────────────────
test('a tree whose package walk finds NOTHING is cannot-run, not clean', (t) => {
  const root = copyFixture(t, 'workspace')
  rmSync(join(root, 'packages'), { recursive: true, force: true })
  const res = runDeclaredDeps(root, loadConfig(root))
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /ZERO/)
  assert.deepEqual(res.failures, [])
})

test('a green names the scope it checked', (t) => {
  const root = copyFixture(t, 'workspace')
  const res = runDeclaredDeps(root, loadConfig(root))
  assert.match(res.scope, /package\(s\)/)
})

// ── family#64 ────────────────────────────────────────────────────────────────

test('import syntax inside a COMMENT is not a dependency', (t) => {
  // The real shape from noy-db/to's bundle-size.test.ts. This gate reported
  // `uses "peer" but does not declare it` for to-aws-s3 and to-aws-dynamo, whose
  // only imports are vitest plus three node: builtins — and the false rows blocked
  // enabling it on the family's largest publisher (19 packages).
  const root = copyFixture(t, 'workspace')
  appendFileSync(join(root, SRC), [
    '',
    '// Static (`from "peer"`) or dynamic (`import("peer")`) — this package',
    '// must not inline it. Subpaths count too: the hub peer is bound as',
    '// `@noy-db/hub/to`, never inlined.',
    '/* and a block form: import("ghost-block") */',
    '',
  ].join('\n'))
  assert.deepEqual(gate(root), [], 'prose about import syntax is not an import')
})

test('CONTROL: a genuinely undeclared dependency in real code is still caught', (t) => {
  // Without this, the comment fix could blank the scan into always-passing, which
  // is a worse defect than over-firing.
  const root = copyFixture(t, 'workspace')
  appendFileSync(join(root, SRC), [
    '',
    '// a comment naming import("ghost") — must be ignored',
    'import { x } from "genuinely-undeclared"',
    'export const y = async () => import("also-undeclared")',
    '',
  ].join('\n'))
  const named = gate(root).join('\n')
  assert.match(named, /genuinely-undeclared/, 'a static import in code is still caught')
  assert.match(named, /also-undeclared/, 'and a dynamic one')
  assert.ok(!named.includes('ghost'), 'while the commented one is not')
})

test('a URL in a string is not a comment, and the line after it still scans', (t) => {
  const root = copyFixture(t, 'workspace')
  appendFileSync(join(root, SRC), [
    '',
    'export const u = "https://example.com//x"',
    'import { z } from "after-the-url"',
    '',
  ].join('\n'))
  assert.match(gate(root).join('\n'), /after-the-url/, 'stripping a // inside a string would eat this')
})
