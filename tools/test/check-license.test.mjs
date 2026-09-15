import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { runCheckLicense } from '../src/gates/check-license.mjs'
import { copyFixture } from './helpers.mjs'

const gate = (root, overrides = {}) => runCheckLicense(root, { ...loadConfig(root), ...overrides }).failures

const editPkg = (root, rel, fn) => {
  const p = join(root, rel, 'package.json')
  const json = JSON.parse(readFileSync(p, 'utf8'))
  fn(json)
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n')
}

// Make every publishable package in the fixture compliant for the given tier.
function relicense(root, dirs, tier) {
  for (const rel of dirs) {
    writeFileSync(join(root, rel, 'LICENSE'), `${tier} text\n`)
    writeFileSync(join(root, rel, 'NOTICE'), 'noy-db — Copyright 2026 vLannaAi\n')
    editPkg(root, rel, (j) => {
      j.license = tier
      j.files = ['dist', 'README.md', 'LICENSE', 'NOTICE']
    })
  }
}

const FLAT = ['as-good', 'as-bad', 'as-aws-s3']

test('flat: every package with LICENSE, NOTICE, matching field and files entries is green', (t) => {
  const root = copyFixture(t, 'flat-as')
  relicense(root, FLAT, 'Apache-2.0')
  assert.deepEqual(gate(root), [])
})

test('flat: a manifest whose license field disagrees with the tier fails, naming the package', (t) => {
  const root = copyFixture(t, 'flat-as')
  relicense(root, FLAT, 'Apache-2.0')
  editPkg(root, 'as-good', (j) => { j.license = 'MIT' })
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /as-good.*"license": "MIT".*expected "Apache-2.0"/)
})

test('flat: LICENSE listed in files but absent on disk fails — the 7c class', (t) => {
  const root = copyFixture(t, 'flat-as')
  relicense(root, FLAT, 'Apache-2.0')
  rmSync(join(root, 'as-bad', 'LICENSE'))
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /as-bad.*LICENSE.*missing on disk/)
})

test('flat: NOTICE present on disk but not in files fails — it would not ship', (t) => {
  const root = copyFixture(t, 'flat-as')
  relicense(root, FLAT, 'Apache-2.0')
  editPkg(root, 'as-good', (j) => { j.files = ['dist', 'README.md', 'LICENSE'] })
  const failures = gate(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /as-good.*NOTICE.*not in "files"/)
})

test('flat: a package with no files field is not asked about files (npm ships LICENSE/NOTICE by default)', (t) => {
  const root = copyFixture(t, 'flat-as')
  relicense(root, FLAT, 'Apache-2.0')
  editPkg(root, 'as-good', (j) => { delete j.files })
  assert.deepEqual(gate(root), [])
})

test('flat: the tier comes from config — FSL repos pass with the FSL identifier', (t) => {
  const root = copyFixture(t, 'flat-as')
  relicense(root, FLAT, 'FSL-1.1-Apache-2.0')
  assert.deepEqual(gate(root, { license: 'FSL-1.1-Apache-2.0' }), [])
  assert.equal(gate(root).length, 3) // default tier is Apache-2.0: all three disagree
})

test('workspace: private packages are skipped', (t) => {
  const root = copyFixture(t, 'workspace')
  relicense(root, ['packages/a', 'packages/hub'], 'Apache-2.0')
  assert.deepEqual(gate(root), [])
})

// --- README licence prose (added 2026-09-15) --------------------------------
// ~57 published 0.8.0 packages said MIT under "## License" while manifest and
// LICENSE said Apache-2.0. The triad was correct for all of them.
import { licenceSection, foreignLicenceIds } from '../src/gates/check-license.mjs'
import { writeFileSync as wfs } from 'node:fs'
import { join as j } from 'node:path'

// The fixture is not green by default; make it so, then add the README under test.
const prepared = (t) => { const root = copyFixture(t, 'flat-as'); relicense(root, FLAT, 'Apache-2.0'); return root }
const firstPkgDir = (root) => j(root, 'as-good')

test('README whose ## License section names MIT under an Apache-2.0 tier fails, naming the package', (t) => {
  const root = prepared(t)
  wfs(j(firstPkgDir(root), 'README.md'), '# x\n\n## License\n\n[MIT](./LICENSE) © someone\n')
  const f = gate(root)
  assert.equal(f.length, 1)
  assert.match(f[0], /README "## License" names MIT/)
})

test('README whose ## License section names the tier is green', (t) => {
  const root = prepared(t)
  wfs(j(firstPkgDir(root), 'README.md'), '# x\n\n## License\n\nApache-2.0 © someone\n')
  assert.deepEqual(gate(root), [])
})

test('README with no licence section is not a failure — consistency, not presence', (t) => {
  const root = prepared(t)
  wfs(j(firstPkgDir(root), 'README.md'), '# x\n\nMIT is mentioned in prose elsewhere, which is fine.\n')
  assert.deepEqual(gate(root), [])
})

test('licenceSection stops at the next heading and returns null when absent', () => {
  assert.deepEqual(licenceSection('# a\n## License\nMIT\n## Next\nnope'), ['MIT'])
  assert.equal(licenceSection('# a\n## Usage\nMIT'), null)
})

test('foreignLicenceIds matches whole ids only — Apache-2.0 does not trip on "Apache"', () => {
  assert.deepEqual(foreignLicenceIds(['Apache-2.0 © x'], 'Apache-2.0'), [])
  assert.deepEqual(foreignLicenceIds(['[MIT](./LICENSE)'], 'Apache-2.0'), ['MIT'])
  assert.deepEqual(foreignLicenceIds(['Apache-2.0'], 'FSL-1.1-Apache-2.0'), ['Apache-2.0'])
})
