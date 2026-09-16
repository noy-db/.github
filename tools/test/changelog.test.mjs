import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { versionSection, hasContent, runChangelogCensus } from '../src/release/changelog.mjs'
import { copyFixture } from './helpers.mjs'

test('versionSection is end-anchored: a pre-release heading does not satisfy the stable version', () => {
  assert.equal(versionSection('# x\n## 0.8.0-pre.0\n- pre\n', '0.8.0'), null)
  assert.deepEqual(versionSection('# x\n## 0.8.0\nLockstep.\n## 0.7.0\n- old\n', '0.8.0'), ['Lockstep.'])
  assert.deepEqual(versionSection('# x\n## [0.8.0] - 2026-09-13\n- a\n', '0.8.0'), ['- a'])
})

test('hasContent: prose is content, a bullet is content, blank lines are not', () => {
  assert.equal(hasContent(['Lockstep bump; see hub.']), true)
  assert.equal(hasContent(['- a']), true)
  assert.equal(hasContent(['', '  ']), false)
})

test('census: per PUBLISHABLE package — one file cannot satisfy the others, and a missing file is a failure', (t) => {
  const root = copyFixture(t, 'flat-as')
  const cfg = loadConfig(root)
  // as-good has a full section; as-bad has the heading empty; as-aws-s3 has NO changelog
  writeFileSync(join(root, 'as-good', 'CHANGELOG.md'), '# as-good\n## 0.8.0\nShipped.\n')
  writeFileSync(join(root, 'as-bad', 'CHANGELOG.md'), '# as-bad\n## 0.8.0\n\n## 0.7.0\n- old\n')
  rmSync(join(root, 'as-aws-s3', 'CHANGELOG.md'), { force: true })
  const { failures, checked } = runChangelogCensus(root, cfg, '0.8.0')
  assert.equal(checked, 3)
  assert.equal(failures.length, 2, failures.join('\n'))
  assert.ok(failures.some((f) => f.includes('as-bad') && /no content/.test(f)))
  assert.ok(failures.some((f) => f.includes('as-aws-s3') && /no CHANGELOG\.md at all/.test(f)))
})

test('census: green when every publishable package has a non-empty section', (t) => {
  const root = copyFixture(t, 'flat-as')
  const cfg = loadConfig(root)
  for (const d of ['as-good', 'as-bad', 'as-aws-s3']) writeFileSync(join(root, d, 'CHANGELOG.md'), `# ${d}\n## 0.8.0\nLockstep bump to 0.8.0; see hub.\n`)
  assert.deepEqual(runChangelogCensus(root, cfg, '0.8.0').failures, [])
})
