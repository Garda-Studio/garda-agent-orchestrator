import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assessUpstreamReviewDependencyStatus,
    resolveValidatedUpstreamReviewDependencyStatus,
    type ReviewDependencyTimelineEvent
} from '../../../../src/gates/review/review-dependencies';
import { resolveLockedReviewFindingPolicyFromPreflight } from '../../../../src/gates/review/review-finding-disposition';
import { getReviewFindingsEvidenceFromValidationArtifact } from '../../../../src/gates/completion/completion-verdict-findings';
import { type ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import { writeSchema4ReviewPackage } from './review-execution-lineage-test-fixture';

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function sha256Buffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

function writeReviewArtifactAndRefreshReceipt(fixture: {
    reviewArtifactPath: string;
    receiptPath: string;
}, content: string): void {
    fs.writeFileSync(fixture.reviewArtifactPath, content, 'utf8');
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.review_artifact_sha256 = sha256Buffer(fs.readFileSync(fixture.reviewArtifactPath));
    writeJson(fixture.receiptPath, receipt);
}

function buildReviewFindingsJsonArtifact(options: {
    taskId: string;
    reviewContextSha256?: string;
    coverageContractSha256?: string;
    residualRisks?: string[];
    malformedLegacyShape?: boolean;
}): string {
    if (options.malformedLegacyShape) {
        return JSON.stringify({
            schema_version: 1,
            task_id: options.taskId,
            review_type: 'code',
            review_context_sha256: options.reviewContextSha256 || 'a'.repeat(64),
            tree_state_sha256: 'b'.repeat(64),
            validation_evidence: {
                compile_gate: {
                    command: 'npm run build',
                    status: 'passed',
                    recorded_at_utc: '2026-07-13T00:00:00.000Z'
                }
            },
            coverage_ledger: {
                entries: []
            },
            findings: {
                critical: [],
                high: [],
                medium: [],
                low: []
            },
            residual_risks: options.residualRisks || [],
            notes: []
        }, null, 2) + '\n';
    }
    return JSON.stringify({
        schema_version: 1,
        task_id: options.taskId,
        review_type: 'code',
        review_context_sha256: options.reviewContextSha256 || 'a'.repeat(64),
        tree_state_sha256: 'b'.repeat(64),
        validation_notes: [{
            id: 'N-001',
            topic: 'dependency-reader',
            note: 'Reviewed the dependency reader JSON artifact path.',
            evidence: [{
                location: 'src/gates/review/review-dependencies.ts:280',
                observation: 'The dependency reader derives upstream state from strict findings JSON.'
            }]
        }],
        coverage_ledger: {
            coverage_contract_sha256: options.coverageContractSha256 || 'c'.repeat(64),
            entries: [{
                obligation_id: 'FILE-001',
                evidence: [{
                    location: 'src/gates/review/review-dependencies.ts:280',
                    observation: 'The dependency reader path was inspected.'
                }],
                finding_ids: options.residualRisks && options.residualRisks.length > 0 ? [] : []
            }]
        },
        findings: {
            critical: [],
            high: [],
            medium: [],
            low: []
        },
        residual_risks: (options.residualRisks || []).map((description, index) => ({
            id: `R-${String(index + 1).padStart(3, '0')}`,
            description,
            evidence: [{
                location: 'src/gates/review/review-dependencies.ts:280',
                observation: 'The dependency reader treats residual risks as active upstream blockers.'
            }]
        })),
        reviewer_notes: ['No reviewer-owned verdict fields are present.']
    }, null, 2) + '\n';
}


function createReviewDependencyTaxonomyFixture(options: {
    taskId: string;
    receipt?: boolean;
    receiptPreflightSha256?: string;
    context?: boolean;
}): {
    repoRoot: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    timelineEvents: ReviewDependencyTimelineEvent[];
    latestRecordedReviewByType: Map<string, ReviewDependencyTimelineEvent>;
    reviewArtifactPath: string;
    reviewContextPath: string;
    receiptPath: string;
    preflightSha256: string;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependency-taxonomy-'));
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, `${options.taskId}-preflight.json`);
    const preflightPayload = {
        task_id: options.taskId,
        detection_source: 'git_auto',
        include_untracked: true,
        changed_files: ['src/gates/review/review-dependencies.ts'],
        metrics: {
            scope_sha256: 'd'.repeat(64),
            changed_files_sha256: 'd'.repeat(64)
        },
        required_reviews: {
            code: true,
            test: true
        },
        review_execution_policy: {
            mode: 'test_after_code'
        }
    };
    writeJson(preflightPath, preflightPayload);
    const preflightSha256 = sha256Buffer(fs.readFileSync(preflightPath));
    const reviewArtifactPath = path.join(reviewsRoot, `${options.taskId}-code.md`);
    const reviewContextPath = path.join(reviewsRoot, `${options.taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${options.taskId}-code-receipt.json`);
    fs.writeFileSync(reviewArtifactPath, [
        '# Review',
        '',
        'Validated current-cycle upstream review dependency diagnostics.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'REVIEW PASSED'
    ].join('\n'), 'utf8');
    if (options.context !== false) {
        writeJson(reviewContextPath, {
            task_id: options.taskId,
            review_type: 'code'
        });
    }
    if (options.receipt !== false) {
        writeJson(receiptPath, {
            task_id: options.taskId,
            review_type: 'code',
            preflight_sha256: options.receiptPreflightSha256 || preflightSha256,
            review_artifact_sha256: sha256Buffer(fs.readFileSync(reviewArtifactPath))
        });
    }
    const recordedEvent: ReviewDependencyTimelineEvent = {
        event_type: 'REVIEW_RECORDED',
        sequence: 2,
        details: {
            review_type: 'code',
            review_context_path: reviewContextPath
        }
    };
    return {
        repoRoot,
        preflightPath,
        preflightPayload,
        timelineEvents: [
            {
                event_type: 'COMPILE_GATE_PASSED',
                sequence: 1,
                details: {
                    preflight_path: preflightPath
                }
            },
            recordedEvent
        ],
        latestRecordedReviewByType: new Map([['code', recordedEvent]]),
        reviewArtifactPath,
        reviewContextPath,
        receiptPath,
        preflightSha256
    };
}

test('assessUpstreamReviewDependencyStatus classifies missing receipt blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-missing-receipt',
        receipt: false
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-missing-receipt',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'missing_receipt');
        assert.match(result.reason, /missing or invalid review receipt JSON/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus classifies stale freshness blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-stale-freshness',
        receiptPreflightSha256: '0'.repeat(64)
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-stale-freshness',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'stale_freshness');
        assert.match(result.reason, /not bound to the current preflight/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus classifies missing context blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-missing-context',
        context: false
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-missing-context',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'missing_context');
        assert.match(result.reason, /missing or invalid review-context artifact/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus accepts verdict-free JSON artifacts with no active findings as upstream pass', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-979-json-pass'
    });
    try {
        writeSchema4ReviewPackage({
            reviewsRoot: path.dirname(fixture.preflightPath),
            repoRoot: fixture.repoRoot,
            taskId: 'T-979-json-pass',
            reviewType: 'code',
            preflightPath: fixture.preflightPath,
            preflight: fixture.preflightPayload
        });

        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-979-json-pass',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.notEqual(result.blockerCode, 'missing_upstream_pass');
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus rejects malformed verdict-free JSON artifacts as missing upstream pass', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-979-json-malformed'
    });
    try {
        writeReviewArtifactAndRefreshReceipt(
            fixture,
            buildReviewFindingsJsonArtifact({
                taskId: 'T-979-json-malformed',
                malformedLegacyShape: true
            })
        );

        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-979-json-malformed',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'missing_upstream_pass');
        assert.match(result.reason, /review artifact verdict is 'missing'/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus blocks verdict-free JSON residual risks under strict fallback policy', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-979-json-residual-risk'
    });
    try {
        writeSchema4ReviewPackage({
            reviewsRoot: path.dirname(fixture.preflightPath),
            repoRoot: fixture.repoRoot,
            taskId: 'T-979-json-residual-risk',
            reviewType: 'code',
            preflightPath: fixture.preflightPath,
            preflight: fixture.preflightPayload,
            residualRisks: ['Residual risk requires implementation follow-up before dependent reviews.']
        });

        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-979-json-residual-risk',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'stale_freshness');
        assert.match(result.reason, /fix_now residual risks/u);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus permits non-blocking findings under the locked profile policy', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-979-json-non-blocking-finding'
    });
    try {
        fixture.preflightPayload.profile_policy_snapshot = {
            review_finding_policy: {
                schema_version: 1,
                policy_id: 'custom',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        };
        writeJson(fixture.preflightPath, fixture.preflightPayload);
        const currentPreflightSha256 = sha256Buffer(fs.readFileSync(fixture.preflightPath));
        const reviewPackage = writeSchema4ReviewPackage({
            reviewsRoot: path.dirname(fixture.preflightPath),
            repoRoot: fixture.repoRoot,
            taskId: 'T-979-json-non-blocking-finding',
            reviewType: 'code',
            preflightPath: fixture.preflightPath,
            preflight: fixture.preflightPayload,
            residualRisks: ['Residual risk is assigned to a follow-up task by the locked profile policy.']
        });

        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-979-json-non-blocking-finding',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: currentPreflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.notEqual(result.blockerCode, 'missing_upstream_pass');
        const findingsEvidence = getReviewFindingsEvidenceFromValidationArtifact(
            reviewPackage.artifactPath,
            JSON.parse(fs.readFileSync(
                reviewPackage.validationArtifactPath,
                'utf8'
            )) as ReviewFindingsValidationArtifact,
            resolveLockedReviewFindingPolicyFromPreflight(fixture.preflightPayload)
        );
        assert.equal(findingsEvidence.residual_risks.length, 1);
        const dispositionStatus = resolveValidatedUpstreamReviewDependencyStatus('code', {
            violations: [],
            findingsEvidence
        });
        assert.equal(dispositionStatus.ready, true, dispositionStatus.reason);
        assert.equal(dispositionStatus.blockerCode, null);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});
