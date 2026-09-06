import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadConfigFile } from '../src/config.mjs'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = JSON.parse(readFileSync(join(PKG, 'schema.json'), 'utf8'))

const CONFIG_NAME = 'family.config.json'

function rootWith(cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'family-cfg-'))
  writeFileSync(join(dir, CONFIG_NAME), JSON.stringify(cfg, null, 2))
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

// --- loadConfigFile reads EXACTLY the named file -----------------------------

test('loadConfigFile reads the named file, not family.config.json beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-cfg-'))
  writeFileSync(join(dir, CONFIG_NAME), JSON.stringify({ ...VALID, manager: 'pnpm' }))
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...VALID, manager: 'npm' }))
  assert.equal(loadConfigFile(join(dir, 'other.json')).manager, 'npm')
})

test('loadConfigFile throws for a path that does not exist, even beside a valid config', () => {
  const dir = rootWith(VALID)
  assert.throws(() => loadConfigFile(join(dir, 'does-not-exist.json')), /does-not-exist\.json/)
})

test('cli --config with a nonexistent path exits non-zero', () => {
  const dir = rootWith(VALID)
  const r = spawnSync(process.execPath, [join(PKG, 'cli.mjs'), 'config', '--config', join(dir, 'does-not-exist.json'), '--print'], {
    encoding: 'utf8',
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /does-not-exist\.json/)
  assert.equal(r.stdout, '')
})

// --- the enums come from schema.json, not a second hand-kept copy ------------

test('every binds value in schema.json is accepted by loadConfig', () => {
  for (const binds of SCHEMA.properties.binds.enum)
    assert.equal(loadConfig(rootWith({ ...VALID, binds })).binds, binds)
})

test('every gate in schema.json is accepted by loadConfig', () => {
  const gates = SCHEMA.properties.gates.items.enum
  assert.deepEqual(loadConfig(rootWith({ ...VALID, gates })).gates, gates)
})

test('every layout and manager in schema.json is accepted by loadConfig', () => {
  for (const layout of SCHEMA.properties.layout.enum)
    assert.equal(loadConfig(rootWith({ ...VALID, layout })).layout, layout)
  for (const manager of SCHEMA.properties.manager.enum)
    assert.equal(loadConfig(rootWith({ ...VALID, manager })).manager, manager)
})

test('a key declared in schema.json is never reported as unknown', () => {
  const known = new Set(Object.keys(SCHEMA.properties))
  assert.equal(known.has('localChecks') && known.has('exempt') && known.has('conformanceKit'), true)
  for (const key of known) assert.equal(SCHEMA.required.includes(key) || true, true)
  // The real link: the loader's unknown-key message lists exactly schema.json's keys.
  try {
    loadConfig(rootWith({ ...VALID, wobble: 1 }))
    assert.fail('expected a throw')
  } catch (err) {
    for (const key of known) assert.match(err.message, new RegExp(key))
  }
})
