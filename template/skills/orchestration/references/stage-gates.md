# Stage Gates

## Gate 1: Task Selection
Pass criteria:
- Task exists in `TODO` before entry, and successful `enter-task-mode` reconciles it to `IN_PROGRESS`.

## Gate 2: Plan
Pass criteria:
- Plan covers scope, files, risks, and checks.

## Gate 3: Task-Mode Entry
Pass criteria:
- `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode` result is pass.
- Task-mode artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json`.
- Task timeline contains `TASK_MODE_ENTERED`.

## Gate 4: Preflight Classification
Pass criteria:
- Preflight artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json`.
- Path mode is declared by script output: `FAST_PATH` or `FULL_PATH`.
- Required reviews are declared by preflight output.

## Gate 5: Tests or Validation
Pass criteria:
- `FULL_PATH` runtime code: required tests defined and currently meaningful.
- `FAST_PATH` runtime code or non-runtime tasks: explicit validation checklist exists.

## Gate 6: Implementation
Pass criteria:
- Changes satisfy planned scope without unrelated edits.

## Gate 7: Checks
Pass criteria:
- Compile gate passed before review phase:
  - `node garda-agent-orchestrator/bin/garda.js gate compile-gate` result is pass.
  - Task-mode evidence is valid for the same task id.
  - Compile evidence artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-compile-gate.json`.
  - Task timeline contains `COMPILE_GATE_PASSED`.
  - No preflight scope drift is reported by compile gate.

## Gate 8: Independent Reviews
Pass criteria:
- Successful review-gate flow reconciles the task to `IN_REVIEW`.
- Every required review lane has an accepted findings-only receipt with complete coverage-ledger evidence.
- Every accepted finding and residual risk has a locked policy disposition.
- Every `fix_now` item is resolved through authenticated remediation evidence, and every `create_follow_up` item has a materialized task-owned follow-up.
- Re-review follows the snapshotted selective recovery route and preserves only authenticated unaffected receipts.
- Review artifacts satisfy `TASK.md` artifact contract.
- `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check` result is pass.
- `required-reviews-check` compile-evidence check is pass for same task id.
- `required-reviews-check` task-mode check is pass for same task id.
- Review gate evidence artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-review-gate.json`.

## Gate 9: Documentation Finalization
Pass criteria:
- Documentation impact gate passed (`node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate`).
- Documentation impact artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-doc-impact.json`.
- Required docs updated for impacted behavior.
- Changelog updated for runtime behavior changes.

## Gate 10: Completion
Pass criteria:
- All required gates passed.
- `node garda-agent-orchestrator/bin/garda.js gate completion-gate` result is pass.
- Timeline contains `TASK_MODE_ENTERED`.
- Timeline contains `COMPLETION_GATE_PASSED`.
- Required findings receipts are satisfied, no `fix_now` item remains unresolved, and every required follow-up is materialized.
- Completion finalization reconciles the task to `DONE`.
- Artifact contract fields are valid for path mode, findings validation, locked dispositions, lane evidence, and recovery bindings.
- User report is delivered in mandatory order: short agent-authored summary -> verbatim Garda final user report, followed by the task-bound native command followed by `Do you want me to commit now? (yes/no)` only under OFF or missing authority. ON has no question.
- Commit only through the task-bound native command printed by the Garda final report. With an authenticated workspace-local ON grant, run `gate human-commit --task-id "<task-id>" --message "<message>"` after completion/task-audit PASS without asking. With OFF or missing authority, ask `Do you want me to commit now? (yes/no)` and commit only after the operator answers yes, using `gate human-commit --task-id "<task-id>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp of the answer>" --message "<message>"`. A missing or stale confirmation is refused. Both modes require current completion/task-audit PASS, exactly accepted staged task scope and post-commit audit; amend, pathspec, hook and index overrides remain forbidden. Permission covers no push, CI or publication. Never suggest or run a plain `git commit`.

## Failure Policy
- Any failed gate blocks next gates.
- Stop in explicit `BLOCKED` workflow state when a gate cannot be satisfied now, but do not hand-edit the active `TASK.md` status cell to `BLOCKED` as a gate substitute.
- Use explicit `DECOMPOSED` state when the parent is no longer executable because remaining work was split into child tasks. For strict decomposition `split-required` decisions, the child rows must match the decision artifact and remain strict-profile work.
- Resume only after blocker is resolved.
