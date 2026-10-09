---
name: dependency-review
description: Independent dependency risk review for manifest, lockfile, and package upgrade changes. Use for requests like "dependency review", "lockfile review", "package upgrade review", or when preflight requires dependency review. Do NOT use for general code review without dependency scope.
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

# Dependency Review

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`. Return exactly one findings-only JSON object, complete the entire assigned scope and every coverage-ledger obligation, and do not add verdict, pass/fail, status, downstream disposition, or remediation fields.

Do not independently load task-lifecycle rules, task state, commands or token-economy configuration. Use only the assigned evidence and generated scope; this skill and its references do not grant command authority. Run a check only when the generated handoff explicitly permits that exact safe check. Never install packages, regenerate a lockfile, run Garda, or fetch remote dependency metadata as a mandatory reviewer.

Use this skill for independent dependency-change risk assessment.
Prioritize supply-chain integrity, runtime compatibility, and operational blast radius.

## Required Inputs
- Generated scope, supplied rule snapshot, output form, and coverage ledger for a mandatory review.
- In-scope manifests, lockfiles, version pins, and dependency diffs named by that handoff.
- Supplied runtime, migration, license, integrity, or validation evidence relevant to those changes.
- For standalone advice, the caller's explicit question and dependency scope; do not infer a mandatory review cycle.

## Review Workflow
1. Identify manifest, lockfile, and package-manager scope from changed files.
2. Load checklist from `references/dependency-review-checklist.md`.
3. Validate pinning strategy, major-version jumps, and transitive-risk visibility.
4. Validate changelog, release-note, or migration-impact evidence for breaking upgrades.
5. Validate runtime/build/test compatibility assumptions for changed packages.
6. Validate license, integrity, and supply-chain handling for newly introduced dependencies.
7. Check manifest/lockfile consistency and whether the proposed inputs keep installs deterministic.
8. Record evidence-supported findings and coverage in the generated form without widening the assigned scope.

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning the findings-only report. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. Include stable finding identifiers, severity, concrete file/line evidence, and impact in the fields supplied by the generated form; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Complete every coverage-ledger obligation exactly once with concrete assigned-scope evidence and the generated finding/no-finding result.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Validation Boundary
- Missing prior focused execution evidence alone is not a finding or residual risk. Inspect supplied results and repository contracts without implying an unrun check passed.
- When the generated handoff permits a safe focused check, use exactly one relevant authenticated repository target. Otherwise report reserved F-000 only with the exact evidence-only marker and target required by the generated handoff, when its narrow conditions actually apply.
- Report concrete risks such as incompatible range widening, provenance/integrity defects, manifest/lockfile drift, or broken runtime/migration assumptions with exact package names and before/after versions. Missing execution alone does not establish those defects.

## Standalone Advice
Standalone advice is not a mandatory review receipt. When explicitly asked outside a generated mandatory review, provide a scoped dependency-risk assessment with evidence, compatibility assumptions, and recommended checks. Do not emit a lifecycle decision or claim unperformed validation; any implementation belongs to the separately authorized executor.
