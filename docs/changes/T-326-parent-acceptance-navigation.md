# Decomposed parent acceptance navigation

When every explicit child reaches DONE, the existing queue synchronization and
its lifecycle events remain unchanged. The navigator now requests the native
parent audit before reporting accepted completion. The queue transition alone
does not establish the original parent's acceptance.

On subsequent navigation, a gate-owned parent DONE marker cannot hide aggregate
audit blockers or an unavailable final closeout. The navigator retains the
exact blockers and does not suggest restarting the parent's leaf workflow.
Authenticated operator discard and accepted terminal evidence retain their
existing treatment.

Child source diagnostics distinguish an invalid timeline, a missing
`TASK_SOURCE_COMMIT_ACCEPTED` event and invalid or ambiguous source events.
An audited no-op alone still cannot substitute for source acceptance. Existing
source authentication, ancestry, composition, WIP and memory checks remain
required; this repair does not publish missing evidence or close a parent.
