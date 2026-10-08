# Architecture Review Checklist

## Boundary Integrity

- [ ] Each module/service touches only its own declared domain; no boundary leaks.
- [ ] Dependencies flow in the declared direction (feature → core, service → shared-lib).
- [ ] No new circular dependency introduced between modules or packages.
- [ ] Cross-module interfaces use explicit contracts (interfaces, DTOs, events), not internal types.

## Coupling & Cohesion

- [ ] Shared mutable state does not span independently deployable units.
- [ ] New shared code belongs in a declared shared-lib, not duplicated or smuggled via transitive imports.
- [ ] Temporal coupling between modules is explicit (documented ordering, saga, or choreography).
- [ ] Internal implementation details are not exposed through public module APIs.

## Data Ownership

- [ ] Each data store (DB table, topic, queue) has exactly one owning module that writes to it.
- [ ] No module reads another module's persistence directly; access goes through a declared contract.
- [ ] Schema changes are additive or behind a migration that is rollback-safe.

## Failure Modes

- [ ] Changed calls are classified as in-process work or network, database, or cross-process I/O across a real failure domain.
- [ ] Local chains preserve input/output, errors, ordering, data ownership and actual resource-cost invariants; hop count alone cannot mandate an async boundary.
- [ ] Remote calls respect an end-to-end deadline by propagating the remaining budget and cancellation; do not reset a full timeout at each hop.
- [ ] Retries fit the remaining budget and use idempotent or explicitly safe operation semantics; fallback or degradation is defined where a non-critical remote dependency can fail.
- [ ] Async boundaries, circuit-breaker or bulkhead protection follow actual latency, isolation and partial-failure risk rather than a fixed hop threshold.

## Deployment & Rollback

- [ ] Minimum deployment set is identified; blast radius has not silently widened.
- [ ] Schema migrations and code changes can be deployed independently (expand-contract).
- [ ] Feature flags or versioned endpoints gate risky behavioral changes.
- [ ] Rollback path is documented or obvious (revert-deploy without data loss).

## Architecture Documentation

- [ ] Change is consistent with existing ADRs and architecture diagrams.
- [ ] Intentional divergence from documented architecture has a new or updated ADR.
- [ ] Module responsibility descriptions (READMEs, doc headers) are updated if scope changed.

## Operability

- [ ] New integration points emit structured logs or metrics sufficient for incident triage.
- [ ] Alerting thresholds reviewed if a new failure domain is introduced.
- [ ] Health-check or readiness probe covers newly added external dependencies.
