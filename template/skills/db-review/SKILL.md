---
name: db-review
description: Independent database risk review with evidence-supported findings-only output. Use for requests like "DB review", "review migration", "SQL safety check", or when preflight requires db review. Do NOT use for generic code-style-only feedback.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  runtime_requirement: Node.js 24 baseline for public CLI and gate commands
---

# DB Review

Use this skill to inspect concrete database changes for correctness, performance and data safety.

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`.

Return exactly one findings-only JSON object using the generated output template. Complete the entire assigned scope and every coverage-ledger obligation. Do not add verdict, pass/fail, status, downstream disposition, or remediation fields. The controller owns policy decisions, follow-up creation and acceptance; the reviewer reports evidence-supported findings and risks.

## Required Inputs
- Task goal and expected database behavior.
- Authenticated changed-file scope and diff supplied by orchestration, including assigned migrations, repositories and queries.
- Generated handoff artifacts and selected review-only rule context.
- Available migration, query-plan, test and inspection evidence.

Use the supplied rule snapshot and scope metadata. Do not independently load task-lifecycle rules, task state, commands or token-economy configuration. If supplied inputs are missing or unreadable, describe the concrete limitation in the generated form rather than inventing scope, evidence or authority.

## Scope And Compact Evidence
- Review every assigned file, behavior boundary and applicable checklist category, including all generated coverage obligations.
- Follow only the omissions explicitly authorized by the generated handoff; concise output must not reduce assigned coverage or omit findings.
- Keep observations concise and evidence-bound. Record exact commands and actionable diagnostics for checks actually performed, using the generated output budget.
- On remediation reviews, re-sweep the complete current assigned scope rather than checking only previously reported findings.

## Database Review Lenses
1. Use `references/db-trigger-matrix.md` to understand the assigned database impact; preflight owns trigger evaluation and lane selection.
2. Inspect migration safety, data-loss paths, rollback implications and compatibility with existing data and callers.
3. Inspect query paths for N+1, unbounded scans, index usage and lock risks. Tie performance concerns to concrete queries and relevant execution evidence.
4. Check whether critical filters and sorts have an appropriate index strategy; identify query columns and the expected index pattern when reporting a defect.
5. Inspect transaction boundaries, isolation assumptions, read/write routing and consistency with the stated data guarantees.
6. Inspect constraints, data integrity and idempotency, including retry and partial-failure behavior.

## Evidence And Findings
- Continue the full review after finding an issue. Report every distinct supported defect and residual risk without inventing or padding findings.
- Deduplicate findings that share one root cause; describe the observed impact with concrete file:line evidence.
- Record the files, behavior boundaries, checks and applicable checklist categories actually inspected in the generated validation notes and coverage ledger.
- Distinguish a demonstrated migration, query, index or transaction defect from speculation or a missing command log.
- If an existing exception is relevant, cite its supplied artifact and rule ID. Do not grant or create exceptions.
- Do not widen the assigned scope or claim that an exhaustive sweep guarantees the absence of every latent defect.

## Focused Validation Boundary
Missing prior focused execution evidence alone is not a finding or residual risk. When that absence is the prospective concern, follow the generated handoff's narrow focused self-validation contract: attempt the smallest safe permitted local check for exactly one relevant authenticated repository target and obey its command restrictions. Record the exact command, outcome and concrete diagnostics in the generated validation note.

A passing check produces no finding. Report an exposed defect with its ordinary finding ID and linked evidence. An unavailable or prohibited attempt may use reserved F-000 only with the exact evidence-only marker and target required by the generated handoff; do not substitute a generic lack-of-testing finding. This skill does not redefine that marker or the output schema.

## Standalone Advice
Without a generated handoff, provide advisory findings with severity, concrete scope and evidence. Label limitations honestly. Standalone advice is not a mandatory review receipt or proof of task completion; do not fabricate generated bindings, policy decisions or acceptance.

## Review Selection
Preflight and the current generated handoff own lane selection and escalation. This skill does not duplicate trigger rules or independently start another review.
