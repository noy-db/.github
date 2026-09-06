import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { runCodemodRows } from '../src/gates/codemod-rows.mjs'
import { copyFixture, FIXTURES } from './helpers.mjs'

const gate = (root, overrides = {}) => runCodemodRows(root, { ...loadConfig(root), ...overrides })

const SRC = 'packages/a/src/index.ts'

test('workspace: a row whose new name is present and old name gone is green', () => {
  const { failures, status } = gate(join(FIXTURES, 'workspace'))
  assert.equal(status, 'ok')
  assert.deepEqual(failures, [])
})

test('workspace: a row naming a package this repo does not hold is somebody else\'s to answer for', () => {
  // fixtures/workspace's map carries a second row for @noy-db/somewhere-else,
  // which is absent here. The green assertion above only means something
  // because that row is skipped rather than failed.
  const map = JSON.parse(
    readFileSync(join(FIXTURES, 'workspace/packages/hub/codemods/0.7.0.json'), 'utf8'),
  )
  assert.equal(map.renames.length, 2)
})

test('workspace: the promised NEW name missing from src fails', (t) => {
  const root = copyFixture(t, 'workspace')
  const p = join(root, SRC)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/NewName/g, 'Unrelated'))
  const { failures, status } = gate(root)
  assert.equal(status, 'ok')
  assert.equal(failures.length, 1)
  assert.match(failures[0], /"NewName" appears nowhere/)
})

test('workspace: the renamed-away OLD name still present fails, for a safeGlobalReplace row', (t) => {
  const root = copyFixture(t, 'workspace')
  const p = join(root, SRC)
  writeFileSync(p, readFileSync(p, 'utf8') + '\nexport const OldName = 2\n')
  const { failures } = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /"OldName" is STILL present/)
})

test('workspace: an unresolvable hub is `no-hub`, not a violation', (t) => {
  const root = copyFixture(t, 'workspace')
  rmSync(join(root, 'packages/a/node_modules'), { recursive: true, force: true })
  const { failures, status } = gate(root)
  assert.equal(status, 'no-hub')
  assert.deepEqual(failures, [])
})
