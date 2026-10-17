import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    createHash,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    computeFileSha256,
    writePreflight,
    writeArtifact,
    writeIntegrityEventSequence,
    appendIntegrityEvent,
    buildReviewRecordedTelemetryDetails,
    writePassedLifecycleWithReviewRecorded,
    writeWorkflowConfig,
    writePassedLifecycle,
    makeIndependentReviewGateCheck,
    makeDelegatedRouting,
    buildCurrentTaskAuditSummary,
    assertReviewIntegrity,
    assertReviewIntegrityBlocksFinalCloseout,
    writeCurrentIndependentReviewFixture,
    makeTempDir} from './task-audit-summary-fixtures';
import {
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../../../../src/gates/review-reuse';
import {
    collectReviewAuthorshipAttestationIssues
} from '../../../../src/gates/task-audit/task-audit-summary-review-integrity';

function passedReviewAuthorshipAttestation(...reviewTypes: string[]): Record<string, unknown> {
    return {
        schema_version: 1,
        status: 'PASSED',
        required_review_types: reviewTypes,
        attested_review_types: reviewTypes,
        skipped_review_types: [],
        attestations: Object.fromEntries(reviewTypes.map((reviewType) => [reviewType, true])),
        false_review_types: [],
        missing_review_types: [],
        unknown_review_types: [],
        non_boolean_review_types: [],
        violations: [],
        honesty_prompt: [],
        visible_summary_line: `Review authorship attestation: passed for ${reviewTypes.join(', ')}.`
    };
}


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
        it('keeps the legacy trust summary visible when preflight review metadata is missing but historical review artifacts remain', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_provenance: {
                    schema_version: 1,
                    attestation_type: 'controller_event_integrity',
                    controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
                    task_sequence: 1,
                    prev_event_sha256: null,
                    event_sha256: 'a'.repeat(64)
                },
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.review_trust?.status, 'LEGACY_LOCAL_AUDITED_CLAIM');
            assert.match(result.final_closeout.review_trust?.visible_summary_line || '', /legacy LOCAL_AUDITED claim/i);
            assert.match(formatTaskAuditSummaryText(result), /Review trust: legacy LOCAL_AUDITED claim/i);
        });

        it('keeps an unavailable trust summary visible when only a partial compatibility review artifact remains', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.review_trust?.status, 'UNAVAILABLE');
            assert.match(result.final_closeout.review_trust?.visible_summary_line || '', /incomplete or invalid/i);
            assert.match(formatTaskAuditSummaryText(result), /Review trust: unavailable/i);
        });

        it('reads independent delegated trust from a current passed review gate', () => {
            const preflightSha256 = 'a'.repeat(64);
            const reviewGate = {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightSha256,
                required_reviews: { code: true },
                review_checks: {
                    code: makeIndependentReviewGateCheck('REVIEW PASSED', 'agent:code-reviewer')
                }
            };

            const summary = readReviewTrustSummaryFromReviewGate(
                reviewGate,
                { code: true },
                TASK_ID,
                'code',
                preflightSha256
            );
            const staleSummary = readReviewTrustSummaryFromReviewGate(
                reviewGate,
                { code: true },
                TASK_ID,
                'code',
                'b'.repeat(64)
            );
            const missingRoutingPolicySummary = readReviewTrustSummaryFromReviewGate(
                {
                    ...reviewGate,
                    review_checks: {
                        code: {
                            ...makeIndependentReviewGateCheck('REVIEW PASSED', 'agent:code-reviewer'),
                            reviewer_routing_policy: undefined
                        }
                    }
                },
                { code: true },
                TASK_ID,
                'code',
                preflightSha256
            );

            assert.equal(summary?.status, 'INDEPENDENT_AUDITED');
            assert.equal(summary?.completion_policy, 'INDEPENDENT_REVIEW_ATTESTED');
            assert.equal(staleSummary, null);
            assert.equal(missingRoutingPolicySummary, null);
        });

        it('surfaces review authorship attestation failures as review integrity issues', () => {
            const issues = collectReviewAuthorshipAttestationIssues(
                {
                    task_id: TASK_ID,
                    status: 'FAILED',
                    outcome: 'FAIL',
                    required_reviews: { code: true },
                    review_authorship_attestation: {
                        schema_version: 1,
                        status: 'FAILED',
                        required_review_types: ['code'],
                        attestations: { code: false },
                        false_review_types: ['code'],
                        missing_review_types: [],
                        unknown_review_types: [],
                        non_boolean_review_types: [],
                        violations: [
                            'Review authorship attestation is false for mandatory review types: code.'
                        ]
                    }
                },
                { code: true }
            );

            assert.ok(issues.some((issue) => issue.includes('code: review authorship attestation is false')));
            assert.ok(issues.some((issue) => issue.includes('review authorship attestation violation')));
        });

        it('surfaces a missing review authorship attestation block as a review integrity issue', () => {
            const issues = collectReviewAuthorshipAttestationIssues(
                {
                    task_id: TASK_ID,
                    status: 'PASSED',
                    outcome: 'PASS',
                    required_reviews: { code: true }
                },
                { code: true }
            );

            assert.deepEqual(issues, [
                'review authorship attestation missing for required review lanes: code'
            ]);
        });

        it('surfaces missing lanes even when review authorship attestation status claims passed', () => {
            const issues = collectReviewAuthorshipAttestationIssues(
                {
                    task_id: TASK_ID,
                    status: 'PASSED',
                    outcome: 'PASS',
                    required_reviews: { code: true },
                    review_authorship_attestation: {
                        schema_version: 1,
                        status: 'PASSED',
                        required_review_types: ['code'],
                        attestations: {},
                        false_review_types: [],
                        missing_review_types: [],
                        unknown_review_types: [],
                        non_boolean_review_types: [],
                        violations: []
                    }
                },
                { code: true }
            );

            assert.ok(issues.includes('code: review authorship attestation is missing'));
        });

        it('surfaces not-required authorship attestation when current review lanes are required', () => {
            const issues = collectReviewAuthorshipAttestationIssues(
                {
                    task_id: TASK_ID,
                    status: 'PASSED',
                    outcome: 'PASS',
                    required_reviews: { code: true },
                    review_authorship_attestation: {
                        schema_version: 1,
                        status: 'NOT_REQUIRED',
                        required_review_types: [],
                        attestations: {},
                        false_review_types: [],
                        missing_review_types: [],
                        unknown_review_types: [],
                        non_boolean_review_types: [],
                        violations: []
                    }
                },
                { code: true }
            );

            assert.ok(issues.includes('review authorship attestation status is NOT_REQUIRED'));
            assert.ok(issues.includes('code: review authorship attestation is missing'));
        });

        describe('final closeout review integrity enforced output', () => {
            describe('positive closeout states', () => {
                it('marks final closeout ready when current mandatory reviews are independently attested', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePreflight(reviewsDir, TASK_ID, { task_id: TASK_ID, mode: 'FULL_PATH', changed_files: ['src/reviewed-feature.ts'], metrics: { changed_lines_total: 18 }, required_reviews: { code: true } });
                    const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
                    const reviewerIdentity = 'agent:code-reviewer';
                    const fixture = writeCurrentIndependentReviewFixture({ reviewsDir, taskId: TASK_ID, preflightSha256, reviewerIdentity, provenance: null });
                    writeIntegrityEventSequence(eventsDir, TASK_ID, ['TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED'].map((event_type) => ({ event_type })));
                    const invocationEvent = appendIntegrityEvent(eventsDir, TASK_ID, {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        details: { task_id: TASK_ID, review_type: 'code', reviewer_execution_mode: 'delegated_subagent', reviewer_identity: reviewerIdentity, review_context_sha256: fixture.reviewContextSha256, routing_event_sha256: 'd'.repeat(64) }
                    });
                    const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
                    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
                    const integrity = invocationEvent.integrity as Record<string, unknown>;
                    receipt.reviewer_provenance = { schema_version: 1, attestation_type: 'reviewer_invocation_attestation', controller_event_type: 'REVIEWER_INVOCATION_ATTESTED', task_sequence: integrity.task_sequence, prev_event_sha256: integrity.prev_event_sha256, event_sha256: integrity.event_sha256, task_id: TASK_ID, review_type: 'code', reviewer_execution_mode: 'delegated_subagent', reviewer_identity: reviewerIdentity, review_context_sha256: fixture.reviewContextSha256, routing_event_sha256: 'd'.repeat(64) };
                    writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', receipt);
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_RECORDED', details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code') });
                    ['REVIEW_GATE_PASSED', 'DOC_IMPACT_ASSESSED', 'COMPLETION_GATE_PASSED'].forEach((event_type) => appendIntegrityEvent(eventsDir, TASK_ID, { event_type }));

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    const blockerDetails = [
                        result.final_report_contract.blocker,
                        JSON.stringify(result.blockers),
                        JSON.stringify(result.final_closeout.review_integrity_attestation?.observed_issues || [])
                    ].filter(Boolean).join(' | ');
                    assert.equal(result.final_closeout.status, 'READY', blockerDetails);
                    assert.equal(result.final_report_contract.status, 'READY', blockerDetails);
                    const attestation = assertReviewIntegrity(result, 'INDEPENDENT_REVIEW_ATTESTED', {
                        completionReviewAttested: true,
                        enforcementMode: 'BLOCKING'
                    });
                    assert.deepEqual(attestation.observed_issues, []);
                });

                it('keeps final closeout ready when planned review routing is rebound to the resolved reviewer identity', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePreflight(reviewsDir, TASK_ID, { task_id: TASK_ID, mode: 'FULL_PATH', changed_files: ['src/reviewed-feature.ts'], metrics: { changed_lines_total: 18 }, required_reviews: { code: true } });
                    const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
                    const plannedReviewerIdentity = `agent:pending:${TASK_ID}-code`;
                    const resolvedReviewerIdentity = 'agent:resolved-code-reviewer';
                    const fixture = writeCurrentIndependentReviewFixture({
                        reviewsDir,
                        taskId: TASK_ID,
                        preflightSha256,
                        reviewerIdentity: resolvedReviewerIdentity,
                        routing: makeDelegatedRouting(plannedReviewerIdentity),
                        provenance: null
                    });
                    writeIntegrityEventSequence(eventsDir, TASK_ID, [
                        'TASK_MODE_ENTERED',
                        'RULE_PACK_LOADED',
                        'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        'SHELL_SMOKE_PREFLIGHT_RECORDED',
                        'PREFLIGHT_CLASSIFIED',
                        'COMPILE_GATE_PASSED',
                        'REVIEW_PHASE_STARTED'
                    ].map((event_type) => ({ event_type })));
                    const routingEvent = appendIntegrityEvent(eventsDir, TASK_ID, {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: plannedReviewerIdentity,
                            reviewer_identity: plannedReviewerIdentity
                        }
                    });
                    const routingIntegrity = routingEvent.integrity as Record<string, unknown>;
                    const invocationEvent = appendIntegrityEvent(eventsDir, TASK_ID, {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        details: {
                            task_id: TASK_ID,
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: resolvedReviewerIdentity,
                            reviewer_session_id: resolvedReviewerIdentity,
                            review_context_sha256: fixture.reviewContextSha256,
                            routing_event_sha256: routingIntegrity.event_sha256
                        }
                    });
                    const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
                    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
                    const invocationIntegrity = invocationEvent.integrity as Record<string, unknown>;
                    receipt.reviewer_provenance = {
                        schema_version: 1,
                        attestation_type: 'reviewer_invocation_attestation',
                        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        task_sequence: invocationIntegrity.task_sequence,
                        prev_event_sha256: invocationIntegrity.prev_event_sha256,
                        event_sha256: invocationIntegrity.event_sha256,
                        task_id: TASK_ID,
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: resolvedReviewerIdentity,
                        review_context_sha256: fixture.reviewContextSha256,
                        routing_event_sha256: routingIntegrity.event_sha256
                    };
                    writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', receipt);
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_RECORDED', details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code') });
                    ['REVIEW_GATE_PASSED', 'DOC_IMPACT_ASSESSED', 'COMPLETION_GATE_PASSED'].forEach((event_type) => appendIntegrityEvent(eventsDir, TASK_ID, { event_type }));

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    const blockerDetails = [
                        result.final_report_contract.blocker,
                        JSON.stringify(result.blockers),
                        JSON.stringify(result.final_closeout.review_integrity_attestation?.observed_issues || [])
                    ].filter(Boolean).join(' | ');
                    assert.equal(result.final_closeout.status, 'READY', blockerDetails);
                    assert.equal(result.final_report_contract.status, 'READY', blockerDetails);
                    const attestation = assertReviewIntegrity(result, 'INDEPENDENT_REVIEW_ATTESTED', {
                        completionReviewAttested: true,
                        enforcementMode: 'BLOCKING'
                    });
                    assert.deepEqual(attestation.observed_issues, []);
                });

                it('keeps mandatory review attested when closeout-only docs are added after review', () => {
                    writeWorkflowConfig(tmpDir, false);
                    const implementationFile = 'src/reviewed-feature.ts';
                    const closeoutDoc = 'CHANGELOG.md';
                    const reviewedPreflight = {
                        task_id: TASK_ID,
                        mode: 'FULL_PATH',
                        changed_files: [implementationFile],
                        metrics: { changed_lines_total: 18 },
                        required_reviews: { code: true }
                    };
                    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(reviewedPreflight, tmpDir).review_scope_sha256;
                    writePreflight(reviewsDir, TASK_ID, reviewedPreflight);
                    const reviewedPreflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
                    const reviewerIdentity = 'agent:code-reviewer';
                    const fixture = writeCurrentIndependentReviewFixture({
                        reviewsDir,
                        taskId: TASK_ID,
                        preflightSha256: reviewedPreflightSha256,
                        reviewerIdentity,
                        provenance: null,
                        receiptOverrides: {
                            review_scope_sha256: reviewScopeSha256,
                            code_scope_sha256: reviewScopeSha256
                        }
                    });
                    writeIntegrityEventSequence(eventsDir, TASK_ID, ['TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED'].map((event_type) => ({ event_type })));
                    const invocationEvent = appendIntegrityEvent(eventsDir, TASK_ID, {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        details: {
                            task_id: TASK_ID,
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: reviewerIdentity,
                            review_context_sha256: fixture.reviewContextSha256,
                            routing_event_sha256: 'd'.repeat(64)
                        }
                    });
                    const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
                    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
                    const integrity = invocationEvent.integrity as Record<string, unknown>;
                    receipt.reviewer_provenance = {
                        schema_version: 1,
                        attestation_type: 'reviewer_invocation_attestation',
                        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        task_sequence: integrity.task_sequence,
                        prev_event_sha256: integrity.prev_event_sha256,
                        event_sha256: integrity.event_sha256,
                        task_id: TASK_ID,
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: reviewerIdentity,
                        review_context_sha256: fixture.reviewContextSha256,
                        routing_event_sha256: 'd'.repeat(64)
                    };
                    writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', receipt);
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_RECORDED', details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code') });
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_GATE_PASSED' });
                    writePreflight(reviewsDir, TASK_ID, { task_id: TASK_ID,
                        mode: 'FULL_PATH',
                        changed_files: [implementationFile, closeoutDoc],
                        metrics: { changed_lines_total: 19 },
                        required_reviews: { code: true }
                    });
                    writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                        status: 'PASSED',
                        outcome: 'PASS',
                        decision: 'DOCS_UPDATED',
                        behavior_changed: true,
                        changelog_updated: true,
                        docs_updated: [closeoutDoc]
                    });
                    ['DOC_IMPACT_ASSESSED', 'COMPLETION_GATE_PASSED'].forEach((event_type) => appendIntegrityEvent(eventsDir, TASK_ID, { event_type }));

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    const blockerDetails = [
                        result.final_report_contract.blocker,
                        JSON.stringify(result.blockers),
                        JSON.stringify(result.final_closeout.review_integrity_attestation?.observed_issues || [])
                    ].filter(Boolean).join(' | ');
                    assert.equal(result.final_closeout.status, 'READY', blockerDetails);
                    assert.equal(result.final_report_contract.status, 'READY', blockerDetails);
                    assert.deepEqual(result.final_closeout.docs.docs_updated, [closeoutDoc]);
                    assertReviewIntegrity(result, 'INDEPENDENT_REVIEW_ATTESTED', {
                        completionReviewAttested: true,
                        enforcementMode: 'BLOCKING'
                    });
                });

                it('marks docs-only no-review closeout as allowed but not review-attested', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePassedLifecycle(eventsDir, TASK_ID);
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FAST_PATH',
                        scope_category: 'docs-only',
                        changed_files: ['docs/usage.md'],
                        metrics: { changed_lines_total: 6 },
                        required_reviews: {}
                    });

                    const result = buildTaskAuditSummary({
                        taskId: TASK_ID,
                        repoRoot: tmpDir,
                        eventsRoot: eventsDir,
                        reviewsRoot: reviewsDir
                    });

                    assert.equal(result.final_closeout.status, 'READY');
                    assertReviewIntegrity(result, 'NO_REVIEW_REQUIRED', {
                        completionReviewAttested: false,
                        completionReviewAttestationNotRequired: true
                    });
                });
            });

            describe('degraded and fallback enforcement states', () => {
                const degradedCases = [
                    {
                        name: 'fabricated',
                        writeFixture: (sha: string) => writeCurrentIndependentReviewFixture({ reviewsDir, taskId: TASK_ID, preflightSha256: sha, reviewContent: '# Code Review\nReview artifact: placeholder\nREVIEW PASSED' }),
                        issue: 'fabricated-looking review artifact content observed'
                    },
                    {
                        name: 'missing-invocation',
                        writeFixture: (sha: string) => writeCurrentIndependentReviewFixture({ reviewsDir, taskId: TASK_ID, preflightSha256: sha }),
                        issue: 'missing matching REVIEWER_INVOCATION_ATTESTED telemetry'
                    },
                    {
                        name: 'unbound-planned-resolved-identity',
                        writeFixture: (sha: string) => writeCurrentIndependentReviewFixture({
                            reviewsDir,
                            taskId: TASK_ID,
                            preflightSha256: sha,
                            reviewerIdentity: 'agent:resolved-code-reviewer',
                            routing: makeDelegatedRouting(`agent:pending:${TASK_ID}-code`),
                            provenance: null
                        }),
                        issue: 'review context reviewer identity does not match receipt'
                    },
                    {
                        name: 'missing-receipt',
                        writeFixture: (sha: string) => {
                            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
                            writeArtifact(reviewsDir, TASK_ID, '-review-gate.json', { task_id: TASK_ID, status: 'PASSED', outcome: 'PASS', preflight_hash_sha256: sha, required_reviews: { code: true }, review_checks: { code: makeIndependentReviewGateCheck('REVIEW PASSED', 'agent:code-reviewer') } });
                        },
                        issue: 'missing or invalid review receipt'
                    },
                    {
                        name: 'mismatched-hash',
                        writeFixture: (sha: string) => {
                            writeCurrentIndependentReviewFixture({ reviewsDir, taskId: TASK_ID, preflightSha256: sha });
                            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED\nmodified after receipt');
                        },
                        issue: 'review artifact hash does not match receipt'
                    }
                ] as const;

                for (const degradedCase of degradedCases) {
                    it(`blocks ${degradedCase.name} review evidence from final closeout`, () => {
                        writeWorkflowConfig(tmpDir, false);
                        writePreflight(reviewsDir, TASK_ID, { mode: 'FULL_PATH', changed_files: [`src/${degradedCase.name}.ts`], metrics: { changed_lines_total: 18 }, required_reviews: { code: true } });
                        degradedCase.writeFixture(computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)));
                        const details = fs.existsSync(path.join(reviewsDir, `${TASK_ID}-code-receipt.json`))
                            ? buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
                            : {};
                        writePassedLifecycleWithReviewRecorded(eventsDir, TASK_ID, details);

                        const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                        assertReviewIntegrityBlocksFinalCloseout(result, degradedCase.issue);
                    });
                }

                it('blocks reused review evidence without strict bindings from final closeout', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePassedLifecycle(eventsDir, TASK_ID);
                    writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                        requested_depth: 2,
                        effective_depth: 2,
                        active_profile: 'balanced'
                    });
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FULL_PATH',
                        changed_files: ['tests/node/cli/commands/gates-review-reuse-stale-evidence.test.ts'],
                        metrics: { changed_lines_total: 32 },
                        required_reviews: { code: true, test: true }
                    });
                    const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
                    const codeReviewContent = '# Code Review\nREVIEW PASSED';
                    const testReviewContent = '# Test Review\nTEST REVIEW PASSED';
                    writeArtifact(reviewsDir, TASK_ID, '-code.md', codeReviewContent);
                    writeArtifact(reviewsDir, TASK_ID, '-test.md', testReviewContent);
                    writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                        schema_version: 2,
                        task_id: TASK_ID,
                        review_type: 'code',
                        preflight_sha256: preflightSha256,
                        review_context_sha256: '1'.repeat(64),
                        review_artifact_sha256: createHash('sha256').update(codeReviewContent, 'utf8').digest('hex'),
                        reused_existing_review: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:historical-code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    });
                    writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                        schema_version: 2,
                        task_id: TASK_ID,
                        review_type: 'test',
                        preflight_sha256: preflightSha256,
                        review_context_sha256: '2'.repeat(64),
                        review_artifact_sha256: createHash('sha256').update(testReviewContent, 'utf8').digest('hex'),
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:fresh-test-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    });
                    writeArtifact(reviewsDir, TASK_ID, '-review-gate.json', {
                        task_id: TASK_ID,
                        status: 'PASSED',
                        outcome: 'PASS',
                        preflight_hash_sha256: preflightSha256,
                        required_reviews: { code: true, test: true },
                        verdicts: {
                            code: 'REVIEW PASSED',
                            test: 'TEST REVIEW PASSED'
                        },
                        review_authorship_attestation: passedReviewAuthorshipAttestation('code', 'test'),
                        review_checks: {
                            code: makeIndependentReviewGateCheck('REVIEW PASSED', 'agent:historical-code-reviewer'),
                            test: makeIndependentReviewGateCheck('TEST REVIEW PASSED', 'agent:fresh-test-reviewer')
                        }
                    });

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    assertReviewIntegrityBlocksFinalCloseout(result, 'strict reused review evidence is invalid');
                });

                it('allows valid reused review evidence with historical provenance context at final closeout', () => {
                    writeWorkflowConfig(tmpDir, false);
                    const implementationFile = 'src/reused-positive.ts';
                    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
                    fs.writeFileSync(path.join(tmpDir, implementationFile), 'export const reusedPositive = true;\n', 'utf8');
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FULL_PATH',
                        changed_files: [implementationFile],
                        metrics: { changed_lines_total: 8 },
                        required_reviews: { code: true }
                    });
                    const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
                    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
                    const preflightSha256 = computeFileSha256(preflightPath);
                    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflight, tmpDir).review_scope_sha256;
                    const codeScopeSha256 = computeReviewReuseCodeScopeFingerprint('code', preflight, tmpDir).code_scope_sha256;
                    const reviewType = 'code';
                    const reviewerIdentity = 'agent:historical-code-reviewer';
                    const reviewContent = [
                        '# Code Review',
                        'Historical reused code review remains applicable.',
                        '## Findings by Severity',
                        'none',
                        '## Residual Risks',
                        'none',
                        '## Verdict',
                        'REVIEW PASSED',
                        ''
                    ].join('\n');
                    const artifactPath = path.join(reviewsDir, `${TASK_ID}-${reviewType}.md`);
                    fs.writeFileSync(artifactPath, reviewContent, 'utf8');
                    const artifactSha256 = computeFileSha256(artifactPath);
                    const artifactSnapshotPath = path.join(reviewsDir, `${TASK_ID}-${reviewType}-artifact-${artifactSha256}.md`);
                    fs.copyFileSync(artifactPath, artifactSnapshotPath);
                    const sourceTreeStateSha256 = '3'.repeat(64);
                    const currentTreeStateSha256 = 'c'.repeat(64);
                    const sourceContext = {
                        schema_version: 1,
                        review_type: reviewType,
                        depth: 2,
                        token_economy_active: true,
                        required_review: true,
                        reviewer_routing: makeDelegatedRouting(reviewerIdentity),
                        tree_state: { tree_state_sha256: sourceTreeStateSha256 }
                    };
                    const currentContext = {
                        ...sourceContext,
                        tree_state: { tree_state_sha256: currentTreeStateSha256 },
                        current_reuse_materialization: true
                    };
                    const sourceContextSha256 = createHash('sha256').update(JSON.stringify(sourceContext), 'utf8').digest('hex');
                    writeArtifact(reviewsDir, TASK_ID, `-${reviewType}-review-context.json`, currentContext);
                    const currentContextSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-${reviewType}-review-context.json`));
                    const reviewContextReuseSha256 = computeReviewContextReuseHash(currentContext);
                    assert.ok(reviewContextReuseSha256);
                    const routingEventSha256 = '6'.repeat(64);
                    const [taskModeEvent, rulePackEvent] = writeIntegrityEventSequence(eventsDir, TASK_ID, [
                        { event_type: 'TASK_MODE_ENTERED' },
                        { event_type: 'RULE_PACK_LOADED' },
                        { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                        { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                        { event_type: 'PREFLIGHT_CLASSIFIED' }
                    ]);
                    void taskModeEvent;
                    const invocationEvent = appendIntegrityEvent(eventsDir, TASK_ID, {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        details: {
                            task_id: TASK_ID,
                            review_type: reviewType,
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: reviewerIdentity,
                            review_context_sha256: sourceContextSha256,
                            review_tree_state_sha256: sourceTreeStateSha256,
                            routing_event_sha256: routingEventSha256
                        }
                    });
                    const invocationIntegrity = invocationEvent.integrity as Record<string, unknown>;
                    const provenance = {
                        schema_version: 1,
                        attestation_type: 'reviewer_invocation_attestation',
                        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        task_sequence: invocationIntegrity.task_sequence,
                        prev_event_sha256: invocationIntegrity.prev_event_sha256,
                        event_sha256: invocationIntegrity.event_sha256,
                        task_id: TASK_ID,
                        review_type: reviewType,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: reviewerIdentity,
                        review_context_sha256: sourceContextSha256,
                        review_tree_state_sha256: sourceTreeStateSha256,
                        routing_event_sha256: routingEventSha256
                    };
                    const baseReceipt = {
                        schema_version: 2,
                        task_id: TASK_ID,
                        review_type: reviewType,
                        preflight_sha256: preflightSha256,
                        review_artifact_sha256: artifactSha256,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: reviewerIdentity,
                        reviewer_fallback_reason: null,
                        reviewer_provenance: provenance,
                        trust_level: 'INDEPENDENT_AUDITED'
                    };
                    const sourceReceipt = {
                        ...baseReceipt,
                        review_context_sha256: sourceContextSha256,
                        review_context_reuse_sha256: reviewContextReuseSha256,
                        review_tree_state_sha256: sourceTreeStateSha256,
                        review_scope_sha256: reviewScopeSha256,
                        code_scope_sha256: codeScopeSha256,
                        reused_existing_review: false
                    };
                    const receiptPath = path.join(reviewsDir, `${TASK_ID}-${reviewType}-receipt.json`);
                    fs.writeFileSync(receiptPath, JSON.stringify(sourceReceipt), 'utf8');
                    const sourceReceiptSha256 = computeFileSha256(receiptPath);
                    const sourceReceiptSnapshotPath = path.join(reviewsDir, `${TASK_ID}-${reviewType}-receipt-${sourceReceiptSha256}.json`);
                    fs.copyFileSync(receiptPath, sourceReceiptSnapshotPath);
                    appendIntegrityEvent(eventsDir, TASK_ID, {
                        event_type: 'REVIEW_RECORDED',
                        details: {
                            ...sourceReceipt,
                            receipt_path: receiptPath,
                            receipt_sha256: sourceReceiptSha256,
                            receipt_snapshot_path: sourceReceiptSnapshotPath,
                            receipt_snapshot_sha256: sourceReceiptSha256,
                            review_artifact_path: artifactPath,
                            review_artifact_sha256: artifactSha256,
                            review_artifact_snapshot_path: artifactSnapshotPath,
                            review_artifact_snapshot_sha256: artifactSha256
                        }
                    });
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'COMPILE_GATE_PASSED' });
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_PHASE_STARTED' });
                    const reusedReceipt = {
                        ...baseReceipt,
                        review_context_sha256: currentContextSha256,
                        review_context_reuse_sha256: reviewContextReuseSha256,
                        review_tree_state_sha256: currentTreeStateSha256,
                        review_scope_sha256: reviewScopeSha256,
                        code_scope_sha256: codeScopeSha256,
                        reused_existing_review: true,
                        reused_from_receipt_path: receiptPath,
                        reused_from_receipt_sha256: sourceReceiptSha256,
                        reused_from_review_context_sha256: sourceContextSha256,
                        reused_from_review_context_reuse_sha256: reviewContextReuseSha256,
                        reused_from_review_tree_state_sha256: sourceTreeStateSha256,
                        reused_from_review_scope_sha256: reviewScopeSha256,
                        reused_from_code_scope_sha256: codeScopeSha256
                    };
                    fs.writeFileSync(receiptPath, JSON.stringify(reusedReceipt), 'utf8');
                    const reusedReceiptSha256 = computeFileSha256(receiptPath);
                    const reusedReceiptSnapshotPath = path.join(reviewsDir, `${TASK_ID}-${reviewType}-receipt-${reusedReceiptSha256}.json`);
                    fs.copyFileSync(receiptPath, reusedReceiptSnapshotPath);
                    appendIntegrityEvent(eventsDir, TASK_ID, {
                        event_type: 'REVIEW_RECORDED',
                        details: {
                            ...reusedReceipt,
                            receipt_path: receiptPath,
                            receipt_sha256: reusedReceiptSha256,
                            receipt_snapshot_path: reusedReceiptSnapshotPath,
                            receipt_snapshot_sha256: reusedReceiptSha256,
                            review_artifact_path: artifactPath,
                            review_artifact_sha256: artifactSha256,
                            review_artifact_snapshot_path: artifactSnapshotPath,
                            review_artifact_snapshot_sha256: artifactSha256
                        }
                    });
                    writeArtifact(reviewsDir, TASK_ID, '-review-gate.json', {
                        task_id: TASK_ID,
                        status: 'PASSED',
                        outcome: 'PASS',
                        preflight_hash_sha256: preflightSha256,
                        required_reviews: { code: true },
                        verdicts: { code: 'REVIEW PASSED' },
                        review_authorship_attestation: passedReviewAuthorshipAttestation('code'),
                        review_checks: {
                            code: {
                                ...makeIndependentReviewGateCheck('REVIEW PASSED', reviewerIdentity),
                                reused_existing_review: true
                            }
                        }
                    });
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_GATE_PASSED' });
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'DOC_IMPACT_ASSESSED' });
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'COMPLETION_GATE_PASSED' });
                    assert.ok(rulePackEvent);

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    const blockerDetails = [
                        result.final_report_contract.blocker,
                        JSON.stringify(result.blockers),
                        JSON.stringify(result.final_closeout.review_integrity_attestation?.observed_issues || [])
                    ].filter(Boolean).join(' | ');
                    assert.equal(result.final_closeout.status, 'READY', blockerDetails);
                    assertReviewIntegrity(result, 'INDEPENDENT_REVIEW_ATTESTED', {
                        completionReviewAttested: true,
                        completionAllowed: true,
                        enforcementMode: 'BLOCKING'
                    });
                });

                it('blocks stale telemetry closeout through review integrity enforcement', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FULL_PATH',
                        changed_files: ['src/gates/task-audit-summary.ts'],
                        metrics: { changed_lines_total: 18 },
                        required_reviews: { code: true }
                    });
                    const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
                    writeCurrentIndependentReviewFixture({
                        reviewsDir,
                        taskId: TASK_ID,
                        preflightSha256
                    });
                    const reviewRecordedDetails = buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
                    writePassedLifecycleWithReviewRecorded(eventsDir, TASK_ID, reviewRecordedDetails, 'after-review-gate');

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    assert.equal(result.status, 'BLOCKED');
                    assertReviewIntegrityBlocksFinalCloseout(result, 'review recorded after current required-reviews gate');
                    assert.ok(result.blockers.some((blocker) =>
                        blocker.gate === 'required-reviews-check'
                        && blocker.reason.includes('Required review evidence changed after REVIEW_GATE_PASSED')
                    ));
                });
            });

            describe('unsafe review type enforcement reporting', () => {
                it('allowlists required review types before review artifact path construction', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePassedLifecycle(eventsDir, TASK_ID);
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FULL_PATH',
                        changed_files: ['src/gates/task-audit-summary.ts'],
                        metrics: { changed_lines_total: 18 },
                        required_reviews: { '../../../outside': true }
                    });

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    const attestation = assertReviewIntegrityBlocksFinalCloseout(
                        result,
                        'unsafe or unknown required review type ignored'
                    );
                    assert.deepEqual(attestation.required_review_types, []);
                });
            });
        });

        it('does not promote asserted-local review gate checks to independent trust', () => {
            const summary = readReviewTrustSummaryFromReviewGate(
                {
                    task_id: TASK_ID,
                    status: 'PASSED',
                    outcome: 'PASS',
                    preflight_hash_sha256: 'a'.repeat(64),
                    required_reviews: { code: true },
                    review_checks: {
                        code: {
                            required: true,
                            skipped_by_override: false,
                            receipt_valid: true,
                            reviewer_execution_mode: 'same_agent_fallback',
                            reviewer_identity: `self:${TASK_ID}`,
                            reviewer_fallback_reason: 'provider limitation',
                            trust_level: 'LOCAL_ASSERTED'
                        }
                    }
                },
                { code: true },
                TASK_ID,
                'code',
                'a'.repeat(64)
            );

            assert.equal(summary, null);
        });

        it('degrades review trust summary when required review trust evidence is incomplete or invalid', () => {
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                reviewer_provenance: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:test-reviewer',
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'INDEPENDENT_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true, test: true },
                reviewsDir,
                TASK_ID,
                'code'
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the current review artifact no longer matches the receipt hash', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                review_artifact_sha256: crypto.createHash('sha256').update('# Code Review\nREVIEW PASSED - stale', 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code'
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps current-cycle trust unavailable when a required review receipt omits review_artifact_sha256', () => {
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: null,
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the receipt preflight hash no longer matches the current preflight', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: 'stale-preflight-hash',
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback receipt omits reviewer_fallback_reason', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code'
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when delegated_subagent receipt uses a self-scoped reviewer identity', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code'
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps trust unavailable when REVIEW_RECORDED telemetry points to a deprecated same_agent_fallback context at a noncanonical path', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            const customReviewContextPath = path.join(reviewsDir, 'custom-code-review-context.json');
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            fs.writeFileSync(customReviewContextPath, JSON.stringify({
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            }, null, 2) + '\n', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(customReviewContextPath),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the current review context routing diverges from the receipt', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: null
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback routing conflicts with a delegation-required policy', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'delegation_required',
                    delegation_required: true,
                    expected_execution_mode: 'delegated_subagent',
                    fallback_allowed: false,
                    fallback_reason_required: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when delegated_subagent routing conflicts with a same-agent-only policy', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: null,
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback uses a non-self-scoped routing identity', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: 'provider limitation'
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback review-context omits fallback_reason', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: null
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps same_agent_fallback review-context unavailable even when legacy policy marked fallback_reason optional', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: null,
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });
    });
});
