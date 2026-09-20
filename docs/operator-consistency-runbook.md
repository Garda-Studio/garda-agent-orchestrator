# Operator Consistency and Recovery Runbook

This runbook explains which runtime artifacts are canonical, which ones are derived indexes or caches, and how to recover safely when locks, manifests, or lifecycle operations become stale or corrupt.

Use this document together with:

- `garda status why-blocked --target-root "."`
- `garda doctor --target-root "."`
- `garda doctor explain <FAILURE_ID>`
- `garda gate task-events-summary --task-id "T-xxx"`

## Runtime Consistency Model

| Artifact | Role | Source of truth? | Safe to delete manually? | Recovery surface |
|---|---|---|---|---|
| `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl` | Per-task lifecycle log | **Yes** | **No** | Re-run the correct gate for missing events; inspect with `garda gate task-events-summary` |
| `garda-agent-orchestrator/runtime/task-events/all-tasks.jsonl` | Aggregate task-event index | No — derived from task activity | Only during corruption recovery, after confirming per-task JSONL files are intact | Future task-event writes recreate it; use per-task JSONL as authority while recovering |
| `garda-agent-orchestrator/runtime/task-events/.timeline-summary.json` | Timeline completeness/index summary | No — derived index | Yes | Runtime rewrites entries from per-task JSONL during later task-event writes and task-scoped reconciliation |
| `garda-agent-orchestrator/runtime/protected-hash-cache.json` | Protected-path hash cache | No — performance optimization only | Yes | Rebuilt on the next protected-path scan (`status`, `doctor`, or gates) |
| `garda-agent-orchestrator/runtime/protected-control-plane-manifest.json` | Trusted protected control-plane baseline | No — trusted baseline, not history | **No** | Refresh with `garda setup`, `garda update`, or `garda reinit` |
| `garda-agent-orchestrator/runtime/task-events/*.lock` | Task-event write coordination | No | Only if proven stale | `garda doctor --cleanup-stale-locks` |
| `garda-agent-orchestrator/runtime/reviews/*.lock` | Review-artifact write coordination | No | Only if proven stale | `garda doctor --cleanup-stale-locks` |
| `garda-agent-orchestrator/runtime/reviews/*-completion-gate.lock` | Completion finalization coordination | No | Only after owner verification | Manual removal after verifying the owning process is gone; `doctor --cleanup-stale-locks` does **not** reclaim these |
| `garda-agent-orchestrator/runtime/.update-in-progress` | Interrupted update sentinel | No | Prefer command-driven recovery | `garda update` or `garda rollback` |
| `.uninstall-in-progress` | Interrupted uninstall sentinel | No | Prefer command-driven recovery | `garda uninstall` or `garda setup` |
| `garda-agent-orchestrator/runtime/.lifecycle-operation.lock` | Lifecycle operation lock | No | **No** while live | Wait for the owner to finish, or recover the interrupted lifecycle command |

## Operator Rule of Thumb

1. If `runtime/task-events/<task-id>.jsonl` disagrees with an index, trust the per-task JSONL.
2. If a file exists only to summarize, aggregate, or cache runtime state, treat it as disposable/rebuildable metadata.
3. Never manually edit task-event JSONL, trusted manifests, or live lock directories.
4. The public task-event read contract is append-only schema version `2` with stable top-level `schema_version`, `event_source`, and `public_metadata` fields. Older legacy lines without those top-level fields must still be read as compatible history rather than rewritten in place.
4. Prefer `doctor`, `doctor explain`, `status why-blocked`, `update`, `rollback`, `reinit`, and task gates over ad-hoc file deletion.

## Quick Diagnosis

```bash
garda doctor --target-root "."
garda status why-blocked --target-root "."
garda doctor explain TIMELINE_INCOMPLETE
garda gate task-events-summary --task-id "T-242"
```

Use `doctor` for workspace-wide health, `status why-blocked` for task-facing blockers, `doctor explain` for named remediation steps, and `task-events-summary` when you need the canonical timeline for one task.

## Recovery Playbooks

### Task queue and workflow-setting transactions

All runtime TASK.md mutations use the task-queue repository, including status
changes, follow-up rows, reset, repair rollback, UI closure-policy edits and task
template installation. The existing `TASK.md.garda-status-sync.lock` name now
holds a directory with owner identity, PID, host and lease freshness metadata.
Writers acquire the lock before reading, compare the current bytes before
publication, and publish through a temporary file, file fsync and atomic rename.
Live owners and foreign-host locks are not reclaimed on age alone. A subsequent
writer can recover a confirmed dead local owner. Legacy lock files fail closed;
verify the owner is gone before operator recovery instead of deleting a live lock.
Reentrant synchronous writes fail immediately rather than deadlocking the owner.

`workflow set` (including guarded UI settings) holds one workspace-local lock
through read, validation, config/policy publication, audit, task-reset receipt and
protected-manifest refresh. Its write-ahead journal is
`runtime/workflow-config-transaction.json`; its lock is
`runtime/workflow-config-transaction.lock`. A failed operation restores the prior
generation. If the process is killed, the next `workflow set` first restores an
unfinished generation, or finishes journal cleanup for an already committed one.
Retry the intended confirmed command, or request an existing non-task-reset value
unchanged for recovery only. A no-op does not require new setting authorization;
any actual setting change retains the usual operator-confirmation requirements.

Do not delete the journal to bypass pending recovery. Recovery validates its
schema, participant allowlist, root, preimage hashes and current file hashes
before restoring anything. A foreign edit, corrupt journal, linked path or unknown
state stops recovery without overwriting the conflicting files. Preserve the
journal and participants for operator inspection. These are local recovery
records, not proof against a malicious actor who can rewrite the entire local
control plane. Critical configuration readers and workflow commands report pending
transactions rather than treating partially published settings as ready. Read-only
commands do not silently repair an interrupted write.

The transaction supports at most 16 MiB per participant (including the audit file)
and 64 MiB for the recovery journal. Exceeding a limit fails closed, without
silently truncating audit history. TASK.md repository reads also have a 16 MiB
bound. Keep authoritative audit history when addressing a size limit; do not
truncate it merely to unblock a write. Filesystem parent-directory fsync remains
best-effort and is not available through this helper on Windows; atomic rename
and file fsync do not promise hardware-independent power-loss durability.

These transactions do not make several independent files atomically visible to
arbitrary external filesystem readers. Do not run installation/update or manually
edit protected files concurrently with workflow setting mutations. Those writers
retain their separate lifecycle coordination.

### 1. Stale task-event or review-artifact locks

Symptoms:

- `status why-blocked` reports `STALE_TASK_EVENT_LOCK` or `STALE_REVIEW_ARTIFACT_LOCK`
- `doctor` shows stale locks under `runtime/task-events/*.lock` or `runtime/reviews/*.lock`

Safe recovery:

```bash
garda doctor --target-root "." --cleanup-stale-locks --dry-run
garda doctor --target-root "." --cleanup-stale-locks
```

Rules:

- Always run `--dry-run` first.
- Only locks proven stale are removed automatically.
- Do **not** delete live lock directories manually.

### 2. Stale completion finalization locks

Symptoms:

- `status why-blocked` reports `STALE_COMPLETION_FINALIZATION_LOCK`
- `doctor` shows `runtime/reviews/*-completion-gate.lock`

Safe recovery:

1. Verify the owning PID is gone.
2. Remove the stale `*-completion-gate.lock` directory manually.
3. Re-run `garda next-step T-xxx` and follow its printed recovery command.
   It may route back to `completion-gate` with the current preflight artifact,
   or directly to `task-audit-summary` if completion evidence is already valid.

Why manual? Completion finalization locks are intentionally separate from the stale-lock cleanup surface.

### 3. Corrupt or incomplete task timeline

Symptoms:

- `garda doctor explain TIMELINE_INCOMPLETE`
- `garda doctor explain TIMELINE_INTEGRITY_FAILED`
- `garda gate task-events-summary --task-id "T-xxx"` reports missing events, invalid JSON, or hash-chain violations

Safe recovery:

1. Treat `runtime/task-events/<task-id>.jsonl` as canonical evidence.
2. Re-run the missing gate(s) to emit the required lifecycle events.
3. Do **not** edit the JSONL manually.
4. If the canonical timeline is unrecoverable, mark the task `BLOCKED` and investigate from the last good gate artifact.

When only an index looks wrong:

- `all-tasks.jsonl` and `.timeline-summary.json` are derived.
- Diagnose from the per-task JSONL first.
- Let later task-event writes or task-scoped reconciliation refresh the derived indexes.

### 4. Corrupt aggregate task log or timeline summary index

Symptoms:

- A task timeline JSONL looks correct, but aggregate/summarized views are missing or inconsistent
- `doctor`/`status` warnings point at summary freshness rather than per-task JSONL corruption

Safe recovery:

1. Confirm the relevant `runtime/task-events/<task-id>.jsonl` files are intact.
2. Do not use `all-tasks.jsonl` as the authority during recovery.
3. If `.timeline-summary.json` is corrupt, remove it and let later task-event activity/task-scoped reconciliation rewrite entries.
4. If `all-tasks.jsonl` is corrupt, treat it as disposable derived state and let future task-event writes recreate the file; use canonical per-task JSONL until the index catches up.

Practical note: aggregate-log recreation is lazy/best-effort. It does not change task truth; it only affects the convenience index.

### 5. Protected manifest drift or corruption

Symptoms:

- `status` shows `Protected manifest (DRIFT)` or `Protected manifest (INVALID)`
- `doctor` reports `Protected Control-Plane Manifest`

Safe recovery:

```bash
garda setup --target-root "."
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda reinit --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

Rules:

- Do **not** hand-edit `runtime/protected-control-plane-manifest.json`.
- Use `--orchestrator-work` only for legitimate orchestrator control-plane tasks.
- In a self-hosted source checkout, source/bundle drift can be informational; lifecycle gates still decide whether the task may continue.

### 6. Corrupt protected hash cache

Symptoms:

- Protected-path scans slow down or start from scratch
- You suspect `runtime/protected-hash-cache.json` is invalid

Safe recovery:

Delete `garda-agent-orchestrator/runtime/protected-hash-cache.json` and rerun `garda status`, `garda doctor`, or the relevant gate. The cache is only a performance optimization.

### 7. Interrupted update, uninstall, or lifecycle operation

Symptoms:

- `doctor` reports `Interrupted update detected`
- `doctor` reports `Interrupted uninstall detected`
- `doctor` reports a lifecycle operation lock under `runtime/.lifecycle-operation.lock`

Safe recovery:

```bash
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda rollback --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda uninstall --target-root "."
garda setup --target-root "."
```

Rules:

- Re-run the lifecycle command instead of deleting sentinels manually.
- Use `rollback` when an update started but the applied state is uncertain.
- Use `setup` only when the workspace needs to be re-established from a clean operator path.

## What Not To Delete Manually

- `runtime/task-events/<task-id>.jsonl`
- live task-event locks or review-artifact locks
- `runtime/protected-control-plane-manifest.json`
- lifecycle sentinels/locks unless the relevant recovery command explicitly tells you to remove something

## Windows Caveats

- Lock directories can remain undeletable while another process still has an open handle.
- Always verify the reported PID before removing a stale lock.
- Use PowerShell equivalents for manual lock cleanup:

```powershell
Get-Process -Id <pid>
Remove-Item -LiteralPath ".\garda-agent-orchestrator\runtime\reviews\T-123-completion-gate.lock" -Recurse -Force
```

- If Windows reports `Access is denied`, treat the lock as still live until the owning process exits or the handle is released.

## Related Docs

- [CLI Reference](cli-reference.md)
- [Node Runtime Contract](node-runtime-contract.md)
- [Orchestrator Work, Protected Paths, and Isolation Remediation](orchestrator-work-and-isolation.md)
- [Control-Plane Isolation Mode](control-plane-isolation.md)
