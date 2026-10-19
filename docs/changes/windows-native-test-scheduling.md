# Windows native test scheduling

Full Windows Release on 51a35208 passed the nine repaired Node22 scenarios,
but concurrent test shards exposed cold native PowerShell startup timeouts.
Node24's real module-authority probe exceeded its unchanged 2500 ms budget;
Node22's first timeline appends could not establish native DACL authority,
then later appends succeeded. Both runtime failures remain recorded.

The native module, native file-identity and lifecycle-event suites now use
the existing serial scheduling lane after parallel shards finish. Their real
PowerShell, SID/DACL, immutable file identity and multi-process append checks
still run. Production source, authentication, timeout budgets, process handling
and coverage requirements are unchanged. The wrapper regression measures actual
overlap and requires these suites to execute once without parallel shard peers.

The active release-intent fixture explicitly sets a recent past mtime within
the existing three-second lifetime. This avoids accidentally constructing a
future-dated intent through native filesystem clock precision. Its 80 ms waiter
timeout and single metadata-read assertions remain; separate expired/future
intent rejection controls and all production TTL/skew guards are unchanged.

Local Windows24 qualification does not replace hosted Windows22 acceptance.
Only the two failed full Windows Release variants may be retried after review,
an exact commit and source audit. The other twenty successful variants remain
accepted without repetition.
