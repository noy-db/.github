import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runChangesetCoverage, isExempt } from '../src/gates/changeset-coverage.mjs'
import { TOOLS } from './helpers.mjs'

// These fixtures are REAL git repos built per test, not static trees: the gate's
// input is a diff, and a diff only exists between two commits.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const write = (root, path, body) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}

const CFG = { layout: 'flat' }

/**
 * A flat repo (the to/as/on shape): private workspace root, one publishable
 * package `to-a`, one private `to-internal`. Committed on `main`, then a
 * `pr` branch is checked out for the test to change.
 */
function repo(t, { changesets = true, layout = 'flat' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'family-tools-coverage-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q', '-b', 'main')
  write(root, 'family.config.json', { layout, manager: 'pnpm', binds: null, publishes: true, gates: ['changeset-coverage'] })
  if (layout === 'single') {
    write(root, 'package.json', { name: '@noy-db/solo', version: '0.1.0' })
    write(root, 'src/index.ts', 'export const a = 1\n')
  } else {
    write(root, 'package.json', { name: 'noy-db-to', private: true })
    write(root, 'pnpm-workspace.yaml', 'packages:\n  - "to-*"\n')
    write(root, 'to-a/package.json', { name: '@noy-db/to-a', version: '0.1.0' })
    write(root, 'to-a/src/index.ts', 'export const a = 1\n')
    write(root, 'to-internal/package.json', { name: '@noy-db/to-internal', version: '0.1.0', private: true })
    write(root, 'to-internal/src/index.ts', 'export const i = 1\n')
  }
  if (changesets) {
    write(root, '.changeset/config.json', '{}\n')
    write(root, '.changeset/README.md', '# Changesets\n')
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'checkout', '-q', '-b', 'pr')
  return root
}

const commit = (root) => {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'pr')
}
const run = (root, opts = {}) => runChangesetCoverage(root, CFG, { base: 'main', env: {}, ...opts })
const changeset = (root, file, name) => write(root, `.changeset/${file}`, `---\n'${name}': patch\n---\n\nA change.\n`)

// ⭐ (1) THE FALSE CONTROL — family#171's exact shape. If this goes green the
// gate is checking nothing.
test('(1) a source edit to a publishable package with NO changeset is RED, naming the package', (t) => {
  const root = repo(t)
  write(root, 'to-a/src/index.ts', 'export const a = 1\nexport const added = 2\n')
  commit(root)
  const res = run(root)
  assert.equal(res.failures.length, 1)
  assert.match(res.failures[0], /"@noy-db\/to-a"/)
  assert.match(res.failures[0], /to-a\/src\/index\.ts/)
  assert.match(res.failures[0], /no \.changeset\/\*\.md names it/)
})

test('(2) the same edit WITH a changeset naming the package is green, and says what it checked', (t) => {
  const root = repo(t)
  write(root, 'to-a/src/index.ts', 'export const a = 1\nexport const added = 2\n')
  changeset(root, 'add-export.md', '@noy-db/to-a')
  commit(root)
  const res = run(root)
  assert.deepEqual(res.failures, [])
  assert.match(res.scope, /1 publishable package\(s\) touched, 0 unnamed/)
})

test('a changeset naming a DIFFERENT package does not cover this one', (t) => {
  const root = repo(t)
  write(root, 'to-a/src/index.ts', 'export const a = 2\n')
  changeset(root, 'other.md', '@noy-db/to-internal')
  commit(root)
  assert.equal(run(root).failures.length, 1)
})

test('(3) a test-only / docs-only edit is green — the exempt list', (t) => {
  const root = repo(t)
  write(root, 'to-a/__tests__/a.test.ts', 'test()\n')
  write(root, 'to-a/src/a.test.ts', 'test()\n')
  write(root, 'to-a/README.md', '# a\n')
  write(root, 'to-a/docs/guide.txt', 'guide\n')
  write(root, 'to-a/test/fixtures/x.json', '{}\n')
  commit(root)
  const res = run(root)
  assert.deepEqual(res.failures, [])
  assert.match(res.scope, /5 changed path\(s\).*5 exempt, 0 publishable package\(s\) touched/)
})

test('isExempt: the list, and what it deliberately does NOT exempt', () => {
  for (const p of ['a/__tests__/x.ts', 'a/test/x.ts', 'a/src/x.test.ts', 'a/x.spec.mjs', 'CHANGELOG.md', 'a/docs/x.ts', 'a/fixtures/y.json', '.github/workflows/ci.yml', '.changeset/x.md', 'family.config.json', 'pnpm-lock.yaml', 'examples/x/pnpm-lock.yaml'])
    assert.equal(isExempt(p), true, p)
  // package.json is a published change (a pin bump), and `testing.ts` is source.
  for (const p of ['a/src/index.ts', 'a/package.json', 'a/src/testing.ts', 'a/src/latest.ts', '.npmignore', 'a/family.config.json'])
    assert.equal(isExempt(p), false, p)
})

test('(4) an edit to a PRIVATE package needs no changeset', (t) => {
  const root = repo(t)
  write(root, 'to-internal/src/index.ts', 'export const i = 2\n')
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n') // the private workspace root
  commit(root)
  const res = run(root)
  assert.deepEqual(res.failures, [])
  assert.match(res.scope, /0 publishable package\(s\) touched/)
})

test('(5) a repo without .changeset/ is a pass that SAYS the gate does not apply', (t) => {
  const root = repo(t, { changesets: false })
  write(root, 'to-a/src/index.ts', 'export const a = 2\n')
  commit(root)
  const res = run(root)
  assert.deepEqual(res.failures, [])
  assert.equal(res.status, undefined)
  assert.match(res.scope, /^n\/a — no \.changeset\//)
})

test('(6) a release PR (changesets consumed + versions bumped) passes as a release PR', (t) => {
  const root = repo(t)
  changeset(root, 'pending.md', '@noy-db/to-a')
  write(root, 'to-a/src/index.ts', 'export const a = 2\n')
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'feature'); git(root, 'checkout', '-q', 'main'); git(root, 'merge', '-q', 'pr')
  git(root, 'checkout', '-q', '-b', 'release')
  // What `changeset version` writes: the changeset gone, the version bumped,
  // a CHANGELOG entry. (A dep-only bump also edits src-less manifests.)
  unlinkSync(join(root, '.changeset/pending.md'))
  write(root, 'to-a/package.json', { name: '@noy-db/to-a', version: '0.1.1' })
  write(root, 'to-a/CHANGELOG.md', '## 0.1.1\n')
  commit(root)
  const res = run(root)
  assert.deepEqual(res.failures, [])
  assert.match(res.scope, /^release PR — consumes 1 changeset\(s\) and bumps 1 manifest/)
})

// core cuts its pre line in changesets PRE MODE: `changeset version` keeps the
// files and records them in pre.json. Measured on core's 0.10.0-pre.2 PR (#214).
const enterPre = (root, recorded) =>
  write(root, '.changeset/pre.json', { mode: 'pre', tag: 'pre', initialVersions: {}, changesets: recorded })

test('(6b) a PRE-MODE release PR (pre.json updated, versions bumped, nothing deleted) passes', (t) => {
  const root = repo(t)
  enterPre(root, [])
  changeset(root, 'pending.md', '@noy-db/to-a')
  write(root, 'to-a/src/index.ts', 'export const a = 2\n')
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'feature'); git(root, 'checkout', '-q', 'main'); git(root, 'merge', '-q', 'pr')
  git(root, 'checkout', '-q', '-b', 'release')
  enterPre(root, ['pending'])
  write(root, 'to-a/package.json', { name: '@noy-db/to-a', version: '0.1.1-pre.0' })
  commit(root)
  const res = run(root)
  assert.deepEqual(res.failures, [])
  assert.match(res.scope, /^release PR — records changesets in pre\.json/)
})

test('in pre mode a changeset ALREADY RECORDED in pre.json does not cover a new change', (t) => {
  const root = repo(t)
  enterPre(root, ['old'])
  changeset(root, 'old.md', '@noy-db/to-a')
  commit(root)
  git(root, 'checkout', '-q', 'main'); git(root, 'merge', '-q', 'pr'); git(root, 'checkout', '-q', '-b', 'pr2')
  write(root, 'to-a/src/index.ts', 'export const a = 9\n')
  commit(root)
  const res = run(root)
  assert.equal(res.failures.length, 1)
  assert.match(res.scope, /0 pending changeset file\(s\) \(1 consumed in pre mode/)
  // …and in mode "exit" the next `changeset version` still versions it, so it covers.
  write(root, '.changeset/pre.json', { mode: 'exit', tag: 'pre', initialVersions: {}, changesets: ['old'] })
  commit(root)
  assert.deepEqual(run(root).failures, [])
})

test('deleting a changeset WITHOUT a version bump is not a release PR — the source edit still reds', (t) => {
  const root = repo(t)
  changeset(root, 'stale.md', '@noy-db/to-a')
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'cs'); git(root, 'checkout', '-q', 'main'); git(root, 'merge', '-q', 'pr')
  git(root, 'checkout', '-q', '-b', 'pr2')
  unlinkSync(join(root, '.changeset/stale.md'))
  write(root, 'to-a/src/index.ts', 'export const a = 3\n')
  commit(root)
  assert.equal(run(root).failures.length, 1)
})

test('a push in Actions (no GITHUB_BASE_REF) is n/a — not a PR', (t) => {
  const root = repo(t)
  write(root, 'to-a/src/index.ts', 'export const a = 2\n')
  commit(root)
  const res = runChangesetCoverage(root, CFG, { env: { GITHUB_ACTIONS: 'true' } })
  assert.deepEqual(res.failures, [])
  assert.equal(res.scope, 'n/a — not a PR')
})

test('an unresolvable base is cannot-run, never a pass', (t) => {
  const root = repo(t)
  const res = run(root, { base: 'origin/does-not-exist' })
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /origin\/does-not-exist/)
})

test('an unreadable workspace manifest is cannot-run, never a pass', (t) => {
  const root = repo(t)
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - "**/pkgs"\n')
  commit(root)
  assert.equal(run(root).status, 'cannot-run')
})

test('single layout: the root IS the package — a source edit reds, a workflow edit does not', (t) => {
  const root = repo(t, { layout: 'single' })
  write(root, '.github/workflows/ci.yml', 'on: push\n')
  commit(root)
  assert.deepEqual(runChangesetCoverage(root, { layout: 'single' }, { base: 'main', env: {} }).failures, [])
  write(root, 'src/index.ts', 'export const a = 2\n')
  commit(root)
  const res = runChangesetCoverage(root, { layout: 'single' }, { base: 'main', env: {} })
  assert.equal(res.failures.length, 1)
  assert.match(res.failures[0], /@noy-db\/solo/)
})

// ⭐ THE SHAPE CI ACTUALLY RUNS: actions/checkout at depth 1, base from
// GITHUB_BASE_REF. A shallow clone has no merge-base; without the fetch every
// PR in an opted-in repo would be cannot-run.
test('a depth-1 clone with GITHUB_BASE_REF still reaches a verdict', (t) => {
  const src = repo(t)
  write(src, 'to-a/src/index.ts', 'export const a = 2\n')
  commit(src)
  const bare = mkdtempSync(join(tmpdir(), 'family-tools-coverage-bare-'))
  const clone = mkdtempSync(join(tmpdir(), 'family-tools-coverage-clone-'))
  t.after(() => { rmSync(bare, { recursive: true, force: true }); rmSync(clone, { recursive: true, force: true }) })
  git(bare, 'clone', '-q', '--bare', src, '.')
  git(clone, 'clone', '-q', '--depth', '1', '--branch', 'pr', `file://${bare}`, '.')
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository').trim(), 'true', 'precondition: shallow')
  const res = runChangesetCoverage(clone, CFG, { env: { GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' } })
  assert.equal(res.status, undefined, res.cannotRun)
  assert.equal(res.failures.length, 1)
  assert.match(res.scope, /vs origin\/main@/)
})

test('the CLI exits 1 on the false control and 2 when it cannot run', (t) => {
  const root = repo(t)
  write(root, 'to-a/src/index.ts', 'export const a = 2\n')
  commit(root)
  const cli = (...args) => spawnSync(process.execPath, [join(TOOLS, 'cli.mjs'), 'changeset-coverage', '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_BASE_REF: '' },
  })
  const red = cli('--base', 'main')
  assert.equal(red.status, 1, red.stderr)
  assert.match(red.stderr, /@noy-db\/to-a/)
  assert.equal(cli('--base', 'nope').status, 2)
})
