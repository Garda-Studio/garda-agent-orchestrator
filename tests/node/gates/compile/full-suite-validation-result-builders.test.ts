import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDocsOnlyNotRequiredResult,
    buildFullSuiteValidationOutputTelemetry,
    buildSkippedResult,
    buildValidationResult,
    detectOutOfScopeFailures,
    formatFullSuiteValidationResult,
    isFullSuiteNotRequiredForDocsOnlyScope,
    loadFullSuiteValidationConfig} from '../../../../src/gates/full-suite/full-suite-validation';
import { shouldOmitSuccessfulFullSuiteOutput } from '../../../../src/cli/commands/gate-flows/full-suite/full-suite-validation-flow';
import { countTextChars } from '../../../../src/gate-runtime/text-utils';





describe('gates/full-suite-validation', () => {
    describe('detectOutOfScopeFailures', () => {
        it('returns true when failure references unrelated file', () => {
            assert.equal(
                detectOutOfScopeFailures(['error at src/unrelated/bar.ts:5 something'], ['src/gates/foo.ts']),
                true
            );
        });

        it('returns false when failure matches changed file', () => {
            assert.equal(
                detectOutOfScopeFailures(['error at src/gates/foo.ts:10'], ['src/gates/foo.ts']),
                false
            );
        });
    });

    describe('result builders', () => {
        it('omits raw output only for clean PASSED full-suite results', () => {
            assert.equal(shouldOmitSuccessfulFullSuiteOutput({
                status: 'PASSED',
                warnings: []
            }), true);
            assert.equal(shouldOmitSuccessfulFullSuiteOutput({
                status: 'PASSED',
                warnings: ['warning']
            }), false);
            assert.equal(shouldOmitSuccessfulFullSuiteOutput({
                status: 'WARNED',
                warnings: []
            }), false);
        });

        it('buildSkippedResult keeps cycle binding', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildSkippedResult(config, {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: '2026-04-20T12:00:00.000Z'
            });
            assert.equal(result.status, 'SKIPPED');
            assert.equal(result.cycle_binding?.task_id, 'T-123');
        });

        it('detects docs-only scopes where full-suite validation is not required', () => {
            assert.equal(isFullSuiteNotRequiredForDocsOnlyScope({
                scope_category: 'docs-only',
                changed_files: ['docs/runbook.md'],
                triggers: {
                    runtime_code_changed: false,
                    test: false
                },
                required_reviews: {}
            }), true);

            assert.equal(isFullSuiteNotRequiredForDocsOnlyScope({
                scope_category: 'docs-only',
                changed_files: ['tests/README.md'],
                triggers: {
                    test: true
                },
                required_reviews: { test: true }
            }), false);

            assert.equal(isFullSuiteNotRequiredForDocsOnlyScope({
                scope_category: 'docs-only',
                changed_files: ['docs/security.md'],
                triggers: {
                    runtime_code_changed: false,
                    security: true,
                    test: false
                },
                required_reviews: { security: true }
            }), true);
        });

        it('buildDocsOnlyNotRequiredResult records an explicit skip reason', () => {
            const config = { ...loadFullSuiteValidationConfig('/nonexistent'), enabled: true, command: 'npm test' };
            const result = buildDocsOnlyNotRequiredResult(config, {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });

            assert.equal(result.status, 'SKIPPED');
            assert.equal(result.enabled, true);
            assert.equal(result.required, false);
            assert.equal(result.skip_reason, 'DOCS_ONLY_SCOPE_NOT_REQUIRED');
            assert.ok(formatFullSuiteValidationResult(result).includes('SkipReason: DOCS_ONLY_SCOPE_NOT_REQUIRED'));
        });

        it('buildValidationResult returns WARNED for AUDIT_AND_WARN out-of-scope failures', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildValidationResult(
                { ...config, enabled: true, out_of_scope_failure_policy: 'AUDIT_AND_WARN' },
                1,
                false,
                ['FAIL at src/unrelated.ts:10 something'],
                null,
                ['src/changed.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );
            assert.equal(result.status, 'WARNED');
            assert.equal(result.out_of_scope_audit_verdict, 'WARNED');
            assert.equal(result.violations.length, 0);
            assert.ok(result.warnings.length > 0);
        });

        it('buildValidationResult records out-of-scope harness timeouts as WARNED', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildValidationResult(
                { ...config, enabled: true, out_of_scope_failure_policy: 'AUDIT_AND_BLOCK' },
                1,
                true,
                [
                    'not ok 1 - failed at tests/node/cli/commands/gates.test.ts:10',
                    'WARNING: task-event append failed: Timed out acquiring file lock: runtime/task-events/.T-001.lock;',
                    'Process timed out after 600000 ms.'
                ],
                null,
                ['src/gates/full-suite-validation.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );

            assert.equal(result.status, 'WARNED');
            assert.equal(result.out_of_scope_audit_verdict, 'WARNED');
            assert.equal(result.harness_failure_detected, true);
            assert.equal(result.harness_failure_audit_verdict, 'WARNED');
            assert.equal(result.violations.length, 0);
            assert.ok(result.warnings.some((line) => line.includes('out-of-scope test harness or lock surface')));
        });

        it('buildValidationResult keeps in-scope harness timeouts blocking', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildValidationResult(
                { ...config, enabled: true, out_of_scope_failure_policy: 'AUDIT_AND_BLOCK' },
                1,
                true,
                [
                    'not ok 1 - failed at tests/node/cli/commands/gates.test.ts:10',
                    'WARNING: task-event append failed: Timed out acquiring file lock: runtime/task-events/.T-001.lock;',
                    'Process timed out after 600000 ms.'
                ],
                null,
                ['tests/node/cli/commands/gates.test.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );

            assert.equal(result.status, 'FAILED');
            assert.equal(result.harness_failure_detected, false);
            assert.ok(result.violations.some((line) => line.includes('timed out')));
        });

        it('buildValidationResult records in-scope timeouts as WARNED when timeout blocker is disabled', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildValidationResult(
                { ...config, enabled: true, timeout_blocker: false },
                1,
                true,
                [
                    'not ok 1 - failed at tests/node/cli/commands/gates.test.ts:10',
                    'Process timed out after 600000 ms.'
                ],
                null,
                ['tests/node/cli/commands/gates.test.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );

            assert.equal(result.status, 'WARNED');
            assert.equal(result.violations.length, 0);
            assert.ok(result.warnings.some((line) => line.includes('timeout_blocker=false')));
        });

        it('formatFullSuiteValidationResult includes cycle binding', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildSkippedResult(config, {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);
            assert.ok(text.includes('FULL_SUITE_VALIDATION_SKIPPED'));
            assert.ok(text.includes('CycleBinding: task_id=T-123;'));
        });

        it('formatFullSuiteValidationResult labels optimized sharded full-suite commands as mandatory evidence', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run test:sharded'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('PerformanceMode: mode=optimized_sharded; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="npm run test:sharded"'));

            assert.doesNotMatch(text, /fallback_command=/u);
        });

        it('formatFullSuiteValidationResult includes duration history comparison evidence', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run test:sharded'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            result.duration_ms = 90_000;
            result.duration_history_comparison = {
                history_path: 'runtime/metrics/full-suite-validation-duration-history.json',
                previous_sample_count: 3,
                previous_average_duration_ms: 100_000,
                previous_best_duration_ms: 80_000,
                previous_latest_duration_ms: 95_000,
                current_duration_ms: 90_000,
                delta_vs_previous_average_ms: 10_000,
                delta_vs_previous_best_ms: -10_000,
                delta_vs_previous_latest_ms: 5_000
            };

            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('DurationHistoryComparison: current_duration_ms=90000; previous_sample_count=3; previous_average_duration_ms=100000; delta_vs_previous_average_ms=10000;'));
            assert.ok(text.includes('delta_vs_previous_best_ms=-10000; previous_latest_duration_ms=95000; delta_vs_previous_latest_ms=5000;'));
        });

        it('formatFullSuiteValidationResult surfaces top failure diagnostics', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run test:sharded'
            };
            const result = {
                ...buildValidationResult(config, 1, false, ['not ok 1 - failing test'], null, ['src/changed.ts'], {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }),
                failure_evidence: {
                    schema_version: 1 as const,
                    task_id: 'T-123',
                    status: 'FAILED' as const,
                    command: 'npm run test:sharded',
                    exit_code: 1,
                    timed_out: false,
                    output_artifact_path: 'runtime/reviews/T-123-full-suite-output.log',
                    summary_artifact_path: 'runtime/reviews/T-123-full-suite-failure-evidence/summary.json',
                    copied_logs: [],
                    copied_logs_count: 0,
                    max_copied_logs: 6,
                    max_log_chars: 200000,
                    failure_kind: 'assertion' as const,
                    top_failures: [{
                        kind: 'assertion' as const,
                        summary: 'AssertionError [ERR_ASSERTION]: expected true',
                        source: 'copied_log' as const,
                        source_path: '.node-build/test-shard-logs/run-1/shard-01-of-02.log',
                        artifact_path: 'runtime/reviews/T-123-full-suite-failure-evidence/shard-log-01.log',
                        test_name: 'fails usefully',
                        file_path: 'tests/node/failing.test.ts',
                        line: 12
                    }],
                    failure_chunks: [],
                    compact_summary: [],
                    last_output_lines: [],
                    shard_diagnostics: [],
                    timeout_diagnostics: []
                }
            };
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('FailureEvidence: summary=runtime/reviews/T-123-full-suite-failure-evidence/summary.json; copied_logs=0; kind=assertion; top_failures=1'));
            assert.ok(text.includes('TopFailures:'));
            assert.ok(text.includes('kind=assertion; test=fails usefully; file=tests/node/failing.test.ts:12; artifact=runtime/reviews/T-123-full-suite-failure-evidence/shard-log-01.log; source=.node-build/test-shard-logs/run-1/shard-01-of-02.log; summary=AssertionError [ERR_ASSERTION]: expected true'));
        });

        it('formatFullSuiteValidationResult labels reuse-aware full-suite commands as mandatory evidence', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run build-prep && npm test'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('PerformanceMode: mode=optimized_reuse_aware; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="npm run build-prep && npm test"'));

            assert.doesNotMatch(text, /fallback_command=/u);
        });

        it('formatFullSuiteValidationResult labels sharded reuse-aware full-suite commands as mandatory evidence', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run build-prep && npm run test:sharded'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('PerformanceMode: mode=optimized_sharded_reuse_aware; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="npm run build-prep && npm run test:sharded"'));

            assert.doesNotMatch(text, /fallback_command=/u);
        });

        it('formatFullSuiteValidationResult surfaces slowest known tests from sharded runner output', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run test:sharded',
                green_summary_max_lines: 7
            };
            const result = buildValidationResult(config, 0, false, [
                'NODE_FOUNDATION_TEST_SHARD_PLAN source=duration duration_known=2/2',
                'NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=600000 heartbeat_ms=60000 concurrency=2 node_test_concurrency=inherit grouped_shards=12 max_grouped_files=32 isolated_files=2 serial_files=6',
                'NODE_FOUNDATION_TEST_SHARD_COMPARISON source=pre_run_telemetry current_threshold_ms=60000 baseline_threshold_ms=60000 current_estimated_wall_ms=541552 baseline_estimated_wall_ms=541552 estimated_wall_delta_ms=0 current_isolated_files=2 baseline_isolated_files=2 current_scheduled_shards=14 baseline_scheduled_shards=14 current_grouped_shards=12 baseline_grouped_shards=12 max_worker_processes=2 baseline_max_worker_processes=2 serial_files=6 telemetry_known=120/376',
                'NODE_FOUNDATION_TEST_SLOWEST tests/node/slow-a.test.ts duration_ms=42000',
                'NODE_FOUNDATION_TEST_SLOWEST tests/node/slow-b.test.ts duration_ms=39000',
                '# tests 20',
                '# pass 20',
                '# fail 0',
                '# duration_ms 120000',
                'NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=600000 heartbeat_ms=60000 concurrency=1',
                'NODE_FOUNDATION_TEST_SHARD_COMPARISON current_threshold_ms=60000 baseline_threshold_ms=60000 current_estimated_wall_ms=0 baseline_estimated_wall_ms=0 estimated_wall_delta_ms=0 current_isolated_files=0 baseline_isolated_files=0 current_scheduled_shards=9 baseline_scheduled_shards=9 current_grouped_shards=9 baseline_grouped_shards=9 max_worker_processes=2 baseline_max_worker_processes=2 serial_files=0 telemetry_known=0/262',
                'NODE_FOUNDATION_TEST_SHARD_COMPARISON source=post_run_telemetry current_threshold_ms=60000 baseline_threshold_ms=60000 current_estimated_wall_ms=512000 baseline_estimated_wall_ms=512000 estimated_wall_delta_ms=0 current_isolated_files=2 baseline_isolated_files=2 current_scheduled_shards=14 baseline_scheduled_shards=14 current_grouped_shards=12 baseline_grouped_shards=12 max_worker_processes=2 baseline_max_worker_processes=2 serial_files=6 telemetry_known=132/376'
            ], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('NODE_FOUNDATION_TEST_SLOWEST tests/node/slow-a.test.ts duration_ms=42000'));
            assert.ok(text.includes('NODE_FOUNDATION_TEST_SLOWEST tests/node/slow-b.test.ts duration_ms=39000'));
            assert.ok(text.includes('NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=600000 heartbeat_ms=60000 concurrency=2'));
            assert.ok(text.includes('NODE_FOUNDATION_TEST_SHARD_COMPARISON source=post_run_telemetry current_threshold_ms=60000 baseline_threshold_ms=60000'));
            assert.ok(text.includes('estimated_wall_delta_ms=0'));
            assert.ok(text.includes('telemetry_known=132/376'));
            assert.ok(!text.includes('telemetry_known=0/262'));
            assert.ok(!text.includes('telemetry_known=120/376'));
        });

        it('formatFullSuiteValidationResult redacts secrets from configured command output', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm test -- ACCESS_TOKEN=full-suite-command-secret'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(!text.includes('full-suite-command-secret'));
            assert.ok(text.includes('Command: npm test -- ACCESS_TOKEN=<redacted>'));
        });

        it('buildFullSuiteValidationOutputTelemetry measures savings against compacted visible output', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const rawOutputLines = [
                'detail line 1 with verbose raw output that should not survive compaction',
                'detail line 2 with verbose raw output that should not survive compaction',
                'detail line 3 with verbose raw output that should not survive compaction',
                'detail line 4 with verbose raw output that should not survive compaction',
                'detail line 5 with verbose raw output that should not survive compaction',
                'detail line 6 with verbose raw output that should not survive compaction',
                'detail line 7 with verbose raw output that should not survive compaction',
                'detail line 8 with verbose raw output that should not survive compaction',
                'detail line 9 with verbose raw output that should not survive compaction',
                'detail line 10 with verbose raw output that should not survive compaction',
                'detail line 11 with verbose raw output that should not survive compaction',
                'detail line 12 with verbose raw output that should not survive compaction',
                '# tests 20',
                '# pass 20',
                '# fail 0',
                '# duration_ms 1234'
            ];
            const result = buildValidationResult(
                { ...config, enabled: true, command: 'npm test' },
                0,
                false,
                rawOutputLines,
                'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-output.log',
                ['src/changed.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );
            const telemetry = buildFullSuiteValidationOutputTelemetry(
                rawOutputLines,
                result
            );

            assert.ok(telemetry);
            assert.equal((telemetry as Record<string, unknown>).filter_mode, 'full_suite_validation_compaction');
            assert.ok(Number((telemetry as Record<string, unknown>).estimated_saved_chars) > 0);
            assert.ok(Number((telemetry as Record<string, unknown>).estimated_saved_tokens) > 0);

            const formatted = formatFullSuiteValidationResult({
                ...result,
                output_telemetry: telemetry
            });
            assert.match(formatted, /\[full-suite-validation\] suppressed ~\d+ chars/);
            assert.equal(
                Number((telemetry as Record<string, unknown>).filtered_char_count),
                countTextChars(formatted.split('\n'))
            );
        });

        it('buildFullSuiteValidationOutputTelemetry measures savings for failure_chunks output', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const rawOutputLines = [
                'not ok 1 - full suite telemetry branch failed at src/changed.ts:5',
                ...Array.from(
                    { length: 60 },
                    (_, index) => `verbose failure detail line ${index + 1} that should be compacted away`
                )
            ];
            const result = buildValidationResult(
                { ...config, enabled: true, command: 'npm test', red_failure_chunk_lines: 10 },
                1,
                false,
                rawOutputLines,
                'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-output.log',
                ['src/changed.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );
            const telemetry = buildFullSuiteValidationOutputTelemetry(rawOutputLines, result);

            assert.equal(result.status, 'FAILED');
            assert.ok(result.failure_chunks.length > 0);
            assert.ok(telemetry);
            assert.equal((telemetry as Record<string, unknown>).parser_strategy, 'failure_chunks');
            assert.ok(Number((telemetry as Record<string, unknown>).estimated_saved_chars) > 0);
            assert.ok(Number((telemetry as Record<string, unknown>).estimated_saved_tokens) > 0);
            const formatted = formatFullSuiteValidationResult({
                ...result,
                output_telemetry: telemetry
            });
            assert.equal(
                Number((telemetry as Record<string, unknown>).filtered_char_count),
                countTextChars(formatted.split('\n'))
            );
        });
    });
});
