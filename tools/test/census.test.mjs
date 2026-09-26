import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  census, checkOne, hasAccepted, hasVersion, report, encodeName, budgetSeconds, schedule,
} from '../src/release/census.mjs'

const doc = (versions, time) => ({
  ok: true,
  json: async () => ({ versions: Object.fromEntries(versions.map((v) => [v, {}])), ...(time ? { time } : {}) }),
})
const noSleep = async () => {}

test('hasVersion: only the versions map counts', () => {
  assert.equal(hasVersion({ versions: { '1.0.0': {} } }, '1.0.0'), true)
  assert.equal(hasVersion({ versions: {} }, '1.0.0'), false)
  assert.equal(hasVersion({}, '1.0.0'), false)
  assert.equal(hasVersion(null, '1.0.0'), false)
  // An unpublish tombstone: the version document and tarball still 200, and a
  // resolver sees nothing. Presence must come from `versions`.
  assert.equal(hasVersion({ versions: {}, time: { '1.0.0': 'x' } }, '1.0.0'), false)
})

test('hasAccepted: reads the time map, and is DIAGNOSTIC ONLY', () => {
  assert.equal(hasAccepted({ time: { '1.0.0': 'x' } }, '1.0.0'), true)
  assert.equal(hasAccepted({ time: {} }, '1.0.0'), false)
  assert.equal(hasAccepted({ versions: { '1.0.0': {} } }, '1.0.0'), false)
})

test('encodeName: a scoped name is URL-encoded for the registry path', () => {
  assert.equal(encodeName('@noy-db/hub'), '@noy-db%2fhub')
  assert.equal(encodeName('semver'), 'semver')
})

// ── the budget ───────────────────────────────────────────────────────────────

test('budgetSeconds: a floor that clears the measured worst case, scaling, and a ceiling', () => {
  // family#65: 19 packages spread 258s of npm acceptance; 10 packages spread 134s.
  // The old total budget was 180s — SHORTER than the spread it had to absorb.
  assert.ok(budgetSeconds(19) > 258, 'the floor must clear the measured 19-package spread')
  assert.ok(budgetSeconds(10) > 134, 'and the measured 10-package spread')
  assert.equal(budgetSeconds(1), 600, 'a tiny line still gets the floor — the tail is what bites')
  assert.equal(budgetSeconds(36), 1080, "core's 36 packages scale above the floor")
  assert.equal(budgetSeconds(10_000), 1800, 'a ceiling, so a misconfigured run cannot hang a job')
  assert.ok(budgetSeconds(36) > budgetSeconds(19), 'more packages, more budget')
})

test('schedule: fills the budget, starts fast, and costs few requests when it waits', () => {
  const s = schedule(600)
  assert.equal(s.reduce((a, b) => a + b, 0), 600, 'the schedule spends exactly the budget')
  assert.ok(s[0] <= 5, 'a fast small line finishes in seconds, not after one long sleep')
  assert.ok(s.length < 30, 'a long wait must not become hundreds of registry requests')
  assert.ok(Math.max(...s) <= 60, 'and no single sleep is so long that a late arrival waits it out')
})

test('schedule: a tiny budget still yields at least one pass boundary', () => {
  assert.deepEqual(schedule(3), [3])
  assert.deepEqual(schedule(0), [])
})

// ── checkOne ─────────────────────────────────────────────────────────────────

test('checkOne: a non-OK response is missing with the status, not a throw', async () => {
  const r = await checkOne('@noy-db/x', '1.0.0', { fetchImpl: async () => ({ ok: false, status: 404 }), buster: () => 'cb=1' })
  assert.equal(r.present, false)
  assert.match(r.note, /404/)
})

test('checkOne: a network throw is missing with the reason, never silent', async () => {
  const r = await checkOne('@noy-db/x', '1.0.0', { fetchImpl: async () => { throw new Error('ECONNRESET') }, buster: () => 'cb=1' })
  assert.equal(r.present, false)
  assert.match(r.note, /ECONNRESET/)
})

test('checkOne asks the ABBREVIATED document first — presence is what a resolver reads', async () => {
  const accepts = []
  await checkOne('@noy-db/x', '1.0.0', {
    buster: () => 'cb=1',
    fetchImpl: async (_u, init) => { accepts.push(init.headers.accept); return doc(['1.0.0']) },
  })
  assert.equal(accepts.length, 1, 'a present version costs ONE small request')
  assert.match(accepts[0], /install-v1/)
})

test('checkOne falls back to the FULL document ONLY when absent — that is where time lives', async () => {
  const accepts = []
  const r = await checkOne('@noy-db/x', '1.0.0', {
    buster: () => 'cb=1',
    fetchImpl: async (_u, init) => {
      accepts.push(init.headers.accept)
      return accepts.length === 1 ? doc([]) : doc([], { '1.0.0': '2026-09-26T00:00:00Z' })
    },
  })
  assert.equal(accepts.length, 2)
  assert.match(accepts[0], /install-v1/)
  assert.equal(accepts[1], 'application/json', 'the abbreviated document omits `time`')
  assert.equal(r.present, false)
  assert.equal(r.accepted, true)
})

test('checkOne busts the cache with a DIFFERENT key each call', async () => {
  const urls = []
  const fetchImpl = async (u) => { urls.push(u); return doc(['1.0.0']) }
  await checkOne('@noy-db/x', '1.0.0', { fetchImpl })
  await checkOne('@noy-db/x', '1.0.0', { fetchImpl })
  assert.notEqual(urls[0], urls[1], 'a stale edge document answers "never published" with confidence')
})

// ── the poll ─────────────────────────────────────────────────────────────────

test('census: all present on the first pass makes no further requests and never sleeps', async () => {
  let calls = 0
  let slept = 0
  const r = await census(['a', 'b'], '1.0.0', {
    sleep: async () => { slept++ },
    buster: () => 'cb=1',
    fetchImpl: async () => { calls++; return doc(['1.0.0']) },
  })
  assert.deepEqual(r.present.sort(), ['a', 'b'])
  assert.equal(r.missing.length, 0)
  assert.equal(r.passes, 1)
  assert.equal(slept, 0)
  assert.equal(calls, 2)
})

test('census: a name that appears late is absorbed — that is what the budget is for', async () => {
  let n = 0
  const r = await census(['a'], '1.0.0', {
    sleep: noSleep,
    buster: () => 'cb=1',
    fetchImpl: async () => (++n < 6 ? doc([]) : doc(['1.0.0'])),
  })
  assert.equal(r.missing.length, 0)
  assert.ok(r.passes > 1)
})

test('census: only the MISSING names are re-checked', async () => {
  const asked = []
  let pass = 0
  await census(['a', 'b'], '1.0.0', {
    sleep: noSleep,
    buster: () => 'cb=1',
    fetchImpl: async (u) => {
      asked.push(u)
      if (u.includes('/a')) return doc(['1.0.0'])
      return ++pass > 2 ? doc(['1.0.0']) : doc([])
    },
  })
  assert.equal(asked.filter((u) => u.includes('/a')).length, 1, 'a resolved name is never re-asked')
  assert.ok(asked.filter((u) => u.includes('/b')).length > 1)
})

test('census: a name that NEVER appears is reported missing, not waited on forever', async () => {
  const r = await census(['a'], '1.0.0', {
    sleep: noSleep, buster: () => 'cb=1', fetchImpl: async () => doc([]),
  })
  assert.equal(r.present.length, 0)
  assert.equal(r.missing[0].name, 'a')
  assert.equal(r.budgetSeconds, 600)
})

// ── family#65: the verdict must not claim more than the registry can support ──

test('an ACCEPTED-but-absent name and a NEVER-ACCEPTED one get the SAME verdict', async () => {
  // The old design branched here: `time` absent => DROPPED => "delete and recreate
  // the Release". A version npm has not accepted YET is indistinguishable from one
  // it never will, so that branch was undecidable — and all three false verdicts on
  // 2026-09-26 took it.
  const run = (time) => census(['a'], '1.0.0', {
    totalSeconds: 5, sleep: noSleep, buster: () => 'cb=1',
    fetchImpl: async (_u, init) => (init.headers.accept.includes('install-v1') ? doc([]) : doc([], time)),
  })
  const lag = await run({ '1.0.0': '2026-09-26T00:00:00Z' })
  const drop = await run(undefined)
  assert.equal(lag.missing.length, 1)
  assert.equal(drop.missing.length, 1)
  assert.equal(lag.missing[0].accepted, true, '`time` survives as a diagnostic')
  assert.equal(drop.missing[0].accepted, false)

  const say = (r) => { const out = []; report(r, (l) => out.push(l)); return out.join('\n') }
  assert.doesNotMatch(say(drop), /DROPPED/, 'no terminal word for a state the registry cannot confirm')
  assert.doesNotMatch(say(drop), /Re-fire the GitHub Release to retry/, 'the destructive step is never the first instruction')
  assert.match(say(drop), /NOT YET OBSERVED/)
  assert.match(say(lag), /NOT YET OBSERVED/)
})

test('report: 0 when whole, 1 on expiry, and the names either way', () => {
  const out = []
  assert.equal(report({ version: '1.0.0', present: ['a', 'b'], missing: [], passes: 1, waitedSeconds: 0, budgetSeconds: 600 }, (l) => out.push(l)), 0)
  assert.match(out.join('\n'), /2 of 2 visible at 1\.0\.0/)

  const out2 = []
  const rc = report({
    version: '1.0.0', present: ['a'], passes: 9, waitedSeconds: 600, budgetSeconds: 600,
    missing: [{ name: 'b', accepted: true }, { name: 'c', accepted: false, note: 'HTTP 500' }],
  }, (l) => out2.push(l))
  const text = out2.join('\n')
  assert.equal(rc, 1)
  assert.match(text, /1 of 3 visible/)
  assert.match(text, /NOT YET OBSERVED {2}b@1\.0\.0/)
  assert.match(text, /NOT YET OBSERVED {2}c@1\.0\.0/)
  assert.match(text, /HTTP 500/, 'a transport note is never swallowed')
  assert.match(text, /time map/, 'the diagnostic is printed for a human')
  assert.match(text, /600s budget/)
})

test('report: on expiry it prints a DECISION PROCEDURE, and the drop case is still reachable', () => {
  const out = []
  report({
    version: '1.0.0', present: [], passes: 9, waitedSeconds: 600, budgetSeconds: 600,
    missing: [{ name: 'b', accepted: false }],
  }, (l) => out.push(l))
  const text = out.join('\n')
  assert.match(text, /re-measure/i, 'measure before acting')
  assert.match(text, /visible now/, 'the benign reading is offered FIRST')
  assert.match(text, /still absent 10\+ min later/, 'and the real-drop reading is still reachable')
  assert.match(text, /DELETE the GitHub Release/, 'hub@0.8.0 never self-healed; the remedy must survive')
  assert.match(text, /registry\.npmjs\.org/, 'with a command that re-measures independently')
})
