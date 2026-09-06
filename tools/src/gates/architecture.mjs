// The architecture gate — one implementation of the four hand-copied
// `scripts/check-architecture.mjs` in noy-db-to, -as, -on, -at and klum-db.
//
// Two deliberate divergences from the copies it replaces:
//   • the `to` seam runs through the SAME regex loop as every other seam,
//     rather than its own hand-rolled scan;
//   • noy-db-as's hard-coded `DESTINATIONS` set is gone — a package opts out
//     through `exempt` in family.config.json, where the repo that owns the
//     exemption can see it.
//
// ⛔ WHAT THIS FILE GOT WRONG ONCE, so nobody re-derives it. The first version
// modelled EVERY seam as an allow-list of subpaths. Measured against the real
// trees (task 5, finding A) that produced 35 false failures: 16 on noy-db-as,
// 18 on noy-db-on, 1 on doi-db — all of them correct code. Two causes:
//
//   1. `no-runtime-store-import` is NOT an allow-list. noy-db-as's own script
//      says so in its header: it is "NOT noy-db-to's `to-only` rule … Ported
//      verbatim it fails on correct code here, because an `as-*` package binds
//      its own port and legitimately reads shared types from the root." Its
//      real predicate is a single prohibition — a VALUE import of
//      '@noy-db/hub/to' — and every other hub subpath is fine.
//   2. Type-only imports were only forgiven on the subpaths a `typeOnly` set
//      listed. They erase at build and move no data, so they cross no runtime
//      boundary AT ALL; 14 of the 16 noy-db-as failures were `import type`.
//
// So a seam is now one of two SHAPES, and the difference is load-bearing:
// `storeOnly` (a prohibition) or `allowed` (an allow-list).
//
// It never calls process.exit and never prints: it returns failures, so a test
// can assert on them. cli.mjs owns the exit code.
import { join, relative, basename } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { packageDirs, readPkg, walkTs, HUB_IMPORT_RE } from '../walk.mjs'

const BANNED = new Set(['crypto-js', 'node-forge', 'tweetnacl', 'bcryptjs', 'bcrypt'])

// How each bound layer is constrained.
//   storeOnly — a PROHIBITION: only a VALUE import of the store contract
//               ('@noy-db/hub/to') fails. Every other subpath, root barrel
//               included, is allowed. This is noy-db-as/-on/-at's real rule.
//   allowed   — an ALLOW-LIST of subpaths ('' is the root barrel). Anything
//               outside it fails. noy-db-to and klum-db work this way.
//   peerOptionalWhenUnused — the `on-*` family has standalone primitives that
//               import hub nowhere; they owe no peer (noy-db-on).
//
// `allowHubRoot` in family.config.json adds '' to an allow-list seam. doi-db
// binds /to and its own script reads
// `ALLOWED_HUB = new Set(['@noy-db/hub', '@noy-db/hub/to'])`, because hub's
// contract (#935) requires `isConflictError` and /to does not export it. It is
// config rather than a hard-coded row so the repo that needs the exemption is
// the one that declares it.
const SEAM = {
  '@noy-db/hub/to': { allowed: new Set(['/to']), rule: 'to-only' },
  '@noy-db/hub/as': { storeOnly: true, rule: 'no-runtime-store-import' },
  '@noy-db/hub/on': { storeOnly: true, rule: 'no-runtime-store-import', peerOptionalWhenUnused: true },
  '@noy-db/hub/at': { storeOnly: true, rule: 'no-runtime-store-import' },
  '@noy-db/hub/cargo': { allowed: new Set(['', '/cargo', '/pod', '/share-link']), rule: 'klum-only-seam' },
  '@noy-db/hub/introspection': { allowed: new Set(['/introspection']), rule: 'introspection-only' },
}

/**
 * Is this hub import type-only?
 *
 * ⚠️ Scan BACKWARD from the specifier to its own `import`/`export` keyword. One
 * regex over the statement looks right and is wrong: `[^;]*` matches NEWLINES,
 * so it spans from an unrelated multi-line import at the top of the file down
 * to a `from` clause far below and misses the `type` keyword that is actually
 * there. That produced a false positive on real code (noy-db-as's own header).
 *
 * Only a `from` match can be type-only. A bare side-effect import
 * (`import '@noy-db/hub'`) and a `require()` have no type form, and scanning
 * backward from those would find some UNRELATED earlier `import type` and
 * forgive a real runtime import.
 */
function isTypeOnlyImport(code, match) {
  if (!/^from/.test(match[0])) return false
  const kw = Math.max(code.lastIndexOf('import', match.index), code.lastIndexOf('export', match.index))
  if (kw === -1) return false
  return /^(?:import|export)\s+type\b/.test(code.slice(kw, match.index + match[0].length))
}

export function runArchitecture(root, cfg) {
  const failures = []
  const fail = (rule, msg, where) => failures.push({ rule, msg, where: where ? relative(root, where) : '' })
  const dirs = packageDirs(root, cfg.layout).filter((d) => !cfg.exempt.includes(basename(d)))
  const seam = cfg.binds ? SEAM[cfg.binds] : null
  const importsHub = (dir) => {
    let f = false
    walkTs(join(dir, 'src'), (_p, c) => {
      HUB_IMPORT_RE.lastIndex = 0
      if (HUB_IMPORT_RE.test(c)) f = true
    })
    return f
  }

  for (const dir of dirs) {
    const pj = readPkg(dir)
    // A private package in a workspace or flat repo publishes nothing and owes
    // no published range. A `single` repo's root is often private and IS the
    // deliverable (doi-db), so it is never skipped.
    if (pj.private && cfg.layout !== 'single') continue

    // hub-peer-range — a bound seam is declared as a published range, never a
    // dep, never workspace:.
    if (seam) {
      const dep = pj.dependencies?.['@noy-db/hub']
      const peer = pj.peerDependencies?.['@noy-db/hub']
      if (dep !== undefined)
        fail('hub-peer-range', `${pj.name} has @noy-db/hub in dependencies; it must be a peerDependency range.`, dir)
      const mustPeer = !(seam.peerOptionalWhenUnused && !importsHub(dir))
      if (peer === undefined) {
        if (mustPeer) fail('hub-peer-range', `${pj.name} is missing peerDependencies['@noy-db/hub'].`, dir)
      } else if (peer.startsWith('workspace:'))
        fail('hub-peer-range', `${pj.name} peers @noy-db/hub as "${peer}"; a cross-repo package must use a published range.`, dir)
      else if (!/^[\^~]?\d/.test(peer))
        fail('hub-peer-range', `${pj.name} peers @noy-db/hub as "${peer}"; expected a semver range.`, dir)

      // seam rule — which hub subpaths this layer may import.
      const allowed = seam.allowed && new Set(cfg.allowHubRoot ? ['', ...seam.allowed] : seam.allowed)
      walkTs(join(dir, 'src'), (file, code) => {
        const re = new RegExp(HUB_IMPORT_RE.source, 'g')
        let m
        while ((m = re.exec(code)) !== null) {
          const sub = m[1] ?? ''
          // Types cross NO runtime boundary, on any subpath and under any
          // seam, so this precedes every other test rather than being a
          // per-subpath exemption.
          if (isTypeOnlyImport(code, m)) continue

          if (seam.storeOnly) {
            if (sub === '/to')
              fail(seam.rule, `${pj.name}: value-imports '@noy-db/hub/to' — this layer never performs storage I/O; use \`import type\` for the contract's types.`, file)
            continue
          }

          if (allowed.has(sub)) continue
          fail(seam.rule, `${pj.name}: imports '@noy-db/hub${sub}' — allowed: ${[...allowed].map((s) => `@noy-db/hub${s}`).join(', ')}.`, file)
        }
      })
    }

    // no-crypto-deps — all crypto lives inside hub's trust boundary. It is
    // strongest for the one family that sees PLAINTEXT (as-*): its own crypto
    // would run on decrypted user data OUTSIDE that boundary.
    for (const block of ['dependencies', 'devDependencies', 'peerDependencies'])
      for (const name of Object.keys(pj[block] ?? {}))
        if (BANNED.has(name) || name.startsWith('@noble/') || name.startsWith('@scure/'))
          fail('no-crypto-deps', `${pj.name} depends on crypto package "${name}"; all crypto belongs inside @noy-db/hub.`, dir)

    // one-way — @noy-db/* never imports the lobby.
    if (pj.name?.startsWith('@noy-db/') && pj.name !== '@noy-db/lobby')
      walkTs(join(dir, 'src'), (file, code) => {
        if (/['"]@(?:noy-db|klum-db)\/lobby['"]/.test(code))
          fail('one-way', `${pj.name} imports the lobby; @noy-db never imports back.`, file)
      })

    // as-conformance-fixture — every format runs the published kit. When the
    // 0.7 inversion broke four fixtures they were DELETED rather than migrated
    // and nothing noticed: a deleted test does not fail (noy-db #1209).
    if (cfg.conformanceKit) {
      const t = join(dir, '__tests__')
      let found = false
      if (existsSync(t))
        for (const f of readdirSync(t))
          if (f.endsWith('.ts') && readFileSync(join(t, f), 'utf8').includes(`${cfg.conformanceKit}(`)) {
            found = true
            break
          }
      if (!found)
        fail('as-conformance-fixture', `${basename(dir)} has no test invoking ${cfg.conformanceKit}. Write the fixture; do not delete it (noy-db #1209).`, dir)
    }
  }
  return { failures }
}
