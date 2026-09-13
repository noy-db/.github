import { test } from 'node:test'
import assert from 'node:assert/strict'
import { census, checkOne, hasVersion, partition, report, encodeName } from '../src/release/census.mjs'

const packument = (versions) => ({
  ok: true,
  json: async () => ({ versions: Object.fromEntries(versions.map((v) => [v, {}])) }),
})

test('hasVersion: only the versions map counts', () => {
  assert.equal(hasVersion({ versions: { '0.8.0': {} } }, '0.8.0'), true)
  assert.equal(hasVersion({ versions: {} }, '0.8.0'), false)
  // The to-cloudflare-d1 tombstone: a packument exists and serves documents,
  // but the resolver sees nothing. A 200 is not the detector.
  assert.equal(hasVersion({ 'dist-tags': { latest: '0.8.0' }, versions: {} }, '0.8.0'), false)
  assert.equal(hasVersion(null, '0.8.0'), false)
})

test('encodeName: a scoped name is URL-encoded for the registry path', () => {
  assert.equal(encodeName('@noy-db/hub'), '@noy-db%2fhub')
})

test('checkOne: a non-OK response is missing with the status, not a throw', async () => {
  const r = await checkOne('@noy-db/hub', '0.8.0', { fetchImpl: async () => ({ ok: false, status: 404 }) })
  assert.equal(r.present, false)
  assert.match(r.note, /404/)
})

test('checkOne: a network throw is missing with the reason, never silent', async () => {
  const r = await checkOne('@noy-db/hub', '0.8.0', {
    fetchImpl: async () => {
      throw new Error('ECONNRESET')
    },
  })
  assert.equal(r.present, false)
  assert.match(r.note, /ECONNRESET/)
})

test('census: all present on the first pass makes no further requests', async () => {
  let calls = 0
  const res = await census(['@noy-db/hub', '@noy-db/by-peer'], '0.8.0', {
    fetchImpl: async () => {
      calls++
      return packument(['0.8.0'])
    },
    sleep: async () => {},
  })
  assert.deepEqual(res.missing, [])
  assert.equal(calls, 2, 'one request per name, no retry')
})

test('census: a name that appears late is absorbed — that is what the window is for', async () => {
  let round = 0
  const res = await census(['@noy-db/hub'], '0.8.0', {
    attempts: 3,
    fetchImpl: async () => packument(round++ === 0 ? ['0.8.0-pre.0'] : ['0.8.0']),
    sleep: async () => {},
  })
  assert.deepEqual(res.missing, [])
  assert.deepEqual(res.present, ['@noy-db/hub'])
})

test('census: only the MISSING names are re-checked', async () => {
  const asked = []
  let round = 0
  await census(['@noy-db/hub', '@noy-db/cli'], '0.8.0', {
    attempts: 2,
    sleep: async () => {},
    fetchImpl: async (url) => {
      asked.push(url)
      // cli resolves immediately; hub only on the second round
      if (url.includes('cli')) return packument(['0.8.0'])
      return packument(round++ === 0 ? [] : ['0.8.0'])
    },
  })
  assert.equal(asked.filter((u) => u.includes('cli')).length, 1, 'a resolved name is not re-asked')
  assert.equal(asked.filter((u) => u.includes('hub')).length, 2)
})

test('census: a name that NEVER appears is reported missing, not waited on forever', async () => {
  // ⛔ The real incident: hub and by-peer never appeared and only a re-fired
  // Release published them. Expiry must be a hard failure, not a shrug.
  const res = await census(['@noy-db/hub'], '0.8.0', {
    attempts: 3,
    sleep: async () => {},
    fetchImpl: async () => packument(['0.8.0-pre.0']),
  })
  assert.equal(res.missing.length, 1)
  assert.equal(res.missing[0].name, '@noy-db/hub')
})

test('report: exit code 1 and the names when partial, 0 when whole', () => {
  const lines = []
  const log = (s) => lines.push(s)
  assert.equal(report({ version: '0.8.0', present: ['a', 'b'], missing: [] }, log), 0)
  lines.length = 0
  const rc = report({ version: '0.8.0', present: ['a'], missing: [{ name: '@noy-db/hub' }] }, log)
  assert.equal(rc, 1)
  const text = lines.join('\n')
  assert.match(text, /::error::/)
  assert.match(text, /@noy-db\/hub@0\.8\.0/)
  assert.match(text, /Re-fire the GitHub Release/)
})

test('partition: present and missing are both reported', () => {
  const s = partition([{ name: 'a', present: true }, { name: 'b', present: false }])
  assert.deepEqual(s.present, ['a'])
  assert.deepEqual(s.missing.map((m) => m.name), ['b'])
})
