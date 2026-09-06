// Loader + validator for `family.config.json`.
//
// Hand-rolled rather than ajv: the schema is a dozen keys of enums and this
// package is copied into CI for eleven repos, where one fewer transitive
// dependency is worth more than a general validator. `schema.json` sits beside
// this file for editors and reviewers; ⚠️ the two are kept in step BY HAND —
// change one, change the other.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONFIG_FILE = 'family.config.json'

const LAYOUTS = ['workspace', 'flat', 'single']
const MANAGERS = ['pnpm', 'npm']
const BINDS = [
  '@noy-db/hub/to',
  '@noy-db/hub/as',
  '@noy-db/hub/on',
  '@noy-db/hub/at',
  '@noy-db/hub/cargo',
  '@noy-db/hub/introspection',
  null,
]
const GATES = ['architecture', 'versions-uniform', 'declared-deps', 'codemod-rows']

const REQUIRED = ['layout', 'manager', 'binds', 'publishes', 'gates']
const OPTIONAL = ['localChecks', 'exempt', 'conformanceKit']

const show = (v) => (v === null ? 'null' : JSON.stringify(v))
const oneOf = (values) => values.map(show).join(', ')

function bad(msg) {
  throw new Error(`${CONFIG_FILE}: ${msg}`)
}

function checkEnum(key, value, values) {
  if (!values.includes(value)) bad(`${key} is ${show(value)}; expected one of ${oneOf(values)}.`)
}

function checkStringArray(key, value) {
  if (!Array.isArray(value)) bad(`${key} must be an array of strings.`)
  for (const item of value)
    if (typeof item !== 'string') bad(`${key} must be an array of strings; found ${show(item)}.`)
}

export function loadConfig(root) {
  const file = join(root, CONFIG_FILE)
  if (!existsSync(file)) throw new Error(`${CONFIG_FILE}: not found at ${root}`)

  let cfg
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    bad(`is not valid JSON — ${err.message}`)
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) bad('must be a JSON object.')

  for (const key of REQUIRED) if (!(key in cfg)) bad(`missing required key ${key}.`)
  for (const key of Object.keys(cfg))
    if (!REQUIRED.includes(key) && !OPTIONAL.includes(key))
      bad(`unknown key ${key}; allowed: ${[...REQUIRED, ...OPTIONAL].join(', ')}.`)

  checkEnum('layout', cfg.layout, LAYOUTS)
  checkEnum('manager', cfg.manager, MANAGERS)
  checkEnum('binds', cfg.binds, BINDS)
  if (typeof cfg.publishes !== 'boolean') bad(`publishes is ${show(cfg.publishes)}; expected a boolean.`)

  if (!Array.isArray(cfg.gates)) bad('gates must be an array.')
  for (const gate of cfg.gates)
    if (!GATES.includes(gate)) bad(`gates contains ${show(gate)}; expected one of ${oneOf(GATES)}.`)

  if ('localChecks' in cfg) checkStringArray('localChecks', cfg.localChecks)
  if ('exempt' in cfg) checkStringArray('exempt', cfg.exempt)
  if ('conformanceKit' in cfg && typeof cfg.conformanceKit !== 'string')
    bad(`conformanceKit is ${show(cfg.conformanceKit)}; expected a string.`)

  return {
    ...cfg,
    localChecks: cfg.localChecks ?? [],
    exempt: cfg.exempt ?? [],
    conformanceKit: cfg.conformanceKit ?? null,
  }
}
