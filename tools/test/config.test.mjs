import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'

function rootWith(cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'family-cfg-'))
  writeFileSync(join(dir, 'family.config.json'), JSON.stringify(cfg, null, 2))
  return dir
}

const VALID = {
  layout: 'flat',
  manager: 'pnpm',
  binds: '@noy-db/hub/as',
  publishes: true,
  gates: ['architecture', 'versions-uniform'],
}

test('loads a valid config and applies defaults', () => {
  const cfg = loadConfig(rootWith(VALID))
  assert.equal(cfg.layout, 'flat')
  assert.equal(cfg.manager, 'pnpm')
  assert.equal(cfg.binds, '@noy-db/hub/as')
  assert.equal(cfg.publishes, true)
  assert.deepEqual(cfg.gates, ['architecture', 'versions-uniform'])
  assert.deepEqual(cfg.localChecks, [])
  assert.deepEqual(cfg.exempt, [])
  assert.equal(cfg.conformanceKit, null)
})

test('binds may be null', () => {
  const cfg = loadConfig(rootWith({ ...VALID, binds: null }))
  assert.equal(cfg.binds, null)
})

test('optional keys survive when present', () => {
  const cfg = loadConfig(
    rootWith({ ...VALID, localChecks: ['pnpm run check'], exempt: ['as-aws-s3'], conformanceKit: 'runFormatConformanceTests' }),
  )
  assert.deepEqual(cfg.localChecks, ['pnpm run check'])
  assert.deepEqual(cfg.exempt, ['as-aws-s3'])
  assert.equal(cfg.conformanceKit, 'runFormatConformanceTests')
})

test('unknown binds throws with a message naming binds', () => {
  assert.throws(() => loadConfig(rootWith({ ...VALID, binds: '@noy-db/hub/kernel' })), /binds/)
})

test('missing gates throws', () => {
  const { gates, ...noGates } = VALID
  assert.throws(() => loadConfig(rootWith(noGates)), /gates/)
})

test('unknown top-level key throws', () => {
  assert.throws(() => loadConfig(rootWith({ ...VALID, wobble: 1 })), /wobble/)
})

test('unknown gate item throws', () => {
  assert.throws(() => loadConfig(rootWith({ ...VALID, gates: ['architecture', 'peer-floor-ish'] })), /gates/)
})

test('wrong type for publishes throws', () => {
  assert.throws(() => loadConfig(rootWith({ ...VALID, publishes: 'yes' })), /publishes/)
})

test('a missing family.config.json throws naming the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-cfg-'))
  assert.throws(() => loadConfig(dir), /family\.config\.json/)
})
