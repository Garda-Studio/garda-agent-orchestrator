# Changelog

## Unreleased

- Resnapshot current authorized parent WIP before split-required decomposition after a partial restore or an isolated repair commit. Preserve every earlier capture package and keep ordinary capture reuse, scope, containment, HEAD-race and rollback checks intact.

- Authenticate source-checkout WIP restore runtime fingerprints from the local publish build cache, its complete current input inventory and the exact published manifest bytes. Keep published manifests independent of build hosts; reject missing, malformed, forged or stale cache authority, including old caches replayed after a rebuild with the same portable inventory. Recheck retained authority paths, traversed directories and absent input roots after module reads to reject concurrent input additions, rewrites and compiler-metadata changes before canonical append.

- Recognize current and historical task-owned review artifacts, canonical JSON and semantic Markdown plans with exact nested task ownership. Preserve invalid or conflicting JSON identities, including JSON reports stored as Markdown, and shared files during inventory and ordinary/forensic GC storage policies. Compression preserves existing staging and gzip destinations. Preserve active tasks and linked compact namespaces or task roots, and include compact output in task-scoped purge under the existing compact writer lock.

- Preserve phase-scoped resume instructions in generated provider bridges. Add fresh-process continuation regressions and reproducible stdout and instruction-recipe measurements, retaining implementation reload, stale-evidence fallback and fresh reviewer protocols.

- Select advisory controller instruction reads by the current preprompt continuation phase. Defer implementation skills during verified review and closeout, restore implementation context before edits, retain unknown-state fallback and mandatory gate protocols, and keep fresh reviewer rule bundles empty.

- Give required non-test review lanes concrete coverage for authored test-only changes and bind those test bytes in freshness and reuse. Preserve mixed-runtime and documentation scope ownership, frozen test classification, staged index snapshots, excluded closeout paths and concrete findings evidence validation.

- Build schema 3 preprompt continuation from the current validated read-only navigator. Replace historical PASS stage inference and startup/review command batches with one advisory action that must be revalidated before use; retain bounded diagnostics and reject foreign-task or escaped artifact reads.

- Document the current preprompt/resume context audit, bounded output measurements and the implementation plan for phase-dependent controller reads. Distinguish proposed presentation fixtures from implemented behavior, retain fresh reviewer skills and trust evidence, and separate selected-provider output size from unmeasured client instruction loads and token usage.

- Show a bounded readable English task-event history in the local dashboard, including ordered times, review attempts and older or resumed cycles. Original details and projected JSON can be expanded, the guarded source-file link retains full history access, and truncated or incomplete histories are marked. Surrounding controls reuse the installed UI language packs.

- Display existing task reports from both root-level runtime and deployed bundle layouts, preserving recognized bundle-directory casing in raw-file links. Browser validation still binds the exact report filename to the selected task; focused client regressions independently check foreign task IDs and paths, payload types, and text/diagnostic limits.

- Recognize direct negative-test assertions after validated regex literals, including quotes, character classes and escaped slashes, while preserving division tokens and rejecting malformed expressions or assertions embedded in inert, conditional or nested code. Use the bundled TypeScript parser to identify literals, nested method bodies and syntax errors, including generic-instantiation division and executable template substitutions; validate regex patterns and complete flags without executing matches. Builds retain the parser's license and notices, and load it only when checking test evidence. Evidence references and exact test-name requirements remain unchanged.

- Task details can lazily display the existing final user report with localized controls, an explicit current summary, honest missing/stale/legacy states and original text preserved as plain text. `GET /api/tasks/<task-id>/final-report` reuses the same-origin file token boundary, requires a known canonical task, reads only its canonical report up to 256 KiB and returns read-only state/text/path/hash/diagnostics; raw report and existing evidence remain accessible.

- Show a localized task progress card in loaded task details, with recorded stages, blockers, final-report availability and a copyable next command; preserve raw diagnostics and existing guarded actions.

- Expose bounded task progress, the current navigator action, validated final-report availability and task-owned evidence references through lazy task details without executing lifecycle actions.

- Make requested task-plan preparation discoverable from task instructions and CLI help, with one-task and multiple-TODO examples, canonical provider routing and no automatic task execution.

- Document reusable task-plan criteria, verification evidence and a small-task brief using the existing schema; align examples with prepared-plan saving, automatic attachment and frozen start state without adding another artifact or gate.

- Add consistent compact task-plan state, path, editability and reading hints to task entry and handshake. Handshake inspects the frozen attachment, reports missing or changed evidence, and keeps existing readiness checks unchanged.

- Preserve available review lanes explicitly required by TASK.md when profile defaults disable them, including immutable review snapshot reconstruction and dependency ordering.

- Automatically attach ready canonical JSON task plans at ordinary task entry, preserve explicit path precedence and frozen attachments, and report missing or draft optional plans without adding a planning gate.

- Added `task plan save <task-id> --input <file>` for atomic prepared-plan creation or replacement before task execution. Saving and task entry share a task-local lock; started tasks and unknown start evidence refuse replacement, and ready plans require explicit acceptance, verification and scope boundaries.
- Added read-only `task plan list` (including `--missing`) and `task plan show <task-id>` commands for opt-in TODO plans, with bounded repository-confined reads and explicit missing, draft, ready and invalid diagnostics.
- Reject cyclic task-plan step dependencies, including self-dependencies, with a deterministic cycle path. Valid forward references and branching dependency graphs remain supported.

- Bind documentation-only and documentation-with-tests review coverage, freshness, and reuse to reviewed content and frozen classification.

- Scope correction-transport audit to authenticated current cycles while retaining superseded history, and reconstruct persisted predecessor handoffs using canonical paths and attempts.

- Preserve authenticated completed content through Git staging without false drift from changed line statistics.

## 1.4.4

### Garda Compact

- Garda Compact helps AI agents keep command output from overwhelming their context. Git status and diffs, file reads, and text searches return short previews; agents can then page through the retained output or search it for the details they need.
- UI settings control supported command families, preview sizes, and cache limits. Cached output is cleaned up after successful task completion, while unfinished tasks retain theirs.

### Faster Navigation And CLI

- Faster next-step and CLI commands through fewer repeated Git and filesystem reads, improved caching, and lazy command loading.

### More Reliable Reviews And Workflow

- More reliable reviews, including result reuse, DELTA coverage, findings and follow-up handling, and recovery of interrupted review cycles.
- More robust task completion and recovery, with better preservation of unfinished work, safer transactions, and improved locking and crash recovery.

### Safer Updates And Releases

- Added daily update notices with the installed and available versions and an explicit update command after task completion and at UI startup, plus a manual UI check translated into every supported language.
- Safer updates and releases through stronger update and rollback handling, runtime and filesystem checks, and package validation.

## 1.4.3

- Fixed workspace verification for compiled-only npm installations: deployed bundles require their executable dist/src runtime instead of the intentionally excluded TypeScript src tree.
- Added compiled-runtime layout regressions and a packed-package setup/verify smoke check. Missing runtime entrypoints and required runtime directories still fail verification.

## 1.4.2

### Extensible Review Catalog

- Added a guarded review catalog for built-in and repository-specific review lanes. Operators can inspect, validate, explain, create, update, enable, disable, bind, and order custom lanes through `garda review-catalog` and the local UI.
- Added profile-owned review states and dependency graphs. The effective catalog, lane policy, and launch order are frozen when a task starts, so later configuration changes cannot alter an active review cycle.
- Added a compatibility-preserving migration flow for existing workspaces. Missing catalog files continue to use the built-in review lanes, custom lanes remain disabled by default, and migration uses preview, confirmation, one-time receipt, transactional apply, audit, backup, and rollback controls.

### Faster And Safer Review Remediation

- Added authenticated `REUSE`, `DELTA`, and `FULL` remediation modes. Bounded fixes can receive a focused delta review when the original exhaustive review, scope lineage, policy snapshot, and evidence remain valid; ambiguous, stale, protected, oversized, or dependency-invalidated changes fall back to a full review.
- Hardened review reuse, dependency ordering, launch receipts, failed-launch recovery, post-review source-mutation detection, evidence-only remediation, and cross-cycle scope binding so stale or unrelated evidence cannot satisfy a current task.
- Added a controlled correction path for malformed reviewer output, including immutable input/output provenance, isolated retry artifacts, response reconstruction, and fail-closed handling for unsupported or tampered corrections.
- Added profile-driven follow-up task policies, safer grouped follow-up handling, review-limit enforcement, and more coherent recovery for interrupted, reopened, decomposed, remediated, or already-completed tasks.

### Workflow And Operator Experience

- Added declarative lifecycle-phase and workflow-settings manifests to keep CLI help, runtime routing, configuration, documentation, and UI behavior aligned.
- Added an authenticated test-first implementation lane for explicitly marked test-only expected failures, followed by the normal refreshed compile, validation, and review cycle after implementation.
- Improved optional quality-check routing: agents must complete the generated answers before execution, and remediated checks are rerun when their evidence is no longer current.
- Improved `next-step` diagnostics and routing for dynamic review lanes, remediation, scope recovery, closeout, full-suite retry, and review-skill selection while reducing repeated review-index and workspace reads.
- Added review-catalog and delta-review controls to the local dashboard, clearer task status markers, and better visibility into profile policies, decomposition, follow-up behavior, review execution modes, and closeout state.
- `garda uninstall` now preserves `TASK.md` by default. Removing the task queue requires the explicit `--keep-task-file no` override and reports recovery information unless backups are also explicitly skipped.

### Reliability And Compatibility

- Fixed clean-checkout release validation on Node 22 for Windows, isolated review-catalog tests from ignored materialized configuration, serialized mutable review-cycle fixtures on concurrent Linux runners, and made the Windows package-install performance ceiling resilient to shared-runner filesystem variance without weakening the functional timeout.
- Strengthened semantic-cycle rebind and resume transactions, mutation-journal recovery, lifecycle-event reconstruction, full-review reuse, correction rollback, materialized follow-up reconciliation, and frozen-policy handling across configuration drift.
- Fixed review-catalog transaction cleanup so lock-release failures are reported without throwing from `finally`, while simultaneous operation and cleanup failures retain both causes.
- Fixed downstream review and rule-pack validation for repositories that keep the task-mode artifact at an explicit non-default path; the supplied path remains constrained to the repository boundary.
- Added end-to-end coverage for review catalog schema, materialization, CLI and UI management, guarded compatibility migration, dynamic launch order, remediation modes, reports, and legacy workspace behavior.
- Existing workspaces remain compatible without a mandatory catalog migration. Profiles without an explicit remediation-mode policy remain on conservative full-review behavior until the operator deliberately migrates or configures them.

### Upgrade Notes

- After updating, run `garda review-catalog validate --target-root "."` to inspect the effective built-in and custom review configuration.
- Use `garda review-catalog migrate --target-root "."` only when you want to preview an explicit normalized catalog for a legacy workspace; the first call is read-only and does not enable custom lanes.
- Existing active task snapshots are not rewritten by catalog or profile changes. Start a new task cycle to adopt newly configured lanes, dependencies, or remediation policies.

## 1.3.0

### Workflow And Reviews

- Strengthened delegated review provenance from launch through receipt: clean-context identities, immutable launch inputs, serialized lane transitions, output hashes, findings validation, and failure recovery now remain bound to the current task cycle.
- Added deterministic reviewer coverage ledgers and exhaustive findings contracts. Reviewers must cover every assigned file, behavior boundary, and applicable category, continue after finding defects, and report distinct evidence-supported findings without an artificial quota.
- Added profile-level finding policies, guarded preview/apply flows, future-task-only policy snapshots, selective remediation evidence, and safer reuse rules for accepted review results.
- Replaced internal finding-policy and preset identifiers in the local UI with user-facing labels across all 20 language packs, clarified the review-failure cadence setting, and localized the not-due-yet quality-check state.
- Hardened coherent-cycle, dirty-baseline, split-WIP, protected-manifest, full-suite-repair, and post-completion recovery so interrupted work resumes through explicit scoped evidence instead of synthetic state.

### Performance And Test Reliability

- Reduced repeated `next-step` work by batching Git status, diff, index, tree, and object probes; sharing request-scoped workspace snapshots; caching immutable task-queue, review-history, runtime-metric, and toxin evidence; and avoiding full global status construction on ordinary navigator routes.
- Partitioned the largest review and gate test suites, bounded subprocess cleanup, improved Windows lock handling, and retained deterministic timeout and failure telemetry for focused and sharded runs.
- Kept runtime-mutation journal files out of task scope without suppressing user-owned lookalikes, and widened only test-harness observation deadlines so reviewer lock tests remain reliable under full-suite load.

### SQLite Projection

- Added a workspace-local SQLite catalog with canonical-first ingestion, generation-bound reconciliation, integrity checks, repair/rebuild commands, connection leases, bounded recovery, and deterministic fallback to canonical files.
- Adopted SQLite only for benchmark-qualified stress-tier bulk task-activity aggregation and added a hash-bound project-memory search index. Small and trust-sensitive paths remain on canonical readers; SQLite is still a disposable projection and never authorizes lifecycle, review, security, cleanup, configuration, or completion decisions.
- Kept Node 22 runtimes without embedded FTS5 fully supported: the capability probe now selects canonical-file fallback, while FTS5-dependent integration coverage runs only when the runtime provides that capability.

### Architecture, Security, And Release

- Split several gate, recovery, materialization, lifecycle, CLI, and report coordinators behind stable facades, added dependency-boundary enforcement, and tightened realpath containment and reviewer diagnostic redaction.
- Reduced the npm tarball to the compiled runtime and required assets, with clean install/invoke smoke coverage that does not require TypeScript, devDependencies, or a consumer build.
- Added deterministic offline package-surface scoring for file count, unpacked size, lifecycle scripts, and executable risk signals, including explicit rationale-bound baseline updates.
- Release readiness now rejects every pre-existing target tag, while the tag-triggered workflow rejects reruns and prior workflow runs for the same tag, verifies tag/version parity, and removes only its ephemeral local tag ref before running the same uniqueness proof; readiness also requires the changelog head and package-surface baseline to match the target version, preserves the released changelog tail against the prior version tag, and validates repository-relative links across all tracked Markdown documents.
- Preserved post-DONE audited content fingerprints after an exact task diff is committed, aligned every human-commit command surface with fresh timestamp confirmation, and synchronized release-preflight contract coverage with package-surface validation.
- Fixed POSIX absolute-path containment on Linux, hardened profile-lock release against replacement cleanup guards, preserved guarded file identity checks on Node 22 for Windows, and refreshed the vulnerable `brace-expansion` override.
- Removed the unreferenced legacy stack walkthrough set; current setup, run-method, workflow, CLI, and configuration guidance remains in the canonical documentation.

## 1.2.0

- Added the new optional quality checklist gate: before review, the agent can run a separate checklist-based quality pass and receive concrete follow-up items.
- Added configurable quality rules: they can be enabled, disabled, and edited through the UI (`garda ui --actions`).
- Improved `next-step` navigation: reduced the number of cases where the navigator could send the agent through an unnecessary extra review cycle.
- Improved review reuse: previous reviews are reused more carefully, with domain, lane, timing trust, full-suite binding, and telemetry checks, so reviews are not rerun unnecessarily while stale evidence is not accepted.
- Added normalized specialist-skill modes: `off`, `optional`, and `mandatory`. Legacy `advisory`/`required`/`strict` values remain readable for compatibility. Custom specialist skills, pack recommendations, and UI settings were improved.
- Refined the local UI: workflow settings, quality gate, profiles, review limits, task reset actions, and system state are clearer.

## 1.1.1

### Local UI
- Restored the guarded Compile-gate command editor in `garda ui --actions`, placed next to Full-suite command and routed through the audited `garda workflow set --compile-gate-command` confirmation path.
- Setup handoff, successful `agent-init`, and `garda status` now surface `garda ui --actions` as a separate UI recommendation for inspecting workspace state and guarded allow-listed settings without replacing the lifecycle next command.

### Install, Update, And Package Safety
- Preserved existing `TASK.md` task rows and user-owned notes when install/update refreshes the managed template, including overwrite-style setup paths.
- Removed public custom deployed-bundle selection through `--bundle-name` and `GARDA_BUNDLE_NAME`; install/update now use the fixed `garda-agent-orchestrator` bundle directory.
- Centralized behavior-bearing deployed-bundle path construction through shared bundle helpers for gates, reports, preprompt context, and guarded local UI actions.

### Task Workflow And Quality Gates
- Reduced the shipped optional quality-check baseline to broadly applicable rules and moved Garda implementation-specific checks out of the universal default rule set.
- Preserved Garda-specific quality checks as source-checkout custom rules during both stale-config migration and fresh workflow-config materialization.
- Localization file changes no longer trigger unnecessary review types.
- Kept mutable closeout evidence such as `TASK.md` out of review-reuse fingerprints so post-review task-status sync does not force redundant reviewer cycles, while preserving provider instruction surfaces in review scope.

## 1.1.0

### Operator Highlights
- Added and expanded `garda ui` as a local dashboard for task inspection, workflow/settings visibility, instructions, lazy task details, and guarded safe actions.
- `next-step` is the main task-loop navigator and now prints the next mandatory command, review policy, full-suite state, missing artifacts, review trust, compact invalidation diagnostics, and clearer recovery guidance.
- Setup output now avoids internal agent-only blocks and ends with a clearer agent-init handoff, plus a recommendation to use `garda ui` for command discovery.
- Project-memory readiness and impact evidence are now visible in setup/update, status, doctor, preprompt, task audit, and final closeout.
- Agent-init now explains ordinary document path exceptions and optional skill handling more clearly, including when extra project-specific skills should be suggested or installed.
- Human output for setup, update, doctor, task events, stats, audit summary, and closeout is more readable, with colorized human surfaces where useful and clean JSON output preserved for automation.

### Install, Update, And Package Safety
- Garda now targets Node.js 24 LTS as the primary runtime and supports Node.js 22.13+ as a compatibility runtime line.
- Setup, bootstrap, install, init, and reinit can recover from stale local bundle parity when they are run from the trusted source checkout, while remote-source setup and mutating lifecycle commands still fail closed.
- Update flows now record clearer trust and provenance evidence for npm, git, local path, and trust-override sources, and successful update output focuses on the applied version and operator-facing notes.
- `garda update`, `check-update --apply`, and `update git` now print compact user-facing result/source/safety/recovery sections instead of raw diagnostic key-value dumps, while keeping detailed provenance in reports and JSON output.
- `garda update`, `check-update --apply`, and `update git` stop before mutation when Garda is switched off, directing operators to run `garda on` first.
- `garda uninstall` now removes Garda-managed `.agentignore` active/off blocks without restoring stale install-time backups over later user edits.
- The package avoids consumer install lifecycle scripts; source checkout users run `npm run build` explicitly before using the generated launcher and compiled runtime.

### Task Workflow And Closeout
- Stale preflight, compile, rule-pack, review-context, review-gate, and full-suite evidence now routes through narrower recovery chains instead of retrying stale gates.
- `TASK.md` Active Queue preservation and gate-owned status sync now reflow the canonical 9-column table into a deterministic IDEA-compatible Markdown shape while preserving row values and lower local planning blocks.
- Successful `completion-gate` output now explicitly routes agents back to `next-step` and the `task-audit-summary` closeout before final report or commit-permission flow.
- After a successful `completion-gate`, `next-step` now reports missing final closeout artifacts instead of listing the already satisfied `completion-gate` as missing while routing to `task-audit-summary`.
- Zero-diff/no-op closeout diagnostics now omit full-suite artifacts that are disabled or intentionally not required, and omit absent completion-gate evidence once the current timeline has already passed completion.
- Final closeout and commit guidance now suppress commit commands when no tracked committable changes remain.
- Task reset, split-required, decomposed parent routing, and one-shot review-cycle continuation are now gate-owned runtime evidence instead of ad hoc `TASK.md` or workflow-config edits.

### Reviews And Validation
- Mandatory reviews require delegated fresh-context reviewer evidence with explicit routing, launch, invocation, receipt, and cleanup telemetry.
- `garda doctor` now includes a report-only large-module decomposition section that highlights the largest source/test files, large declarations, and matching open follow-up tasks.
- Ready-state task recommendations in `garda status`, `garda doctor`, and `agent-init` now resolve the first executable task from the canonical `TASK.md` Active Queue instead of falling back to `T-001`; terminal-only queues now print a clear no-executable-task message.
- Antigravity generated instructions now explicitly stop instead of fabricating independent review artifacts when no real provider sub-agent launch tool is available.
- Reviewer handoffs now include prompt/template/evidence/output paths plus exact verdict-token guidance, reducing malformed review outputs.
- Reviewer launch handoffs now use an immutable `ReviewerLaunchInputArtifactPath` for artifact-path mode, keeping the prepared input hash separate from the later completed launch artifact hash.
- Fresh reviewer launch attempts now receive hash-suffixed `ReviewOutputPath` files, so retry reviewers cannot accidentally append a new report into a stale prior attempt output.
- Reviewer launch help, next-step guidance, and completion-field hints now consistently name `ReviewerLaunchInputArtifactSha256` as the value for `--launch-input-sha256`, while keeping `launch_input_sha256` and `launch_input_artifact_sha256` clearly scoped as artifact JSON fields.
- `complete-reviewer-launch --record-invocation` now prints a complete `record-review-result` handoff command with current preflight, context, output source, execution mode, reviewer identity, and repo-root flags.
- `next-step` review-reuse hints now stay conservative until `build-review-context` validates current context/reuse hash eligibility, while still showing concrete candidates when current-context evidence can be safely rebound.
- Review reuse is stricter and more useful: PASS reviews can be reused only when receipt, provenance, tree state, scope fingerprints, and current-cycle bindings prove they are still valid.
- Strict-profile reviews are more evidence-aware, so DB/API/performance/infra/dependency lanes are not forced without matching domain surface evidence.
- Reviewer contexts now show current full-suite artifact freshness and duration, and tell reviewers when a current PASS suite already covers their lane without rerunning full tests.
- `record-review-result` now preserves existing canonical raw reviewer output on failed validation and replaces raw output, materialized artifacts, receipts, and review-recorded telemetry only after the accepted review result commits successfully.
- Compile-gate now rejects full-suite/test commands in its command block, while init and project discovery suggest stack-specific compile/build/type-check commands separately from full-suite validation commands.
- Compile-gate command selection can now be configured through `workflow-config.json`, `garda workflow set --compile-gate-command`, and the local UI settings editor, while unconfigured workspaces keep the legacy `40-commands.md` fallback.
- Full-suite validation, docs-only scopes, ordinary docs, and test-only deltas now have clearer routing so unnecessary expensive review/test cycles are avoided without weakening freshness checks.
- Full-suite timeout guidance now accounts for recent high-watermark runtime instead of relying only on averages, and external timeout cleanup now terminates child process trees more reliably.
- Task timeline diagnostics in `garda status`, `garda doctor`, and `repair rebuild-indexes` now distinguish invalid filenames, legacy incomplete histories, active incomplete blockers, and integrity failures with more specific repair guidance.

### Cleanup And Runtime Retention
- `garda html` now handles large runtime histories more quickly by rendering lazy or bounded task details by default.
- Backup inventory now has a backend model over existing rollback snapshots with date, reason, size, restore target, health, and latest-10 retention defaults.
- Scheduled auto-backups can now be configured through workflow config and run through the existing daily maintenance path, disabled by default with latest-10 retention.
- Confirmed manual backups now apply the configured `auto_backup.keep_latest` retention policy and report retention/prune results in CLI output and the local UI manual-backup status.
- Runtime cleanup now covers more generated zones, including temp, cache, report, update-temp, reviewer scratch, test scratch, metrics, and runtime tmp directories.
- Clean successful compile and full-suite runs omit heavy raw logs while retaining compact hash/count evidence; warnings, failures, and non-clean runs still keep detailed output.
- Retention and GC flows preserve active tasks and problem-task forensic evidence while allowing healthy DONE task artifacts to be compacted after ledger evidence exists.

### Release, Docs, And Package Contract
- Release validation now checks the sourceful distribution contract: published packages include the compiled runtime, canonical TypeScript source, templates, package metadata, and the public documentation surface needed by README/HOW_TO links.
- `release:preflight` now runs a short `test:release-smoke` runtime-contract suite after static readiness and before the expensive full release proof.
- Coverage scripts now use an explicit `c8` source-boundary config with `all=true`, reporting unexecuted maintained source while excluding generated build, coverage, runtime, dependency, and test trees.
- Release handoff archives now have separate `archive:source` and `archive:evidence` commands so clean source snapshots stay separate from generated proof artifacts and runtime reports.
- Package and bundle parity checks were tightened so releases can detect stale source, dist, template, package, and runtime-referenced documentation content before handoff.
- Embedded bundle parity validation now reports skipped status instead of an OK status when no parity items are checked.
- Documentation was aligned with the current Node runtime support, provider wording, lock-cleanup behavior, package files surface, and source-checkout build contract.

### Internal Hardening
- Protected control-plane checks, launcher delegation trust, offline-mode ordering, task-event integrity, update cache invalidation, and runtime lock recovery were hardened.
- Protected recovery handoff commands now include required operator-confirmation flags, so `next-step` and protected gate failures print copy-paste executable `enter-task-mode --orchestrator-work` restarts.
- Workflow-config preflight recovery now refreshes underscoped scopes when protected dirty-baseline files are still present outside the planned workflow-config change.
- Protected task-mode recovery now rebuilds planned changed-file scope from the current workspace snapshot instead of carrying stale planned files into the `enter-task-mode --orchestrator-work` restart command.
- Command dispatch, help discovery, workflow settings, profile selection, and optional-skill activation now fail closed in more ambiguous states.
- CI, release readiness, pack smoke, embedded bundle parity, and clean-worktree validation were expanded to better match the release path.

## 1.0.0
- first public Garda release
- renamed the public project line to Garda and reset the visible release history
- aligned the package version and workspace version files to `1.0.0`
- ships the current local agent orchestration runtime, gates, provider bridges, profiles, cleanup flows, and audit trail as the new baseline
