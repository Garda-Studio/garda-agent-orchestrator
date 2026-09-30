# Task Plan Workflow

## Overview

Agents can prepare a structured plan before task execution and consume it through the existing orchestrator lifecycle. Planning is optional for ordinary tasks. A plan describes intended work; successful checks and accepted reviewer receipts provide evidence of completed work.

Garda now recognizes two intentionally separate planning surfaces:

| Surface | Location | Purpose | Enforcement |
|---|---|---|---|
| Structured JSON task plan | `<bundle>/runtime/reviews/<task-id>-task-plan.json` | Ready handoff with scope drift checks | Ready canonical plans attach automatically at ordinary entry; an explicit `--plan-path` takes precedence |
| Markdown working plan | `garda-agent-orchestrator/runtime/plans/<task-id>.md` | Optional human-readable executor guidance | Not schema-enforced; absence is neutral |

## When to Use a Plan

| Scenario | Recommendation |
|---|---|
| Small change or bug fix with clear scope | A short execution brief is enough unless a structured plan was requested |
| Multi-file feature with dependencies | Author a plan — the executor stays on track |
| Cross-cutting refactor or migration | Author a plan — drift detection catches scope creep |
| Security or data change with material boundaries | Prepare a plan when useful; the selected task profile and existing gates govern review |

## Structured JSON Task Plan

A task plan is a JSON file stored at:

```
<bundle>/runtime/reviews/<task-id>-task-plan.json
```

This is the only plan artifact accepted by `enter-task-mode --plan-path`.

Required fields:

| Field | Type | Description |
|---|---|---|
| `schema_version` | integer | Schema version (currently `1`) |
| `task_id` | string | Task identifier (e.g. `T-048`) |
| `status` | enum | `draft`, `approved`, or `superseded` |
| `goal` | string | High-level goal the plan addresses |
| `scope_files` | string[] | Files the plan expects to create or modify |
| `risk_level` | enum | `low`, `medium`, or `high` |
| `steps` | array | Ordered execution steps (each with `id` and `title`) |

Optional schema fields: `acceptance_criteria`, `verification_expectations`, `out_of_scope`, `validation_strategy`, `notes`, `created_by`, `created_at`, `plan_sha256`.

### Criteria and Verification

Use the existing fields together instead of creating another success-criteria artifact:

| Field | Question it answers | Example |
|---|---|---|
| `goal` | What result does the existing TASK.md intent ask for? | Validate structured task plans |
| `acceptance_criteria` | What observable behavior means the goal is met? | Invalid step references are rejected |
| `verification_expectations` | What evidence will demonstrate those criteria? | Focused tests exercise valid and invalid references |
| `out_of_scope` | What must this task leave for other work? | No new mandatory planning gate |
| `scope_files` | Which files may the implementation change? | Schema, focused tests and changelog |
| `validation_strategy` | How should the executor obtain verification evidence? | Focused regression command plus the routed lifecycle checks |

New `approved` plans saved through `task plan save` require nonempty `acceptance_criteria`, `verification_expectations` and `out_of_scope`. The JSON schema still accepts legacy plans without those optional fields. This save-time authoring check does not add a criteria gate to ordinary task execution, require another file, or select a stricter profile.

When a plan is attached, read its existing criteria and verification expectations before implementation. Reuse TASK.md intent rather than copying it into a second competing specification. If a legacy attached plan omits criteria, use the task intent and a concise execution brief; no retrospective criteria artifact is required.

### Small-Task Execution Brief

An ordinary small task can keep a short brief in the conversation or existing task context:

```text
goal: Fix the broken task-plan documentation link described in TASK.md.
done_when: The link opens the existing guide and neighboring links remain unchanged.
verification: Check the target exists and run the relevant documentation contract test.
```

No separate file is required. `done_when` is a brief label, not a new JSON field or gate. An attached plan already supplies the goal, criteria and verification expectations, so refer to them rather than duplicating them in another brief.

### Intended Work and Completion Evidence

JSON criteria describe desired behavior; Markdown guidance and a brief describe execution intent. None proves that implementation succeeded. Record actual command outcomes, test results and accepted independent review evidence through the existing gates. Completion remains owned by the completion gate and final audit, not by an `approved` plan or a checked-off list.

## Optional Markdown Working Plans

Agents and operators may also keep a lightweight Markdown working plan at:

```text
garda-agent-orchestrator/runtime/plans/<task-id>.md
```

This file is planner-authored or operator-authored working context for the executor. It is useful when a task has enough moving parts to benefit from a readable checklist, but does not need the strict JSON task-plan contract or drift enforcement.

Markdown working plans are intentionally free-form. Recommended headings are:

- `Goal`
- `Scope`
- `Out of Scope`
- `Steps`
- `Validation`
- `Risks`
- `Notes`

These headings are examples, not a schema. The file may use any readable Markdown structure.

Important boundaries:

- A Markdown working plan is not passed as `--plan-path`.
- It does not create `plan_guided=true`.
- It does not enable compile-gate drift detection.
- It is not reviewer provenance and must not be treated as a required review artifact.
- Missing, stale, or absent Markdown working plans are neutral for ordinary task execution.
- When one exists, `next-step` and `enter-task-mode` print `MarkdownWorkingPlanPath` and `MarkdownWorkingPlanSha256` so the executor can inspect the optional plan deliberately.
- `cleanup`, `gc`, and `clean` may remove old inactive Markdown working plans only from `garda-agent-orchestrator/runtime/plans/*.md`, using the `plans` category and `--max-working-plans` retention override. Active task plans and user project `plans/` directories outside the Garda runtime path are preserved.
- Reviewer context treats a missing optional Markdown working plan, and a missing task-mode JSON plan in non-plan-guided execution, as neutral `not_provided` context. Reviewers must not turn that absence into an active finding, deferred finding, residual risk, or no-plan waiver requirement. If a JSON task plan was explicitly attached and is missing, stale, invalid, or contradictory, that attached-plan problem is still reviewable.
- Do not create a retrospective Markdown plan only to satisfy a reviewer or completion gate.

### Complete Ready JSON Example

```json
{
  "schema_version": 1,
  "task_id": "T-048",
  "status": "approved",
  "goal": "Add task-plan artifact schema and validator",
  "scope_files": [
    "src/schemas/task-plan.ts",
    "tests/node/schemas/task-plan.test.ts",
    "CHANGELOG.md"
  ],
  "risk_level": "low",
  "acceptance_criteria": [
    "Valid plans with forward step references are accepted",
    "Unknown dependencies and dependency cycles are rejected with useful diagnostics"
  ],
  "verification_expectations": [
    "Focused schema tests cover valid references, unknown references and cycles",
    "The configured compile, validation and independent review gates accept the final change"
  ],
  "out_of_scope": [
    "A new mandatory planning or success-criteria gate",
    "Model or provider API invocation"
  ],
  "steps": [
    {
      "id": "define-schema",
      "title": "Define JSON Schema and TypeScript interfaces",
      "files": ["src/schemas/task-plan.ts"]
    },
    {
      "id": "add-validator",
      "title": "Add runtime validator with referential integrity checks",
      "files": ["src/schemas/task-plan.ts"],
      "depends_on": ["define-schema"]
    },
    {
      "id": "add-tests",
      "title": "Add unit tests for schema validation and edge cases",
      "files": ["tests/node/schemas/task-plan.test.ts"],
      "depends_on": ["add-validator"]
    },
    {
      "id": "update-changelog",
      "title": "Document the new artifact in CHANGELOG.md",
      "files": ["CHANGELOG.md"],
      "depends_on": ["add-tests"]
    }
  ],
  "validation_strategy": {
    "approach": "Run the focused schema regression check through the supported validation path and follow the navigator for mandatory lifecycle checks",
    "commands": ["node scripts/node-foundation/build-scripts.cjs test.js tests/node/schemas/task-plan.test.ts"]
  },
  "created_by": "agent",
  "created_at": "2026-04-09T10:00:00Z"
}
```

## Workflow: Authoring a Plan

1. Investigate the existing task intent, scope, risks and relevant tests before writing the plan.
2. Author JSON in a workspace input file, for example `plan-input.json`, using the complete example above. Set `status` to `approved` when it is ready to consume; this means ready, not operator-signed.
3. Save it before the task has ever started:

   ```text
   node bin/garda.js task plan save T-048 --input plan-input.json --repo-root .
   node bin/garda.js task plan show T-048 --repo-root .
   ```

   In a deployed workspace, use `node garda-agent-orchestrator/bin/garda.js` instead of `node bin/garda.js`.
4. Save validates schema, task identity, ready-plan criteria and dependency integrity, computes `plan_sha256`, and atomically writes the canonical JSON. It requires an existing TODO task with no retained start or lifecycle evidence. It leaves TASK.md status unchanged.

`validateTaskPlan()` and `serializeTaskPlan()` are the shared schema and digest functions. Save is the supported publication command; do not replace an active canonical plan by editing the runtime file directly.

## Workflow: Executing a Plan

The executor follows the normal navigator and reads the attached plan before implementation. Ordinary entry automatically attaches a ready canonical JSON plan when no explicit path is supplied. An explicit `--plan-path` selects another valid JSON plan in the repository and takes precedence.

### Gate Integration

```
enter-task-mode --task-id "T-048" --plan-path "<bundle>/runtime/reviews/T-048-task-plan.json" ...
```

When either automatic or explicit attachment selects a ready JSON plan:
- The gate validates the plan artifact (approved status, matching `task_id`, SHA-256 integrity).
- Plan metadata (`plan_path`, `plan_sha256`, `plan_summary`) is embedded in the task-mode artifact.
- The `TASK_MODE_ENTERED` timeline event records `plan_guided: true`.
- Downstream gates (`build-review-context`, `completion-gate`) propagate plan metadata so reviewers can see whether the task is plan-guided or freeform.

Entry and handshake print the same compact `TaskPlanState`, `TaskPlanPath`, `TaskPlanEditable`, `TaskPlanEvidence` and `ReadPlanHint` lines. Handshake inspects the attachment recorded at entry; it does not select a later plan. JSON, optional Markdown guidance, no attachment and invalid evidence are distinct diagnostic states. Missing or changed attachment content is observational for handshake readiness; existing plan validation and compile checks retain their authority.

### Compile Gate and Drift Detection

At compile-gate time, the orchestrator compares actual changed files against the plan's `scope_files`:

| Outcome | Status | Gate result |
|---|---|---|
| All changed files are within `scope_files` | `NO_DRIFT` | Gate passes |
| Extra files outside plan scope, no override | `REPLAN_REQUIRED` | Gate blocks |
| Extra files outside plan scope, override accepted | `PLAN_DRIFT` | Gate passes with recorded violation |
| No plan attached | `NO_PLAN` | Gate passes (freeform behavior) |

**Override syntax:**

```bash
node bin/garda.js gate compile-gate \
  --task-id "T-048" \
  --preflight-path "garda-agent-orchestrator/runtime/reviews/T-048-preflight.json" \
  --allow-plan-drift \
  --allow-plan-drift-reason "Added missing test helper that was not anticipated in the plan"
```

The override reason must be at least 12 characters. Drift overrides are recorded in compile-gate evidence under `plan_drift`.

### Reviewer Visibility

When `build-review-context` runs for each required review, it reads plan metadata from the task-mode evidence and surfaces:

- `plan.plan_guided` — whether a plan is attached.
- `plan.plan_path` — path to the plan artifact.
- `plan.plan_sha256` — digest for integrity verification.
- `plan.plan_summary` — goal summary from the plan.

Reviewers can use this context to evaluate whether the implementation matches the planned scope.

Markdown working plans are different: they may help the executor understand task intent, but reviewer behavior must not depend on their presence.

### Completion Gate

The completion gate surfaces the same plan evidence:

```
PlanGuided: true
PlanPath: garda-agent-orchestrator/runtime/reviews/T-048-task-plan.json
```

## Fallback: No Plan Present

When no explicit JSON plan is supplied and canonical preparation is missing or draft:

- `plan_guided` is `false` everywhere.
- `plan` fields are `null` in all artifacts.
- Drift detection returns `NO_PLAN` and imposes no constraints.
- The full orchestrator lifecycle (preflight, compile gate, reviews, completion) runs identically to the pre-plan behavior.
- An optional Markdown working plan at `runtime/plans/<task-id>.md` may still be read by the executor, but it does not change gate behavior.

Invalid canonical preparation fails entry rather than becoming freeform. No configuration changes or no-plan waiver are needed for an ordinary task without a ready plan.

## Lifecycle Summary

1. Prepare and save a requested JSON plan before task start, or keep an ordinary small-task brief.
2. Run `next-step` and follow its printed entry, rule-loading, handshake and preflight commands.
3. Read recorded attachment criteria or existing task intent before implementation.
4. Implement within authorized scope and run the navigator's compile, validation and review commands.
5. Resolve reported drift without silently replacing the frozen attachment.
6. Complete docs/memory/closeout gates and deliver the generated final report with actual evidence.

## Plan Statuses

| Status | Meaning |
|---|---|
| `draft` | Plan is being authored; not enforced by gates |
| `approved` | Plan is ready to attach; attached plans supply guidance and scope checks |
| `superseded` | Historical replaced version; cannot be attached as a ready plan |

## Replanning

When drift detection returns `REPLAN_REQUIRED`:

1. The executor stops implementation and reports the drift (extra files outside `scope_files`).
2. Check whether the existing authorized task scope permits a documented drift override. Follow the routed compile command with `--allow-plan-drift` and a specific reason only when appropriate.
3. Materially incompatible scope needs an explicit follow-up rather than rewriting the active plan. Save and ordinary re-entry preserve the original attachment or freeform state once start evidence exists; resetting the queue row to TODO does not permit replacement. Lifecycle statuses remain gate-owned.

## Step Dependencies

Plan steps support `depends_on` references to express ordering constraints:

```json
{
  "id": "add-tests",
  "title": "Add unit tests",
  "depends_on": ["add-validator"]
}
```

The validator enforces referential integrity: every `depends_on` entry must reference an existing step `id` within the same plan. The executor should respect dependency ordering when implementing steps.

## Validation Strategy

The optional `validation_strategy` field tells the executor how to verify the implementation:

```json
{
  "validation_strategy": {
    "approach": "Run the focused schema regression check, then follow the navigator for configured mandatory validation",
    "commands": ["node scripts/node-foundation/build-scripts.cjs test.js tests/node/schemas/task-plan.test.ts"]
  }
}
```

This is advisory — the compile gate and mandatory test execution are still enforced by the orchestrator regardless of what the plan says.

## Security Considerations

- Plan artifacts live under `runtime/reviews/` which is gitignored by default. They are local orchestration control-plane files.
- The `plan_sha256` digest provides tamper detection but is not a security-grade trust anchor (see `docs/threat-model.md`).
- Plan artifacts should not contain secrets or credentials.
- The planner model must have sufficient context to produce accurate `scope_files`; an incomplete scope leads to avoidable `REPLAN_REQUIRED` blocks.

## Related

- [Architecture](architecture.md) — overall orchestrator design.
- [Work Example](work-example.md) — end-to-end task execution walkthrough.
- [Configuration](configuration.md) — orchestrator config reference.
- [Threat Model](threat-model.md) — trust surfaces and mitigations.
