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

test('census: a flat repo with ONE root CHANGELOG.md covers every package that has none of its own', (t) => {
  // as/on/at keep a single root changelog; at wrote its 0.8.0 section there.
  const root = copyFixture(t, 'flat-as')
  const cfg = loadConfig(root)
  for (const d of ['as-good', 'as-bad', 'as-aws-s3']) rmSync(join(root, d, 'CHANGELOG.md'), { force: true })
  writeFileSync(join(root, 'CHANGELOG.md'), '# as\n## 0.8.0\nAll ten published as themselves.\n')
  assert.deepEqual(runChangelogCensus(root, cfg, '0.8.0').failures, [])
  // and an EMPTY root section still fails every package it covers
  writeFileSync(join(root, 'CHANGELOG.md'), '# as\n## 0.8.0\n\n## 0.7.0\n- old\n')
  assert.equal(runChangelogCensus(root, cfg, '0.8.0').failures.length, 3)
})

// ── family#66 ────────────────────────────────────────────────────────────────

test('a Keep a Changelog section organised with ### subsections HAS content', () => {
  // The old terminator was /^#{2,}\s/, so the first `### Added` ended the section
  // and a 66-line entry reported "a heading with no notes". That refused
  // noy-db/as and noy-db/at on 2026-09-26, both correct releases.
  const md = [
    '# Changelog', '', '## [1.0.0] — 2026-01-01', '', '### Added', '', '- a thing', '',
    '### Fixed', '', '- another', '', '## [0.9.0]', '', '- old',
  ].join('\n')
  const section = versionSection(md, '1.0.0')
  assert.ok(hasContent(section), 'the shape Keep a Changelog prescribes must pass')
  assert.ok(section.some((l) => l.includes('- a thing')))
  assert.ok(section.some((l) => l.includes('### Fixed')), 'subsections belong to the section')
  assert.ok(!section.some((l) => l.includes('- old')), 'and it still stops at the next version')
})

test('CONTROL: a version heading immediately followed by the next one is still EMPTY', () => {
  // Without this the depth fix could pass everything, which is the failure mode
  // of a loosened terminator.
  const md = ['## [1.0.0]', '', '## [0.9.0]', '', '- old'].join('\n')
  assert.equal(hasContent(versionSection(md, '1.0.0')), false)
})

test('the section ends at the SAME depth, and a deeper heading does not end it', () => {
  const md = ['### [1.0.0]', '', '#### Added', '', '- a thing', '', '### [0.9.0]', '', '- old'].join('\n')
  const section = versionSection(md, '1.0.0')
  assert.ok(section.some((l) => l.includes('- a thing')), 'h4 is inside an h3 version section')
  assert.ok(!section.some((l) => l.includes('- old')), 'the next h3 ends it')
})

test('a shallower heading ends the section too', () => {
  const md = ['## [1.0.0]', '', '- a thing', '', '# Appendix', '', '- not ours'].join('\n')
  const section = versionSection(md, '1.0.0')
  assert.ok(section.some((l) => l.includes('- a thing')))
  assert.ok(!section.some((l) => l.includes('- not ours')))
})

test('a hash line inside a FENCE is shell, not a heading, and does not truncate', () => {
  // Latent when found: hub's changelog already carries four fenced blocks, so this
  // was one `# install deps` away from a section that "looks empty".
  const md = [
    '## [1.0.0]', '', '```bash', '# install deps', 'npm i', '```', '', '- real note', '',
    '## [0.9.0]', '', '- old',
  ].join('\n')
  const section = versionSection(md, '1.0.0')
  assert.ok(section.some((l) => l.includes('- real note')), 'the note after the fence survives')
  assert.ok(section.some((l) => l.includes('# install deps')), 'and the fence body is kept verbatim')
  assert.ok(!section.some((l) => l.includes('- old')))
})

test('a version heading inside a fence does not open a section', () => {
  const md = ['# Changelog', '', '```md', '## [1.0.0]', '- documented example', '```', ''].join('\n')
  assert.equal(versionSection(md, '1.0.0'), null, 'an example of a heading is not a heading')
})

test('~~~ fences are handled as well as backticks', () => {
  const md = ['## [1.0.0]', '', '~~~sh', '# a comment', '~~~', '', '- note', '', '## [0.9.0]'].join('\n')
  assert.ok(versionSection(md, '1.0.0').some((l) => l.includes('- note')))
})
