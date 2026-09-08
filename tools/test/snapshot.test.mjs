import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { prepareSnapshot } from '../src/snapshot/prepare.mjs'
import { snapshotReport } from '../src/snapshot/report.mjs'
import { copyFixture } from './helpers.mjs'

const OPTS = { tag: 'dev', registry: 'https://npm.pkg.github.com' }
const read = (root, rel) => JSON.parse(readFileSync(join(root, rel, 'package.json'), 'utf8'))

/** An unscoped, publishable-looking package — the thing step 5 must privatise. */
function addUnscoped(root) {
  mkdirSync(join(root, 'packages/tool'))
  writeFileSync(
    join(root, 'packages/tool/package.json'),
    JSON.stringify({ name: 'some-tool', version: '0.7.0' }, null, 2) + '\n',
  )
}

test('prepareSnapshot: all five effects, on a copy of fixtures/workspace', (t) => {
  const root = copyFixture(t, 'workspace')
  addUnscoped(root)
  const cfg = loadConfig(root)

  assert.ok(existsSync(join(root, '.changeset/pre.json')), 'fixture must start in pre mode')
  const summary = prepareSnapshot(root, cfg, OPTS)

  // (1) pre mode is gone — `changeset version --snapshot` refuses to run in it.
  assert.equal(existsSync(join(root, '.changeset/pre.json')), false)

  // (2) every publishable package is named in one changeset, as `patch`.
  assert.equal(
    readFileSync(join(root, '.changeset/zz-snapshot-all.md'), 'utf8'),
    '---\n"@noy-db/a": patch\n"@noy-db/hub": patch\n---\n\nsnapshot\n',
  )

  // (3) publishConfig points at the org registry under the dev tag.
  assert.deepEqual(read(root, 'packages/a').publishConfig, { registry: OPTS.registry, tag: 'dev' })
  assert.deepEqual(read(root, 'packages/hub').publishConfig, { registry: OPTS.registry, tag: 'dev' })

  // (4) every @noy-db peer range also admits a dev snapshot version.
  assert.equal(
    read(root, 'packages/a').peerDependencies['@noy-db/hub'],
    '^0.7.0 || >=0.0.0-dev-0 <0.0.1',
  )

  // (5) an unscoped name cannot go to the org registry at all.
  assert.equal(read(root, 'packages/tool').private, true)

  assert.deepEqual(summary, {
    versionedPackages: ['@noy-db/a', '@noy-db/hub'],
    privatised: ['some-tool'],
    widened: ['@noy-db/a'],
    skipped: [],
  })
})

test('prepareSnapshot: a range already carrying the dev clause is left alone — idempotent', (t) => {
  const root = copyFixture(t, 'workspace')
  addUnscoped(root)
  const cfg = loadConfig(root)

  prepareSnapshot(root, cfg, OPTS)
  const after1 = readFileSync(join(root, 'packages/a/package.json'), 'utf8')
  const changeset1 = readFileSync(join(root, '.changeset/zz-snapshot-all.md'), 'utf8')

  const second = prepareSnapshot(root, cfg, OPTS)
  assert.equal(readFileSync(join(root, 'packages/a/package.json'), 'utf8'), after1)
  assert.equal(readFileSync(join(root, '.changeset/zz-snapshot-all.md'), 'utf8'), changeset1)
  assert.deepEqual(second.widened, [])
  assert.deepEqual(second.privatised, [])
  assert.deepEqual(second.versionedPackages, ['@noy-db/a', '@noy-db/hub'])
})

test('prepareSnapshot: a range ending in "||" is left alone and REPORTED, not widened', (t) => {
  const root = copyFixture(t, 'workspace')
  const file = join(root, 'packages/a/package.json')
  const json = JSON.parse(readFileSync(file, 'utf8'))
  json.peerDependencies['@noy-db/hub'] = '^0.7.0 || '
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n')

  const summary = prepareSnapshot(root, loadConfig(root), OPTS)
  // Appending to it would produce "^0.7.0 ||  || >=0.0.0-dev-0 <0.0.1", which
  // semver reads as "*" — the widening would silently turn a malformed range
  // into an unbounded one and the snapshot would install against anything.
  assert.equal(read(root, 'packages/a').peerDependencies['@noy-db/hub'], '^0.7.0 || ')
  assert.deepEqual(summary.widened, [])
  assert.deepEqual(summary.skipped, ['@noy-db/a: @noy-db/hub "^0.7.0 || "'])
})

test('prepareSnapshot: nothing publishable writes NO changeset, and says so', (t) => {
  const root = copyFixture(t, 'workspace')
  for (const rel of ['packages/a', 'packages/hub']) {
    const file = join(root, rel, 'package.json')
    const json = JSON.parse(readFileSync(file, 'utf8'))
    json.private = true
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  }
  const summary = prepareSnapshot(root, loadConfig(root), OPTS)
  // An empty frontmatter block is not a no-op changeset: `changeset version`
  // reads "---\n---" as a malformed changeset and fails the workflow at a step
  // that has nothing to do with the real condition, which is "nothing to ship".
  assert.equal(existsSync(join(root, '.changeset/zz-snapshot-all.md')), false)
  assert.deepEqual(summary.versionedPackages, [])
})

test('prepareSnapshot: an existing publishConfig field survives', (t) => {
  const root = copyFixture(t, 'workspace')
  const p = join(root, 'packages/a/package.json')
  const json = JSON.parse(readFileSync(p, 'utf8'))
  json.publishConfig = { access: 'public', tag: 'latest' }
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n')

  prepareSnapshot(root, loadConfig(root), OPTS)
  assert.deepEqual(read(root, 'packages/a').publishConfig, {
    access: 'public',
    registry: OPTS.registry,
    tag: 'dev',
  })
})

test('snapshotReport: name@version per non-private package', (t) => {
  const root = copyFixture(t, 'workspace')
  addUnscoped(root)
  assert.deepEqual(snapshotReport(root, loadConfig(root)), [
    '@noy-db/a@0.7.0',
    '@noy-db/hub@0.7.0',
    'some-tool@0.7.0',
  ])
  assert.deepEqual(snapshotReport(root, loadConfig(root), { names: true }), [
    '@noy-db/a',
    '@noy-db/hub',
    'some-tool',
  ])
})

test('snapshotReport: what prepareSnapshot privatised drops out of the report', (t) => {
  const root = copyFixture(t, 'workspace')
  addUnscoped(root)
  const cfg = loadConfig(root)
  prepareSnapshot(root, cfg, OPTS)
  assert.deepEqual(snapshotReport(root, cfg), ['@noy-db/a@0.7.0', '@noy-db/hub@0.7.0'])
})

test('prepareSnapshot: a workspace: peer range is left for changesets, not widened', (t) => {
  const root = copyFixture(t, 'workspace')
  const p = join(root, 'packages', 'a', 'package.json')
  const j = JSON.parse(readFileSync(p, 'utf8'))
  j.peerDependencies = { ...(j.peerDependencies ?? {}), '@noy-db/hub': 'workspace:^' }
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
  const out = prepareSnapshot(root, loadConfig(root), { tag: 'dev', registry: 'https://npm.pkg.github.com' })
  const after = JSON.parse(readFileSync(p, 'utf8'))
  assert.equal(after.peerDependencies['@noy-db/hub'], 'workspace:^')
  assert.ok(!out.widened.includes('@noy-db/a'))
  assert.deepEqual(out.skipped, [])
})

test('report --version prints the line version once, and refuses a non-uniform line', (t) => {
  const root = copyFixture(t, 'workspace')
  assert.deepEqual(snapshotReport(root, loadConfig(root), { version: true }), ['0.7.0'])
  const p = join(root, 'packages/a/package.json')
  const json = JSON.parse(readFileSync(p, 'utf8'))
  json.version = '0.6.0'
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n')
  assert.throws(() => snapshotReport(root, loadConfig(root), { version: true }), /not uniform: 0\.6\.0, 0\.7\.0|not uniform: 0\.7\.0, 0\.6\.0/)
})
