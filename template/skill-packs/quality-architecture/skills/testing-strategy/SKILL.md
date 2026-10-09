---
name: testing-strategy
description: Shapes risk-based test strategy for code changes. Use when deciding what to test, balancing test layers, improving fixture quality, targeting regressions, or controlling flakiness. Triggers — "test plan", "which tests to write", "coverage gap", "flaky", "regression". Negative trigger — routine single-unit-test additions with no strategy questions.
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: quality
  triggers: test plan, test strategy, coverage gap, regression, flaky test, fixture, test data, contract test, integration test balance
  role: specialist
  scope: review-and-advisory
  output-format: findings-and-checklist
  related-skills: orchestration, code-review, architecture-review
---

# Testing Strategy

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`. Return exactly one findings-only JSON object, complete the entire assigned scope and every coverage-ledger obligation, and do not add verdict, pass/fail, status, downstream disposition, or remediation fields.

Do not independently load task-lifecycle rules, task state, commands or token-economy configuration. The checklist is a review lens, not permission to edit tests, run Garda, or launch CI. Use the supplied evidence and execute only exact safe checks explicitly permitted by the generated handoff.

## Core Workflow

1. **Identify the risk surface.** List changed modules and their outbound contracts (APIs, events, persistence, UI entry points). Rank each by blast radius — a shared service adapter outranks a leaf utility.
2. **Map existing coverage.** Locate supplied/in-scope tests that exercise the changed paths. Identify the concrete failure modes they do and do not detect; a missing layer alone does not establish a defect.
3. **Select the right test layer per risk.**
   - **Contract / API tests** — for any change to a public interface, schema, or serialized format.
   - **Integration tests** — for persistence, external calls, queue interactions, or multi-module flows.
   - **Unit tests** — for pure logic, transformations, and edge-case branches.
   - **E2E / smoke tests** — only when user-facing workflows or critical paths are affected.
4. **Evaluate fixtures and test data.** Verify production-relevant shapes and boundary cases. Report unrealistic IDs, missing nullable fields, or stale schema snapshots when they conceal a concrete failure mode; fixed deterministic fixture IDs can be appropriate.
5. **Check for flakiness vectors.** Review time-dependent assertions, uncontrolled network calls, shared mutable state, test ordering dependencies, and non-deterministic data.
6. **Recommend a minimal effective test set.** Prioritize high-risk paths over exhaustive low-value coverage. State explicitly which paths do not need new tests and why.
7. **Check regression sensitivity.** A regression must assert intended behavior and demonstrate how the old behavior fails. Do not change expectations to preserve a known bug or merely mirror implementation details.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Strategy checklist | `references/checklist.md` | Any test-strategy decision or review |

## Anti-Patterns

- **Coverage target as strategy**: treating line coverage percentage as the goal instead of asking which failures actually matter.
- **Redundant layer overlap**: asserting the same field or branch in unit, integration, and end-to-end tests without increasing defect-detection value.
- **Mock-only confidence**: using pure unit tests to "prove" correctness for integration-heavy code that actually fails at boundaries.
- **Permanent flaky quarantine**: moving unstable tests out of the main path without a tracked repair or replacement and retained critical signal.

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning the findings-only report. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. Include stable finding identifiers, severity, concrete file/line evidence, and impact in the fields supplied by the generated form; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Complete every coverage-ledger obligation exactly once with concrete assigned-scope evidence and the generated finding/no-finding result.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Constraints

- Do not demand 100 % line coverage; optimize for defect-detection value per test.
- Allow repeated assertions across layers when they detect distinct failure modes: a pure serialization test and an API adapter test may check the same field while detecting different defects. Remove overlap only when it adds no defect-detection value.
- Do not treat mocks as proof of correctness; prefer narrow real integrations when setup cost is low.
- A bounded flaky-test quarantine requires a tracked repair or replacement, an accountable owner and exit condition, and retained critical signal. A silent skip or deletion without those safeguards is not a fix.
- Avoid snapshot tests for volatile output; prefer structural assertions.
- Never recommend tests that depend on execution order or shared external state without explicit isolation.

## Validation Boundary
- Missing prior focused execution evidence alone is not a finding or residual risk. Review actual test assertions and supplied evidence; do not claim an unrun local or hosted check passed.
- When the generated handoff permits a safe focused check, use exactly one relevant authenticated repository target. Otherwise report reserved F-000 only with the exact evidence-only marker and target required by the generated handoff, when its narrow conditions actually apply.
- A concrete incorrect assertion, untested changed failure contract, or lost critical regression signal can be a finding; demand neither a new test nor another layer without that evidence.

## Standalone Advice
Standalone advice is not a mandatory review receipt. For an explicit strategy question outside a generated mandatory review, recommend a minimal test set, layer rationale, fixtures, and any accountable quarantine plan. Distinguish performed checks from recommendations; implementation and CI execution require separate authorization.
