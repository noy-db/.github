// publish-census — after `changeset publish`, prove the REGISTRY gained every
// version the publisher claimed. Nothing else in the rail asks this question.
//
// ── Why it exists ────────────────────────────────────────────────────────────
//
// core's v0.8.0 release, 2026-09-13: the run went GREEN and published 34 of 36.
// changesets printed `🦋 @noy-db/hub@0.8.0` and `🦋 @noy-db/by-peer@0.8.0` in its
// success list; npm's packument never gained either version, then or later. Only
// a re-fired Release published them. `hub` is the trust boundary every satellite
// binds, so "looks complete, left hub unpublished" is the worst shape this has.
// A publisher's own success list is a CLAIM. This is the verification.
//
// ── Why it was rewritten, 2026-09-26 ─────────────────────────────────────────
//
// The previous version failed THREE releases in one day that were all completely
// correct, and the remedy it printed each time — "delete and recreate the
// Release" — would have been pure waste, and on a stable cut would risk burning a
// version. Measured, from the registry's own `time` map:
//
//   to  0.9.0-pre.0   19 packages, acceptance spread  258s  (to-turso last, a
//                     124s outlier after the next-slowest)
//   as  0.9.0-pre.1   10 packages, acceptance spread  134s
//
// ⛔ THE OLD TOTAL BUDGET WAS 180s. It was shorter than the spread it had to
// absorb, so the verdict landed on whichever package npm happened to accept last.
// That budget had been derived from a SINGLE `hub` datapoint (+81s) and never
// re-derived against a multi-package set — a scalar standing in for a
// distribution.
//
// ⛔⛔ AND THE OLD DESIGN'S CENTRAL CLAIM WAS FALSE. It split the outcome into
// DROPPED (never accepted → re-fire) and PROPAGATING (accepted → wait), using
// `time[version]` as the discriminator, on the reasoning that npm writes `time`
// when it ACCEPTS. That is true, and it does not make the split decidable: a
// version npm has not accepted YET is indistinguishable from one it will never
// accept, because `time` is absent in both cases. All three false verdicts today
// were `DROPPED`, i.e. the branch whose printed remedy is destructive. There is no
// bound at which "absent from both maps" becomes "rejected" — that is a property
// of an eventually-consistent registry, not of this file.
//
// ── The design now ───────────────────────────────────────────────────────────
//
// Two states only, because two are all the registry can support:
//   PRESENT           — the version is in the abbreviated packument
//   NOT YET OBSERVED  — it is not, as of the last look
//
// A drop is PERMANENT and a lag is not, so the two are separated by DURATION, not
// by a field. The budget is therefore generous and scales with the package count
// (a 36-package line legitimately takes longer than a 3-package one), and expiry
// is still a HARD FAILURE — an unbounded wait would agree with the 0.8.0 lie.
// `time` is kept as DIAGNOSTIC TEXT on a missing name, never as a verdict.
//
// ⛔ The remedy printed on expiry is a DECISION PROCEDURE, not an instruction:
// re-check by hand, and only re-fire if the name is still absent well after. A
// gate that tells you to do the destructive thing on its first disagreement is
// worse than one that tells you what it saw.
//
// ⛔⛔ EVERY READ MUST BUST THE CACHE. The root's own verification of pre.2 read
// ABSENT from `npm view` AND from `curl -H 'Cache-Control: no-cache'`, three hours
// after the publish, and concluded a drop. Both read the same CDN, and a request
// header does not purge an edge cache — TWO INSTRUMENTS SHARING ONE CACHE LAYER
// ARE ONE INSTRUMENT. Only changing the URL changes the cache key.
//
// ⛔ It belongs HERE, in the shared rail, not in any one repo: the bug is in
// `release.yml`, which runs for all six publishers.

const REGISTRY = 'https://registry.npmjs.org'

export const encodeName = (name) => name.replace('/', '%2f')

/**
 * A version counts as visible only when it appears in the packument's `versions`
 * map.
 * ⛔ NOT a 200 on the per-version document, and NOT a 200 on the tarball: an
 * unpublish tombstone serves both while the resolver sees `versions: {}`
 * (to-cloudflare-d1, 2026-09-07). `versions` is what an install reads.
 */
export function hasVersion(packument, version) {
  return Boolean(packument && packument.versions && packument.versions[version])
}

/**
 * Did npm record accepting this version? DIAGNOSTIC ONLY.
 * ⛔ Do NOT reintroduce this as a verdict. `time` lags acceptance the same way
 * `versions` does, so its absence cannot mean "rejected" — that reading is the
 * defect this file was rewritten to remove (family#65). It is printed to help a
 * human reading an expiry, and nothing branches on it.
 */
export function hasAccepted(packument, version) {
  return Boolean(packument && packument.time && packument.time[version])
}

/**
 * A per-request cache key. ⛔ NOT cosmetic — see the header. `cache: 'no-store'`
 * is a directive to the local fetch cache and says nothing to a CDN.
 */
export const cacheBuster = () => `cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const get = async (fetchImpl, name, accept, buster) =>
  fetchImpl(`${REGISTRY}/${encodeName(name)}?${buster()}`, { headers: { accept }, cache: 'no-store' })

/**
 * Total seconds to allow, from the package count.
 *
 * Measured spreads: 10 packages / 134s, 19 packages / 258s — roughly linear at
 * ~13s per package, plus a long tail (one outlier sat 124s behind the
 * next-slowest). So: a floor that covers a small line's tail, ~30s per package
 * (≈2.3x the observed rate), and a ceiling so a misconfigured run cannot hang a
 * job for an hour.
 *
 * ⚠️ Deliberately generous. The cost of waiting is CI seconds on a rare job; the
 * cost of expiring early is a human deleting a GitHub Release and re-publishing,
 * which on a stable cut risks burning a version. These are not comparable.
 */
export function budgetSeconds(count, { floor = 600, perPackage = 30, ceiling = 1800 } = {}) {
  return Math.min(ceiling, Math.max(floor, count * perPackage))
}

/**
 * Backoff schedule filling `totalSeconds`: quick early passes so a fast, small
 * line finishes in seconds, then widening intervals so a long wait costs few
 * requests. Returns the delay BEFORE each pass after the first.
 */
export function schedule(totalSeconds, { first = 5, factor = 1.6, max = 60 } = {}) {
  const delays = []
  let spent = 0
  let d = first
  while (spent < totalSeconds) {
    const next = Math.min(d, totalSeconds - spent)
    if (next <= 0) break
    delays.push(next)
    spent += next
    d = Math.min(max, Math.round(d * factor))
  }
  return delays
}

/**
 * One name, one pass. Presence comes from the ABBREVIATED packument because that
 * is the document an install reads; the FULL document is fetched only when the
 * name is absent, purely to attach the `accepted` diagnostic.
 */
export async function checkOne(name, version, { fetchImpl = fetch, buster = cacheBuster } = {}) {
  try {
    const res = await get(fetchImpl, name, 'application/vnd.npm.install-v1+json', buster)
    if (!res.ok) return { name, present: false, accepted: false, note: `HTTP ${res.status}` }
    if (hasVersion(await res.json(), version)) return { name, present: true }

    const full = await get(fetchImpl, name, 'application/json', buster)
    if (!full.ok) return { name, present: false, accepted: false, note: `HTTP ${full.status} (time lookup)` }
    return { name, present: false, accepted: hasAccepted(await full.json(), version) }
  } catch (e) {
    return { name, present: false, accepted: false, note: String(e?.message ?? e) }
  }
}

/**
 * Poll until every name is visible, or the budget runs out. Only still-missing
 * names are re-checked, so a long line does not re-ask about what already landed.
 */
export async function census(names, version, { totalSeconds, sleep, fetchImpl, buster, ...opts } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const total = totalSeconds ?? budgetSeconds(names.length, opts)
  const delays = schedule(total, opts)

  let outstanding = [...names]
  const present = []
  let last = []
  let passes = 0
  let waited = 0

  for (let i = 0; ; i++) {
    last = await Promise.all(outstanding.map((n) => checkOne(n, version, { fetchImpl, buster })))
    passes++
    present.push(...last.filter((r) => r.present).map((r) => r.name))
    outstanding = last.filter((r) => !r.present).map((r) => r.name)
    if (outstanding.length === 0) break
    if (i >= delays.length) break
    await wait(delays[i] * 1000)
    waited += delays[i]
  }

  return {
    version,
    present,
    missing: last.filter((r) => !r.present),
    passes,
    waitedSeconds: waited,
    budgetSeconds: total,
  }
}

/**
 * ⛔ On expiry this prints a DECISION PROCEDURE, not an instruction. The old
 * version told a human to delete and recreate the Release the moment it
 * disagreed with the publisher, and was wrong three times out of three.
 */
export function report(result, log = console.log) {
  const total = result.present.length + result.missing.length
  log(`[census] ${result.present.length} of ${total} visible at ${result.version}`)
  if (result.missing.length === 0) return 0

  log('')
  log(`[census] waited ${result.waitedSeconds}s of a ${result.budgetSeconds}s budget across ${result.passes} passes`)
  log(`::error::${result.missing.length} of ${total} are NOT YET VISIBLE at ${result.version}`)
  for (const m of result.missing) {
    const bits = [m.accepted ? "in the registry's time map" : 'not in the time map either']
    if (m.note) bits.push(m.note)
    log(`  NOT YET OBSERVED  ${m.name}@${result.version}  (${bits.join('; ')})`)
  }
  log('')
  log('This is NOT by itself a dropped publish. npm is eventually consistent, and a version it has')
  log('not accepted YET reads identically to one it never accepted — measured 2026-09-26, three')
  log('times, and every one of them landed shortly after a census gave up.')
  log('')
  log('Before changing anything, re-measure. Then:')
  log('')
  log('  for p in <names>; do')
  log('    curl -s "https://registry.npmjs.org/$p?cb=$RANDOM" | jq -r \'.["dist-tags"].next\'')
  log('  done')
  log('')
  log('  visible now                  → the release is COMPLETE; only this check was early.')
  log('  still absent 10+ min later   → a real drop (measured 2026-09-13, hub@0.8.0 never')
  log('                                 self-healed). Re-fire: DELETE the GitHub Release and')
  log('                                 recreate it against the same tag. `gh run rerun` refuses')
  log('                                 a release-triggered run.')
  return 1
}
