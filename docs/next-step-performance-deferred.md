# Deferred next-step optimizations

Round 6b supersedes the P2, P3 and P5 deferral decisions below; those sections
retain historical analysis, not reasons to defer the accepted implementation.
Within an invocation, consumers may share one checked observation, provided the
A1 final dependency check rejects changed inputs before output and effects.
Across invocations, only an authenticated Q4 record bound to freshly checked
input digests and all relevant identities may supply a derived result. The P6
cross-invocation timeline checkpoint remains deferred.

## Q2: checked invocation observations

Read-only navigation now shares scope path and byte observations, equivalent Git
reads and separate ACL evidence for each inspected object. Retained timeline and
review owners participate in the final dependency check even after their nested
snapshot closes. Each invocation starts fresh; metadata is not a cross-call cache.
The real 64-file fixture performs 64 scope observations and 64 hashes with one or
five review lanes. Standalone gates retain their existing read paths.

The new observation does not span the executing resolver of --execute-effects.
A concrete native WIP regression has a required Git clean filter that keeps the
first line and a smudge filter that appends a random UUID. Predicting checkout
bytes with cat-file --filters invokes smudge once, then checkout invokes it again;
the exact-write prototype falsely rejects the valid operation and adds a filter
invocation. Capturing arbitrary post-checkout bytes instead can bless a foreign
second-line write hidden by clean. The prototype is not shipped. The existing
plan verification and live action checks remain; no execution check is removed.
A real executeNextStepEffects regression proves one smudge, successful WIP capture
and the subsequent decomposition transition. Extending the new observation across
those effects requires an exact producer protocol that handles this scenario.

## Q3: invocation review derivations

Quality evidence, validation phases and obligations, task-mode evidence, dirty
baseline normalization, review scope, lane bindings and context contracts now
share private immutable nodes within the checked read invocation. Full semantic
inputs select separate lane, strict/soft and active/retained-completed contracts;
mutable public copies cannot change retained evidence. Descriptor-only keys leave
opaque caller objects on their original computation path. The preflight facade
still executes its existing per-consumer registry synchronization and checks.

Skill entrypoint/reference selection and DELTA baseline reads retain their native
path, bounded-reader and authentication checks. Q2 dependencies cover consumed
bytes, kinds and missing paths through the final check. Native realpath and the
raw stat fields used by workspace authentication remain distinct from completed
filesystem identities. Large native readers keep their original byte acceptance:
above the 128 MiB retained-content bound, a native read is compared with the Q2
digest; this exceptional compatibility path performs two physical reads. Strict
skill readers likewise retain their original no-follow/nonblocking descriptor
capture and compare it with the shared content observation. Neither path claims
that distinct capture contracts have been replaced by a weaker common reader.

## Q6: remediation authority on verified invocation input

Commit 36066aba already shared the integrity result and captured events. It still
replayed every requested observer and revalidated after consumers. The invocation
now retains an immutable verified view used by remediation authority without
observer replay. Complete safe options plus the current timeline digest select
an isolated authority result; authenticated appends cannot reuse the prior head.

Only an active Q2/A1 observation suppresses the three duplicate snapshot freshness
sites. The retained owner performs its original live validation at invocation exit,
and the explicit append precondition remains live. Outside that observation the
existing callback checks remain. Current receipt, context, report and classification
inputs retain their native checks and final byte/path dependencies. Initial-full
contracts keep their original no-timeline path. No cross-call verification is cached.

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

## P5: filesystem and process memoization

The initial counters covered only Git helper calls and icacls, omitting direct
Git calls and native SID probes. Independent review rejected the resulting claim
that duplicate process work was already bounded. Measurement now captures actual
synchronous Node process boundaries, keyed by command, arguments, working
directory, options and environment (only their digest is emitted). Duplicate
process work remains an open optimization; no process cache is introduced.

Retain `getSafeWorktreePathState` and `fileSha256` semantics. The former resolves
the root and target, checks link targets and rechecks symlink identity after
reading. The latter checks expected identity, opens a descriptor, hashes all
bytes, and compares descriptor and path identity before/after the read. Caching
by pathname or metadata would replace fresh byte/path observations with a new
freshness assumption. The hard requirement to miss on every input change has
not been proven for that change, including parent junction replacement,
same-size writes, timestamp restoration and permissions changing between reads.

Future work may share immutable bytes already captured by authenticated readers,
while retaining fresh descriptor/path/authority checks, or introduce a writer
exclusion protocol covering every dependent source and path component. A cache
must include hash options, expected identity, resolved root, every symlink/junction
component, target bytes and authorization dependencies. It must preserve the
existing fail-closed result if any of them change during a navigation call.

## P6: cross-call incremental timeline verification

Within a call, the integrity result and validated event set share the authenticated
timeline snapshot. Q6 above consolidates freshness only under the active A1 owner;
standalone observer delivery retains its callback-time checks and event ordering.

Across calls, retain full payload capture, parsing and integrity verification.
A prefix checkpoint plus file size/mtime or inode does not prove the prefix is
unchanged. Re-hashing the full prefix preserves detection but still costs O(N).
A safe future design needs a trusted append-only authority outside the mutable
workspace, bound to exact prefix bytes, task identity, schema and writer identity,
with authenticated revocation for replacement, truncation and migration. The
reader must reject or fully reverify on unavailable authority, any prefix/path
change, restored metadata, schema changes and checkpoint replay. An untrusted
sidecar or a record signed only from its own claims is insufficient. This design
is deferred; no cross-call checkpoint is used in 1.4.4.
