// Every self-reference in this repo must name the SAME tag.
//
// ⛔ WHY, measured 2026-09-23: `v2` was cut, `as` moved its callers to
// `ci.yml@v2`, CI went green — and every gate that ran was `v1` code. The
// reusable workflows referenced their composite actions at a literal `@v1`, and
// `setup-family` checked out family-tools at a literal `ref: v1`. So the tag
// shipped the workflow YAML and NOT the tools, and the only visible difference
// was a scope suffix nobody would have thought to look for.
//
// ⭐ The failure is SILENT by construction: a partial bump produces a green run
// of the wrong code. That is why this is an invariant and not a checklist line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLS } from './helpers.mjs'

const REPO = join(TOOLS, '..')

// The source of truth: the line that decides which GATES run.
function toolsRef() {
  const action = readFileSync(join(REPO, 'actions/setup-family/action.yml'), 'utf8')
  const m = action.match(/^\s*ref: (v\d+)\s*$/m)
  assert.ok(m, 'setup-family/action.yml has no `ref: vN` — the tools checkout is the source of truth and must carry one')
  return m[1]
}

// Live refs only: a `#` comment showing a CALLER what to write is documentation,
// not a resolution, and ci.yml's header carries one on purpose.
function liveRefs() {
  const out = []
  for (const dir of ['.github/workflows', 'templates']) {
    for (const f of readdirSync(join(REPO, dir)).filter((n) => /\.ya?ml$/.test(n))) {
      const text = readFileSync(join(REPO, dir, f), 'utf8')
      text.split('\n').forEach((line, i) => {
        if (/^\s*#/.test(line)) return
        const m = line.match(/noy-db\/\.github[^@\s]*@(v\d+)/)
        if (m) out.push({ where: `${dir}/${f}:${i + 1}`, ref: m[1] })
      })
    }
  }
  return out
}

test('every live self-reference names the same tag as the tools checkout', () => {
  const ref = toolsRef()
  const refs = liveRefs()
  // ⛔ The empty-scope rule, applied to this check itself (#23): a walk that
  // finds nothing must fail, or a renamed directory makes this pass vacuously.
  assert.ok(refs.length >= 15, `expected at least 15 live self-references, found ${refs.length} — the scan is broken, not the repo`)
  const wrong = refs.filter((r) => r.ref !== ref)
  assert.deepEqual(wrong, [], `these lag the tools checkout (${ref}): ${wrong.map((w) => `${w.where}=${w.ref}`).join(', ')}`)
})
