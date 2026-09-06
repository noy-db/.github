#!/usr/bin/env node
// family-tools <command> [--root path] [--config path] [--print]
//                        [--dry-run] [--tag t] [--registry url] [--names]
//
// The ONLY place in this package that prints or exits. Every gate module
// returns { failures } so a test can assert on the data instead of scraping
// stdout.
import { resolve } from 'node:path'
import { loadConfig, loadConfigFile } from './src/config.mjs'
import { runArchitecture } from './src/gates/architecture.mjs'
import { runVersionsUniform } from './src/gates/versions-uniform.mjs'
import { runDeclaredDeps } from './src/gates/declared-deps.mjs'
import { runCodemodRows } from './src/gates/codemod-rows.mjs'
import { runPeerFloor } from './src/gates/peer-floor.mjs'
import { prepareSnapshot } from './src/snapshot/prepare.mjs'
import { snapshotReport } from './src/snapshot/report.mjs'

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
}

const COMMANDS = ['config', ...Object.keys(GATES), 'peer-floor', 'snapshot-prepare', 'snapshot-report']

function parseArgs(argv) {
  const opts = {
    gate: undefined,
    root: process.cwd(),
    config: undefined,
    print: false,
    dryRun: false,
    names: false,
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

const usage = () =>
  `usage: family-tools <${COMMANDS.join('|')}> [--root path] [--config path] [--print]\n` +
  `                    [--dry-run] [--tag t] [--registry url] [--names]`

function report(label, failures) {
  for (const f of failures) console.error(`✗ ${line(f)}`)
  if (failures.length > 0) {
    console.error(`\n✗ ${label} FAILED (${failures.length})`)
    return 1
  }
  console.log(`✓ ${label} OK`)
  return 0
}

function main(argv) {
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
    for (const l of snapshotReport(root, cfg, { names: opts.names })) console.log(l)
    return 0
  }

  const entry = GATES[opts.gate]
  if (!entry) {
    console.error(`unknown gate "${opts.gate}"\n${usage()}`)
    return 2
  }

  const { failures, status } = entry.run(root, cfg)
  // `no-hub` is NOT a violation. codemod-rows reads its maps from the installed
  // @noy-db/hub, so an unresolvable hub means the gate could not run — exit 2,
  // distinct from the exit 1 that means a row is untrue. Collapsing the two
  // would let a missing install read as a clean gate.
  if (status === 'no-hub') {
    console.error('✗ cannot resolve @noy-db/hub — install dependencies first')
    return 2
  }
  return report(entry.label, failures)
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(2)
}
