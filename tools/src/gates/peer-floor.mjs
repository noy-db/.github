// peer-floor — does every package actually COMPILE against the oldest
// @noy-db/* versions its peer ranges admit?
//
// Ported from noy-db-as's scripts/check-peer-floor.mjs, generalised with
// klum-db's behaviour: pin EVERY @noy-db/* peer's floor together rather than
// hub's alone.
//
// Why it is separate from the architecture gate:
//
// `hub-peer-range` there asserts the peer is *a range*. It cannot assert the
// range is *true*, because truth requires resolving symbols out of a hub
// version that is not installed. Every other gate — build, lint, typecheck, the
// suites — runs against the DEV PIN, so all of them stay green no matter how
// wrong the declared range is. The dev pin is a proxy for the range, and it
// always answers reassuringly.
//
// That gap shipped twice, in noy-db-to. The MECHANISM is what transfers:
//
//   noy-db-to #89   16 packages advertised ^0.3.0 || ^0.4.0 || ^0.5.0 while
//        importing StoreLocator / StoreDescriptor / StoreFactory, which exist
//        only from 0.6.0-pre. `npm i @noy-db/to-postgres @noy-db/hub` satisfied
//        the peer check and then failed to typecheck.
//
//   noy-db-to #84   to-drive / to-icloud register a NoydbPodStore factory
//        without a cast, which needs StoreLocator.register() to be generic over
//        both store shapes — landed in 0.6.0-pre.11. SYMBOL PRESENCE DOES NOT
//        CATCH THIS: StoreFactory exists at 0.6.0-pre.0, it just cannot accept
//        the argument. Only compiling against the floor finds it.
//
// ⛔ So this check COMPILES; it does not grep. That distinction is the whole
// point and must not be optimised away — a symbol scan would be faster, would
// need no network, and would be wrong in the exact case that shipped.
//
// It needs the network, so it is a CI job, not part of the lint path.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import semver from 'semver'
import { packageDirs, readPkg } from '../walk.mjs'

/**
 * Lowest version each @noy-db peer range admits. Non-@noy-db peers are ignored.
 * THROWS rather than exiting, so a caller decides what a bad range means.
 *
 * semver fails in three ways and only one of them is a return value:
 *
 *   minVersion('not-a-range')   → THROWS TypeError: Invalid comparator
 *   minVersion('>1.0.0 <1.0.0') → returns null   (well-formed, unsatisfiable)
 *   minVersion('') === minVersion('*') === minVersion('<1.0.0') → 0.0.0
 *
 * The third is the one that fails SLOWLY: no @noy-db package has ever published
 * 0.0.0, so it neither throws nor returns null — it plans a check against a
 * version that does not exist and surfaces minutes later at the install step as
 * "no matching version for @noy-db/x@0.0.0", which reads as a registry outage
 * rather than a bad manifest.
 *
 * Detected by VALUE, not by matching the range text, because `<1.0.0` and
 * `>=0.0.0` are unbounded below without looking like wildcards. The honest
 * reason to reject it: an unbounded range promises EVERY version, so there is
 * no floor that could test it. It is not malformed — it is unfalsifiable.
 *
 * NOTE for refactors: `^0.7.0-pre.0` must floor at `0.7.0-pre.0`, NOT `0.7.0`.
 * Flooring at the release would test a HIGHER version than the range admits, so
 * a range that is false for pre-releases would pass. The two look alike.
 */
export function computeFloors(pkg) {
  const floors = {}
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@noy-db/')) continue
    let min
    try {
      min = semver.minVersion(range)
    } catch {
      min = null
    }
    if (!min) throw new Error(`${name}: cannot compute a minimum version from "${range}"`)
    if (min.version === '0.0.0')
      throw new Error(
        `${name}: range "${range}" has no lower bound, so there is no floor to check it against. ` +
          `An unbounded range promises every version, including ones that were never published. ` +
          `Narrow it to the oldest version this package actually supports.`,
      )
    floors[name] = min.version
  }
  return floors
}

/** A stable identity for a floor SET, so packages needing the same install share one. */
export const floorKey = (floors) =>
  Object.keys(floors)
    .sort()
    .map((n) => `${n}@${floors[n]}`)
    .join(' ')

/**
 * The root manifest TEXT with every floor pinned as an override. Pure: takes
 * and returns text, so the caller keeps the ORIGINAL bytes and restores them
 * verbatim rather than re-serialising.
 *
 * Merged rather than assigned — an existing override that is not a @noy-db peer
 * must survive, or the check silently changes what it resolves.
 *
 * pnpm reads `pnpm.overrides`; npm reads a top-level `overrides`. Writing both
 * would be tidier-looking and wrong: npm warns on unknown fields it does not
 * warn about here, and a stray `pnpm` block in an npm repo's manifest outlives
 * the run if the restore is ever skipped.
 */
export function pinnedRootText(originalText, floors, manager) {
  const pj = JSON.parse(originalText)
  if (manager === 'npm') pj.overrides = { ...(pj.overrides ?? {}), ...floors }
  else pj.pnpm = { ...(pj.pnpm ?? {}), overrides: { ...(pj.pnpm?.overrides ?? {}), ...floors } }
  return JSON.stringify(pj, null, 2) + '\n'
}

/**
 * Group this repo's packages by the floor SET their peer ranges admit.
 *
 * Every @noy-db peer is pinned at once rather than one at a time, because that
 * is how a consumer installs them: the interesting failures are the ones where
 * two floors cannot co-exist.
 *
 * Returns data — `errors` instead of a `process.exit`, so cli.mjs owns the exit
 * code and a test can provoke the bad-range path without spawning a process.
 */
export function planGroups(root, cfg) {
  const byKey = new Map()
  const errors = []
  const skipped = []

  for (const dir of packageDirs(root, cfg.layout)) {
    const pj = readPkg(dir)
    if (pj.private && cfg.layout !== 'single') continue
    let floors
    try {
      floors = computeFloors(pj)
    } catch (err) {
      errors.push(`${err.message}`)
      continue
    }
    // A package with no @noy-db peer at all has no floor to check.
    //
    // ⚠️ THIS IS A CROSS-FILE COUPLING, and it has already broken in a sibling.
    // Skipping is safe only where the architecture gate fails a missing hub
    // peer UNCONDITIONALLY. noy-db-on deliberately exempts packages that import
    // hub nowhere (on-email-otp, on-threat, on-totp) — `peerOptionalWhenUnused`
    // in the SEAM table — so there a peer-less package is skipped by BOTH gates
    // and checked by neither, and nothing says so.
    //
    // So: do NOT harden this into a hard failure (it would break three packages
    // that owe no peer), and do NOT relax the architecture gate's
    // `hub-peer-range` without revisiting this line.
    if (Object.keys(floors).length === 0) {
      skipped.push(pj.name)
      continue
    }
    const key = floorKey(floors)
    if (!byKey.has(key)) byKey.set(key, { key, floors, packages: [] })
    byKey.get(key).packages.push({ name: pj.name, dir, peers: pj.peerDependencies ?? {} })
  }

  return { groups: [...byKey.values()], errors, skipped }
}

// ── The commands, per manager and layout ────────────────────────────────────
//
// A `single` repo has no filter to apply — it IS the package — and pnpm's
// `--filter <name>` there matches nothing and exits 0, which would silently
// typecheck nothing at all.
const commands = (manager, layout) => {
  if (manager === 'npm')
    return {
      install: ['npm', ['install']],
      build: (name) => ['npm', layout === 'single' ? ['run', 'build'] : ['run', 'build', '-w', name]],
      typecheck: (name) => ['npm', layout === 'single' ? ['run', 'typecheck'] : ['run', 'typecheck', '-w', name]],
    }
  return {
    install: ['pnpm', ['install', '--no-frozen-lockfile']],
    // The `...` suffix builds the package AND its workspace dependencies, and
    // keeps the build inside this group's floor rather than rebuilding packages
    // that declare a different one.
    build: (name) => ['pnpm', layout === 'single' ? ['build'] : ['--filter', `${name}...`, 'build']],
    typecheck: (name) => ['pnpm', layout === 'single' ? ['typecheck'] : ['--filter', name, 'typecheck']],
  }
}

/**
 * Plan, and (unless `dryRun`) install + build + typecheck each group at its
 * floor.
 *
 * `log` is injected rather than the module printing: this half runs for minutes
 * and is unreadable without progress, but a gate that prints cannot be asserted
 * on. cli.mjs passes console.log; tests pass nothing.
 */
export function runPeerFloor(root, cfg, { dryRun = false, log = () => {} } = {}) {
  const { groups, errors, skipped } = planGroups(root, cfg)
  const failures = [...errors]

  log(`Peer-floor check — ${groups.length} distinct floor set(s)`)
  for (const g of groups) {
    log(`  ${g.key}`)
    for (const p of g.packages) log(`     ${p.name}`)
  }
  if (skipped.length) log(`  (skipped, no @noy-db peer: ${skipped.join(', ')})`)

  if (dryRun || failures.length) {
    if (dryRun) log('--dry-run: nothing installed.')
    return { failures, groups, skipped }
  }

  const rootPath = join(root, 'package.json')
  const rootOriginal = readFileSync(rootPath, 'utf8')
  const cmd = commands(cfg.manager, cfg.layout)
  const run = (spec) => execFileSync(spec[0], spec[1], { cwd: root, stdio: 'pipe', encoding: 'utf8', env: process.env })

  try {
    for (const g of groups) {
      log(`── installing ${g.key} …`)
      writeFileSync(rootPath, pinnedRootText(rootOriginal, g.floors, cfg.manager))

      try {
        run(cmd.install)
      } catch (e) {
        // A floor set that cannot even be installed is itself a failed claim —
        // usually two peers whose own peer requirements are incompatible.
        failures.push(`${g.key}: install failed: ${e.stderr || e.message}`)
        continue
      }

      let built = true
      for (const p of g.packages) {
        try {
          run(cmd.build(p.name))
        } catch (e) {
          // Reported as a BUILD failure so it is not mistaken for a type error.
          failures.push(`${p.name} @ ${g.key}: build failed:\n      ${`${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 500)}`)
          built = false
        }
      }
      if (!built) continue

      for (const p of g.packages) {
        try {
          run(cmd.typecheck(p.name))
          log(`   typecheck ${p.name} ok`)
        } catch (e) {
          log(`   typecheck ${p.name} FAILED`)
          const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
          const errs = out.split('\n').filter((l) => /error TS/.test(l)).slice(0, 4)
          failures.push(`${p.name} declares ${JSON.stringify(p.peers)} → floor ${g.key}\n      ${errs.join('\n      ') || out.slice(0, 400)}`)
        }
      }
    }
  } finally {
    // Restored in `finally` so an interrupted run does not leave a pinned
    // override behind, and re-installed so the tree matches the manifest again.
    writeFileSync(rootPath, rootOriginal)
    try {
      run(cmd.install)
    } catch {
      log('⚠  restore install failed — run the install again before committing.')
    }
  }

  return { failures, groups, skipped }
}
