# Node test wall time baseline

The tracked schema-2 baseline in `config/node-foundation-test-wall-time-baseline.json` comes from a complete `npm run quality` at committed HEAD `503c344bbc9229e53a96db945324348191b8039d`. It was run in an isolated local clone on 2026-09-23, after `npm run build`, `setup --no-prompt`, and restoration of the clone's original `.gitignore`. The first comparison used the same duration-telemetry input snapshot (SHA-256 `707be61506b6fb5eec5857d3211ff611c9757e8cee00e10c58b84e238a7fc0c8`). Logs are retained locally under `garda-agent-orchestrator/runtime/manual-validation/` and are not committed.

The baseline `T-035-1-F1-baseline-quality-env-passed.log` has SHA-256 `fe64f2a0c4198fc77c3d058fbdd40b511d41e42d80920bf80cb4f7288cf7cca3`. The command exited 0: 43 shards, 9,754 tests, 9,707 passed, 47 skipped, 0 failed, 535 selected Node test files. Scheduler `observed_wall_ms` was 2,074,790 (34m 34.790s). The environment fingerprint was `8ea2ea743b238874b12631fd115cbf35499a00d8b87a5ce262cc230b431039c3`; average host CPU busy was 28.5%.

| Candidate log | SHA-256 | Tests (passed/skipped/failed) | Scheduler wall time | Host CPU busy |
| --- | --- | --- | --- | --- |
| `T-035-1-F1-2-candidate-sourcebound-1.log` | `1d829fd2daeb28d2ed043ef43e292fa72b4f5282e84cd680d089d9844a3aec85` | Full quality, exit 0 | 1,887,713 ms | 46.2% |
| `T-035-1-F1-2-candidate-sourcebound-2.log` | `a516bed9f54f92399bdca5b5e9a15c7e46bb07545ae8aa5da00bb768bcddac41` | Full quality, exit 0 | 1,960,689 ms | 45.0% |

Both tracked candidate commands exited 0 across 43 shards and 536 selected files. Their environment fingerprint matched the baseline. They ran from the same scheduler source at commit `f432a9712a7d6710b47e43e7cdc1195f2fadc6f6`, with `scripts/node-foundation/test.ts` SHA-256 `101739077e36142492197a18c1f993ab254a141fdcd55d25334d6afdc7886451` recorded before and after each run. The comparator uses the slower candidate: 114,101 ms faster than the baseline, ratio 0.95 when rounded to two decimals, within the tracked 0.95 limit (the unrounded ratio is approximately 0.945). The candidate inventory includes one more selected test file than the baseline.

Capture each complete quality run without an external timeout, from a prepared checkout, using the tracked command:

```sh
node scripts/node-foundation/check-test-wall-time-baseline.cjs capture <checkout> <new-log-path> <dependency-root>
```

The baseline evidence was captured with the local `quality-environment-runner.cjs` under the ignored runtime directory. The tracked `capture` mode preserves its environment fingerprint algorithm and adds candidate source provenance. It records the full `npm run quality` output and appends one `NODE_FOUNDATION_QUALITY_ENVIRONMENT` marker with the command exit code, run timestamps, a fingerprint of OS, Node, CPU, memory and host, aggregate host CPU busy percentage, and SHA-256 of the measured scheduler source. It checks that source again after the run and refuses to overwrite an existing log. The marker contains a hash of the host identity, not its raw name.

Compare the three retained logs with:

```sh
node scripts/node-foundation/check-test-wall-time-baseline.cjs config/node-foundation-test-wall-time-baseline.json path/to/baseline-quality.log path/to/candidate-quality-1.log path/to/candidate-quality-2.log
```

The comparator checks all three log hashes and the candidate scheduler source hash against the tracked config; baseline measurement; full `quality` and `test` banners; a top-level full-selection observed run followed by `NODE_FOUNDATION_TEST_OK`; three distinct shard run directories and sequential capture times; matching hardware/runtime fingerprints; and candidate host CPU busy no more than 10 percentage points below baseline. The top-level shard marker must cover at least 535 files and duration telemetry for at least 500 files. It rejects a top-level partial-selection marker while allowing markers emitted by nested test fixtures. Both candidates must pass the 0.95 wall-time ratio; the output reports the slower one. A 64 MiB per-log limit bounds parsing.

The fingerprint and CPU guard make the measurements more comparable; aggregate CPU busy does not identify every competing process or remove all load variation. The candidate source hash identifies the scheduler implementation; it does not authenticate every other file in the checkout. The measured threshold is evidence for these complete runs, not a hardware-controlled causal estimate. Keep the full exit codes, test totals, source commit, telemetry snapshot, and log hashes with any rebaseline. The earlier 2026-09-21 log (`observed_wall_ms=1652561`) and the two `T-035-1-F1-candidate-quality-env-*.log` runs lacked candidate source markers; they remain historical context, not the tracked comparison candidates.
