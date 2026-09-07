// snapshot-prepare — the in-place manifest edits a `changeset version
// --snapshot` publish to the org registry needs, and nothing else.
//
// It does NOT run changesets. The workflow does. Keeping the mutation and the
// invocation apart is what lets this be tested at all: the edits are the part
// that goes quietly wrong, and they are pure filesystem work.
//
// Every step is IDEMPOTENT, because a re-run of a failed workflow is normal and
// the second run must not double-append a range or claim it changed something
// it did not. `widened` and `privatised` therefore record CHANGES, not states —
// a second run reports both empty. `versionedPackages` is a function of the
// tree, so it is stable across runs.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageDirs, readPkg } from '../walk.mjs'

// The clause that makes an existing peer range admit a `0.0.0-dev-<sha>`
// snapshot. Bounded above by <0.0.1 so it admits ONLY snapshot versions and
// never a real release that the original range deliberately excluded.
export const DEV_CLAUSE = '>=0.0.0-dev-0 <0.0.1'
const DEV_MARKER = '0.0.0-dev-0'

const writeJson = (file, json) => writeFileSync(file, JSON.stringify(json, null, 2) + '\n')

/**
 * Every manifest this repo owns: the packages, plus the root when it is not
 * already one of them. The root matters for a `workspace` layout too — it is
 * where an unscoped name most often sits, and step 5 must reach it.
 */
export function manifestDirs(root, cfg) {
  const dirs = packageDirs(root, cfg.layout)
  if (!dirs.includes(root) && existsSync(join(root, 'package.json'))) return [root, ...dirs]
  return dirs
}

export function prepareSnapshot(root, cfg, { tag, registry }) {
  const dirs = manifestDirs(root, cfg)
  const entries = dirs.map((dir) => ({ dir, json: readPkg(dir) }))
  const publishable = entries.filter(({ json }) => !json.private && json.name?.startsWith('@noy-db/'))

  // (1) Leave pre mode. `changeset version --snapshot` refuses to run in it,
  // and the refusal reads as a changesets bug rather than a repo state.
  const preJson = join(root, '.changeset/pre.json')
  if (existsSync(preJson)) rmSync(preJson)

  // (2) One changeset naming every publishable package, so `version --snapshot`
  // touches all of them. Without it changesets versions only what has a pending
  // changeset — which on a green main is nothing, and the snapshot publishes an
  // empty set while exiting 0.
  // Nothing publishable means NO changeset file. An empty frontmatter block
  // ("---\n---") is not a harmless no-op: `changeset version` reads it as a
  // malformed changeset and fails the workflow at a step that has nothing to do
  // with the real condition, which is simply that this repo has nothing to ship.
  const versionedPackages = publishable.map(({ json }) => json.name).sort()
  if (versionedPackages.length > 0) {
    mkdirSync(join(root, '.changeset'), { recursive: true })
    writeFileSync(
      join(root, '.changeset/zz-snapshot-all.md'),
      `---\n${versionedPackages.map((n) => `"${n}": patch\n`).join('')}---\n\nsnapshot\n`,
    )
  }

  const privatised = []
  const widened = []
  const skipped = []

  for (const { dir, json } of entries) {
    const file = join(dir, 'package.json')
    let touched = false

    // (3) Point the publish at the org registry under the dev tag. Spread over
    // the existing block rather than replacing it: `access: "public"` and
    // friends must survive, and losing one fails at publish time, not here.
    if (!json.private && json.name?.startsWith('@noy-db/')) {
      const next = { ...(json.publishConfig ?? {}), registry, tag }
      if (JSON.stringify(next) !== JSON.stringify(json.publishConfig)) {
        json.publishConfig = next
        touched = true
      }
    }

    // (4) Widen every @noy-db peer range to admit a snapshot version. A
    // snapshot's `0.0.0-dev-<sha>` satisfies no real range, so without this the
    // set installs only with --legacy-peer-deps — which is exactly the property
    // the family refuses to depend on.
    //
    // Appended, never replaced: the original range is the published promise and
    // this is a temporary widening for one registry.
    for (const [name, range] of Object.entries(json.peerDependencies ?? {})) {
      if (!name.startsWith('@noy-db/')) continue
      if (range.includes(DEV_MARKER)) continue // already widened — a re-run
      // A workspace-protocol peer is not a semver range yet: changesets turns
      // `workspace:^` into `^<snapshot version>` during `changeset version`,
      // which already admits every later snapshot. Appending the clause here
      // yields `workspace:^ || …`, which changesets rejects as
      // "Invalid comparator: ^" — measured on noy-db/core's first snapshot.
      if (range.startsWith('workspace:')) continue
      // A range with a dangling "||" must NOT be widened. Appending would give
      // "^0.7.0 ||  || >=0.0.0-dev-0 <0.0.1", which semver reads as "*" — so a
      // malformed range would be silently upgraded into an unbounded one, and
      // the snapshot would install against anything. Report it instead: the
      // versions-uniform gate is what fixes it, and this is not that gate.
      const trimmed = range.trim()
      if (trimmed.endsWith('||') || trimmed.startsWith('||')) {
        skipped.push(`${json.name}: ${name} ${JSON.stringify(range)}`)
        continue
      }
      json.peerDependencies[name] = `${range} || ${DEV_CLAUSE}`
      touched = true
      if (!widened.includes(json.name)) widened.push(json.name)
    }

    // (5) An unscoped name has no place in the @noy-db org registry, and a
    // changesets run would otherwise try to publish it there and 404. Marking
    // it private is the narrowest way to take it out of the set.
    if (!json.name?.startsWith('@noy-db/') && json.private !== true) {
      json.private = true
      privatised.push(json.name)
      touched = true
    }

    if (touched) writeJson(file, json)
  }

  return { versionedPackages, privatised: privatised.sort(), widened: widened.sort(), skipped: skipped.sort() }
}
