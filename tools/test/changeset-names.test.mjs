import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { runChangesetNames, changesetNames, workspacePackages } from '../src/gates/changeset-names.mjs'
import { copyFixture, FIXTURES } from './helpers.mjs'

const FIX = 'workspace-changesets'
const run = (root) => runChangesetNames(root, loadConfig(root))
const gate = (root) => run(root).failures

const changeset = (root, name, body) => writeFileSync(join(root, '.changeset', name), body)

test('a changeset naming a real workspace package is green', () => {
  assert.deepEqual(gate(join(FIXTURES, FIX)), [])
})

// ⭐ THE FALSE-POSITIVE CONTROL, and the reason this gate does not use
// packageDirs(). core's workspace declares test-harnesses/* as well as
// packages/*, so a denominator that walks only packages/ would report six
// private harnesses as deleted and block a correct merge.
test('a package OUTSIDE packages/ but inside the workspace globs is not dead', () => {
  const res = run(join(FIXTURES, FIX))
  assert.deepEqual(res.failures, [])
  assert.match(res.scope, /against 4 workspace package\(s\)/)
})

test('a changeset naming a package the workspace does not have FAILS, naming file and package', (t) => {
  const root = copyFixture(t, FIX)
  changeset(root, 'dead.md', "---\n'@noy-db/test-capsule-conformance': patch\n---\n\nThe shape that killed the rail.\n")
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /dead\.md/)
  assert.match(failures[0], /@noy-db\/test-capsule-conformance/)
  assert.match(failures[0], /not in the workspace/)
  // The remedy has to be in the message: the author is about to choose between
  // re-pointing and deleting, and deleting silently loses a release note.
  assert.match(failures[0], /Re-point it|drop the file/)
})

test('DELETING the package a live changeset names turns the gate red — the real sequence', (t) => {
  const root = copyFixture(t, FIX)
  assert.deepEqual(gate(root), [], 'precondition: green before the deletion')
  rmSync(join(root, 'packages', 'a'), { recursive: true })
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /@noy-db\/a/)
})

test('every dead ROW is reported, not just the first — one file may bump several', (t) => {
  const root = copyFixture(t, FIX)
  changeset(root, 'multi.md', "---\n'@noy-db/gone-one': patch\n'@noy-db/gone-two': minor\n'@noy-db/a': patch\n---\n\nThree rows, two dead.\n")
  const failures = gate(root)
  assert.equal(failures.length, 2)
  assert.ok(failures.some((f) => /gone-one/.test(f)))
  assert.ok(failures.some((f) => /gone-two/.test(f)))
})

test('prose with no frontmatter is ignored, never parsed as a changeset', (t) => {
  const root = copyFixture(t, FIX)
  changeset(root, 'notes.md', '# Some notes\n\n@noy-db/definitely-not-a-package: patch\n')
  assert.deepEqual(gate(root), [])
})

test('zero changesets is GREEN, not cannot-run — it is the normal state after a release', (t) => {
  const root = copyFixture(t, FIX)
  for (const f of readdirSync(join(root, '.changeset'))) unlinkSync(join(root, '.changeset', f))
  const res = run(root)
  assert.deepEqual(res.failures, [])
  assert.equal(res.status, undefined)
  // ...and the scope says so, so "0 rows" and "35 rows, all fine" do not print
  // the same green (noy-db/.github#23).
  assert.match(res.scope, /^0 bump row\(s\)/)
})

test('no .changeset/ directory is cannot-run, never a vacuous pass', (t) => {
  const root = copyFixture(t, FIX)
  rmSync(join(root, '.changeset'), { recursive: true })
  const res = run(root)
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /no \.changeset\//)
})

test('a multi-package layout with no workspace manifest is cannot-run — the false-positive direction stops the gate', (t) => {
  const root = copyFixture(t, FIX)
  rmSync(join(root, 'pnpm-workspace.yaml'))
  const res = run(root)
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /no workspace manifest/)
})

test('a workspace glob shape the gate does not understand is cannot-run, never guessed', (t) => {
  const root = copyFixture(t, FIX)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/**/deep"\n')
  const res = run(root)
  assert.equal(res.status, 'cannot-run')
  assert.match(res.cannotRun, /does not guess/)
})

test('npm-style root "workspaces" is read when there is no pnpm-workspace.yaml', (t) => {
  const root = copyFixture(t, FIX)
  rmSync(join(root, 'pnpm-workspace.yaml'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*', 'test-harnesses/*'] }))
  assert.deepEqual(gate(root), [])
})

test('changesetNames parses the bump rows and ignores the body', () => {
  assert.deepEqual(changesetNames("---\n'@noy-db/a': patch\n\"b\": minor\nc: major\n---\n\n'@noy-db/not-a-row': patch\n"),
    ['@noy-db/a', 'b', 'c'])
  assert.equal(changesetNames('no frontmatter here\n'), null)
})

test('workspacePackages reports an unreadable manifest rather than an empty set', (t) => {
  const root = copyFixture(t, FIX)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  this is not a list item\n')
  const res = workspacePackages(root, 'workspace')
  assert.ok(res.unparsed, 'must report unparsed, not return a silently short set')
  assert.equal(res.names, undefined)
})

// ⭐ docs-site's pnpm-workspace.yaml lists `showcases` and `registry` — literal
// directories, not globs. Rejecting a star-free entry made that repo exit 2, and
// a repo that cannot run a gate quietly stops being covered by it.
test('a LITERAL workspace directory (no glob) contributes its package', (t) => {
  const root = copyFixture(t, FIX)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - "registry"\n')
  const res = run(root)
  // @noy-db/test-kit is no longer in the globs, so its changeset is now dead —
  // which is the control that the set really is being recomputed.
  assert.equal(res.failures.length, 1)
  assert.match(res.failures[0], /@noy-db\/test-kit/)
  assert.match(res.scope, /against 4 workspace package\(s\)/)
})

test('a literal directory that does not exist is skipped, not an error', (t) => {
  const root = copyFixture(t, FIX)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - "test-harnesses/*"\n  - "nope"\n')
  assert.deepEqual(gate(root), [])
})

test('a star in the MIDDLE is still refused — the gate guesses nothing', (t) => {
  const root = copyFixture(t, FIX)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "pack*ges/*"\n')
  assert.equal(run(root).status, 'cannot-run')
})
