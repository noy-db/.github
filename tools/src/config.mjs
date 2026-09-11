// Loader + validator for `family.config.json`.
//
// Hand-rolled rather than ajv: the schema is a dozen keys of enums and this
// package is copied into CI for eleven repos, where one fewer transitive
// dependency is worth more than a general validator.
//
// The VALIDATION LOGIC is hand-rolled; the ENUMS ARE NOT. Every allowed value,
// the required-key list and the optional-key list are read out of `schema.json`
// at load time, so the schema is the single source of truth and the two cannot
// drift. Adding a gate or a seam means editing schema.json only.
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const CONFIG_FILE = 'family.config.json'

const SCHEMA = JSON.parse(readFileSync(new URL('../schema.json', import.meta.url), 'utf8'))
const PROPS = SCHEMA.properties
const LAYOUTS = PROPS.layout.enum
const MANAGERS = PROPS.manager.enum
const BINDS = PROPS.binds.enum
const GATES = PROPS.gates.items.enum
const REQUIRED = SCHEMA.required
const OPTIONAL = Object.keys(PROPS).filter((k) => !REQUIRED.includes(k))

const show = (v) => (v === null ? 'null' : JSON.stringify(v))
const oneOf = (values) => values.map(show).join(', ')

function validate(cfg, label) {
  const bad = (msg) => {
    throw new Error(`${label}: ${msg}`)
  }
  const checkEnum = (key, value, values) => {
    if (!values.includes(value)) bad(`${key} is ${show(value)}; expected one of ${oneOf(values)}.`)
  }
  const checkStringArray = (key, value) => {
    if (!Array.isArray(value)) bad(`${key} must be an array of strings.`)
    for (const item of value)
      if (typeof item !== 'string') bad(`${key} must be an array of strings; found ${show(item)}.`)
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
  if (cfg.license !== undefined && !PROPS.license.enum.includes(cfg.license))
    bad(`license is ${show(cfg.license)}; expected one of ${oneOf(PROPS.license.enum)}.`)

  if ('localChecks' in cfg) checkStringArray('localChecks', cfg.localChecks)
  if ('exempt' in cfg) checkStringArray('exempt', cfg.exempt)
  if ('publicRelease' in cfg && typeof cfg.publicRelease !== 'boolean')
    bad(`publicRelease is ${show(cfg.publicRelease)}; expected a boolean.`)
  if ('allowHubRoot' in cfg && typeof cfg.allowHubRoot !== 'boolean')
    bad(`allowHubRoot is ${show(cfg.allowHubRoot)}; expected a boolean.`)
  if ('conformanceKit' in cfg && typeof cfg.conformanceKit !== 'string')
    bad(`conformanceKit is ${show(cfg.conformanceKit)}; expected a string.`)

  return {
    ...cfg,
    localChecks: cfg.localChecks ?? [],
    exempt: cfg.exempt ?? [],
    allowHubRoot: cfg.allowHubRoot ?? false,
    // Absent means public: the eight existing members change nothing. Only a
    // premium repo declares false, and that declaration lives in its tree.
    publicRelease: cfg.publicRelease ?? true,
    conformanceKit: cfg.conformanceKit ?? null,
  }
}

// Load EXACTLY this file. `--config path/to/x.json` must read x.json — an
// earlier version took the file's DIRECTORY and re-appended family.config.json,
// so a nonexistent --config path silently loaded a different, valid config and
// exited 0.
export function loadConfigFile(file) {
  const label = basename(file)
  if (!existsSync(file)) throw new Error(`${label}: not found at ${file}`)
  let cfg
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${label}: is not valid JSON — ${err.message}`)
  }
  return validate(cfg, label)
}

export const loadConfig = (root) => loadConfigFile(join(root, CONFIG_FILE))
