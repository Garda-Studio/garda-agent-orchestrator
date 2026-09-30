---
name: orchestration
description: Execute a task end-to-end with deterministic gates, preflight classification, depth control, and required independent reviews. Use for requests like "execute task", "run task", "implement task", "finish task T-00X", or "do task N". Do NOT use for standalone specialist review requests without implementation workflow.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Edit
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  runtime_requirement: Node.js 24 baseline for public CLI and gate commands
---

# Orchestration

This file is the canonical execution workflow.
Rule files provide policy context, but lifecycle steps and gate order are defined here.
Canonical gate surface is `node garda-agent-orchestrator/bin/garda.js gate <name>`.
Default task navigator is `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`; run it before the first gate, after every suggested command, and after any gate failure. The numbered workflow below defines policy and allowed gates, but `next-step` owns the executable next command.

## Findings-Only Review Lifecycle
- Every new review cycle uses the exact generated role prompt, prompt template, output template, and evidence manifest. The reviewer returns one findings-only JSON object to the exact `ReviewOutputPath` and never chooses a verdict, disposition, follow-up, or remediation action.
- `record-review-result` validates the schema and coverage ledger, applies the task's immutable finding policy, materializes required F-tasks or remediation baseline evidence, and derives the lane result. An accepted empty-findings report must not be blocked for omitted reviewer-owned decision fields.
- Failed `fix_now` remediation is classified from the authenticated baseline. The snapshotted rerun policy selects focused, focused-plus-affected, or ordinary validation and invalidates only affected review lanes. `next-step` remains the only executable navigator.
- Verdict-oriented Markdown and explicit verdict flags described later in this file are compatibility surfaces for historical artifacts only; they must never be requested from a reviewer or used to construct a new-cycle result.

## Required Inputs
- User request.
- Current task queue: `TASK.md`.
- Active source-of-truth entrypoint selected for this workspace.
- Relevant rule files from `garda-agent-orchestrator/live/docs/agent-rules/`.
- Token economy config: `garda-agent-orchestrator/live/config/token-economy.json`.

## Execution Depth
- Supported: `depth=1`, `depth=2`, `depth=3`.
- Default: `depth=2`.
- Depth controls context budget and validation thoroughness only.
- Mandatory gates are never optional because of depth.
- Escalation:
  - `FULL_PATH` => minimum `depth=2`
  - required `db/security/refactor` review => minimum `depth=2`
  - high-risk auth/payment/data/infra changes => prefer `depth=3`

## Token Economy
- Config source: `garda-agent-orchestrator/live/config/token-economy.json`.
- Activate reviewer-context compaction only when `enabled=true` and effective depth is in `enabled_depths`.
- Shared gate output filters from `garda-agent-orchestrator/live/config/output-filters.json` stay active regardless of reviewer-context token-economy state.
- Default: keep `enabled=true` with `enabled_depths=[1,2]`; at these depths reviewer context is compacted and token-economy savings are reported in the implementation summary.
- Recommendation when reviewer-context token economy is enabled: use `enabled=true` with `depth=1` only for small, well-localized tasks; prefer `depth=2` or `depth=3` when correctness depends on broader context.
- Short-form `depth=1` guidance is available at `garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md`. If your client supports targeted skill loading, prefer that short form over the full orchestration skill when effective depth stays at `1` and no escalation trigger fires.
- Depth-aware reviewer context loading when active:
  - `depth=1`: load task goal, changed files, required review flags, and minimal diff context only.
  - `depth=2`: load `depth=1` context plus required checklists and only relevant rule sections.
  - default `depth=3` policy: use full reviewer context.
  - if a deployment explicitly includes `3` in `enabled_depths`, keep the full reviewer context and allow only non-scope-reducing compaction (for example stripped examples/code blocks or compact reviewer output).
- Depth-aware reviewer rule-pack contract when active:
  - `code` reviewer:
    - `depth=1`: `00-core.md`, `80-task-workflow.md`, plus rule ids/snippets directly triggered by changed scope.
    - `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `50-structure-and-docs.md`, `70-security.md`, `80-task-workflow.md`.
  - `db` reviewer:
    - `depth=1`: `00-core.md`, `80-task-workflow.md`, plus DB-triggered rule ids/snippets.
    - `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `70-security.md`, `80-task-workflow.md`.
  - `security` reviewer:
    - `depth=1`: `00-core.md`, `80-task-workflow.md`, plus security-triggered rule ids/snippets.
    - `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `70-security.md`, `80-task-workflow.md`.
  - `refactor` reviewer:
    - `depth=1`: `00-core.md`, `80-task-workflow.md`, plus refactor-triggered rule ids/snippets.
    - `depth=2`: `00-core.md`, `30-code-style.md`, `35-strict-coding-rules.md`, `50-structure-and-docs.md`, `80-task-workflow.md`.
  - default `depth=3` policy or token economy disabled: full reviewer rule packs.
  - if a deployment explicitly includes `3` in `enabled_depths`, keep full reviewer rule packs and allow only non-scope-reducing compaction.
- Context trimming when active:
  - `strip_examples=true`: remove examples from generated reviewer rule-context markdown snapshot.
  - `strip_code_blocks=true`: remove code blocks from generated reviewer rule-context markdown snapshot.
- Scoped diff contract when active:
  - if `scoped_diffs=true` and reviewer type is `db`, `security`, or `refactor`, generate scoped artifact before reviewer launch:
    - Node: `node garda-agent-orchestrator/bin/garda.js gate build-scoped-diff --review-type "<db|security|refactor>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.diff" --metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json"`
  - helper resolves trigger regexes from `garda-agent-orchestrator/live/config/paths.json` `triggers.<review-type>`.
  - if helper reports `fallback_to_full_diff=true`, pass full diff to reviewer and continue required review.
- Review-context artifact contract when active:
  - generate reviewer context artifact before reviewer launch:
    - Node: `node garda-agent-orchestrator/bin/garda.js gate build-review-context --review-type "<review-type>" --depth "<1|2|3>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --scoped-diff-metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json"`
  - JSON artifact must record selected rule pack, omitted sections, `deferred_by_depth` reason when applicable, scoped-diff fallback evidence, and nested `rule_context.*` metadata for the generated markdown snapshot.
  - sibling markdown snapshot (`rule_context.artifact_path`) is the preferred prompt payload for reviewer rule text when token economy mode is active.
- Compact reviewer output contract when active:
  - if `compact_reviewer_output=true`, keep the complete findings-only JSON schema and coverage ledger while shortening only free-text evidence.
  - on failed command/test evidence, cap pasted tail output to `fail_tail_lines`.
  - review/completion gates audit compactness best-effort and emit warnings when reviewer artifacts exceed compact budgets.

## Task Resume Protocol
- When resuming a task already in `IN_PROGRESS` or `IN_REVIEW`, treat resume as full orchestration execution.
- Mandatory resume sequence:
  1. Re-read `AGENTS.md` routing, `00-core.md`, and this orchestration skill before any edits.
  2. Re-open current task row in `TASK.md` and latest artifacts in `runtime/reviews/` plus timeline `runtime/task-events/<task-id>.jsonl`.
  3. Run `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."` and follow only its single recommended command.
  4. Continue from current stage, but do not skip compile/review/completion gates.
  5. Final report contract remains mandatory on resume: review integrity attestation -> implementation summary -> commit command -> explicit commit question.

## Task Start Contract
- The canonical user command is: ``Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.``
- Active profile selection comes from `garda-agent-orchestrator/live/config/profiles.json` and the `TASK.md` `Profile` column; do not present `depth=<1|2|3>` as normal user task-start guidance.
- At fresh main-agent task start, show one English start marker from the repo-owned list (`Garda captures my mind` or `Garda rewrites my code`) once in the first relevant reply; this UX marker is not gate evidence.
- Do not use start-marker presence or exact text as hard evidence for task-mode, compile, review, completion, or task-audit gates.
- Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.
- If the workspace already contains modified files before task-mode entry and the run is not isolated through staged or explicit scope, stop and treat the start as invalid.

## Canonical Workflow
1. Select highest-priority `TODO` task in `TASK.md`; successful `enter-task-mode` reconciles it to `IN_PROGRESS`.
2. If no `TODO` exists, create a task from current user request; successful `enter-task-mode` then reconciles it to `IN_PROGRESS`.
3. Resolve requested depth and record requested/effective depth in non-status `TASK.md` notes.
4. Run the default navigator and repeat it after every command:
   - Node: `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`
   - Do not start with `compile-gate`, infer default config flags, or choose a gate from this static list unless `next-step` prints it as the single recommended command.
5. Enter task mode explicitly before preflight when `next-step` requests it:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "<EXPLICIT_TASK_EXECUTION|TASK_CREATED_FROM_REQUEST>" --requested-depth "<1|2|3>" --task-summary "<task summary>"`
   - `enter-task-mode` writes task-scoped event `TASK_MODE_ENTERED` automatically and persists `runtime/reviews/<task-id>-task-mode.json`.
   - Enter task mode with explicit runtime identity via `--provider "<provider>"`; add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned, and do not rely on canonical SourceOfTruth fallback.
6. Record baseline downstream rules explicitly before preflight when `next-step` requests it:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md"`
   - `load-rule-pack` writes task-scoped event `RULE_PACK_LOADED` automatically and persists `runtime/reviews/<task-id>-rule-pack.json`.
7. Build a concise execution brief from existing TASK.md intent: goal, done_when (observable result), verification, scope/files and material risks. No separate file is required for an ordinary small task.
   - When JSON is attached, read and reuse its `goal`, `acceptance_criteria`, `verification_expectations`, `out_of_scope`, `scope_files` and `validation_strategy`; do not duplicate criteria into a competing artifact.
   - Legacy plans may omit optional criteria fields; use existing task intent and the brief without a new gate, retrospective artifact or profile change.
   - Record assumptions as `none` or a concise list in existing plan `notes` or the brief. Make ordinary implementation choices within authorized scope; no mandatory question or approval is required for every plan.
   - Resolve material ambiguity affecting user-visible behavior, authorization or scope from authoritative task context or a focused operator question before dependent work; independent investigation or work may continue.
   - Prepared plans freeze after task start. A newly discovered requirement incompatible with authorized active scope needs an explicit follow-up and scope or authorization resolution before dependent work; do not silently rewrite the active plan.
   - A ready plan or brief records intent. Actual command outcomes and accepted review receipts establish completion evidence; existing lifecycle gates remain authoritative.
   - `enter-task-mode` auto-emits `PLAN_CREATED`; do not backfill it manually unless recovery tooling explicitly requires it.
8. Run handshake diagnostics after task-mode entry and baseline rule-pack loading when `next-step` requests it:
   - canonical invocation: `node garda-agent-orchestrator/bin/garda.js gate handshake-diagnostics ...`.
   - Handshake must fail closed when runtime identity is unresolved or the current runtime session does not attest launchable reviewer subagents.
9. Run shell smoke preflight after handshake diagnostics when `next-step` requests it:
   - canonical invocation: `node garda-agent-orchestrator/bin/garda.js gate shell-smoke-preflight ...`.
10. Run preflight with explicit `--output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"` when `next-step` requests it:
   - `classify-change` with repeated `--changed-file` for precise scope, or
   - `--use-staged` in dirty workspaces.
   - canonical invocation: `node garda-agent-orchestrator/bin/garda.js gate classify-change ...`.
   - `classify-change` writes task-scoped event `PREFLIGHT_STARTED` first, then `PREFLIGHT_CLASSIFIED` on success or `PREFLIGHT_FAILED` on failure.
11. Apply depth escalation from preflight output when required.
12. Refresh downstream rule-pack evidence for the actual required review set when `next-step` requests it:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "POST_PREFLIGHT" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --loaded-rule-file "<opened-rule-file>"`
   - When `next-step` prints `bind-rule-pack-to-preflight`, run that command instead; it is allowed only for unchanged current-cycle rule files and hashes where evidence needs a new preflight binding.
   - `load-rule-pack` must include every downstream rule file actually opened after preflight, including risk-specific rule packs required by the selected reviews.
   - This step is order-dependent: do not parallelize it with `classify-change` or `compile-gate` for the same task cycle.
13. Execute implementation path:
   - `FULL_PATH` runtime => tests first, then implementation.
   - non-runtime or `FAST_PATH` runtime => objective validations, then implementation.
14. Run compile gate (mandatory) before review phase only when `next-step` reports `NextGate: compile-gate`:
   - Resolve `fail_tail_lines` from `garda-agent-orchestrator/live/config/token-economy.json`; when missing/invalid, fallback to `50`.
   - Gate output filter profiles are loaded from `garda-agent-orchestrator/live/config/output-filters.json`; invalid config must warn and fall back to passthrough output.
   - Node: `node garda-agent-orchestrator/bin/garda.js gate compile-gate --task-id "<task-id>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --fail-tail-lines "<fail_tail_lines>"`
   - Compile gate auto-emits `IMPLEMENTATION_STARTED` before execution and then writes `COMPILE_GATE_PASSED` or `COMPILE_GATE_FAILED`.
   - Compile gate is strict about preflight scope freshness and fails on scope drift; rerun `next-step` and follow its refresh sequence when scope changes.
   - A newer `PREFLIGHT_CLASSIFIED` also invalidates older post-preflight rule-pack evidence; rerun downstream gates sequentially instead of overlapping the same task cycle.
   - If preflight was created from planned `--changed-file` inputs in a clean workspace before implementation, that refresh is expected once the real diff exists.
   - On failure, do not move to review phase; fix and rerun until pass.
15. After `COMPILE_GATE_PASSED`, let the successful review-gate flow reconcile the task to `IN_REVIEW`; do not hand-edit that transition.
16. Before each required independent review, run `build-review-context` for that review type only when `next-step` names it.
   - Node: `node garda-agent-orchestrator/bin/garda.js gate build-review-context --review-type "<review-type>" --depth "<1|2|3>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --scoped-diff-metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json"`
   - This step is mandatory even when token economy is inactive because it auto-emits `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED`.
17. Run only required independent reviews from preflight:
    - mandatory on every provider: clean-context delegated reviewer sub-agents with isolated review context.
    - same-agent fallback does not satisfy the mandatory review workflow.
    - if the current runtime session cannot launch delegated reviewers, stop and treat the task as blocked until delegated review support exists.
    - if runtime identity is missing, contradictory, still relies on canonical SourceOfTruth fallback, or does not attest launchable reviewer subagents, rerun `enter-task-mode` with explicit runtime identity before `handshake-diagnostics` or `build-review-context`.
    - baseline: `code`, `db`, `security`, `refactor`
    - optional when enabled in `garda-agent-orchestrator/live/config/review-capabilities.json`: `api`, `test`, `performance`, `infra`, `dependency`
    - when token economy mode is active, generate review-context artifact and attach both the JSON metadata artifact and its `rule_context.artifact_path` markdown snapshot to the reviewer prompt.
    - when `scoped_diffs=true` and required reviewer is `db`, `security`, or `refactor`, run scoped diff helper and attach scoped artifact path plus scoped metadata fallback flag to reviewer prompt.
    - Log event per reviewer invocation: `REVIEW_REQUESTED`.
18. Run `required-reviews-check` and treat result as release gate when `next-step` requests it.
   - `required-reviews-check` writes task-scoped event `REVIEW_GATE_PASSED` or `REVIEW_GATE_FAILED` automatically.
   - `required-reviews-check` fails if explicit task-mode entry evidence is missing (missing `TASK_MODE_ENTERED` / missing `runtime/reviews/<task-id>-task-mode.json`).
   - `required-reviews-check` fails if post-preflight rule-pack evidence is missing (missing `RULE_PACK_LOADED` / missing `runtime/reviews/<task-id>-rule-pack.json`).
   - `required-reviews-check` fails if compile evidence is missing in `runtime/task-events/<task-id>.jsonl` (missing `COMPILE_GATE_PASSED`).
   - `required-reviews-check` fails if workspace changed after compile evidence; rerun compile gate after post-compile edits.
   - Explicit `--*-review-verdict` flags are historical CLI compatibility only; new-cycle lane state comes from validated findings receipts and locked dispositions.
   - This defaulting is only a contract convenience; the gate still validates current-cycle artifacts, receipts, review-context bindings, and exact pass tokens, and must not auto-scan `runtime/reviews` for a convenient PASS.
19. Resolve every `fix_now` finding before `DONE`; materialize required follow-ups, preserve ignored-item audit evidence, and repeat only the review lanes selected by the snapshotted remediation policy until every required findings receipt is satisfied.
   - blocking findings must be fixed before rerun.
   - non-blocking findings and residual risks may proceed only through their locked `create_follow_up` or `ignore` disposition evidence; reviewers do not defer them in prose.
   - On failed gate and return to coding, log event: `REWORK_STARTED`.
20. Run doc impact gate before completion when `next-step` requests it:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --decision "<NO_DOC_UPDATES|DOCS_UPDATED>" --behavior-changed "<true|false>" --changelog-updated "<true|false>" --rationale "<why>"`
   - Doc impact gate writes task-scoped event `DOC_IMPACT_ASSESSED` or `DOC_IMPACT_ASSESSMENT_FAILED`.
21. Run full-suite validation gate when `next-step` requests it; enablement is controlled by `garda-agent-orchestrator/live/config/workflow-config.json`:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate full-suite-validation --task-id "<task-id>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --repo-root "."`
   - Full-suite validation emits `FULL_SUITE_VALIDATION_PASSED`, `FULL_SUITE_VALIDATION_WARNED`, `FULL_SUITE_VALIDATION_FAILED`, or `FULL_SUITE_VALIDATION_SKIPPED`.
   - When enabled, completion-gate requires `PASSED` or `WARNED` status; `FAILED` and `SKIPPED` block completion.
   - When disabled (default), the gate emits `SKIPPED` and completion-gate does not require the artifact.
22. Run completion gate when `next-step` requests it and treat result as final readiness gate before `DONE`.
   - Node: `node garda-agent-orchestrator/bin/garda.js gate completion-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>"`
   - Completion gate writes task-scoped event `COMPLETION_GATE_PASSED` or `COMPLETION_GATE_FAILED` automatically.
   - Completion gate fails if task-mode entry evidence is missing.
   - Completion gate fails if post-preflight rule-pack evidence is missing.
   - Completion gate fails if a PASS review artifact still contains active findings or residual risks, or if any deferred entry omits `Justification:`.
   - Completion gate validates full-suite-validation cycle binding when enabled.
23. Update required docs and changelog when behavior changed.
   - Internal orchestration artifacts (`TASK.md`, `garda-agent-orchestrator/runtime/**`, `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md`) may remain gitignored in deployed workspaces; update them on disk but do not `git add -f` them unless the user explicitly asks to version orchestrator internals.
24. Record artifacts, evidence, and any non-status task notes in `TASK.md`.
   - If an orchestrator defect was encountered or fixed, emit `ORCHESTRATOR_DEFECT_ACKNOWLEDGED` through `gate log-task-event` with `defect_id`, `summary`, `resolution`, `problem_record_id`, and `follow_up_task_id` in `--details-json`.
   - Verify that the follow-up task row exists and that the canonical `TASK.md` orchestrator-problems section links the problem record to that follow-up. An in-place fix never replaces this durable capture.
25. After `COMPLETION_GATE_PASSED`, run `node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>" --as-json`; this materializes `runtime/reviews/<task-id>-final-closeout.json` and `runtime/reviews/<task-id>-final-closeout.md`. Use the canonical final-closeout artifact instead of reconstructing the report structure manually.
26. Terminal status contract:
    - `DONE` only when compile gate, required review gate, doc impact gate, and completion gate passed; successful completion finalization reconciles `TASK.md` to `DONE`.
    - `BLOCKED` when any mandatory gate failed or cannot run; keep the blocked reason explicit, stop the pipeline, and do not hand-edit the active `TASK.md` status cell to `BLOCKED` as a gate substitute.
    - `SPLIT_REQUIRED` when a scope-budget guard, review-cycle auto-split guard, or strict decomposition `split-required` decision latched the parent before child tasks were linked; do not run parent lifecycle gates while latched.
    - `DECOMPOSED` when a scope-budget, review-cycle, or strict-decomposition guard intentionally split the parent into child tasks; do not run parent lifecycle gates after decomposition.
    - Strict decomposition children must stay strict: `next-step` only routes a `split-required` strict parent when the linked child rows match the decision artifact, are parent-derived, exist in `TASK.md`, and use profile `strict`.
    - Before entering a routed decomposed child task, inspect `workflow-config.full_suite_validation.command` against that child scope. If it still includes suspended sibling tests, update it only through the audited workflow-config route before `enter-task-mode`; keep current-child tests covered, exclude suspended siblings, and leave an already-suitable command unchanged.
    - Log terminal event: `TASK_DONE` or `TASK_BLOCKED`.
27. Report to user in exact order:
    1. concise implementation summary (include depth, path mode, review result status, docs updated)
       - do not paste the full final-closeout markdown or duplicate its complete section order in chat; link or name the canonical artifact when useful, then report only the status, key changes, validations, and commit readiness;
       - at `depth=1` and `depth=2`, include an output-compaction line; at `depth=3` it is optional;
       - use chars as the primary unit, keep approximate percentage when baseline is known, keep spaced breakdown formatting, and include token estimate only as a secondary note when available;
       - keep spaces between numeric values and labels and around `+`; do not emit compressed fragments like `824code review context` or `+25DB review context`;
       - localized summaries may translate the wording, but must preserve the numeric structure; example: `Suppressed output: ~3528 chars (~67%) (code review context ~3296 chars + DB review context ~100 chars + compile gate output ~132 chars). Token estimate: ~882.`
    2. commit suggestion as exact command form, defaulting to conventional style: `git commit -m "<type>(<scope>): <summary>"`
       - if `final_closeout.commit_command_suggestion` is populated, use it verbatim by default; otherwise fall back to the conventional template above.
    3. explicit follow-up question: `Do you want me to commit now? (yes/no)`
28. Close spawned reviewer/specialist agents when platform supports agent lifecycle controls.
29. Never commit unless user explicitly requests commit.

## Reviewer Agent Execution (Platform-Agnostic)
- Apply this section on every platform.
- Mandatory reviews must launch each required reviewer as a fresh-context delegated sub-agent with isolated context on every provider.
- Do not use provider-default reviewer agents that bypass this contract.
- Provider delegation capability and platform launch mapping:
  - Codex (delegation-capable): use sub-agents with isolated review context.
  - Cursor (delegation-capable): use delegated reviewer sub-agents with isolated context.
  - Claude Code (delegation-capable): use Agent tool/sub-agents with `fork_context=false`.
  - Gemini (delegation-capable): use delegated reviewer sub-agents with isolated context.
  - Qwen (delegation-capable): use delegated reviewer sub-agents with isolated context.
  - GitHub Copilot CLI (delegation-capable): use `task` tool with `agent_type="general-purpose"`; run one reviewer per isolated task execution.
  - Windsurf (delegation-capable): use delegated reviewer sub-agents with isolated context.
  - Junie (delegation-capable): use delegated reviewer sub-agents with isolated context.
  - Antigravity (delegation-capable): use delegated reviewer sub-agents with isolated context.
  - Providers or bridges without delegated reviewer support are not eligible to satisfy the mandatory review workflow until delegated launch support exists.
- Reviewer routing metadata contract:
  - Each reviewer invocation must capture `reviewer_execution_mode` (`delegated_subagent`) and `reviewer_identity` (`agent:<reviewer-id>`).
  - `build-review-context` emits `reviewer_routing` metadata in the review-context artifact; the orchestrator must populate `reviewer_routing.actual_execution_mode` and `reviewer_routing.reviewer_session_id` after reviewer launch.
  - Fresh-context requirement: do not reuse an existing reviewer session for a new mandatory review.
  - Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence; reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence.
  - After the review receipt is persisted by `record-review-result` or `record-review-receipt`, close or release the reviewer sub-agent session.
  - `build-review-context` must fail closed when the pinned runtime identity is unresolved or does not attest launchable reviewer subagents for the current runtime session.
  - Historical `same_agent_fallback` artifacts are compatibility-only diagnostics and must not satisfy a fresh mandatory review cycle.
  - Gate diagnostics (`required-reviews-check`, `completion-gate`) must report whether each review has valid delegated fresh-context execution evidence.
- For each required review where preflight `required_reviews.<type>=true`:
  1. Launch reviewer using the platform mapping above with mandatory delegation on capable providers.
  2. Prompt must include:
     - task id and task goal;
     - changed files list from preflight artifact;
     - diff summary (or exact staged diff if available);
     - mandatory skill path for this review type;
     - explicit rule-context package paths selected for this reviewer/depth (do not include non-selected rule files while token economy mode is active);
     - review-context artifact path (`garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json`) and nested markdown snapshot from `rule_context.artifact_path`; this artifact is mandatory lifecycle evidence even when token economy mode is inactive;
     - token economy flags when active (`depth`, `compact_reviewer_output`, `strip_examples`, `strip_code_blocks`);
      - for `db` / `security` / `refactor` required reviews when scoped diffs are enabled: scoped artifact produced by `node garda-agent-orchestrator/bin/garda.js gate build-scoped-diff`, with scoped metadata artifact and full-diff fallback when helper reports empty scope;
      - required output contract:
        - exact findings-only JSON fields from the generated output template;
        - findings list with file evidence;
        - `reviewer_execution_mode` used for this review (`delegated_subagent`);
        - include every evidence-supported finding and residual risk; do not select downstream disposition or remediation;
        - review artifact write path: `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>.md`.
   3. Feed reviewer output into `record-review-result` using exactly one source: `--review-output-path` or `--review-output-stdin`.
      - `--review-output-stdin` is only a transport convenience. The gate must still persist raw reviewer input to `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-output.md` before findings validation and receipt materialization.
      - Do not introduce a lighter validation branch for stdin. Verdict, routing, receipt, and telemetry checks must be identical to file-based ingest.
      - After receipt persistence succeeds, close or release the reviewer sub-agent session; do not keep a reviewer session alive for another mandatory review.
   4. Validate the persisted findings report and materialize its locked disposition evidence.
   5. If any item is `fix_now`, remediate it and follow the selective recovery route; create required follow-up tasks before allowing completion.
- Reviewer mapping contract:
  - `required_reviews.code=true` => skill `garda-agent-orchestrator/live/skills/code-review/SKILL.md` => pass token `REVIEW PASSED` => gate parameter `-CodeReviewVerdict`
  - `required_reviews.db=true` => skill `garda-agent-orchestrator/live/skills/db-review/SKILL.md` => pass token `DB REVIEW PASSED` => gate parameter `-DbReviewVerdict`
  - `required_reviews.security=true` => skill `garda-agent-orchestrator/live/skills/security-review/SKILL.md` => pass token `SECURITY REVIEW PASSED` => gate parameter `-SecurityReviewVerdict`
  - `required_reviews.refactor=true` => skill `garda-agent-orchestrator/live/skills/refactor-review/SKILL.md` => pass token `REFACTOR REVIEW PASSED` => gate parameter `-RefactorReviewVerdict`
  - `required_reviews.api=true` => skill `garda-agent-orchestrator/live/skills/api-contract-review/SKILL.md` (or custom `.../api-review/SKILL.md`) => pass token `API REVIEW PASSED` => gate parameter `-ApiReviewVerdict`
  - `required_reviews.test=true` => skill `garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md` (or custom `.../test-review/SKILL.md`) => pass token `TEST REVIEW PASSED` => gate parameter `-TestReviewVerdict`
  - `required_reviews.performance=true` => skill `garda-agent-orchestrator/live/skills/performance-review/SKILL.md` => pass token `PERFORMANCE REVIEW PASSED` => gate parameter `-PerformanceReviewVerdict`
  - `required_reviews.infra=true` => skill `garda-agent-orchestrator/live/skills/devops-k8s/SKILL.md` (or custom `.../infra-review/SKILL.md`) => pass token `INFRA REVIEW PASSED` => gate parameter `-InfraReviewVerdict`
  - `required_reviews.dependency=true` => skill `garda-agent-orchestrator/live/skills/dependency-review/SKILL.md` => pass token `DEPENDENCY REVIEW PASSED` => gate parameter `-DependencyReviewVerdict`
- After all required findings receipts are collected, run the review gate. Explicit verdict parameters below are historical compatibility only:
  - Node: `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check --preflight-path "<path>" --task-id "<task-id>" --code-review-verdict "<...>" --db-review-verdict "<...>" --security-review-verdict "<...>" --refactor-review-verdict "<...>" --api-review-verdict "<...>" --test-review-verdict "<...>" --performance-review-verdict "<...>" --infra-review-verdict "<...>" --dependency-review-verdict "<...>"`
  - New cycles omit explicit verdict flags; the gate validates current-cycle findings receipts and system-derived lane state from `preflight.required_reviews`.
- After review gate pass, run doc impact gate:
  - Node: `node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate --preflight-path "<path>" --task-id "<task-id>" --decision "<NO_DOC_UPDATES|DOCS_UPDATED>" --behavior-changed "<true|false>" --changelog-updated "<true|false>" --rationale "<why>"`
- After review gate pass, run completion gate before `DONE`:
  - Node: `node garda-agent-orchestrator/bin/garda.js gate completion-gate --preflight-path "<path>" --task-id "<task-id>"`
- Historical `same_agent_fallback` artifacts may be read for diagnostics only; they do not satisfy a fresh mandatory review cycle.
- HARD STOP: if the provider cannot launch delegated reviewer sub-agents, the mandatory review workflow is blocked until delegated launch support exists.

## Task Event Logging Commands
- Node:
  `node garda-agent-orchestrator/bin/garda.js gate log-task-event --task-id "<task-id>" --event-type "<event-type>" --outcome "INFO|PASS|FAIL|BLOCKED" --message "<short message>" --actor "orchestrator"`
- Orchestrator defect acknowledgement:
  `node garda-agent-orchestrator/bin/garda.js gate log-task-event --task-id "<task-id>" --event-type "ORCHESTRATOR_DEFECT_ACKNOWLEDGED" --outcome "INFO" --message "<short summary>" --actor "orchestrator" --details-json '{"defect_id":"T-<id>","summary":"<defect>","resolution":"fixed_in_current_task|deferred_to_follow_up","problem_record_id":"T-<id>","follow_up_task_id":"T-<id>"}'`
- Final task audit fails closed when an acknowledgement lacks a linked canonical `TASK.md` problem record or follow-up row. Timelines with no acknowledgement remain historical read-only compatible and report the encounter state as unknown.
- Task event logs:
  - `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`
  - `garda-agent-orchestrator/runtime/task-events/all-tasks.jsonl`
- New task-event writes add best-effort append locking and per-task integrity metadata (`integrity.task_sequence`, `prev_event_sha256`, `event_sha256`).
- `status` and `doctor` surface timeline completeness, not just file presence or hash-chain integrity.
- Terminal events `TASK_DONE` and `TASK_BLOCKED` trigger full log cleanup for temporary reviewer/specialist logs after required artifacts are persisted.
- Human-readable summary:
  - `node garda-agent-orchestrator/bin/garda.js gate task-events-summary --task-id "<task-id>"`

## Escape Hatch Policy (Audited Override)
- Supported only for code review and only for tiny low-risk scopes.
- Command pattern:
  `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check ... --skip-reviews "code" --skip-reason "<reason>"`
- Guardrails enforced by script:
  - only `code` can be skipped,
  - `db/security/refactor` overrides are forbidden,
  - max scope for override: `<=1` changed file and `<=8` changed lines,
  - reason is mandatory and persisted into override artifact.

## Hard Stops
- Do not assign `FAST_PATH` / `FULL_PATH` manually.
- Do not skip explicit task-mode entry via `enter-task-mode` before preflight and implementation.
- Do not skip explicit rule-pack evidence via `load-rule-pack`; reading only the top-level router is insufficient.
- Do not skip preflight classification with explicit `--output-path`.
- Do not move to implementation without a concise execution brief or reading the attached plan; no separate criteria artifact is required.
- Do not move to `IN_REVIEW` without passing compile gate (`COMPILE_GATE_PASSED`).
- Do not bypass required reviews without deterministic gate override contract.
- Do not set or hand-edit active `TASK.md` lifecycle status cells (`IN_PROGRESS`, `IN_REVIEW`, `SPLIT_REQUIRED`, `DONE`, `BLOCKED`) as a substitute for gates; task-mode, review-gate, split-required latch, and completion finalization own normal status sync, and explicit operator `task-reset` owns reset/discard.
- Do not set `DONE` without passing compile gate, `required-reviews-check`, `doc-impact-gate`, and `completion-gate`.
- Do not continue after compile/review when scope changed; rerun preflight and full mandatory gates.
- Do not use `git add -f` to stage ignored orchestration control-plane files just because gates or changelog rules mention them.
- Do not change final report order: review integrity attestation -> implementation summary -> `git commit -m` suggestion -> `Do you want me to commit now? (yes/no)`.
- Final report review integrity attestation must state whether independent review completed, whether fake/fallback/same-agent/legacy/missing/unverifiable review artifacts were observed, whether completion is review-attested, and why completion is or is not allowed.
- Do not leave reviewer/specialist agents open after review completion (when platform supports agent lifecycle controls).

## Mandatory Outputs
- Gate-owned `TASK.md` status reconciliation plus any required non-status notes or artifact references. Do not manually synchronize the active lifecycle status in the final report.
- Task-mode artifact: `garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json`.
- Preflight artifact: `garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json`.
- Compile gate result: `COMPILE_GATE_PASSED`.
- Compile gate evidence: `garda-agent-orchestrator/runtime/reviews/<task-id>-compile-gate.json`.
- Required review artifacts, validated findings receipts, and satisfied dispositions.
- Gate check result (`REVIEW_GATE_PASSED` or `REVIEW_GATE_PASSED_WITH_OVERRIDE`).
- Review gate evidence: `garda-agent-orchestrator/runtime/reviews/<task-id>-review-gate.json`.
- Documentation impact gate result and artifact: `DOC_IMPACT_ASSESSED` + `garda-agent-orchestrator/runtime/reviews/<task-id>-doc-impact.json`.
- Completion gate result (`COMPLETION_GATE_PASSED`).
- Task event trace: `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`.
- Optional timeline summary for final report: `garda gate task-events-summary` output.
- Optional review-context artifacts for token economy mode: `garda gate build-review-context` JSON output plus sibling markdown snapshot referenced by `rule_context.artifact_path`.
- Final user report.

## Examples
- User: `Execute task T-003 depth=1`
  - Skill resolves task, runs preflight, escalates depth if needed, executes mandatory gates, and reports final state.
- User: `Execute task T-022 depth=2`
  - Skill follows full lifecycle and runs only required specialist reviews from preflight.
- User: `Execute task T-105 depth=1 --skip-review=code --reason="one-line config hotfix"`
  - Skill may use audited override only if gate script allows it for tiny low-risk scope.

## Troubleshooting
- Preflight not found or invalid:
  - Re-run `classify-change` with explicit output path.
- Required review result missing or findings disposition unsatisfied:
  - Re-run missing reviewer and then `required-reviews-check`.
- Completion gate failed:
  - Resolve listed timeline/artifact/integrity violations, then rerun `completion-gate`.
- Compile gate failed:
  - Fix compile errors and rerun `compile-gate` until `COMPILE_GATE_PASSED`.
- Compile gate failed with preflight scope drift:
  - Re-run `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."` and follow its refresh sequence.
  - If the original preflight used planned `--changed-file` inputs in a clean workspace before coding, changed line totals may differ once the real diff exists; this is expected.
- Doc impact gate failed:
  - Fix doc-impact decision/rationale/changelog flags and rerun `doc-impact-gate`.
- Override rejected:
  - Scope is too large or specialized reviews are required; remove override and run full review path.
- Git noise in dirty workspace:
  - Stage task-specific project files and run preflight with `--use-staged`.
  - Ignored orchestration control-plane files should stay unstaged unless the user explicitly asks to version them.
