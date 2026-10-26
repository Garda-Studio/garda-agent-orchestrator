# Deferred next-step optimizations

## P2: navigation audit projection

Round 6 consumer inspection at 537beb12 found that the audit is consumed on every
normal navigation route, including routes that do not consume the final report.
`resolveNextStepDecisionRoute` reads:

- lifecycle gate outcomes for full suite, compile, required reviews, completion,
  startup and preflight decisions;
- required review flags and scope category for launch planning and trust;
- `status` in the common result's `auditStatus` (text and JSON);
- final-report status/blocker and all blockers for terminal task routing;
- the full final-closeout artifact for retained final-report comparison.

`buildTaskAuditSummaryFromSnapshot` derives status from lifecycle failures,
coverage, required-review evidence, integrity, project-memory evidence,
post-completion drift, supporting-gate gaps and finalization-lock state. Removing
the audit on a pre-review or launch route is therefore not output preserving.
Report-only calculations also perform authenticated artifact and workspace
reads. It has not been established that suppressing them preserves every
fail-closed exception and snapshot-boundary check.

Retain the current implementation. A future change must first separate a common
authenticated evidence collection from projections. Navigation and full audit
must consume the same evidence and identical status reducer; full-report-only
formatting may then be lazy within the authenticated invocation. Never allow a
lazy getter to escape its snapshot or run after a navigation effect mutates the
workspace. Compare full text/JSON, exceptions, changed-source rejection,
artifact-generation changes, finalization locks and active/completed paths,
including a mutation between consumers. Counts must demonstrate that the
expensive evidence graph is collected once rather than merely renaming the
full audit operation. No audit check or output field is removed by this deferral.

## P3: broader derived-review memoization

The implemented cache covers JSON parsing of the private immutable payload
captured by the existing review-artifact snapshot. Every access still enters
`readReviewArtifactCanonicalSnapshot`; invalidation, path resolution, file
identity, publication generation and read budgets remain authoritative. Buffers
never escape (the public byte reader copies them); new snapshots use new buffers.
Returned JSON remains a fresh deeply frozen value, preserving existing identity
semantics. Invalid JSON is cached only for those same captured bytes.

Memoizing whole review-state, coverage, validation-obligation, quality-analysis
or remediation-authority functions is deferred. Their explicit arguments do not
contain every dependency: they also read source bytes, current task-mode and
preflight authority, command sources, timeline restart provenance and other
artifacts. A key of path/mtime or serialized arguments is insufficient. First
extract pure derivations accepting an immutable authenticated evidence graph,
including exact source content and the active/completed inspection mode; retain
all boundary checks on every access. Include mutation-between-consumer tests
for every captured dependency before adding such a cache.
