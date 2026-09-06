# `noy-db/.github`

Shared CI, snapshot and release workflows for the noy-db family, plus the
`@noy-db/family-tools` gates they run (`tools/`).

This repo is **public**, and that is load-bearing: `setup-family` checks it out
with the caller's `GITHUB_TOKEN`, which cannot read a private sibling repo.

Everything a member repo's CI does is decided by that repo's
`family.config.json` — see `tools/schema.json` for the full schema.

## The caller shape

Up to four files in a member repo, about forty lines total. `ci.yml` everywhere;
`peer-floor.yml` wherever the repo binds a seam; `snapshot.yml` and
`prune-snapshots.yml` in every **publishing** repo — the pair goes together,
since prune only ever deletes what snapshot published.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  ci:
    uses: noy-db/.github/.github/workflows/ci.yml@v1
    secrets: inherit
```

```yaml
# .github/workflows/snapshot.yml
name: Snapshot
on:
  push: { branches: [main] }
  workflow_dispatch:
jobs:
  snapshot:
    # A called workflow can only REDUCE the caller's token, never elevate it —
    # so `packages: write` has to be granted here, not in the reusable workflow.
    permissions: { contents: read, packages: write }
    uses: noy-db/.github/.github/workflows/snapshot.yml@v1
    secrets: inherit
```

```yaml
# .github/workflows/peer-floor.yml   — repos whose family.config.json `binds` is not null
name: peer-floor
on:
  workflow_dispatch:
  schedule: [{ cron: '0 6 * * 1' }]
jobs:
  peer-floor:
    uses: noy-db/.github/.github/workflows/peer-floor.yml@v1
```

```yaml
# .github/workflows/prune-snapshots.yml   — repos with publishes: true
name: prune-snapshots
on:
  workflow_dispatch:
  schedule: [{ cron: '0 7 * * 1' }]
jobs:
  prune:
    # Same reason as above: the caller grants the token scope, and the reusable
    # workflow can only narrow what it is handed.
    permissions: { contents: read, packages: write }
    uses: noy-db/.github/.github/workflows/prune-snapshots.yml@v1
    with: { keep: 20 }
```

⚠️ Prune is a **separate caller, not a job inside `peer-floor.yml`** — its gate is
`publishes`, not `binds`. noy-db core publishes and binds nothing, so a prune job
riding on the peer-floor caller would never run for the biggest publisher in the
family.

`v1` is a **moving tag**. A change here is validated by moving `v1`; no caller
pins a branch, and `setup-family` hardcodes `v1` for the tools checkout so a
workflow and the tools it runs can never come from different revisions.

## What's here

### `actions/setup-family`

Checks out the caller, checks out this repo at `v1` into `.family-tools`,
installs Node and the caller's dependencies, and installs the tools' one
dependency (`semver`). Adds `/.family-tools/` to the caller's
`.git/info/exclude` so changesets' git checks never see it.

| input | default | meaning |
|---|---|---|
| `manager` | `pnpm` | `pnpm` → `pnpm install --frozen-lockfile`; `npm` → `npm ci` |
| `node-version` | `'22'` | Node major |
| `frozen` | `'true'` | `'false'` uses `--no-frozen-lockfile`, for a job that mutates the lockfile |
| `install` | `'true'` | `'false'` skips the caller's install *and* the pnpm setup — the config job needs only node and the tools |

Output `tools` is the CLI path (`.family-tools/tools/cli.mjs`). The pnpm store
is cached on `hashFiles('**/pnpm-lock.yaml')`.

### `actions/family-config`

Runs `cli.mjs config --root . --print` and exposes the config as outputs:
`layout`, `manager`, `binds`, `publishes` (strings) and `gates`, `localChecks`
(JSON array strings, for `fromJSON`). `binds` is the literal string `null` when
the repo binds no seam.

### `.github/workflows/ci.yml`

`config` → `build` → `test` (node 22 and 24), `gates` (one job per gate in
`gates`, `fail-fast: false`), `local-checks` (the repo's own commands), and
`lint-typecheck`. Every job re-runs setup and the build; nothing is passed
between them as an artifact. Every script invocation is
`<manager> run --if-present <script>`, so a repo without a `build` or `test`
script (noy-db-docs) is green rather than red.

No job may be made soft. A gate that cannot fail the build is not a gate.

### `.github/workflows/snapshot.yml`

Publishes `0.0.0-dev-<YYYYMMDDHHmmss>` of every publishable package to
`https://npm.pkg.github.com` under the `dev` dist-tag. A repo with
`publishes: false` gets a green no-op job.

All the manifest surgery happens **on the runner** and is thrown away with it:

1. `snapshot-prepare` deletes `.changeset/pre.json`, writes one changeset naming
   every publishable package, sets `publishConfig.registry`/`tag`, appends the
   dev clause to every `@noy-db/*` peer range, and privatises unscoped names.
2. `changeset version --snapshot dev`, then `changeset publish --tag dev
   --no-git-tag`.
3. `snapshot-report` writes `name@version` to the step summary, and the run
   re-resolves every published name from the registry.

Nothing is committed, and the repo's own dev pins stay exact **public**
versions.

### `.github/workflows/peer-floor.yml`

`cli.mjs peer-floor --root .` — does every package still *compile* against the
oldest `@noy-db/*` version its peer ranges admit? It installs from the network
and rewrites the tree, so it is its own scheduled workflow and not a CI gate.

### `.github/workflows/prune-snapshots.yml`

Deletes `0.0.0-dev-*` versions beyond `keep` (default 20) per package. Inputs:
`keep`, `dry-run`. A version whose name does not match `^0\.0\.0-dev-` is never
deleted — asserted immediately before the `DELETE`, not assumed. With the
caller's `GITHUB_TOKEN` it only sees packages the calling repo owns, which is
the intended scope: each publishing repo prunes its own.

### `.github/workflows/self-test.yml`

This repo's own CI: the tools' suite on node 22 and 24, the gates against every
fixture carrying an `expected.json`, and two properties this repo must not lose
(no raw registry write in any workflow; no soft gate in `ci.yml`).

## The snapshot version scheme

`0.0.0-dev-<YYYYMMDDHHmmss>` — changesets' default snapshot suffix is a UTC
datetime, not a commit sha — produced by `changeset version --snapshot dev` and
tagged `dev`. `0.0.0-*` sorts below every real release, so a snapshot can never win a
`^` range by accident, and the dev clause `>=0.0.0-dev-0 <0.0.1` that
`snapshot-prepare` appends to peer ranges admits snapshots **and nothing else**.

## Consuming the dev registry

The org's dev registry is **private**: org members with `read:packages` can read
it, nobody else can. In a consumer:

```
# .npmrc
@noy-db:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Export `GITHUB_TOKEN` from `gh auth token` — the token needs the
`read:packages` scope (`gh auth refresh -s read:packages` if it does not have
it). Do not commit that file in a family repo; see deviation 2.

### The surviving trap

> **Verify a dev build by installing its peers explicitly and WITHOUT
> `--legacy-peer-deps`.**

`--legacy-peer-deps` makes any peer conflict disappear, so an install that
needs it has proved nothing about the ranges — which is exactly the property
the dev clause exists to keep true. Installing only the package under test
proves nothing either: a peer that is never installed is never checked.

## Deviations from the specs

| # | Deviation | Why |
|---|---|---|
| 1 | `.github` is public and hosts family-tools under `tools/`, consumed by checkout | a member's `GITHUB_TOKEN` cannot read a private sibling repo or package without a PAT |
| 2 | No scoped `.npmrc` is committed in family repos; snapshots publish via `publishConfig.registry` written in the runner | member dev pins stay exact public versions — a committed registry line would silently redirect a normal install |
| 3 | The runner appends ` \|\| >=0.0.0-dev-0 <0.0.1` to every `@noy-db/*` peer range | so `hub@dev` and `as-xlsx@dev` install together without `--legacy-peer-deps` |
| 4 | `peer-floor` is its own weekly/dispatch workflow, not a ci gate | it needs the network and rewrites the tree |
| 5 | Unscoped packages (`create-noy-db`) are privatised in the runner | GitHub Packages accepts scoped names only |
| 6 | `.changeset/pre.json` is deleted in the runner | changesets refuses a snapshot while in pre mode |

## Working on this repo

```bash
cd tools && npm install && npm test
```

Never `node --test test/` bare — the suite needs `semver` installed, and a
stale `node_modules` is what makes the bare form look like it works.
