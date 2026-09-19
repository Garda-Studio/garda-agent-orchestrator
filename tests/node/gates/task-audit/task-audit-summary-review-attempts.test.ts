import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewAttemptSummary } from '../../../../src/gates/task-audit/task-audit-summary-review-attempts';
import { normalizeKnownReviewType } from '../../../../src/gates/task-audit/task-audit-summary-review-common';
import {
    loadIndex,
    resolveIndexPath,
    writeIndex
} from '../../../../src/gate-runtime/reviews-index';

import {
    fs,
    path,
    createHash,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    computeFileSha256,
    writePreflight,
    writeArtifact,
    writeIntegrityEventSequence,
    appendIntegrityEvent,
    buildReviewRecordedTelemetryDetails,
    writeWorkflowConfig,
    makeDelegatedRouting,
    makeTempDir} from './task-audit-summary-fixtures';


describe('gates/task-audit-summary', () => {
    let tmpDir: string;
    let eventsDir: string;
    let reviewsDir: string;
    const TASK_ID = 'T-AUDIT-1';

    beforeEach(() => {
        tmpDir = makeTempDir();
        eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        writeWorkflowConfig(tmpDir, false);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('buildTaskAuditSummary', () => {
        it('uses a precomputed effective lane set without re-resolving the preflight snapshot', () => {
            const knownReviewTypes = new Set(['architecture-boundary']);
            const malformedPreflight = {
                required_reviews: { 'architecture-boundary': true },
                effective_review_snapshot: { schema_version: 1 }
            };

            assert.equal(
                normalizeKnownReviewType(
                    'architecture-boundary',
                    malformedPreflight,
                    knownReviewTypes
                ),
                'architecture-boundary'
            );
        });

        it('summarizes review attempts from recorded snapshot telemetry', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: false, test: false }
            });

            const codePassContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codePassContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer-pass')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(codePassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer-pass',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
            });

            const codeFailContent = '# Code Review\n\n## Verdict\nREVIEW FAILED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codeFailContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer-fail')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(codeFailContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer-fail',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
            });

            const testPassContent = '# Test Review\n\n## Verdict\nTEST REVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-test.md', testPassContent);
            writeArtifact(reviewsDir, TASK_ID, '-test-review-context.json', {
                task_id: TASK_ID,
                review_type: 'test',
                reviewer_routing: makeDelegatedRouting('agent:test-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-test-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(testPassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:test-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED',
                reused_existing_review: true
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'test')
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.total_attempts, 2);
            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 2,
                    pass_count: 1,
                    fail_count: 1,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }
            ]);
            const expectedLine = 'Review attempts: total=2; code(pass=1, fail=1, reused=0, missing/invalid=0)';
            assert.equal(result.review_attempt_summary?.visible_summary_line, expectedLine);
            assert.equal(result.final_closeout.review_attempt_summary?.total_attempts, 2);
            assert.ok(formatTaskAuditSummaryText(result).includes(expectedLine));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes(expectedLine));
        });

        it('indexes receipt snapshots once and caches immutable validation across timeline and fallback discovery', () => {
            const codePassContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codePassContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                review_artifact_sha256: createHash('sha256').update(codePassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:indexed-code-reviewer',
                trust_level: 'INDEPENDENT_AUDITED'
            });
            const details = buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
            for (let index = 0; index < 500; index += 1) {
                fs.writeFileSync(
                    path.join(reviewsDir, `T-UNRELATED-${index}-preflight.json`),
                    '{"unrelated":true}\n',
                    'utf8'
                );
            }

            const fsModule = require('node:fs') as typeof fs;
            const originalReaddirSync = fsModule.readdirSync;
            const originalOpenSync = fsModule.openSync;
            let reviewDirectoryReads = 0;
            let immutableSnapshotReads = 0;
            fsModule.readdirSync = ((targetPath: fs.PathLike, options?: unknown) => {
                if (path.resolve(String(targetPath)) === path.resolve(reviewsDir)) {
                    reviewDirectoryReads += 1;
                }
                return originalReaddirSync(targetPath, options as never);
            }) as typeof fsModule.readdirSync;
            fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
                if (
                    path.resolve(String(targetPath)).startsWith(`${path.resolve(reviewsDir)}${path.sep}`)
                    && /-(?:receipt|artifact)-[0-9a-f]{64}\.(?:json|md)$/u.test(path.basename(String(targetPath)))
                ) {
                    immutableSnapshotReads += 1;
                }
                return originalOpenSync(targetPath, flags, mode);
            }) as typeof fsModule.openSync;

            try {
                const summary = buildReviewAttemptSummary({
                    reviewsRoot: reviewsDir,
                    taskId: TASK_ID,
                    timelineEvents: [
                        { event_type: 'REVIEW_RECORDED', details },
                        { event_type: 'REVIEW_RECORDED', details }
                    ]
                });

                assert.equal(summary?.total_attempts, 1);
                assert.equal(reviewDirectoryReads, 1);
                assert.equal(immutableSnapshotReads, 2);
            } finally {
                fsModule.readdirSync = originalReaddirSync;
                fsModule.openSync = originalOpenSync;
            }
        });

        it('fails closed when indexed immutable snapshot metadata diverges from canonical evidence', () => {
            const codePassContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codePassContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                review_artifact_sha256: createHash('sha256').update(codePassContent, 'utf8').digest('hex')
            });
            const details = buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
            const timelineEvents = [{ event_type: 'REVIEW_RECORDED', details }];

            const initial = buildReviewAttemptSummary({ reviewsRoot: reviewsDir, taskId: TASK_ID, timelineEvents });
            assert.equal(initial?.review_types[0]?.pass_count, 1);

            const loaded = loadIndex(reviewsDir).index;
            const receiptSnapshotName = path.basename(String(details.receipt_snapshot_path));
            const receiptEntry = loaded.entries.find((entry) => entry.fileName === receiptSnapshotName);
            assert.ok(receiptEntry);
            receiptEntry.sizeBytes += 1;
            writeIndex(resolveIndexPath(reviewsDir), loaded);

            const divergent = buildReviewAttemptSummary({ reviewsRoot: reviewsDir, taskId: TASK_ID, timelineEvents });
            assert.deepEqual(divergent?.review_types, [{
                review_type: 'code',
                total_attempts: 1,
                pass_count: 0,
                fail_count: 0,
                reused_count: 0,
                missing_or_invalid_count: 1
            }]);
        });

        it('classifies findings-json remediation attempts from structured receipt evidence without prose verdicts', () => {
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const reviewContextPath = path.join(reviewsDir, `${TASK_ID}-code-review-context.json`);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:structured-reviewer')
            });

            const recordStructuredAttempt = (verdict: 'fail_for_fix_now' | 'pass_no_findings'): void => {
                const content = `${JSON.stringify({ structured_review: true, disposition: verdict })}\n`;
                writeArtifact(reviewsDir, TASK_ID, '-code.md', content);
                writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                    schema_version: 2,
                    task_id: TASK_ID,
                    review_type: 'code',
                    preflight_sha256: null,
                    review_context_sha256: computeFileSha256(reviewContextPath),
                    review_artifact_sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_identity: 'agent:structured-reviewer',
                    reviewer_fallback_reason: null,
                    trust_level: 'INDEPENDENT_AUDITED',
                    review_output_format: 'findings_json',
                    review_findings_validation: {
                        status: 'accepted',
                        accepted: true
                    },
                    review_findings_disposition: {
                        verdict
                    }
                });
                appendIntegrityEvent(eventsDir, TASK_ID, {
                    event_type: 'REVIEW_RECORDED',
                    details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
                });
            };

            recordStructuredAttempt('fail_for_fix_now');
            recordStructuredAttempt('pass_no_findings');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.total_attempts, 2);
            assert.deepEqual(result.review_attempt_summary?.review_types, [{
                review_type: 'code',
                total_attempts: 2,
                pass_count: 1,
                fail_count: 1,
                reused_count: 0,
                missing_or_invalid_count: 0
            }]);
        });

        it('dedupes duplicate materialization of one fresh reviewer invocation', () => {
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const content = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            const reviewContextPath = path.join(reviewsDir, `${TASK_ID}-code-review-context.json`);
            writeArtifact(reviewsDir, TASK_ID, '-code.md', content);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:one-invocation')
            });
            const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
            const receipt = {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(reviewContextPath),
                review_artifact_sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:one-invocation',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED',
                reviewer_provenance: { event_sha256: 'a'.repeat(64) },
                recorded_at_utc: '2026-07-22T00:00:01.000Z'
            };
            fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
            });
            receipt.recorded_at_utc = '2026-07-22T00:00:02.000Z';
            fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.total_attempts, 1);
            assert.equal(result.review_attempt_summary?.review_types[0].total_attempts, 1);
        });

        it('dedupes fallback snapshots from one fresh reviewer invocation without telemetry', () => {
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const content = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            const reviewContextPath = path.join(reviewsDir, `${TASK_ID}-code-review-context.json`);
            writeArtifact(reviewsDir, TASK_ID, '-code.md', content);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:one-fallback-invocation')
            });
            const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
            const receipt = {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(reviewContextPath),
                review_artifact_sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:one-fallback-invocation',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED',
                reviewer_provenance: { event_sha256: 'b'.repeat(64) },
                recorded_at_utc: '2026-07-22T00:00:01.000Z'
            };
            fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
            buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
            receipt.recorded_at_utc = '2026-07-22T00:00:02.000Z';
            fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
            buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.source_mode, 'current_artifacts_fallback');
            assert.equal(result.review_attempt_summary?.total_attempts, 1);
            assert.equal(result.review_attempt_summary?.review_types[0].total_attempts, 1);
        });

        it('reports cumulative and current-scope review-cycle diagnostics in audit and closeout summaries', () => {
            writeWorkflowConfig(tmpDir, false);
            const currentCodeScopeSha256 = '1'.repeat(64);
            const currentReviewScopeSha256 = '2'.repeat(64);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: {
                    changed_lines_total: 24,
                    domain_scope_fingerprints: {
                        schema_version: 1,
                        detection_source: 'explicit_changed_files',
                        include_untracked: true,
                        use_staged: false,
                        domains: {},
                        legacy: {
                            review_scope_sha256: currentReviewScopeSha256,
                            code_scope_sha256: currentCodeScopeSha256,
                            non_test_review_scope_sha256: currentCodeScopeSha256,
                            code_review_scope_sha256: currentCodeScopeSha256
                        }
                    }
                },
                required_reviews: { code: false, test: false }
            });

            for (let index = 0; index < 4; index += 1) {
                appendIntegrityEvent(eventsDir, TASK_ID, {
                    event_type: 'REVIEW_RECORDED',
                    details: {
                        review_type: 'code',
                        code_scope_sha256: index < 2 ? currentCodeScopeSha256 : createHash('sha256').update(`old-code-scope-${index}`).digest('hex'),
                        reused_existing_review: index === 1
                    }
                });
            }
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: {
                    review_type: 'test',
                    review_scope_sha256: currentReviewScopeSha256,
                    reused_existing_review: true
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.total_attempts, 3);
            assert.equal(result.review_attempt_summary?.total_non_test_attempts, 3);
            assert.equal(result.review_attempt_summary?.current_scope_non_test_attempts, 1);
            assert.equal(result.review_attempt_summary?.fresh_non_test_attempts, 3);
            assert.equal(result.review_attempt_summary?.reused_non_test_attempts, 0);
            assert.equal(result.review_attempt_summary?.scope_hash_count_by_review_type?.code, 3);
            assert.deepEqual(result.review_attempt_summary?.current_scope_counts_by_review_type?.code, {
                total: 1,
                pass: 0,
                fail: 0,
                missing_or_invalid: 1
            });
            assert.equal(result.final_closeout.review_attempt_summary?.current_scope_non_test_attempts, 1);
            assert.ok(formatTaskAuditSummaryText(result).includes('Review cycle attempts: total=3; non_test=3; current_scope_non_test=1; fresh_non_test=3; reused_non_test=0; scope_hashes_by_type=code=3'));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes('Review cycle attempts: total=3; non_test=3; current_scope_non_test=1; fresh_non_test=3; reused_non_test=0; scope_hashes_by_type=code=3'));
        });

        it('uses workflow review-cycle exclusions for audit and closeout non-test attempt totals', () => {
            writeWorkflowConfig(tmpDir, false);
            const workflowConfigPath = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
            const reviewCycleGuard = workflowConfig.review_cycle_guard as Record<string, unknown>;
            reviewCycleGuard.excluded_review_types = ['test', 'performance'];
            fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');

            const currentCodeScopeSha256 = '3'.repeat(64);
            const currentReviewScopeSha256 = '4'.repeat(64);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: {
                    changed_lines_total: 24,
                    domain_scope_fingerprints: {
                        schema_version: 1,
                        detection_source: 'explicit_changed_files',
                        include_untracked: true,
                        use_staged: false,
                        domains: {},
                        legacy: {
                            review_scope_sha256: currentReviewScopeSha256,
                            code_scope_sha256: currentCodeScopeSha256,
                            non_test_review_scope_sha256: currentCodeScopeSha256,
                            code_review_scope_sha256: currentCodeScopeSha256
                        }
                    }
                },
                required_reviews: { code: false, performance: false, test: false }
            });

            for (const reviewType of ['code', 'code', 'performance', 'test']) {
                appendIntegrityEvent(eventsDir, TASK_ID, {
                    event_type: 'REVIEW_RECORDED',
                    details: {
                        review_type: reviewType,
                        code_scope_sha256: reviewType === 'test' ? undefined : currentCodeScopeSha256,
                        review_scope_sha256: reviewType === 'test' ? currentReviewScopeSha256 : undefined
                    }
                });
            }

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.total_attempts, 4);
            assert.equal(result.review_attempt_summary?.total_non_test_attempts, 2);
            assert.equal(result.review_attempt_summary?.current_scope_non_test_attempts, 2);
            assert.equal(result.review_attempt_summary?.fresh_non_test_attempts, 2);
            assert.equal(result.review_attempt_summary?.reused_non_test_attempts, 0);
            assert.deepEqual(result.review_attempt_summary?.current_scope_counts_by_review_type, {
                code: {
                    total: 2,
                    pass: 0,
                    fail: 0,
                    missing_or_invalid: 2
                }
            });
            assert.deepEqual(result.review_attempt_summary?.scope_hash_count_by_review_type, {
                code: 1,
                performance: 1,
                test: 1
            });
            assert.equal(result.final_closeout.review_attempt_summary?.total_non_test_attempts, 2);
            assert.ok(formatTaskAuditSummaryText(result).includes('Review cycle attempts: total=4; non_test=2; current_scope_non_test=2; fresh_non_test=2; reused_non_test=0; scope_hashes_by_type=code=1, performance=1, test=1'));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes('Review cycle attempts: total=4; non_test=2; current_scope_non_test=2; fresh_non_test=2; reused_non_test=0; scope_hashes_by_type=code=1, performance=1, test=1'));
        });

        it('summarizes code security refactor and test attempts in stable compact order', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 42 },
                required_reviews: { code: false, security: false, refactor: false, test: false }
            });

            function recordAttempt(reviewType: string, title: string, verdictToken: string, reviewerIdentity: string, reusedExistingReview = false): void {
                const reviewContent = `# ${title}\n\n## Verdict\n${verdictToken}\n`;
                writeArtifact(reviewsDir, TASK_ID, `-${reviewType}.md`, reviewContent);
                writeArtifact(reviewsDir, TASK_ID, `-${reviewType}-review-context.json`, {
                    task_id: TASK_ID,
                    review_type: reviewType,
                    reviewer_routing: makeDelegatedRouting(reviewerIdentity)
                });
                writeArtifact(reviewsDir, TASK_ID, `-${reviewType}-receipt.json`, {
                    schema_version: 2,
                    task_id: TASK_ID,
                    review_type: reviewType,
                    preflight_sha256: null,
                    review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-${reviewType}-review-context.json`)),
                    review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_identity: reviewerIdentity,
                    reviewer_fallback_reason: null,
                    trust_level: 'INDEPENDENT_AUDITED',
                    reused_existing_review: reusedExistingReview
                });
                appendIntegrityEvent(eventsDir, TASK_ID, {
                    event_type: 'REVIEW_RECORDED',
                    details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, reviewType)
                });
            }

            recordAttempt('code', 'Code Review', 'REVIEW PASSED', 'agent:code-reviewer-pass');
            recordAttempt('security', 'Security Review', 'SECURITY REVIEW FAILED', 'agent:security-reviewer-fail');
            recordAttempt('refactor', 'Refactor Review', 'REFACTOR REVIEW PASSED', 'agent:refactor-reviewer-pass');
            recordAttempt('test', 'Test Review', 'TEST REVIEW PASSED', 'agent:test-reviewer-pass', true);
            recordAttempt('code', 'Code Review', 'CODE REVIEW FAILED', 'agent:code-reviewer-fail');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.total_attempts, 4);
            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 2,
                    pass_count: 1,
                    fail_count: 1,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                },
                {
                    review_type: 'refactor',
                    total_attempts: 1,
                    pass_count: 1,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                },
                {
                    review_type: 'security',
                    total_attempts: 1,
                    pass_count: 0,
                    fail_count: 1,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }
            ]);
            const expectedLine = 'Review attempts: total=4; code(pass=1, fail=1, reused=0, missing/invalid=0); refactor(pass=1, fail=0, reused=0, missing/invalid=0); security(pass=0, fail=1, reused=0, missing/invalid=0)';
            assert.equal(result.review_attempt_summary?.visible_summary_line, expectedLine);
            assert.ok(formatTaskAuditSummaryText(result).includes(expectedLine));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes(expectedLine));
        });

        it('counts historical stale failed review attempts before a fresh pass', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/cli/commands/gate-review-handlers/result/review-result-handlers.ts'],
                metrics: { changed_lines_total: 38 },
                required_reviews: { code: false }
            });

            function recordCodeAttempt(verdictToken: string, reviewerIdentity: string, historicalStale = false): void {
                const reviewContent = `# Code Review\n\n## Verdict\n${verdictToken}\n`;
                writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
                writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                    task_id: TASK_ID,
                    review_type: 'code',
                    reviewer_routing: makeDelegatedRouting(reviewerIdentity)
                });
                writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                    schema_version: 2,
                    task_id: TASK_ID,
                    review_type: 'code',
                    preflight_sha256: null,
                    review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                    review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_identity: reviewerIdentity,
                    reviewer_fallback_reason: null,
                    trust_level: 'INDEPENDENT_AUDITED',
                    historical_stale_review_result: historicalStale,
                    review_result_scope: historicalStale ? 'historical_stale_after_remediation' : 'current'
                });
                appendIntegrityEvent(eventsDir, TASK_ID, {
                    event_type: 'REVIEW_RECORDED',
                    details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
                });
            }

            recordCodeAttempt('REVIEW FAILED', 'agent:code-reviewer-fail-1', true);
            recordCodeAttempt('CODE REVIEW FAILED', 'agent:code-reviewer-fail-2', true);
            recordCodeAttempt('REVIEW PASSED', 'agent:code-reviewer-pass');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.total_attempts, 3);
            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 3,
                    pass_count: 1,
                    fail_count: 2,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }
            ]);
            const expectedLine = 'Review attempts: total=3; code(pass=1, fail=2, reused=0, missing/invalid=0)';
            assert.equal(result.review_attempt_summary?.visible_summary_line, expectedLine);
            assert.ok(formatTaskAuditSummaryText(result).includes(expectedLine));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes(expectedLine));
        });

        it('falls back to immutable snapshot artifacts when no REVIEW_RECORDED telemetry exists', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: { code: false, test: false }
            });

            const codePassContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codePassContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer-pass')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(codePassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer-pass',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });

            const testPassContent = '# Test Review\n\n## Verdict\nTEST REVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-test.md', testPassContent);
            writeArtifact(reviewsDir, TASK_ID, '-test-review-context.json', {
                task_id: TASK_ID,
                review_type: 'test',
                reviewer_routing: makeDelegatedRouting('agent:test-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-test-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(testPassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:test-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED',
                reused_existing_review: true
            });
            buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
            buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'test');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.source_mode, 'current_artifacts_fallback');
            assert.equal(result.review_attempt_summary?.total_attempts, 1);
            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 1,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }
            ]);
        });

        it('ignores mutable current review artifacts without snapshot evidence', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: { code: false }
            });

            const codePassContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codePassContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer-pass')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(codePassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer-pass',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary, null);
        });

        it('reports mixed source mode when telemetry and snapshot fallback are both used', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: { code: false, test: false }
            });

            const codePassContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codePassContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer-pass')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(codePassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer-pass',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
            });

            const testPassContent = '# Test Review\n\n## Verdict\nTEST REVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-test.md', testPassContent);
            writeArtifact(reviewsDir, TASK_ID, '-test-review-context.json', {
                task_id: TASK_ID,
                review_type: 'test',
                reviewer_routing: makeDelegatedRouting('agent:test-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-test-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(testPassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:test-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED',
                reused_existing_review: true
            });
            buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'test');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.source_mode, 'mixed');
            assert.equal(result.review_attempt_summary?.total_attempts, 1);
            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 1,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }
            ]);
        });

        it('counts same review type from telemetry and snapshot fallback as separate attempts when evidence differs', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: { code: false }
            });

            const codeFailContent = '# Code Review\n\n## Verdict\nREVIEW FAILED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codeFailContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer-fail')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(codeFailContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer-fail',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
            });

            const codePassContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codePassContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer-pass')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(codePassContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer-pass',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary?.source_mode, 'mixed');
            assert.equal(result.review_attempt_summary?.total_attempts, 2);
            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 2,
                    pass_count: 1,
                    fail_count: 1,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }
            ]);
        });

        it('marks review attempts as missing or invalid when snapshot evidence is unavailable', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: {
                    task_id: TASK_ID,
                    review_type: 'code',
                    receipt_snapshot_path: path.join(reviewsDir, 'missing-code-receipt.json'),
                    receipt_snapshot_sha256: '1'.repeat(64),
                    review_artifact_snapshot_path: path.join(reviewsDir, 'missing-code-review.md'),
                    review_artifact_snapshot_sha256: '2'.repeat(64)
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 0,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 1
                }
            ]);
            assert.ok(formatTaskAuditSummaryText(result).includes('missing/invalid=1'));
        });

        it('downgrades snapshot attempts to missing or invalid when the receipt hash does not bind to the artifact snapshot', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update('# Code Review\n\n## Verdict\nREVIEW FAILED\n', 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 0,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 1
                }
            ]);
        });

        it('downgrades path-only REVIEW_RECORDED evidence without snapshot hashes to missing or invalid', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
            const reviewPath = path.join(reviewsDir, `${TASK_ID}-code.md`);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED',
                reused_existing_review: true
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: {
                    task_id: TASK_ID,
                    review_type: 'code',
                    receipt_path: receiptPath,
                    review_artifact_path: reviewPath,
                    reused_existing_review: true
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary, null);
        });

        it('excludes corrupt reused snapshot fallback when telemetry identifies the same evidence as reused', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED',
                reused_existing_review: true
            });
            const details = buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
            fs.writeFileSync(String(details.receipt_snapshot_path), '{corrupt', 'utf8');
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: { ...details, reused_existing_review: true }
            });

            const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot: tmpDir, eventsRoot: eventsDir, reviewsRoot: reviewsDir });

            assert.equal(result.review_attempt_summary, null);
        });

        it('downgrades REVIEW_RECORDED evidence with live paths and hashes but no snapshot paths', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            const reviewHash = createHash('sha256').update(reviewContent, 'utf8').digest('hex');
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
            const reviewPath = path.join(reviewsDir, `${TASK_ID}-code.md`);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: reviewHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            const receiptHash = computeFileSha256(receiptPath);
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: {
                    task_id: TASK_ID,
                    review_type: 'code',
                    receipt_path: receiptPath,
                    receipt_sha256: receiptHash,
                    review_artifact_path: reviewPath,
                    review_artifact_sha256: reviewHash
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 0,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 1
                }
            ]);
        });

        it('downgrades REVIEW_RECORDED evidence when snapshot hashes do not bind to recorded artifact hashes', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            const details = buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
            details.receipt_sha256 = 'a'.repeat(64);
            details.review_artifact_sha256 = 'b'.repeat(64);
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 2,
                    pass_count: 1,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 1
                }
            ]);
        });

        it('downgrades REVIEW_RECORDED evidence when snapshot-path fields point to live artifacts', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
            const reviewPath = path.join(reviewsDir, `${TASK_ID}-code.md`);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: {
                    task_id: TASK_ID,
                    review_type: 'code',
                    receipt_snapshot_path: receiptPath,
                    receipt_snapshot_sha256: computeFileSha256(receiptPath),
                    receipt_sha256: computeFileSha256(receiptPath),
                    review_artifact_snapshot_path: reviewPath,
                    review_artifact_snapshot_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                    review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex')
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 0,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 1
                }
            ]);
        });

        it('downgrades REVIEW_RECORDED evidence when snapshot paths use canonical names in noncanonical directories', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });

            const details = buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
            const noncanonicalSnapshotDir = path.join(reviewsDir, 'copied-snapshots');
            fs.mkdirSync(noncanonicalSnapshotDir, { recursive: true });
            const canonicalReceiptSnapshotPath = String(details.receipt_snapshot_path);
            const canonicalReviewSnapshotPath = String(details.review_artifact_snapshot_path);
            const nestedReceiptSnapshotPath = path.join(noncanonicalSnapshotDir, path.basename(canonicalReceiptSnapshotPath));
            const nestedReviewSnapshotPath = path.join(noncanonicalSnapshotDir, path.basename(canonicalReviewSnapshotPath));
            fs.copyFileSync(canonicalReceiptSnapshotPath, nestedReceiptSnapshotPath);
            fs.copyFileSync(canonicalReviewSnapshotPath, nestedReviewSnapshotPath);
            fs.rmSync(canonicalReceiptSnapshotPath, { force: true });
            fs.rmSync(canonicalReviewSnapshotPath, { force: true });
            details.receipt_snapshot_path = nestedReceiptSnapshotPath;
            details.review_artifact_snapshot_path = nestedReviewSnapshotPath;

            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 0,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 1
                }
            ]);
        });

        it('counts snapshot-less historical REVIEW_RECORDED telemetry as missing or invalid', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 16 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: {
                    task_id: TASK_ID,
                    review_type: 'code'
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 0,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 1
                }
            ]);
        });

        it('counts repeated historical REVIEW_RECORDED events without snapshot paths as separate missing-or-invalid attempts', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 16 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: { task_id: TASK_ID, review_type: 'code' }
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: { task_id: TASK_ID, review_type: 'code' }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 2,
                    pass_count: 0,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 2
                }
            ]);
        });

        it('dedupes repeated REVIEW_RECORDED telemetry when the same snapshot evidence is recorded twice', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 16 },
                required_reviews: { code: false }
            });
            const reviewContent = '# Code Review\n\n## Verdict\nREVIEW PASSED\n';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: makeDelegatedRouting('agent:code-reviewer')
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            });
            const details = buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
            appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_RECORDED', details });
            appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_RECORDED', details });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.review_attempt_summary?.review_types, [
                {
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 1,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }
            ]);
        });

        it('excludes reused review telemetry for snapshot-less historical REVIEW_RECORDED events', () => {
            writeWorkflowConfig(tmpDir, false);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 16 },
                required_reviews: { code: false }
            });
            appendIntegrityEvent(eventsDir, TASK_ID, {
                event_type: 'REVIEW_RECORDED',
                details: {
                    task_id: TASK_ID,
                    review_type: 'code',
                    reused_existing_review: true
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.review_attempt_summary, null);
        });
    });
});
