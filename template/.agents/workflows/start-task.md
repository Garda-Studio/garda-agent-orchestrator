<!-- garda-agent-orchestrator:managed-start -->
---
description: "Mandatory shared router for any task execution through Garda orchestration."
---

# Start Task

This checklist is the shared start-task router for root entrypoints and provider bridges.
It routes to the canonical Garda workflow and does not replace `80-task-workflow.md` or the orchestration skill.

Before any code changes:
- Open `AGENTS.md` and `TASK.md`.
- If an active provider bridge exists, open it too before implementation.
- At fresh main-agent task start, show one English start marker from the repo-owned list (`Garda captures my mind` or `Garda rewrites my code` or `Garda orchestrator active.` or `Garda task workflow engaged.` or `Garda guarded workflow active.` or `Garda navigator active.` or `Garda task mode entered.` or `Garda orchestration loop started.` or `Garda task lifecycle started.` or `Garda next-step workflow active.` or `Garda guarded task run started.` or `Garda operator workflow engaged.` or `Garda task route engaged.` or `Garda control-plane workflow active.` or `Garda workflow controls loaded.` or `Garda queue route active.` or `Garda task execution path active.`) once in the first relevant reply; this UX marker is not gate evidence.
- Do not use start-marker presence or exact text as hard evidence for task-mode, compile, review, completion, or task-audit gates.
- Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.
- Enter orchestrator mode with the canonical command: Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.
- Run `node bin/garda.js next-step "<task-id>" --repo-root "."` before the first gate, after every suggested command, and after any gate failure. Follow only the single command it prints. In deployed workspaces use `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`.
- Do not start by guessing `compile-gate`, `classify-change`, or default config flags. Static gate order below is policy context; `next-step` is the executable navigator.
- If `garda-agent-orchestrator/runtime/plans/<task-id>.md` exists for the selected task, read it as optional executor guidance. Missing Markdown working plans are normal: do not block, invent a waiver, pass them as `--plan-path`, or treat their absence as a reviewer/completion issue.
- Active profile selection comes from the workspace profile config. Inspect, switch, or create profiles with `node bin/garda.js profile current|list|use|create --target-root "."` in a self-hosted source checkout, or `node garda-agent-orchestrator/bin/garda.js profile current|list|use|create --target-root "."` inside a materialized/deployed workspace.
- If the workspace already contains modified files before task-mode entry, stop and isolate scope via `--use-staged` or explicit `--changed-file ...` preflight inputs before continuing.
- Agents cannot approve protected task-mode entry for themselves. Any rerun with `--orchestrator-work` or `--workflow-config-work` requires a fresh operator approval, `--operator-confirmed yes`, and `--operator-confirmed-at-utc "<ISO-8601 timestamp>"`.
- In materialized/application workspaces, the Garda bundle is vendor/control-plane. When `garda_self_guard` is on, agents must not self-escalate into `--orchestrator-work`; route protected Garda bundle edits to operator-owned update/repair/maintenance or an explicit `workflow set --garda-self-guard off` policy change.
- Use compact command protocol from `40-commands.md`: first `scan`, then `inspect`, then verbose `debug` only by exception.

## Copy-Paste Start Commands
- First/resume command (source checkout): `node bin/garda.js next-step "<task-id>" --repo-root "."`
- First/resume command (deployed workspace): `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`
- Use the same `next-step` command before the first gate, after every suggested command, and after any gate failure. Do not start with `compile-gate`, guess flags, or read default config templates when `next-step` can inspect task evidence.
- Source checkout (`--provider`): `node bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "<runtime-provider>" --repo-root "."`
- Source checkout (`--provider` + `--routed-to`, optional telemetry): `node bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "<runtime-provider>" --routed-to "<provider-bridge-or-entrypoint>" --repo-root "."`
- Source checkout (`TASK_ENTRY` rules): `node bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md" --repo-root "."`
- Deployed workspace (`--provider`): `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "<runtime-provider>" --repo-root "."`
- Deployed workspace (`--provider` + `--routed-to`, optional telemetry): `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "<runtime-provider>" --routed-to "<provider-bridge-or-entrypoint>" --repo-root "."`
- Deployed workspace (`TASK_ENTRY` rules): `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md" --repo-root "."`
- Required runtime identity: use `--provider "<runtime-provider>"`; add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned.

Mandatory gate order:
0. `next-step "<task-id>"` before the first gate and after every gate; run only the single recommended command it prints unless the user explicitly asks for diagnostics
1. `gate enter-task-mode` with explicit runtime identity via `--provider "<provider>"`; add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned, and never rely on canonical SourceOfTruth fallback
2. `gate load-rule-pack --stage TASK_ENTRY`
3. `gate handshake-diagnostics`
4. `gate shell-smoke-preflight`
5. `gate classify-change`
6. POST_PREFLIGHT rule-pack command printed by `next-step`: `gate load-rule-pack --stage POST_PREFLIGHT` or `gate bind-rule-pack-to-preflight`
7. implement only after preflight
8. `gate compile-gate`
9. `gate build-review-context` for each required review
10. `gate required-reviews-check`
11. `gate doc-impact-gate`
12. `gate full-suite-validation` (when enabled via workflow-config.json)
13. `gate completion-gate`

Hard stops:
- If a mandatory gate fails or is unavailable, stop and report the exact command and stderr.
- If `next-step` or a failed gate says `--orchestrator-work`, `--workflow-config-work`, or `workflow set` is required, stop for explicit operator approval before running the command with `--operator-confirmed yes` and `--operator-confirmed-at-utc "<ISO-8601 timestamp>"` where required.
- If `next-step` reports `operator-maintenance` because Garda self-guard is on, do not rerun task mode with `--orchestrator-work`; an operator must run update/repair/maintenance or deliberately relax the guard.
- Do not make code edits before `enter-task-mode`; unscoped pre-task diffs must be isolated first.
- Spawn a new clean-context delegated reviewer for this review context using the provider-native/internal agent or subagent tool with the exact generated CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath from prepare-reviewer-launch, not ReviewerLaunchArtifactPath control metadata, not a shell command or hand-written artifact, and not a reconstructed prompt; do not create, reserve, hold, or complete a reviewer before launch input exists, and do not reuse an existing reviewer session. For Codex, follow the current client's declared tool schema; when collaboration.spawn_agent is exposed, use fork_turns="none", and use another isolation parameter only when that tool declares it. Claude should use fork_context=false when available, and other providers must use provider-equivalent isolated sub-agent or task launch. If the current provider session cannot launch a fresh delegated reviewer, stop and report that blocker instead of fabricating routing, launch, review, receipt, or telemetry evidence.
- After `prepare-reviewer-launch`, launch the real delegated reviewer and immediately run `record-reviewer-delegation-started` with provider/controller invocation id plus exact launch-input evidence. Treat `complete-reviewer-launch` as post-return completion/finalization evidence, not as reviewer start.
- Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence; reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence.
- After the review receipt is persisted, close or release the reviewer sub-agent session.
- Do not spawn or pre-launch a dependent downstream reviewer before the required upstream accepted findings receipt reports findings-satisfied for the same cycle.
- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.
- Use next-step review navigation output before reviewer launch: `ReviewLaunchableBatch` / `launchable_review_types` list lanes that may be launched now, `BlockedReviewLanes` / `blocked_review_lanes` list dependency reasons, `NextReview` remains legacy single-lane compatibility, failed current reviews take remediation priority, and enabled full-suite validation blocks `test` review until current full-suite PASS evidence exists.
- Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as a generator, build or compile step followed by a command that consumes its output (for example tests over generated or compiled artifacts) must use the guarded workflow path or run strictly sequentially, never in parallel.
- Do not hand-edit active `TASK.md` lifecycle statuses (`IN_PROGRESS`, `IN_REVIEW`, `DONE`, `BLOCKED`) as a substitute for gates; completion finalization owns `DONE`, review-gate owns `IN_REVIEW`, task-mode owns `IN_PROGRESS`, and explicit operator `task-reset` owns reset/discard.
- Do not mark `DONE` without `COMPLETION_GATE_PASSED`.
- Do not create fake review artifacts or bypass reviewer routing.
- The `40-commands.md` restraint applies only to standalone ad-hoc commands. It does NOT exempt mandatory gates: gates such as `compile-gate` and `full-suite-validation` must execute their underlying build/test/type-check commands when the workflow requires them.
<!-- garda-agent-orchestrator:managed-end -->
