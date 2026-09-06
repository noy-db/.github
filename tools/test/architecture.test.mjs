import { test } from 'node:test'
import assert from 'node:assert/strict'
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

test('flat-as: `import type` from the store contract is allowed', () => {
  const { wheres } = gate('flat-as')
  assert.equal(wheres.filter((w) => w === 'as-good').length, 0)
})

test('flat-on: a package that imports hub nowhere owes no peer', () => {
  assert.deepEqual(gate('flat-on'), { rules: [], wheres: [] })
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
