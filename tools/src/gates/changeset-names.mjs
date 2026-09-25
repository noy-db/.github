// changeset-names — every pending changeset names a package the workspace has.
//
// WHY IT EXISTS. core merged family#39 step 5 (delete the six conformance
// re-export shims) and the @dev rail was DEAD for three consecutive snapshot
// runs before anyone noticed. Three of 33 changesets still named the deleted
// packages, and `changeset version` refuses the ENTIRE run on one unknown name:
//
//   Found changeset capsule-group-vocabulary for package
//   @noy-db/test-capsule-conformance which is not in the workspace
//
// ⛔ WHY NOTHING CAUGHT IT, and why this has to be a gate rather than care:
//   - it fails at the VERSION step, before auth and before publish, so nothing
//     is dropped and nothing half-publishes — there is no damage to go find;
//   - the deleting PR's own CI is GREEN, because removing a package breaks
//     nothing that the PR runs;
//   - it only fires on merge to main, by which time the author has moved on;
//   - the error names ONE package, so it reads as one stale row rather than
//     "the release rail is down".
//
// A rename is caught by the type system. A deletion referenced BY STRING is
// caught by nothing until something reads the string. This reads the string.
//
// ⚠️ DO NOT "simplify" the denominator to packageDirs(). It walks packages/ (or
// the repo root) only, and core's pnpm-workspace.yaml also declares
// test-harnesses/* — six private packages that changesets resolves and
// packageDirs cannot see. Using it here would report every changeset naming a
// test harness as dead, which is a FALSE POSITIVE that breaks CI on a correct
// tree. The denominator must come from the same file changesets reads.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The workspace's package-name set, read from the manifest changesets reads.
 *
 * Returns { names, globs } or { unparsed } — and `unparsed` is deliberately
 * fatal upstream rather than skipped. An UNDER-counted denominator invents dead
 * names (loud, wrong, and it blocks a correct merge); an over-counted one only
 * misses a real row. Since the two failure directions are not symmetric, a glob
 * shape this function does not understand must stop the gate, never widen it.
 */
export function workspacePackages(root, layout = 'single') {
  const globs = []
  const wsYaml = join(root, 'pnpm-workspace.yaml')
  if (existsSync(wsYaml)) {
    // Deliberately not a YAML parser: the file is a `packages:` key and a list
    // of quoted globs in every repo in this family. Anything else is `unparsed`.
    for (const raw of readFileSync(wsYaml, 'utf8').split('\n')) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || line === 'packages:') continue
      const m = /^-\s*["']?([^"'#]+?)["']?$/.exec(line)
      if (!m) return { unparsed: `pnpm-workspace.yaml: cannot read the line ${JSON.stringify(line)}` }
      globs.push(m[1].trim())
    }
  } else {
    const pj = join(root, 'package.json')
    if (!existsSync(pj)) return { unparsed: 'no pnpm-workspace.yaml and no package.json at the root' }
    const ws = JSON.parse(readFileSync(pj, 'utf8')).workspaces
    if (Array.isArray(ws)) globs.push(...ws)
    else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages)
    // No workspace at all is legitimate (layout "single"): the root package is
    // the whole set, handled below.
  }

  // ⛔ A multi-package layout with NO workspace manifest would leave the
  // denominator as {root package} alone, and then EVERY changeset reads as dead.
  // That is the false-positive direction, so it stops the gate instead.
  if (globs.length === 0 && layout !== 'single')
    return { unparsed: `family.config.json declares layout "${layout}" but no workspace manifest lists any package glob` }

  const names = new Set()
  const add = (dir) => {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) return
    const { name } = JSON.parse(readFileSync(pj, 'utf8'))
    if (name) names.add(name)
  }
  add(root) // a single-package repo, and harmless elsewhere

  for (const g of globs) {
    if (g.startsWith('!')) continue // an exclusion only ever SHRINKS the set
    // ⛔ Validate the WHOLE entry before splitting it. Checking only the last
    // segment let "pack*ges/*" through: the directory part never matched, the
    // loop contributed nothing, and the gate went on to call every changeset
    // dead. That is the UNDER-COUNT direction — the one that invents failures —
    // reached by a check that looked thorough.
    const stars = (g.match(/\*/g) ?? []).length
    const literal = stars === 0
    // The only glob this gate reads is a single trailing "*" on the LAST segment:
    // "dir/*", "prefix-*". Anything else (a "**", a star inside a directory
    // name, a star not at the end) is refused rather than approximated.
    if (!literal && !/^[^*]*\*$/.test(g.slice(g.lastIndexOf('/') + 1)))
      return { unparsed: `workspace glob ${JSON.stringify(g)} is not "<dir>/*", "<prefix>*" or a literal directory — this gate does not guess` }
    if (!literal && stars !== 1)
      return { unparsed: `workspace glob ${JSON.stringify(g)} has more than one "*" — this gate does not guess` }

    const slash = g.lastIndexOf('/')
    const base = slash === -1 ? root : join(root, g.slice(0, slash))
    const leaf = slash === -1 ? g : g.slice(slash + 1)

    // ⭐ A workspace entry need not be a glob at all. docs-site lists `showcases`
    // and `registry` — literal directories, each ONE package. Treating a
    // star-free entry as unreadable made that repo exit 2, and a repo that
    // cannot run a gate quietly stops being covered by it, which is the vacuity
    // trap this rail has already paid for once.
    if (literal) {
      const p = join(base, leaf)
      if (existsSync(p) && statSync(p).isDirectory()) add(p)
      continue
    }

    const prefix = leaf.slice(0, -1)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue
      if (!entry.startsWith(prefix)) continue
      const p = join(base, entry)
      if (statSync(p).isDirectory()) add(p)
    }
  }
  return { names, globs }
}

/** The package names a changeset's frontmatter bumps, with its own filename. */
export function changesetNames(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return null // not a changeset: no frontmatter at all
  const out = []
  for (const raw of m[1].split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    // `'@scope/pkg': patch` — quotes are what changesets writes, but a
    // hand-written row may omit them on an unscoped name.
    const mm = /^["']?([^"':]+?)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line)
    if (mm) out.push(mm[1].trim())
  }
  return out
}

export function runChangesetNames(root, cfg) {
  const dir = join(root, '.changeset')
  if (!existsSync(dir))
    return {
      failures: [],
      status: 'cannot-run',
      cannotRun:
        'no .changeset/ directory — this gate reads pending changesets, so it examined nothing. ' +
        'Remove it from this repo\'s gates rather than letting it report a vacuous pass.',
    }

  const ws = workspacePackages(root, cfg.layout)
  if (ws.unparsed)
    return { failures: [], status: 'cannot-run', cannotRun: `cannot determine the workspace package set — ${ws.unparsed}` }

  const files = readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md')
  const failures = []
  let rows = 0
  for (const file of files) {
    const named = changesetNames(readFileSync(join(dir, file), 'utf8'))
    if (named === null) continue // README-shaped prose, not a changeset
    for (const name of named) {
      rows++
      if (!ws.names.has(name))
        failures.push(
          `${relative(root, join(dir, file))} bumps "${name}", which is not in the workspace — ` +
            `\`changeset version\` will refuse the WHOLE run. Re-point it at the package that owns this ` +
            `change now, or drop the file; dropping it discards a release note somebody wrote.`,
        )
    }
  }

  // ⛔ Zero changesets is the NORMAL state right after a release, so it is not
  // cannot-run. But the scope line says both numbers, because "0 rows" and "33
  // rows, all fine" must not print the same green — that is noy-db/.github#23.
  return {
    failures,
    scope: `${rows} bump row(s) across ${files.length} changeset file(s), against ${ws.names.size} workspace package(s)`,
  }
}
