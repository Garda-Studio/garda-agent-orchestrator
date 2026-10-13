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

### Offline lifecycle fixtures and explicit npm network coverage

Default lifecycle tests use the tracked `tests/fixtures/npm/garda-agent-orchestrator-1.0.0.tgz`, verified against its adjacent SHA-512 integrity lock before installation. This preserves the real published legacy caller without requiring registry access or an existing npm cache. Each fixture clears inherited npm configuration and credentials, uses empty temporary user/global config files and an owned cache, enables npm offline mode, and points registry requests at an unavailable loopback endpoint. Cleanup restores the inherited environment.

Live acquisition of the exact published `garda-agent-orchestrator@1.0.0` package is an explicit lane:

```text
npm run test:lifecycle:network
```

This command enables `GARDA_NPM_NETWORK_TESTS=1` in its child runner and selects only the network acquisition test. It requires access to `https://registry.npmjs.org`, uses a fresh owned cache, disables lifecycle scripts and npm audit/funding requests, and does not reuse user credentials. Default `npm test` and `npm run test:lifecycle` skip this single network case while exercising the local legacy update path. Do not enable the network flag for an offline proof.

Clean-checkout integration for bundle ownership, deterministic process snapshots, runner-environment cleanup, and local npm acquisition uses the following exact selection after provisioning the locked development dependencies:

```text
node scripts/node-foundation/build-scripts.cjs test.js tests/node/bundle-source-fixtures.test.ts tests/node/validators/workspace-layout.test.ts tests/node/validators/status.test.ts tests/node/cli/commands/setup.test.ts tests/node/process-environment-fixtures.test.ts tests/node/gates/compile/full-suite-validation-run-marker.test.ts tests/node/gates/compile/full-suite-validation-cli-transaction.test.ts tests/node/repo/node-foundation-test-wrapper.test.ts tests/node/lifecycle/check-update-runtime-policy.test.ts
```

Start from a tracked checkout without `garda-agent-orchestrator/`, `dist/`, `.node-build/`, or `.scripts-build/`. Git, npm, and the supported Node runtime must be available; TypeScript and Node typings come from the locked development dependency installation. Dependency provisioning is separate from test package acquisition. The runner builds the required generated graphs before executing tests; test npm cache/config roots and bundle roots belong to individual fixtures.

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

`npm run validate:embedded-bundle-parity` inspects the nested `garda-agent-orchestrator/` generated bundle even when Git ignores it. The bundle must be an ordinary directory with a filesystem identity distinct from the repository root. The mandatory release check compares root and bundle tree hashes for the selected release sync surface, including source, compiled `dist`, templates, package metadata, and public documentation. A missing bundle, empty selection, linked or hard-linked input, changed path identity, missing file, or hash mismatch fails the check. An explicitly optional API check can report `SKIPPED` for an unavailable or ignored bundle; it never reports that skip as a pass. Setup, refresh, update, and rollback share a bounded list of public bundle assets, so they do not copy unrelated files from the source documentation directory.

`npm run quality` composes `typecheck`, `typecheck:unused`, `lint`, threshold-enforced `coverage`, and `audit:prod`; `npm run quality:fast` uses the same `typecheck:unused` enforcement before fast coverage. `npm run typecheck:unused` runs `tsc -p tsconfig.node-foundation.json --noEmit --pretty false --noUnusedLocals --noUnusedParameters`, so unused imports, locals, parameters, and types cannot accumulate while ordinary `typecheck` remains focused on the project tsconfig defaults. Coverage reports use the repository `c8` configuration so maintained source boundaries are measured; `all=true` keeps unexecuted maintained source visible in the report, while conservative global floors (35% statements/functions/lines and 55% branches) fail material regressions and leave room for later ratcheting. The test build emits source maps for the staged `.node-build/src` and `.node-build/scripts/node-foundation` execution projection. Generated and retained trees such as `dist`, `.node-build/tests`, `.scripts-build`, `coverage`, deployed runtime artifacts, `node_modules`, and tests are excluded from the reported surface. The release-validation matrix uploads each leg's `coverage/lcov.info`, including failed threshold runs when the report was produced. Packaging smoke is intentionally outside `npm test`, `npm run test:sharded`, `npm run test:full`, and coverage; run it explicitly with `npm run test:packaging`. This keeps the release contract explicit: the shipped package must build, typecheck, pass unused-symbol enforcement, lint, pass the regular runtime suite under coverage collection, pass production dependency audit, pack from a clean tree, install, execute from the packaged runtime, and leave the release tree clean.

Release handoff archives are split by purpose. `npm run archive:source` writes a deterministic tracked-source tar that excludes generated/local trees including dependency installs, coverage output, staged builds, package runtime output, and Garda runtime state. `npm run archive:evidence` writes a separate allow-listed proof tar for runtime reports, task events, final review artifacts, project-memory evidence, manual-validation logs, metrics, and coverage output, while excluding generated reviewer launch/context support artifacts, skipping known secret or credential paths, and failing closed on credential-like text evidence content. These commands do not alter npm package `files`; package contents remain governed by `npm pack` and release validation.

Direct `npm pack` and `npm pack --dry-run` are guarded by `prepack`, which runs the same clean-worktree preflight before package preparation and again after `build:publish-runtime`.

### Local test timing comparison

Capture each complete quality run without an external timeout, from a prepared checkout, using the tracked command:

```sh
node scripts/node-foundation/check-test-wall-time-baseline.cjs capture <checkout> <new-log-path> <dependency-root>
```

The baseline evidence was captured with the local `quality-environment-runner.cjs` under the ignored runtime directory. The tracked `capture` mode preserves its environment fingerprint algorithm and records candidate scheduler-source and dependency-lock provenance. It records the full `npm run quality` output and appends one `NODE_FOUNDATION_QUALITY_ENVIRONMENT` marker with the command exit code, run timestamps, a fingerprint of OS, Node, CPU, memory and host, aggregate host CPU busy percentage, and source and dependency SHA-256 values. It checks both hashes again after the run, rejects invalid CPU telemetry, and refuses to overwrite an existing log. On success, it prints the post-run dependency tree SHA-256 and file count needed for the tracked config. The marker contains a hash of the host identity, not its raw name.

Compare the three retained logs with:

```sh
node scripts/node-foundation/check-test-wall-time-baseline.cjs config/node-foundation-test-wall-time-baseline.json path/to/baseline-quality.log path/to/candidate-quality-1.log path/to/candidate-quality-2.log
```

The comparator checks all three log hashes before resolving log-derived checkout paths, requires dependency-bound schema 3 for both candidates, checks both candidate provenance hashes against the tracked config, then rechecks the checkout lock snapshot and hashes the current installed dependency tree and requires the measured candidate shard log checkout to match that dependency root and rejects any installed entry whose modification or metadata-change time is after the first candidate run began. It also checks baseline measurement; full `quality` and canonical `test` or guarded `coverage` banners; a top-level full-selection observed run followed by `NODE_FOUNDATION_TEST_OK`; three distinct shard run directories (legacy `.node-build/test-shard-logs/run-<pid>` or managed `garda-agent-orchestrator/runtime/validation-output/<UUID>/scratch`) and sequential capture times; matching hardware/runtime fingerprints; and candidate host CPU busy no more than 10 percentage points below baseline. The top-level shard marker must cover at least 535 files and duration telemetry for at least 500 files. It rejects a top-level partial-selection marker while allowing markers emitted by nested test fixtures. Both candidates must pass the 0.95 wall-time ratio; the output reports the slower one. A 64 MiB per-log limit bounds parsing.

The fingerprint and CPU guard make the measurements more comparable; aggregate CPU busy does not identify every competing process or remove all load variation. The candidate source hash identifies the scheduler implementation. The in-run dependency digest identifies lockfile snapshots, and the post-run tree hash plus file and directory modification and metadata-change times provide additional evidence about installed executable and library content. That post-run check relies on filesystem timestamps; it is an inference about the earlier runs, not a content hash recorded during them. Package scripts, other test sources, other checkout files, and the global npm executable are outside these digests. The retained runs establish the observed wall time under the recorded conditions; they do not cryptographically authenticate every file that contributed to the workload. The measured threshold is evidence for these complete runs, not a hardware-controlled causal estimate. Keep the full exit codes, test totals, source commit, telemetry snapshot, and log hashes with any rebaseline. Earlier candidate logs without dependency markers remain historical context, not the tracked comparison candidates.

### Manual npm staged publishing

The npm release path is `.github/workflows/publish.yml`, using only explicitly
authorized `workflow_dispatch` on a release-tag ref. Tag push starts no workflow.
The unchanged selector requires the exact repository, full run/tag SHA and
`I authorize this selected run`. `validate` is the default operation;
`stage-publish` explicitly selects validation and staging. The offered target is
GitHub-hosted `ubuntu-latest` with Node `24`; every checkout uses the run SHA without
persisted credentials. Same-tag concurrency covers both operations without cancellation.

The `validate` job checks tag/version/ancestry, authenticates complete same-tag
run/attempt history, and verifies the latest exact-commit manual CI run through the
reviewed complete-suite adapter. Saved summaries and partial selections are insufficient:
authorization, all 23 job identities and required steps, retained attempts and 24-hour
freshness must pass. The job uses read-only Actions access, pinned npm CLI `11.15.0`
and `npm run release:preflight`. It packs once outside the checkout, records the
candidate manifest/digest, smokes that exact tarball through `GARDA_RELEASE_CANDIDATE_PATH`,
and re-verifies its bytes. The required `security_run_id` identifies a completed
exact-commit manual Security run with both npm audit and OSV; the live adapter creates
candidate-bound Security evidence before upload.

The explicitly selected dependent `publish` job targets `npm-release`, downloads only
the same-run artifact, verifies the expected candidate name/digest and live Security
proof again, checks history immediately before staging, and passes that exact tarball
to `npm stage publish`. It does not repack. A later staging dispatch validates its own
candidate instead of adopting an earlier validate-only artifact. The history guard
allows at most three attempts across all same-tag run IDs with authenticated 24-hour
history. A completed prior validation with `success`, `failure`, `cancelled` or
`timed_out` and skipped, unexecuted staging permits another separately authorized
dispatch within those limits. Started, failed, cancelled or uncertain prior staging
and missing records fail closed.

The environment must be restricted to selected release tags matching `v*`, with the
same environment name on the npm Trusted Publisher entry. GitHub required reviewers
are optional for the solo-maintainer flow; human approval is npm staged approval with
maintainer 2FA. npm Trusted Publishing uses OIDC with staging-only `id-token: write`
and no long-lived npm token. Registry acceptance, staged approval and public provenance
must be verified before claiming a public release or attestation.

This source contract and its local synthetic-provider tests do not establish hosted
Actions execution, pending/skipped job metadata, Environment/OIDC grants or npm registry
outcomes. Obtain separate authorization for those checks. Historical automatic-run
proof remains source-qualified history, not current release evidence. See the
[manual release runbook](run-methods.md#81-manual-npm-staged-publish) and
[publication history guard](release-readiness.md#publication-history-guard).

### `npm run release:preflight`

Runs the final operator-facing release readiness gate before the expensive release validation path:

1. `npm run validate:release-readiness`
2. `npm run test:release-smoke`
3. `npm run validate:release`

`npm run validate:release-readiness` is a short checklist gate. It verifies static alignment for package scripts, shipped package files, production audit wiring, CI release validation, lifecycle update smoke wiring, runtime-state documentation, manifest validation guidance, security document package/manifest surface, the explicitly authorized manual npm Trusted Publishing workflow/docs, and the tracked `docs/release-readiness.md` checklist before the release is cut. Its offline result is `ReleaseDecision: NOT_EVALUATED`, not release approval or hosted proof. `npm run test:release-smoke` then exercises high-signal runtime contracts for task id parsing, task-event append integrity, next-step startup routing, and status/doctor formatting. It intentionally does not replace `npm run validate:release`; the latter remains the build/test/pack/install proof and includes `npm run test:packaging` for package smoke coverage.

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
