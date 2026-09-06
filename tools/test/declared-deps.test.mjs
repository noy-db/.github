import { test } from 'node:test'
import assert from 'node:assert/strict'
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
