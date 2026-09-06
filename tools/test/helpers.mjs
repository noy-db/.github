// Shared test scaffolding. Not a `*.test.mjs`, so `node --test "test/*.test.mjs"`
// does not try to run it as a suite.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const TOOLS = join(HERE, '..')
export const FIXTURES = join(TOOLS, 'fixtures')

/**
 * A throwaway copy of a fixture, so a test can MUTATE it into its red case
 * instead of the repo carrying a near-duplicate broken fixture per assertion.
 *
 * `verbatimSymlinks` is load-bearing: fixtures/workspace commits a RELATIVE
 * symlink at packages/a/node_modules/@noy-db/hub, and the default (dereference)
 * would copy hub's tree in its place. The copy would still pass — while no
 * longer testing that codemod-rows reads the INSTALLED hub rather than a second
 * copy of the maps, which is the whole point of that gate resolving hub.
 */
export function copyFixture(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `family-tools-${name}-`))
  cpSync(join(FIXTURES, name), dir, { recursive: true, verbatimSymlinks: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
