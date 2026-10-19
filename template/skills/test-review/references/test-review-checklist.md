# Test Review Checklist

Use with any language, framework and runner. Report only evidence-supported findings.

## Behavior Coverage
- [ ] Every changed or new behavior has at least one assertion that fails if it regresses.
- [ ] Error paths, boundaries and empty/invalid inputs touched by the change are asserted.
- [ ] Removed or renamed behavior no longer has stale tests that still pass vacuously.

## Assertion Quality
- [ ] Assertions check results and side effects, not only absence of exceptions.
- [ ] Expected values were not changed to accommodate a defect.
- [ ] Snapshot or golden-file updates are explained by an intended behavior change.

## Regression Evidence
- [ ] For a fix, the case fails on the old behavior and passes on the new one (expected-red evidence when supplied).
- [ ] The evidence runs the reviewed test sources, not unrelated tests.

## Isolation And Determinism
- [ ] No dependence on execution order, shared mutable state, real time, network, locale or random seeds without control.
- [ ] Resources created by tests are cleaned up or isolated.

## Fixtures And Data
- [ ] Fixtures reflect production-relevant shapes, nullability and limits where they matter.
- [ ] Mocks and fakes do not hide the integration boundary the change actually affects.
