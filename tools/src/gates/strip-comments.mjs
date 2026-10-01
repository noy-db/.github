// stripComments — blank out COMMENT spans before a specifier scan, leaving code
// and string bodies byte-for-byte intact.
//
// ⛔ WHY THIS EXISTS. `declared-deps` matched `import("peer")` inside a LINE
// COMMENT in noy-db/to's `bundle-size.test.ts`:
//
//     // Static (`from "peer"`) or dynamic (`import("peer")`) — this package
//
// and reported `uses "peer" but does not declare it` for two packages. There is no
// package named `peer`; those files import only `vitest` and three `node:`
// builtins. The false rows blocked enabling the gate on the family's LARGEST
// publisher (19 packages) — exactly where an undeclared dependency is least
// visible — and they landed on the one test whose whole purpose is asserting that
// declared peers stay external. family#64.
//
// ⛔ It cannot be fixed by editing the comment. The comment is correct and
// load-bearing, and the next correct comment re-breaks the gate. Prose ABOUT
// import syntax is a normal thing to write in a file about imports.
//
// ── Why a state machine, and why strings are KEPT ────────────────────────────
//
// A regex cannot tell `//` in code from `//` inside `'https://x'` — strip the
// latter and the rest of a real line disappears. This walks the text once,
// tracking which construct it is inside.
//
// String bodies are deliberately PRESERVED: the scanners' whole job is to read a
// specifier out of a quoted string, so blanking those would leave the gate seeing
// `import("")` everywhere and reporting nothing — a gate that passes everything,
// which is worse than one that over-fires. A specifier hidden in prose is
// excluded because prose is a comment, not because it is quoted.
//
// ⭐ EXCEPT a string whose body contains WHITESPACE (family#106, 2026-10-02). A
// module specifier never contains whitespace, so such a string cannot be one —
// but it can CONTAIN import syntax as text, and core had six of them: cli's
// `config.ts` scaffolds a user's config file inside a template literal
// (`import { awsDynamoStore } from '@noy-db/to-aws-dynamo'`), and a hub error
// string tells the caller to pass `shamirRecoveryProvider() from
// '@noy-db/on-shamir'`. The package-seam rule reported all six as undeclared
// seams, and its remedy text ("add it to packageSeams and the family registry")
// would have recorded six couplings that do not exist. Those bodies are blanked;
// every whitespace-free string — every real specifier — is kept.
//
// Length, line count and every newline are preserved, so the `/gm` `^`-anchored
// scanners still see the right line structure.
//
// Not handled, deliberately: a regex literal containing an unescaped `//`, which
// cannot occur (`/a//b/` closes at the second slash), and JSX text.

const CODE = 0
const LINE = 1
const BLOCK = 2
const SQ = 3
const DQ = 4
const TPL = 5

/** The source with comment spans, and string bodies that contain whitespace, replaced by spaces. */
export function stripComments(src) {
  const out = Array.from(src)
  let state = CODE
  let start = -1 // index of the first character of the current string body
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === CODE) {
      if (c === '/' && n === '/') { state = LINE; out[i] = ' '; out[i + 1] = ' '; i++; continue }
      if (c === '/' && n === '*') { state = BLOCK; out[i] = ' '; out[i + 1] = ' '; i++; continue }
      if (c === "'") state = SQ
      else if (c === '"') state = DQ
      else if (c === '`') state = TPL
      if (state !== CODE) start = i + 1
      continue
    }
    if (state === LINE) {
      if (c === '\n') state = CODE
      else out[i] = ' '
      continue
    }
    if (state === BLOCK) {
      if (c === '*' && n === '/') { state = CODE; out[i] = ' '; out[i + 1] = ' '; i++; continue }
      if (c !== '\n') out[i] = ' '
      continue
    }
    // inside a string — honour escapes so `'it\'s'` does not end early
    if (c === '\\') { i++; continue }
    // A '…' or "…" string cannot contain a raw newline in JS. Reaching one means
    // the scan entered a string that is not there (a stray quote after a `*/`),
    // so resynchronise at the line end rather than blank the next line.
    if (c === '\n' && (state === SQ || state === DQ)) { state = CODE; continue }
    if ((state === SQ && c === "'") || (state === DQ && c === '"') || (state === TPL && c === '`')) {
      state = CODE
      // A body with whitespace is prose or generated text, never a specifier.
      if (/\s/.test(src.slice(start, i))) for (let k = start; k < i; k++) if (src[k] !== '\n') out[k] = ' '
    }
  }
  return out.join('')
}
