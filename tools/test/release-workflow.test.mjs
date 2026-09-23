// The publish gate is the TRIGGER, so the trigger is what the test pins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { TOOLS } from './helpers.mjs'

// ⚠️ The ref in these patterns is `@v\d+`, never a literal tag. These tests
// assert the SHAPE — which workflow a caller fires, and that every family-tools
// job starts with setup-family rather than a bare checkout. Pinning the tag here
// too would make them fail at every cut, and it would be a SECOND checker of a
// claim internal-refs.test.mjs already owns (that all self-references agree).

const REPO = join(TOOLS, '..')
const release = () => readFileSync(join(REPO, '.github/workflows/release.yml'), 'utf8')
const caller = () => readFileSync(join(REPO, 'templates/release-caller.yml'), 'utf8')

test('release.yml is workflow_call only — it cannot fire on its own', () => {
  const y = release()
  assert.match(y, /^on:\n  workflow_call:/m)
  assert.doesNotMatch(y, /^\s+(push|pull_request|release|schedule|workflow_dispatch):/m)
})

test('release.yml publishes exactly once, without provenance, to the public registry, under next', () => {
  const y = release()
  const publishes = y.match(/changeset publish/g) ?? []
  assert.equal(publishes.length, 1)
  assert.match(y, /changeset publish --tag next --no-git-tag/)
  // Provenance is OFF: npm rejects it for private source repos (E422), and the
  // member repos are private. Asserted absent so nobody re-adds it by habit.
  assert.doesNotMatch(y, /NPM_CONFIG_PROVENANCE/)
  assert.match(y, /id-token: write/)
  assert.doesNotMatch(y, /npm publish/) // spec 04 verification 3, kept
  assert.doesNotMatch(y, /npm\.pkg\.github\.com/) // never the org registry from here
})

test('release.yml refuses a commit with no green dev snapshot, and a tag that is not the manifest version', () => {
  const y = release()
  assert.match(y, /snapshot\.yml\/runs\?head_sha=/)
  assert.match(y, /versions-uniform/)
  assert.match(y, /tag_name.*!=.*version/s)
})

test('the caller template fires only on a published GitHub Release', () => {
  const c = caller()
  assert.match(c, /^on:\n  release:\n    types: \[published\]\n/m)
  assert.doesNotMatch(c, /^\s+(push|tags|workflow_dispatch):/m)
  assert.match(c, /uses: noy-db\/\.github\/\.github\/workflows\/release\.yml@v\d+/)
  assert.match(c, /NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
})

test('every job that reads family-tools starts with setup-family, never a bare checkout', () => {
  const y = release()
  // family-config and every cli.mjs call need .family-tools on disk; only
  // setup-family puts it there. A bare checkout passed the self-test and
  // failed the first real release at the config job.
  assert.doesNotMatch(y, /uses: actions\/checkout@/)
  const jobs = y.split(/^  [a-z-]+:\n/m).slice(1)
  // A LOWER BOUND, not a count. This asserted `=== 4` and broke the moment a
  // fifth job (peer-floor) was added — failing on the arithmetic rather than on
  // anything being wrong. The count is a fact about today; the per-job check
  // below is the invariant.
  assert.ok(jobs.length >= 4, `expected the split to find the jobs, got ${jobs.length}`)
  // Only jobs that READ family-tools need it on disk; a job that merely
  // refuses (publicRelease: false) has no tools to read.
  const readers = jobs.filter((job) => /cli\.mjs|family-config/.test(job))
  assert.ok(readers.length >= 3, 'config, verify and publish all read family-tools')
  for (const job of readers) assert.match(job, /steps:\n(\s+#.*\n)*\s+- uses: noy-db\/\.github\/actions\/setup-family@v\d+/)
})

test('both the reusable workflow and the caller grant actions: read — verify reads the snapshot run through the API', () => {
  // An explicit permissions block grants nothing it does not name, and a
  // reusable workflow's permissions are capped by its caller's. Both sides
  // must say it. Measured: 403 in core's first verify run with only
  // contents + id-token.
  for (const y of [release(), caller()]) {
    // Comment lines are allowed inside the block: the caller template carries
    // a two-line explanation of why the grant must be repeated there.
    assert.match(y, /^permissions:\n(?:  (?:[a-z-]+: [a-z]+.*|#.*)\n)*  actions: read/m)
  }
})

test('the publish job ensures @changesets/cli is installed before calling it — flat repos do not carry it', () => {
  const y = release()
  const publish = y.slice(y.indexOf('\n  publish:'))
  assert.match(publish, /@changesets\/cli/)
  assert.ok(publish.indexOf('@changesets/cli') < publish.indexOf('changeset publish'), 'install step must precede the publish step')
})

test('the Record step runs even when publish fails — a partial publish must leave a summary', () => {
  const y = release()
  assert.match(y, /- name: Record\n\s+if: always\(\)/)
})

test('release.yml refuses a repo that declares publicRelease: false, on both verify and publish', () => {
  const y = release()
  assert.match(y, /publicRelease: \$\{\{ steps\.cfg\.outputs\.publicRelease \}\}/)
  assert.match(y, /refused:\n\s+needs: config\n\s+if: needs\.config\.outputs\.publicRelease == 'false'/)
  const verify = y.slice(y.indexOf('\n  verify:'), y.indexOf('\n  publish:'))
  const publish = y.slice(y.indexOf('\n  publish:'))
  assert.match(verify, /publicRelease != 'false'/)
  assert.match(publish, /if: needs\.config\.outputs\.publicRelease != 'false'/)
})

test('the publish job sits behind the release environment and the peer-floor gate', () => {
  // Both added 2026-09-14. The environment is where "never publish without the
  // user's word" stops being prose: the required reviewer lives in repository
  // settings, which a silo cannot edit, unlike family.config.json.
  const y = release()
  const publish = y.slice(y.indexOf('\n  publish:'))
  assert.match(publish, /^    environment: release$/m)
  assert.match(publish, /needs: \[config, verify, peer-floor\]/)
})

test('peer-floor installs unfrozen — the floor install rewrites the tree', () => {
  // It cannot be a step inside verify for exactly this reason.
  const y = release()
  const job = y.slice(y.indexOf('\n  peer-floor:'), y.indexOf('\n  publish:'))
  assert.match(job, /frozen: 'false'/)
  assert.match(job, /cli\.mjs peer-floor --root \./)
})

test('verify runs the per-package changelog census (not a repo-wide grep)', () => {
  const y = release()
  const verify = y.slice(y.indexOf('\n  verify:'), y.indexOf('\n  peer-floor:'))
  assert.match(verify, /cli\.mjs changelog-census --root \./)
  assert.doesNotMatch(verify, /grep -rqE "\^## /, 'the existential grep must be gone')
})

// ── noy-db/.github#26 ────────────────────────────────────────────────────────
// Measured on noy-db/core 0.9.0-pre.0, run 35680634078: changesets refuses a
// custom tag in pre mode, so `changeset publish --tag next` failed AFTER config,
// peer-floor, verify and a human approving the `release` environment. 0 of 22
// published. The condition was readable from the checked-out tree all along.
test('verify refuses a pre-mode tree BEFORE the release environment gate is spent', () => {
  const yml = release()
  const verify = yml.slice(yml.indexOf('\n  verify:'), yml.indexOf('\n  peer-floor:'))
  assert.match(verify, /\.changeset\/pre\.json/)
  assert.match(verify, /changeset pre exit/)
})

test('the pre-mode fix does NOT drop --tag next, which would route the publish to @latest', () => {
  assert.match(release(), /changeset publish --tag next --no-git-tag/)
})
