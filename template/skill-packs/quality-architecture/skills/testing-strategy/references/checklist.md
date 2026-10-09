# Testing Strategy Checklist

For a generated mandatory review, this checklist is a lens within the assigned scope, not command, test-edit, CI, or output-format authority. Fill the generated findings-only form and coverage ledger. Outside that review, an authorized executor may use it for standalone test planning.

## Risk Framing

- [ ] Identify changed modules and rank them by blast radius (shared > leaf).
- [ ] Confirm existing test coverage for every changed public contract.
- [ ] State explicitly which changed paths need no new tests and document the rationale.

## Coverage Mix

- [ ] Check changed interfaces/schemas against existing contract or API coverage and identify concrete missing failure modes.
- [ ] Evaluate boundary coverage for persistence, external calls, and multi-module flows; another layer is justified by risk, not its absence alone.
- [ ] Use unit tests for pure logic and edge cases. Allow repeated assertions across layers for distinct failure modes; remove overlap only when it adds no defect-detection value.

## Fixtures & Flakiness

- [ ] Validate fixture data reflects current production shapes (nullable fields, enums, realistic IDs).
- [ ] Scan for flakiness vectors: time-sensitive assertions, shared state, network calls, and ordering dependencies.
- [ ] A bounded flaky-test quarantine has a tracked repair or replacement, an accountable owner and exit condition, and retained critical signal. Silent skips or deletion are not a fix.

## Negative Paths & Recovery

- [ ] Make sure at least one test exercises the expected failure mode for each changed public contract.
- [ ] Check retry exhaustion, timeout, validation-error, and permission-denied behavior where those cases matter.
- [ ] Prefer deterministic fault injection over ad hoc sleeps or brittle environment toggles.
- [ ] Assert intended behavior and demonstrate how old behavior fails; do not rewrite expectations to accept a known bug or merely mirror the implementation.

## Validation Evidence & Advice

- [ ] Inspect supplied local/CI evidence and distinguish performed checks from recommendations; this checklist does not authorize CI execution.
- [ ] Missing prior focused execution evidence alone is not a finding or residual risk. Follow the generated handoff's exact safe-check and narrow F-000 conditions rather than inventing an execution requirement.
- [ ] Record whether smoke, canary, or post-deploy validation is needed for the changed risk surface.
- [ ] In standalone advice, recommend required/optional tests and explain remaining gaps. In a mandatory review, use only generated findings/coverage fields and do not assign a lifecycle decision.
