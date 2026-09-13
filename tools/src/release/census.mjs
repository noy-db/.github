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

export async function checkOne(name, version, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${REGISTRY}/${encodeName(name)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      cache: 'no-store',
    })
    if (!res.ok) return { name, present: false, note: `HTTP ${res.status}` }
    return { name, present: hasVersion(await res.json(), version) }
  } catch (e) {
    return { name, present: false, note: String(e?.message ?? e) }
  }
}

/**
 * Poll until every name carries `version`, or the attempts run out.
 * Only the still-missing names are re-checked, so a large line does not re-ask
 * the registry about packages that already resolved.
 */
export async function census(names, version, { attempts = 6, delayMs = 15000, sleep, fetchImpl } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let outstanding = [...names]
  const present = []
  let last = []
  for (let i = 0; i < attempts; i++) {
    last = await Promise.all(outstanding.map((n) => checkOne(n, version, { fetchImpl })))
    const split = partition(last)
    present.push(...split.present)
    outstanding = split.missing.map((m) => m.name)
    if (outstanding.length === 0) break
    if (i < attempts - 1) await wait(delayMs)
  }
  return {
    version,
    present,
    missing: last.filter((r) => !r.present),
    attempts: outstanding.length === 0 ? undefined : attempts,
  }
}

export function report(result, log = console.log) {
  log(`[census] ${result.present.length} of ${result.present.length + result.missing.length} resolve at ${result.version}`)
  if (result.missing.length === 0) return 0
  log('')
  log('::error::the registry did NOT gain every published version — this release is PARTIAL')
  for (const m of result.missing) log(`  MISSING  ${m.name}@${result.version}${m.note ? `  (${m.note})` : ''}`)
  log('')
  log('Re-fire the GitHub Release to retry: delete it and recreate it against the same tag.')
  log('`gh run rerun` refuses a release-triggered run — measured 2026-09-13.')
  return 1
}
