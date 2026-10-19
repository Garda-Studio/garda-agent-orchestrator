# Windows native helper timeout recovery

The exact Windows22 diagnosis reproduced a cold native helper timeout at
2512 ms. Its recorded root creation time was inside the existing admitted
window, so identity rejection and PATH substitution were not the cause.
The review publication case passed the same native diagnosis in 1020 ms.

Asynchronous native termination may retry one timed-out helper within the
existing 6000 ms total shutdown budget. Each command remains capped at 2500 ms.
Both attempts use the same protected executable, encoded native implementation,
environment and authenticated target creation windows. Identity rejection,
ordinary command errors and output-buffer failures do not retry. There is no
PID-only fallback. Synchronous exit cleanup and its 2500 ms budget are unchanged.

Regression controls distinguish timeout recovery from identity rejection and
buffer overflow, require identical targets/arguments and prohibit bare PID kills.

The review publication fixture signals worker readiness before timing the read
barrier. It deliberately delays worker exit after successful publication. The
existing two-second assertion measures the barrier, including concurrent write
completion and invalidation, while the test still awaits worker exit separately.
This reproduces and removes the false inclusion of worker shutdown/coverage
reporting in the lock metric. Production review locking is unchanged.

The diagnostic entry now selects only the still-failed shell cleanup case;
the successful native review diagnosis is retained. Full Windows22/24 Release
acceptance remains required after review, an exact commit and source audit.
