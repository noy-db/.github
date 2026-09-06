// versions-uniform — one version across the line, and every internal range
// admits it.
//
// Ported from noy-db-as's scripts/check-versions-uniform.mjs. WHY IT EXISTS:
//
// A lockstep line's version lives in N separate files, and an edit that misses
// one is locally correct, passes every in-repo gate, and only surfaces as an
// ERESOLVE in a consumer's install.
//
// The second half is the one noy-db-as specifically needs. Its one internal
// edge — as-xlsx → as-zip — is a PEER deliberately, because a peer makes
// version skew visible to a consumer instead of silently resolving to a second
// copy. That property is only worth anything if the range actually admits the
// version being shipped. A range left behind at a previous release publishes a
// peer requirement the sibling published alongside it does not satisfy.
//
// ⚠️ Written as an INVARIANT over the OUTPUT, not as a pinned version: "no two
// packages may disagree, and no internal range may exclude our own version". A
// check whose expected value is edited every release is a check people stop
// reading, and it cannot see the class — only the instance it was last edited
// for. Do not "simplify" it into a comparison against a constant.
import { join } from 'node:path'
import semver from 'semver'
import { packageDirs, readPkg } from '../walk.mjs'

const FIELDS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']

export function runVersionsUniform(root, cfg) {
  const failures = []

  // A private package publishes nothing, so it is not ON the line and its
  // version is free to disagree. A `single` repo's root is often private and IS
  // the deliverable, so there it is never skipped — mirroring the architecture
  // gate, which made the same cut for the same reason.
  const pkgs = packageDirs(root, cfg.layout)
    .map((dir) => ({ dir, json: readPkg(dir) }))
    .filter(({ json }) => cfg.layout === 'single' || !json.private)

  // ── Invariant 1: every package carries the same version ──────────────────
  const versions = new Map()
  for (const { dir, json } of pkgs) {
    if (!versions.has(json.version)) versions.set(json.version, [])
    versions.get(json.version).push(join(dir, '').slice(root.length + 1) || '.')
  }
  if (versions.size > 1) {
    const lines = [...versions.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([v, dirs]) => `      ${String(v).padEnd(18)} ${dirs.join(', ')}`)
    failures.push(`the line is not uniform — ${versions.size} different versions:\n${lines.join('\n')}`)
  }

  // ── Invariant 2: every internal range admits the version being shipped ───
  // Checked against each DEPENDED-ON package's own version rather than against
  // a single repo-wide value, so this stays correct even while invariant 1 is
  // failing — the two report independently instead of one masking the other.
  const versionOf = new Map(pkgs.map((p) => [p.json.name, p.json.version]))
  for (const { json } of pkgs) {
    for (const field of FIELDS) {
      for (const [name, range] of Object.entries(json[field] ?? {})) {
        if (!versionOf.has(name)) continue
        const target = versionOf.get(name)
        // Checked BEFORE validRange, because "^0.7.0 || " is a valid range that
        // floors at 0.0.0 — it satisfies everything and looks almost right.
        //
        // Both ends, because semver normalises them identically: MEASURED,
        // validRange("^0.7.0 || ") === validRange("|| ^0.7.0") === "*", and
        // both satisfy 9.9.9. The leading form is what a widening prepended
        // instead of appended leaves behind, and it reads even more like a
        // real range than the trailing one does.
        const trimmed = range.trim()
        if (trimmed.endsWith('||') || trimmed.startsWith('||')) {
          failures.push(
            `${json.name}: ${field}.${name} range "${range}" has a dangling "||" — an unfinished append floors at 0.0.0`,
          )
          continue
        }
        if (!semver.validRange(range)) {
          failures.push(`${json.name}: ${field}.${name} range "${range}" is not a valid semver range`)
          continue
        }
        if (!semver.satisfies(target, range, { includePrerelease: true }))
          failures.push(
            `${json.name}: ${field}.${name} is "${range}", which does NOT admit ${name}@${target} as shipped from this repo`,
          )
      }
    }
  }

  return { failures }
}
