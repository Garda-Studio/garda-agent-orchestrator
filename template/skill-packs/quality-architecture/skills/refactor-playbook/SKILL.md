---
name: refactor-playbook
description: >
  Guides behavior-preserving refactors through invariant locking, characterization tests,
  seam creation, bounded coherent changes, and explicit semantic intent. Use when a task
  requires extracting modules, reducing complexity,
  decoupling components, consolidating duplicated logic, or restructuring legacy code
  without altering observable behavior.
  Trigger phrases: refactor, extract module, decompose, restructure, simplify, consolidate,
  reduce complexity, decouple, technical debt, untangle.
  Do NOT use for greenfield design or full rewrites. Use feature skills for primary
  behavior changes; this playbook can support explicitly authorized coupled corrections.
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
  triggers: extract, decompose, split, inline, move, rename, simplify, consolidate, decouple, technical debt
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: code-review, architecture-review, testing-strategy
---

# Refactor Playbook

## Core Workflow

1. **Lock invariants before touching code.** Identify the observable behaviors that must not change: outputs, side effects, error contracts and public consumers. Establish the relevant baseline with existing affected checks. Add characterization tests where target-area coverage is insufficient; do not treat intentional authorized behavior changes as invariants to preserve.
2. **Identify seams.** Locate the narrowest points where the target code interacts with the rest of the system — function boundaries, interface implementations, dependency injection sites, event emitters, or I/O adapters. These seams define safe cut lines for extraction and substitution.
3. **Choose the smallest coherent change.** A private module and its required callers may change together when that is the bounded unit that preserves invariants. Prefer independently testable cuts; use leaf-to-root order where it helps, rather than leaving callers broken to enforce an order. State scope, dependencies and meaningful checkpoints before editing.
4. **Make semantic intent explicit.** Separate unrelated feature or bug-fix work. Explicitly authorized necessary coupled corrections may accompany structural changes when separating them would leave the coherent unit incorrect. Identify the intentional behavior delta, preserve unaffected invariants, and test and review both parts together; unrelated semantics remain out of scope.
5. **Validate meaningful behavior checkpoints.** Run affected checks through the existing workflow gates when a coherent unit or behavior boundary changes. Mechanical edits do not require a full suite after every atomic edit. Keep all mandatory compile, test, review and completion gates; batching does not excuse an unvalidated behavior change.
6. **Preserve real consumer compatibility.** Identify actual external consumers before renaming or removing a public symbol. Keep a re-export or thin adapter bridge until those consumers migrate, unless an explicit breaking-change contract authorizes removal. Private-only symbols and their known callers can migrate together without a speculative compatibility layer.
7. **Plan safe rollback.** Describe the reversible change boundary and isolate irreversible data or external effects. Use the workspace's normal commit and recovery rules. This guidance requires neither an actual intermediate commit nor an actual revert as proof; validation must establish that the final coherent change preserves its stated invariants.

## Examples

### Private module rename

Rename private `parseLine` to `parseOrderLine` and update its required callers together in the same bounded change. Preserve input/output, error and side-effect invariants and validate the affected parser/caller paths at the coherent checkpoint. With no actual external consumers, the old private name needs no re-export bridge.

### Public API migration

For exported `getInvoice` with actual external consumers, introduce `loadInvoice` and keep `getInvoice` as a thin adapter preserving the existing public contract, including errors and side effects. Document deprecation and validate old and new consumers. Remove the adapter only after consumer migration or explicit approval of the breaking-change contract.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Refactor safety checklist | `references/checklist.md` | Any behavior-preserving refactor or extraction task |

## Constraints

- Separate unrelated semantic changes; document and validate explicitly authorized necessary coupled corrections in the same coherent unit.
- Do not silently remove a public contract used by actual external consumers; provide a compatibility bridge or follow an explicitly authorized breaking-change contract.
- Do not skip characterization tests when existing coverage is insufficient for the target area.
- Bound the module/caller scope; split independent goals before they exceed the active task's scope budget.
- Do not perform speculative generalization (adding extension points, abstractions, or parameters "for the future") as part of a refactor task.
- Treat observable error, log or metric changes as semantic deltas. Keep them separate when unrelated; otherwise require explicit authorization and focused assertions for the coupled correction.
