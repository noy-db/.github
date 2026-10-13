// changeset-coverage — every publishable package a PR touches is named by a
// pending changeset (noy-db/family#171).
//
// WHY IT EXISTS. A PR adding a published export with NO changeset passed
// `changeset-names`, which validates the names in changesets that EXIST — it
// says nothing about a change that has no changeset at all. That change then
// merges, `changeset version` has nothing to bump, and the export ships under
// an unchanged version (or not at all) with no release note.
//
// The predicate: the packages under the diff's touched paths (publishable only,
// `private` not true; exempt paths removed) ⊆ the union of package names in the
// frontmatter of `.changeset/*.md` at HEAD.
//
// ⛔ DELIBERATELY NOT COVERED: a repo without `.changeset/config.json`. The issue
// asks for the same predicate against CHANGELOG `## Unreleased` there. It is NOT
// implemented, on purpose: those satellites hand-write CHANGELOG at cut time, so
// that predicate would red every routine PR. Such a repo gets a clean pass that
// SAYS it does not apply — never a silent green that looks like a checked one.
//
// ⚠️ The denominator is `workspacePackages()` — the same reading of
// pnpm-workspace.yaml that changeset-names uses (see that file for why
// packageDirs() is wrong). An unreadable workspace, an unresolvable base or a
// failed git call is `cannot-run` (exit 2), NEVER a pass.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changesetNames, workspacePackages } from './changeset-names.mjs'

/**
 * Paths whose change never needs a changeset, because nothing under them ships
 * a behaviour change. Matched per path SEGMENT (directories) or BASENAME (files),
 * not as globs — the list is the specification, and `isExempt` implements it.
 *
 * The first block is the issue's list. The second is repo infrastructure: in a
 * `single` layout (lobby, daemon) the repo root IS the package, so without it a
 * workflow tweak or a changeset-only PR would read as an unannounced change.
 * Lockfiles never ship. Dotfiles are NOT exempt: `.npmignore` decides what ships.
 *
 * ⚠️ `package.json` is deliberately NOT exempt. A lockstep pin bump touches every
 * manifest and therefore needs a changeset — that is a published change.
 */
export const EXEMPT_PATHS = [
  // tests, docs, fixtures — the issue's list
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.md',
  '**/docs/**',
  '**/fixtures/**',
  '**/__fixtures__/**',
  // root infrastructure
  '.github/**',
  '.changeset/**',
  'family.config.json',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
]

const EXEMPT_DIRS = new Set(['__tests__', 'test', 'tests', 'docs', 'fixtures', '__fixtures__'])
const EXEMPT_ROOT_DIRS = new Set(['.github', '.changeset'])
const EXEMPT_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json'])

/** Whether a repo-relative POSIX path is covered by EXEMPT_PATHS. */
export function isExempt(path) {
  const segs = path.split('/')
  const base = segs[segs.length - 1]
  if (EXEMPT_ROOT_DIRS.has(segs[0]) || path === 'family.config.json' || EXEMPT_FILES.has(base)) return true
  if (segs.slice(0, -1).some((s) => EXEMPT_DIRS.has(s))) return true
  return base.endsWith('.md') || base.includes('.test.') || base.includes('.spec.')
}

class GitError extends Error {}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    throw new GitError(`git ${args.join(' ')} failed: ${String(err.stderr || err.message).trim()}`)
  }
}

/**
 * Where the PR's diff starts. Order: an explicit --base; else the PR's base
 * branch from GITHUB_BASE_REF (fetched, because CI checks out at depth 1 and a
 * shallow clone has no merge-base); else, inside Actions with no base ref, this
 * is a push — not a PR — and the gate does not apply; else (a local run)
 * origin/main.
 */
export function resolveBase(opts, env) {
  if (opts.base) return { base: opts.base, fetch: null }
  if (env.GITHUB_BASE_REF) return { base: `origin/${env.GITHUB_BASE_REF}`, fetch: env.GITHUB_BASE_REF }
  if (env.GITHUB_ACTIONS) return { na: 'n/a — not a PR' }
  return { base: 'origin/main', fetch: null }
}

const cannotRun = (msg) => ({ failures: [], status: 'cannot-run', cannotRun: msg })

const versionAt = (root, rev, path) => {
  try {
    return JSON.parse(git(root, ['show', `${rev}:${path}`])).version
  } catch {
    return undefined
  }
}

export function runChangesetCoverage(root, cfg, opts = {}) {
  const env = opts.env ?? process.env
  if (!existsSync(join(root, '.changeset', 'config.json')))
    return { failures: [], scope: 'n/a — no .changeset/ (satellite CHANGELOG coverage is deliberately not checked)' }

  const where = resolveBase(opts, env)
  if (where.na) return { failures: [], scope: where.na }

  const ws = workspacePackages(root, cfg.layout)
  if (ws.unparsed) return cannotRun(`cannot determine the workspace package set — ${ws.unparsed}`)

  let mergeBase, rows
  try {
    if (where.fetch) {
      if (git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true')
        git(root, ['fetch', '--no-tags', '--quiet', '--unshallow', 'origin'])
      git(root, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${where.fetch}:refs/remotes/origin/${where.fetch}`])
    }
    mergeBase = git(root, ['merge-base', where.base, 'HEAD']).trim()
    // --no-renames: a move shows as a delete + an add, so BOTH packages count.
    const out = git(root, ['diff', '--name-status', '--no-renames', '-z', mergeBase, 'HEAD'])
    const parts = out.split('\0').filter(Boolean)
    rows = []
    for (let i = 0; i + 1 < parts.length; i += 2) rows.push({ status: parts[i], path: parts[i + 1] })
  } catch (err) {
    if (err instanceof GitError) return cannotRun(`cannot compute the PR diff against ${where.base} — ${err.message}`)
    throw err
  }

  const base = `${where.base}@${mergeBase.slice(0, 8)}`
  const isChangeset = (p) => /^\.changeset\/[^/]+\.md$/.test(p) && p !== '.changeset/README.md'

  // A RELEASE PR is `changeset version`'s output: it CONSUMES the changesets
  // and bumps versions. Outside pre mode consuming means DELETING them; in pre
  // mode (core cuts 0.x-pre.N this way) the files stay and `.changeset/pre.json`
  // records them instead — measured on core's 0.10.0-pre.2 release PR (#214),
  // which deletes nothing. Both conjuncts are required either way: deleting a
  // stale changeset alone is not a release, and must not switch the gate off.
  const consumed = rows.filter((r) => r.status === 'D' && isChangeset(r.path))
  const preRecorded = rows.some((r) => r.status !== 'D' && r.path === '.changeset/pre.json')
  if (consumed.length > 0 || preRecorded) {
    const bumped = rows.filter(
      (r) =>
        r.status === 'M' &&
        /(^|\/)package\.json$/.test(r.path) &&
        versionAt(root, mergeBase, r.path) !== versionAt(root, 'HEAD', r.path),
    )
    if (bumped.length > 0)
      return {
        failures: [],
        scope:
          `release PR — ${preRecorded ? 'records changesets in pre.json' : `consumes ${consumed.length} changeset(s)`} ` +
          `and bumps ${bumped.length} manifest version(s) vs ${base}`,
      }
  }

  // The union of names in PENDING changesets at HEAD, read the way
  // changeset-names reads them. ⚠️ In pre mode (`pre.json` mode "pre") a
  // changeset already recorded in pre.json is CONSUMED — it stays on disk but
  // will not bump anything again — so it must not cover a new change. Without
  // this, core's ~50 recorded changesets would name every hot package and the
  // gate would never fire there. In mode "exit" every file on disk is still
  // versioned by the next `changeset version`, so all of them count.
  const dir = join(root, '.changeset')
  let consumedIds = new Set()
  if (existsSync(join(dir, 'pre.json'))) {
    const pre = JSON.parse(readFileSync(join(dir, 'pre.json'), 'utf8'))
    if (pre.mode === 'pre') consumedIds = new Set(pre.changesets ?? [])
  }
  const files = readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md' && !consumedIds.has(n.slice(0, -3)))
  const named = new Set()
  for (const f of files) for (const n of changesetNames(readFileSync(join(dir, f), 'utf8')) ?? []) named.add(n)

  // Longest directory wins: in a flat repo the private workspace root (dir '')
  // contains every package, and must not swallow their paths.
  const byDepth = [...ws.packages].sort((a, b) => b.dir.length - a.dir.length)
  const owner = (p) => byDepth.find((pkg) => pkg.dir === '' || p === pkg.dir || p.startsWith(`${pkg.dir}/`))

  let exempt = 0
  const touched = new Map() // publishable name -> paths
  for (const { path } of rows) {
    if (isExempt(path)) { exempt++; continue }
    const pkg = owner(path)
    if (!pkg || pkg.private) continue
    if (!touched.has(pkg.name)) touched.set(pkg.name, [])
    touched.get(pkg.name).push(path)
  }

  const failures = []
  for (const [name, paths] of touched) {
    if (named.has(name)) continue
    failures.push(
      `"${name}" is changed by this PR (${paths.length} path(s), e.g. ${paths[0]}) but no .changeset/*.md names it — ` +
        `add a changeset that bumps it (\`pnpm changeset\`). Without one the change merges and ships under no version and no release note.`,
    )
  }

  // ⭐ A green states its scope (noy-db/.github#23): "touched nothing publishable"
  // and "touched six packages, all named" must not print the same tick.
  const publishable = ws.packages.filter((p) => !p.private).length
  return {
    failures,
    scope:
      `${rows.length} changed path(s) vs ${base}: ${exempt} exempt, ${touched.size} publishable package(s) touched, ` +
      `${failures.length} unnamed; ${named.size} name(s) across ${files.length} pending changeset file(s)` +
      `${consumedIds.size ? ` (${consumedIds.size} consumed in pre mode, not counted)` : ''}; ` +
      `${publishable} publishable of ${ws.packages.length} workspace package(s)`,
  }
}
