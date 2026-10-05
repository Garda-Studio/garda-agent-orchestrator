# CLI Reference

## Review-output correction evidence commands

These helper gates record actual provider evidence for a correction attempt; they do not launch a reviewer or supply missing provenance:

| Gate | Evidence and principal options |
| --- | --- |
| `record-review-output-correction-transport` | Selected session availability, originating reviewer identity and provider invocation. Use `--session-availability`, `--reviewer-identity`, `--provider-invocation-id`, and `--attestation-source`. |
| `record-review-output-correction-response` | Exact raw response file returned by the originating reviewer. Use `--review-output-path` with that reviewer's identity and provider invocation. |
| `record-review-output-correction-invocation` | Actual correction producer invocation bound to its immutable launch input. Use `--correction-producer-identity`, `--launch-input-sha256`, and `--fork-context` for the selected route. |

All three require the owning `--task-id`, `--review-type`, `--correction-artifact-path` and repository root. Run `garda gate <gate-name> --help` for source/deployed syntax. The action selected by the navigator determines the permitted transport and attestations.

The available-gate listing also includes `decline-optional-skill`, `materialize-full-suite-repair-task`, `restore-full-suite-repair-wip`, and `record-reviewer-launch-failed`. Their existing validation and authorization requirements apply.


Complete command reference for Garda Agent Orchestrator.

### `garda compact`

`garda compact` is an explicit, read-only inspection command. It does not intercept the shell or replace mandatory build/test/evidence reads. Agents and reviewers choose it when a command may produce noisy output. Short output stays inline; long output shows a bounded beginning/tail and an executable retrieval command.

```text
garda compact git status --task-id T-123
garda compact git diff --task-id T-123 --path src/example.ts
garda compact file --task-id T-123 --path src/example.ts --from 40 --lines 80
garda compact file --task-id T-123 --path src/example.ts --metadata
garda compact rg --task-id T-123 --path src --query "search text"
garda compact read --task-id T-123 --ref <capture-id> --stream stdout --offset 0
garda compact read --task-id T-123 --ref <capture-id> --stream stderr --tail
garda compact read --task-id T-123 --ref <capture-id> --max-bytes 8192
garda compact read --task-id T-123 --ref <capture-id> --from-line 40 --lines 80
garda compact search --task-id T-123 --ref <capture-id> --query "failure" --query "error" --context 2
garda compact file --help
garda compact usage
```

All operations accept `--repo-root`; inspection paths must be repository-relative. Diff supports `--staged`; repository search is literal unless `--regex` is supplied. Arbitrary shell commands/flags are not accepted. Extending support requires a typed adapter, tests and a capability setting, not a UI shell-string field.

Small results stay inline regardless of line count when they fit the character budget. Explicit file ranges use a separate 8192-byte budget instead of a second head/tail preview. Larger ranges show a sequential first page with an exact continuation offset. File output identifies selected source lines and whether source EOF was reached; a saved reference contains only that selection.

Retained stdout/stderr preserve original bytes without secret filtering. Reads default to 4096 bytes, accept `--max-bytes 256..8192`, and support retained-stream line selection through `--from-line` and `--lines`. Line numbers refer to the captured stream, not necessarily source-file line numbers. Byte pages preserve valid UTF-8 boundaries and independently bound escaped display text. An arbitrary offset inside a character may rewind by up to three bytes. `--tail` uses the selected byte budget. Manifest size/hash verification still runs on every retrieval.

Search accepts up to eight repeated literal `--query` values with OR semantics and `--context 0..8` (default 2). It shows readable line context, retained line numbers and read offsets, merging overlapping displayed ranges. Long contexts are explicitly clipped. Search scans at most 1 MiB and 20 matching positions per call; follow `nextOffset` until `end` for complete search coverage. A complete capture describes this bounded invocation, not every line of a source file. Timeouts, quota/IO failures and capped output are explicitly partial; missing references fail honestly. Overview previews may split UTF-8 boundaries; retained bytes are unchanged.

UI and audited workflow settings expose separate preview, selected-range byte, read-page byte and search-context budgets. Preview defaults are 20 lines / 3000 characters, with maxima of 100 lines / 6000 characters; the line limit applies when the character budget requires an overview. Read budgets have an 8192-byte ceiling. These display settings do not raise disk-cache quotas. Existing configurations inherit defaults for missing fields.

The file cache is `garda-agent-orchestrator/runtime/compact/<task-id>/<capture-id>/`, outside tracked/published source and normal managed backups. Defaults: 16 MiB per capture including metadata, 64 MiB per task, 256 MiB per workspace and 2048 captures. A full cache rejects new captures; unfinished/blocked task output is never evicted to make room. Small inline results create no capture files.

Successful task completion waits for deletion of its own cache. Accepted task start/resume and completion also attempt bounded cleanup of known DONE tasks, including crash leftovers. There is no periodic collector, UI dependency or sweep on ordinary CLI reads. Unknown/unfinished task directories are preserved conservatively and still count toward limits. Disabling compact stops new inspections but does not break retained reads or boundary cleanup.

Savings depend on the inspection: preview plus selective retrieval can be much smaller than a full noisy dump, but an already narrow native read can be cheaper. Discovery/reviewer guidance and follow-up reads are part of that cost.

## Public Surface

The runtime is Node-only.

- Published command names: `garda`, `gao`, `garda-agent-orchestrator`
- Source invocation: `node bin/garda.js <command>`
- Runtime baseline: `Node.js ^22.13.0 || >=24.0.0` (Node 24 LTS primary, Node 22.13+ compatibility)
- Source checkouts do not rely on consumer install lifecycle scripts. Run `npm install` for dependencies and `npm run build` explicitly before using `node bin/garda.js` from source.

Runtime compatibility matrix:

| Node.js line | Garda 1.4.x status | Notes |
|---|---|---|
| Node 24 LTS | Supported primary runtime | Covered by `package.json` engines, CI, release validation, and cross-platform smoke. |
| Node 22.13+ LTS | Supported compatibility runtime | Covered by `package.json` engines, CI typecheck/test/release validation, runtime diagnostics, docs, and cross-platform smoke. |
| Node 23, Node 22 before 22.13, and Node 20 or older | Untested / not officially supported | Outside the tested `^22.13.0 || >=24.0.0` support matrix. Doctor warns, but runtime version mismatch alone does not block execution. |

---

## Core Commands

### `garda`

Safe overview of the current workspace.

```text
garda
```

### `garda setup`

First-run onboarding. Recommended entrypoint for end users.

```text
garda setup
garda setup --target-root "." --no-prompt --assistant-language "English" --assistant-brevity concise --source-of-truth Codex --enforce-no-auto-commit no --claude-orchestrator-full-access no --token-economy-enabled yes
```

What it does:
- deploys or refreshes `./garda-agent-orchestrator/`
- collects or accepts the 6 init answers
- writes `runtime/init-answers.json`
- runs install
- validates `MANIFEST.md`
- leaves final agent onboarding for `AGENT_INIT_PROMPT.md` and `garda agent-init`
- prints `RecommendedUiCommand: garda ui --actions` as the post-agent-init UI inspection command

Notes:
- `setup` supports `--active-agent-files` for fully scripted flows, but ordinary onboarding leaves explicit active-agent-file confirmation to `garda agent-init`.
- After CLI setup the workspace is still in agent handoff state, not ready for task execution.

### `garda agent-init`

Hard code-level onboarding gate. This command writes `runtime/agent-init-state.json` and blocks `Workspace ready` until it passes.

```text
garda agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "AGENTS.md, CLAUDE.md" --project-rules-updated yes --skills-prompted yes
```

When `agent-init` passes and the workspace is ready for tasks, the final output prints `RecommendedUiCommand: garda ui --actions` so the operator can review workspace state and guarded allow-listed settings before or alongside choosing the first task. Mutating UI actions still require explicit confirmation.

### `garda status`

```text
garda status --target-root "."
garda status --target-root "." --compact
garda status why-blocked --target-root "."
```

Notes:
- `status` prints the normal workspace readiness snapshot.
- `status` prints `RecommendedUiCommand: garda ui --actions` separately from `RecommendedNextCommand`; the UI command is for guarded local inspection/settings, while the next command remains the lifecycle command to run.
- While a valid `runtime/agent-init-state.json` has `ProjectMemoryInitialized=false` or `ProjectMemoryValidated=false`, `status` reports `PROJECT_MEMORY_PENDING` and prints `ProjectMemoryInitRefreshPrompt`.
- Malformed or invalid `agent-init-state.json` remains an `AGENT_STATE_INVALID` readiness problem; rerun `garda agent-init` after repair so the memory readiness fields can be trusted.
- When both `ProjectMemoryInitialized=true` and `ProjectMemoryValidated=true`, `status` treats durable project memory as already confirmed and does not recommend the expensive full init/refresh prompt again.
- In a self-hosted source checkout, `status` still shows trusted protected-manifest `DRIFT`, but when the trusted manifest itself was recorded as `is_source_checkout=true` that drift is downgraded to informational instead of forcing readiness to `false` on its own.
- `status --compact` preserves the not-ready output but reduces the green path to a single summary line: `GARDA_STATUS: ready | source=<provider>`.
- `status why-blocked` inspects `TASK.md`, task timelines, and failed gate markers to explain why `BLOCKED`, `IN_PROGRESS`, or `IN_REVIEW` tasks are stalled.
- `status why-blocked` also surfaces task-event locks that can block timeline writes and review-artifact locks that can block `runtime/reviews` artifact persistence.
- The canonical task timeline is `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`; status rolls up derived task-event indexes rather than replacing the per-task JSONL source of truth.
- New task-event lines use the public task-event schema version `2` with `event_source: "task-events"` plus stable `public_metadata` fields (`lifecycle_phase`, `status_signal`, `health_state`, `terminal_outcome`). Readers must remain backward-compatible with legacy schema `1` lines that lack those top-level public fields.
- See [Operator Consistency and Recovery Runbook](operator-consistency-runbook.md) for the canonical-vs-derived model and recovery guidance.

### `garda doctor`

Runs `garda verify` plus `garda gate validate-manifest`.

```text
garda doctor --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda doctor --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --compact
garda doctor --target-root "." --cleanup-stale-locks --dry-run
garda doctor --target-root "." --cleanup-stale-locks
garda doctor explain COMPILE_GATE_FAILED
garda doctor explain --list
```

Notes:
- `doctor` remains the aggregate verify + manifest + timeline health command.
- On failure, human `doctor` output starts with a concise `Doctor Failure Summary` before the detailed evidence dump. The summary lists the primary blockers, highlights failure state, and prints the most actionable next command when a safe remediation is known, such as protected-manifest repair after operator verification.
- In a self-hosted source checkout, trusted protected-manifest `DRIFT` remains visible in `doctor`, but source-checkout drift is reported as informational unless the task-context gates classify it as real pre-start or lifecycle drift.
- `doctor --compact` preserves failure diagnostics but reduces the green path to a single line: `Doctor: PASSED | verify=PASSED | manifest=PASSED`.
- `doctor` reports task-event lock health under `garda-agent-orchestrator/runtime/task-events/*.lock`, including owner metadata, stale-vs-live assessment, and remediation guidance.
- `doctor` also reports review-artifact lock health under `garda-agent-orchestrator/runtime/reviews/*.lock`, including owner metadata, stale-vs-live assessment, and remediation guidance.
- `doctor --cleanup-stale-locks --dry-run` previews stale task-event locks and stale review-artifact locks that are safe to remove; rerun without `--dry-run` to delete only those proven-stale lock directories.
- `doctor` reports task-history ledger scan counts when ledger files exist. Verified ledgers are the lightweight history record that allows healthy `DONE` tasks to move out of detailed runtime evidence later; incomplete, contradictory, or invalid ledgers keep the task out of ledger-only compaction.
- `doctor` includes a report-only Large Module Decomposition Report. Its next-step diagnostic budgets are intentionally tighter than blocking policy gates (`coordinator_budget=4500`, `helper_budget=700`) so residual coordinator/helper growth is visible without failing doctor by itself.
- `doctor explain <FAILURE_ID>` prints remediation steps for known failure IDs such as `TASK_MODE_NOT_ENTERED`, `COMPILE_GATE_FAILED`, and `TIMELINE_INCOMPLETE`.
- `doctor explain --list` prints the current remediation database keys.
- `doctor` uses the same runtime-consistency vocabulary as the operator runbook: canonical per-task JSONL, derived indexes, trusted protected manifest, and stale lock cleanup.
- See [Operator Consistency and Recovery Runbook](operator-consistency-runbook.md) for the operator playbook behind these diagnostics.

### `garda preprompt`

Read-only task bootstrap helper. It returns current task/workspace context together with the canonical next commands for the active lifecycle stage.

```text
garda preprompt task --task-id "T-137" --json --target-root "."
garda preprompt task --task-id "T-137" --target-root "."
```

Notes:
- `preprompt task` does not modify task state, timelines, or review artifacts.
- `preprompt task --json` reuses the current preflight artifact when present to derive required review types and the post-implementation command sequence.
- `preprompt task --json` exposes `project_memory.initialization_state` and `project_memory.init_refresh_prompt`; the top-level prompt is present only while `agent-init-state.json` is missing, invalid, or does not yet record both `ProjectMemoryInitialized=true` and `ProjectMemoryValidated=true`.
- Missing or incomplete project-memory files make `project_memory.status` partial and add warnings, but they do not by themselves set the top-level `init_refresh_prompt` when agent-init state already records validated memory.
- When the repo maps `optional-skill-selection-policy` through `garda-agent-orchestrator/live/config/garda.config.json`, `preprompt task --json` also shows `diagnostics.optional_skills`, including the canonical policy mode (`off`, `optional`, or `mandatory`), compact selection summary, selected skill ids, `selected_installed_skill_paths`, or an explicit `as_is` fallback reason. A stray policy file that is not mapped through `garda.config.json` does not activate the feature. The diagnostics reuse the current preflight scope when present and otherwise fall back to task-start context such as task summary and persisted planned scope.
- If `diagnostics.optional_skills.blocker` is present under `mandatory`, `preprompt task` remains read-only but exits non-zero so the startup flow cannot proceed past that blocker silently. Legacy config values remain read-compatible: `advisory` maps to `optional`, and `required`/`strict` map to `mandatory`.
- If the workspace is dirty but no reusable staged scope or existing preflight scope is available, the output reports that blocker instead of inventing a misleading `--use-staged` classify command.
- Output stays bounded: review-artifact and changed-file arrays include counts plus truncation metadata instead of dumping arbitrarily large lists.

### `garda next-step`

Deterministic task navigator. Use this as the default task loop: run it before the first gate, after every suggested command, and after any gate failure.

```text
garda next-step T-137
garda next-step T-137 --as-json
garda gate next-step T-137
garda gate next-step --preflight-path "garda-agent-orchestrator/runtime/reviews/T-137-preflight.json" --repo-root "."
```

Notes:
- `next-step` reads current task events and review artifacts, then prints the current status, effective full-suite config including placement, review policy, missing artifacts, and the single next command to run.
- The command accepts either a positional task id (`T-137`), `--task-id`, or a `--preflight-path` that ends in `<task-id>-preflight.json`.
- Before the first preflight, `next-step` reuses task-mode `planned_changed_files` to print concrete `classify-change --changed-file` arguments; agents should not invent placeholder paths.
- After every suggested command completes, rerun `garda next-step T-137` instead of guessing gate flags, reading default templates for effective config, or starting with `compile-gate`.
- If preflight scope touches protected orchestrator control-plane files without `--orchestrator-work`, restart task mode with the exact command printed by `next-step` or by the failed preflight gate before continuing, except in application workspaces where Garda self-guard is on and `next-step` routes to `operator-maintenance`.
- In materialized/application workspaces the `garda-agent-orchestrator/` bundle is vendor/control-plane. With `garda_self_guard=on`, agents cannot self-escalate into `--orchestrator-work`; operators must run update/repair/maintenance or deliberately relax the policy with `workflow set --garda-self-guard off`.
- Review navigation uses the launch batch, not only the legacy single-review field. Human output can include `ReviewLaunchableBatch`, `BlockedReviewLanes`, and `ReviewFailedCurrent`; JSON includes `review.launchable_review_types`, `review.blocked_review_lanes`, and `review.failed_review_type`.
- `NextReview` / `review.next_review_type` remain compatibility fields for older single-lane consumers. When a launch batch contains multiple independent lanes, agents may launch those reviewers in parallel only after `next-step` says they are launchable.
- `BlockedReviewLanes` names dependency reasons such as upstream review types or `full-suite-validation`. Full-suite placement controls when that dependency appears: `after_compile_before_reviews` blocks reviewer launch after compile until current full-suite evidence exists, `before_test_review` blocks only the `test` reviewer, and `before_completion` leaves reviewer context neutral while completion still enforces the suite later.
- True docs-only scopes record `NOT_REQUIRED` full-suite evidence instead of running the configured suite, even when security-sensitive documentation still requires security review. Mixed docs plus code/test/config scopes stay on the normal full validation path.
- A failed current-cycle review takes remediation priority over downstream launch work. Fix and rerun or validly reuse the failed review as PASS before treating blocked downstream lanes as ready.
- After a failed review, the agent must rerun `next-step` and follow the printed recovery chain. A remediation diff can refresh preflight, require a new compile, rebuild scoped diff metadata, and require a fresh delegated reviewer for the failed or invalidated lane. Do not carry a failed review forward to completion merely because the code was changed.
- For mandatory reviews, `next-step`, rule packs, orchestration skills, review contexts, and provider bridges expect a newly spawned clean-context reviewer for the current review context; do not reuse an existing reviewer session, and close or release the reviewer sub-agent after `record-review-result` or `record-review-receipt` persists the receipt.

### `garda debug env`

Show environment and runtime triage details for debugging CLI or workspace issues.

```text
garda debug env --target-root "."
garda debug env --target-root "." --json
```

Notes:
- `debug env` is the public `debug` subcommand surface.
- `--json` emits the same environment snapshot in machine-readable form.

### `garda stats`

Show token-overhead and runtime analytics for the workspace or a single task.

```text
garda stats --target-root "."
garda stats --target-root "." --json
garda stats "T-137" --target-root "."
garda stats --task-id "T-137" --target-root "."
garda stats "T-137" --target-root "." --json
garda stats --task-id "T-137" --target-root "." --json
```

Notes:
- A positional task id is equivalent to `--task-id` for task-specific stats.
- Task-specific stats include review attempt pass/fail/reuse/missing counts when review evidence is available; aggregate stats keep the existing aggregate schema.
- Output-compaction reporting uses `chars` as the primary unit. When a token estimate is shown, it is explicitly a secondary estimate of suppressed output, not model-token usage.
- Human-readable stats output uses color when the terminal supports it; `--json` remains uncolored.

### `garda task`

Read-only task inspection namespace. Start with a task id, then choose the view.

```text
garda task "T-137" stats --target-root "."
garda task "T-137" events --repo-root "."
garda task "T-137" events --repo-root "." --include-details
garda task "T-137" events --repo-root "." --as-json
```

Notes:
- `garda task "<task-id>" stats` routes to the same per-task analytics as `garda stats "<task-id>"`.
- `garda task "<task-id>" events` prints the task event timeline without changing lifecycle state.
- Human task event output uses color when the terminal supports it; `--as-json`, `--compact-latest-cycle`, and persisted `--output-path` output remain uncolored.
- `garda gate task-events-summary --task-id "T-001" --compact-latest-cycle` now emits compact summary schema version `2`, including an `event_contract` block for public event compatibility and latest-cycle `health_state` / `terminal_outcome` fields for bounded automation consumers.
- The task namespace is inspection-only. It does not alias, replace, or modify `next-step`, and the events wrapper does not expose `--output-path`; use the explicit gate command when intentionally materializing an artifact.

### `garda html`

Write a static read-only HTML report and print a browser link.

```text
garda html --target-root "."
garda html --target-root "." --output-path "garda-agent-orchestrator/runtime/reports/garda-report.html"
garda html --target-root "." --snapshot --retain-snapshots 5
garda html --target-root "." --max-detailed-tasks 5
garda html --target-root "." --json
```

Notes:
- The report has tabs for the canonical upper `TASK.md` Active Queue, current workflow settings, and short operator instructions.
- Clicking a task row opens read-only details. Deep task details are lazy/skipped by default for static reports so large runtime histories return promptly.
- Use `--max-detailed-tasks N` to embed heavier stats, lifecycle events, audit summaries, and artifact metadata for up to N task rows in the generated snapshot.
- The command refreshes a stable latest HTML file and prints a `file://` URL. It does not start a server or mutate task lifecycle state.
- `--snapshot` writes a timestamped copy under `runtime/reports/snapshots`; `--retain-snapshots N` keeps the newest N generated snapshots.

### `garda ui`

Start a foreground localhost UI and print a browser URL.

```text
garda ui --target-root "."
garda ui --target-root "." --port 17340
garda ui --target-root "." --language de
garda ui --target-root "." --idle-minutes 15 --idle-warning-seconds 60
garda ui --target-root "." --no-idle-shutdown
garda ui --target-root "." --actions
```

Notes:
- The server uses Node built-ins only and binds to `127.0.0.1`; it does not add Express, Vite, React, or other runtime dependencies.
- The terminal stays occupied while the UI is running. Stop it with Ctrl+C, or use the guarded Server Status stop action in the browser.
- Idle shutdown is enabled by default. The browser sends throttled activity pings, the server owns the authoritative `last_activity_at`, idle threshold, warning countdown, and shutdown deadline, and closed tabs or sleeping browsers still let the foreground process stop after the deadline.
- During the warning window the Server Status panel shows a countdown slider. Any real user activity before the deadline resets the server-side timer.
- After the local server shuts down, in-page Launch cannot work because no process remains to receive the request. Rerun `garda ui --target-root "."` from a terminal.
- The dashboard loads the canonical upper `TASK.md` queue immediately, with overview counters, task search, status/priority filters, workflow config, initialization/settings, project-memory, instructions, and task detail panels.
- The initialization/settings panel shows `SourceOfTruth` together with its canonical entrypoint file, such as `Codex (AGENTS.md)`, and links local project files through the guarded file-open route.
- The project-memory panel avoids eager full-file dumps. Memory files and ordinary docs open through guarded file links; ordinary docs are managed one validated project path at a time, and changing ordinary-doc entries does not by itself trigger extra review lanes.
- The dashboard UI chrome uses English as the built-in fallback plus bundled `garda-ui-*.json` language packs. Use `--language <id>` for the initial server-rendered language; the visible language panel stores the browser-local selection for that page. If no stored selection exists, the browser locale is matched against available packs before falling back to the CLI value and then English.
- Localization covers UI chrome only. CLI commands, task IDs, config keys, enum values, file paths, raw gate/review/artifact output, and machine-readable JSON stay exact and untranslated.
- Per-task details are fetched lazily from read-only local JSON endpoints when the user clicks `Load details`, including gate timeline, blockers, review summary, and artifact links.
- By default the UI does not run shell commands, mutate task lifecycle state, edit workflow config, or write settings.
- `--actions` exposes only allow-listed Garda actions in their owning domain panels, not a catch-all shell console or separate Actions tab. Action requests support preview mode, require typed confirmation for mutating actions, and append runtime audit JSONL entries under `garda-agent-orchestrator/runtime/ui-actions/`.
- With `--actions`, workflow setting panels expose guarded editors for allow-listed workflow knobs, including the compile-gate command, full-suite command and limits, project-memory tuning, auto-backup settings, and optional quality-check rules. The editor supports preview and execution modes, requires the exact confirmation phrase `APPLY GARDA SETTING`, and runs the existing audited `garda workflow set` command path with `--operator-confirmed yes`; it does not write `workflow-config.json` directly.
- Optional quality-check controls show the current advisory gate state and configured rules. Operators can enable or disable the gate, add or edit a rule, disable a single rule, or delete a custom rule through fixed `workflow set --optional-checks-enabled` and `--optional-check-rule-*` commands. These checks run before compile/review/full-suite work when routed by `next-step`, but they never replace mandatory compile, review, or full-suite gates.
- High-risk policy switches such as full-suite enablement, review policy, scope-budget enablement/profiles, review-cycle policy, and task-reset enablement remain guarded in the UI and are changed through the explicit workflow command surface. The compile-gate command and tiered scope-budget thresholds are editable through the same audited settings editor and are validated before workflow config is written.
- Action execution requires the page's per-process request token, exact localhost `Origin`, and JSON content type; cross-origin localhost posts are rejected.
- File-open links served by the local UI are also scoped to project files and require the page action token plus same-origin context before the server streams content.
- The browser never accepts arbitrary shell text; each action maps to a fixed existing Garda command.

### `garda off`

Hide managed Garda root instruction files while keeping the deployed bundle and `TASK.md` available.

### `garda on`

Restore managed Garda root instruction files after a previous `garda off`.

Temporarily hide or restore Garda-owned root agent instruction files without uninstalling the deployed bundle.

```text
garda off --target-root "." --dry-run
garda off --target-root "."
garda on --target-root "." --dry-run
garda on --target-root "."
```

Notes:
- `garda off` moves managed root agent surfaces such as `AGENTS.md`, active provider entrypoints, provider bridge profiles, and `.agents/workflows/start-task.md` into `garda-agent-orchestrator/runtime/switch/off/`.
- `garda on` restores those managed files from `runtime/switch/off/`.
- User-owned root alternatives are moved into `runtime/switch/on/` when turning Garda back on, and restored when turning it off again.
- `TASK.md` remains visible; the switch is for root agent instruction surfaces, not task queue removal.
- Setup/update/reinit keep an active managed `.agentignore` block for bulky Garda-generated artifacts while leaving command, rule, config, and explicit runtime evidence paths readable.
- `garda off` writes a separate managed `.agentignore` block pointing agents away from `garda-agent-orchestrator/`; `garda on` removes only that off-mode block and leaves the active block in place.
- Update apply paths are blocked while Garda is off. Run `garda on` before `garda update`, `garda check-update --apply`, or applying `garda update git`; read-only checks such as `check-update`, `check-update --dry-run`, and `update git --check-only` remain available.
- Conflicts fail closed without overwriting user-authored files. Use `--dry-run` to inspect planned moves before changing a workspace.

### `garda bootstrap`

Deploy the bundle without running install.

```text
garda bootstrap
garda bootstrap --repo-url "<git-url>" --branch "<branch>"
```

### `garda install`

Deploy or refresh the orchestrator from prepared init answers.

```text
garda install --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda install --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --repo-url "<git-url>" --branch "<branch>"
```

### `garda init`

Re-materialize `live/` from an existing deployed bundle.

```text
garda init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

### `garda reinit`

Change init answers without a full reinstall.

To synchronize a stale deployed bundle with a source checkout, run `npm run build`
then `node bin/garda.js setup --no-prompt`. `init` and `reinit` rematerialize the
existing bundle and do not copy updated source artifacts.

```text
garda reinit --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

Notes:
- `reinit` re-materializes `live/` based on new answers and enforces a hard atomic consistency invariant for the deployed bundle.
- After sync, a mandatory post-reinit invariant check proves the deployed bundle is structurally complete (includes `bin`, `dist`, `package.json`, `VERSION`, and `template`) relative to the source being applied.

### `garda verify`

Validate deployment consistency and rule contracts.

```text
garda verify --target-root "." --source-of-truth "Codex" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda verify --target-root "." --source-of-truth "Codex" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --compact
```

Provider values: `Claude`, `Codex`, `Cursor`, `DeepSeek`, `Gemini`, `Qwen`, `GitHubCopilot`, `Windsurf`, `Junie`, `Antigravity`.

Notes:
- `verify --compact` preserves failure output but reduces the green path to `Verification: PASS | paths=<count> | violations=0`.

### `garda check-update`

Compare the current deployment with a newer npm package or a local unpacked bundle root. By default this only checks; `--apply` performs the update immediately.

```text
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --apply --no-prompt
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --dry-run
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --package-spec "garda-agent-orchestrator@latest"
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --source-path "."
```

Notes:
- By default `check-update` uses the deployed package name from `garda-agent-orchestrator/package.json` with the npm `latest` tag.
- `--package-spec` accepts npm specs such as `garda-agent-orchestrator@<target-version>`, dist-tags like `@latest`, and local tarballs like `.\garda-agent-orchestrator-<target-version>.tgz`.
- Trusted npm registry specs are resolved before apply to an exact `name@version` package with registry integrity metadata. Update and check-update output include requested, exact, resolved-version, and resolved-integrity fields when registry provenance is available.
- Output also includes `ReleaseProvenanceStatus`, `ReleaseProvenanceSummary`, and `ReleaseProvenanceRecommendation`. The preferred release path is npm registry provenance with integrity; local or override sources are marked unverified.
- `--source-path` is for local testing against an unpacked repo or bundle directory.
- `--trust-override` is an explicit bypass for non-allowlisted npm specs, git sources, or local `--source-path` testing, and the public CLI only accepts it together with `--no-prompt`.
- Ordinary CLI/runtime flows ignore `GARDA_UPDATE_TRUST_OVERRIDE`; that environment variable is reserved for test-only harness paths, not for production or CI.
- If Garda is off, `--apply` fails before source acquisition, bundle sync, rollback, verify, or manifest validation. Run `garda on` first. Read-only `check-update` and `--dry-run` checks remain available in off mode.
- `--apply` runs the full update lifecycle after bundle sync, re-materializes `live/`, applies built-in live-rule contract migrations for existing workspaces, runs verify plus manifest validation, enforces a hard atomic consistency invariant for the deployed bundle, defers `VERSION` until lifecycle success, and creates rollback artifacts for the last applied update.
- After an apply, long-lived hosts reject later commands until Garda starts in a new process.
- Human update output stays operator-focused and omits internal workflow-config merge and project-memory handoff text. Structured JSON output and update reports still include those fields for automation and diagnostics.

### `garda update`

Apply the update workflow directly.

```text
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --package-spec "garda-agent-orchestrator@latest"
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --source-path "."
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --dry-run
```

Notes:
- `update` always applies the update workflow unless `--dry-run` is used.
- If Garda is off, `update` fails before rollback snapshot creation, install, verify, or manifest validation. Run `garda on` first; `--dry-run` remains available.
- Trusted npm registry specs are resolved before install to an exact package version with integrity metadata, and the resolved provenance is recorded in CLI output and update reports.
- Release provenance status, summary, and recommendation are recorded alongside trust-policy fields. For release-sensitive updates, prefer the package-manager path when registry integrity is available.
- Use `--trust-override --no-prompt` only when you intentionally bypass the trusted-source allowlist for a local or non-standard source; the update report records that override.
- Successful applies sync bundle files, run install, re-materialize `live/`, apply built-in live-rule contract migrations for existing workspaces, run verify plus manifest validation, and only then write the final `VERSION` marker.
- Successful applies create rollback artifacts under `garda-agent-orchestrator/runtime/update-rollbacks/` and `garda-agent-orchestrator/runtime/bundle-backups/`.
- Successful applies run the updated bundle lifecycle through a fixed entry in a fresh Node process. The handoff rejects a missing or linked entry and confines CommonJS and native ESM module resolution to the deployed `dist` runtime. Long-lived hosts must start a new Garda process before issuing another command after an apply.
- Update reports now reflect actual execution status; steps with no configured runner are reported as skipped rather than pass.
- Human output omits internal workflow-config merge and project-memory handoff text; use `--json` or the generated update report for those diagnostic details.
- Use `garda check-update --apply` when you want a compare-first flow with optional apply.

### `garda update git`

Apply the update workflow from a git source explicitly.

```text
garda update git --target-root "." --repo-url "https://github.com/Garda-Studio/garda-agent-orchestrator.git"
garda update git --target-root "." --repo-url "." --check-only
garda update git --target-root "." --repo-url "." --branch "master"
garda update git
```

Notes:
- `update git` clones an HTTPS repository or explicit local path into a temp directory, verifies the selected source and ref, then runs the same update lifecycle as npm-based `update`. Local paths use Git's local clone mode; `file://` URLs and URLs with credentials or parameters are rejected before clone. Applying requires `VERSION`, `package.json`, `bin/garda.js`, and `dist/src/index.js` in the selected Git commit, with a clean regular-file bundle tree. Garda does not install dependencies or run repository build scripts from the clone. A source-only ref can still be used with `--check-only`; for apply, use a ref with a committed prebuilt bundle or the trusted npm update path.
- `--check-only` compares the git source without applying it.
- If Garda is off, applying `update git` fails before cloning the update source. Run `garda on` first; `--check-only` remains available.
- Trusted git sources stay in enforced mode; if you bypass git-source trust with `--trust-override --no-prompt`, that override is recorded in CLI output and the update report.
- Git updates record a trusted-source/no-release-signature provenance status. For release-sensitive git updates, run `garda update git --check-only` or `garda update git --dry-run` first, or prefer the npm update path with registry integrity.
- With no extra flags, `garda update git` targets the current directory and uses the default GitHub repository URL.
- Successful applies use the same fresh-process lifecycle handoff as npm-based `update`; long-lived hosts must start a new Garda process before another command.
- Same-version content-drift syncs keep human output focused on operator-visible status and drift fields; internal workflow-config and project-memory handoff details remain available in JSON/report output.

### `garda rollback`

Rollback to a specific orchestrator version or restore from the latest rollback snapshot.

```text
garda rollback --target-root "."
garda rollback --target-root "." --dry-run
garda rollback --target-root "." --snapshot-path "garda-agent-orchestrator/runtime/update-rollbacks/update-20260325-114000"
garda rollback --target-root "." --to-version "<target-version>" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda rollback --target-root "." --to-version "<target-version>" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --source-path "." --trust-override --no-prompt
garda rollback --target-root "." --to-version "<target-version>" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --package-spec "garda-agent-orchestrator@<target-version>"
```

Notes:
- Without `--to-version`, `rollback` restores only the selected pre-update workspace snapshot, including its recorded bundle and `VERSION`. It verifies the snapshot records and file hashes before restoration and checks the restored files afterward. Unrelated bundle backups are not overlaid.
- With `--to-version`, `rollback` acquires that orchestrator version, syncs the bundle, re-runs install/materialization, updates `VERSION` only after success, then verifies the restored workspace and manifest unless their explicit skip flags are set.
- `--source-path` requires `--trust-override --no-prompt`, as with a local update source. Its result receives the same post-restore verification as other version sources.
- `--init-answers-path` is required for version-based rollback because the workspace is re-materialized for the requested version.
- `--snapshot-path` applies to snapshot-mode rollback; with no `--snapshot-path`, `rollback` uses the latest saved rollback snapshot automatically.
- Older snapshots without integrity metadata require manual recovery; Garda will not restore unauthenticated records automatically. The local hashes detect changes to a snapshot after capture but do not establish publisher identity or protect against a local actor who can rewrite the snapshot and its metadata together.
- After a successful non-dry-run rollback, start a new Garda process before another command so the restored bundle is loaded from disk.

### `garda backup`

Create a manual rollback backup snapshot in the backup inventory.

```text
garda backup create --target-root "." --dry-run
garda backup create --target-root "." --confirm
garda backup create --target-root "." --confirm --json
```

Notes:
- `backup create --confirm` writes a `manual-<timestamp>` snapshot under `garda-agent-orchestrator/runtime/update-rollbacks/` with rollback records, so the Backups UI can restore it through the guarded rollback path.
- `--dry-run` is read-only and reports the planned target without creating files.
- The live `garda ui --actions` Backups tab exposes the same create path as a guarded browser action that requires the exact confirmation phrase `CREATE BACKUP`.

### `garda cleanup`

Preview or apply retained runtime artifact cleanup under `garda-agent-orchestrator/runtime/` using count-, age-, and runtime-retention policy limits. Use `--dry-run` to preview removals and compression without deleting anything.

```text
garda cleanup --target-root "."
garda cleanup --target-root "." --dry-run
garda cleanup --target-root "." --max-age-days 14 --max-backups 5 --max-task-events 30
garda cleanup --target-root "." --runtime-retention-older-than-days 30 --runtime-retention-keep-latest-tasks 20
garda cleanup --target-root "." --max-reviews 20 --max-working-plans 50 --max-update-rollbacks 10 --max-update-reports 10 --max-bundle-backups 10
garda cleanup policy --target-root "."
garda cleanup policy edit --target-root "."
garda cleanup policy --edit --target-root "."
garda cleanup policy reset --target-root "."
garda cleanup policy --retention-mode summary --compress-after-days 14 --target-root "."
garda gc --target-root "." --category reviews
garda gc --target-root "." --runtime-retention-older-than-days 30 --runtime-retention-keep-latest-tasks 20
garda gc --target-root "." --confirm --category reviews
```

Notes:
- `cleanup` only operates on supported runtime artifact categories: backups, bundle-backups, task-event logs, review artifacts, Markdown working plans, generated temp/cache/report/update zones, project-memory impact artifacts, metrics, update-rollbacks, and update-reports.
- `--dry-run` reports projected removals, compression, retention tiers, and bytes reclaimed without mutating the filesystem.
- Retention accepts a global artifact age limit (`--max-age-days`), task-scoped runtime retention controls (`--runtime-retention-older-than-days`, `--runtime-retention-keep-latest-tasks`), and per-category count limits (`--max-backups`, `--max-task-events`, `--max-reviews`, `--max-working-plans`, `--max-update-rollbacks`, `--max-update-reports`, `--max-bundle-backups`).
- `--runtime-retention-older-than-days N` limits task-scoped runtime retention to tasks whose retained audited artifacts are older than N days; `--runtime-retention-keep-latest-tasks N` preserves the latest N inactive task groups by filesystem recency. Both values must be non-negative integers and can be combined.
- Backup-related count defaults keep the latest 10 entries.
- Count-based eviction uses **real filesystem recency** (file modification time), not task-id ordering. When the number of items exceeds the cap, the least recently modified entries are removed first. When modification times are equal, task-id / filename order is used as a deterministic tie-breaker.
- For review artifacts, recency is determined per task group: the most recent `mtime` among all files in a `T-xxx-*` group represents that group's freshness.
- Runtime retention is tiered. Active tasks remain active evidence. Healthy `DONE` tasks can compact detailed runtime artifacts into `runtime/task-ledger/<task-id>.json` history only after the ledger verifies. Blocked, failed, incomplete, tampered, or ambiguous tasks keep recovery-readable evidence and may only compress heavy forensic artifacts such as raw outputs, review contexts/outputs, and scoped diffs.
- Clean-success compile and full-suite raw logs may not exist after a green run. Those gates keep compact retention evidence with status, duration, hashes, and line/char counts; warning, failure, timeout, and non-clean runs retain raw output.
- Full purge is not automatic. Review the dry-run output first, then rerun with `--confirm` only when you intentionally accept the deletion or compression plan.
- Working-plan retention is limited to `garda-agent-orchestrator/runtime/plans/*.md` files named after canonical task IDs. Active task plans are preserved, and cleanup never targets user project `plans/` directories outside the Garda runtime path.
- `runtime/task-events/all-tasks.jsonl` is subject to aggregate line-count retention (`--max-aggregate-lines` via cleanup/gc policy). Tail pruning keeps the most recent entries and discards the oldest when the aggregate exceeds the configured cap. The file is never deleted outright by cleanup.
- `runtime/task-events/all-tasks.jsonl` is a derived aggregate index; the canonical task record remains `runtime/task-events/<task-id>.jsonl`.
- Set `GARDA_LOW_NOISE_RUNTIME_WRITES=1` or `GARDA_RUNTIME_WRITES_MODE=low-noise` to reduce IDE file-watcher churn from rebuildable derived runtime files. In this mode ordinary gate writes still persist canonical per-task timelines, review artifacts, receipts, locks, and hash-chain data, but skip opportunistic writes to `runtime/task-events/all-tasks.jsonl`, `runtime/task-events/.timeline-summary.json`, `runtime/metrics.jsonl`, and `runtime/reviews/reviews-index.json`. Read paths can rebuild indexes in memory, and `garda repair rebuild-indexes --confirm` still persists derived indexes explicitly when the operator asks for it.
- Cleanup runs under the lifecycle operation lock to avoid concurrent mutation of the same runtime state.
- `cleanup policy` shows the current persistent review-artifact storage settings from `live/config/review-artifact-storage.json`.
- `cleanup policy` also shows read-only runtime-retention settings from `live/config/runtime-retention.json`: healthy-DONE compaction age, problem-task compression age, confirm-only purge, and daily maintenance posture.
- `cleanup policy edit` is the dialog-first editor for retention mode, compression threshold, and receipt preservation. `cleanup policy --edit` is an alias.
- `cleanup policy reset` restores the bundled default policy template. `cleanup policy --reset` is an alias.

### `garda repair`

Inspect and repair rebuildable runtime control-plane state without hand-editing files.

```text
garda repair inspect --target-root "."
garda repair inspect --target-root "." --json
garda repair rebuild-indexes --target-root "."
garda repair rebuild-indexes --target-root "." --confirm
garda repair protected-manifest --target-root "."
garda repair protected-manifest --target-root "." --confirm
garda repair locks --target-root "."
garda repair locks --target-root "." --cleanup-stale
garda repair locks --target-root "." --cleanup-stale --confirm
garda repair catalog health --target-root "."
garda repair catalog drift --target-root "."
garda repair catalog repair --target-root "."
garda repair catalog repair --target-root "." --confirm
garda repair catalog rebuild --target-root "."
garda repair catalog rebuild --target-root "." --confirm
garda repair task-events migrate-legacy-suffix --task-id T-123 --target-root "." --json
garda repair task-events migrate-legacy-suffix --task-id T-123 --target-root "." --apply --expected-plan-sha256 HASH --json
```

Notes:
- `repair inspect` is read-only. It names canonical state (`runtime/task-events/<task-id>.jsonl`, review artifacts, protected manifest) separately from rebuildable derived indexes (`.timeline-summary.json`, `reviews-index.json`).
- `repair rebuild-indexes` is dry-run by default. With `--confirm`, it rebuilds `.timeline-summary.json` from canonical per-task event logs and rebuilds `runtime/reviews/reviews-index.json` from review artifact files.
- `repair protected-manifest` is dry-run by default. With `--confirm`, it refreshes the trusted protected control-plane manifest from the current workspace snapshot.
- `repair locks` inspects task-event, review-artifact, and completion-finalization lock classes. Cleanup is dry-run unless both `--cleanup-stale` and `--confirm` are provided.
- Completion-finalization locks are inspected only; they are not deleted by `repair locks` because they protect task finalization.
- `repair catalog health` validates canonical inputs, SQLite compatibility, and exact snapshot parity without changing canonical files.
- `repair catalog drift` reports the canonical sources whose hashes differ from the current derived catalog.
- `repair catalog repair` and `repair catalog rebuild` are dry-run by default. `--confirm` repairs drift or performs an explicit batched rebuild; confirmed corruption repair quarantines the database, WAL, and SHM recovery unit before rebuilding from canonical files.
- `repair task-events migrate-legacy-suffix` previews a migration only when a valid terminal integrity-schema-v1 suffix is anchored directly to a trusted schema-v2 event. It preserves event payloads and rebuilds only suffix integrity metadata.
- Applying a task-event suffix migration requires `--apply` and the exact `--expected-plan-sha256` emitted by the current preview. Apply revalidates identity and content under the task lock, creates and verifies a root-confined backup, atomically replaces the timeline, and verifies canonical integrity before reporting success.
- Invalid, unanchored, mixed, replayed, foreign-task, symlinked, raced, oversized, or already-current timelines are not modified. A repeated apply against an already-current timeline is an idempotent no-op.

### `garda gc`

Extended cleanup helper with dry-run default, category filters, runtime-retention preview, and `clean` alias support.

```text
garda gc --target-root "."
garda gc --target-root "." --dry-run
garda gc --target-root "." --confirm --category reviews --category task-events
garda gc --target-root "." --category plans --max-working-plans 25
garda clean --target-root "." --confirm
```

Notes:
- `gc` is dry-run by default; pass `--confirm` to apply removals.
- `clean` is a public alias for `gc`.
- `--category plans` limits `gc` to retained Markdown working plans under `garda-agent-orchestrator/runtime/plans/*.md`; active task plans are preserved.
- `--category reviews` previews or applies retention-approved review artifact removal/compression. Healthy `DONE` tasks require verified ledger evidence before ledger-only compaction; problem tasks stay recoverable and compress only heavy forensic artifacts.
- Daily opportunistic maintenance after final closeout uses the same retention-only GC path, is lock-bound and non-critical, and defaults to dry-run. It writes a small daily report sentinel and does not perform broad generated-zone cleanup from the finalization path.

### Task Reset Aliases

Safe aliases for the guarded task reset gate. They route directly to `garda gate task-reset` and enforce the same confirmation requirements.

```text
garda task-reset T-137 --reopen --dry-run
garda workflow set --target-root "." --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda task-reset T-137 --discard --confirm
garda task reset T-137 --reopen --confirm
```

Notes:
- `task-reset` and `task reset` are aliases that route to the `garda gate task-reset` command.
- They route through `garda gate task-reset --task-id "<task-id>" --reopen --dry-run/--confirm --repo-root "."` or `--discard --confirm`.
- Confirmed task-reset mutations are disabled by default. `--dry-run` remains available for inspection, but `--confirm` requires an audited opt-in via `garda workflow set --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`; manual JSON edits to `task_reset.enabled=true` are rejected unless matching workflow-set audit evidence exists.
- Task-reset-shaped near-misses (e.g., `garda taskreset`, `garda resettask`) fail early with remediation guidance before the bootstrap directory creation process.

### `garda workflow`

Show or change repo-local workflow configuration.

```text
garda workflow --target-root "."
garda workflow show --target-root "." --json
garda workflow set --target-root "." --compile-gate-command "<compile/build/type-check command>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --full-suite-enabled true --full-suite-placement before_test_review --full-suite-command "npm test" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --review-execution-policy strict_sequential --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --scope-budget-enabled true --scope-budget-warn-review-tokens 50000 --scope-budget-block-review-tokens 100000 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --review-cycle-enabled true --review-cycle-max-total-non-test-reviews 30 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --review-cycle-auto-split-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --auto-backup-enabled true --auto-backup-interval-days 1 --auto-backup-keep-latest 10 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --garda-self-guard on
garda workflow set --target-root "." --garda-self-guard off --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow explain --target-root "."
```

Notes:
- `workflow` with no subcommand behaves like `workflow show`.
- The current surface manages repo-local `compile_gate`, `full_suite_validation`, `review_execution_policy`, `scope_budget_guard`, `review_cycle_guard`, `task_reset`, and `auto_backup` settings in `live/config/workflow-config.json`.
- `full_suite_validation.command` uses one direct argv command and validates its argument syntax with the same parser as the executor before the gate starts a child. Its contract rejects unquoted shell control operators and environment-assignment prefixes, direct shell interpreters, shell interpreters delegated through recognized transparent process hosts, direct executable paths with known shell-script extensions, and WSL commands without an explicit `-e` / `--exec` boundary. Dollar signs, parentheses and backticks in ordinary arguments stay literal, without shell expansion. Quote control operators when they are argument data; use `env NAME=value <program>` for environment delegation. It does not infer the behavior of arbitrary executables or reinterpret their data arguments, and it does not inspect executable contents, symlink targets, or `PATH` identity. Put compound commands in a trusted wrapper such as an npm script and configure `npm run <wrapper-script>`.
- `compile_gate.command` is the executable compile-gate source. Missing values or `__COMPILE_GATE_COMMAND_UNCONFIGURED__` fail closed instead of falling back to `40-commands.md`.
- Compile commands accept direct executable arguments and sequential unquoted `&&` chains. Each segment runs only after its predecessor succeeds; the first failure stops the chain and preserves its exit code. The timeout covers the entire chain. Async cancellation stops the active child and prevents later segments; the sync executor observes an already-aborted signal before each segment.
- Aggregate output payload is bounded to 40 MiB for the complete chain, plus a bounded truncation marker. Overflow preserves the beginning and latest tail; the returned result is redacted, including failure and interruption diagnostics.
- Single and double quotes preserve arguments, paths with spaces, empty direct-executable arguments, and literal `"&&"`. Executable names remain literal, including quoted whitespace; `"npm "` does not resolve to `"npm"`. Outside quotes backslashes are literal; inside double quotes they escape a double quote or backslash. Quotes may be concatenated with ordinary argument text. Ordinary unquoted `$NAME`, `folder(name)`, backticks and `$(value)` remain argument data. There is no variable, command or glob expansion.
- Unsupported unquoted pipes, `||`, single `&`, redirects, semicolons, newlines and leading environment assignments are rejected before execution, including during compile configuration. Quote control operators when they are literal arguments; put shell behavior requiring interpretation in a trusted wrapper script. Windows batch entrypoints retain their safety checks and reject empty arguments or literals containing quotes, percent signs, exclamation marks, NUL, CR or LF.
- For example: `npm --prefix "store frontend" run build && mvn -f "service backend/pom.xml" -DskipTests compile`. Maven skip-test flags and Gradle test exclusions are validated separately for each segment; a flag in one command cannot authorize a test-bound command elsewhere in the chain.
- Executable strings supplied by `npm exec`/`npm x`/`npx` `--call`/`-c` or pnpm shell mode are checked with the same command syntax and compile/test restrictions, including nested supported chains. Put other shell syntax in a trusted wrapper. Normal package, path and program argument values remain data; npm's `--` boundary and npx's first positional argument end their option parsing.
- Native shell command strings use a narrower portable subset: inner single quotes, backslashes, `$`, backticks, `%`, `!`, `^`, `*`, `?`, `[`, `]`, `{`, `}`, `~` and newlines are rejected even inside quotes; use a trusted wrapper for their shell interpretation. Unquoted grouping parentheses and shell comments also require a wrapper; parentheses inside simple double-quoted values and literal hashes such as `folder#name` remain supported. The validator accepts simple double-quoted values and supported `&&` chains, subject to the existing Windows batch argument checks. Direct argv values retain their literal contract. Configured full-suite identity is checked for the enclosing segment before its executable string is inspected.
- Compile configuration also rejects native inline shell dispatch (`sh -c`, `cmd /c` or `/k`, PowerShell command/encoded-command options), shell dispatch builtins (`exec`, `command`, `eval`, `source`, `.`), and `env -S`/`--split-string`, including through recognized package runners. Use a trusted wrapper file for that executable text. Interpreter file forms such as `sh scripts/build.sh` and `pwsh -File scripts/build.ps1` remain supported, and later arguments belong to the wrapper. The generic command executor retains direct argv execution; these additional checks belong to compile configuration.
- Compile configuration supports WSL only with a case-sensitive `--exec` or `-e` boundary and a nonempty delegated program. Host options before it may be `-d`/`--distribution`, `--distribution-id`, `-u`/`--user`, `--cd`, `--shell-type` with separate nonempty values, or boolean `--system`. Option operands remain data even when named `test`, `pytest` or `--exec`. After the program, every value belongs to its argv; delegated test/full-suite and inline-shell checks still apply through nested package runners. Default-shell execution, `--option=value` and unsupported host options receive an actionable error directing the operator to `wsl --exec <program> <args>` or a trusted wrapper.
- Configured full-suite identity is checked before executable-string expansion and at every recognized executable boundary, including intermediate package runners beneath transparent wrappers and WSL. Quoted command-looking data remains literal. The validator does not inspect arbitrary executable or wrapper contents, symlinks or `PATH` identity.
- Windows and Linux share this portable syntax contract. Local Node 24 checks cover both executors and compile configuration on Windows and Linux; actual WSL host invocation is checked on Windows. macOS was not validated for this change.
- `--compile-gate-command` must stay a compile/build/type-check command and must not match the configured full-suite validation command.
- Scheduled auto-backups are disabled by default and run only through the existing daily maintenance trigger when enabled; configure them with `--auto-backup-enabled`, `--auto-backup-interval-days`, and `--auto-backup-keep-latest`.
- `workflow set` changes require explicit operator approval with `--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`. A standalone `--garda-self-guard on` change is permitted without confirmation because it tightens protection. A true no-op needs no approval; requesting a task-reset audit repair still requires fresh confirmation. Agents must not approve workflow-config mutations for themselves.
- `--garda-self-guard on` maps to `orchestrator_work_policy.mode=deny_agent_entry`; `off` maps to `require_operator_confirmation` and requires explicit operator approval.
- Supported `review_execution_policy` modes are `parallel_all`, `test_after_code`, `code_first_optional`, and `strict_sequential`.
- `parallel_all` can make code, security, refactor, API, and other specialist lanes independent. Full-suite placement still applies: `before_test_review` gates only `test`, `after_compile_before_reviews` gates all reviewers after compile, and `before_completion` defers enforcement until completion.
- Fresh materialization writes the recommended default `review_execution_policy.mode=code_first_optional`.
- Existing repos that still omit `review_execution_policy` stay on the legacy compatibility path (`test` waits for all required upstream reviews, other review types remain independent) until an operator explicitly sets one of the supported modes.
- Scope budget guard settings can be changed with `--scope-budget-enabled true|false`, `--scope-budget-profiles strict,balanced`, `--scope-budget-warn-files N`, `--scope-budget-block-files N`, `--scope-budget-warn-changed-lines N`, `--scope-budget-block-changed-lines N`, `--scope-budget-warn-required-reviews N`, `--scope-budget-block-required-reviews N`, `--scope-budget-warn-review-tokens N`, and `--scope-budget-block-review-tokens N`. Legacy `--scope-budget-action` and `--scope-budget-max-*` flags remain accepted for old automation; `--scope-budget-action` only controls how legacy `max_*` values map to tiered thresholds and does not disable explicit `block_*` blocking.
- The default scope budget guard is enabled for `strict`, warns above `20` files or `2000` changed lines, and blocks above `50` files or `5000` changed lines. Required review type defaults warn above `5` and block above `8`; review-token defaults warn above `50000` and block above `100000`.
- Required review thresholds mean distinct review types required by the current preflight. Disabled review capabilities do not become required just because matching files changed; this is not the number of reviewers, completed review attempts, or review cycles.
- Review-token thresholds use a heuristic review forecast, not a measured tokenizer count; use `garda workflow explain` to show the effective workflow guard settings, behavior, and unblock options.
- Review cycle guard settings can be changed with `--review-cycle-enabled true|false`, `--review-cycle-action BLOCK_FOR_OPERATOR_DECISION|WARN_ONLY`, `--review-cycle-max-failed-non-test-reviews N`, `--review-cycle-max-total-non-test-reviews N`, `--review-cycle-excluded-review-types test`, and `--review-cycle-auto-split-enabled true|false`.
- The default review cycle guard is enabled, uses `BLOCK_FOR_OPERATOR_DECISION`, blocks when failed non-test reviews exceed `15` or total non-test review attempts exceed `30`, and excludes `test` review from counting.
- Review cycle attempts are counted from review invocation and recorded-review timeline evidence with deduplication only when both reviewer identity and review context hash match; `test` is excluded because reaching test review means upstream code-oriented review gates already allowed the task forward.
- When `review_cycle_guard.action=BLOCK_FOR_OPERATOR_DECISION`, `next-step` blocks compile, review, and full-suite continuation until the operator chooses a recovery path. `allow_one_more_cycle` records task-scoped runtime evidence through `gate record-review-cycle-continuation` and does not edit `workflow-config.json`; `raise_limits` is a permanent repo-local policy change through `workflow set` and requires separate operator approval.
- When `review_cycle_guard.auto_split_enabled=false` (default), `next-step` tells the agent to wait for operator direction after a blocking review-cycle violation.
- When `review_cycle_guard.auto_split_enabled=true`, `next-step` emits a dedicated auto-split prompt artifact for the agent from the bundled template at `template/docs/prompts/review-cycle-auto-split.md`. The template is materialized into `runtime/reviews/<task-id>-review-cycle-auto-split-prompt.md` only when a blocking review-cycle violation actually happens. The prompt tells the agent to preserve unfinished parent diff through the split checkpoint path, create maximally small linked parent-derived child tasks such as `<task-id>-1`, choose the next non-conflicting suffix from `TASK.md`, rerun `next-step` so the parent can move from `SPLIT_REQUIRED` to `DECOMPOSED`, and then execute those child tasks sequentially. Strict decomposition `split-required` decisions use the same linked-child routing shape but are stricter: child rows must match the recorded proposed-child list, exist in `TASK.md`, remain parent-derived, and keep profile `strict`. The prompt must not auto-commit unfinished or unreviewed work, and it must not mark the parent `DONE` merely because split work exists.
- `next-step` also supports parents that were already marked `DECOMPOSED` by an agent or operator rather than by a Garda split gate. Record this audibly in Notes as `Decomposition source: manual-agent` or `Decomposition source: manual-operator` followed by an explicit `child tasks:` list or `child range <first> through <last>`. The older `Manual operator-requested decomposition (...): child range ...` form remains compatible. Manual provenance suppresses any expectation of nonexistent split-decision artifacts, but it does not weaken routing: the parent is never executed directly, missing declared child rows are named, and no child is inferred from unrelated or merely parent-prefixed task IDs.
- `WARN_ONLY` does not block the next gate, but `next-step` prints the review-cycle violation under `Warnings` so the operator still sees the over-budget review cycle.
- Task reset mutations are controlled by `task_reset.enabled`, default to `false`, and can be changed with `--task-reset-enabled true|false`. Enabling task reset through `workflow set` records the audit evidence required by confirmed `garda gate task-reset` mutations.

#### Operator Confirmation and Automation

Use canonical `--operator-confirmed yes` in commands. The confirmation parser trims surrounding whitespace and compares case-insensitively, so `YES` and ` Yes ` have the same meaning; `true`, `1`, an empty value, or a missing approval are not substitutes. This normalization does not supply operator authorization.

Where fresh approval is required, pass the actual approval time in `--operator-confirmed-at-utc` as an ISO-8601 timestamp. The shared validator rejects invalid timestamps, approvals older than ten minutes, and timestamps more than one minute in the future. Do not replay a stored approval or manufacture one in unattended automation.

For `restart-coherent-cycle`, confirmation is conditional on re-entry into the prior protected task mode. Ordinary unprotected restarts do not require it; follow the command printed by `next-step`. Recovery preserves the previous protected-work intent and does not use optional-looking help flags to bypass entry policy.

Inspect settings with `workflow show` or `workflow explain`. For an authorized change, invoke `workflow set` with the required confirmation flags instead of writing `workflow-config.json` directly. A wrapper must pass the real approval and propagate command failure. In `garda ui --actions`, the server checks the action boundary and the typed confirmation phrase before invoking the same audited command with a current timestamp; a preview does not apply settings. Setup/init/update materialization and test fixtures have their own configuration-writing responsibilities and are not an approval bypass for ordinary setting changes.

### `garda templates`

Show, validate, and manage user-owned effective message template overrides.

```text
garda templates --target-root "."
garda templates list --target-root "."
garda templates show --template final-report --target-root "."
garda templates path --template commit-message --target-root "." --json
garda templates edit --template reviewer-prompt --target-root "."
garda templates validate --target-root "."
garda templates validate --template final-report --target-root "."
garda templates reset --template final-report --target-root "."
```

Notes:
- `templates` with no subcommand behaves like `templates list`.
- Supported template ids are `final-report`, `commit-message`, and `reviewer-prompt`.
- Built-in templates live under `template/templates/**`; user-owned overrides live under `live/templates/*.user.*`.
- `templates edit` creates the user override file when it is missing and prints the path to edit. It does not launch an editor.
- `templates validate` fails closed when an effective template removes required placeholders, edits protected Garda sections, allows auto-commit wording, or breaks the JSON contract for commit-message templates.
- `templates reset` removes only the selected user-owned override and restores the built-in effective template.

### `garda review-capabilities`

Show, list, enable, or disable repo-local optional review capabilities without hand-editing `review-capabilities.json`.

```text
garda review-capabilities --target-root "."
garda review-capabilities list --target-root "."
garda review-capabilities show --target-root "." --json
garda review-capabilities enable api test --target-root "."
garda review-capabilities disable performance --target-root "."
```

Notes:
- `review-capabilities` with no subcommand behaves like `review-capabilities show`.
- `review-capabilities list` is an alias for `review-capabilities show`.
- Supported toggle targets are `api`, `test`, `performance`, `infra`, and `dependency`.
- Enabling a capability validates that a matching live review skill is present under `live/skills/**`; bridge presence is reported separately for bridge-hosted providers, but root-entrypoint providers use the live skill directly.
- Unsupported custom live skills remain manual-only and do not become preflight-triggered review types automatically.

### `garda review-catalog`

Inspect built-in and custom review lanes, validate catalog/profile/dependency resolution, and manage custom lanes through a guarded transaction.

```text
garda review-catalog list --target-root "."
garda review-catalog validate --target-root "."
garda review-catalog show <review-id> --profile <name> --target-root "."
garda review-catalog explain <review-id> --profile <name> --target-root "."
garda review-catalog create <review-id> --display-label <label> --skill-id <skill-id> --trigger-mode <manual|signals> [definition options] --target-root "."
garda review-catalog update <review-id> [definition options] --target-root "."
garda review-catalog enable|disable <review-id> --target-root "."
garda review-catalog profile-bind <review-id> --profile <name> --state <disabled|auto|required> --target-root "."
garda review-catalog dependency <review-id> --profile <name> --depends-on <review-id> --target-root "."
garda review-catalog dependency <review-id> --profile <name> --clear-dependencies --target-root "."
garda review-catalog migrate --target-root "."
garda review-catalog migrate --confirm --expected-state-sha256 <hash> --expected-plan-sha256 <hash> --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601> --target-root "."
garda review-catalog migrate --apply --expected-state-sha256 <hash> --expected-plan-sha256 <hash> --confirmation-receipt-sha256 <hash> --target-root "."
```

Notes:

- A missing `live/config/review-catalog.json` is legacy-compatible: inspection exposes the built-in lanes with their canonical verdict tokens.
- `migrate` is an explicit guarded migration for legacy configuration. Its first call is a dry-run that validates and normalizes the catalog, capabilities, and profiles, then reports parity hashes for required reviews, verdict/receipt tokens, dependency order, and task-report lanes without writing.
- Migration retains `review-capabilities.json`, preserves its effective choices and the configured or implicit review-execution preset, and never enables custom lanes. It uses the same separate confirmation, one-time receipt, transaction lock, audit, backup, and rollback path as catalog mutations.
- A stale workflow preset, invalid legacy config, interrupted publish, or parity mismatch fails closed. A repeated migration after successful normalization returns an unchanged preview and applies as `NO_CHANGE` when separately confirmed.
- Custom lanes are declarative and disabled by default. The CLI rejects prompt bodies, verdict-token overrides, built-in replacement, and unrecognized fields.
- `list`, `show`, `explain`, and `validate` are read-only. Mutations affect future task snapshots only.
- A mutation call without a phase flag is preview-only. Confirm the exact preview with `--confirm --expected-state-sha256 <hash> --expected-plan-sha256 <hash> --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601>`, then apply it with `--apply`, the same expected hashes, and `--confirmation-receipt-sha256 <hash>`.
- Confirmation receipts are one-time and stale-state-bound. The transaction rejects active agent tasks, concurrent writers, changed config or filesystem boundaries, and replayed receipts.
- Successful apply records audit and backup paths. A later publish failure automatically rolls all managed files back and records the rollback diagnostic.
- Profile state and the validated dependency graph determine eligibility and review launch order; they do not retroactively alter an already-entered task.

### `garda profile`

Manage the active workspace profile and user-defined profile presets.

```text
garda profile list --target-root "."
garda profile current --target-root "."
garda profile use strict --target-root "."
garda profile create --target-root "."
garda profile create my-profile --target-root "." --copy-from balanced --depth 2 --description "Custom profile"
garda profile delete my-profile --target-root "."
garda profile validate --target-root "."
```

Notes:
- Running `garda profile create` with no profile name in a TTY starts the full interactive profile builder.
- The interactive builder can customize depth, review policy, token economy, and skill behavior for the new profile.
- Passing `<name>` plus flags keeps `profile create` script-friendly for automation.
- Profiles are stored in `live/config/profiles.json` and preserved across init/reinit/update merges.

### `garda uninstall`

Remove the orchestrator from a project.

```text
garda uninstall --target-root "."
garda uninstall --target-root "." --no-prompt
garda uninstall --target-root "." --dry-run --no-prompt --keep-task-file no
garda uninstall --target-root "." --no-prompt --keep-primary-entrypoint no --keep-task-file no --keep-runtime-artifacts yes
```

Notes:
- Uninstall removes managed blocks, bridge files, and the deployed bundle while preserving unrelated user content.
- `TASK.md` is preserved by default, including with `--no-prompt`, so the operator queue survives uninstall and later setup/reinstall.
- `--keep-task-file no` is the explicit destructive override for removing the managed task queue. Without `--skip-backups`, output includes `TaskFileRecoveryPath` for the exact pre-removal copy.
- Combining `--keep-task-file no` with `--skip-backups` intentionally removes the managed queue without a recovery copy and emits a warning.
- Before destructive work, uninstall creates an internal journal snapshot and attempts automatic restore if the uninstall flow fails mid-run.
- `--skip-backups` skips the user-facing recovery backup copies; use it only when you intentionally accept losing those recovery artifacts.
- `--keep-runtime-artifacts yes` preserves runtime reports, rollback snapshots, and task-event history under `garda-agent-orchestrator/runtime/`, along with user-owned `live/docs/project-memory/**`.

### `garda skills`

Manage optional built-in domain packs and generate code-driven recommendations from the compact skills index.

```text
garda skills list --target-root "."
garda skills suggest --target-root "." --task-text "Fix slow API endpoint" --changed-path "src/api/users.ts"
garda skills add java-spring --target-root "."
garda skills remove java-spring --target-root "."
garda skills validate --target-root "."
```

Rules:
- `skills suggest` reads only `live/config/skills-index.json` to score optional skills.
- After user selection, the chosen pack is installed into `live/skills/**` without reading its full optional `SKILL.md` immediately.
- Full optional `SKILL.md` files are loaded only when a selected skill is actually activated for a task or a hard activation rule requires it.

### `garda diff-managed`

Show managed vs user-owned block ownership across workspace files.

```text
garda diff-managed --target-root "."
garda diff-managed --target-root "." --json
```

---

## Gate Commands

### `garda gate`

Canonical gate surface is `garda gate <name>` or `node bin/garda.js gate <name>`.

| Gate | Canonical invocation |
|---|---|
| Enter task mode | `garda gate enter-task-mode --task-id "T-001" --task-summary "..."` (`--orchestrator-work --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"` for tasks that modify protected control-plane paths after explicit operator approval — see [orchestrator-work-and-isolation](orchestrator-work-and-isolation.md)) |
| Restart coherent cycle | `garda gate restart-coherent-cycle --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Restart review cycle | `garda gate restart-review-cycle --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json" --impact-analysis "<replace with main-agent remediation impact analysis>"` |
| One-shot review-cycle continuation | `garda gate record-review-cycle-continuation --task-id "T-001" --decision "allow_one_more_cycle" --baseline-total-non-test-reviews "<current total>" --baseline-failed-non-test-reviews "<current failed>" --max-total-non-test-reviews "<configured total limit>" --max-failed-non-test-reviews "<configured failed limit>" --excluded-review-types "test" --reason "<operator-approved reason>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"` |
| Load rule pack | `garda gate load-rule-pack --task-id "T-001" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md"` |
| Bind rule pack to preflight | `garda gate bind-rule-pack-to-preflight --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Classify change | `garda gate classify-change --use-staged --task-id "T-001" --task-intent "..."` |
| Compile gate | `garda gate compile-gate --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Optional skill activation | `garda gate activate-optional-skill --task-id "T-001" --skill-id "<selected-skill-id>"` |
| Review gate | `garda gate required-reviews-check --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Audited no-op | `garda gate record-no-op --task-id "T-001" --reason "Already implemented in current branch"` |
| Doc impact | `garda gate doc-impact-gate --task-id "T-001" --decision "NO_DOC_UPDATES"` |
| Project memory impact | `garda gate project-memory-impact --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Completion gate | `garda gate completion-gate --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Scoped diff | `garda gate build-scoped-diff --review-type "db"` |
| Review context | `garda gate build-review-context --task-id "T-001" --review-type "code" --depth 2 --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Task events | `garda gate task-events-summary --task-id "T-001"`; use `--compact-latest-cycle` for bounded machine-readable latest-cycle JSON |
| Task audit | `garda gate task-audit-summary --task-id "T-001"`; human stdout may be colored, while `--as-json` and `--output-path` remain uncolored |
| Next step | `garda next-step T-001` or `garda gate next-step T-001` |
| Log event | `garda gate log-task-event --task-id "T-001" --event-type "..."` |
| Manifest validation | `garda gate validate-manifest --manifest-path "garda-agent-orchestrator/MANIFEST.md"` |
| Human commit | `garda gate human-commit --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --message "<message>"` |

Use `garda next-step T-001` as the task-loop command before and after gates; it reports the effective full-suite config including placement, review policy, missing artifacts, review trust status, and a single recommended command. Full gate examples live in `template/docs/agent-rules/40-commands.md`.

Task-start identity and preflight notes:
- `enter-task-mode` and related runtime identity checks normalize explicit provider aliases such as `github-copilot-cli` to the canonical provider id `GitHubCopilot`; artifacts record the canonical id.
- When `classify-change` receives `--task-id` but no `--output-path`, it writes the canonical task preflight artifact at `garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json`. Non-task ad hoc classification can still run without writing an artifact.
- After a preflight refresh, `next-step` distinguishes rereading rules from rebinding evidence. If the same current-cycle POST_PREFLIGHT rule files and hashes are already loaded, it may print `bind-rule-pack-to-preflight`; if required reviews, rule files, rule hashes, or task-mode cycle changed, it prints `load-rule-pack --stage POST_PREFLIGHT` so rules are read again.
- If task-mode evidence lives at a nondefault path, preserve the same `--task-mode-path` across `classify-change`, POST_PREFLIGHT `load-rule-pack`, and `bind-rule-pack-to-preflight`.
- Optional Markdown working plans live at `garda-agent-orchestrator/runtime/plans/<task-id>.md`. When present, `next-step` and `enter-task-mode` print `MarkdownWorkingPlanPath` and `MarkdownWorkingPlanSha256` for executor handoff. They are human-readable guidance only: they are not passed as `--plan-path`, are not schema-enforced, and missing files are not a gate, review, or completion blocker.
- `classify-change --force-code-review` keeps code review mandatory even when the active fast profile would otherwise lighten a true docs-only scope. Protected control-plane scopes still keep code review mandatory without the flag.

`doc-impact-gate` accepts only `DOCS_UPDATED` and `NO_DOC_UPDATES` for `--decision`. `docs_updated` is reserved for user-facing documentation. Internal closeout evidence uses explicit flags such as `--internal-changelog-updated true` and `--project-memory-updated true`; `NO_DOC_UPDATES` is fail-closed and still cannot be combined with `docs_updated`, `behavior_changed=true`, or `changelog_updated=true`.

`project-memory-impact` writes read-only impact diagnostics under `runtime/project-memory/`; update evidence is recorded with `--confirm-updated` after user-owned project memory files have been updated separately. Fresh workspaces default project-memory maintenance to `update`, and setup/update migrate the old generated `enabled=false, mode=check` default to `update` while preserving explicit existing `off`, custom `check`, `update`, or `strict` choices. After setup or update, give the agent this first-task prompt when memory may still be stale or incomplete:

```text
Initialize or refresh Garda project memory. Inspect the repository through the normal orchestrator workflow, starting with `garda-agent-orchestrator/live/docs/project-memory/README.md` and `garda-agent-orchestrator/live/docs/project-memory/compact.md`. Project memory is a compact project map for orientation, not proof. Read README.md, then compact.md, then only focused files relevant to the task. Verify memory facts against source, tests, config, docs, and gate evidence before changing behavior. Update only `garda-agent-orchestrator/live/docs/project-memory/*.md` files that are missing, stale, template-seeded, placeholder-only, incomplete, or no longer shaped as a compact project map. Write durable current-state contracts only: module ownership, workflow invariants, commands, decisions, risks, and active unknowns. Do not store repeated task narratives, transient failures, large command outputs, or duplicated known orchestrator issues. Task ids are optional provenance only and should not be the default heading structure. Keep `compact.md` concise and link-oriented; record confirmed stack, commands, module map, decisions, risks, and unknown/custom stack fallback from source, configs, tests, durable docs, or explicit user answers. Do not edit generated `garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md`, do not invent facts, and do not overwrite user-authored memory without preserving its facts. Record project-memory update evidence when the workflow asks for it.
```

`validate-manifest --compact` preserves failure diagnostics but reduces the green path to `MANIFEST_VALIDATION_PASSED | entries=<count>`.

Reviewer staging note:
- The findings-only output, validation/disposition evidence chain, profile
  snapshot behavior, and legacy migration procedure are documented in
  [Findings-Only Review Contracts and Legacy Migration](findings-contracts.md).
- Keep transient reviewer source files under `garda-agent-orchestrator/runtime/tmp/reviews/<task-id>/<review-type>/review-output.md` when using `record-review-result --review-output-path`.
- If `--review-output-path` points into reviewer scratch storage, the path must encode the current task id so Garda can attribute and clean it safely.
- `build-review-context` records the fresh-context reviewer contract in `reviewer_routing`: required reviews need a new delegated reviewer session, not a reused long-lived reviewer agent. `record-review-result` prints a reviewer cleanup reminder after receipt persistence.
- `build-review-context` also prints `ReviewReuseDecision` and `ReviewReuseReason` so agents can see whether a prior PASS review was safely rebound to the current cycle or why a fresh reviewer is still required.
- Garda cleans current-task reviewer scratch artifacts deterministically after successful review recording, removes same-task leftovers on terminal `TASK_DONE` or `TASK_BLOCKED`, sweeps aged task-attributable staging files when they no longer belong to active `IN_PROGRESS` or `IN_REVIEW` tasks, and retains stale unattributed paths instead of deleting them by guesswork.

Grouped review follow-up recovery:
- After accepted unchanged-code parent-cycle review reuse, rerun the native findings follow-up materialization gate. Garda can rebind the existing pending grouped child when every bound review lane has authenticated current-cycle reuse evidence.
- Historical findings validation and disposition remain bound to their original review. The child receives the current parent-cycle binding without duplicating its deferred obligations.
- Lane completeness covers every artifact for the same child and frozen snapshot across cycles, including lanes not yet rebound during partial recovery. Removing a lane from both parent and child notes does not hide its historical obligations.
- An active child, ambiguous ownership, or incomplete reuse evidence blocks recovery. Follow `next-step` diagnostics; do not manually relabel child notes or rewrite historical evidence.
- Every blocked materialization attempt, including accepted `fix_now` dispositions, writes diagnostics to a separate `*-blocked.json` artifact through a confined, link-safe writer. Canonical publication also rejects unsafe links. Recovery authenticates each lane's validation and disposition against its receipt, including the real deferred obligations. Integrity-bound current review events establish expected lanes even when an artifact and both queue references disappear; unreadable, missing or inconsistent native candidates fail closed. First publication of the incoming fresh-review lane remains possible, while authenticated child scope waits for all deferred lanes. The selected child must own its lane artifacts, and multiple claims to the same group block recovery. After resolving a blocker, native materialization can retry using the preserved evidence. Historical evidence alone cannot satisfy the current cycle.

Zero-diff task contract:
- A clean-tree `classify-change` result is baseline-only evidence, not proof that the task is complete.
- `required-reviews-check` and `completion-gate` now block zero-diff implementation tasks unless the task later produces a real diff or an audited no-op artifact is recorded.
- When `completion-gate` fails on stage-sequence or coherent-cycle ordering, it now prints a ready-to-rerun `restart-coherent-cycle` command that replays `enter-task-mode -> load-rule-pack -> handshake-diagnostics -> shell-smoke-preflight -> classify-change -> load-rule-pack -> compile-gate` before reviews continue.
- `restart-review-cycle` is the narrower recovery path for review-only reruns: it classifies the remediation fix before review reuse decisions as `test_coverage_only`, `test_hook_isolation`, `api_surface`, `runtime_behavior`, `security_sensitive`, `refactor_structure`, or fail-closed `unknown`; records affected file groups and rationale; invalidates the owning review lane for targeted categories such as `test_hook_isolation` -> `code` and `refactor_structure` -> `refactor`; refreshes `classify-change -> POST_PREFLIGHT rule-pack binding -> compile-gate -> build-review-context`; prepares review contexts in dependency order; and reports `PendingReviewTypes` when downstream reviews are still blocked by missing same-cycle upstream PASS evidence. Preserved review lanes may reuse prior PASS evidence only through the normal receipt, provenance, tree-state, and scope-fingerprint checks; fail-closed categories relaunch all required review lanes.
- Use `garda gate record-no-op --task-id "<task-id>" --reason "<rationale>"` only when the task is genuinely `already done`, `no changes required`, or `audit only`.

---

## Runtime Requirements

| Component | Requirement |
|---|---|
| Public CLI and gate commands | Node.js 24 LTS primary; Node.js 22.13+ compatibility |
| Task orchestration workspace | Local Git repository with the `git` CLI available; GitHub, GitLab, or other remotes are optional |
