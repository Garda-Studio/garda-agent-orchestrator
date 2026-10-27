# Deferred next-step optimizations

Round 6b supersedes the original P2, P3 and P5 deferral decisions. This document
describes the implemented boundaries and the remaining concrete fallback cases.
Within an invocation, consumers may share one checked observation, provided the
A1 final dependency check rejects changed inputs before output and effects.
Across invocations, Q4 recomputation records require authentication, freshly
checked input digests and all relevant identities. Gate-owned closed-cycle
outcomes have the separate navigation boundary described below. The P6
cross-invocation timeline checkpoint remains deferred.

## Q2: checked invocation observations

Read-only navigation now shares scope path and byte observations, equivalent Git
reads and separate ACL evidence for each inspected object. Retained timeline and
review owners participate in the final dependency check even after their nested
snapshot closes. Each invocation starts fresh; metadata is not a cross-call cache.
Standalone gates retain their existing read paths.

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

## Q5: gate-owned closed-cycle outcomes

Native gates authenticate review evidence before publishing a navigation summary.
Only an authenticated restart with matching task, event and status bindings can
close earlier attempts. Navigation checks the summary's current authority and
continues authenticating open-cycle evidence and every older artifact explicitly
referenced by a current rule. Missing or invalid acceleration follows the native
path; it is not evidence of success.

Completion and explicit audit still validate the full closed archive. Historical
Markdown used by the current quality-checklist cadence rule also remains a live
input when old events lack signed cadence admissions. Inferring a pass from an
unsigned event status alone would miss a FAILED verdict in its referenced report.
The existing bounded legacy cadence window is retained.

## Q7: navigation and report projections

Navigation retains the authenticated evidence and status/blocker reducers it
consumes. Report-only formatting is lazy within the checked invocation; it cannot
escape its owner. Current terminal materializations can use an authenticated
projection bound to the closeout JSON, Markdown, final report, ledger bytes and
complete renderer code/runtime identity. Every current file is still checked.
Missing or invalid acceleration follows the native validation path.

A concrete fallback remains when an existing materialized report has neither a
usable projection nor its ledger. Adding an otherwise unused property to the
closeout JSON leaves renderer output unchanged, but the native exact-current-summary
comparison rejects the altered JSON. That exact comparison and its history work
remain on this fallback. Tasks without a materialized result retain their existing
terminal behavior.

## Q4: authenticated persisted derivations

The implemented records cover fixed quality parsing and reduction operations.
Native acquisition of source, context and authority evidence remains live.
Authenticated private records bind workspace, task, lane, cycle, mode, parameters,
policy/plan and loaded code to the observed dependency digests. Readers validate
current observations before selecting a result; invalid, missing or mismatched
records take the native derivation path. A selected record's dependencies also
participate in the invocation's final check.

The dependency recorder supports checked bytes, absence, filtered directory names,
file kind/link identity, process results, ACL verdicts and verified timeline
queries. Unrecorded I/O or an unsealed callback cannot publish a reusable result.
Code-only preparation resolves native lazy imports before binding the complete
transitive code graph, so a fresh CLI process can consume a native producer's
record. It does not waive code, input or final freshness checks.

## Superseded Round 6 decisions

The original P2/P3/P5 deferrals described consumers that repeatedly acquired
implicit inputs and checked freshness independently. Round 6b replaces those
premises with authenticated invocation observations, immutable derivations and the
final dependency check described above. Those original deferrals do not apply to
the implemented work. Cross-call reuse still requires current byte and identity
validation; pathname, file metadata or serialized arguments alone are not proof.

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
