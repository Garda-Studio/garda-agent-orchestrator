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
