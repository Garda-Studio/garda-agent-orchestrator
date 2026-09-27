# Change Log

Current baseline:

- Shared update availability: task entry and UI startup check trusted npm metadata in the background using one daily local cache. Concurrent checks coalesce and failures are throttled. Terminal closeout adds an English version notice and the existing apply command after the canonical report; the UI adds a manual refresh and complete status/accessibility translations for all 21 locales. `GARDA_UPDATE_CHECK=0` disables automatic checks. No package acquisition or automatic update is performed.
- Update availability refinement: a shared renewable scheduling lease bounds detached task-boundary launches without trusting recycled process IDs; schedulers tolerate launch-lock contention, and queued manual refreshes survive caller deadlines. Closeout reads the local cache asynchronously alongside the navigator. Persisted pending claims coalesce metadata launches, and capped source history preserves daily throttling on eviction. Windows environment-key casing participates in source binding. Production npm, task-boundary and browser-startup regressions cover the complete notification path.
- Confirmed work alongside unfinished tasks: `next-step` reports active owners and requests explicit consent; repeated `--allow-active-task` options bind approval to the current task and owner artifacts. Later gates reuse it, and re-entry preserves the original dirty-workspace baseline while requiring fresh consent.
- runtime is Node-only
- lifecycle commands and gates run through `bin/garda.js`
- template content no longer ships shell lifecycle or gate entrypoints
- `record-review-result` can ingest reviewer output from stdin, but still persists the same canonical raw `*-review-output.md` artifact before verdict, routing, and receipt validation so direct ingest cannot bypass the review audit path
- strict decomposition `split-required` routing keeps parents non-executable until linked parent-derived strict child rows match the recorded decision artifact
- T-974-1: evidence-only missing-focused-test findings now accept only the exact changed test named by the canonical marker and restart review only after current task-owned command, artifact, output hash/size, chronology, and path validation; no fake source edit is required
- T-976: schema-version-3 reviewer contexts bind a deterministic full-scope coverage ledger; receipt recording rejects omitted, duplicate, generic, or unresolved coverage evidence, and task audit surfaces coverage completeness without requiring a minimum finding count

For source-level release notes, see the repository root `CHANGELOG.md`.
