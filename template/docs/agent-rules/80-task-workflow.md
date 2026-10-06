# Task Workflow

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Canonical Workflow Source
- Canonical execution flow is defined in:
  - `garda-agent-orchestrator/live/skills/orchestration/SKILL.md`
- Reviewer-agent execution mechanics are defined in `orchestration/SKILL.md` section `Reviewer Agent Execution (Platform-Agnostic)`.
- This file defines lifecycle semantics and hard-stop contracts only.
- Do not maintain parallel step-by-step workflow variants in multiple files.

## Task Lifecycle
- Task queue source: `TASK.md`.
- Status lifecycle: `TODO -> IN_PROGRESS -> IN_REVIEW -> DONE`, `BLOCKED`, `SPLIT_REQUIRED`, or `DECOMPOSED`.
- Visual markers in `TASK.md` status are allowed (`🟦 TODO`, `🟨 IN_PROGRESS`, `🟧 IN_REVIEW`, `🟩 DONE`, `🟥 BLOCKED`, `🟫 SPLIT_REQUIRED`, `🟪 DECOMPOSED`), but canonical status token must remain present.
- Gate flow owns forward `TASK.md` status transitions to `IN_PROGRESS`, `IN_REVIEW`, `SPLIT_REQUIRED`, and `DONE`.
- Agents may add tasks, edit backlog content, and update non-status `TASK.md` metadata when requested, but must not hand-edit active task status cells to `IN_PROGRESS`, `IN_REVIEW`, `SPLIT_REQUIRED`, `DONE`, or `BLOCKED` as a substitute for lifecycle gates.
- Explicit operator reset or discard commands, such as `gate task-reset --reopen` or `gate task-reset --discard`, are the supported exceptions for lifecycle reset/discard status changes.
- Keep `BLOCKED` as an explicit workflow stop state when the workflow fails closed, record the blocking reason in notes/timeline, and use `DECOMPOSED` only for split parent tasks that are no longer executable lifecycle scopes.
- If provider-native agent directories are present, use their orchestrator bridge profile before any implementation:
  - `.github/agents/orchestrator.md`
  - `.windsurf/agents/orchestrator.md`
  - `.junie/agents/orchestrator.md`
  - `.antigravity/agents/orchestrator.md`
- Provider bridges must refresh skill routing from `90-skill-catalog.md` and `review-capabilities.json`, including specialist skills added after init.
- One task owns implementation by default. If another unfinished task owns the worktree, report its task id and ask the operator to confirm working alongside it while preserving existing changes. After explicit approval, enter task mode with repeated `--allow-active-task <id>`, fresh operator confirmation flags, and an explicit planned file scope. The recorded approval applies to this task and the approved owner entries; later gates reuse it, while new or restarted owners require renewed confirmation. Dirty-workspace protection remains mandatory.
- Path mode values: `FAST_PATH` or `FULL_PATH`.
- Path mode is assigned only by:
  `node garda-agent-orchestrator/bin/garda.js gate classify-change`.

## Depth Contract
- Supported depth values: `1`, `2`, `3`.
- Default depth: `2`.
- Depth never bypasses mandatory gates.
- Depth escalation applies when:
  - preflight returns `FULL_PATH`;
  - preflight requires specialized review (`db`, `security`, `refactor`, or enabled optional specialist review).

## Agent Start Contract
- Planning discovery: for a leading `[plan]` Notes token or explicit plan request, see `garda task plan --help` and canonical orchestration planning guidance; load full details only on demand.
- The canonical user instruction is: Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.
- Default executable navigator is `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`; run it before the first gate, after every suggested command, and after any gate failure.
- Static gate order below is policy context. Agents must not start at `compile-gate`, infer default flags, or skip to review from the static list when `next-step` can inspect current task evidence.
- Active profile selection comes from `live/config/profiles.json` and the `TASK.md` `Profile` column; do not present `depth=<1|2|3>` as normal user task-start guidance.
- At fresh main-agent task start, show one English start marker from the repo-owned list once in the first relevant reply; this UX marker is not gate evidence.
- Do not use start-marker presence or exact text as hard evidence for task-mode, compile, review, completion, or task-audit gates.
- Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.
- If `garda-agent-orchestrator/runtime/plans/<task-id>.md` exists for the selected task, read it as optional executor guidance. Missing Markdown working plans are normal: do not block, invent a waiver, pass them as `--plan-path`, or treat their absence as a reviewer/completion issue.
- If the workspace already contains modified files before task-mode entry and the run is not isolated through staged or explicit scope, stop and treat the start as invalid.
- Another `IN_PROGRESS` or `IN_REVIEW` task with task-mode evidence requires operator consent before starting work alongside it. `next-step` reports the owners and emits the explicit `--allow-active-task` approval command. Queue-only waiting rows and tasks with an authenticated current-cycle no-op do not claim implementation ownership. Valid task-specific approval is reused by later gates. Re-entry requires fresh consent and preserves the original dirty-workspace baseline, including when the artifact path changes.

## Review Catalog Context Contract
- Built-in review lanes and their canonical verdict tokens remain compatibility-owned even when `live/config/review-catalog.json` is absent.
- Custom review lanes are declarative and disabled by default. They cannot replace built-in lanes or supply prompt bodies or verdict-token overrides.
- Capability flags, profile lane states, triggers, and the validated review dependency graph determine which catalog lanes are active and their launch order.
- Task entry and preflight bind the effective lanes and dependency graph into an immutable current-task catalog/policy snapshot. Guarded catalog or profile mutations affect future tasks only.
- Normal task agents consume `TaskStartReviewCatalog` plus current preflight evidence; delegated reviewers consume only the generated launch input for their lane. Do not load `live/config/review-catalog.json` into normal task or reviewer context.
- Use `review-catalog list|show|explain|validate` only for explicit inspection, management, migration, or troubleshooting work.
- Catalog mutations use the guarded preview, operator-confirmation, and apply transaction. Preserve its active-task guard, hash bindings, audit trail, backup, and automatic rollback behavior.

## Project Memory Task Entry Protocol
- `TASK_ENTRY` rule-pack includes `15-project-memory.md` as generated project-memory orientation.
- After `TASK_ENTRY` rule loading, read source memory through the index-first protocol:
  1. `garda-agent-orchestrator/live/docs/project-memory/README.md`
  2. `garda-agent-orchestrator/live/docs/project-memory/compact.md`
  3. only the focused memory files relevant to the current task.
- Do not read every project-memory file by default; use `preprompt task` suggestions or `compact.md` task routing to choose a small focused set.
- Memory is orientation, not proof. Validate against source, tests, config, and mandatory gates before changing behavior.
- Project-memory writes are not automatic task-start behavior. Update memory only when workflow mode and explicit operator approval allow it.
- When updating memory, write durable current-state contracts only: module ownership, workflow invariants, commands, decisions, risks, and active unknowns. Do not write repeated task narratives, transient failures, or default task-id heading sections.
- Unknown or custom stack fallback: read `stack.md`, `commands.md`, and `module-map.md`, then inspect repository evidence instead of applying framework-specific assumptions.

## Integrity Priority Rules
- Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.
- Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.
- Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.
- Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.
- If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.

## Task Resume Protocol
- Apply this protocol whenever resuming an existing task in `IN_PROGRESS` or `IN_REVIEW`.
- Mandatory resume sequence:
  1. Re-read `AGENTS.md` routing and `00-core.md`.
  2. Re-read orchestration workflow (`live/skills/orchestration/SKILL.md`) and current task row in `TASK.md`.
  3. Re-read existing task evidence (`runtime/reviews/*`, `runtime/task-events/<task-id>.jsonl`) before new changes.
  4. Continue with full mandatory gates; resume never bypasses compile/review/completion gates.
- Final user report contract is mandatory on resume too.

## Mandatory Gate Contract
- Before running any specific gate command, run `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."` and execute only the single recommended command it prints.
- After that command completes, rerun the exact same `next-step` command. This loop also handles missing preflight artifacts, stale preflight scope, protected control-plane drift, full-suite enablement, and review dependency order.
- Task-mode entry command must pass before preflight or implementation:
  `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode`.
- If the likely task file list is already known before task-mode entry, pass repeated `--planned-changed-file` hints to `enter-task-mode`. When those hints include protected orchestrator paths and `--orchestrator-work` is missing, the gate must stop before preflight and print a rerun command with explicit `--orchestrator-work`; it must never auto-enable the flag silently.
- Agents cannot approve protected task-mode entry for themselves. Any command with `--orchestrator-work` or `--workflow-config-work` requires fresh operator approval, `--operator-confirmed yes`, and `--operator-confirmed-at-utc "<ISO-8601 timestamp>"`.
- Enter task mode with explicit runtime identity via `--provider "<provider>"`; add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned, and do not rely on canonical SourceOfTruth fallback.
- Task-mode entry must produce `runtime/reviews/<task-id>-task-mode.json` and task-timeline event `TASK_MODE_ENTERED`.
- Baseline downstream rules must be opened and recorded before preflight:
  `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --stage "TASK_ENTRY"`.
- Baseline rule-pack evidence must produce `runtime/reviews/<task-id>-rule-pack.json` and task-timeline event `RULE_PACK_LOADED`.
- Optional Markdown working plans live at `garda-agent-orchestrator/runtime/plans/<task-id>.md`. They are human-readable guidance only and do not replace the structured JSON task plan accepted by `enter-task-mode --plan-path`.
- Handshake diagnostics must pass after task-mode entry and before preflight:
  `node garda-agent-orchestrator/bin/garda.js gate handshake-diagnostics`.
- Handshake must fail closed when runtime identity is unresolved or the current runtime session does not attest launchable reviewer subagents.
- Handshake diagnostics must emit task-timeline event `HANDSHAKE_DIAGNOSTICS_RECORDED`.
- Shell smoke preflight must pass after handshake diagnostics and before preflight:
  `node garda-agent-orchestrator/bin/garda.js gate shell-smoke-preflight`.
- Shell smoke preflight must emit task-timeline event `SHELL_SMOKE_PREFLIGHT_RECORDED`.
- Treat `handshake-diagnostics -> shell-smoke-preflight -> classify-change` as one strict same-task chain. Do not parallelize these transitions; a newer `TASK_MODE_ENTERED` invalidates older handshake evidence, and a newer `HANDSHAKE_DIAGNOSTICS_RECORDED` invalidates older shell-smoke evidence.
- Preflight artifact must exist before review stage.
- Preflight classification must run with explicit `--output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"`.
- Preflight lifecycle telemetry must show `PREFLIGHT_STARTED` and then either `PREFLIGHT_CLASSIFIED` or `PREFLIGHT_FAILED`.
- Clean-tree preflight (`changed_files_count=0`) is baseline-only evidence, not task completion.
- Zero-diff implementation tasks must end in exactly one of these states before terminal status:
  - produced diff after implementation, then normal gate flow;
  - audited no-op recorded through `node garda-agent-orchestrator/bin/garda.js gate record-no-op --task-id "<task-id>" --reason "<rationale>"`;
  - explicit `BLOCKED` state explaining why no changes were produced.
- Legacy update compatibility wording: After preflight decides `required_reviews.*`, re-run `load-rule-pack --stage "POST_PREFLIGHT" --preflight-path ...`. Current contract: After preflight decides `required_reviews.*`, run the exact POST_PREFLIGHT command printed by `next-step`: `load-rule-pack --stage "POST_PREFLIGHT" --preflight-path ...` when rule files must be read, or `bind-rule-pack-to-preflight` when current-cycle rule files and hashes are unchanged and only evidence must be rebound.
- Treat `classify-change -> POST_PREFLIGHT rule-pack binding -> compile-gate` as one strict same-task chain. Do not parallelize these transitions; use `next-step` between them because a newer `PREFLIGHT_CLASSIFIED` invalidates older post-preflight rule-pack or compile attempts.
- A task may enter the test-first expected-red lane only when its `TASK.md` Notes contain the exact marker `Test-first: expected-red` and the current preflight is test-only. Follow the guarded `run-intermediate-command --expect-failure` command printed by `next-step`; it must bind a concrete changed focused test, the current preflight and scope hashes, the non-zero test exit, and the bounded output artifact. An unexpected pass, timeout, cancellation, unrelated test, foreign task, stale preflight, or modified evidence remains blocking. Once expected-red evidence is authenticated, `next-step` exposes implementation; after production files change, normal refreshed preflight, compile, full-suite, required reviews, and completion remain mandatory. Ordinary test-only tasks without the exact marker remain fail-closed.
- Compile gate command must pass before `IN_REVIEW`, but only run it when `next-step` reports `NextGate: compile-gate`:
  `node garda-agent-orchestrator/bin/garda.js gate compile-gate`.
- Compile lifecycle telemetry must show `IMPLEMENTATION_STARTED` before `COMPILE_GATE_PASSED`.
- Compile gate enforces preflight scope freshness; if scope drift is detected, rerun `next-step` and follow its refresh sequence instead of hand-authoring recovery flags.
- When preflight was created from planned `--changed-file` inputs in a clean workspace before implementation, this refresh is expected once the real diff exists; treat it as normal lifecycle recovery, not as an unexpected workflow failure.
- Compile gate validates post-preflight rule-pack evidence for the same task id and preflight artifact.
- Compile gate invocation must pass `fail_tail_lines` from `live/config/token-economy.json` (fallback `50`) to keep failure-output budget deterministic.
- Compile/review gate output compaction profiles are loaded from `live/config/output-filters.json`; invalid or missing config must warn and fall back to passthrough output instead of inventing filtered summaries.
- Shared gate-output compaction is independent of reviewer-context token economy scope; even with token economy disabled or at the default `depth=3` policy, compile/review gates still use `output-filters.json` and `fail_tail_lines`.
- Before each required reviewer invocation, run `node garda-agent-orchestrator/bin/garda.js gate build-review-context ...` for that review type.
- Reviewer preparation must emit `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` before the review gate can satisfy completion for code-changing tasks.
- After `prepare-reviewer-launch`, launch the real delegated reviewer with the exact generated handoff, then immediately run `record-reviewer-delegation-started` with provider/controller invocation id and launch-input evidence. `record-review-routing` and `prepare-reviewer-launch` may bind only the planned `agent:pending:<task-id>-<review-type>` identity; do not invent, reserve, hold, or pre-complete a provider reviewer identity before launch input exists.
- Downstream review preparation must follow the current-cycle dependency graph from `preflight.review_execution_policy`; do not start `test` until every required upstream dependency for the active policy has an accepted findings receipt with findings-satisfied state.
- Downstream reviewer dependencies are launch blockers, not only materialization blockers. Do not spawn or pre-launch a dependent downstream reviewer as an exploratory pass, early signal, or parallel sidecar before the required upstream accepted findings receipt reports findings-satisfied for the same cycle.
- Known producer-consumer validation flows are launch blockers too. Do not fan out raw shell commands such as `npm run build:node-foundation` and direct `node --test .node-build/...` in parallel; use the guarded workflow path or run producer then consumer strictly sequentially.
- If a later cycle changes only test scope, still run `build-review-context` for reusable upstream `code` review first so current-cycle reuse evidence exists before `test` review starts.
- Required reviews must be launched only from preflight `required_reviews.*`.
- Parallel reviewer fan-out is allowed only between independent required review types with no dependency edge for the current cycle.
- Review gate command must pass before `DONE`:
  `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check`.
- Explicit `--*-review-verdict` flags are historical compatibility only. New cycles omit them and the review gate derives required lane state from validated findings receipts and locked dispositions for `preflight.required_reviews`.
- `required-reviews-check` validates current-cycle artifacts, receipts, review-context bindings, findings satisfaction, and disposition evidence, and must not auto-pick a stale historical result from `runtime/reviews/`.
- Review gate command validates compile evidence (`COMPILE_GATE_PASSED`) from task timeline for the same task id.
- Review gate command validates task-mode entry evidence (`TASK_MODE_ENTERED`) for the same task id.
- Review gate command validates post-preflight rule-pack evidence (`RULE_PACK_LOADED`) for the same task id and preflight artifact.
- Review gate command validates no workspace drift after compile evidence; post-compile edits require compile gate rerun.
- Review gate rejects zero-diff implementation tasks unless an audited no-op artifact exists for the same task id.
- Missing prior focused-validation evidence alone is never a reviewer finding. Only when that absence is the prospective concern, every built-in or custom reviewer first runs the smallest safe relevant local check for exactly one repository target file with no unrelated or directory target, within authenticated scope, and records its exact command, outcome, and concrete non-placeholder diagnostics in `validation_notes`; authenticated changed-file evidence must name that exact target, and shell command chaining, substitution, and expansion are prohibited. A passing check produces no finding; a failed check or exposed defect is reported normally, links `finding_ids` to the exact ordinary defect finding, and shares at least one exact changed-file evidence location with each linked finding. For an unavailable or prohibited attempt, reserved id F-000 requires either its title or description to equal `[garda:evidence-only:missing-focused-validation] test=<exact-repository-relative-test-path>; action=run-and-record-focused-test` or `[garda:evidence-only:missing-focused-validation] target=<exact-repository-relative-validation-path>; action=run-and-record-focused-validation`, replacing only the angle-bracketed path. The reviewer must not invoke Garda or descendants: after inspecting scope, optionally performing that narrow check, and writing exactly one review JSON object, it stops. After an authenticated F-000 receipt, the main agent may run that exact check with `gate run-intermediate-command` and follow `next-step`; verified post-review evidence restarts the same review scope without a fake implementation edit and does not replace compile, full-suite, or review PASS evidence.
- Documentation impact gate command must pass before `DONE`:
  `node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate`.
- `doc-impact-gate` is a closeout gate after required review PASS. Reviewers assess whether the scoped documentation and changelog changes are sufficient, but must not fail solely because the downstream task-owned doc-impact artifact has not yet been materialized.
- Full-suite validation gate must run before `completion-gate` when enabled:
  `node garda-agent-orchestrator/bin/garda.js gate full-suite-validation --task-id "<task-id>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --repo-root "."`.
- Full-suite validation is controlled by `garda-agent-orchestrator/live/config/workflow-config.json` (`full_suite_validation.enabled` and `full_suite_validation.placement`). Operators may edit that file directly or use the repo-local CLI surface (`garda workflow show`, `garda workflow set --full-suite-enabled true|false --full-suite-placement <after_compile_before_reviews|before_test_review|before_completion>`); do not introduce setup/init/reinit questions for this mode.
- `garda workflow set` is a guarded workflow-config mutation surface and requires separate explicit operator approval with `--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`; agents must not approve workflow-config mutations for themselves.
- Review-cycle `allow_one_more_cycle` uses `gate record-review-cycle-continuation` and is task-scoped one-shot runtime evidence. Do not implement it by changing `workflow-config.json`; permanent `raise_limits` choices must go through audited `garda workflow set`.
- Full-suite placement modes are lifecycle routing controls: `after_compile_before_reviews` runs the suite after compile before any reviewer launch, `before_test_review` blocks only the `test` reviewer until current suite evidence exists, and `before_completion` leaves reviewer context neutral while completion still enforces full-suite evidence later.
- Optional quality checks are advisory self-check rules controlled by `workflow-config.json` `optional_quality_checks`. They are default-enabled and routed by `next-step` after implementation changes exist, normally before compile/review/full-suite work, so agents can address simplification, style fit, hardcoding, duplication, unnecessary abstraction, growth, and verification-scope issues before expensive gates.
- A newly materialized quality-checklist answers file is an editable scaffold, not runnable evidence. Complete every active answer and any rule-specific required fields, then rerun `next-step`; only execute the `quality-checklist` command after the navigator prints it for the validated answers file.
- `quality-checklist` `ACTION_REQUIRED` means the implementation agent must return to the implementation/refactor step and address the listed follow-up before continuing to compile, review, or full-suite validation. `PASS` continues the normal lifecycle, and disabled mode skips only this advisory gate.
- Optional quality checks never certify correctness and never replace compile-gate, full-suite validation, or delegated independent review. Operators may disable the gate or customize individual rules only through the audited workflow-setting path (`garda workflow set --optional-checks-enabled ...` or `--optional-check-rule-*`, including the guarded local UI).
- When enabled, `completion-gate` requires a full-suite-validation artifact with status `PASSED` or `WARNED` (AUDIT_AND_WARN policy). Status `FAILED` blocks completion.
- When disabled (default), `full-suite-validation` emits `SKIPPED` and `completion-gate` does not require the artifact.
- `AUDIT_AND_WARN` policy with out-of-scope-only failures produces status `WARNED`, exits 0, and does not block completion. The warning is audited in the artifact and timeline.
- `AUDIT_AND_BLOCK` policy with out-of-scope failures produces status `FAILED` and blocks completion.
- Completion gate command must pass before `DONE`:
  `node garda-agent-orchestrator/bin/garda.js gate completion-gate`.
- After `COMPLETION_GATE_PASSED`, run `node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>" --as-json`; the gate now materializes canonical closeout artifacts at `runtime/reviews/<task-id>-final-closeout.json` and `runtime/reviews/<task-id>-final-closeout.md`. Use those artifacts instead of reconstructing the final closeout order free-form.
- Completion gate validates task-mode entry evidence, post-preflight rule-pack evidence, compile evidence, review-gate evidence, doc-impact evidence, full-suite-validation evidence (when enabled), ordered lifecycle evidence (`TASK_MODE_ENTERED`, `RULE_PACK_LOADED`, `PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `COMPILE_GATE_PASSED`, `REVIEW_PHASE_STARTED`, review pass evidence), review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`), best-effort task-event hash-chain integrity, required findings receipts, locked dispositions, follow-up materialization, and selective-remediation evidence.
- Completion gate rejects zero-diff implementation tasks unless the task has later produced a real diff or an audited no-op artifact exists at `runtime/reviews/<task-id>-no-op.json`.
- New-cycle reviewers return every finding and residual risk without a verdict or disposition. Completion requires every `fix_now` item resolved, every `create_follow_up` item materialized, and every ignored item retained in auditable locked disposition evidence.
- Review contexts with schema version 3 or newer bind a deterministic `Coverage Ledger` covering every changed file, generated behavior boundary, and applicable review category. Every obligation must appear exactly once with concrete changed-file `path:line` evidence and an evidence-backed `finding` or `no-finding` result before either PASS or FAIL can be recorded.
- Every active finding in a schema-version-3 review must have one stable identifier such as `[F-001]` and be referenced by at least one coverage obligation. Missing, duplicate, unknown, generic, or unresolved ledger entries reject receipt recording; there is no minimum finding count and reviewers must not invent or pad findings.
- Remediation reviews regenerate and complete the same deterministic current-scope coverage contract. Final task audit reports completed and omitted obligations so broad self-attestation cannot substitute for auditable scope coverage.
- Task timeline log must be updated for lifecycle stages and gate outcomes:
  `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`.
- The runtime auto-emits task-start and stage-transition events such as `PLAN_CREATED`, `PREFLIGHT_STARTED`, `IMPLEMENTATION_STARTED`, `REVIEW_PHASE_STARTED`, `STATUS_CHANGED`, `PROVIDER_ROUTING_DECISION`, gate pass/fail markers, and terminal completion markers.
- When an orchestrator defect is encountered or fixed during another task, immediately append `ORCHESTRATOR_DEFECT_ACKNOWLEDGED` with `details.defect_id`, `summary`, `resolution` (`fixed_in_current_task` or `deferred_to_follow_up`), `problem_record_id`, and `follow_up_task_id`. Permission to fix the defect in place does not waive durable capture.
- The referenced follow-up must exist as a canonical `TASK.md` row, and the workspace-owned orchestrator-problems section must contain one record that links `problem_record_id` to `follow_up_task_id`. Final task audit blocks an acknowledged defect whose durable record or follow-up is missing. Timelines without an acknowledgement remain read-only compatible and report `encountered=unknown` rather than inventing a no-defect assertion.
- Task-event writers must use best-effort append locking for both per-task log and aggregate `all-tasks.jsonl`; do not rely on unsynchronized raw append for concurrent runs.
- Task-event integrity is procedural hardening only: local hash-chain and replay detection help detect tampering after the fact, but they are not a security-grade trust anchor.
- Task timeline completeness is surfaced in `status` and `doctor`; incomplete timelines are a real workflow defect, not optional trace noise.
- Orchestrator control-plane files (`TASK.md`, `garda-agent-orchestrator/runtime/**`, and internal docs such as `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md`) are local workflow artifacts; in deployed workspaces their ignored status is normal.
- Terminal non-active statuses (`DONE`, `BLOCKED`, `SPLIT_REQUIRED`, `DECOMPOSED`) require full cleanup of temporary reviewer/specialist logs after required artifacts are persisted.
- Gate-owned status sync is the only normal updater for active lifecycle status cells. Final reporting must not ask the implementation agent to manually synchronize `TASK.md` status; stale queue-vs-gate diagnostics should name the gate evidence or explicit operator reset/discard command.
- Documentation impact updates are required when behavior/contracts/ops docs changed.
- Required changelog or evidence updates to ignored orchestrator paths must stay local on disk; do not use `git add -f` unless the user explicitly requests versioning orchestrator internals.
- Final user report order is mandatory: short agent-authored summary of what changed -> verbatim Garda final user report from `runtime/reviews/<task-id>-final-user-report.md` -> conventional-style `git commit -m "<type>(<scope>): <summary>"` suggestion when committable changes exist -> `Do you want me to commit now? (yes/no)` when committable changes exist.
- The Garda final user report artifact is generated by `task-audit-summary`; do not reinterpret, summarize, reorder, or rewrite it. The implementation agent may add only the short summary before the verbatim artifact text.
- When `next-step` prints `CopyPasteFinalUserReport`, paste `CopyPasteFinalUserReport` exactly as printed, without code fences, wrappers, paraphrase, interpretation, summarization, or reformatting.
- The user-facing final report must not paste the full final-closeout markdown or duplicate every canonical closeout section. Treat `*-final-closeout.*`, `*-final-user-report.md`, and the gate-owned `CopyPasteFinalUserReport` block as the source of truth; final delivery must not add commit readiness or extra review-integrity prose outside the generated artifact. Commit command suggestions and commit permission questions are allowed only after the verbatim generated report and only when `next-step` lists them in `FinalReportOrder`.
- At `depth=1` and `depth=2`, the implementation summary must include an output-compaction line; at `depth=3` it is optional. Use chars as the primary unit, keep approximate percentage when baseline is known, keep spaced breakdown formatting, and include token estimate only as a secondary note when available: `Suppressed output: ~3528 chars (~67%) (code review context ~3296 chars + DB review context ~100 chars + compile gate output ~132 chars). Token estimate: ~882.`
- Reviewer and specialist agents must be closed after findings receipt persistence.
- HARD STOP: do not skip `enter-task-mode`; compile/review/completion evidence is invalid without explicit task-mode entry.
- HARD STOP: do not skip `load-rule-pack`; reading the top-level router alone is not enough to prove downstream rule loading.
- HARD STOP: do not continue a normal task run when the workspace already had modified files before `enter-task-mode`; isolate scope first with staged or explicit preflight inputs.
- HARD STOP: do not launch required reviewers without `build-review-context`; completion requires review-skill telemetry.
- HARD STOP: do not force-stage ignored orchestration control-plane files just because gates, changelog, or reviews reference them.
- HARD STOP: do not set or hand-edit the `TASK.md` status to `DONE` until completion gate is `COMPLETION_GATE_PASSED`, every review finding is either resolved or explicitly deferred with `Justification:`, and the generated final user report is delivered in mandatory order; completion finalization performs the normal queue sync.
- HARD STOP: any mandatory gate/tooling failure (`Unknown gate`, missing CLI, build dependency errors, stale bundle mismatch) forces an immediate `BLOCKED` state. Broken infrastructure is not a license to continue implementation or bypass the orchestrator.
- HARD STOP: do not use agent-authored scripts to batch, loop over, or "green-light" orchestrator gates or to write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.
- HARD STOP: do not fabricate review artifacts, receipts, routing metadata, telemetry, task statuses, or claims that a task is commit-ready when the required gate evidence is absent.
- If compile command or workflow infra files are hotfixed inside current task, scope is expanded and full re-run is mandatory: preflight -> compile gate -> required reviews gate -> doc impact gate -> completion gate.

## Escape Hatch Contract
- Audited skip-review override is allowed only through gate script parameters.
- Current supported override scope:
  - only code review,
  - only tiny low-risk scope,
  - mandatory explicit reason,
  - mandatory override artifact.
- DB, security, and refactor mandatory reviews are never skippable by override.

## Reviewer Independence
- Mandatory reviews must be spawned as fresh-context sub-agents on every provider. The implementation agent must not satisfy a required review in-place.
- Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence. Reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence.
- After the review receipt is persisted by `record-review-result` or `record-review-receipt`, close or release the reviewer sub-agent session.
- Provider launch contract:
  - Codex: use sub-agents with isolated review context.
  - Cursor: use delegated reviewer sub-agents with isolated context.
  - Claude Code: use Agent tool/sub-agents with `fork_context=false`.
  - Gemini: use delegated reviewer sub-agents with isolated context.
  - Qwen: use delegated reviewer sub-agents with isolated context.
  - GitHub Copilot CLI: use `task` tool with `agent_type="general-purpose"` (one reviewer per isolated task run).
  - Windsurf: use delegated reviewer sub-agents with isolated context.
  - Junie: use delegated reviewer sub-agents with isolated context.
  - Antigravity: use delegated reviewer sub-agents with isolated context.
  - Providers or bridges without delegated reviewer support are not eligible to satisfy the mandatory review workflow until delegated launch support exists.
- If runtime identity is missing, contradictory, still relies on canonical SourceOfTruth fallback, or does not attest launchable reviewer subagents, rerun `enter-task-mode` with explicit runtime identity before `handshake-diagnostics` or `build-review-context`.
- Launch required reviewers in dependency order. If `test` depends on a current-cycle upstream `code` result, finish the upstream accepted findings receipt and findings-satisfied materialization before any downstream reviewer launch.
- Reviewer execution mode must be recorded in review receipts and telemetry:
  - `reviewer_execution_mode`: `delegated_subagent`.
  - `reviewer_identity`: provider-assigned reviewer id with `agent:` scope.
  - Historical `same_agent_fallback` receipts may be read for diagnostics only; they do not satisfy a fresh mandatory review cycle.
  - Gate diagnostics must explain whether each review has valid delegated fresh-context execution evidence.

## Remediation Review Modes
- `reviewer_execution_mode` remains `delegated_subagent`; `review_execution_mode` independently records review scope as `FULL` or `DELTA`.
- The first accepted review for every effective lane is always `FULL`. `DELTA` is bounded repair verification chained to authenticated exhaustive coverage, never an initial or standalone review.
- A workspace profile enables `DELTA` only by explicitly declaring a valid schema-2 `review_remediation_mode_policy`. Profiles without that field and schema-1 policies that have not passed through init migration, including legacy workspaces, resolve fail-closed to `FULL`-only behavior.
- The immutable task profile snapshot owns the mode policy for the active lifecycle. Editing profile configuration never changes an already locked task snapshot.
- Every built-in review lane is eligible for `DELTA` by default under schema 2. A profile may add custom review-catalog lanes by stable lowercase kebab-case ID or remove individual lanes from `delta_eligible_review_types`, including all lanes, to force only those lanes to `FULL`. Eligibility remains bounded by configured file/line/consecutive-review limits and requires unchanged task criteria, policy, catalog, dependency graph, full-scope membership, and authenticated baseline lineage.
- Ambiguous or global impact, generated churn, protected control-plane/policy changes, API/auth/security/database/schema/dependency/infrastructure/secret/lockfile boundaries, unavailable impact, oversized changes, periodic-full thresholds, stale or tampered evidence, and dependency invalidation force `FULL`.
- A `DELTA` context carries exact remediation targets plus complete prior-scope lineage. Findings outside the delta remain preserved until authenticated reconciliation resolves or disposition-locks them.
- Status, profile output, stats, receipts, and task-audit reports expose the configured/legacy policy state and observed `FULL`/`DELTA` modes. These are diagnostics over gate-owned contracts, not alternate routing authority.
- For new cycles, validated findings plus locked disposition state form the release gate; reviewer-authored verdicts are forbidden.
- Historical verdict tokens remain readable for audit-only compatibility:
  - code: `REVIEW PASSED`
  - db: `DB REVIEW PASSED`
  - security: `SECURITY REVIEW PASSED`
  - refactor: `REFACTOR REVIEW PASSED`
  - optional specialist verdicts when enabled and required:
    - api: `API REVIEW PASSED`
    - test: `TEST REVIEW PASSED`
    - performance: `PERFORMANCE REVIEW PASSED`
    - infra: `INFRA REVIEW PASSED`
    - dependency: `DEPENDENCY REVIEW PASSED`

## BLOCKED Semantics
- `BLOCKED` means pipeline is paused; no next stage may start.
- Resume only after explicit blocking condition resolution.
- Record `blocked_reason_code` in `TASK.md` notes or task-event diagnostics. Do not hand-edit the active status cell to `BLOCKED` as a substitute for a failed mandatory gate or explicit operator decision.
- For infrastructure-driven blocks, you must report: the exact command, `cwd`, chosen CLI path, and `stderr`.

## DECOMPOSED Semantics
- `SPLIT_REQUIRED` means a scope-budget guard, review-cycle auto-split guard, or strict decomposition `split-required` decision latched the parent task before ordinary continuation. Do not run classify, compile, review, full-suite, completion, or final closeout gates on a `SPLIT_REQUIRED` parent.
- A `SPLIT_REQUIRED` parent clears only when linked child tasks are added so `next-step` can transition it to `DECOMPOSED`, or when an explicit operator reset/discard command clears the task.
- `DECOMPOSED` means the parent task was intentionally split because scope-budget, review-cycle, or strict-decomposition guardrails made the monolithic lifecycle too large.
- A `DECOMPOSED` parent is not an executable lifecycle scope: do not run classify-change, compile, review, full-suite, or completion gates on the parent.
- `next-step` must route a `DECOMPOSED` parent to the next unfinished child task; nested decomposed parents should resolve to the next unfinished leaf child.
- Before entering a routed decomposed child task, inspect `workflow-config.full_suite_validation.command` against that child scope. If it still includes suspended sibling tests, update it only through the audited workflow-config route before `enter-task-mode`; keep current-child tests covered, exclude suspended siblings, and leave an already-suitable command unchanged.
- Existing legacy `BLOCKED` rows whose notes clearly say "Paused for split", "Split into ...", or "Continue via child tasks" may be treated compatibly as decomposed parents until a safe migration updates the status cell.
- When review-cycle auto split is enabled, the guard should move the parent to `SPLIT_REQUIRED`; the agent should create maximally small child tasks, rerun `next-step` on the parent so the gate transitions it to `DECOMPOSED`, and execute those children through normal gates.
- For a strict decomposition `split-required` decision, linked children must match the decision artifact: each proposed child id is explicitly linked from parent notes, exists as a `TASK.md` row, is parent-derived, and uses profile `strict`. Extra linked parent-derived children outside the artifact, missing child rows, non-parent-derived child ids, or non-strict profiles keep the parent blocked instead of relaxing strictness.
