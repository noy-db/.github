// publish-census — after `changeset publish`, prove the REGISTRY gained every
// version the publisher claimed. Nothing else in the rail asks this question.
//
// ── The incident this exists for ─────────────────────────────────────────────
//
// core's v0.8.0 release, 2026-09-13: the run went GREEN and published 34 of 36.
// changesets printed `🦋 @noy-db/hub@0.8.0` and `🦋 @noy-db/by-peer@0.8.0` in
// its success list; npm's packument never gained either version. No error, no
// warning, exit 0. ⛔ `hub` is the trust boundary every satellite binds — a
// release that looks complete and leaves it unpublished is the worst shape this
// bug has. The only thing that caught it was querying the registry afterwards
// and counting.
//
// ⚠️ MEASURED, AND IT DECIDES THE DESIGN: this was NOT propagation lag. The two
// names were still absent minutes later and never appeared on their own; only a
// re-fired Release published them. So a census that merely waits would have
// waited forever and then agreed with the lie. The retry window below exists to
// absorb *genuine* lag, and its expiry is a HARD FAILURE, never a shrug.
//
// ── The SECOND incident, and it is the opposite one ───────────────────────────
//
// core's v0.9.0-pre.2, 2026-09-26: the census hard-failed `PARTIAL` naming three
// packages. All three were fine. `@noy-db/hub@0.9.0-pre.2` appeared in the
// registry's `time` map at 03:48:28Z — **81 seconds after this census gave up at
// 03:47:07Z**. The two others arrived within the minute after that. A Release was
// deleted and recreated to fix nothing: the re-fired run published ZERO packages
// and reported 16 of 16.
//
// ⛔ So the check has TWO failure directions and they need different answers:
//   a DROP (0.8.0)  — npm never accepted it; waiting is useless, retry is the fix
//   LAG  (pre.2)    — npm accepted it; waiting is the fix, and calling it PARTIAL
//                     costs a human a Release delete plus a re-publish cycle
//
// ⭐ THE DISCRIMINATOR IS THE `time` MAP, not the `versions` map. npm writes
// `time[version]` when it ACCEPTS a publish; `versions[version]` is what a
// resolver reads once the document has propagated. So `time` present + `versions`
// absent == accepted and still propagating, and neither present == never
// accepted. That distinction is free, and without it the two incidents above are
// the same output.
//
// ⛔⛔ AND THE DISCRIMINATOR IS WORTHLESS AGAINST A CACHED DOCUMENT. The root's
// own verification of pre.2 read ABSENT from `npm view` AND from `curl -H
// 'Cache-Control: no-cache'`, three hours after the publish, and concluded a drop.
// Both instruments read the same CDN, and a request header does not purge an edge
// cache — TWO INSTRUMENTS SHARING ONE CACHE LAYER ARE ONE INSTRUMENT. A stale
// document carries neither `versions` nor `time`, so it answers "never accepted"
// with total confidence. Hence `cacheBuster` below: the cache KEY has to change.
//
// ⭐ The family already held the rule — `to/CLAUDE.md`, "a green publish is not
// a published package". What was missing was an artefact enforcing it. Same
// shape as every other thing that bit this family: the knowledge existed and
// nothing mechanical acted on it.
//
// ⛔ It belongs HERE, in the shared rail, not in any one repo. The bug is in
// `release.yml`, which runs for all six members; a census in core would have
// protected core and left `to`, `as`, `on`, `at` and `ui` exposed to the
// identical defect. Repairing the instance and not extending the detector to
// the class is a mistake this family has already made once and named.

const REGISTRY = 'https://registry.npmjs.org'

export const encodeName = (name) => name.replace('/', '%2f')

/**
 * Split a census result into what resolved and what did not.
 * `present` is returned too, so a run that publishes nothing is distinguishable
 * from a run whose every name is missing — those are very different faults.
 */
export function partition(results) {
  return {
    present: results.filter((r) => r.present).map((r) => r.name),
    missing: results.filter((r) => !r.present),
  }
}

/**
 * A version counts as published only when it appears in the packument's
 * `versions` map.
 * ⛔ NOT a 200 on the per-version document, and NOT a 200 on the tarball: an
 * unpublish tombstone serves both while the resolver sees `versions: {}`
 * (to-cloudflare-d1, 2026-09-07). `versions` is the thing an install reads.
 */
export function hasVersion(packument, version) {
  return Boolean(packument && packument.versions && packument.versions[version])
}

/**
 * Did npm ACCEPT this version, whether or not a resolver can see it yet?
 *
 * `time[version]` is written when the publish is accepted. So this is true for a
 * version that is merely propagating and false for one that was never published
 * — which is the whole difference between "wait" and "retry".
 * ⚠️ The abbreviated packument (`application/vnd.npm.install-v1+json`) OMITS
 * `time`, so a census that wants this must ask for the full document. That is why
 * `checkOne` no longer sends that accept header.
 */
export function hasAccepted(packument, version) {
  return Boolean(packument && packument.time && packument.time[version])
}

/**
 * A per-request cache key. ⛔ NOT cosmetic: `cache: 'no-store'` is a directive to
 * the local fetch cache and says nothing to a CDN, so a stale edge document can
 * and did answer a question about a version published minutes earlier. Changing
 * the URL changes the cache key, which is the only part of this an edge honours.
 */
export const cacheBuster = () => `cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const get = async (fetchImpl, name, accept, buster) =>
  fetchImpl(`${REGISTRY}/${encodeName(name)}?${buster()}`, { headers: { accept }, cache: 'no-store' })

/**
 * ⛔⛔ TWO DOCUMENTS, AND SWAPPING EITHER FOR THE OTHER BREAKS A REAL CASE.
 *
 *   presence  ← the ABBREVIATED packument (`install-v1`). It is what a resolver
 *               reads, so it is the verdict. The original measurement behind this
 *               (2026-09-07, `to-cloudflare-d1`) was an unpublish tombstone: the
 *               abbreviated doc served `versions: {}` while the version document
 *               and the tarball both answered 200.
 *               ⚠️ That package has since RECOVERED — re-measured 2026-09-26, its
 *               abbreviated doc now serves all three versions — so the tombstone
 *               case is currently unobservable and this split is held by the
 *               earlier measurement, not by a control that can run today.
 *               Reading presence from the full document would still be wrong:
 *               presence must be asked of the document an install reads.
 *   acceptance ← the FULL document, which alone carries `time`.
 *
 * ⚠️ `accepted && !present` has TWO causes: still propagating (the pre.2 case) and
 * ACCEPTED-THEN-UNPUBLISHED. `time` keeps an entry for a version that no longer
 * exists — `to-cloudflare-d1` carries 71 `time` entries against 3 versions — so
 * the grace window below would also be granted to an unpublished version. That is
 * tolerable because the window is BOUNDED and its expiry still fails the release;
 * it is not tolerable to read the grace as proof the version is coming.
 *
 * The full document is fetched ONLY for a name that came back absent, so the
 * happy path still costs one small request per package.
 */
export async function checkOne(name, version, { fetchImpl = fetch, buster = cacheBuster } = {}) {
  try {
    const res = await get(fetchImpl, name, 'application/vnd.npm.install-v1+json', buster)
    if (!res.ok) return { name, present: false, accepted: false, note: `HTTP ${res.status}` }
    if (hasVersion(await res.json(), version)) return { name, present: true, accepted: true }

    // Absent for a resolver. Did npm accept it at all?
    const full = await get(fetchImpl, name, 'application/json', buster)
    if (!full.ok) return { name, present: false, accepted: false, note: `HTTP ${full.status} (time lookup)` }
    return { name, present: false, accepted: hasAccepted(await full.json(), version) }
  } catch (e) {
    return { name, present: false, accepted: false, note: String(e?.message ?? e) }
  }
}

/**
 * Poll until every name carries `version`, or the attempts run out.
 * Only the still-missing names are re-checked, so a large line does not re-ask
 * the registry about packages that already resolved.
 */
/**
 * Poll until every name carries `version`, or the attempts run out.
 * Only the still-missing names are re-checked, so a large line does not re-ask
 * the registry about packages that already resolved.
 *
 * ⚠️ `attempts`/`delayMs` were 6x15s = 90s. `hub@0.9.0-pre.2` was accepted at
 * +81s and this check called the release PARTIAL at +90s having sampled once at
 * +76s. The window is now 12x15s = 180s, and a name npm has ACCEPTED gets
 * `acceptedGraceAttempts` further passes beyond that — because for an accepted
 * version the only possible answer is "not yet", and the cost of being wrong is a
 * human deleting a GitHub Release.
 * ⛔ The expiry is still a HARD FAILURE. A drop (0.8.0) never self-heals, so an
 * unbounded wait would agree with the lie; the grace applies ONLY to names npm
 * has confirmed it accepted.
 */
export async function census(
  names,
  version,
  { attempts = 12, delayMs = 15000, acceptedGraceAttempts = 8, sleep, fetchImpl, buster } = {},
) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let outstanding = [...names]
  const present = []
  let last = []
  let used = 0
  // The cap grows only while every outstanding name is one npm ACCEPTED.
  let cap = attempts
  while (used < cap) {
    last = await Promise.all(outstanding.map((n) => checkOne(n, version, { fetchImpl, buster })))
    used++
    const split = partition(last)
    present.push(...split.present)
    outstanding = split.missing.map((m) => m.name)
    if (outstanding.length === 0) break
    const allAccepted = last.filter((r) => !r.present).every((r) => r.accepted)
    if (allAccepted && cap === attempts) cap = attempts + acceptedGraceAttempts
    if (used < cap) await wait(delayMs)
  }
  return {
    version,
    present,
    missing: last.filter((r) => !r.present),
    attempts: outstanding.length === 0 ? undefined : used,
    waitedSeconds: (used * delayMs) / 1000,
  }
}

/**
 * ⛔ The remedy DEPENDS on which failure this is, so the report must say which.
 * Telling someone to delete and recreate a Release for a version npm has already
 * accepted costs a publish cycle and fixes nothing — measured 2026-09-26.
 */
export function report(result, log = console.log) {
  const total = result.present.length + result.missing.length
  log(`[census] ${result.present.length} of ${total} resolve at ${result.version}`)
  if (result.missing.length === 0) return 0

  const accepted = result.missing.filter((m) => m.accepted)
  const dropped = result.missing.filter((m) => !m.accepted)
  log('')
  log(`[census] waited ${result.waitedSeconds ?? '?'}s across ${result.attempts ?? '?'} passes`)

  if (dropped.length > 0) {
    log('::error::the registry never ACCEPTED these versions — this release is PARTIAL')
    for (const m of dropped) log(`  DROPPED  ${m.name}@${result.version}${m.note ? `  (${m.note})` : ''}`)
    log('')
    log('A dropped version does not self-heal — waiting longer will not help (measured 2026-09-13).')
    log('Re-fire the GitHub Release to retry: delete it and recreate it against the same tag.')
    log('`gh run rerun` refuses a release-triggered run — measured 2026-09-13.')
  }

  if (accepted.length > 0) {
    log(`::error::npm ACCEPTED these versions but they are still not resolvable after ${result.waitedSeconds ?? '?'}s`)
    for (const m of accepted) log(`  PROPAGATING  ${m.name}@${result.version}  (present in the registry's time map)`)
    log('')
    log('⛔ DO NOT delete and recreate the Release for these — the version exists, so a re-fired')
    log('   publish skips them and changes nothing (measured 2026-09-26, 16 of 16 already published).')
    log('   Re-check the registry directly; if they resolve, the release is COMPLETE and only this')
    log('   check was impatient. Raise the window in tools/src/release/census.mjs if it recurs.')
  }
  return 1
}
