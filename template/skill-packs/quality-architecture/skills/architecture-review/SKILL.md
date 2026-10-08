---
name: architecture-review
description: >
  Reviews cross-module and system-design changes for boundary violations, coupling drift,
  failure-mode gaps, data-ownership conflicts, deployment blast radius, and mismatch between
  stated architecture and actual changed code.
  Use when a task touches service boundaries, module public APIs, cross-cutting shared code,
  integration points, infra topology, or data-ownership contracts.
  Trigger phrases: arch review, design review, system review, boundary review, module review.
  Do NOT use for single-module internal refactors that do not alter any public surface or dependency direction.
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
  triggers: service boundary, module split, cross-module dependency, shared library change, data ownership, deployment topology, integration point
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, api-contract-review, dependency-review
---

# Architecture Review

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`. Return exactly one findings-only JSON object, complete the entire assigned scope and every coverage-ledger obligation, and do not add verdict, pass/fail, status, downstream disposition, or remediation fields. Any verdict-oriented text below is historical audit-only guidance and never applies to generated or other new review cycles.

## Core Workflow

1. **Map the change boundary.** Identify every module, service, or package touched by the diff. For each, determine its stated responsibility (from architecture docs, ADRs, or README) and its actual dependency direction in the code.
2. **Check dependency direction.** Verify that dependencies flow in the declared direction (e.g., feature → core, service → shared-lib, not the reverse). Flag any new import that inverts or creates a circular dependency between modules.
3. **Assess coupling surface.** For each cross-module change, check whether the touched interface is the narrowest necessary: no leaking of internal types, no shared mutable state, no implicit temporal coupling. Prefer explicit contracts (interfaces, DTOs, events) over direct access to another module's internals.
4. **Classify the failure boundary.** Distinguish in-process call chains from network, database, or cross-process I/O that crosses a real failure domain. For local calls, check input/output, errors, ordering, data ownership and actual resource cost; hop count alone cannot mandate an async boundary. For new or changed remote calls, check the end-to-end deadline, remaining budget and cancellation propagation. Retries require safe operation semantics and available budget; assess fallback/degradation, circuit-breaker or bulkhead protection where the actual partial-failure risk warrants it.
5. **Verify data ownership.** Confirm that only the owning module writes to each data store or topic. Flag any change that introduces a second writer, shares a database table across module boundaries, or reads another module's data without a declared contract.
6. **Estimate deployment blast radius.** Determine the minimum set of services/packages that must be deployed together. Flag changes that widen the required deployment set or that lack a rollback-safe migration path (e.g., non-additive schema change combined with a code change in one release).
7. **Cross-check architecture docs.** If architecture decision records (ADRs), diagrams, or architecture docs exist, verify the change is consistent with them. If the change intentionally diverges, require an updated or new ADR before approval.

## Boundary Examples

### Local call chain

`OrderController → OrderService → OrderCalculator → OrderFormatter` runs in one process with bounded deterministic work and no external I/O. Review its input/output, error, ordering and ownership invariants. Three local hops do not require an async boundary, per-hop timeouts or retries by themselves. Choose a different boundary only when actual latency, blocking work or isolation requirements justify it.

### Remote timeout propagation

`API → PricingService → InventoryService` crosses remote failure domains. API defines one request deadline `D`. PricingService forwards only the remaining budget to InventoryService; downstream timeouts cannot extend `D`. Propagate cancellation and stop when the budget is exhausted. Retries require enough remaining budget and idempotent or explicitly safe operation semantics. Assess fallback, circuit-breaker or bulkhead protection against the actual partial-failure risk; hop count alone does not mandate an async boundary.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Architecture review checklist | `references/checklist.md` | Any cross-module or system-design change |

## Anti-Patterns

- **Shared module as escape hatch**: moving logic into a common package only to bypass boundary friction, which usually hides ownership problems instead of solving them.
- **Second writer syndrome**: allowing another module or service to write the same table, topic, or file path without a formal ownership transfer.
- **Synchronous convenience chain**: replacing an explicit async boundary with a long synchronous call path that widens latency and failure blast radius.
- **Coupled rollout by accident**: changes that require multiple deploys, schema flips, or flag timing to line up, but document none of those constraints.

## Constraints

- Do not approve cross-boundary changes that invert the declared dependency direction without an explicit ADR or documented decision.
- Do not accept new shared mutable state between independently deployable modules.
- Do not permit a module to directly access another module's persistence (DB tables, queues, files) without a formal contract.
- Do not skip failure-mode analysis for new or changed remote calls, including external I/O hidden behind an in-process interface. Review pure local chains against local invariants rather than imposing distributed failure machinery from their hop count.
- Treat any change that widens deployment blast radius or removes rollback safety as a hard-fail unless explicitly justified and documented.
- Do not conflate this review with line-level code quality; focus on structural, boundary, and system-level concerns only.
