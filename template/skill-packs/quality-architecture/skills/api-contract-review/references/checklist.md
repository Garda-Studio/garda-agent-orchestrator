# API Contract Review Checklist

## Surfaces And Directions

- [ ] Inspect the changed contract and actual producers/consumers against the prior committed version.
- [ ] Include independently consumed persisted JSON/config, CLI arguments and machine-readable CLI output; HTTP is not a prerequisite.
- [ ] Identify old/new callers, accepting servers, output producers, readers and stored-data versions.
- [ ] Check new producer/old consumer and supported old producer/new consumer rollout or rollback directions.

## Request-Consumer Compatibility

- [ ] Accepted enum/type expansion retains every previously valid old caller input and its semantics.
- [ ] Accepted enum/type narrowing or rejection of previously accepted null has concrete old-caller impact assessed.
- [ ] A newly required input still supports prior omission through a verified compatible path, or has a project-specific evolution plan.
- [ ] New caller inputs are not assumed to work with an old server merely because the new server accepts them.
- [ ] Unknown-field acceptance/rejection and validation retain the intended caller contract.

## Response-Producer Compatibility

- [ ] Newly emitted enum values/types or null are checked against old strict decoders and actual tolerant fallbacks.
- [ ] Narrower emitted sets remain within old reader acceptance and retain promised behavior; new narrow readers are checked against old producers where rollback requires it.
- [ ] Omitted/renamed guaranteed fields and additional fields are checked against required-field and strict unknown-field readers.
- [ ] Error codes, envelope fields, status meanings and error handling are checked using existing project conventions and actual consumer impact.

## Schema And Observable Semantics

- [ ] Types, presence, nullability, collection wrappers and date/time formats agree with implementations.
- [ ] Effective defaults are actually applied where needed; schema default annotations are not treated as insertion or migration proof.
- [ ] Changes to omitted-input behavior or interpretation of old stored data are assessed even if structural validation succeeds.
- [ ] Persisted data migrations/applied defaults and CLI reader fixtures cover supported old/new and rollback combinations.
- [ ] Changed pagination, cursor, filtering, idempotency and retry semantics have relevant bounds and consumer checks.

## Evolution And Severity

- [ ] Follow existing project version, error, deprecation and migration conventions; do not prescribe a universal HTTP envelope.
- [ ] Demonstrated breaks have an appropriate compatible rollout, migration or versioned surface under those conventions.
- [ ] Missing evidence is described precisely and investigated within the assigned scope; uncertainty alone does not mandate a version bump.
- [ ] Severity follows demonstrated failure, exposure and impact, rather than treating every schema or error-envelope change as high severity.

## Evidence And Generated Output

- [ ] Tests use actual relevant consumer/producer or stored/CLI fixtures, with positive and negative assertions proportional to the change.
- [ ] The response enum expansion, old-caller request expansion and non-HTTP examples are checked against actual accepted/emitted sets.
- [ ] Complete the whole assigned scope and every generated coverage obligation after discovering a finding.
- [ ] Preserve read-only reviewer scope; the exact ReviewOutputPath is the only permitted write and no descendant agent or task lifecycle command is allowed.
- [ ] Use the generated findings-only form as sole output authority; do not add a verdict, status, disposition or alternative Markdown recipe.
- [ ] Follow only the generated narrow focused validation/F-000 exception, retain exact diagnostics and do not repeat current gate-owned execution.
