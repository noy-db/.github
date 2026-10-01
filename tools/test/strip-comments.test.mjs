import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripComments } from '../src/gates/strip-comments.mjs'

test('the family#64 case: import syntax inside a line comment is not an import', () => {
  // Verbatim shape from noy-db/to's bundle-size.test.ts, which made declared-deps
  // report a dependency named "peer" for two packages.
  const src = [
    "import { describe, expect, it } from 'vitest'",
    '  // Static (`from "peer"`) or dynamic (`import("peer")`) — this package',
    "  const spec = `${peer}(/[^\"']+)?`",
  ].join('\n')
  const out = stripComments(src)
  assert.ok(out.includes("from 'vitest'"), 'the real import survives')
  assert.ok(!/from\s+"peer"/.test(out), 'the commented static form is gone')
  assert.ok(!/import\(\s*"peer"\s*\)/.test(out), 'and the commented dynamic form')
})

test('CONTROL: the same specifier in real code is still found', () => {
  // Without this the fix could blank everything and the gate would pass always —
  // which is worse than over-firing.
  const out = stripComments('const d = await import("peer")\n')
  assert.match(out, /import\(\s*"peer"\s*\)/)
})

test('a // inside a string is not a comment', () => {
  const src = 'const u = "https://example.com//x"\nimport "after"\n'
  const out = stripComments(src)
  assert.ok(out.includes('https://example.com//x'), 'the URL is intact')
  assert.ok(out.includes('import "after"'), 'and the line after it survives')
})

test('block comments and JSDoc are blanked', () => {
  assert.ok(!stripComments('/* import("a") */\n').includes('a'))
  assert.ok(!stripComments('/**\n * import("b")\n */\n').includes('b'))
})

test('a block comment END inside a string does not close it early', () => {
  const src = '/* a "*/" b */\nimport "real"\n'
  assert.ok(stripComments(src).includes('import "real"'))
})

test('an escaped quote does not end the string early', () => {
  const src = 'const s = "it\\" // not a comment"\nimport "real"\n'
  const out = stripComments(src)
  assert.ok(out.includes('import "real"'))
  // The body has whitespace, so family#106 blanks it; what this test protects is
  // that the escaped quote did not END the string and leak `//` into a comment.
  assert.equal(out.split('\n')[0].length, src.split('\n')[0].length, 'the string line keeps its length')
})

test('template literals are treated as strings', () => {
  const out = stripComments('const t = `a // b`\nimport "real"\n')
  assert.ok(out.startsWith('const t = `'), 'the template opened as a string, not as code')
  assert.ok(out.includes('import "real"'), 'its `//` was not a comment that ate the next line')
})

test('length, line count and newlines are preserved — the scanners are ^-anchored /gm', () => {
  const src = '// one\nimport "x"\n/* two\nthree */\nimport "y"\n'
  const out = stripComments(src)
  assert.equal(out.length, src.length)
  assert.equal(out.split('\n').length, src.split('\n').length)
  // BARE_IMPORT is /^\s*import\s+['"]…/gm — both must still match at line start
  const found = [...out.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(found, ['x', 'y'])
})

test('a file with no comments is returned unchanged', () => {
  const src = 'import a from "b"\nexport const c = 1\n'
  assert.equal(stripComments(src), src)
})

test('family#106: import syntax inside a TEMPLATE that scaffolds a file is not an import', () => {
  // cli's config.ts shape: generated file text, not this module's imports.
  const src = "import { x } from '@noy-db/hub'\nconst t = `import { awsDynamoStore } from '@noy-db/to-aws-dynamo'\n// import { o } from '@noy-db/on-oidc'\n`\n"
  const out = stripComments(src)
  assert.ok(out.includes("from '@noy-db/hub'"), 'the real import survives')
  assert.ok(!out.includes('to-aws-dynamo'), 'the scaffolded import is blanked')
  assert.ok(!out.includes('on-oidc'), 'and the commented-out one inside the template')
  assert.equal(out.length, src.length)
  assert.equal(out.split('\n').length, src.split('\n').length, 'line structure kept')
})

test('family#106: a specifier quoted inside an error STRING is prose', () => {
  const src = `throw new Error("pass shamirRecovery: shamirRecoveryProvider() from '@noy-db/on-shamir' to createNoydb()")\n`
  assert.ok(!stripComments(src).includes('on-shamir'))
})

test('CONTROL family#106: every whitespace-free string survives — a real specifier is never blanked', () => {
  const src = "import a from '@noy-db/a'\nexport * from \"@noy-db/b\"\nconst c = await import(`@noy-db/c`)\nconst d = require('@noy-db/d')\n"
  assert.equal(stripComments(src), src)
})
