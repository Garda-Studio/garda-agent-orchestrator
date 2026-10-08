# Refactor Safety Checklist

## Pre-Refactor Safety

- [ ] Relevant existing affected checks establish the baseline; mandatory workflow gates remain required.
- [ ] Target area has sufficient test coverage; characterization tests added where gaps exist.
- [ ] Preserved invariants are explicit (outputs, side effects, error contracts and public consumers); authorized behavior deltas are identified separately.
- [ ] Refactor scope is bounded; unrelated improvements are deferred to a follow-up.

## Seam Identification

- [ ] Interaction points between the target code and the rest of the system are mapped.
- [ ] Each seam is narrow enough to serve as a safe extraction or substitution boundary.
- [ ] Dependency direction at each seam is documented (who calls whom, who owns the interface).

## Coherent Scope

- [ ] The smallest coherent change may update a private module and its required callers together.
- [ ] Independently testable cuts and leaf-to-root order are used where helpful; callers are not left broken to enforce an order.
- [ ] Scope, dependencies and meaningful behavior checkpoints are stated before work; independent goals are split within the active budget.

## Change Separation

- [ ] Unrelated semantic changes are separate; explicitly authorized necessary coupled corrections are documented, tested and reviewed with the coherent unit.
- [ ] Unaffected invariants remain preserved, including observable errors, logs and metrics outside the authorized delta.
- [ ] Actual external consumers retain their public contract through a re-export or thin adapter until migration, or an explicitly authorized breaking-change contract applies.
- [ ] Private-only names and known callers can migrate together without a speculative compatibility layer.

## Incremental Verification

- [ ] Existing gates run the affected checks at meaningful behavior checkpoints; no full suite is demanded after every atomic edit.
- [ ] All mandatory compile, test, review and completion gates pass for the final coherent change.
- [ ] No new warnings, deprecations, or test skips introduced by the refactor.

## Rollback Readiness

- [ ] The reversible change boundary and safe recovery plan are explicit.
- [ ] Validation establishes the final invariants; an actual intermediate commit or actual revert is not required as proof.
- [ ] No irreversible side effects (data migrations, external API changes) bundled with the refactor.
