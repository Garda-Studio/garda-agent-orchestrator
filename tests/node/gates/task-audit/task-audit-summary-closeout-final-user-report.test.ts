import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatFinalUserReport } from '../../../../src/gates/task-audit/task-audit-summary';

import {
    fs,
    path,
    writeWorkflowConfig,
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

        it('prevents adversarial content while rendering concise final user report with warning last', () => {
            const closeout: Parameters<typeof formatFinalUserReport>[0] = {
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-149-final-closeout.json',
                    markdown: 'runtime/reviews/T-149-final-closeout.md',
                    final_user_report: 'runtime/reviews/T-149-final-user-report.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { db: 'DB REVIEW PASSED', test: 'TEST REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 2,
                    changed_lines_total: 12,
                    scope_category: 'mixed',
                    active_profile: 'balanced'
                },
                review_timing_audit: {
                    entries: [
                        {
                            review_type: 'db',
                            reviewer_identity: 'agent:db-reviewer',
                            reviewer_execution_mode: 'delegated_subagent',
                            reused_existing_review: false,
                            receipt_path: 'runtime/reviews/T-149-db-receipt.json',
                            receipt_sha256: null,
                            review_output_path: null,
                            review_output_sha256: null,
                            provider: 'Antigravity',
                            provider_invocation_id: 'agent:t149-db-reviewer',
                            reviewer_launch_attestation_source: 'provider_subagent',
                            launch_prepared_at_utc: null,
                            delegation_started_at_utc: null,
                            launched_at_utc: null,
                            launch_completed_at_utc: null,
                            invocation_attested_at_utc: null,
                            review_result_recorded_at_utc: null,
                            review_output_source_mtime_utc: null,
                            delegation_to_result_ms: 11_840,
                            delegation_to_source_mtime_ms: null,
                            gate_finalize_ms: null,
                            launch_to_result_ms: 11_840,
                            launch_to_source_mtime_ms: null,
                            hidden_timing_status: 'DISTRUSTED',
                            hidden_timing_distrust_code: 'too_short_without_strong_provider_evidence'
                        },
                        {
                            review_type: 'test',
                            reviewer_identity: 'agent:test-reviewer',
                            reviewer_execution_mode: 'delegated_subagent',
                            reused_existing_review: false,
                            receipt_path: 'runtime/reviews/T-149-test-receipt.json',
                            receipt_sha256: null,
                            review_output_path: null,
                            review_output_sha256: null,
                            provider: 'Codex',
                            provider_invocation_id: 'codex-run-1',
                            reviewer_launch_attestation_source: 'codex.spawn_agent',
                            launch_prepared_at_utc: null,
                            delegation_started_at_utc: null,
                            launched_at_utc: null,
                            launch_completed_at_utc: null,
                            invocation_attested_at_utc: null,
                            review_result_recorded_at_utc: null,
                            review_output_source_mtime_utc: null,
                            delegation_to_result_ms: 76_522,
                            delegation_to_source_mtime_ms: null,
                            gate_finalize_ms: null,
                            launch_to_result_ms: 76_522,
                            launch_to_source_mtime_ms: null,
                            hidden_timing_status: 'TRUSTED',
                            hidden_timing_distrust_code: null
                        }
                    ],
                    visible_summary_line: 'Review timing audit: db(DISTRUSTED); test(TRUSTED).'
                },
                review_integrity_attestation: {
                    schema_version: 1,
                    enforcement_mode: 'BLOCKING',
                    status: 'INDEPENDENT_REVIEW_ATTESTED',
                    required_review_count: 2,
                    required_review_types: ['db', 'test'],
                    independent_review_completed: true,
                    completion_review_attested: true,
                    completion_review_attestation_not_required: false,
                    completion_allowed: true,
                    fake_or_fallback_artifacts_observed: false,
                    same_agent_fallback_observed: false,
                    fallback_artifacts_observed: false,
                    legacy_local_review_observed: false,
                    missing_or_unverifiable_artifacts_observed: false,
                    fabricated_artifacts_observed: false,
                    observed_issues: [],
                    reason: 'All mandatory reviews are independently audited.',
                    visible_summary_line: 'Review integrity: INDEPENDENT_REVIEW_ATTESTED.',
                    final_report_lines: []
                },
                review_findings_audit: {
                    status: 'CLEAR',
                    lanes: [{
                        review_type: 'test',
                        source_mode: 'fresh',
                        validation_status: 'ACCEPTED',
                        validation_violations: [],
                        disposition_status: 'SATISFIED',
                        disposition_counts: { fix_now: 0, create_follow_up: 1, ignore: 0 },
                        disposition_violations: [],
                        findings: [{
                            id: 'F-001',
                            kind: 'finding',
                            severity: 'medium',
                            title: 'Concise finding title visible in chat',
                            description: 'Detailed finding description that must stay in the audit artifact.',
                            evidence_locations: ['src/example.ts:10'],
                            coverage_obligation_ids: ['FILE-001'],
                            action: 'create_follow_up',
                            materialization_status: 'MATERIALIZED',
                            follow_up_task_id: 'T-AUDIT-1-F1',
                            blocking: false
                        }],
                        remaining_blocker_ids: []
                    }],
                    finding_count: 1,
                    residual_risk_count: 0,
                    disposition_counts: { fix_now: 0, create_follow_up: 1, ignore: 0 },
                    remaining_blocker_count: 0,
                    validation_failures: [{
                        timestamp_utc: '2026-01-01T00:00:00.000Z',
                        review_type: 'test',
                        reviewer_identity: 'agent:test-reviewer',
                        violation: 'Verbose historical validation detail that must stay out of chat.',
                        validation_artifact_sha256: null
                    }],
                    correction_transports: [{
                        timestamp_utc: '2026-01-01T00:00:01.000Z',
                        event_type: 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED',
                        review_type: 'test',
                        transport: 'full_reviewer_relaunch',
                        session_availability: 'unavailable',
                        correction_attempt: 2,
                        correction_package_sha256: null,
                        reviewer_invocation_event_sha256: null,
                        provider_capabilities_sha256: null,
                        evidence_valid: true,
                        violations: []
                    }],
                    remediation_cycles: [],
                    fresh_review_count: 1,
                    reused_review_count: 0,
                    visible_summary_line: 'Verbose legacy summary that must stay out of chat.'
                },
                workflow: {
                    mandatory_full_suite_enabled: false,
                    visible_summary_line: 'Mandatory full-suite: false'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "feat(workflow): final report"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            };
            const renderedReport = formatFinalUserReport(closeout);

            assert.ok(renderedReport.includes('Status: DONE'));
            assert.ok(renderedReport.includes('Full suite: not required'));
            assert.ok(renderedReport.includes('db(1): passed (0m 11s)'));
            assert.ok(renderedReport.includes('test(1): passed with follow-up (1m 16s)'));
            assert.ok(!renderedReport.includes('PathMode:'));
            assert.ok(!renderedReport.includes('Commit Readiness:'));
            assert.ok(!renderedReport.includes('Operator Question:'));
            assert.ok(renderedReport.includes('Non-blocking findings:\ntest/F-001 (medium): Concise finding title visible in chat -&gt; T-AUDIT-1-F1'));
            assert.ok(renderedReport.includes('Follow-ups:\nT-AUDIT-1-F1'));
            assert.equal(renderedReport.includes('Summary: status='), false);
            assert.equal(renderedReport.includes('ReviewDiagnostics:'), false);
            assert.equal(renderedReport.includes('AuditDetails:'), false);
            assert.equal(renderedReport.includes('Detailed finding description that must stay in the audit artifact.'), false);
            assert.equal(renderedReport.includes('Verbose historical validation detail that must stay out of chat'), false);
            assert.ok(renderedReport.includes('WARNING: review-output validation caused a full reviewer relaunch for test.'));
            assert.ok(renderedReport.includes('WARNING: review accepted, but timing looked unusual'));

            const groupedFollowUpLane = closeout.review_findings_audit!.lanes[0];
            const groupedFollowUpReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: {
                    ...closeout.review_findings_audit!,
                    lanes: [
                        {
                            ...groupedFollowUpLane,
                            findings: [
                                groupedFollowUpLane.findings[0],
                                {
                                    ...groupedFollowUpLane.findings[0],
                                    id: 'F-002',
                                    title: 'Second finding assigned to the same grouped follow-up'
                                }
                            ]
                        },
                        {
                            ...groupedFollowUpLane,
                            review_type: 'security',
                            findings: [{
                                ...groupedFollowUpLane.findings[0],
                                id: 'F-003',
                                title: 'Finding from another lane assigned to the same grouped follow-up'
                            }]
                        }
                    ]
                }
            });
            assert.equal(
                groupedFollowUpReport.match(/^T-AUDIT-1-F1$/gmu)?.length,
                1,
                'the follow-up section should list each grouped task once'
            );

            const pendingFollowUpReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: {
                    ...closeout.review_findings_audit!,
                    status: 'BLOCKED',
                    lanes: closeout.review_findings_audit!.lanes.map((lane) => ({
                        ...lane,
                        disposition_status: 'BLOCKED' as const,
                        findings: lane.findings.map((finding) => ({
                            ...finding,
                            id: 'F-PENDING',
                            materialization_status: 'PENDING' as const,
                            follow_up_task_id: 'T-AUDIT-PENDING-F1'
                        })),
                        remaining_blocker_ids: []
                    })),
                    remaining_blocker_count: 1
                }
            });
            assert.ok(pendingFollowUpReport.includes('test(1): failed (1m 16s)'));
            assert.equal(pendingFollowUpReport.includes('test(1): passed with follow-up'), false);
            assert.ok(pendingFollowUpReport.includes('test/F-PENDING has no materialized follow-up'));
            assert.equal(pendingFollowUpReport.includes('Follow-ups:\nT-AUDIT-PENDING-F1'), false);

            const manyFindingsReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: {
                    ...closeout.review_findings_audit!,
                    lanes: closeout.review_findings_audit!.lanes.map((lane) => ({
                        ...lane,
                        findings: Array.from({ length: 1_000 }, (_, index) => ({
                            ...lane.findings[0],
                            id: `F-${String(index + 1).padStart(4, '0')}`,
                            title: `Finding ${index + 1}`,
                            action: 'ignore' as const,
                            follow_up_task_id: null
                        }))
                    }))
                }
            });
            assert.ok(manyFindingsReport.includes('test/F-0010 (medium): Finding 10'));
            assert.equal(manyFindingsReport.includes('test/F-0011 (medium): Finding 11'), false);
            assert.ok(manyFindingsReport.includes('990 more finding(s); see machine-readable closeout evidence.'));
            assert.ok(manyFindingsReport.length < 3_000);

            const manyAuditSectionsReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: {
                    ...closeout.review_findings_audit!,
                    lanes: closeout.review_findings_audit!.lanes.map((lane) => ({
                        ...lane,
                        findings: [
                            ...Array.from({ length: 1_000 }, (_, index) => ({
                                ...lane.findings[0],
                                id: `F-UP-${String(index + 1).padStart(4, '0')}`,
                                title: `Follow-up ${index + 1}`,
                                action: 'create_follow_up' as const,
                                materialization_status: 'MATERIALIZED' as const,
                                follow_up_task_id: `T-AUDIT-1-F${index + 1}`,
                                blocking: false
                            })),
                            ...Array.from({ length: 1_000 }, (_, index) => ({
                                ...lane.findings[0],
                                id: `R-${String(index + 1).padStart(4, '0')}`,
                                kind: 'residual_risk' as const,
                                severity: 'residual_risk' as const,
                                title: null,
                                description: `Residual risk ${index + 1}`,
                                action: null,
                                materialization_status: null,
                                follow_up_task_id: null,
                                blocking: false
                            }))
                        ],
                        remaining_blocker_ids: Array.from(
                            { length: 1_000 },
                            (_, index) => `F-BLOCK-${String(index + 1).padStart(4, '0')}`
                        )
                    }))
                }
            });
            assert.ok(manyAuditSectionsReport.includes('990 more finding(s); see machine-readable closeout evidence.'));
            assert.ok(manyAuditSectionsReport.includes('990 more follow-up(s); see machine-readable closeout evidence.'));
            assert.ok(manyAuditSectionsReport.includes('990 more blocker(s); see machine-readable closeout evidence.'));
            assert.ok(manyAuditSectionsReport.includes('990 more residual risk(s); see machine-readable closeout evidence.'));
            assert.equal(manyAuditSectionsReport.includes('T-AUDIT-1-F11'), false);
            assert.equal(manyAuditSectionsReport.includes('test/F-BLOCK-0011'), false);
            assert.equal(manyAuditSectionsReport.includes('test/R-0011: Residual risk 11'), false);
            assert.ok(manyAuditSectionsReport.length < 8_000);

            const manyReviewAndCorrectionEntriesReport = formatFinalUserReport({
                ...closeout,
                implementation_summary: {
                    ...closeout.implementation_summary,
                    review_verdicts: Object.fromEntries(Array.from(
                        { length: 1_000 },
                        (_, index) => [`review-${String(index + 1).padStart(4, '0')}`, 'REVIEW PASSED']
                    ))
                },
                review_findings_audit: {
                    ...closeout.review_findings_audit!,
                    correction_transports: Array.from({ length: 1_000 }, (_, index) => ({
                        ...closeout.review_findings_audit!.correction_transports![0],
                        review_type: `review-${String(index + 1).padStart(4, '0')}`
                    }))
                }
            });
            assert.ok(manyReviewAndCorrectionEntriesReport.includes('990 more review(s); see machine-readable closeout evidence.'));
            assert.ok(manyReviewAndCorrectionEntriesReport.includes('991 more process warning(s); see machine-readable closeout evidence.'));
            assert.equal(manyReviewAndCorrectionEntriesReport.includes('review-0011(0): passed'), false);
            assert.ok(manyReviewAndCorrectionEntriesReport.length < 20_000);

            const noFindingsReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: {
                    status: 'CLEAR',
                    lanes: [],
                    finding_count: 0,
                    residual_risk_count: 0,
                    disposition_counts: { fix_now: 0, create_follow_up: 0, ignore: 0 },
                    remaining_blocker_count: 0,
                    validation_failures: [],
                    remediation_cycles: [],
                    fresh_review_count: 0,
                    reused_review_count: 0,
                    visible_summary_line: 'Review findings audit: status=CLEAR; findings=0.'
                }
            });
            assert.ok(noFindingsReport.includes('Non-blocking findings:\nnone'));
            assert.ok(noFindingsReport.includes('Follow-ups:\nnone'));
            assert.equal(noFindingsReport.includes('ReviewDiagnostics:'), false);

            const noAuditReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: null
            });
            assert.ok(noAuditReport.includes('Non-blocking findings:\nnone'));
            assert.ok(noAuditReport.includes('Follow-ups:\nnone'));
            assert.equal(noAuditReport.includes('AuditDetails:'), false);

            const incompleteDispositionReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: {
                    status: 'BLOCKED',
                    lanes: [{
                        review_type: 'test',
                        source_mode: 'fresh',
                        validation_status: 'ACCEPTED',
                        validation_violations: [],
                        disposition_status: 'BLOCKED',
                        disposition_counts: { fix_now: 1, create_follow_up: 1, ignore: 0 },
                        disposition_violations: [],
                        findings: [{
                            id: 'F-BLOCKING',
                            kind: 'finding',
                            severity: 'high',
                            title: 'Blocking detail remains in the audit artifact.',
                            description: 'The compact report must still expose the finding id.',
                            evidence_locations: ['src/example.ts:20'],
                            coverage_obligation_ids: ['FILE-002'],
                            action: 'fix_now',
                            materialization_status: 'NOT_REQUIRED',
                            follow_up_task_id: null,
                            blocking: true
                        }, {
                            id: 'F-UNMATERIALIZED',
                            kind: 'finding',
                            severity: 'medium',
                            title: 'Follow-up detail remains in the audit artifact.',
                            description: 'The compact report must expose missing task materialization.',
                            evidence_locations: ['src/example.ts:30'],
                            coverage_obligation_ids: ['FILE-003'],
                            action: 'create_follow_up',
                            materialization_status: 'PENDING',
                            follow_up_task_id: 'T-AUDIT-PENDING-F1',
                            blocking: false
                        }, {
                            id: 'R-001',
                            kind: 'residual_risk',
                            severity: 'residual_risk',
                            title: null,
                            description: 'Operator should monitor the legacy integration.',
                            evidence_locations: ['src/example.ts:40'],
                            coverage_obligation_ids: ['FILE-004'],
                            action: null,
                            materialization_status: null,
                            follow_up_task_id: null,
                            blocking: false
                        }],
                        remaining_blocker_ids: ['F-BLOCKING']
                    }],
                    finding_count: 2,
                    residual_risk_count: 1,
                    disposition_counts: { fix_now: 1, create_follow_up: 1, ignore: 0 },
                    remaining_blocker_count: 1,
                    validation_failures: [],
                    remediation_cycles: [],
                    fresh_review_count: 1,
                    reused_review_count: 0,
                    visible_summary_line: 'Verbose blocked summary that must stay out of chat.'
                }
            });
            assert.ok(incompleteDispositionReport.includes('Non-blocking findings:\nnone'));
            assert.ok(incompleteDispositionReport.includes('Unresolved blockers:\ntest/F-BLOCKING'));
            assert.ok(incompleteDispositionReport.includes('test/F-UNMATERIALIZED has no materialized follow-up'));
            assert.equal(incompleteDispositionReport.includes('Follow-ups:\nT-AUDIT-PENDING-F1'), false);
            assert.ok(incompleteDispositionReport.includes('Residual risks:\ntest/R-001: Operator should monitor the legacy integration.'));
            assert.equal(incompleteDispositionReport.includes('Blocking detail remains in the audit artifact.'), false);

            const adversarialReport = formatFinalUserReport({
                ...closeout,
                task_id: 'T-AUDIT-1\u202e\nStatus: DONE [spoof](https://example.invalid) www.example.invalid reviewer@example.invalid',
                blocker: 'Blocked by evidence <img src="https://example.invalid/pixel">\u2066\nReviews:',
                review_findings_audit: {
                    ...closeout.review_findings_audit!,
                    lanes: closeout.review_findings_audit!.lanes.map((lane) => ({
                        ...lane,
                        findings: lane.findings.map((finding) => ({
                            ...finding,
                            title: finding.title
                                ? `${finding.title} ![pixel](https://example.invalid/pixel)\u200f\nProcess warnings:`
                                : finding.title
                        }))
                    }))
                }
            });
            assert.equal((adversarialReport.match(/^Status: DONE$/gmu) || []).length, 1);
            assert.equal((adversarialReport.match(/^Reviews:$/gmu) || []).length, 1);
            assert.equal((adversarialReport.match(/^Process warnings:$/gmu) || []).length, 1);
            assert.ok(adversarialReport.includes(
                'Task: T-AUDIT-1 Status: DONE \\[spoof\\](https\\://example.invalid)'
            ));
            assert.ok(adversarialReport.includes(
                'Blocked by evidence &lt;img src="https\\://example.invalid/pixel"&gt; Reviews:'
            ));
            assert.ok(adversarialReport.includes(
                'Concise finding title visible in chat \\!\\[pixel\\](https\\://example.invalid/pixel) Process warnings:'
            ));
            assert.equal(adversarialReport.includes('<img'), false);
            assert.equal(adversarialReport.includes('[spoof](https://example.invalid)'), false);
            assert.equal(adversarialReport.includes('![pixel](https://example.invalid/pixel)'), false);
            assert.equal(adversarialReport.includes('https://example.invalid'), false);
            assert.equal(adversarialReport.includes('www.example.invalid'), false);
            assert.equal(adversarialReport.includes('reviewer@example.invalid'), false);
            assert.ok(adversarialReport.includes('www\\.example.invalid'));
            assert.ok(adversarialReport.includes('reviewer\\@example.invalid'));
            assert.equal(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(adversarialReport), false);

            const headingReport = formatFinalUserReport({ ...closeout, blocker: '# Spoof heading' });
            const blockquoteReport = formatFinalUserReport({ ...closeout, blocker: '> Spoof blockquote' });
            const bulletReport = formatFinalUserReport({ ...closeout, blocker: '- Spoof bullet' });
            const plusBulletReport = formatFinalUserReport({ ...closeout, blocker: '+ Spoof bullet' });
            const orderedReport = formatFinalUserReport({ ...closeout, blocker: '1. Spoof ordered item' });
            const parenthesizedOrderedReport = formatFinalUserReport({
                ...closeout,
                blocker: '2) Spoof ordered item'
            });
            const setextReport = formatFinalUserReport({ ...closeout, blocker: '=== Spoof setext heading' });
            assert.ok(headingReport.includes('Unresolved blockers:\n\\# Spoof heading'));
            assert.ok(blockquoteReport.includes('Unresolved blockers:\n&gt; Spoof blockquote'));
            assert.equal(blockquoteReport.includes('Unresolved blockers:\n> Spoof blockquote'), false);
            assert.ok(bulletReport.includes('Unresolved blockers:\n\\- Spoof bullet'));
            assert.ok(plusBulletReport.includes('Unresolved blockers:\n\\+ Spoof bullet'));
            assert.ok(orderedReport.includes('Unresolved blockers:\n1\\. Spoof ordered item'));
            assert.ok(parenthesizedOrderedReport.includes('Unresolved blockers:\n2\\) Spoof ordered item'));
            assert.ok(setextReport.includes('Unresolved blockers:\n\\=== Spoof setext heading'));
        });

    });
});
