---
name: refactor-review
description: Independent refactor safety review for behavior-preserving changes with evidence-supported findings-only output. Use for requests like "refactor review", "cleanup review", "restructure review", or when preflight requires refactor review. Do NOT use for feature-design discussions without behavior-preservation scope.
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

# Refactor Review

Use this skill to inspect behavior-preserving changes for observable drift and maintenance risk.

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`.

Return exactly one findings-only JSON object using the generated output template. Complete the entire assigned scope and every coverage-ledger obligation. Do not add verdict, pass/fail, status, downstream disposition, or remediation fields. The controller owns policy decisions, follow-up creation and acceptance; the reviewer reports evidence-supported findings and risks.

## Required Inputs
- Task goal and explicit behavior-preservation requirements or documented intended contract changes.
- Authenticated changed-file scope and diff supplied by orchestration.
- Generated handoff artifacts and selected review-only rule context.
- Relevant tests, characterization evidence and changed-scope inspection, compiler or linter results.

Use the supplied rule snapshot and scope metadata. Do not independently load task-lifecycle rules, task state, commands or token-economy configuration. If supplied inputs are missing or unreadable, describe the concrete limitation in the generated form rather than inventing scope, evidence or authority.

## Scope And Compact Evidence
- Review every assigned file, behavior boundary and applicable checklist category, including all generated coverage obligations.
- Follow only the omissions explicitly authorized by the generated handoff; concise output must not reduce assigned coverage or omit findings.
- Keep observations concise and evidence-bound. Record exact commands and actionable diagnostics for checks actually performed, using the generated output budget.
- On remediation reviews, re-sweep the complete current assigned scope rather than checking only previously reported findings.

## Refactor Review Lenses
1. Use `references/refactor-review-checklist.md` as the inspection checklist within the assigned scope; report through the generated form.
2. Compare public contracts and user-visible flows, including inputs, outputs, errors and side effects, against the stated behavior-preservation requirement.
3. Inspect backward compatibility for configuration, events and data mappings, and behavior-critical domain paths.
4. Check the refactor's current-task justification and its effect on responsibility boundaries, complexity, coupling and duplication. Identify speculative abstraction or unused extension points with concrete evidence.
5. Inspect changed-scope unused imports and variables, stale helpers, dead code and relevant unresolved inspection, compiler or linter warnings.
6. Check test adequacy for extracted or renamed paths, edge cases, exception handling and transaction behavior. Trace concrete negative paths that could reveal hidden side effects or behavior drift.

## Evidence And Findings
- Continue the full review after finding an issue. Report every distinct supported defect and residual risk without inventing or padding findings.
- Deduplicate findings that share one root cause; describe the observed impact with concrete file:line evidence.
- Record the files, behavior boundaries, checks and applicable checklist categories actually inspected in the generated validation notes and coverage ledger.
- Distinguish a demonstrated defect from speculation or a missing command log. Explain relevant inspection warnings or supplied exceptions with concrete evidence.
- If an existing exception is relevant, cite its supplied artifact and rule ID. Do not grant or create exceptions.
- Do not widen the assigned scope or claim that an exhaustive sweep guarantees the absence of every latent defect.

## Focused Validation Boundary
Missing prior focused execution evidence alone is not a finding or residual risk. When that absence is the prospective concern, follow the generated handoff's narrow focused self-validation contract: attempt the smallest safe permitted local check for exactly one relevant authenticated repository target and obey its command restrictions. Record the exact command, outcome and concrete diagnostics in the generated validation note.

A passing check produces no finding. Report an exposed defect with its ordinary finding ID and linked evidence. An unavailable or prohibited attempt may use reserved F-000 only with the exact evidence-only marker and target required by the generated handoff; do not substitute a generic lack-of-testing finding. This skill does not redefine that marker or the output schema.

## Standalone Advice
Without a generated handoff, provide advisory findings with severity, concrete scope and evidence. Label limitations honestly. Standalone advice is not a mandatory review receipt or proof of task completion; do not fabricate generated bindings, policy decisions or acceptance.

## Review Selection
Preflight and the current generated handoff own lane selection and escalation. This skill does not duplicate trigger rules or independently start another review.
