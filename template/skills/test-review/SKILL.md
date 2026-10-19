---
name: test-review
description: Independent findings-only review of changed tests and test evidence. Use when preflight requires a test review, or for requests like "review tests", "review test changes", "is this covered". Applies to any language, test framework and runner. Do NOT use for writing new tests or for test-strategy planning without concrete changes.
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

# Test Review

Use this skill to inspect whether changed tests and the supplied test evidence actually protect the changed behavior.

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`.

Return exactly one findings-only JSON object using the generated output template. Complete the entire assigned scope and every coverage-ledger obligation. Do not add verdict, pass/fail, status, downstream disposition, or remediation fields.

## Required Inputs
- Task goal and the changed behavior the tests must protect.
- Authenticated changed-file scope, declared file roles and diff supplied by orchestration.
- Supplied selected-case, focused, full-suite and report-file evidence for the current cycle.

Use the supplied rule snapshot and scope metadata. Do not independently load task-lifecycle rules, task state or commands. If supplied inputs are missing or unreadable, describe the concrete limitation in the generated form rather than inventing scope or evidence.

## Test Review Lenses
Apply `references/test-review-checklist.md` to every changed test and to the changed production behavior:
1. **Behavior coverage.** Each changed behavior, error path and boundary has an assertion that would fail if the behavior regressed. Name the uncovered behavior concretely; a missing test layer alone is not a defect.
2. **Assertion quality.** Assertions check outcomes, not merely that code ran; expectations are not rewritten to match a known defect; snapshots or golden files are not accepted blindly.
3. **Expected-red and regression evidence.** When the task claims a fix, the supplied evidence shows the new or changed case failing for the old behavior and passing now, through the project's own runner.
4. **Isolation and determinism.** No hidden ordering, shared mutable state, wall-clock, network or locale dependence without explicit control.
5. **Fixture realism.** Test data reflects production-relevant shapes and boundaries where that matters for the failure mode.
6. **Evidence integrity.** The commands, selected cases and report files in the evidence correspond to the reviewed test sources; a passing run of different or unrelated tests is not coverage.

Judge tests by the conventions of the project's own language and framework. Do not require a particular runner, file naming scheme or directory layout.

## Evidence And Findings
- Continue the full review after finding an issue. Report every distinct supported defect and residual risk without inventing or padding findings.
- Deduplicate findings that share one root cause; give concrete file:line evidence and the regression that would go undetected.
- Record the tests, behaviors, evidence items and checklist categories actually inspected in the generated validation notes and coverage ledger.

## Focused Validation Boundary
Missing prior focused execution evidence alone is not a finding. When the generated handoff permits it, run the smallest safe focused check for exactly one relevant authenticated test target with the project's own runner and record the exact command, outcome and diagnostics. A passing check produces no finding; an unavailable or prohibited attempt follows the generated handoff's evidence-only marker contract.

## Standalone Advice
Without a generated handoff, provide advisory findings with severity, scope and evidence. Standalone advice is not a mandatory review receipt or proof of task completion.

## Review Selection
Preflight and the current generated handoff own lane selection. This skill does not duplicate trigger rules or independently start another review. For broader test-strategy planning, the optional `quality-architecture` pack provides `testing-strategy`.
