# Windows path volume consumers and CI fixtures

After the native ACL and helper startup repairs, full Windows Release exposed
nine residual Node22 failures and one shared Node24 fixture failure. The process
and ACL diagnoses remained successful. All nine Node22 scenarios were reproduced
on native Windows24 with an explicit path-stat/capability simulation before this
repair; this simulation is not native Node22 acceptance.

Lock heartbeats now obtain their original BigInt path identity through the
existing two-live-descriptor reconstruction. They keep exact volume, inode,
link count, mode and nanosecond birth time checks before mutating the same open
owner object. A classified identity-change error preserves an uncertain owner
without writing; unrelated I/O and partial/no-progress write errors still surface.

Commit-permission audit verification reconstructs the final path identity while
the original audit descriptor stays open. Audit bytes, bounded read windows,
metadata comparisons, HMAC domains, keys, operator receipts and workspace identity
payloads are unchanged. This repairs authenticated migration-chain verification;
it cannot grant or renew permission.

Snapshot tests separate identity acquisitions from payload acquisitions. Identity
helpers remain real and fail the probe if they attempt synchronous payload reads.
The single payload capture, short reads and fresh-invocation assertions remain.
A zero Windows O_NONBLOCK constant means unavailable; the fixture now verifies
that fallback, while retaining the positive simulated/native capability branch.
Real POSIX FIFO rejection coverage is unchanged.

The CI preparation fixture requires the exact diagnostic-only condition, the
default full Release mode and the mandatory full validation command. Negative
controls still reject disabled/reordered preparation and now reject replacing
the legitimate validation predicate with false. Workflow code and source pins
are unchanged.
