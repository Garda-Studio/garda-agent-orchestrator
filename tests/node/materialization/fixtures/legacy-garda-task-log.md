# Task List

Single source of active engineering tasks for agent execution.

## Status Legend
- `TODO`
- `IN_PROGRESS`
- `IN_REVIEW`
- `DONE`
- `BLOCKED`

## Artifact Contract
Use this format in the `Artifacts` column for `IN_REVIEW`, `DONE`, and `BLOCKED` tasks:

`path_mode=<FAST_PATH|FULL_PATH>; preflight_artifact=<path|n/a>; code_review_agent_label=<CODE_REVIEW|NOT_REQUIRED>; code_review_agent_id=<agent-id|n/a>; code_review_verdict=<REVIEW PASSED|REVIEW FAILED|NOT_REQUIRED>; code_review_artifact=<path|n/a>; rule_coverage_artifact=<path|n/a>; db_review_agent_label=<DB_REVIEW|NOT_REQUIRED>; db_review_agent_id=<agent-id|n/a>; db_review_verdict=<DB REVIEW PASSED|DB REVIEW FAILED|NOT_REQUIRED>; db_review_artifact=<path|n/a>; security_review_agent_label=<SECURITY_REVIEW|NOT_REQUIRED>; security_review_agent_id=<agent-id|n/a>; security_review_verdict=<SECURITY REVIEW PASSED|SECURITY REVIEW FAILED|NOT_REQUIRED>; security_review_artifact=<path|n/a>; refactor_review_agent_label=<REFACTOR_REVIEW|NOT_REQUIRED>; refactor_review_agent_id=<agent-id|n/a>; refactor_review_verdict=<REFACTOR REVIEW PASSED|REFACTOR REVIEW FAILED|NOT_REQUIRED>; refactor_review_artifact=<path|n/a>; doc_impact_artifact=<path|n/a>; changelog_entry=<path|NOT_REQUIRED>; task_event_log=<path|n/a>; blocked_reason_code=<code|n/a>`

Completion constraints:
- `DONE` requires valid `path_mode`.
- For tasks created after adoption of T-008 workflow, `DONE` requires concrete `preflight_artifact` path.
- `DONE` requires compile gate pass (`COMPILE_GATE_PASSED` event in task timeline).
- `DONE` requires `code_review_verdict=REVIEW PASSED` for runtime code tasks, otherwise `NOT_REQUIRED`.
- `DONE` requires `db_review_verdict=DB REVIEW PASSED` when DB trigger matched, otherwise `NOT_REQUIRED`.
- `DONE` requires `security_review_verdict=SECURITY REVIEW PASSED` when security trigger matched, otherwise `NOT_REQUIRED`.
- `DONE` requires `refactor_review_verdict=REFACTOR REVIEW PASSED` when refactor trigger matched, otherwise `NOT_REQUIRED`.
- If runtime code review is required, `code_review_agent_label` and `code_review_agent_id` are mandatory.
- If DB review is required, `db_review_agent_label` and `db_review_agent_id` are mandatory.
- If security review is required, `security_review_agent_label` and `security_review_agent_id` are mandatory.
- If refactor review is required, `refactor_review_agent_label` and `refactor_review_agent_id` are mandatory.
- If `code_review_verdict` is not `NOT_REQUIRED`, `code_review_artifact` and `rule_coverage_artifact` must be concrete paths, not `n/a`.
- If `db_review_verdict` is not `NOT_REQUIRED`, `db_review_artifact` must be a concrete path, not `n/a`.
- If `security_review_verdict` is not `NOT_REQUIRED`, `security_review_artifact` must be a concrete path, not `n/a`.
- If `refactor_review_verdict` is not `NOT_REQUIRED`, `refactor_review_artifact` must be a concrete path, not `n/a`.
- `DONE` requires each PASS review artifact to keep active `Findings by Severity` and `Residual Risks` empty (`None`). Non-blocking follow-ups may remain only in `Deferred Findings`, and every deferred entry must include `Justification:`.
- If optional specialist reviews are enabled and required by preflight, append the same field pair pattern and enforce pass verdicts:
  - `api_review_verdict` / `api_review_artifact` (`API REVIEW PASSED`)
  - `test_review_verdict` / `test_review_artifact` (`TEST REVIEW PASSED`)
  - `performance_review_verdict` / `performance_review_artifact` (`PERFORMANCE REVIEW PASSED`)
  - `infra_review_verdict` / `infra_review_artifact` (`INFRA REVIEW PASSED`)
  - `dependency_review_verdict` / `dependency_review_artifact` (`DEPENDENCY REVIEW PASSED`)
- `DONE` requires `doc_impact_artifact` and `changelog_entry` according to documentation gate rules.
- `DONE` requires `task_event_log` pointing to `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`.
- `BLOCKED` requires a non-empty `blocked_reason_code`.
- Recommended review artifact path pattern:
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-code-review.md`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-db-review.md`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-security-review.md`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-refactor-review.md`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-api-review.md`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-test-review.md`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-performance-review.md`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-infra-review.md`
  - `garda-agent-orchestrator/runtime/reviews/<task-id>-dependency-review.md`
  - `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`

## BLOCKED Reason Codes
- `MISSING_ENV`
- `AWAITING_DECISION`
- `EXTERNAL_SERVICE_DOWN`
- `POLICY_RESTRICTED`
- `REVIEW_FAILED`
- `TESTS_FAILED`
- `DOCS_PENDING`
- `PRECHECK_FAILED`
- `MANIFEST_INVALID`

## Active Queue
| ID | Status | Priority | Area | Title | Owner | Updated | Artifacts | Notes |
|---|---|---|---|---|---|---|---|---|
| T-003 | TODO | P2 | process | Add next real engineering task from user request | unassigned | 2026-03-05 | n/a | Keep queue non-empty for workflow continuity |

## Completed
| ID | Status | Priority | Area | Title | Owner | Updated | Artifacts | Notes |
|---|---|---|---|---|---|---|---|---|
| T-001 | DONE | P1 | rules | Establish strict coding and workflow rules | codex | 2026-03-05 | path_mode=FULL_PATH; preflight_artifact=n/a; code_review_agent_label=NOT_REQUIRED; code_review_agent_id=n/a; code_review_verdict=NOT_REQUIRED; code_review_artifact=n/a; rule_coverage_artifact=n/a; db_review_agent_label=NOT_REQUIRED; db_review_agent_id=n/a; db_review_verdict=NOT_REQUIRED; db_review_artifact=n/a; security_review_agent_label=NOT_REQUIRED; security_review_agent_id=n/a; security_review_verdict=NOT_REQUIRED; security_review_artifact=n/a; refactor_review_agent_label=NOT_REQUIRED; refactor_review_agent_id=n/a; refactor_review_verdict=NOT_REQUIRED; refactor_review_artifact=n/a; doc_impact_artifact=garda-agent-orchestrator/live/docs/agent-rules/35-strict-coding-rules.md; changelog_entry=garda-agent-orchestrator/live/docs/changes/CHANGELOG.md; blocked_reason_code=n/a | Strict SOLID rules and task workflow added |
| T-002 | DONE | P1 | process | Create full orchestration, code-review, and DB-review skills | codex | 2026-03-05 | path_mode=FULL_PATH; preflight_artifact=n/a; code_review_agent_label=NOT_REQUIRED; code_review_agent_id=n/a; code_review_verdict=NOT_REQUIRED; code_review_artifact=n/a; rule_coverage_artifact=n/a; db_review_agent_label=NOT_REQUIRED; db_review_agent_id=n/a; db_review_verdict=NOT_REQUIRED; db_review_artifact=n/a; security_review_agent_label=NOT_REQUIRED; security_review_agent_id=n/a; security_review_verdict=NOT_REQUIRED; security_review_artifact=n/a; refactor_review_agent_label=NOT_REQUIRED; refactor_review_agent_id=n/a; refactor_review_verdict=NOT_REQUIRED; refactor_review_artifact=n/a; doc_impact_artifact=garda-agent-orchestrator/live/skills/orchestration; changelog_entry=garda-agent-orchestrator/live/docs/changes/CHANGELOG.md; blocked_reason_code=n/a | Added mandatory skill invocation and hard stop gates |
| T-004 | DONE | P1 | process | Enforce non-skippable gates and specialist review requirements | codex | 2026-03-05 | path_mode=FULL_PATH; preflight_artifact=n/a; code_review_agent_label=NOT_REQUIRED; code_review_agent_id=n/a; code_review_verdict=NOT_REQUIRED; code_review_artifact=n/a; rule_coverage_artifact=n/a; db_review_agent_label=NOT_REQUIRED; db_review_agent_id=n/a; db_review_verdict=NOT_REQUIRED; db_review_artifact=n/a; security_review_agent_label=NOT_REQUIRED; security_review_agent_id=n/a; security_review_verdict=NOT_REQUIRED; security_review_artifact=n/a; refactor_review_agent_label=NOT_REQUIRED; refactor_review_agent_id=n/a; refactor_review_verdict=NOT_REQUIRED; refactor_review_artifact=n/a; doc_impact_artifact=garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md; changelog_entry=garda-agent-orchestrator/live/docs/changes/CHANGELOG.md; blocked_reason_code=n/a | Added mandatory skill catalog and updated workflow gates |
| T-005 | DONE | P1 | docs | Enforce documentation updates for feature and behavior changes | codex | 2026-03-05 | path_mode=FULL_PATH; preflight_artifact=n/a; code_review_agent_label=NOT_REQUIRED; code_review_agent_id=n/a; code_review_verdict=NOT_REQUIRED; code_review_artifact=n/a; rule_coverage_artifact=n/a; db_review_agent_label=NOT_REQUIRED; db_review_agent_id=n/a; db_review_verdict=NOT_REQUIRED; db_review_artifact=n/a; security_review_agent_label=NOT_REQUIRED; security_review_agent_id=n/a; security_review_verdict=NOT_REQUIRED; security_review_artifact=n/a; refactor_review_agent_label=NOT_REQUIRED; refactor_review_agent_id=n/a; refactor_review_verdict=NOT_REQUIRED; refactor_review_artifact=n/a; doc_impact_artifact=garda-agent-orchestrator/live/docs/agent-rules/35-strict-coding-rules.md; changelog_entry=garda-agent-orchestrator/live/docs/changes/CHANGELOG.md; blocked_reason_code=n/a | Added documentation impact and changelog hard-stop gate |
| T-006 | DONE | P1 | process | Add security review skill, blocked reason codes, and review templates | codex | 2026-03-05 | path_mode=FULL_PATH; preflight_artifact=n/a; code_review_agent_label=NOT_REQUIRED; code_review_agent_id=n/a; code_review_verdict=NOT_REQUIRED; code_review_artifact=n/a; rule_coverage_artifact=n/a; db_review_agent_label=NOT_REQUIRED; db_review_agent_id=n/a; db_review_verdict=NOT_REQUIRED; db_review_artifact=n/a; security_review_agent_label=NOT_REQUIRED; security_review_agent_id=n/a; security_review_verdict=NOT_REQUIRED; security_review_artifact=n/a; refactor_review_agent_label=NOT_REQUIRED; refactor_review_agent_id=n/a; refactor_review_verdict=NOT_REQUIRED; refactor_review_artifact=n/a; doc_impact_artifact=garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md; changelog_entry=garda-agent-orchestrator/live/docs/changes/CHANGELOG.md; blocked_reason_code=n/a | Added mandatory security-review trigger for auth/payments and artifact contract extensions |
| T-007 | DONE | P1 | process | Add refactor review skill and mandatory trigger wiring | codex | 2026-03-05 | path_mode=FULL_PATH; preflight_artifact=n/a; code_review_agent_label=NOT_REQUIRED; code_review_agent_id=n/a; code_review_verdict=NOT_REQUIRED; code_review_artifact=n/a; rule_coverage_artifact=n/a; db_review_agent_label=NOT_REQUIRED; db_review_agent_id=n/a; db_review_verdict=NOT_REQUIRED; db_review_artifact=n/a; security_review_agent_label=NOT_REQUIRED; security_review_agent_id=n/a; security_review_verdict=NOT_REQUIRED; security_review_artifact=n/a; refactor_review_agent_label=NOT_REQUIRED; refactor_review_agent_id=n/a; refactor_review_verdict=NOT_REQUIRED; refactor_review_artifact=n/a; doc_impact_artifact=garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md; changelog_entry=garda-agent-orchestrator/live/docs/changes/CHANGELOG.md; blocked_reason_code=n/a | Added full refactor-review skill, orchestration gates, and bootstrap propagation |
| T-008 | DONE | P1 | process | Add FAST_PATH/FULL_PATH preflight gates and minimize reviewer swarm for small UI changes | codex | 2026-03-05 | path_mode=FULL_PATH; preflight_artifact=n/a; code_review_agent_label=NOT_REQUIRED; code_review_agent_id=n/a; code_review_verdict=NOT_REQUIRED; code_review_artifact=n/a; rule_coverage_artifact=n/a; db_review_agent_label=NOT_REQUIRED; db_review_agent_id=n/a; db_review_verdict=NOT_REQUIRED; db_review_artifact=n/a; security_review_agent_label=NOT_REQUIRED; security_review_agent_id=n/a; security_review_verdict=NOT_REQUIRED; security_review_artifact=n/a; refactor_review_agent_label=NOT_REQUIRED; refactor_review_agent_id=n/a; refactor_review_verdict=NOT_REQUIRED; refactor_review_artifact=n/a; doc_impact_artifact=garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md; changelog_entry=garda-agent-orchestrator/live/docs/changes/CHANGELOG.md; blocked_reason_code=n/a | Added preflight and review-gate scripts with FAST_PATH policy wiring |





