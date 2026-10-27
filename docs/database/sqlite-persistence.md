# SQLite Persistence Contract

Status: Accepted derived-projection contract after the staged T-1000 sequence.

This ADR defines the ownership, compatibility, migration, recovery, and
measurement contract for Garda's SQLite work. It does not make SQLite an
authoritative store. The T-1000-6 cutover review retained canonical-file
authority, so SQLite remains a disposable, rebuildable projection.

## Decision

- Each Garda workspace owns one SQLite database at
  `<workspace-root>/garda-agent-orchestrator/runtime/catalog/orchestration.sqlite3`.
- Operational data from different workspaces must never share a database.
- A future machine-wide workspace registry, if required, must be a separate,
  opt-in design. It may contain workspace identifiers, canonical paths,
  last-seen timestamps, and health summaries only. It must not contain task,
  event, review, or project-memory content.
- The supported embedded driver is the built-in `node:sqlite` module using
  `DatabaseSync`, behind an internal persistence adapter.
- The adapter must use only APIs available on the minimum supported Node line,
  Node 22.13+, and must capability-probe the module before enabling SQLite.
- SQLite access runs inside the Garda Node process. There is no database server,
  daemon, port, or separately managed service.
- A missing, unavailable, locked, incompatible, or corrupt projection must not
  prevent canonical file writes or safe read fallback.

The workspace-local boundary prevents cross-project lock contention, data
mixing, version coupling, and a machine-wide recovery domain. It also keeps
copy, removal, backup, and rebuild operations confined to one workspace.

## Scope And Non-Goals

This contract covers the derived orchestration catalog introduced by the first
four T-1000 stages and the later project-memory search index. It deliberately
does not:

- replace canonical files;
- move raw logs, diffs, reviewer output bodies, configuration, locks,
  sentinels, or recovery archives into SQLite;
- permit SQLite-only completion, security, or review decisions;
- introduce a networked or machine-global database;
- authorize an authoritative-state cutover; T-1000-6 completed with canonical
  files retained as the trust and recovery boundary.

## Source-Of-Truth Matrix

| Information | Canonical source | SQLite projection | Recovery rule |
|---|---|---|---|
| Task definitions, ordering, priority, profile, and operator-authored notes | `TASK.md` | Normalized task and queue rows, plus source path and content hash | Re-read `TASK.md`; database rows never prove lifecycle completion. |
| Lifecycle evidence and ordering | `runtime/task-events/*.jsonl`, including sequence and hash-chain evidence | Indexed event envelope, task id, event type, sequence, timestamp, source path, and source hash | Replay valid canonical events in order; reject or report malformed/hash-invalid input. |
| Review attempts, artifacts, receipts, and provenance | `runtime/reviews/**` | Attempt/receipt metadata, verdict, reviewer identity, context hashes, artifact paths, and content hashes | Re-index validated files; raw handoffs, diffs, logs, and reviewer output bodies stay outside the database. |
| Terminal task evidence | `runtime/task-ledger/**` | Queryable ledger fields and provenance | Rebuild from ledger files and their hashes. |
| Retention and cleanup state | Canonical retention artifacts and the source-owned cleanup contract | Queryable eligibility and inventory rows | Recompute from canonical artifacts; SQLite alone must never authorize deletion. |
| Metrics | `runtime/metrics.jsonl` and other canonical metric streams | Typed samples and aggregates with source offsets/hashes | Replay the canonical stream; aggregates are disposable. |
| Live configuration | `live/config/**` | Selected immutable snapshots or hashes needed to explain a projection | Reload files; never use a stale database value to override live config. |
| Project memory | Approved Markdown under `live/docs/project-memory/**` | Later hash-bound FTS documents and bounded relationship rows | Re-index approved Markdown; SQLite must not rewrite it. |
| Git state | Git worktree, index, and `HEAD` | Optional observation metadata for query correlation | Ask Git again for any trust or completion decision. |
| Locks, sentinels, and process/run markers | Filesystem and live process state | None, except non-authoritative historical observations | Resolve through the owning lock/recovery surface, never through a database-only flag. |
| Backups and rollback snapshots | Files under their existing recovery roots | Inventory metadata and hashes only | Validate the actual files before use. |

The initial logical catalog contains normalized task rows, lifecycle events,
review attempts and receipts, artifact paths and hashes, task ledgers, retention
state, and metrics. Later stages may add project-memory FTS and relationship
tables. Every imported row must retain enough provenance to identify its
canonical source, ordering position where applicable, timestamp, and content
hash.

### Derived Catalog Schema v2

T-1000-2 implements the internal adapter under
`src/runtime/sqlite-catalog/`. Schema version 1 contains:

- `canonical_sources` for workspace-relative source identity, observation time,
  and whole-source content hashes;
- `task_queue_rows`, `lifecycle_events`, `review_attempts`,
  `review_receipts`, `artifacts`, `task_ledgers`, `retention_state`, and
  `metric_samples` for the normalized orchestration projection;
- `metric_labels` for normalized metric dimensions;
- `catalog_state` for disposable projection generation and snapshot identity;
- `schema_migrations` for immutable migration checksums and application-version
  provenance.

T-1000-3 adds schema version 2, which stores the last reconciled canonical
runtime mutation generation in `catalog_state`. Existing canonical writers
advance the integrity-checked generation journal only after their file write
commits. They do not need to open SQLite. If a projection refresh is skipped or
fails, the generation mismatch makes the catalog ineligible for trusted reads
and preserves canonical file fallback until reconciliation catches up.

Every domain row references `canonical_sources` and separately retains its
record hash plus source sequence, byte offset, and source timestamp where those
values exist. The adapter replaces a complete projection inside one bounded
`BEGIN IMMEDIATE` transaction only when the normalized projection contains at
most 10,000 rows, including source and metric-label rows. Larger inputs return
`rebuild_required` before a writer transaction starts. T-1000-3 must handle that
result through the explicit, progress-reported rebuild outside the interactive
write path. Failed or contended bounded writes roll back and return a deferred result.
Initial schema migration also holds the workspace catalog maintenance lock and
uses the contract's five-second maximum maintenance wait. This stage does not
scan canonical files, change any command's read path, or make SQLite
authoritative. T-1000-3 adds the scanner and maintenance orchestration without
changing query authority; hot read-path adoption remains T-1000-4.

## Canonical-First Write And Read Ordering

1. Validate and write the canonical file using its existing atomicity and
   integrity rules.
2. Commit the SQLite projection update in a separate bounded transaction.
3. If projection update fails, preserve the canonical success, emit a bounded
   diagnostic, mark the projection stale, and continue through file fallback.
4. A later incremental reconciliation or full rebuild catches the projection up.

Production canonical writers converge through the existing runtime mutation
generation commit boundary. After that boundary releases its generation lock, a
successful commit schedules one coalesced best-effort reconciliation per
workspace and event-loop turn. Before scanning canonical inputs, the automatic
path performs a constant-time recovery-unit size check, a metadata-only bounded
inventory of the canonical source areas, and a direct inspection of existing
connection leases without opening another catalog connection. It runs the
synchronous scanner only while both the main database plus WAL and the complete
canonical workload are at most 512 KiB, the workload contains no more than 512
filesystem entries, and no live connection lease exists. Exceeding either
bound, a live connection, or unsafe metadata returns `deferred` before file
content is read and leaves the generation stale for explicit reconciliation or
rebuild. This bound keeps a full-history or large-artifact scan out of
established-project write latency while T-1000-4 owns benchmark-qualified
incremental query adoption. Scheduling never changes the canonical result: an
unavailable SQLite runtime or malformed input inside the bounded envelope emits
a bounded diagnostic. Normal writes do not create a missing catalog implicitly;
an explicit repair or rebuild bootstraps it before write-through reconciliation
is active.

Reads go through a repository/query boundary. It may use SQLite only when the
catalog is compatible, healthy, and current for the sources needed by that
query. Otherwise it uses the existing file reader. Recovery and rebuild read
canonical files into a new projection; they never write recovered projection
values back to canonical files.

### Reconciliation And Maintenance Commands

T-1000-3 projects the canonical active task table, integrity-checked per-task
event streams, task ledgers, retention state, bounded review metadata referenced
by those streams, and runtime metrics. A stable snapshot hash covers the sorted
canonical source identities and content hashes. Normal reconciliation validates
the complete next projection but replaces only sources whose hashes changed;
unchanged SQLite rows remain in place. The interactive transaction limit applies
to the changed source set, including deleted rows. A larger change returns
`rebuild_required` instead of starting a long writer transaction.

Review-artifact ingestion fails closed above 4,096 unique referenced artifacts,
8 MiB for one artifact, or 128 MiB across one canonical snapshot. Size checks run
before reading artifact content so health and recovery paths cannot allocate an
unbounded buffer from a hash-declared review artifact.

The public maintenance surface is:

```text
garda repair catalog health [--json]
garda repair catalog drift [--json]
garda repair catalog repair [--confirm] [--json]
garda repair catalog rebuild [--confirm] [--json]
```

`health` and `drift` are read-only. They validate canonical input, catalog
compatibility, snapshot hashes, row-level parity, and source-level drift. Their
SQLite open uses read-only mode and never migrates schema, changes journal
policy, or writes catalog rows. It briefly registers ephemeral coordination
metadata while holding the maintenance lock so catalog promotion cannot race an
inspection, then releases that connection lease after the SQLite handle closes.
Inspection fails closed when the lease cannot be registered safely. A missing
or older catalog is reported for fallback or writable repair without catalog mutation.
`repair` and `rebuild` are preview-only unless `--confirm` is supplied.
Confirmed rebuilds populate bounded batches in a workspace-confined staging
database, checkpoint and seal its WAL, require both `quick_check` and the full
`integrity_check` to return `ok`, run foreign-key and exact row-parity
validation, then hold the catalog maintenance lock only for backup
and atomic promotion. Promotion fails closed while any live process owns a
catalog connection lease. An interrupted staging build leaves the previous
live catalog untouched. Confirmed corruption repair uses the same exclusive
maintenance check before moving the main database, WAL, and SHM files together
into quarantine. Projection failures are returned as deferred diagnostics
after the canonical operation has already succeeded; they never roll back
canonical files.

## Driver And Runtime Compatibility

`node:sqlite` is selected over a third-party native add-on because Garda already
requires Node 22.13+, the module is available there without a feature flag, and
it adds no package installation, native ABI, or database-service dependency.
`DatabaseSync` also fits Garda's short-lived local CLI process model.

The module's API maturity differs across supported Node releases, so its types
must not leak outside the adapter. Startup must probe `node:sqlite`,
`DatabaseSync`, the required prepare/transaction behavior, and the embedded
SQLite features used by the schema. A failed probe disables the projection and
selects file fallback with a diagnostic.

Module availability does not guarantee that the embedded SQLite library was
built with FTS5. Missing FTS5 is a supported capability limitation, including
on the Node 22.13 compatibility floor: Garda does not create or open the
workspace catalog in that case and continues through the canonical-file
readers. FTS5-dependent integration tests run only when the same runtime probe
succeeds; the unavailable and canonical-fallback paths remain mandatory tests.

The implementation must not rely on newer conveniences absent from the support
floor. In particular:

- configure lock waiting with `PRAGMA busy_timeout`, not the newer constructor
  `timeout` option;
- create consistent backups with `VACUUM INTO`, not the newer `sqlite.backup`
  helper;
- keep SQL and row mapping behind the adapter so a future driver change requires
  a new ADR rather than application-wide edits.

Long scans, rebuilds, and maintenance work must be explicit operations with
progress reporting. Ordinary navigator and report queries must stay bounded;
synchronous database work must not become an unbounded pause in the CLI. The
adapter therefore refuses to start an in-place projection transaction above its
10,000-row limit; the caller must route that projection to explicit rebuild
orchestration rather than retrying the same synchronous write.

## Database Identity And Schema Versioning

The database uses both SQLite-native identity/version fields and an auditable
migration ledger:

- `PRAGMA application_id = 0x47415231` (`GAR1`, decimal `1195463217`);
- `PRAGMA user_version` is the current integer schema version;
- `schema_migrations(version, name, checksum, applied_at_utc, app_version)`
  records every applied migration;
- projection state records canonical source identity, path, sequence or byte
  offset where applicable, timestamp, and content hash.

Version `0` with an empty schema is uninitialized. A non-empty database with a
different application id is not a Garda catalog and must not be modified. A
schema newer than the running CLI is read/write incompatible: the CLI must not
downgrade it and must use canonical file fallback. A known older schema is
migrated before ordinary queries.

Migrations are forward-only, sequential, immutable, and checksummed. Under the
workspace's catalog maintenance lock, each migration:

1. verifies the current application id, `user_version`, and all prior ledger
   checksums;
2. creates a consistent backup before a destructive or multi-step change;
3. enables migration durability, opens `BEGIN IMMEDIATE`, applies one version,
   writes its ledger row, updates `user_version`, and commits atomically;
4. validates the resulting schema and returns to the normal connection policy.

An error rolls back the active migration. The CLI closes the database, keeps or
restores the last validated catalog when safe, marks the projection unavailable,
and falls back to canonical files. Migration failure must never rewrite or roll
back canonical evidence.

## Connection, WAL, And Contention Policy

Each CLI process owns at most one catalog connection and closes it in `finally`.
Connections are never inherited by child processes. Every open registers a
process-owned connection lease while briefly holding the maintenance lock, and
close releases the lease only after the SQLite handle closes. Multiple normal
processes may hold separate leases concurrently; exclusive promotion and
quarantine defer until no live lease remains. Dead same-host leases are
reclaimed through the filesystem-lock owner check, while an unverifiable lease
fails closed. Lease files are ephemeral coordination metadata, not catalog-data
mutation. On every connection the adapter applies and verifies the relevant settings:

```sql
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
PRAGMA busy_timeout = 250;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA wal_autocheckpoint = 1000;
```

Extension loading remains disabled. Dynamic values use bound parameters and
dynamic identifiers come only from fixed allowlists.

WAL is required for the derived catalog so readers do not block a normal writer.
The returned journal mode must be `wal`; silently falling back to another mode
is not accepted. The database, `-wal`, and `-shm` files are one recovery unit.
The catalog is enabled only on a local filesystem whose resolved path remains
inside the workspace runtime root. UNC paths, Windows mapped network drives,
and known network, clustered, shared-folder, or userspace filesystem types
disable SQLite and use file fallback. If Windows drive locality or filesystem
type cannot be inspected, the adapter also fails closed to file fallback.
The initial path check probes the nearest existing directory; after
`runtime/catalog` is created, the open path resolves and probes that actual
directory again before SQLite creates or opens the database. Windows drive
mapping is queried afresh for every catalog open; the two checks within one
open may reuse only that operation-scoped classification.
The post-create check also verifies realpath containment so a symlink or
junction cannot redirect the database or WAL companions outside the workspace.

Normal projection writes use short transactions. Interactive commands wait at
most 250 ms; there is no unbounded retry loop. `BUSY` or `LOCKED` means
contention, not corruption: the operation falls back or defers reconciliation
and must not quarantine the database. Migration, rebuild, restore, and promotion
additionally require the maintenance lock and may use an explicit timeout of at
most five seconds. Migration and validated promotion use `synchronous = FULL`;
the ordinary rebuildable projection uses `NORMAL`.

## Integrity, Corruption, And Rebuild

Every open validates the application id, supported schema version, migration
ledger checksums, and required schema shape. `PRAGMA quick_check` runs after
migration, rebuild, restore, an unclean maintenance exit, and periodically via
health/doctor policy. Explicit deep diagnosis and every backup/restore validation
run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`; success requires the
integrity result `ok` and no foreign-key violation rows.

The following are not corruption: a missing database, stale projection,
unsupported newer schema, capability-probe failure, or a bounded `BUSY`/`LOCKED`
result. They select file fallback and a targeted repair path.

For confirmed corruption or invalid Garda identity:

1. acquire the maintenance lock and close all task-owned connections;
2. move the database and any `-wal`/`-shm` companions together into a
   timestamped, root-confined `runtime/catalog/quarantine/` entry;
3. build a new database at a temporary sibling path from validated canonical
   sources;
4. run schema, quick, full integrity, foreign-key, and parity checks;
5. seal the temporary database with the promotion protocol below so every
   committed frame is checkpointed into the main file;
6. atomically promote the sealed main file, then open the destination and
   establish a fresh WAL generation (including Windows-safe closed-handle
   behavior).

If rebuild cannot prove parity, retain the quarantine and use canonical file
readers. Never delete forensic files as part of an automatic failed rebuild.

### Sealed Promotion Protocol

Atomic replacement applies to one self-contained main database file, not to a
live three-file WAL unit. Before rebuild or restore promotion, the adapter holds
the maintenance lock, prevents new lease registration, proves that no live
connection lease remains, runs
`PRAGMA wal_checkpoint(TRUNCATE)`, and requires a non-busy result with every WAL
frame checkpointed. It then closes all handles and verifies that no non-empty
`-wal` remains. Only after that proof may the transient `-shm` be discarded and
the main file be flushed to durable storage and copied to the recovery backup;
the sealed staging main is then atomically renamed over the still-present live
main, so there is no promotion interval with a missing live catalog.
The containing directory is synchronized where the platform supports directory
flushes.

If checkpoint completion, handle closure, or the absence of pending WAL content
cannot be proven, promotion fails. The temporary main, `-wal`, and `-shm` files
remain together for diagnosis and canonical file fallback continues. A promoted
main file is reopened and validated before `journal_mode=WAL` is enabled for the
new live generation.

## Backup And Restore

Backups are recovery accelerators, not the only recovery source. The adapter
uses `VACUUM INTO` to a new temporary destination while the source connection is
open, validates the snapshot, flushes the snapshot and manifest to durable
storage, then atomically promotes them into the workspace's existing recovery
area and synchronizes the containing directory where supported. Copying only a
live main database file is forbidden because WAL content may not yet be
checkpointed.

A backup is required before destructive/multi-step migration and is available
through explicit maintenance commands. Existing retention rules may prune old
validated snapshots, but must not remove the only pre-operation recovery point
while that operation is active.

Restore never opens a backup in place. It copies or materializes it to a
temporary sibling, validates application id, supported version, migration
checksums, integrity, foreign keys, and canonical parity, seals it with the same
checkpoint protocol, then promotes the self-contained main file under the
maintenance lock. Restored projection rows never overwrite canonical files. If
parity is stale, reconciliation runs from files and the result is sealed again
before the catalog becomes eligible for reads.

## Security And Privacy Boundary

- Catalog and backup paths are root-confined and checked after path resolution.
- Files receive user-only permissions where the platform supports them.
- SQLite extensions are never enabled.
- SQL values are parameterized; schema identifiers are fixed in code.
- Raw logs, diffs, prompts, reviewer output bodies, secrets, and arbitrary
  project files are not copied into the catalog.
- Project-memory indexing is allowlisted, hash-bound, and separately scoped by
  T-1000-5.

## Benchmark Baseline And Adoption Gates

Performance evidence compares the existing canonical readers with the SQLite
query boundary on the same machine, Node runtime, Git revision, schema version,
fixture, and power state. The result records OS, CPU, storage type, Node and
embedded SQLite versions, database size, journal settings, process count, and
query plans.

Two deterministic, non-secret fixture tiers are required:

| Tier | Tasks | Lifecycle events | Review attempts/receipts | Purpose |
|---|---:|---:|---:|---|
| Typical | 50 | 5,000 | 250 | Interactive and small-project behavior |
| Stress | 1,000 | 100,000 | 5,000 | Scaling, cleanup, reporting, and rebuild behavior |

Measurements cover:

- task status and next-step hot lookup;
- task history and review/receipt lookup;
- dashboard/report aggregation;
- retention and cleanup selection;
- incremental ingestion after one canonical write;
- cold process startup and first query;
- complete rebuild and post-rebuild parity;
- forced file fallback for every adopted query.

Warm measurements use at least 10 discarded warmups and 30 recorded samples and
report p95, which is the acceptance metric below. Median is retained as an
additional diagnostic when the benchmark capture records it. Cold-process and
rebuild samples are reported separately.
No cross-machine absolute latency claim is valid.

Query adoption requires all of the following:

- exact result and ordering parity on both fixture tiers;
- no Typical-tier p95 regression greater than the larger of 10 percent or 5 ms;
- at least 30 percent lower Stress-tier p95 for each hot path moved to SQLite;
- incremental projection overhead no greater than the larger of 10 percent of
  the canonical write baseline or 5 ms at p95;
- deterministic rebuild, corruption fallback, concurrency, and migration tests;
- bounded lock behavior and a working canonical-file fallback.

Any path that misses its gate remains on the canonical reader. T-1000-4 records
the before/after evidence; T-1000-6 considered authority and rejected the
cutover because sustained reliability plus tested export, backup, restore,
downgrade, and rollback paths were not available.

The T-1000-4 local benchmark and the resulting adaptive adoption boundary are
recorded in [SQLite Query Adoption Evidence](https://github.com/Garda-Studio/garda-agent-orchestrator/blob/master/docs/database/sqlite-query-adoption-evidence.md).

## Authority Cutover Decision

SQLite remains a derived, workspace-local projection. No queue, lifecycle,
review-metadata, or project-memory domain moves to SQLite authority.

The pilot evidence does not justify a cutover:

- only the stress-tier bulk task-activity aggregate qualified for SQLite, with
  49.0 percent lower p95; task-queue lookup was materially slower through the
  routed SQLite path at both fixture tiers and stays on the file reader;
- current evidence covers focused validation and a local benchmark, not
  sustained reliability across releases, interrupted upgrades, and real
  workspace recovery cycles;
- rebuild promotion has an internal recovery copy and rollback path for the
  disposable projection, but there is no supported authoritative export,
  operator restore, downgrade, or authority rollback workflow;
- file fallback remains necessary for unavailable, stale, locked,
  incompatible, corrupt, or performance-unqualified catalog states.

The cutover may be reconsidered only after each proposed authoritative domain
has workload-specific parity and latency evidence, sustained operational
reliability, and deterministic export, backup, restore, downgrade, and rollback
tests. Until then, canonical files remain the recovery and trust boundary, and
SQLite-only completion, security, review, cleanup, or configuration decisions
remain prohibited.

## Staged Rollout

1. T-1000-2 builds the derived catalog without changing read authority.
2. T-1000-3 adds canonical-first ingestion, parity, repair, and rebuild.
3. T-1000-4 adopts only benchmark-qualified hot queries with file fallback.
4. T-1000-5 adds hash-bound project-memory search indexing.
5. T-1000-6 retains canonical-file authority because the cutover prerequisites
   are not satisfied.

## Primary References

- [Node.js 22.13 SQLite API](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html)
- [Current Node.js SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA reference](https://www.sqlite.org/pragma.html)
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)
- [SQLite backup API](https://www.sqlite.org/backup.html)
- [SQLite corruption guidance](https://www.sqlite.org/howtocorrupt.html)
- [SQLite network filesystem guidance](https://www.sqlite.org/useovernet.html)
