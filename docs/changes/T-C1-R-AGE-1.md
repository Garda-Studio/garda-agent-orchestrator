# Retention timestamp observation precision

Retention preview compares the artifact's newest timestamp at whole-millisecond
precision, matching `Date.now()` and the existing public
`latest_artifact_mtime_ms` field. Fractional filesystem timestamp precision could
previously make a freshly written file appear a fraction of a millisecond ahead
of the observed clock, producing `age_days=-1` instead of zero.

Only the timestamp comparison precision changes. Retention thresholds, native
health/ledger requirements and deletion selection remain intact. Artifacts ahead
of the observed whole millisecond still have a negative age and remain ineligible,
including when the configured retention threshold is zero days. At a day boundary,
age calculation now agrees with the whole-millisecond timestamp reported by the
same preview. This can move a threshold comparison by less than one millisecond.

The focused regressions create real fractional filesystem timestamps and mock
only the observed clock inside temporary test fixtures. They cover fresh zero age,
future artifact protection and a day-boundary comparison. The unchanged existing
compact-only inventory test first exposed the bug in the required Linux suite.
Current executed coverage is Linux; native Windows coverage is not claimed.

The affected daily-maintenance fixture now creates its ordinary bundle `VERSION`,
matching the established cleanup fixtures. Three unchanged integration checks
otherwise failed because cleanup correctly rejected the incomplete fixture bundle.
All selection/deletion assertions and the production containment guard are retained.

This is a bounded blocker repair for disposable preview work. It does not complete
that original task, migrate raw evidence, remove payloads or change workflow grants.
