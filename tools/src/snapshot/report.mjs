// snapshot-report — what a snapshot run actually published.
//
// Run AFTER `changeset version --snapshot`, so it reads the versions changesets
// wrote rather than computing them: the workflow's summary must name what npm
// now carries, and a version this tool derived itself would agree with the
// manifest whether or not the publish did anything.
import { readPkg } from '../walk.mjs'
import { manifestDirs } from './prepare.mjs'

export function snapshotReport(root, cfg, { names = false, version = false } = {}) {
  const pkgs = manifestDirs(root, cfg)
    .map((dir) => readPkg(dir))
    .filter((json) => !json.private && json.name)
  // --version: the ONE version the line carries. release.yml compares it to the
  // Release tag; if the line is not uniform there is no single answer, and
  // versions-uniform (which runs first) is the gate that says so — this just
  // refuses to pick one.
  if (version) {
    const versions = [...new Set(pkgs.map((json) => json.version))]
    if (versions.length !== 1) throw new Error(`the line is not uniform: ${versions.join(', ')}`)
    return versions
  }
  return pkgs.map((json) => (names ? json.name : `${json.name}@${json.version}`)).sort()
}
