# Node Platform Foundation

## Goal

This document records the TypeScript/Node foundation that now backs the active runtime.

- baseline: **Node 24 LTS primary**, with **Node 22.13+ LTS compatibility**
- source of truth: **`src/**/*.ts`**
- executed runtime: **`dist/src/**/*.js`** (or staged **`.node-build/src/**/*.js`** in test fixtures)
- public router: generated **`bin/garda.js`** compiled from **`src/bin/garda.ts`**
- validation and gate logic run through the same Node runtime

## Source Layout

| Path | Role |
|---|---|
| `src/bin/garda.ts` | TypeScript source for the generated public CLI launcher |
| `src/cli/index.ts` | Foundation descriptor for the active Node runtime |
| `src/core/*.ts` | Shared constants, fs/path helpers, template utilities |
| `src/materialization/*.ts` | Install/init materialization logic |
| `src/lifecycle/*.ts` | Bootstrap, install, reinit, update, uninstall flows |
| `src/validators/*.ts` | Status, verify, doctor, manifest validation |
| `src/gates/*/*.ts` | Gate implementations and task-event summaries organized by domain |
| `src/gate-runtime/*.ts` | Shared gate runtime helpers |
| `tests/node/**` | Node-native unit and integration coverage |
| `scripts/node-foundation/*.ts` | Repository-only build/test harness for staged `.node-build/` output |
| `tsconfig.json` | Editor-facing entrypoint |
| `tsconfig.node-foundation.json` | Tooling contract for the Node foundation |

## Execution Model

- `src/**/*.ts` is the strict TypeScript source of truth; it is compiled before execution.
- `src/bin/garda.ts` compiles into the public `bin/garda.js` launcher; under `node_modules` it behaves as a thin router that prefers a local workspace/source launcher when one exists, and otherwise executes compiled JavaScript from `dist/src/**/*.js` or staged `.node-build/src/**/*.js`.
- `scripts/node-foundation/build.ts` produces `.node-build/` for staged contract tests, `dist/` for the published-package runtime, and syncs the generated `bin/garda.js` launcher from compiled TypeScript output.
- Direct execution of raw `.ts` files is no longer part of the supported runtime.

## Validator Strategy

Validation stays in-repo and TypeScript-first:

- init-answer validation
- managed config validation
- workspace layout checks
- manifest duplicate detection
- doctor and verify aggregation

## Build and Test

### `npm run build`

Compiles the lightweight helper graph (`src/bin/**/*.ts` plus `scripts/node-foundation/**/*.ts`) into `.scripts-build/`, then publishes compiled runtime artifacts into `dist/`.

This command does not certify direct `node --test .node-build/...` consumers. Those tests depend on the staged `.node-build/` graph, not only on `dist/`.

### `npm test`

Compiles the lightweight helper graph into `.scripts-build/`, rebuilds the wider staged `.node-build/` graph from `tsconfig.tests.json`, and executes the compiled `tests/node/**/*.test.js` suite.

When an operator needs to run direct compiled tests from `.node-build/`, the producer-consumer chain must stay sequential: refresh `.node-build/` first with `npm run build:node-foundation` or `npm test`, then run the direct `node --test .node-build/...` consumer. The runtime now blocks stale or concurrently-written `.node-build/` consumers instead of letting them run against untrusted artifacts.

### `npm run validate:release`

Runs the explicit release proof path:

1. `npm run validate:clean-worktree`
2. `npm run validate:version-parity`
3. `npm run build`
4. `npm run validate:embedded-bundle-parity`
5. `npm run quality`
6. compiled `tests/node/packaging/pack-smoke.test.js`, which performs `npm pack -> npm install <tarball> -> CLI invoke`
7. `npm run validate:clean-worktree`

`npm run validate:clean-worktree` fails closed when the repository cannot prove a Git `HEAD`, branch/status state, or clean tracked/untracked worktree. Clean detached `HEAD` states are allowed for reproducible CI/package checks, but dirty tracked files and untracked files block release handoff.

`npm run validate:embedded-bundle-parity` treats the nested `garda-agent-orchestrator/` checkout bundle as a generated artifact. If it is omitted or gitignored, the release check records that state as valid because it is not part of the release surface; if it is present and not gitignored, the check compares root and bundle tree hashes for the release sync surface, including source, compiled `dist`, templates, package metadata, and runtime-referenced docs.

`npm run quality` composes `typecheck`, `typecheck:unused`, `lint`, threshold-enforced `coverage`, and `audit:prod`; `npm run quality:fast` uses the same `typecheck:unused` enforcement before fast coverage. `npm run typecheck:unused` runs `tsc -p tsconfig.node-foundation.json --noEmit --pretty false --noUnusedLocals --noUnusedParameters`, so unused imports, locals, parameters, and types cannot accumulate while ordinary `typecheck` remains focused on the project tsconfig defaults. Coverage reports use the repository `c8` configuration so maintained source boundaries are measured; `all=true` keeps unexecuted maintained source visible in the report, while conservative global floors (35% statements/functions/lines and 55% branches) fail material regressions and leave room for later ratcheting. The test build emits source maps for the staged `.node-build/src` and `.node-build/scripts/node-foundation` execution projection. Generated and retained trees such as `dist`, `.node-build/tests`, `.scripts-build`, `coverage`, deployed runtime artifacts, `node_modules`, and tests are excluded from the reported surface. The release-validation matrix uploads each leg's `coverage/lcov.info`, including failed threshold runs when the report was produced. Packaging smoke is intentionally outside `npm test`, `npm run test:sharded`, `npm run test:full`, and coverage; run it explicitly with `npm run test:packaging`. This keeps the release contract explicit: the shipped package must build, typecheck, pass unused-symbol enforcement, lint, pass the regular runtime suite under coverage collection, pass production dependency audit, pack from a clean tree, install, execute from the packaged runtime, and leave the release tree clean.

Release handoff archives are split by purpose. `npm run archive:source` writes a deterministic tracked-source tar that excludes generated/local trees including dependency installs, coverage output, staged builds, package runtime output, and Garda runtime state. `npm run archive:evidence` writes a separate allow-listed proof tar for runtime reports, task events, final review artifacts, project-memory evidence, manual-validation logs, metrics, and coverage output, while excluding generated reviewer launch/context support artifacts, skipping known secret or credential paths, and failing closed on credential-like text evidence content. These commands do not alter npm package `files`; package contents remain governed by `npm pack` and release validation.

Direct `npm pack` and `npm pack --dry-run` are guarded by `prepack`, which runs the same clean-worktree preflight before package preparation and again after `build:publish-runtime`.

### Tag-driven npm staged publishing

The npm release path is `.github/workflows/publish.yml`, triggered by `v*` tags. The workflow runs a pre-stage `validate` job on GitHub-hosted Ubuntu with Node 24, checks the tag against package metadata and `VERSION`, runs `npm ci`, runs `npm run release:preflight`, and records `npm pack --dry-run` output.

The `publish` job depends on validation and targets the GitHub Environment `npm-release`. The environment should be restricted to selected release tags matching `v*`, and the same environment name must be configured on the npm Trusted Publisher entry. GitHub required reviewers are optional for this solo-maintainer flow; the human approval step is npm staged approval with maintainer 2FA after CI stages the package. The job uses npm Trusted Publishing with OIDC through `permissions: contents: read, id-token: write`, `actions/setup-node@v6` registry configuration, cache disabled for the release build, an explicit npm CLI `11.15.0+` upgrade for `npm stage`, a final release proof rerun, and plain `npm stage publish`. Do not add long-lived npm publish tokens to this workflow. Trusted Publishing for public GitHub Actions packages automatically generates npm provenance when the registry accepts the staged publish and the package is approved.

### `npm run release:preflight`

Runs the final operator-facing release readiness gate before the expensive release validation path:

1. `npm run validate:release-readiness`
2. `npm run test:release-smoke`
3. `npm run validate:release`

`npm run validate:release-readiness` is a short checklist gate. It verifies static alignment for package scripts, shipped package files, production audit wiring, CI release validation, lifecycle update smoke wiring, runtime-state documentation, manifest validation guidance, security document package/manifest surface, the tag-driven npm Trusted Publishing workflow/docs, and the tracked `docs/release-readiness.md` checklist before the release is cut. `npm run test:release-smoke` then exercises high-signal runtime contracts for task id parsing, task-event append integrity, next-step startup routing, and status/doctor formatting. It intentionally does not replace `npm run validate:release`; the latter remains the build/test/pack/install proof and includes `npm run test:packaging` for package smoke coverage.

Copy-paste slow smoke command:

```text
npm run test:packaging
```

### GitHub Actions CI

Repository CI mirrors the same contract in `.github/workflows/ci.yml`:

1. `npm run typecheck`
2. `npm run lint`
3. focused Node foundation test jobs for unit, gates, CLI, lifecycle, and binary/materialization coverage (runs on Node 22.13+ and Node 24)
4. gate and CLI test jobs use `GARDA_NODE_FOUNDATION_TEST_SHARDS=2` for parallel file execution while preserving fail-closed aggregate results
5. `npm run validate:release:fast` on Linux and Windows
6. cross-platform lifecycle smoke on Linux, macOS, and Windows (Node 22.13+ and Node 24)

Local release proof remains stricter than the CI fast release matrix:

1. `npm run release:preflight`
2. `npm run validate:release-readiness`
3. `npm run test:release-smoke`
4. `npm run validate:release`

Full-suite optimization compatibility guardrails:

- Do not replace mandatory full-suite validation with focused shards, smoke tests, or `validate:release:fast`; optimized modes may only change how equivalent full-suite evidence is produced and aggregated.
- The optimized local command is copy-paste safe as `npm run test:sharded`; it still runs the mandatory full-suite selection, emits shard logs, duration telemetry, and a fail-closed aggregate result. Use `npm test` as the standard fallback when validating without the optimized runner.
- Workflow output and `next-step` label optimized commands as `optimized_sharded` or reuse-aware full-suite modes; those labels describe execution strategy only, not weaker validation.
- Do not depend on ignored local runtime state, `.node-build/` leftovers, duration history, or machine-local cache state for CI/release correctness. Every official CI job starts from checkout, `npm ci`, and an explicit build/test command.
- Keep optimized test execution cross-platform for Linux, Windows, and macOS. Shell snippets used in CI must stay portable or be explicitly scoped with a compatible shell.
- Keep failure forensics useful: shard runners and full-suite validation must preserve enough logs, failing test identity, duration, command, and aggregate exit status for release triage.
- Any command migration must leave `npm run release:preflight` and `npm run validate:release` as the operator-facing final proof path unless release-readiness validation and docs are updated in the same change.

The lifecycle smoke installs from a `file://` clone of the current workflow branch, not implicitly from the repository default branch. That keeps pull-request and branch runs aligned with the code under test.

### Node 22 Compatibility Contract

Node 22.13+ is an official Garda 1.4.x compatibility runtime line. Node 24 remains the primary baseline, but the public runtime contract now requires every official support surface to include both Node 22.13+ and Node 24:

1. `package.json` engines allow `^22.13.0 || >=24.0.0`.
2. CI runs typecheck, full tests, release validation, and smoke coverage on Node 22.13+ and Node 24.
3. Runtime diagnostics and docs describe Node 22.13+ as supported and warn, rather than hard-block, when the current runtime is outside the tested support matrix.
4. TypeScript Node typings track the lower supported Node 22 line so Node 24-only APIs are not accidentally used.

Node 23, Node 22 versions before 22.13.0, and Node 20 or older remain outside the official support matrix. They are not CI/release-tested, but runtime version mismatch alone is warning-only.

## Current Runtime State

- `bin/garda.js` is a generated runtime launcher; the maintained source of truth lives in `src/bin/garda.ts`.
- Lifecycle commands and gates are Node-only.
- `TypeScript` means `strict:true` across runtime code, Node tests, and the repository build/test harness.
- Historical shell wrappers have been removed from the runtime surface.

## Repository Branch Note

- `master` and `dev` are the active heads for the current Node runtime line.
- `feat/node-runtime-migration` may still appear in clones or remotes as a historical alias that points to the same head; it is not a separate maintained runtime track.
