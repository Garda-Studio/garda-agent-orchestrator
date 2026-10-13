# Source Layout Refactor Safety Map

This map is the safety contract for source-layout refactors. It is intentionally
behavior-preserving: future layout tasks may move or split files only when the
public command, gate, lifecycle, artifact, and review-trust contracts stay
compatible.

## Scope

The current crowded source areas are:

| Area | Current shape | Safe refactor direction |
|---|---:|---|
| `src/cli/commands` | Command facades and owner directories such as `gate-flows/**`, `gate-review-handlers/**`, `workflow/**`, `profile/**`, `stats/**`, `workspace/**`, and `preprompt/**` | Group durable command families under owner directories and keep public command facades stable. |
| `src/gate-runtime` | Stable top-level compatibility facades plus `review/**` and `timeline/**` owner directories | Keep runtime implementations under the owner directories while preserving the flat materialized-bundle paths as compatibility-only re-exports. |
| `src/lifecycle` | Lifecycle facades and owner directories such as `agent-init/**`, `cleanup/**`, `lock/**`, `runtime-policy/**`, and `update/**` | Group by update/apply, rollback, cleanup/removal, locks, retention policy, and update-source checks. |
| `src/validators` | Validator facades and owner directories such as `doctor/**`, `status/**`, and `workspace-layout/**` | Group by doctor/status/workspace/verify diagnostics only where imports can stay stable. |
| `src/materialization` | Init/install facades plus `install/**` phase helpers | Split scenario phases behind existing init/install facades before introducing directories. |
| `src/core` | Core primitives plus `task-queue/**` owner internals | Split only clearly separable helpers; do not create a generic bucket for unrelated primitives. |

`src/gates/next-step/next-step.ts` remains a separate facade-extraction track and
is not part of this layout block except for tiny import fixes caused by a moved
facade.

## Compatibility Boundaries

Keep these imports stable unless a child task explicitly changes the public API:

- CLI entry and dispatch: `src/cli/runtime-main.ts`, `src/cli/main.ts`,
  `src/cli/commands/command-dispatch.ts`, and command modules imported by tests.
- Gate CLI facades: `src/cli/commands/gates.ts`,
  `src/cli/commands/gate-command.ts`, `src/cli/commands/gate-build-handlers.ts`,
  `src/cli/commands/gate-task-handlers.ts`, and
  `src/cli/commands/gate-review-handlers/**` public barrel paths.
- Runtime facades and indexes: `src/gate-runtime/task-events.ts`,
  `src/gate-runtime/review-artifacts.ts`, `src/gate-runtime/reviews-index.ts`,
  and `src/gate-runtime/timeline-summary.ts`.
- Lifecycle/materialization facades used by CLI/tests:
  `src/lifecycle/update.ts`, `src/lifecycle/rollback.ts`,
  `src/lifecycle/check-update.ts`, `src/materialization/init.ts`, and
  `src/materialization/install.ts`.
- Validator public imports: `src/validators/index.ts`, `src/validators/doctor.ts`,
  `src/validators/status.ts`, and `src/validators/verify.ts`.
- Core primitives with many direct consumers: `src/core/workflow-config.ts`,
  `src/core/provider-registry.ts`, `src/core/subprocess.ts`, and
  `src/core/dependent-validation-chains.ts`.

## Canonical Gate-Runtime Imports

Runtime implementation ownership is complete under two subpackages:

- Timeline, lifecycle, task-event, lock, ledger, and summary code:
  `src/gate-runtime/timeline/**`.
- Review context, review artifacts, receipts, indexes, reviewer contracts, and
  scoped diffs: `src/gate-runtime/review/**`.

New gate-runtime implementation code and implementation-coupled tests must use
the canonical subpackage paths, for example
`gate-runtime/timeline/task-events`,
`gate-runtime/timeline/timeline-summary`,
`gate-runtime/review/review-context`, and
`gate-runtime/review/review-artifacts`. The `timeline/index.ts` and
`review/index.ts` barrels are the canonical grouped entrypoints.

Flat paths such as `gate-runtime/task-events`,
`gate-runtime/timeline-summary`, and `gate-runtime/review-context` are
deprecated for new imports. They remain one-line compatibility facades for
existing cross-domain callers and materialized bundles during the transition;
they must not become implementation owners again.

## Facade Classification

The current one-line compatibility re-exports fall into two classes:

- Public/stable facades: package-facing barrels, command and gate dispatch
  surfaces, validator entrypoints, core primitives listed above, lifecycle
  update/rollback/check-update entrypoints, and runtime review/timeline roots
  that are imported by tests or cross-domain callers.
- Internal compatibility facades: root files that only preserve pre-split
  paths for helpers now owned by a focused subdirectory, such as
  `src/validators/doctor-*`, `src/validators/status-*`, and
  `src/materialization/project-memory-*`. New same-domain implementation code
  should import the canonical subdirectory path directly while old public/test
  imports stay supported through the facade.
- Gate-runtime root contract: `src/gate-runtime/review-*`,
  `src/gate-runtime/review-context*`, `src/gate-runtime/review-artifacts.ts`,
  `src/gate-runtime/reviews-index.ts`, `src/gate-runtime/scoped-diff.ts`,
  `src/gate-runtime/lifecycle-event-*`, `src/gate-runtime/lifecycle-events.ts`,
  `src/gate-runtime/task-events*.ts`, `src/gate-runtime/task-history-ledger.ts`,
  and `src/gate-runtime/timeline-*` are public compatibility paths when tests,
  gate code, or external consumers import them. New same-domain gateway barrels
  should prefer the canonical `src/gate-runtime/review/**` and
  `src/gate-runtime/timeline/**` owner paths when the root file is only a
  facade. All task-event helpers, integrity, IO, lock support, and timeline
  summary implementations are owned by `timeline/**`; their root files are
  deprecated compatibility facades only.
- Gate-runtime real root modules: `hash.ts`, `output-filters.ts`,
  `output-log-retention.ts`, `output-compaction-reporting.ts`, `text-utils.ts`,
  and `token-telemetry.ts` remain root-owned source modules until a focused
  task gives them a durable owner directory and keeps existing public imports
  compatible.
- Lifecycle root contract: `src/lifecycle/update.ts`,
  `src/lifecycle/rollback.ts`, `src/lifecycle/check-update.ts`,
  `src/lifecycle/common.ts`, and `src/lifecycle/contract-migrations.ts` are
  public compatibility entrypoints for CLI commands, lifecycle tests, and
  materialized-update paths. New same-domain lifecycle implementation imports
  should prefer canonical owner paths such as `src/lifecycle/update/**`,
  `src/lifecycle/cleanup/**`, `src/lifecycle/lock/**`,
  `src/lifecycle/runtime-policy/**`, and
  `src/lifecycle/agent-init/**` when the root file is only a facade.
- Lifecycle real root modules: `src/lifecycle/agent-init.ts`,
  `src/lifecycle/generic-utils.ts`, and `src/lifecycle/lifecycle-common.ts`
  remain root-owned implementation modules for now because they are shared
  across update, setup, uninstall, cleanup, and rollback flows. They must not be
  moved behind a narrower owner directory until the affected cross-flow call
  sites are migrated in the same task and old public imports remain compatible.
- Materialization root contract: `src/materialization/init.ts` and
  `src/materialization/install.ts` remain public facades for setup, update, and
  lifecycle callers. Phase-owned implementation code may move under
  `src/materialization/init/**` or `src/materialization/install/**` when the
  root file keeps the public `runInit`/`runInstall` entrypoints and generated
  materialization output remains unchanged.
- Core task-queue namespace: `src/core/active-task-state.ts` is a public
  compatibility facade for task status parsing and runtime active-task
  discovery. The implementation lives under `src/core/task-queue/**`; new
  same-domain task-queue implementation code may import that owner path, while
  cross-domain consumers and tests can keep the stable root import.
- Validator workspace-layout namespace: `src/validators/workspace-layout.ts`
  remains the public validator compatibility surface for workspace layout and
  bundle/runtime checks. Focused source-runtime staleness helpers live under
  `src/validators/workspace-layout/**`; same-domain validator implementation
  may import those helpers directly when it is not preserving a public path.

If a file is moved behind a new directory, keep a facade or compatibility
re-export at the old import path until the affected source and test imports are
updated in the same child task.

Internal-only source helper paths are not public compatibility contracts by
default. Gate CLI parsing, artifact, formatting, and subprocess helpers use the
canonical `src/cli/gate-cli/**` owner path. The former
`src/cli/commands/gates/**` helper paths are one-release compatibility
re-exports only; new source and test imports must use `src/cli/gate-cli/**`.
The preserved contract is CLI/gate behavior, output, exit codes, artifact
schemas, and documented public entrypoints, not arbitrary historical source
file locations.

## Move Order

Use this order so each child task has a bounded blast radius:

1. CLI command family layout.
2. Large standalone CLI command boundaries after layout is stable.
3. Gate runtime internals.
4. Lifecycle internals.
5. Validators, materialization, and selected core hotspots.

Do not combine CLI command moves with lifecycle or gate-runtime moves. Do not
combine source moves with behavior fixes unless the fix is required to preserve
the current public contract.

## Validation Map

| Future task | Focused validation before mandatory gates |
|---|---|
| CLI command layout | `tests/node/cli/**`, especially `tests/node/cli/commands/**` and gate CLI command suites. |
| Standalone CLI command splits | Command-specific tests for profile, stats, setup, update, repair, workspace maintenance, and dispatch. |
| Gate runtime layout | `tests/node/gate-runtime/**`, review artifact/reuse tests, timeline/status tests. |
| Lifecycle layout | `tests/node/lifecycle/**`, update/check-update tests, cleanup tests, protected-manifest tests. |
| Validators/materialization/core | `tests/node/validators/**`, `tests/node/materialization/**`, `tests/node/core/**`, plus affected provider/materialization tests. For source-layout-only facade moves, keep the nearest domain tests path-targetable and rely on compile/full-suite gates for broad import compatibility. |

Every child task must still finish through the normal orchestrator gates:
compile, required reviews, doc-impact, full-suite when enabled, completion, and
final audit.

## Guardrails

- Preserve CLI command names, flags, exit codes, text output, and JSON output.
- Preserve gate artifact schemas, runtime evidence paths, timeline event names,
  receipt semantics, and review-trust validation.
- Preserve self-hosted update, rollback, protected-manifest, cleanup, and
  materialized workspace behavior.
- Avoid `utils`, `misc`, or `common` directories unless the owner domain is
  specific and stable.
- Prefer small compatibility facades over broad import rewrites only when public
  consumers are uncertain. For proven internal helper paths, migrate consumers
  and delete the old file instead of keeping dead facades.
- Keep generated output directories (`dist/**`, `.node-build/**`, `coverage/**`)
  out of refactor scope; they are validation artifacts, not source ownership.
