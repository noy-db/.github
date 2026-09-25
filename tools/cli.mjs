#!/usr/bin/env node
// family-tools <command> [--root path] [--config path] [--print]
//                        [--dry-run] [--tag t] [--registry url] [--names] [--version]
//
// The ONLY place in this package that prints or exits. Every gate module
// returns { failures } so a test can assert on the data instead of scraping
// stdout.
import { runChangelogCensus } from './src/release/changelog.mjs'
import { resolve } from 'node:path'
import { loadConfig, loadConfigFile } from './src/config.mjs'
import { runArchitecture } from './src/gates/architecture.mjs'
import { runVersionsUniform } from './src/gates/versions-uniform.mjs'
import { runDeclaredDeps } from './src/gates/declared-deps.mjs'
import { runCodemodRows } from './src/gates/codemod-rows.mjs'
import { runCheckLicense } from './src/gates/check-license.mjs'
import { runPeerFloor } from './src/gates/peer-floor.mjs'
import { runProseExamples } from './src/gates/prose-examples.mjs'
import { runChangesetNames } from './src/gates/changeset-names.mjs'
import { prepareSnapshot } from './src/snapshot/prepare.mjs'
import { snapshotReport } from './src/snapshot/report.mjs'
import { census, report as censusReport } from './src/release/census.mjs'

// A gate's failures are either {rule,msg,where} rows (architecture, which has
// several rules) or plain strings (the ported single-purpose checks, whose
// messages are already whole sentences). Formatted here rather than normalised
// at the source: dressing a ported message up as a `rule` would invent a rule
// name that appears nowhere in the repo it was ported from.
const line = (f) => (typeof f === 'string' ? f : `[${f.rule}] ${f.msg}${f.where ? ` (${f.where})` : ''}`)

const GATES = {
  architecture: { label: 'Architecture invariants', run: runArchitecture },
  'versions-uniform': { label: 'Version invariants', run: runVersionsUniform },
  'declared-deps': { label: 'Declared dependencies', run: runDeclaredDeps },
  'codemod-rows': { label: 'Codemod rows', run: runCodemodRows },
  'check-license': { label: 'Licence tier on disk', run: runCheckLicense },
  'prose-examples': { label: 'Shipped examples compile', run: runProseExamples },
  'changeset-names': { label: 'Pending changesets name real packages', run: runChangesetNames },
}

const COMMANDS = ['config', ...Object.keys(GATES), 'peer-floor', 'snapshot-prepare', 'snapshot-report', 'publish-census', 'changelog-census']

function parseArgs(argv) {
  const opts = {
    gate: undefined,
    root: process.cwd(),
    config: undefined,
    print: false,
    dryRun: false,
    names: false,
    version: false,
    tag: 'dev',
    registry: 'https://npm.pkg.github.com',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') opts.root = argv[++i]
    else if (a === '--config') opts.config = argv[++i]
    else if (a === '--tag') opts.tag = argv[++i]
    else if (a === '--registry') opts.registry = argv[++i]
    else if (a === '--print') opts.print = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--names') opts.names = true
    else if (a === '--version') opts.version = true
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (opts.gate === undefined) opts.gate = a
    else throw new Error(`unexpected argument ${a}`)
  }
  // A trailing value option reads past the end of argv; report it as a usage
  // error rather than letting resolve(undefined) throw a TypeError.
  for (const [flag, key] of [['--root', 'root'], ['--config', 'config'], ['--tag', 'tag'], ['--registry', 'registry']])
    if (argv.includes(flag) && opts[key] === undefined) throw new Error(`${flag} needs a value`)
  return opts
}

// ⚠️ THE PIPE TRAP, in the help because it is where someone looks after being
// confused by it. `family-tools <gate> … | head` reports `$?` from HEAD, not
// from the gate: `as` nearly filed a FAILING prose run as passing on its first
// look, and `to` recorded the same shape on 2026-09-11. The summary line below
// (`✓ … OK` / `✗ … FAILED (n)`) exists so the eye never needs `$?` — but a
// pipe can also truncate that line away, which is exactly how it bites.
const usage = () =>
  `usage: family-tools <${COMMANDS.join('|')}> [--root path] [--config path] [--print]\n` +
  `                    [--dry-run] [--tag t] [--registry url] [--names] [--version]\n` +
  `\n` +
  `⚠️  Do NOT pipe this command when you care about its exit code — \`… | head\`\n` +
  `    gives you head's status, not the gate's. Redirect to a file and read the\n` +
  `    final summary line, or check \${PIPESTATUS[0]}.`

function report(label, failures, scope) {
  for (const f of failures) console.error(`✗ ${line(f)}`)
  if (failures.length > 0) {
    console.error(`\n✗ ${label} FAILED (${failures.length})`)
    return 1
  }
  // ⭐ A green STATES ITS SCOPE (noy-db/.github#23). Without this, a gate that
  // checked 40 packages and one that checked 0 print the same tick — which is
  // how four gates passed vacuously on an empty tree for their whole lives.
  console.log(`✓ ${label} OK${scope ? ` — ${scope}` : ''}`)
  return 0
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.gate === undefined) {
    console.error(usage())
    return 2
  }
  const root = resolve(opts.root)
  // --config names the config FILE and is read verbatim; without it the config
  // is family.config.json inside --root.
  const cfg = opts.config ? loadConfigFile(resolve(opts.config)) : loadConfig(root)

  // `config` is not a gate — it loads, validates, and (with --print) emits the
  // resolved config as JSON for Task 4's composite action to read.
  if (opts.gate === 'config') {
    if (opts.print) console.log(JSON.stringify(cfg, null, 2))
    else console.log('✓ family.config.json OK')
    return 0
  }

  // peer-floor is not in schema.json's `gates` enum on purpose: it needs the
  // network and runs as its own CI job, never in the gates sweep.
  if (opts.gate === 'peer-floor') {
    const { failures } = runPeerFloor(root, cfg, { dryRun: opts.dryRun, log: (s) => console.log(s) })
    return report('Peer floors', failures)
  }

  if (opts.gate === 'snapshot-prepare') {
    console.log(JSON.stringify(prepareSnapshot(root, cfg, { tag: opts.tag, registry: opts.registry }), null, 2))
    return 0
  }

  if (opts.gate === 'snapshot-report') {
    for (const l of snapshotReport(root, cfg, { names: opts.names, version: opts.version })) console.log(l)
    return 0
  }

  // ⛔ Runs AFTER `changeset publish`, and asks the registry rather than the
  // publisher. core's v0.8.0 run went green having published 34 of 36 — hub
  // among the two it claimed and did not deliver. See src/release/census.mjs.
  if (opts.gate === 'publish-census') {
    const names = snapshotReport(root, cfg, { names: true })
      .join('\n')
      .split(/\s+/)
      .filter(Boolean)
    const [version] = snapshotReport(root, cfg, { version: true })
    if (names.length === 0) {
      console.log('[census] nothing published — no names to check')
      return 0
    }
    const result = await census(names, String(version).trim())
    return censusReport(result)
  }

  // ⛔ Per PUBLISHABLE PACKAGE, not per file. The YAML grep it replaces was
  // existential over the repo (one heading satisfied 36 packages) and blind to
  // a package with no CHANGELOG.md. See src/release/changelog.mjs.
  if (opts.gate === 'changelog-census') {
    const [version] = snapshotReport(root, cfg, { version: true })
    const { failures, checked } = runChangelogCensus(root, cfg, String(version).trim())
    if (failures.length === 0) { console.log(`✓ CHANGELOG ${String(version).trim()} section present with content in ${checked}/${checked} publishable packages`); return 0 }
    for (const f of failures) console.error(`✗ ${f}`)
    console.error(`✗ CHANGELOG census FAILED (${failures.length} of ${checked})`)
    return 1
  }

  const entry = GATES[opts.gate]
  if (!entry) {
    console.error(`unknown gate "${opts.gate}"\n${usage()}`)
    return 2
  }

  const res = entry.run(root, cfg)
  const { failures, status } = res
  // `no-hub` is NOT a violation. codemod-rows reads its maps from the installed
  // @noy-db/hub, so an unresolvable hub means the gate could not run — exit 2,
  // distinct from the exit 1 that means a row is untrue. Collapsing the two
  // would let a missing install read as a clean gate.
  if (status === 'no-hub') {
    console.error('✗ cannot resolve @noy-db/hub — install dependencies first')
    return 2
  }
  // ⛔ SAME REASONING, GENERALISED. A gate that COULD NOT RUN is exit 2, never
  // the exit 0 of a clean pass: prose-examples reports this when it finds no
  // compiler, no built entry points, or zero blocks — each of which would
  // otherwise be a green run that examined nothing. The distinct code is what
  // stops a CI step reading "could not run" as "passed".
  if (status === 'cannot-run') {
    console.error(`✗ ${entry.label}: ${res.cannotRun}`)
    return 2
  }
  // Notes are NAMED, not counted, and printed whether or not the gate passes:
  // prose-examples uses them for blocks excluded as not-a-program, so the
  // exclusion cannot grow silently into a gate that checks nothing.
  for (const note of res.notes ?? []) console.log(`  ${note}`)
  return report(entry.label, failures, res.scope)
}

// `main` is async because publish-census polls the registry. Awaiting it here
// keeps the single exit point: a rejected promise must not become an unhandled
// rejection that exits 0 while reporting nothing.
try {
  process.exit(await main(process.argv.slice(2)))
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(2)
}
