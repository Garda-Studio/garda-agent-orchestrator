# Full CI lifecycle qualification

Lifecycle fixtures use the shared pinned compile program instead of inline Node
evaluation. Update verification and workflow migration retain their existing
project command admission and permission preservation checks. The deployed and
legacy runner, rollback, materialization, memory preservation and full local
lifecycle assertions remain unchanged.

Completed-task evidence batches share queue contents only while inspecting their
task proofs. Evidence hashes, queue identity and workspace state are rechecked
after that read snapshot has ended. Reopened queues still invalidate the entire
batch, and cleanup must revalidate each proof under its existing mutation locks.

The bounded lifecycle writer audit includes the accepted configuration migration
calls in agent initialization and update execution, plus the read-only completed
evidence batching change. Its source seal requires an explicit independent review
of the bounded changes and the existing journal-owner coverage before acceptance.
