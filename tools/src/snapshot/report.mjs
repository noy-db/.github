// snapshot-report — what a snapshot run actually published.
//
// Run AFTER `changeset version --snapshot`, so it reads the versions changesets
// wrote rather than computing them: the workflow's summary must name what npm
// now carries, and a version this tool derived itself would agree with the
// manifest whether or not the publish did anything.
import { readPkg } from '../walk.mjs'
import { manifestDirs } from './prepare.mjs'

export function snapshotReport(root, cfg, { names = false } = {}) {
  return manifestDirs(root, cfg)
    .map((dir) => readPkg(dir))
    .filter((json) => !json.private && json.name)
    .map((json) => (names ? json.name : `${json.name}@${json.version}`))
    .sort()
}
