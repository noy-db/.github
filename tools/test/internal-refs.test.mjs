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
//
// README fenced blocks count as live (family#143): a new member copies the
// README's caller verbatim, so a stale tag there ships the wrong code just as
// silently as one in templates/. The README carried four `@v1` snippets for
// three weeks after the v2 cut; nothing read them.
function liveRefs() {
  const out = []
  const scan = (where, text, live) => {
    text.split('\n').forEach((line, i) => {
      if (!live(line) || /^\s*#/.test(line)) return
      const m = line.match(/noy-db\/\.github[^@\s]*@(v\d+)/)
      if (m) out.push({ where: `${where}:${i + 1}`, ref: m[1] })
    })
  }
  for (const dir of ['.github/workflows', 'templates']) {
    for (const f of readdirSync(join(REPO, dir)).filter((n) => /\.ya?ml$/.test(n))) {
      scan(`${dir}/${f}`, readFileSync(join(REPO, dir, f), 'utf8'), () => true)
    }
  }
  let fenced = false
  scan('README.md', readFileSync(join(REPO, 'README.md'), 'utf8'), (line) => {
    if (/^```/.test(line)) fenced = !fenced
    return fenced
  })
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

// The README's caller snippets are the templates verbatim (family#143): a new
// member copies the README, so a snippet that drifts from its template is a
// second, unmeasured caller shape.
test('every README caller snippet equals its template, minus the template header line', () => {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
  const fences = [...readme.matchAll(/^```yaml\n# \.github\/workflows\/([a-z-]+)\.yml[^\n]*\n([\s\S]*?)^```$/gm)]
  assert.ok(fences.length >= 7, `expected the README to carry the caller snippets, found ${fences.length}`)
  for (const [, name, body] of fences) {
    const template = readFileSync(join(REPO, 'templates', `${name}-caller.yml`), 'utf8').split('\n').slice(1).join('\n')
    assert.equal(body.trimEnd(), template.trimEnd(), `README snippet for ${name}.yml drifted from templates/${name}-caller.yml`)
  }
})
