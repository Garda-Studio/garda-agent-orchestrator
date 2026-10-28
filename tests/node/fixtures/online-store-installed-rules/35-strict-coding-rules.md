# Strict Coding Rules

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Purpose
These rules define mandatory quality gates for production code.
They are not optional recommendations.

## Rule IDs
- `SOLID-SRP`
- `SOLID-OCP`
- `SOLID-LSP`
- `SOLID-ISP`
- `SOLID-DIP`
- `QG-COMPLEXITY`
- `QG-SIMPLICITY`
- `QG-PARAMETERS`
- `QG-DUPLICATION`
- `QG-NULL-SAFETY`
- `QG-ERROR-HANDLING`
- `QG-LOGGING`
- `QG-TRANSACTIONS`
- `QG-INPUT-VALIDATION`
- `TEST-TEST-FIRST`
- `TEST-REGRESSION`
- `TEST-UNIT-INTEGRATION`
- `TEST-PASS-GATE`
- `TEST-NO-BUGGY-EXPECTATIONS`
- `DOC-IMPACT-ASSESSMENT`
- `DOC-UPDATE-REQUIRED`
- `DOC-CHANGELOG-ENTRY`
- `DB-MIGRATIONS`
- `DB-N-PLUS-ONE`
- `DB-INDEX-BACKED`
- `DB-MODULE-BOUNDARIES`

## SOLID Mandatory Rules

### SRP (Single Responsibility Principle)
Mandatory:
- Each class or service has one business responsibility.
- Each public method performs one unit of work.

Forbidden:
- Combining validation, persistence, external calls, and notification in one method.
- Utility classes that contain unrelated domain logic.

Review checks:
- A class should not have more than four direct collaborators unless explicitly justified.
- A method should not exceed 40 logical lines unless complexity is documented.

### OCP (Open/Closed Principle)
Mandatory:
- Extend behavior via new implementations (strategy, plugin, registry), not by modifying stable core flows.

Forbidden:
- `if` or `switch` chains by provider type in core business services.

Review checks:
- New providers or adapters should be added without rewriting existing provider logic.

### LSP (Liskov Substitution Principle)
Mandatory:
- Implementations of an interface preserve functional contract and error semantics.

Forbidden:
- Narrowing valid input range in child implementations.
- Throwing broader or undocumented exceptions for the same contract.

Review checks:
- Interface implementations must pass shared contract tests.

### ISP (Interface Segregation Principle)
Mandatory:
- Use small role-focused interfaces per consumer use case.

Forbidden:
- Fat interfaces with methods unused by some consumers.

Review checks:
- No consumer should depend on methods it does not use.

### DIP (Dependency Inversion Principle)
Mandatory:
- Domain services depend on abstractions (ports/interfaces), not framework or infrastructure classes.

Forbidden:
- Injecting concrete adapters directly into domain-level services.

Review checks:
- Constructors of domain services should accept interfaces for external dependencies.

## Additional Quality Gates
- Prefer the smallest correct change that satisfies the task and existing architecture. Speculative abstraction, one-off configurability, future-proofing, or broad rewrites without current-task evidence are review findings.
- Cyclomatic complexity target is `<= 10` per method. Values `> 15` require refactor or explicit exception.
- Maximum parameters for public methods is `5`; use request objects for larger inputs.
- Duplicate business logic across modules is not allowed.
- Null handling must be explicit. Hidden null contracts are forbidden.
- Exceptions must be domain-specific and actionable; swallowing exceptions is forbidden.
- Business logs must be structured and include operation identifiers (`orderId`, `userId`, `paymentId`, and similar).
- Transaction semantics must be explicit. Query-only operations must use framework-appropriate read-only semantics.
- All external input must be validated at module boundaries.

## Testing Rules
- Test-first applies to runtime code behavior changes: add or update tests before implementation.
- Every bug fix requires at least one regression test.
- Domain logic requires unit tests; repository or infrastructure behavior requires integration tests.
- Review cannot pass when required tests are failing.
- Do not modify tests to match incorrect runtime behavior unless requirements changed and rationale is documented.

## Database-Focused Rules
- Persistent model changes require migrations.
- Avoid N+1 queries in hot paths.
- Critical filter and sort queries should be index-backed.
- Cross-module data access should use public module contracts, not direct table coupling.

## Documentation Rules
- Any runtime behavior change requires documentation impact assessment.
- Documentation impact assessment must be machine-checkable via task artifact (`runtime/reviews/<task-id>-doc-impact.json`).
- If behavior, contract, or operating flow changed, update relevant docs in the same task.
- API contract changes require API documentation updates.
- Architecture or integration flow changes require updates in architecture docs or ADR records.
- Every completed runtime behavior-change task requires an entry in `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md`.
- In normal deployed workspaces, this internal changelog is local orchestration evidence and may stay gitignored; update it on disk, but do not use `git add -f` unless the user explicitly asks to version orchestrator internals.

## Exceptions
Any exception to these rules must be documented in a review artifact (PR description or task log entry) with:
- rule id,
- reason,
- risk,
- mitigation plan,
- follow-up task id.

## Enforcement
- Automated checks should be used where available (for example: Checkstyle and CI workflows).
- Rules without automation must be enforced through explicit reviewer checklist items in independent review, each with auditable evidence.
- Non-automated rule review must include coverage declaration: `applicable_rule_ids`, `not_applicable_rule_ids`, and reason for each skipped rule id.

