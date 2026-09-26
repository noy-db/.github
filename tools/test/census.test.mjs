import { test } from 'node:test'
import assert from 'node:assert/strict'
import { census, checkOne, hasAccepted, hasVersion, partition, report, encodeName } from '../src/release/census.mjs'

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
  // ⚠️ Counted per NAME, not per fetch: since 2026-09-26 a name that comes back
  // absent costs a SECOND request (the full document, for `time`), so an exact
  // fetch count conflates "re-asked about a package" with "classified one".
  assert.equal(asked.filter((u) => u.includes('cli')).length, 1, 'a resolved name is not re-asked')
  assert.ok(asked.filter((u) => u.includes('hub')).length >= 2, 'hub was re-asked after coming back absent')
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

// ─── the two incidents, as named cases ────────────────────────────────────────
// They produce the SAME "missing" set and need OPPOSITE remedies, which is the
// whole reason `accepted` exists.

const doc = ({ versions = [], time = [] }) => ({
  ok: true,
  json: async () => ({
    versions: Object.fromEntries(versions.map((v) => [v, {}])),
    time: Object.fromEntries(time.map((v) => [v, '2026-09-26T03:48:28.313Z'])),
  }),
})

test('hasAccepted: the time map answers "did npm accept it", independent of versions', () => {
  assert.equal(hasAccepted({ time: { '0.9.0-pre.2': 'x' } }, '0.9.0-pre.2'), true)
  // Propagating: accepted, not yet resolvable. This is the pre.2 shape.
  assert.equal(hasVersion({ time: { '0.9.0-pre.2': 'x' }, versions: {} }, '0.9.0-pre.2'), false)
  // Dropped: neither. This is the 0.8.0 shape.
  assert.equal(hasAccepted({ time: {}, versions: {} }, '0.9.0-pre.2'), false)
  assert.equal(hasAccepted(null, '0.9.0-pre.2'), false)
})

test('checkOne asks the ABBREVIATED document first — presence is what a resolver reads', async () => {
  const accepts = []
  const urls = []
  const r = await checkOne('@noy-db/hub', '0.9.0-pre.2', {
    fetchImpl: async (u, opts) => {
      urls.push(u)
      accepts.push(opts.headers.accept)
      return doc({ versions: ['0.9.0-pre.2'], time: ['0.9.0-pre.2'] })
    },
  })
  assert.equal(r.present, true)
  assert.equal(accepts.length, 1, 'a present version needs no second document')
  assert.match(accepts[0], /install-v1/, 'presence must be read from the document an install reads')
  assert.match(urls[0], /\?cb=/, 'the cache KEY must change — a request header does not purge a CDN edge')
})

test('checkOne falls back to the FULL document ONLY when absent — that is where time lives', async () => {
  const accepts = []
  const r = await checkOne('@noy-db/hub', '0.9.0-pre.2', {
    fetchImpl: async (u, opts) => {
      accepts.push(opts.headers.accept)
      return accepts.length === 1 ? doc({ versions: [], time: [] }) : doc({ versions: [], time: ['0.9.0-pre.2'] })
    },
  })
  assert.equal(accepts.length, 2)
  assert.match(accepts[0], /install-v1/)
  assert.doesNotMatch(accepts[1], /install-v1/)
  assert.deepEqual({ present: r.present, accepted: r.accepted }, { present: false, accepted: true })
})

test('checkOne busts the cache with a DIFFERENT key each call', async () => {
  const urls = []
  const f = async (u) => (urls.push(u), doc({}))
  await checkOne('@noy-db/hub', '1.0.0', { fetchImpl: f })
  await checkOne('@noy-db/hub', '1.0.0', { fetchImpl: f })
  assert.notEqual(urls[0], urls[1], 'a constant buster is the same stale answer twice')
})

test('LAG (pre.2): a name npm ACCEPTED gets the grace window, not a PARTIAL verdict', async () => {
  // Resolvable only on pass 14 — beyond the 12-pass base window, inside the grace.
  let pass = 0
  const result = await census(['@noy-db/hub'], '0.9.0-pre.2', {
    sleep: async () => {},
    fetchImpl: async () => {
      pass++
      return pass >= 14
        ? doc({ versions: ['0.9.0-pre.2'], time: ['0.9.0-pre.2'] })
        : doc({ versions: [], time: ['0.9.0-pre.2'] }) // accepted, propagating
    },
  })
  assert.deepEqual(result.missing, [], 'the pre.2 incident must not fail the release')
  assert.equal(result.present.length, 1)
})

test('DROP (0.8.0): a name npm never accepted does NOT get the grace — it fails at the base window', async () => {
  const result = await census(['@noy-db/hub'], '0.8.0', {
    sleep: async () => {},
    fetchImpl: async () => doc({ versions: [], time: [] }), // never accepted, either document
  })
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].accepted, false)
  // The PASS count is the property. Each pass now costs two fetches, so counting
  // fetches would read 24 and hide it.
  assert.equal(result.attempts, 12, 'a drop never self-heals, so waiting longer is wasted CI time')
})

test('a MIXED set does not lend the grace to the dropped name', async () => {
  const result = await census(['accepted-pkg', 'dropped-pkg'], '1.0.0', {
    sleep: async () => {},
    fetchImpl: async (u) =>
      u.includes('accepted') ? doc({ versions: [], time: ['1.0.0'] }) : doc({ versions: [], time: [] }),
  })
  assert.equal(result.attempts, 12, 'one un-accepted name holds the window at the base')
  assert.equal(result.missing.length, 2)
})

test('report: the remedy DIFFERS by failure kind, and says so', () => {
  const lines = []
  const log = (s) => lines.push(s)

  report({ version: '0.9.0-pre.2', present: [], waitedSeconds: 180, attempts: 12,
           missing: [{ name: '@noy-db/hub', accepted: true }] }, log)
  const lag = lines.join('\n')
  assert.match(lag, /PROPAGATING/)
  assert.match(lag, /DO NOT delete and recreate/)
  assert.doesNotMatch(lag, /DROPPED/)

  lines.length = 0
  report({ version: '0.8.0', present: [], waitedSeconds: 180, attempts: 12,
           missing: [{ name: '@noy-db/hub', accepted: false }] }, log)
  const drop = lines.join('\n')
  assert.match(drop, /DROPPED/)
  assert.match(drop, /delete it and recreate it against the same tag/)
  assert.doesNotMatch(drop, /DO NOT delete/)
})

test('report: a clean census still returns 0 and says the scope', () => {
  const lines = []
  const code = report({ version: '1.0.0', present: ['a', 'b'], missing: [] }, (s) => lines.push(s))
  assert.equal(code, 0)
  assert.match(lines[0], /2 of 2/)
})
