# Manual CI selection

The CI workflow accepts only `workflow_dispatch`. It validates the shared selector in
`scripts/manual-workflow-authorization.cjs` before selected jobs run. The remaining
workflows have their own wiring contracts. Security, Secret Scanning, SBOM and
standalone Smoke also use the manual selector; publication wiring follows separately.

The dispatch contract uses these inputs as data through step environment variables:

| Environment variable | Required value |
| --- | --- |
| `MANUAL_WORKFLOW` | Fixed profile: `ci`, `security`, `secret-scanning`, `sbom`, `smoke-schedule`, or `publish` |
| `MANUAL_REPOSITORY` | Exact current `GITHUB_REPOSITORY` |
| `MANUAL_COMMIT` | Full lowercase 40-character SHA equal to the dispatch run's `GITHUB_SHA` |
| `MANUAL_AUTHORIZATION` | `I authorize this selected run` |
| `MANUAL_JOB` | One supported job, or explicit `all` for validation workflows |
| `MANUAL_OS` | `ubuntu-latest`, `windows-latest`, `macos-latest`, or explicit `all` |
| `MANUAL_RUNTIME` | Supported Node version (`22.13.0` or `24`), or explicit `all` |

Only `workflow_dispatch` is accepted. Missing authorization, foreign repository or
SHA, shell-like values, unsupported choices and prototype property names fail closed.
The SHA binds selection to the workflow run commit; it cannot redirect checkout to
another commit. Callers must use this SHA for checkout and retain independent evidence
of the jobs and steps that actually ran.

The CI profile retains Linux static/test jobs, Linux/Windows release validation and
Linux/Windows/macOS smoke. Selecting one job and unsupported OS fails. Selecting
`all` jobs with one OS includes only compatible jobs on that OS. Security, secret,
SBOM and publication profiles use Linux and Node 24; standalone smoke supports both
Node versions and all three operating systems. `all` always means the profile's
bounded supported set, never self-hosted or larger billed runners.

Publication has explicit `validate` and `stage-publish` operations. Validation does
not select publication; staging also selects its validation prerequisite. Selection
does not replace environment/OIDC, tag/version, candidate evidence, duplicate-publish
guards or npm staged approval.

The CLI appends one `selection=<JSON>` record to the runner-provided `GITHUB_OUTPUT`.
Use `jobs.<id>.enabled` as a job condition before expanding that job's `matrix`.
`complete_matrix_requested` describes requested coverage; it is not successful CI
evidence, a consent receipt or release readiness. A partial selection cannot satisfy
a complete-suite release gate. Failed-job retries must keep the same authorized
repository, SHA and selection; actual retry execution and platform coverage are
validated by the workflow/evidence children. This document grants no CI execution.

For CI, supply `repository`, `commit`, `authorization`, `job`, `os` and `runtime`.
The first three have no defaults. The choice defaults select only Linux static checks
on Node 24. Choose `all` for each of the last three inputs to request the complete
22-job suite. `release` names the existing `validate-release` job. Every job checks out
the run's exact `github.sha`; the supplied commit cannot choose a different checkout.
Authorization runs on a fixed hosted Linux runner with pinned Node setup and read-only
repository permission. Each dispatch keeps its own concurrency group.

A selected job may run while its unselected prerequisites are skipped. A selected
prerequisite that fails or is cancelled prevents its dependants from running. Existing
test, release preparation, platform smoke and failure-evidence steps are preserved.

Candidate readiness uses `scripts/manual-ci-evidence.cjs` from the authoritative
verifier checkout. It verifies the reviewed workflow and selector, npm script contract,
same repository/SHA, a completed successful manual run on `dev`, `main` or `master`,
the authorization step and every required job and preparation step. Success from a
partial selection is insufficient, even when a payload claims complete-matrix intent.

GitHub's failed-job or single-job rerun preserves the run's authorized inputs and SHA.
Readiness retrieves the paginated `filter=all` job history and authenticated metadata
for earlier attempts whose successful jobs or unexpanded skipped records are retained.
Known literal matrix-name records with no executed steps may be retained only from an
earlier attempt, with authenticated identity and timestamps, after every row of that
family executes successfully in a later attempt. These records add no coverage. It requires the latest result
for all 23 job identities, including authorization, and actual execution in the current
attempt. Duplicate, foreign, stale, failed or replayed evidence is rejected; a skipped
latest row or a matrix family without later complete execution is also rejected.
A rerun cannot expand a partial selection into release coverage; a different selection
requires a separately authorized dispatch. This validation does not launch a rerun.

Publish candidate validation uses this same authenticated complete-suite adapter.
Its read-only discovery selects the latest manual CI run ID for the exact SHA without
filtering for success. `node scripts/release-candidate.cjs verify-ci <ci-run-id>
<commit-sha> <owner/repo>` then fetches the current run, paginated full job history
and retained attempts itself. A saved run summary, older green fallback or local
fixture cannot authorize publication. Discovery and verification share step-level
`GH_TOKEN`; token bytes are never written into candidate evidence. The tag trigger
and publication retry guards remain unchanged until the separate publish-wiring work.

The standalone publication-history guard is also not wired into that workflow yet.
Its future CLI is `node scripts/release-publish-history-evidence.cjs validate` or
`stage-publish`, using the current manual tag runner's repository, full SHA, tag,
run ID and attempt from GitHub environment data. It obtains authenticated GET
evidence itself rather than accepting a saved summary. The reviewed whole-workflow
binding must be updated with the final manual wiring before real use.

Retries are limited to three total attempts across every same-tag run ID. Successful
authorization may be retained within a run, but every contributing attempt and its
complete job history must be authenticated. Known validation-only failure with
unexecuted, skipped staging may retry; any earlier executed/failed/cancelled or
uncertain stage history refuses restaging. The current staging check additionally
requires successful validation and a queued npm step that has never started.
Current validation also permits its own strictly unstarted queued stage job;
queued stage history from an earlier run or attempt is rejected.
See [publication history guard](release-readiness.md#publication-history-guard-not-yet-wired)
for checkpoint names, freshness, source binding and serialization constraints.
This read-only guard executes no workflow, rerun, artifact upload or publication.

Security accepts the same six dispatch inputs. Its default selects only `npm-audit`
on `ubuntu-latest` with Node `24`; `osv` selects only the pinned reusable scanner and
`all` selects both. Linux and Node 24 are the only supported selector choices (`all`
maps to that bounded set). Node selection applies to authorization and npm audit;
the pinned OSV workflow uses its own scanner runtime, with no Node input. Both the
npm checkout and the reusable workflow's supported `ref` input use `github.sha`.
Repository read permission is sufficient for authorization/npm; only OSV receives
the SARIF `security-events: write` permission. Dispatch inputs enter the shared
selector as environment data rather than shell source.

Candidate security proof requires the successful authorization job, full-graph npm
audit and the pinned OSV scan/reporter in one completed manual run on a release lane.
A one-scan selection is useful validation but cannot satisfy release evidence.
Verification pins the workflow and selector, fetches paginated `filter=all` history,
authenticates each recorded attempt's repository/SHA/branch/event and timestamps,
and requires the latest result for every required job plus actual current-attempt
execution. Earlier skipped caller-level OSV records with no executed steps add no
coverage and require later successful inner-job execution. Partial, duplicate,
automatic, foreign, stale or replayed proof, and a failed/skipped latest result, fail
closed. Schema-2 attestation binds job IDs/attempts, selector and workflow hashes,
lockfile and candidate digests, and the exact OSV checkout ref. Old schema-1 or
automatic-run evidence must be replaced by genuine current manual evidence; it is
not migrated into a PASS. These source changes grant no permission to execute CI.

CI, Security and Publish verification bind the complete reviewed workflow source,
normalizing only CRLF line endings (and the existing reviewed immutable-pin quoting
for Publish). Scalar comments, expressions, blank lines and trailing bytes remain
part of the source contract. Static Security readiness requires that same reviewed
manual contract; recognizable audit or OSV commands cannot replace a failed source
check. A schema-2 record with the former normalized workflow digest also requires
fresh current evidence rather than automatic migration into a PASS.

Secret Scanning and SBOM accept the same six explicit inputs, defaulting to their
single validation job (`gitleaks` or `sbom`), Linux and Node 24. An explicit `all`
maps to that same bounded one-job set. Repository, commit and authorization have
no defaults. A failed or cancelled authorization prevents the selected job from
running; dispatch inputs reach the selector as environment data. Authorization
and validation check out `github.sha` with persisted Git credentials disabled.
Each dispatch keeps its own concurrency group.

Gitleaks retains full Git history, the pinned CLI and archive checksum, repository
configuration, redacted output and failing leak exit code. SBOM retains its locked
CycloneDX dependency, lifecycle-disabled install, toolchain/lockfile/SBOM identity
record and missing-artifact failure. Static release readiness binds the reviewed
manual workflow bytes, action pins and selector; an automatic trigger, altered
authorization/checkout, or unreviewed selector fails the baseline. This source
binding retains all scalar content, including `#` lines: GitHub expressions can
expand those lines before shell parsing. CRLF copies and quoted spellings of the
exact reviewed action references remain compatible. This is source contract
validation, not evidence of a hosted scan or permission to start one.

Manual Smoke remains at `.github/workflows/smoke-schedule.yml` with selector profile
`smoke-schedule`, but has no scheduled or automatic trigger. It accepts the same six
inputs with defaults `smoke`, `ubuntu-latest` and `24`. Authorization uses a fixed
Linux/Node 24 job; only the selected OS/runtime runs pack and lifecycle validation.
Explicit `all` OS and runtime choices request the six Linux/Windows/macOS and
Node 22.13.0/24 combinations. Choosing `all` for job, OS and runtime also records
complete-matrix intent; that intent is never successful platform or release proof.

Both authorization and smoke check out the run's exact SHA without persisted Git
credentials. Failed or cancelled authorization prevents matrix execution. Existing
prebuilt-bundle lifecycle probes, run-scoped update branch and failure evidence are
preserved, including per-OS/runtime artifact names and 15-day retention. Each
dispatch has its own non-cancelling concurrency group. To investigate runner drift,
an operator must authorize a new manual selection; the former weekly run is removed.
This source change does not execute a workflow or grant permission to do so.
