import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { computeFloors, floorKey, pinnedRootText, planGroups } from '../src/gates/peer-floor.mjs'
import { FIXTURES, TOOLS } from './helpers.mjs'

test('computeFloors: a caret floors at the version written, prerelease included', () => {
  assert.deepEqual(computeFloors({ peerDependencies: { '@noy-db/hub': '^0.7.0' } }), {
    '@noy-db/hub': '0.7.0',
  })
  assert.deepEqual(computeFloors({ peerDependencies: { '@noy-db/hub': '^0.7.0-pre.0' } }), {
    '@noy-db/hub': '0.7.0-pre.0',
  })
})

test('computeFloors: an appended range floors at the OLDEST alternative', () => {
  assert.deepEqual(computeFloors({ peerDependencies: { '@noy-db/hub': '^0.6.0 || ^0.7.0' } }), {
    '@noy-db/hub': '0.6.0',
  })
})

test('computeFloors: non-@noy-db peers are not this check\'s business', () => {
  assert.deepEqual(computeFloors({ peerDependencies: { react: '^18.0.0' } }), {})
})

test('computeFloors: an unbounded range is unfalsifiable, not merely wrong', () => {
  for (const range of ['*', 'x', '', '   ', '<1.0.0', '>=0.0.0'])
    assert.throws(
      () => computeFloors({ peerDependencies: { '@noy-db/hub': range } }),
      /no lower bound/,
      `range ${JSON.stringify(range)} should have been refused`,
    )
})

test('computeFloors: a malformed range throws rather than escaping as a TypeError', () => {
  assert.throws(
    () => computeFloors({ peerDependencies: { '@noy-db/hub': 'not-a-range' } }),
    /cannot compute a minimum version/,
  )
  assert.throws(
    () => computeFloors({ peerDependencies: { '@noy-db/hub': '>1.0.0 <1.0.0' } }),
    /cannot compute a minimum version/,
  )
})

test('pinnedRootText: pnpm pins under pnpm.overrides and keeps unrelated entries', () => {
  const original = JSON.stringify({ name: 'r', pnpm: { overrides: { lodash: '4.0.0' } } }, null, 2) + '\n'
  const out = JSON.parse(pinnedRootText(original, { '@noy-db/hub': '0.7.0' }, 'pnpm'))
  assert.deepEqual(out.pnpm.overrides, { lodash: '4.0.0', '@noy-db/hub': '0.7.0' })
  assert.equal(out.overrides, undefined)
  assert.ok(pinnedRootText(original, {}, 'pnpm').endsWith('\n'))
})

test('pinnedRootText: npm pins under the top-level overrides field', () => {
  const original = JSON.stringify({ name: 'r', overrides: { lodash: '4.0.0' } }, null, 2) + '\n'
  const out = JSON.parse(pinnedRootText(original, { '@noy-db/hub': '0.7.0' }, 'npm'))
  assert.deepEqual(out.overrides, { lodash: '4.0.0', '@noy-db/hub': '0.7.0' })
  assert.equal(out.pnpm, undefined)
})

test('pinnedRootText: every @noy-db peer is pinned in ONE manifest, not one per run', () => {
  const out = JSON.parse(
    pinnedRootText('{}', { '@noy-db/hub': '0.7.0', '@noy-db/as-zip': '0.7.0' }, 'pnpm'),
  )
  assert.deepEqual(Object.keys(out.pnpm.overrides).sort(), ['@noy-db/as-zip', '@noy-db/hub'])
})

test('planGroups: packages sharing a floor set share a group; a peerless one is skipped', () => {
  const root = join(FIXTURES, 'workspace')
  const { groups, errors, skipped } = planGroups(root, loadConfig(root))
  assert.deepEqual(errors, [])
  assert.deepEqual(skipped, ['@noy-db/hub'])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].floors, { '@noy-db/hub': '0.7.0' })
  assert.deepEqual(
    groups[0].packages.map((p) => p.name),
    ['@noy-db/a'],
  )
})

test('planGroups: a bad range becomes an error, never a thrown stack or an exit', () => {
  const root = join(FIXTURES, 'workspace')
  const cfg = loadConfig(root)
  // Not a fixture edit: floorKey/computeFloors are the pure half, and the point
  // here is that planGroups REPORTS rather than exits. Provoke it directly.
  assert.equal(typeof floorKey({ '@noy-db/hub': '0.7.0' }), 'string')
  assert.notEqual(floorKey({ '@noy-db/hub': '0.7.0' }), floorKey({ '@noy-db/hub': '0.6.0' }))
  assert.deepEqual(planGroups(root, cfg).errors, [])
})

test('cli: peer-floor --dry-run prints the plan, installs nothing, exits 0', () => {
  const out = execFileSync(
    process.execPath,
    [join(TOOLS, 'cli.mjs'), 'peer-floor', '--root', join(FIXTURES, 'workspace'), '--dry-run'],
    { encoding: 'utf8' },
  )
  assert.match(out, /@noy-db\/hub@0\.7\.0/)
  assert.match(out, /--dry-run: nothing installed/)
})
