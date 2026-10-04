# Architecture

## Design Philosophy

- Canonical rules live only in `garda-agent-orchestrator/live/docs/agent-rules/*`.
- The selected source-of-truth entrypoint contains the full routing index.
- Additional active agent files can be materialized as redirects or provider bridges, but unused entrypoints are not created by default.
- Provider-native agent profiles bridge back to the same `live/skills/*` contracts.
- The public runtime surface is the generated Node CLI launcher: `bin/garda.js`.
- Existing project docs and legacy agent files are read as input context only.

## Runtime Model

```text
bin/garda.js
  -> when launched from node_modules, delegates to the local workspace/source launcher when available
  -> otherwise loads compiled dist/src/**/*.js (or staged .node-build/src/**/*.js for tests)
  -> generated from strict TypeScript source in src/bin/garda.ts
  -> loads runtime compiled from strict TypeScript source in src/**/*.ts
  -> runs lifecycle commands, validators, and gates
  -> materializes live/, runtime/, and managed root entrypoints
```

### Runtime Layers

| Layer | Location | Runtime | Role |
|---|---|---|---|
| Public CLI | `bin/garda.js` | Node.js 24 LTS primary; Node.js 22.13+ compatibility | Generated launcher compiled from `src/bin/garda.ts` |
| TypeScript source of truth | `src/**/*.ts` | compile-time only | Strict compiler-enforced runtime source |
| Executed runtime | `dist/src/**/*.js` and `.node-build/src/**/*.js` | Node.js 24 LTS primary; Node.js 22.13+ compatibility | Compiled lifecycle, validator, and gate implementation |
| Live workspace | `live/**` | materialized content | Canonical rules, config, skills, metadata |

## What Is Deployed To Project Root

### Entrypoint Files

| File | Purpose |
|---|---|
| `CLAUDE.md` | Claude Code entrypoint |
| `AGENTS.md` | Shared Codex and Cursor entrypoint |
| `GEMINI.md` | Gemini entrypoint |
| `QWEN.md` | Qwen entrypoint |
| `.github/copilot-instructions.md` | GitHub Copilot entrypoint |
| `.windsurf/rules/rules.md` | Windsurf entrypoint |
| `.junie/guidelines.md` | Junie entrypoint |
| `.antigravity/rules.md` | Antigravity entrypoint |
| `.agents/workflows/start-task.md` | Shared start-task router opened by root entrypoints and provider bridges |
| `TASK.md` | Shared task queue |

One entrypoint is canonical. Additional entrypoints are created only when they were explicitly confirmed as active during agent initialization.

### Provider Bridge Profiles

| File | Purpose |
|---|---|
| `.github/agents/orchestrator.md` | Copilot orchestrator bridge |
| `.github/agents/reviewer.md` | Copilot reviewer bridge |
| `.github/agents/{code,db,security,refactor,...}-review.md` | Copilot specialist review bridges |
| `.windsurf/agents/orchestrator.md` | Windsurf orchestrator bridge |
| `.junie/agents/orchestrator.md` | Junie orchestrator bridge |
| `.antigravity/agents/orchestrator.md` | Antigravity orchestrator bridge |

### Settings Files

| File | Condition |
|---|---|
| `.claude/settings.local.json` | `ClaudeOrchestratorFullAccess=true` |
| `.qwen/settings.json` | Only when the project already contains this file; managed entries mirror `TASK.md` plus the current canonical entrypoint |
| `.vscode/settings.json` | Always materialized; adds `files.exclude`, `search.exclude`, and `files.watcherExclude` patterns for generated directories |
| `.git/hooks/pre-commit` | `EnforceNoAutoCommit=true` |
| `.gitignore` | Managed entries for agent artifacts |

## IDE Responsiveness Hardening

Generated trees (`garda-agent-orchestrator/`, `dist/`, `.node-build/`, `.scripts-build/`, `node_modules/`) can degrade IDE responsiveness when indexed. The installer ships product-level safeguards:

### VS Code Exclude Patterns

Install materializes `.vscode/settings.json` with exclude patterns under `files.exclude`, `search.exclude`, and `files.watcherExclude` for all heavy generated directories. If a project already has a `.vscode/settings.json`, install merges the required patterns without removing existing settings.

### Nested Bundle Duplication Detection

`doctor` detects nested deployed bundles where `garda-agent-orchestrator/garda-agent-orchestrator/` contains another launcher. This condition means one project silently produces two indexed copies of the same codebase. Doctor reports these as `DUPLICATES_FOUND` with remediation guidance.

### Self-Hosted Source Checkout Layout

In a self-hosted checkout the directory structure looks like:

```text
project-root/
├── src/                        # TypeScript source (compile-time)
├── dist/                       # Compiled JS runtime (generated, gitignored)
├── .node-build/                # Node foundation test build (generated, gitignored)
├── .scripts-build/             # Script build output (generated, gitignored)
├── bin/garda.js              # Source CLI launcher (generated, gitignored)
├── node_modules/               # Dependencies (gitignored)
├── garda-agent-orchestrator/ # Deployed bundle (gitignored, materialized by install)
│   ├── live/                   # Canonical rules, config, skills
│   ├── runtime/                # Task events, reviews, rollbacks
│   ├── dist/                   # Bundle compiled runtime
│   └── bin/garda.js          # Bundle CLI launcher
├── .vscode/settings.json       # IDE exclude patterns (tracked)
├── .gitignore                  # Managed ignores (tracked)
└── tests/                      # Test suite
```

All generated directories are both gitignored and excluded from IDE indexing by the shipped `.vscode/settings.json`.

`src/lifecycle/cleanup/cleanup-wip-ownership.ts` owns read-only WIP package
snapshots. Authentication validates the canonical capture location and exact
manifest schema, declared patch and untracked payload hashes and sizes, and
the complete contained package tree. Unknown members, links, shared files,
missing declarations and replaced filesystem identities fail closed. Optional
shared read budgets reserve observed manifest and file bytes before opening
them; malformed JSON, rejected schemas and oversized reads retain their charge.
Observed payload size must equal its declaration and fit the remaining package
capacity before the file is opened. Authenticated reads still cap the descriptor
at the admitted size and recheck bytes and metadata after reading.
Directory enumeration reads bounded entries through a closed directory handle,
including the final containment inspection. Its allowance accounts for already
retained and pending members before allocating names. Suspended manifests cannot
claim retirement metadata, and nested restore commands admit only known fields.
Declared source depth cannot exceed the package entry limit. Directory membership
uses a component index bounded to twice that limit, covering original and possible
suspended payload directories without retaining every full ancestor path. Both
bounds apply before package directory reads.
Snapshot metadata has a separate 64 MiB admission allowance per package and a
shared allowance carried by `remainingSnapshotBytes` (initialized to the same
limit when omitted). Conservative identity and path-character weights bound the
potential declared ancestry before traversal; rejected snapshots retain their
charge. The weights are a resource quota, not a heap measurement. Bindings and
file identities use compact SHA256 values, and sorted tree identities are hashed
incrementally. Closing inspection reuses retained bindings and rejects new
members before capturing or enumerating their ancestry.
Closing inspection compares exact membership and retained ancestry identities
with the captured tree. File size, mtime and ctime must remain unchanged across
authenticated reading and snapshot completion; this catches in-place changes
without rereading payload bytes during closing inspection.
Retained directory identities, modification times and change times are rechecked
after closing traversal and file verification, with descendants before the root.
This rejects members added to an already-enumerated parent while closing
inspection visits its descendants.

Restore handoffs reuse the producer's identity builder and restored-file
selection contract. Prepared, pending and finalized states each require their
own exact evidence shape. Identity reconstruction fixes timeline-anchor field
order and retains the producer's manifest spelling while admitting equivalent
Windows selections. Runtime generation comparison is independent of serialized
field order. The package snapshot provides authenticated bytes and retained
filesystem bindings; lifecycle callers own retirement authority, surviving
references, confirmation and subsequent mutation checks.
While a manifest is suspended, each handoff digest must equal its authenticated
bytes. Retirement changes those bytes while preserving the original producer
handoff digest; lifecycle callers validate that transition's authority.

Before split-required decomposition, the authenticated latch route creates a
separate immutable capture of current authorized parent WIP. It does not reuse
an earlier complete capture as checkout evidence after partial restoration or
an isolated HEAD advance. Earlier packages remain available for restoring the
remaining child scopes. Ordinary capture reuse still requires a verified
suspended or fully restored checkout; a new decomposition capture retains the
existing preflight scope, containment, source/index/HEAD revalidation and
transaction rollback checks.

Source-checkout WIP restore finalization runs in the freshly built `dist`
runtime. Its host-local input fingerprint comes from
`.scripts-build/publish-runtime-build-cache.json`; the cache must bind the
SHA-256 of the exact `dist/publish-runtime-manifest.json` bytes. Its versioned
fingerprint payload must authenticate its own digest, match the current Node,
platform, architecture, engine and TypeScript metadata, and declare the complete
current build-input inventory. Every input size and SHA-256 is checked through
the authenticated repository snapshot owner; inventory is reconstructed again
after those reads. Replaying an older cache therefore fails even when published
manifest bytes remain identical. Published manifests contain the portable
runtime file inventory, without host fingerprint
metadata. Finalization also requires a current source checkout, the exact loaded
build root, manifest membership of the finalizer and task-event writer, and
authenticated module hashes. After resolving module hashes, it rechecks retained
path identities, sizes and change/modification times for the manifest, cache,
compiler metadata, build inputs, modules and traversed input directories,
including the absence of optional input roots. Detected content rewrites, file
replacement or late input additions block canonical append and preserve the pending handoff.
Generation changes before canonical event append leave restoration incomplete.

Schema 1 input discovery follows the publish producer's roots and `.cjs`, `.js`,
`.json` and `.ts` extensions, excluding nested `.git` and `node_modules` entries.
Linked or non-regular input paths cannot supply authority. Validation is bounded
to 8,192 input files, 65,536 traversal entries, 64 directory levels, 128 MiB of
input reads, 64 MiB per input and 1 MiB per metadata file. Cache and published
manifest snapshots retain their existing 16 MiB limits.

## What Is Materialized Inside Orchestrator

| Path | Purpose |
|---|---|
| `live/docs/agent-rules/00..90` | Canonical rule set |
| `live/docs/changes/CHANGELOG.md` | Local changelog |
| `live/docs/reviews/TEMPLATE.md` | Review template |
| `live/docs/tasks/TASKS.md` | Internal task reference |
| `live/config/review-capabilities.json` | Enabled review types |
| `live/config/paths.json` | Preflight roots and trigger regexes |
| `live/config/token-economy.json` | Token economy settings |
| `live/config/output-filters.json` | Gate output compaction profiles |
| `live/config/skill-packs.json` | Installed built-in domain packs |
| `live/config/skills-index.json` | Compact optional-skill discovery index |
| `live/skills/**` | Orchestration and review skills |
| `live/project-discovery.md` | Project context discovered during setup |
| `live/source-inventory.md` | Source inventory |
| `live/USAGE.md` | Generated usage guide |
| `live/version.json` | Deployment metadata |
| `runtime/agent-init-state.json` | Hard onboarding state written by `garda agent-init` |
| `runtime/update-rollbacks/**` | Saved pre-update workspace snapshots for rollback |
| `runtime/bundle-backups/**` | Saved bundle copies created during applied updates |
| `runtime/update-reports/**` | Update and rollback reports |

## SQLite Persistence Boundary

Garda's staged SQLite catalog is workspace-local at
`garda-agent-orchestrator/runtime/catalog/orchestration.sqlite3`. It is a
rebuildable query projection over canonical task, event, review, ledger,
retention, metric, and approved project-memory files. It is not shared between
projects and is not an authority for lifecycle, review, security, or completion
decisions. The driver, source-of-truth matrix, migration, WAL, recovery, backup,
restore, and benchmark contracts are defined in
[`docs/database/sqlite-persistence.md`](database/sqlite-persistence.md).

## Git And EOL Change Classification

`src/core/git-change-classification.ts` is the canonical low-level primitive for
classifying the staged/unstaged bits and untracked entries from one
`git status --porcelain=v1 -z` snapshot. Its
`eol_only_is_dirty_v1` policy keeps LF/CRLF-only changes in effective dirty
scope and records an explicit reason; content, binary, path/metadata, and
unavailable comparisons remain distinct. If Git attributes or
`core.autocrlf` normalize a working-tree representation so Git reports it as
clean, the classifier also reports it as clean. Classification never rewrites
working-tree files or changes Git configuration.

## Task Lifecycle

```text
TODO -> IN_PROGRESS -> IN_REVIEW -> DONE
                     \-> BLOCKED
```

Gate pipeline:

```text
0. next-step before the first gate and after every gate
1. enter-task-mode
2. load-rule-pack (TASK_ENTRY)
3. handshake-diagnostics
4. shell-smoke-preflight
5. classify-change
6. load-rule-pack or bind-rule-pack-to-preflight (POST_PREFLIGHT)
7. implementation
8. compile-gate
9. full-suite-validation when the active workflow placement requires it
10. build-review-context for each required review
11. fresh delegated reviewer launch and review-result recording
12. required-reviews-check
13. doc-impact-gate
14. project-memory-impact when enabled
15. completion-gate
16. task-audit-summary
17. DONE reported by next-step
```

Root entrypoints and provider bridges must route task execution through `.agents/workflows/start-task.md`; that file is a thin shared router, not a second workflow source.

Failed reviews re-enter this loop through `next-step`. The agent fixes the
finding, lets the navigator refresh preflight/compile/review-context evidence
as needed, launches a new clean-context delegated reviewer for any invalidated
review lane, records the new verdict, and only then retries
`required-reviews-check`.

### Authenticated remediation review modes

The remediation review boundary has one gate-owned `REUSE | DELTA | FULL`
decision. `REUSE` consumes unchanged authenticated evidence, `DELTA` verifies a
bounded repair against complete prior-scope lineage, and `FULL` re-runs the
exhaustive lane. The first lane review is always `FULL`. A profile must contain
an explicit valid `review_remediation_mode_policy` before `DELTA` is available;
missing legacy policy snapshots remain `FULL`-only. Protected, ambiguous,
oversized, stale, tampered, dependency-invalidated, or periodic-full cases fail
closed to `FULL`.

The immutable task-profile snapshot freezes this policy. Review contexts,
findings validation, receipts, recovery routing, completion, and task audit all
consume the same authenticated execution contract. CLI status/profile output,
stats, and reports expose policy readiness and observed modes, but never make an
independent routing decision.

All gate events are logged to `runtime/task-events/<task-id>.jsonl` with hash-chain integrity.

## Validation Contract

- `tsconfig.build.json` enforces `strict:true` for `src/**/*.ts`.
- `tsconfig.tests.json` enforces `strict:true` for `src/**/*.ts`, `tests/node/**/*.ts`, and `scripts/node-foundation/**/*.ts`.
- `npm run validate:release` is the explicit release proof path: `clean worktree -> build -> embedded bundle parity when present -> regular tests/coverage -> explicit package smoke -> pack/install/invoke -> clean worktree`.
