import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { runVersionsUniform } from '../src/gates/versions-uniform.mjs'
import { copyFixture, FIXTURES } from './helpers.mjs'

const gate = (root, overrides = {}) => runVersionsUniform(root, { ...loadConfig(root), ...overrides }).failures

const editPkg = (root, rel, fn) => {
  const p = join(root, rel, 'package.json')
  const json = JSON.parse(readFileSync(p, 'utf8'))
  fn(json)
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n')
}

test('workspace: a uniform line whose internal range admits what it points at is green', () => {
  assert.deepEqual(gate(join(FIXTURES, 'workspace')), [])
})

test('workspace: two different versions across the line fail', (t) => {
  const root = copyFixture(t, 'workspace')
  editPkg(root, 'packages/a', (j) => {
    j.version = '0.6.0'
  })
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /not uniform/)
})

test('workspace: an internal range that excludes the sibling it points at fails', (t) => {
  const root = copyFixture(t, 'workspace')
  editPkg(root, 'packages/a', (j) => {
    j.peerDependencies['@noy-db/hub'] = '^0.6.0'
  })
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /does NOT admit @noy-db\/hub@0\.7\.0/)
})

test('workspace: a range left ending in "||" is reported as the unfinished append it is', (t) => {
  const root = copyFixture(t, 'workspace')
  editPkg(root, 'packages/a', (j) => {
    j.peerDependencies['@noy-db/hub'] = '^0.7.0 || '
  })
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /"\|\|"/)
})

test('workspace: a range left STARTING with "||" is the same defect, mirrored', (t) => {
  const root = copyFixture(t, 'workspace')
  editPkg(root, 'packages/a', (j) => {
    // semver reads this as "*" exactly as the trailing form does — it admits
    // every version, including ones this repo never published.
    j.peerDependencies['@noy-db/hub'] = '|| ^0.7.0'
  })
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /"\|\|"/)
})

test('workspace: a private package is not part of the line', (t) => {
  const root = copyFixture(t, 'workspace')
  mkdirSync(join(root, 'packages/priv'))
  writeFileSync(
    join(root, 'packages/priv/package.json'),
    JSON.stringify({ name: 'priv', private: true, version: '9.9.9' }, null, 2) + '\n',
  )
  assert.deepEqual(gate(root), [])
})

test('single: one manifest cannot disagree with itself — trivially green', () => {
  assert.deepEqual(gate(join(FIXTURES, 'single-cargo')), [])
})

test('workspace: a pnpm `workspace:` range is always satisfied, never invalid semver', (t) => {
  // MEASURED against noy-db core (task 5, finding B): 88 false failures, every
  // one `range "workspace:^" is not a valid semver range`. pnpm rewrites a
  // workspace: range to the sibling's real version at publish, so it ALWAYS
  // admits what it points at. The root CLAUDE.md mandates this spelling.
  const root = copyFixture(t, 'workspace')
  for (const range of ['workspace:*', 'workspace:^', 'workspace:~', 'workspace:^0.7.0']) {
    editPkg(root, 'packages/a', (j) => {
      j.peerDependencies['@noy-db/hub'] = range
      j.devDependencies['@noy-db/hub'] = range
    })
    assert.deepEqual(gate(root), [], `range ${range} should be accepted`)
  }
})
