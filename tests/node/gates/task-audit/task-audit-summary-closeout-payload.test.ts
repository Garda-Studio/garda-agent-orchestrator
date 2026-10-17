import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatFinalUserReport } from '../../../../src/gates/task-audit/task-audit-summary';
import { buildCompletionReviewOrderBlocker } from '../../../../src/gates/task-audit/task-audit-summary-lifecycle';
import { compileReviewDependencyGraph } from '../../../../src/core/review-dependency-graph';

import {
    fs,
    path,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    computeFileSha256,
    writeEvent,
    writePreflight,
    writeArtifact,
    writeWorkflowConfig,
    assertReviewIntegrityBlocksFinalCloseout,
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

        it('reports custom dependency order drift even when closeout gate events are otherwise present', () => {
            const reviewDependencyGraph = compileReviewDependencyGraph({
                catalogLaneIds: ['code', 'architecture-boundary', 'test'],
                activeLaneIds: ['code', 'architecture-boundary', 'test'],
                requiredReviewIds: ['code', 'architecture-boundary', 'test'],
                mode: 'parallel_all',
                declaration: {
                    preparation_order: ['code', 'architecture-boundary', 'test'],
                    dependencies: {
                        'architecture-boundary': ['code'],
                        test: ['architecture-boundary']
                    }
                }
            });
            const events = [
                { event_type: 'COMPILE_GATE_PASSED', integrity: { task_sequence: 1 }, details: {} },
                {
                    event_type: 'REVIEW_PHASE_STARTED',
                    integrity: { task_sequence: 2 },
                    details: { review_type: 'architecture-boundary' }
                },
                {
                    event_type: 'REVIEW_RECORDED',
                    integrity: { task_sequence: 3 },
                    details: { review_type: 'code' }
                }
            ];

            const blocker = buildCompletionReviewOrderBlocker(
                { code: true, 'architecture-boundary': true, test: true },
                events,
                null,
                tmpDir,
                reviewDependencyGraph
            );

            assert.equal(blocker?.gate, 'required-reviews-check');
            assert.match(blocker?.reason || '', /architecture-boundary.*code.*downstream_started_early/u);
        });

        it('uses task sequence rather than timestamp-sorted array position for dependency closeout', () => {
            const reviewDependencyGraph = compileReviewDependencyGraph({
                catalogLaneIds: ['code', 'architecture-boundary'],
                activeLaneIds: ['code', 'architecture-boundary'],
                requiredReviewIds: ['code', 'architecture-boundary'],
                mode: 'parallel_all',
                declaration: {
                    preparation_order: ['code', 'architecture-boundary'],
                    dependencies: { 'architecture-boundary': ['code'] }
                }
            });
            const timestampSortedButSequenceDivergedEvents = [
                { event_type: 'COMPILE_GATE_PASSED', integrity: { task_sequence: 1 }, details: {} },
                { event_type: 'REVIEW_RECORDED', integrity: { task_sequence: 4 }, details: { review_type: 'code' } },
                {
                    event_type: 'REVIEW_PHASE_STARTED',
                    integrity: { task_sequence: 3 },
                    details: { review_type: 'architecture-boundary' }
                },
                { event_type: 'REVIEW_RECORDED', integrity: { task_sequence: 2 }, details: { review_type: 'code' } }
            ];

            const blocker = buildCompletionReviewOrderBlocker(
                { code: true, 'architecture-boundary': true },
                timestampSortedButSequenceDivergedEvents,
                null,
                tmpDir,
                reviewDependencyGraph
            );

            assert.equal(blocker?.gate, 'required-reviews-check');
            assert.match(blocker?.reason || '', /architecture-boundary.*code.*downstream_started_early/u);
        });

        it('blocks dependency closeout when the upstream review record has blocking findings', () => {
            const reviewDependencyGraph = compileReviewDependencyGraph({
                catalogLaneIds: ['code', 'architecture-boundary'],
                activeLaneIds: ['code', 'architecture-boundary'],
                requiredReviewIds: ['code', 'architecture-boundary'],
                mode: 'parallel_all',
                declaration: {
                    preparation_order: ['code', 'architecture-boundary'],
                    dependencies: { 'architecture-boundary': ['code'] }
                }
            });
            const events = [
                { event_type: 'COMPILE_GATE_PASSED', integrity: { task_sequence: 1 }, details: {} },
                {
                    event_type: 'REVIEW_RECORDED',
                    integrity: { task_sequence: 2 },
                    details: {
                        review_type: 'code',
                        review_findings_disposition: {
                            blocking_count: 1,
                            verdict: 'fail_for_fix_now'
                        }
                    }
                },
                {
                    event_type: 'REVIEW_PHASE_STARTED',
                    integrity: { task_sequence: 3 },
                    details: { review_type: 'architecture-boundary' }
                }
            ];

            const blocker = buildCompletionReviewOrderBlocker(
                { code: true, 'architecture-boundary': true },
                events,
                null,
                tmpDir,
                reviewDependencyGraph
            );

            assert.equal(blocker?.gate, 'required-reviews-check');
            assert.match(blocker?.reason || '', /architecture-boundary.*code.*unaccepted_upstream_record/u);
        });

        it('builds a canonical final closeout payload from task-mode, review-gate, doc-impact, and token-economy evidence', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 6000).toISOString(),
                task_id: TASK_ID,
                event_type: 'TASK_MODE_ENTERED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Task mode entered.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 5000).toISOString(),
                task_id: TASK_ID,
                event_type: 'RULE_PACK_LOADED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Rule pack loaded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 4000).toISOString(),
                task_id: TASK_ID,
                event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Handshake diagnostics recorded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 3000).toISOString(),
                task_id: TASK_ID,
                event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Shell smoke recorded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 2000).toISOString(),
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_CLASSIFIED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Preflight classified.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.',
                details: {
                    output_telemetry: {
                        estimated_saved_chars: 62,
                        estimated_saved_tokens: 62,
                        raw_char_count: 248,
                        filtered_char_count: 186,
                        raw_token_count_estimate: 180,
                        filtered_token_count_estimate: 118
                    }
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 250).toISOString(),
                task_id: TASK_ID,
                event_type: 'REVIEW_PHASE_STARTED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review phase started.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 500).toISOString(),
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 750).toISOString(),
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Doc impact assessed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 1000).toISOString(),
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                requested_depth: 2,
                effective_depth: 2,
                active_profile: 'balanced'
            });
            writePreflight(reviewsDir, TASK_ID, {
                mode: 'FULL_PATH',
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 42 },
                required_reviews: { code: true, test: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-review-gate.json', {
                verdicts: {
                    code: 'REVIEW PASSED',
                    test: 'TEST REVIEW PASSED'
                }
            });
            const crypto = require('node:crypto');
            const codeReviewContent = '# Code Review\n## Verdict\nREVIEW PASSED';
            const testReviewContent = '# Test Review\nTEST REVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'direct Codex provider_entrypoint cannot supply attested reviewer launch evidence',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-review-context.json', {
                task_id: TASK_ID,
                review_type: 'test',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'direct Codex provider_entrypoint cannot supply attested reviewer launch evidence',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codeReviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-test.md', testReviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(codeReviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'direct Codex provider_entrypoint cannot supply attested reviewer launch evidence',
                trust_level: 'LOCAL_ASSERTED'
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-test-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(testReviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'direct Codex provider_entrypoint cannot supply attested reviewer launch evidence',
                trust_level: 'LOCAL_ASSERTED'
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                decision: 'DOCS_UPDATED',
                behavior_changed: false,
                changelog_updated: false,
                docs_updated: ['docs/cli-reference.md']
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assertReviewIntegrityBlocksFinalCloseout(result, 'same_agent_fallback');
            assert.equal(result.final_closeout.implementation_summary.requested_depth, 2);
            assert.equal(result.final_closeout.implementation_summary.effective_depth, 2);
            assert.equal(result.final_closeout.implementation_summary.path_mode, 'FULL_PATH');
            assert.deepEqual(result.final_closeout.implementation_summary.review_verdicts, {
                code: 'REVIEW PASSED',
                test: 'TEST REVIEW PASSED'
            });
            assert.equal(result.final_closeout.review_trust?.status, 'UNAVAILABLE');
            assert.ok(result.final_closeout.review_trust?.visible_summary_line?.includes('incomplete or invalid'));
            assert.ok(result.final_closeout.review_trust?.policy_summary_line?.includes('asserted local review cannot satisfy mandatory independent review'));
            assert.equal(result.final_closeout.review_integrity_attestation?.same_agent_fallback_observed, true);
            assert.equal(result.final_closeout.review_integrity_attestation?.fake_or_fallback_artifacts_observed, true);
            assert.equal(result.final_closeout.implementation_summary.docs_updated, true);
            assert.deepEqual(result.final_closeout.docs.docs_updated, ['docs/cli-reference.md']);
            assert.ok(result.final_closeout.token_economy?.visible_summary_line?.includes('Suppressed output: ~62 chars'));
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, false);
        });

        it('includes full-suite validation telemetry in final closeout token economy', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Full-suite validation passed.',
                details: {
                    output_telemetry: {
                        estimated_saved_chars: 420,
                        estimated_saved_tokens: 105,
                        raw_char_count: 600,
                        filtered_char_count: 180,
                        raw_token_count_estimate: 150,
                        filtered_token_count_estimate: 45
                    }
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.token_economy?.total_estimated_saved_chars, 420);
            assert.equal(result.final_closeout.token_economy?.total_estimated_saved_tokens, 105);
            assert.ok(result.final_closeout.token_economy?.visible_summary_line?.includes('full-suite validation output ~420 chars'));
        });

        it('carries full-suite timeout warning evidence into final closeout reports', () => {
            writeArtifact(reviewsDir, TASK_ID, '-full-suite-validation.json', {
                status: 'WARNED',
                enabled: true,
                command: 'npm test',
                exit_code: null,
                timed_out: true,
                warnings: [
                    'Full suite validation timed out, but workflow-config.full_suite_validation.timeout_blocker=false.'
                ],
                timeout_policy: {
                    timeout_blocker: false,
                    timeout_retry_count: 0,
                    max_attempts: 1,
                    attempts: [
                        { attempt: 1, exit_code: null, timed_out: true }
                    ],
                    attempts_exhausted: true,
                    warning_only_continuation: true,
                    repair_task_proposal: null
                },
                timeout_forecast: {
                    history_path: 'runtime/metrics/full-suite-duration-history.json',
                    sample_count: 0,
                    excluded_sample_count: 2,
                    excluded_sample_reasons: {
                        timed_out: 1,
                        retry_contaminated: 1
                    },
                    average_duration_seconds: null,
                    high_watermark_duration_seconds: null,
                    recommended_timeout_seconds: 600,
                    safety_margin_seconds: null,
                    recommendation_source: 'config_timeout',
                    configured_timeout_seconds: 600,
                    warning: 'Full-suite duration history was unreadable; using configured timeout fallback.'
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const timeout = result.final_closeout.workflow?.full_suite_timeout;
            const finalUserReport = formatFinalUserReport(result.final_closeout);
            const finalMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);
            const summaryText = formatTaskAuditSummaryText(result);

            assert.equal(timeout?.status, 'WARNED');
            assert.equal(timeout?.timed_out, true);
            assert.equal(timeout?.timeout_blocker, false);
            assert.equal(timeout?.warning_only_continuation, true);
            assert.equal(timeout?.forecast_excluded_sample_reasons.timed_out, 1);
            assert.ok(timeout?.visible_summary_line.includes('warning_only=true'));
            assert.ok(finalUserReport.includes('Full suite: warned'));
            assert.ok(finalUserReport.includes('Process warnings:'));
            assert.ok(finalUserReport.includes('workflow-config.full\\_suite\\_validation.timeout\\_blocker=false'));
            assert.ok(finalMarkdown.includes('Full-suite timeout: status=WARNED'));
            assert.ok(summaryText.includes('Full-suite timeout: status=WARNED'));
        });

        it('keeps task metadata inference working when TASK.md notes cell is empty', () => {
            const now = new Date().toISOString();
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P2 | reliability/review-context-canonicalization | Unify review-context artifact naming and make all review gates use one canonical path family | gpt-5.4 | 2026-04-15 | strict | |'
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.commit_command_suggestion, 'node garda-agent-orchestrator/bin/garda.js gate human-commit --task-id "T-AUDIT-1" --message "fix(orchestration): review context canonicalization"');
        });

        it('keeps scope inference deterministic when changed_files order differs', () => {
            const now = new Date().toISOString();
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P2 | reliability/deterministic-commit-scope | Keep final report commit scope deterministic | gpt-5.4 | 2026-04-15 | balanced | |'
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });

            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/validators/verify.ts', 'src/materialization/init.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: {}
            });
            const first = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/materialization/init.ts', 'src/validators/verify.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: {}
            });
            const second = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(first.final_report_contract.commit_command_suggestion, second.final_report_contract.commit_command_suggestion);
            assert.equal(first.final_report_contract.commit_command_suggestion, 'node garda-agent-orchestrator/bin/garda.js gate human-commit --task-id "T-AUDIT-1" --message "fix(materialization): deterministic commit scope"');
        });

        it('falls back to the conventional commit template when task metadata is unavailable', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 8 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.commit_command_template, 'node garda-agent-orchestrator/bin/garda.js gate human-commit --task-id "T-AUDIT-1" --message "<type>(<scope>): <summary>"');
            assert.equal(result.final_report_contract.commit_command_suggestion, 'node garda-agent-orchestrator/bin/garda.js gate human-commit --task-id "T-AUDIT-1" --message "<type>(<scope>): <summary>"');
            assert.deepEqual(result.final_report_contract.required_order, [
                'short agent-authored summary of what changed',
                'verbatim Garda final user report'
            ]);
        });

    });
});
