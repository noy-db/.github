# `noy-db/.github`

Shared CI, snapshot, release, promote and docs-deploy workflows for the noy-db
family, plus the `@noy-db/family-tools` gates they run (`tools/`).

This repo is **public**, and that is load-bearing: `setup-family` checks it out
with the caller's `GITHUB_TOKEN`, which cannot read a private sibling repo.

Everything a member repo's CI does is decided by that repo's
`family.config.json` — see `tools/schema.json` for the full schema.

## The caller shape

Every caller is a thin file whose body is in `templates/<name>-caller.yml`;
copy the template, drop its first line. `ci.yml` everywhere; `peer-floor.yml`
wherever the repo binds a seam; `snapshot.yml` and `prune-snapshots.yml` in
every **publishing** repo — the pair goes together, since prune only ever
deletes what snapshot published; `release.yml` and `promote.yml` in every repo
that publishes to **public** npm (`publicRelease` not `false` — lobby has the
first pair and not the second) — another pair, since promote only ever moves a
dist-tag onto what release published. `nightly.yml` wherever the wider Node
matrix should still run. The snippets below are the templates verbatim, and
`tools/test/internal-refs.test.mjs` fails if one drifts from its template or
names a tag other than the one `setup-family` checks out.

```yaml
# .github/workflows/ci.yml
# Thin caller. The workflow itself lives once, in noy-db/.github.
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  ci:
    uses: noy-db/.github/.github/workflows/ci.yml@v2
    secrets: inherit
```

```yaml
# .github/workflows/snapshot.yml   — repos with publishes: true
# Thin caller. Copied only into repos whose family.config.json has publishes: true.
name: snapshot

on:
  workflow_dispatch: {}
  push:
    branches: [main]

jobs:
  snapshot:
    uses: noy-db/.github/.github/workflows/snapshot.yml@v2
    permissions:
      contents: read
      packages: write
```

```yaml
# .github/workflows/peer-floor.yml   — repos whose family.config.json `binds` is not null
# Thin caller. Replaces each repo's own peer-floor workflow.
name: peer-floor

on:
  workflow_dispatch:
  schedule:
    - cron: '0 6 * * 1'

jobs:
  peer-floor:
    uses: noy-db/.github/.github/workflows/peer-floor.yml@v2
```

```yaml
# .github/workflows/prune-snapshots.yml   — repos with publishes: true
# Thin caller. Copied only into repos whose family.config.json has publishes: true.
# Same Monday slot as peer-floor, an hour later: peer-floor watches ranges,
# this one only ever deletes `0.0.0-dev-*` versions this repo published.
name: prune-snapshots

on:
  workflow_dispatch:
  schedule:
    - cron: '0 7 * * 1'

jobs:
  prune:
    # A called workflow can only REDUCE the caller's token, never elevate it,
    # so `packages: write` has to be granted here.
    uses: noy-db/.github/.github/workflows/prune-snapshots.yml@v2
    permissions:
      contents: read
      packages: write
    with:
      keep: 20
```

⚠️ Prune is a **separate caller, not a job inside `peer-floor.yml`** — its gate is
`publishes`, not `binds`. noy-db core publishes and binds nothing, so a prune job
riding on the peer-floor caller would never run for the biggest publisher in the
family.

```yaml
# .github/workflows/release.yml   — repos publishing to public npm
# Fires ONLY when a human publishes a GitHub Release. The tag IS the version.
name: Release
on:
  release:
    types: [published]
permissions:
  contents: read
  id-token: write
  # verify reads snapshot.yml's runs; a reusable workflow's token is capped by
  # its caller's grants, so this is needed here too, not only in .github.
  actions: read
jobs:
  release:
    uses: noy-db/.github/.github/workflows/release.yml@v2
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

```yaml
# .github/workflows/promote.yml   — repos publishing to public npm
# Thin caller. Moves a dist-tag onto an already-published version for every
# publishable package here.
#
# ⛔ The rail refuses unless EVERY name already carries the version, because a
# partial move splits the line across two versions under one dist-tag — and the
# half that moved is the half a bare `npm install` serves.
name: promote

on:
  workflow_dispatch:
    inputs:
      version:
        description: The already-published version to point the dist-tag at.
        required: true
      tag:
        description: Git tag whose tree lists the packages. Blank = v<version>.
        required: false
        default: ''
      dist_tag:
        description: Which dist-tag to move.
        required: false
        default: latest
      dry_run:
        description: Print what would move and write nothing.
        type: boolean
        default: false

jobs:
  promote:
    uses: noy-db/.github/.github/workflows/promote.yml@v2
    with:
      version: ${{ inputs.version }}
      tag: ${{ inputs.tag }}
      dist_tag: ${{ inputs.dist_tag }}
      # ⚠️ Deliberately tolerant of BOTH shapes. A workflow_dispatch boolean
      # reaches `inputs` as a real boolean, but stringifies through some contexts,
      # and a bare `== 'true'` would make dry_run silently never fire — a flag that
      # quietly does nothing is worse than no flag.
      dry_run: ${{ inputs.dry_run == true || inputs.dry_run == 'true' }}
    secrets: inherit
```

```yaml
# .github/workflows/nightly.yml   — the full Node matrix, once a day
#
# ⭐ THIS IS THE OTHER HALF OF THE CI TRIM (2026-09-13). The per-push run was
# narrowed to a single Node major to keep the develop-and-bounce loop fast while
# `@dev` is the family's only release surface. That trade is only honest if the
# wider matrix still runs somewhere.
#
# ⛔ A repo that trims the push matrix and does NOT adopt this caller has simply
# stopped testing Node 24. That is a decision someone may make, but it must be
# made out loud — not arrived at by copying half a change.
#
# Runs at 03:17 UTC: off the hour, because scheduled jobs bunch on :00 and
# GitHub delays them under load. Nothing here publishes or tags.
name: nightly

on:
  schedule:
    - cron: '17 3 * * *'
  # Kept so the matrix can be exercised on demand before a cut, rather than
  # waiting a day to learn whether the wider matrix still passes.
  workflow_dispatch: {}

jobs:
  ci:
    uses: noy-db/.github/.github/workflows/ci.yml@v2
    with:
      node-matrix: '["22","24"]'
    secrets: inherit
```

`v2` is a **moving tag**. A change here is validated by moving `v2`; no caller
pins a branch, and `setup-family` hardcodes `v2` for the tools checkout so a
workflow and the tools it runs can never come from different revisions.
`tools/test/internal-refs.test.mjs` asserts every live self-reference in this
repo — the workflows, the templates and the README snippets above — names that
same tag, because a partial bump is a green run of the wrong code.

## What's here

### `actions/setup-family`

Checks out the caller, checks out this repo at `v2` into `.family-tools`,
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
`layout`, `manager`, `binds`, `publishes`, `publicRelease`, `scriptTest`,
`scriptLint`, `scriptTypecheck` (strings) and `gates`, `localChecks` (JSON
array strings, for `fromJSON`). `binds` is the
literal string `null` when the repo binds no seam. `publicRelease` is `'true'`
unless the config says `false` — whether artefacts may go to **public** npm,
independent of `publishes` (lobby: `publishes: true`, `publicRelease: false` —
it cuts `@dev` snapshots and nothing else).

### `.github/workflows/ci.yml`

`config` → `build` → `test`, `gates` (one job per gate in `gates`,
`fail-fast: false`), `local-checks` (the repo's own commands), and
`lint-typecheck`. The test matrix is the `node-matrix` input, default
`["22"]`; the nightly caller passes `["22","24"]`, and a repo without it has
stopped testing Node 24. Every job re-runs setup and the build; nothing is
passed between them as an artifact. `build` is `<manager> run --if-present
build` (noy-db-docs defines none). **`test`, `lint` and `typecheck` are
required** (family#142): they run without `--if-present`, so a renamed or
deleted script is a red build, never a silent green. A repo that genuinely has
none of one declares it off in its own `family.config.json`:

```json
"scripts": { "test": true, "lint": false, "typecheck": true }
```

Absent means all three required; `false` skips that step. Measured 2026-10-12:
every member defines all three, so no repo needs the key today.

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

### `.github/workflows/release.yml`

Publishes every publishable package at its manifest version to **public npm
under `next`**. The caller fires only on `release: [published]` — a GitHub
Release a human publishes — and the tag is the version. Jobs:

1. `config` reads `family.config.json`. A repo with `publicRelease: false`
   routes to `refused`, a job that fails loudly and publishes nothing.
2. `verify`: the same commit has a green `snapshot.yml` run (`actions: read`
   is what lets it ask), the tree is not in changesets pre mode, the line is
   uniform and its licence ships, the Release tag equals the manifest version,
   and every publishable package's CHANGELOG has a section for it.
3. `peer-floor`: every package compiles against the oldest version its peers
   admit — in the release path, because a check that is not here cannot gate
   a release.
4. `publish`, behind the `release` **environment**: its required reviewer is
   the "never publish without the user's word" rule as a gate, set in
   repository settings where a silo cannot edit it. `changeset publish --tag
   next --no-git-tag` with the org `NPM_TOKEN`, then a summary that runs even
   on failure, then a census that asks the registry whether it gained every
   version the publisher claimed.

Provenance is off (npm rejects it for a private source repo); the publish job
alone keeps `id-token: write` so the flip is one line. Every other job holds
only what it uses.

### `.github/workflows/promote.yml`

Moves a dist-tag (`latest` unless told otherwise) onto an already-published
version, for every publishable name in the calling repo. Inputs: `version`,
`tag` (the git tag whose tree lists the packages; blank means `v<version>`),
`dist_tag`, `dry_run`. The names come from the **tag**, the logic from `@v2`,
so a tag cut before the caller existed can still be promoted. The inputs are
validated before the first network call and reach the shell only through the
environment. It refuses unless **every** name already carries the version — a
partial move splits the line across two versions under one tag — and reads the
tag back from the registry afterwards. Deliberately not behind the `release`
environment: a dist-tag move is reversible, a publish is not.

### `.github/workflows/peer-floor.yml`

`cli.mjs peer-floor --root .` — does every package still *compile* against the
oldest `@noy-db/*` version its peer ranges admit? It installs from the network
and rewrites the tree, so it is its own scheduled workflow and not a CI gate.
It also runs as a job in `release.yml`, where the property has to hold.

### `.github/workflows/prune-snapshots.yml`

Deletes `0.0.0-dev-*` versions beyond `keep` (default 20) per package. Inputs:
`keep`, `dry-run`. A version whose name does not match `^0\.0\.0-dev-` is never
deleted — asserted immediately before the `DELETE`, not assumed. With the
caller's `GITHUB_TOKEN` it only sees packages the calling repo owns, which is
the intended scope: each publishing repo prunes its own.

### `.github/workflows/docs-deploy.yml`

noy-db/docs only. Builds `apps/docs` twice (`DOCS_TIER=public` and
`internal`), syncs each to its S3 bucket and invalidates its CloudFront
distribution. Credentials are GitHub's OIDC token exchanged for one AWS role
whose trust policy admits only that repo on `main` — so the caller grants
`id-token: write`, and no stored AWS key exists anywhere in the family. The
caller fires on `workflow_run` of `ci` and checks its conclusion, so a red
gate no longer ships.

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
| 4 | `peer-floor` is its own weekly/dispatch workflow and a `release.yml` job, not a ci gate | it needs the network and rewrites the tree |
| 5 | Unscoped packages (`create-noy-db`) are privatised in the runner | GitHub Packages accepts scoped names only |
| 6 | `.changeset/pre.json` is deleted in the runner | changesets refuses a snapshot while in pre mode |

## Working on this repo

```bash
cd tools && npm install && npm test
```

Never `node --test test/` bare — the suite needs `semver` installed, and a
stale `node_modules` is what makes the bare form look like it works.
