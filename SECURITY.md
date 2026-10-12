# Security policy

This is the organisation default for every `noy-db` repository that does not carry its own
`SECURITY.md`.

## Reporting a vulnerability

Report it through GitHub private vulnerability reporting on the **affected repository**, not in a
public issue:

```
https://github.com/noy-db/<repo>/security/advisories/new
```

Which repository owns which package:

| Package | Repository |
|---|---|
| `@noy-db/hub` and the other core packages | `core` |
| `@noy-db/to-*` | `to` |
| `@noy-db/as-*` | `as` |
| `@noy-db/on-*` | `on` |
| `@noy-db/at-*` | `at` |
| `@noy-db/in-*` | `in` |
| `@noy-db/exclave-plain` | `capsule` |
| `@noy-db/ui`, `@noy-db/ui-*` | `ui` |

If you are unsure which repository applies, report on `core`.

Private vulnerability reporting is enabled on `core`, `to`, `as`, `on`, `at`, `in`, `capsule` and
`ui`. Reports are read and answered through the advisory thread.

## Supported versions

Measured on 2026-10-12 from `npm view @noy-db/hub dist-tags`:

| Line | Version | Supported |
|---|---|---|
| the current `@latest` line | `0.9.0` | yes |
| the current `@next` pre-release line | `0.10.0-pre.1` | yes |
| anything below `@latest` | — | no — deprecated on npm, receives no fixes |

Each release moves these two lines; the dist-tags on npm are the authority, not the numbers above.

## Scope

The `@noy-db/*` packages on public npm and the code in the `noy-db` repositories. Zero-knowledge is
the architecture's central property: a report that a backend, transport or export sees plaintext it
should not is in scope even when it is not exploitable on its own.
