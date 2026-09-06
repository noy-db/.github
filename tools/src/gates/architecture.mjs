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
// It never calls process.exit and never prints: it returns failures, so a test
// can assert on them. cli.mjs owns the exit code.
import { join, relative, basename } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { packageDirs, readPkg, walkTs, HUB_IMPORT_RE } from '../walk.mjs'

const BANNED = new Set(['crypto-js', 'node-forge', 'tweetnacl', 'bcryptjs', 'bcrypt'])

// Which hub subpaths each bound layer may import.
//   allowed   — value or type, freely
//   typeOnly  — the types erase at build and move no data, so `import type` is
//               fine while a VALUE import is a layer violation
//   peerOptionalWhenUnused — the `on-*` family has standalone primitives that
//               import hub nowhere; they owe no peer (noy-db-on)
const SEAM = {
  '@noy-db/hub/to': { allowed: new Set(['/to']), rule: 'to-only' },
  '@noy-db/hub/as': { allowed: new Set(['/as']), typeOnly: new Set(['/to']), rule: 'no-runtime-store-import' },
  '@noy-db/hub/on': { allowed: new Set(['/on']), typeOnly: new Set(['/to']), rule: 'no-runtime-store-import', peerOptionalWhenUnused: true },
  '@noy-db/hub/at': { allowed: new Set(['/at']), typeOnly: new Set(['/to']), rule: 'no-runtime-store-import' },
  '@noy-db/hub/cargo': { allowed: new Set(['', '/cargo', '/pod', '/share-link']), rule: 'klum-only-seam' },
  '@noy-db/hub/introspection': { allowed: new Set(['/introspection']), rule: 'introspection-only' },
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
      walkTs(join(dir, 'src'), (file, code) => {
        const re = new RegExp(HUB_IMPORT_RE.source, 'g')
        let m
        while ((m = re.exec(code)) !== null) {
          const sub = m[1] ?? ''
          if (seam.allowed.has(sub)) continue
          if (seam.typeOnly?.has(sub)) {
            // ⚠️ Scan BACKWARD from the specifier to its own `import` keyword.
            // One regex over the statement looks right and is wrong: `[^;]*`
            // matches NEWLINES, so it spans from an unrelated multi-line import
            // at the top of the file down to a `from` clause far below and
            // misses the `type` keyword that is actually there.
            const kw = code.lastIndexOf('import', m.index)
            if (kw !== -1 && /^import\s+type\b/.test(code.slice(kw, m.index + m[0].length))) continue
            fail(seam.rule, `${pj.name}: value-imports '@noy-db/hub${sub}'; use \`import type\` — this layer never performs storage I/O.`, file)
            continue
          }
          fail(seam.rule, `${pj.name}: imports '@noy-db/hub${sub}' — allowed: ${[...seam.allowed].map((s) => `@noy-db/hub${s}`).join(', ')}.`, file)
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
