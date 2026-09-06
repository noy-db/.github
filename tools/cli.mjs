#!/usr/bin/env node
// family-tools <gate> [--root path] [--config path] [--print]
//
// The ONLY place in this package that prints or exits. Every gate module
// returns { failures } so a test can assert on the data instead of scraping
// stdout.
import { resolve } from 'node:path'
import { loadConfig, loadConfigFile } from './src/config.mjs'
import { runArchitecture } from './src/gates/architecture.mjs'

// Task 3 adds versions-uniform, declared-deps, codemod-rows, peer-floor,
// snapshot-prepare and snapshot-report as further rows here.
const GATES = {
  architecture: { label: 'Architecture invariants', run: runArchitecture },
}

function parseArgs(argv) {
  const opts = { gate: undefined, root: process.cwd(), config: undefined, print: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') opts.root = argv[++i]
    else if (a === '--config') opts.config = argv[++i]
    else if (a === '--print') opts.print = true
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (opts.gate === undefined) opts.gate = a
    else throw new Error(`unexpected argument ${a}`)
  }
  // A trailing `--root` / `--config` reads past the end of argv; report it as
  // a usage error rather than letting resolve(undefined) throw a TypeError.
  if (opts.root === undefined) throw new Error('--root needs a path')
  if (argv.includes('--config') && opts.config === undefined) throw new Error('--config needs a path')
  return opts
}

function usage() {
  return `usage: family-tools <${['config', ...Object.keys(GATES)].join('|')}> [--root path] [--config path] [--print]`
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

  const entry = GATES[opts.gate]
  if (!entry) {
    console.error(`unknown gate "${opts.gate}"\n${usage()}`)
    return 2
  }

  const { failures } = entry.run(root, cfg)
  for (const f of failures) console.error(`✗ [${f.rule}] ${f.msg}${f.where ? ` (${f.where})` : ''}`)
  if (failures.length > 0) {
    console.error(`\n✗ ${entry.label} FAILED (${failures.length})`)
    return 1
  }
  console.log(`✓ ${entry.label} OK`)
  return 0
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(2)
}
