# Skill Catalog

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Purpose
- Define available project skills.
- Define deterministic trigger policy for mandatory invocations.
- Avoid duplicating orchestration step sequence; canonical lifecycle is in:
  `garda-agent-orchestrator/live/skills/orchestration/SKILL.md`.

## Integrity Priority Rules
- Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.
- Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.
- Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.
- If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.

## Available Project Skills
- `garda-agent-orchestrator/live/skills/orchestration`
- `garda-agent-orchestrator/live/skills/orchestration-depth1`
- `garda-agent-orchestrator/live/skills/code-review`
- `garda-agent-orchestrator/live/skills/db-review`
- `garda-agent-orchestrator/live/skills/dependency-review`
- `garda-agent-orchestrator/live/skills/security-review`
- `garda-agent-orchestrator/live/skills/refactor-review`
- `garda-agent-orchestrator/live/skills/skill-builder`

## Optional Skills (Live-Only, On Demand)
- Optional specialist skills are created only under `garda-agent-orchestrator/live/skills/**`.
- Template must stay generic; project-specific specialists are not written back into `template/`.
- Capability flags for optional specialists are managed in:
  `garda-agent-orchestrator/live/config/review-capabilities.json`.
- Optional custom review-lane declarations are managed in `garda-agent-orchestrator/live/config/review-catalog.json`; absence remains compatible with the built-in review lanes.
- Profile lane states and review dependency graphs are managed in `garda-agent-orchestrator/live/config/profiles.json` and become immutable for a task when its current task snapshot is created.
- Compact optional-skill discovery metadata for pack suggestion and init-time recommendations is managed in:
  `garda-agent-orchestrator/live/config/skills-index.json`.
- Compact task-start optional-skill selection headlines are managed in:
  `garda-agent-orchestrator/live/config/skills-headlines.json`.
- Built-in domain packs are managed through:
  - `node garda-agent-orchestrator/bin/garda.js skills list --target-root "."`
  - `node garda-agent-orchestrator/bin/garda.js skills suggest --target-root "." --task-text "<task summary>" --changed-path "<path>"`
  - `node garda-agent-orchestrator/bin/garda.js skills add <pack-id> --target-root "."`
  - `node garda-agent-orchestrator/bin/garda.js skills remove <pack-id> --target-root "."`
  - `node garda-agent-orchestrator/bin/garda.js skills validate --target-root "."`
- Installed built-in packs are recorded in:
  `garda-agent-orchestrator/live/config/skill-packs.json`.
- Built-in pack ids come from `skills list`; do not hardcode the list in downstream prompts.
- Optional skill selection contract:
  - read `live/config/skills-index.json` for pack suggestion and init-time optional-skill discovery;
  - read `live/config/skills-headlines.json` for current-task optional-skill selection after task text and planned scope are known;
  - after the user selects a pack, install/copy it into `garda-agent-orchestrator/live/skills/**` without reading the full optional `SKILL.md`;
  - do not open a full optional `SKILL.md` unless that selected skill is actually being activated for a task or a hard activation rule requires it;
  - after a pack is installed, full optional skills live under `garda-agent-orchestrator/live/skills/**`.
- During ordinary task execution, use the compact task-start catalog summary, preflight snapshot, and generated reviewer launch input. Do not read the complete review catalog or unrelated review skills into normal agent context.

## Preflight Gate (Mandatory)
- Before preflight, enter task mode explicitly:
  `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>"`
- Enter task mode with explicit runtime identity via `--provider "<provider>"`; add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned, and do not rely on canonical SourceOfTruth fallback.
- Before preflight, record the baseline downstream rules that were actually opened:
  `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md"`
- Run before review stage:
  `node garda-agent-orchestrator/bin/garda.js gate classify-change --changed-file "<planned-file-1>" --changed-file "<planned-file-2>" --task-intent "<task summary>" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"`
- In dirty workspaces prefer staged mode:
  `node garda-agent-orchestrator/bin/garda.js gate classify-change --use-staged --task-intent "<task summary>" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"`
- Legacy update compatibility wording: After preflight, re-run `load-rule-pack --stage "POST_PREFLIGHT"`. Current contract: After preflight, run the exact POST_PREFLIGHT rule-pack command printed by `next-step`. Use `load-rule-pack --stage "POST_PREFLIGHT"` with the actual downstream rule files opened for the required review set when rules must be read:
  `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "POST_PREFLIGHT" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --loaded-rule-file "<opened-rule-file>"`
- Use `bind-rule-pack-to-preflight` only when `next-step` prints it because current-cycle rule files and hashes are unchanged and only the preflight evidence binding must be refreshed.
- Do not parallelize `classify-change`, POST_PREFLIGHT rule-pack binding, and `compile-gate` for the same task cycle. If preflight is refreshed, rerun downstream gates sequentially from the POST_PREFLIGHT command that `next-step` prints.
- Before each required reviewer invocation, run `node garda-agent-orchestrator/bin/garda.js gate build-review-context --review-type "<review-type>" --depth "<1|2|3>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"`.
- Review launch dependencies come from `preflight.review_execution_policy`; prepare `test` only after every required upstream dependency for the active policy has an accepted findings receipt with findings-satisfied state.
- On pure test-scope reruns, if the active policy keeps `test` downstream of `code`, run `build-review-context` for reusable upstream `code` review first so the current-cycle reuse receipt exists before launching `test` review.
- Compile gate is mandatory after implementation and before `IN_REVIEW`:
  `node garda-agent-orchestrator/bin/garda.js gate compile-gate --task-id "<task-id>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"`
- Preflight artifact is the only source for:
  - `path_mode` (`FAST_PATH` / `FULL_PATH`)
  - `required_reviews.code`
  - `required_reviews.db`
  - `required_reviews.security`
  - `required_reviews.refactor`
  - optional keys (when capability enabled): `required_reviews.api`, `required_reviews.test`, `required_reviews.performance`, `required_reviews.infra`, `required_reviews.dependency`

## Invocation Contract
- Always start task execution with `orchestration`.
- Provider-native agent profiles are only bridges and must route to this same skill catalog:
  - `.github/agents/orchestrator.md`
  - `.github/agents/reviewer.md`
  - `.github/agents/code-review.md`
  - `.github/agents/db-review.md`
  - `.github/agents/security-review.md`
  - `.github/agents/refactor-review.md`
  - `.windsurf/agents/orchestrator.md`
  - `.junie/agents/orchestrator.md`
  - `.antigravity/agents/orchestrator.md`
- For GitHub Copilot bridge profiles, always refresh routing from:
  - `garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md`
  - `garda-agent-orchestrator/live/config/review-capabilities.json`
  - `garda-agent-orchestrator/live/skills/**` (including specialist skills added after init)
- Invoke review skills only when required by preflight:
  - `code-review` for `required_reviews.code=true`
  - `db-review` for `required_reviews.db=true`
  - `security-review` for `required_reviews.security=true`
  - `refactor-review` for `required_reviews.refactor=true`
  - optional specialist skills when enabled and required:
    - `api-contract-review` (or custom `api-review`) for `required_reviews.api=true`
    - `testing-strategy` (or custom `test-review`) for `required_reviews.test=true`
    - `performance-review` for `required_reviews.performance=true`
    - `devops-k8s` (or custom `infra-review`) for `required_reviews.infra=true`
    - `dependency-review` for `required_reviews.dependency=true`
- `build-review-context` is the canonical proof that the selected review skill and its rule context were loaded; completion for code-changing tasks expects `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` in the task timeline.
- `build-review-context` emits `reviewer_routing` metadata in the review-context artifact; reviewers must be launched as fresh-context sub-agents on every provider, and the orchestrator must populate `reviewer_routing.actual_execution_mode` and `reviewer_routing.reviewer_session_id` after reviewer launch.
- `record-review-routing` and `prepare-reviewer-launch` may use planned `agent:pending:<task-id>-<review-type>` identities only. The real provider `agent:*` reviewer identity is recorded at `record-reviewer-delegation-started`; no bridge may ask an agent to create, reserve, hold, or pre-complete a reviewer before the exact launch input exists.
- Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence. Reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence.
- After the review receipt is persisted by `record-review-result` or `record-review-receipt`, close or release the reviewer sub-agent session.
- `build-review-context` must fail closed when the pinned runtime identity is unresolved or does not attest launchable reviewer subagents for the current runtime session.
- Same-agent self-review is invalid for mandatory reviews. Historical `same_agent_fallback` artifacts remain diagnostic compatibility evidence only and cannot satisfy a current review cycle.
- Before `DONE`, run:
  `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" ...`
- Then run completion gate:
  `node garda-agent-orchestrator/bin/garda.js gate completion-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>"`

## Trigger Source of Truth
- Specialized trigger semantics are defined only in:
  `garda-agent-orchestrator/live/skills/orchestration/references/review-trigger-matrix.md`
- Trigger evaluation is executed only by preflight script.
- Optional/manual reviewers never satisfy mandatory gates.

## Escape Hatch Policy
- Optional audited override for mandatory review gate is supported only via:
  `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check --skip-reviews ... --skip-reason ...`
- Default restrictions:
  - only code review can be skipped,
  - only tiny low-risk scope,
  - DB/security/refactor overrides are forbidden.
- Every override must produce an override artifact and be recorded in `TASK.md`.

## Enforcement
- Missing task-mode entry artifact (`runtime/reviews/<task-id>-task-mode.json`) blocks progression.
- Missing rule-pack artifact (`runtime/reviews/<task-id>-rule-pack.json`) blocks progression.
- Missing preflight artifact blocks progression.
- Missing baseline `RULE_PACK_LOADED` blocks preflight.
- Missing post-preflight rule-pack proof blocks compile/review/completion.
- Missing `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, or `SKILL_REFERENCE_LOADED` blocks completion for code-changing tasks.
- Missing compile-gate pass (`COMPILE_GATE_PASSED`) blocks progression to `IN_REVIEW` and `DONE`.
- Missing required skill invocation blocks progression.
- Missing required findings receipt or unsatisfied locked disposition blocks completion.
- Missing review gate check pass blocks completion.
- Missing completion gate pass (`COMPLETION_GATE_PASSED`) blocks completion.
- Missing task timeline evidence in `runtime/task-events/<task-id>.jsonl` blocks completion.
- Incomplete task timeline evidence is surfaced by `status` and `doctor`.
- Missing required docs/changelog updates blocks completion for doc-impacting changes.
- Reviewer/specialist agents must be closed after findings receipt persistence.
