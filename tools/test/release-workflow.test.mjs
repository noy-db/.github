// The publish gate is the TRIGGER, so the trigger is what the test pins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLS } from './helpers.mjs'

const REPO = join(TOOLS, '..')
const release = () => readFileSync(join(REPO, '.github/workflows/release.yml'), 'utf8')
const caller = () => readFileSync(join(REPO, 'templates/release-caller.yml'), 'utf8')

test('release.yml is workflow_call only — it cannot fire on its own', () => {
  const y = release()
  assert.match(y, /^on:\n  workflow_call:/m)
  assert.doesNotMatch(y, /^\s+(push|pull_request|release|schedule|workflow_dispatch):/m)
})

test('release.yml publishes exactly once, with provenance, to the public registry, under next', () => {
  const y = release()
  const publishes = y.match(/changeset publish/g) ?? []
  assert.equal(publishes.length, 1)
  assert.match(y, /changeset publish --tag next --no-git-tag/)
  assert.match(y, /NPM_CONFIG_PROVENANCE: true/)
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
  assert.match(c, /uses: noy-db\/\.github\/\.github\/workflows\/release\.yml@v1/)
  assert.match(c, /NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
})

test('every job that reads family-tools starts with setup-family, never a bare checkout', () => {
  const y = release()
  // family-config and every cli.mjs call need .family-tools on disk; only
  // setup-family puts it there. A bare checkout passed the self-test and
  // failed the first real release at the config job.
  assert.doesNotMatch(y, /uses: actions\/checkout@/)
  const jobs = y.split(/^  [a-z-]+:\n/m).slice(1)
  assert.equal(jobs.length, 3)
  for (const job of jobs) assert.match(job, /steps:\n(\s+#.*\n)*\s+- uses: noy-db\/\.github\/actions\/setup-family@v1/)
})
