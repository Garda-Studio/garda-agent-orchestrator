import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileReviewDependencyGraph } from '../../../../src/core/review-dependency-graph';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import {
    buildAuthenticatedRemediationReviewExecution,
    resolvePersistedRemediationReusePolicy,
    shouldAcceptCurrentPassReviewEvidence
} from '../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import {
    buildReviewRemediationRecoveryRoute,
    getAuthoritativeReviewRemediationDecisionViolations,
    resolveAuthoritativeReviewRemediationDecision,
    type AuthoritativeReviewRemediationDecision,
    type BuildReviewRemediationRecoveryRouteOptions,
    type ResolveAuthoritativeReviewRemediationDecisionOptions,
    type ReviewRemediationDecisionClassification,
    type ReviewRemediationCompletedReceipt,
    type ReviewRemediationModePolicyValidationInputs,
    type ReviewRemediationReusableReceipt
} from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import type { ReviewRemediationDeltaClassification } from '../../../../src/gates/review-remediation/review-remediation-delta';
import { buildReviewRemediationReadableDiffEvidence } from '../../../../src/gates/review-remediation/review-remediation-readable-diff';
import {
    buildReviewRemediationValidationEvidence,
    type BuildReviewRemediationValidationComponentInput,
    type ReviewRemediationValidationArtifactState
} from '../../../../src/gates/review-remediation/review-remediation-validation-evidence';
import {
    buildDefaultReviewRemediationRerunPolicy,
    type ReviewRemediationDeltaCategory
} from '../../../../src/policy/review-remediation-rerun-policy';
import {
    buildDefaultReviewRemediationModePolicy,
    evaluateReviewRemediationMode
} from '../../../../src/policy/review-remediation-mode-policy';

const TASK_ID = 'T-979-40-fixture';
const REVIEWS_ROOT = 'garda-agent-orchestrator/runtime/reviews';

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

interface PersistedReusePolicyFixture {
    root: string;
    bundleRoot: string;
    preflightPath: string;
    preflightSha256: string;
    timelinePath: string;
}

function makePersistedReusePolicyFixture(): PersistedReusePolicyFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-persisted-remediation-policy-'));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${TASK_ID}.jsonl`);
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    const preflightContents = '{"schema_version":1}\n';
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(preflightPath, preflightContents, 'utf8');
    return {
        root,
        bundleRoot,
        preflightPath,
        preflightSha256: hash(preflightContents),
        timelinePath
    };
}

function appendRestartDecision(
    fixture: PersistedReusePolicyFixture,
    decision: AuthoritativeReviewRemediationDecision,
    classification?: ReviewRemediationDecisionClassification
): void {
    appendTaskEvent(
        fixture.bundleRoot,
        TASK_ID,
        'REVIEW_CYCLE_RESTARTED',
        'PASS',
        'Review cycle restarted.',
        {
            task_id: TASK_ID,
            event_type: 'REVIEW_CYCLE_RESTARTED',
            status: 'PASSED',
            preflight_sha256: fixture.preflightSha256,
            authoritative_review_decision: decision,
            ...(classification === undefined
                ? {}
                : { authoritative_review_classification: classification })
        }
    );
}

function appendRecordedReview(
    fixture: PersistedReusePolicyFixture,
    reusedExistingReview: boolean
): void {
    appendTaskEvent(
        fixture.bundleRoot,
        TASK_ID,
        'REVIEW_RECORDED',
        'PASS',
        'Review recorded.',
        {
            task_id: TASK_ID,
            review_type: 'test',
            preflight_sha256: fixture.preflightSha256,
            reused_existing_review: reusedExistingReview,
            review_findings_disposition: {
                verdict: 'pass_no_findings'
            }
        }
    );
}

function readPersistedPolicyEvents(fixture: PersistedReusePolicyFixture): Record<string, unknown>[] {
    return fs.readFileSync(fixture.timelinePath, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resolvePersistedPolicy(
    fixture: PersistedReusePolicyFixture,
    reviewType: string,
    authenticatedFreshPassReviewEvidence?: {
        reviewRecordedSequence: number;
        remediationMode: string | null;
        authoritativeDecisionSha256: string | null;
        classificationSha256: string | null;
    }
): { blockedReason: string; preservedScopeMismatchReason: string } {
    return resolvePersistedRemediationReusePolicy({
        events: readPersistedPolicyEvents(fixture),
        taskId: TASK_ID,
        reviewType,
        preflightPath: fixture.preflightPath,
        timelinePath: fixture.timelinePath,
        authenticatedFreshPassReviewEvidence
    });
}

function latestReviewRecordedSequence(fixture: PersistedReusePolicyFixture): number {
    const events = readPersistedPolicyEvents(fixture);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].event_type === 'REVIEW_RECORDED') {
            return Number((events[index].integrity as Record<string, unknown> | undefined)?.task_sequence) || 0;
        }
    }
    return 0;
}

function makeSnapshot(): Record<string, unknown> {
    return {
        schema_version: 1,
        review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy(),
        review_remediation_rerun_policy_diagnostics: ['fixture policy'],
        review_remediation_mode_policy: buildDefaultReviewRemediationModePolicy(),
        review_remediation_mode_policy_diagnostics: ['fixture mode policy']
    };
}

function makeDelta(
    category: ReviewRemediationDeltaCategory,
    reviewType = 'test',
    changedFile = 'tests/node/example.test.ts'
): ReviewRemediationDeltaClassification {
    const changedLine = 'assert.equal(actual, expected);\n';
    const modePolicy = buildDefaultReviewRemediationModePolicy();
    const modePolicyAssessment = evaluateReviewRemediationMode({
        policy: modePolicy,
        reviewType,
        category,
        changedFilesCount: 1,
        changedLinesTotal: 1,
        consecutiveDeltaReviews: 0
    });
    const core: Omit<ReviewRemediationDeltaClassification, 'classification_sha256'> = {
        schema_version: 1,
        task_id: TASK_ID,
        review_type: reviewType,
        status: 'CLASSIFIED',
        category,
        reason: `fixture category ${category}`,
        baseline: {
            artifact_path: `${REVIEWS_ROOT}/${TASK_ID}-${reviewType}-remediation-baseline.json`,
            artifact_sha256: hash('baseline'),
            review_tree_state_sha256: hash('tree'),
            delta_base_snapshot_sha256: hash('delta-base')
        },
        current_snapshot_sha256: hash('current'),
        full_review_required: modePolicyAssessment.mode === 'FULL',
        full_review_reasons: modePolicyAssessment.full_review_reasons,
        scope: {
            full_review_scope: [changedFile],
            full_review_scope_sha256: hash(changedFile),
            required_delta_targets: [changedFile],
            required_delta_targets_sha256: hash(changedFile),
            optional_context_files: [],
            optional_context_files_sha256: hash(''),
            membership_unchanged: true
        },
        changed_files: [changedFile],
        unchanged_files: [],
        file_deltas: [{
            path: changedFile,
            operation: 'modified',
            category,
            reason: `fixture category ${category}`,
            baseline_status: 'text',
            current_status: 'text',
            baseline_mode: 0o100644,
            current_mode: 0o100644,
            baseline_content_sha256: hash('baseline-content'),
            current_content_sha256: hash('current-content'),
            baseline_line_count: 0,
            current_line_count: 1,
            additions: 1,
            deletions: 0,
            changed_lines: 1
        }],
        additions_total: 1,
        deletions_total: 0,
        changed_lines_total: 1,
        readable_diff: buildReviewRemediationReadableDiffEvidence([{
            path: changedFile,
            lines: [{
                operation: 'addition',
                baseline_line: null,
                current_line: 1,
                segment_index: 1,
                segment_count: 1,
                text: changedLine,
                source_line_sha256: hash(changedLine)
            }]
        }]),
        mode_policy_assessment: modePolicyAssessment
    };
    return {
        ...core,
        classification_sha256: sha256RedactedJsonPayload(core)
    };
}

function rehashDelta(delta: ReviewRemediationDeltaClassification): ReviewRemediationDeltaClassification {
    const { classification_sha256: _, ...core } = delta;
    return {
        ...core,
        classification_sha256: sha256RedactedJsonPayload(core)
    };
}

function modePolicyValidationInputs(
    overrides: Partial<ReviewRemediationModePolicyValidationInputs> = {}
): ReviewRemediationModePolicyValidationInputs {
    return {
        consecutiveDeltaReviews: 0,
        protectedBoundarySignals: [],
        taskCriteriaChanged: false,
        policyChanged: false,
        uncertainCrossFileImpact: false,
        ...overrides
    };
}

function resolveFixtureAuthoritativeDecision(
    options: ResolveAuthoritativeReviewRemediationDecisionOptions,
    validationInputOverrides: Partial<ReviewRemediationModePolicyValidationInputs> = {}
) {
    return resolveAuthoritativeReviewRemediationDecision({
        ...options,
        modePolicyValidationInputs: modePolicyValidationInputs(validationInputOverrides)
    });
}

function component(role: BuildReviewRemediationValidationComponentInput['role']): BuildReviewRemediationValidationComponentInput {
    const full = role === 'full';
    return {
        role,
        sourceKind: full ? 'full_suite_validation' : 'intermediate_command',
        command: full ? 'npm test' : `npm test -- ${role}`,
        status: 'PASSED',
        exitCode: 0,
        sourceArtifactPath: `${REVIEWS_ROOT}/${TASK_ID}-${role}-result.json`,
        sourceArtifactSha256: hash(`${role}-result`),
        ...(full
            ? {}
            : {
                outputArtifactPath: `${REVIEWS_ROOT}/${TASK_ID}-${role}-output.log`,
                outputArtifactSha256: hash(`${role}-output`),
                outputArtifactSizeBytes: 64
            })
    };
}

function readArtifactState(artifactPath: string): ReviewRemediationValidationArtifactState | null {
    if (/(?:-code|-test)-remediation-baseline\.json$/u.test(artifactPath)) {
        return { sha256: hash('baseline'), size_bytes: 1 };
    }
    for (const role of ['focused', 'affected', 'expanded', 'full'] as const) {
        if (artifactPath.endsWith(`-${role}-result.json`)) {
            return {
                sha256: hash(`${role}-result`),
                size_bytes: 1,
                source_kind: role === 'full' ? 'full_suite_validation' : 'intermediate_command',
                command: role === 'full' ? 'npm test' : `npm test -- ${role}`,
                status: 'PASSED',
                exit_code: 0
            };
        }
        if (artifactPath.endsWith(`-${role}-output.log`)) {
            return { sha256: hash(`${role}-output`), size_bytes: 64 };
        }
    }
    for (const reviewType of ['code', 'security', 'refactor', 'test']) {
        if (artifactPath.endsWith(`-${reviewType}-receipt.json`)) {
            return { sha256: hash(`${reviewType}-receipt`), size_bytes: 1 };
        }
    }
    return null;
}

function validationEvidence(category: ReviewRemediationDeltaCategory, reviewType = 'test') {
    const roles = category === 'leaf_test'
        ? ['focused'] as const
        : category === 'structural_test'
            ? ['focused', 'affected'] as const
            : ['expanded'] as const;
    return buildReviewRemediationValidationEvidence({
        reviewsRoot: REVIEWS_ROOT,
        artifactStateReader: readArtifactState,
        delta: makeDelta(category, reviewType),
        components: roles.map(component)
    });
}

const validationCommands = {
    focused: { command: 'node run-focused.js' },
    focused_and_affected: { command: 'node run-focused-affected.js' },
    ordinary: { command: 'node bin/garda.js gate full-suite-validation --task-id T-979-40-fixture' }
};

const reviewCommands = {
    code: { command: 'node review-code.js' },
    security: { command: 'node review-security.js' },
    refactor: { command: 'node review-refactor.js' },
    test: { command: 'node review-test.js' },
    'architecture-boundary': { command: 'node review-architecture-boundary.js' }
};

function acceptedReceipt(reviewType: string): ReviewRemediationReusableReceipt {
    return {
        review_type: reviewType,
        reuse_status: 'ACCEPTED',
        findings_satisfied: true
    };
}

function freshReceipt(reviewType: string): ReviewRemediationReusableReceipt {
    return {
        review_type: reviewType,
        reuse_status: 'ACCEPTED',
        findings_satisfied: true,
        evidence_kind: 'FRESH'
    };
}

function completedReceipt(
    reviewType: string,
    evidence: ReturnType<typeof validationEvidence>
): ReviewRemediationCompletedReceipt {
    return {
        schema_version: 1,
        task_id: TASK_ID,
        review_type: reviewType,
        status: 'ACCEPTED',
        findings_satisfied: true,
        review_context_sha256: hash(`${reviewType}-context`),
        delta_classification_sha256: evidence.remediation_bindings.delta_classification_sha256,
        validation_evidence_sha256: sha256RedactedJsonPayload(evidence),
        receipt_artifact_path: `${REVIEWS_ROOT}/${TASK_ID}-${reviewType}-receipt.json`,
        receipt_artifact_sha256: hash(`${reviewType}-receipt`)
    };
}

function routeOptions(
    category: ReviewRemediationDeltaCategory,
    overrides: Partial<BuildReviewRemediationRecoveryRouteOptions> = {}
): BuildReviewRemediationRecoveryRouteOptions {
    const profilePolicySnapshot = makeSnapshot();
    return {
        taskId: TASK_ID,
        currentReviewType: 'test',
        profilePolicySnapshot,
        baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot),
        delta: makeDelta(category),
        requiredReviews: { code: true, refactor: true, test: true },
        reviewExecutionPolicyMode: 'strict_sequential',
        modePolicyValidationInputs: modePolicyValidationInputs(),
        reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('refactor'), acceptedReceipt('test')],
        completedReceipts: [],
        reviewContextSha256ByType: {
            code: hash('code-context'),
            security: hash('security-context'),
            refactor: hash('refactor-context'),
            test: hash('test-context')
        },
        validationCommands,
        reviewCommands,
        reviewsRoot: REVIEWS_ROOT,
        artifactStateReader: readArtifactState,
        ...overrides
    };
}

describe('review remediation selective recovery routing', () => {
    it('allows fresh current-pass evidence through a reuse block without allowing reused evidence', () => {
        const blockedReason = 'invalidated remediation lane requires a fresh review';

        assert.equal(shouldAcceptCurrentPassReviewEvidence({
            accepted: true,
            reusedExistingReview: false
        }, blockedReason), true);
        assert.equal(shouldAcceptCurrentPassReviewEvidence({
            accepted: true,
            reusedExistingReview: true
        }, blockedReason), false);
        assert.equal(shouldAcceptCurrentPassReviewEvidence({
            accepted: false,
            reusedExistingReview: false
        }, blockedReason), false);
    });

    it('authenticates a task-wide FULL lane when remediation originated in another failed lane', () => {
        const profilePolicySnapshot = makeSnapshot();
        const delta = makeDelta('ambiguous', 'test');
        const classification = {
            source: 'delta' as const,
            delta,
            profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
        };
        const unboundDecision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'test',
            classification,
            requiredReviews: { code: true, test: true },
            reviewExecutionPolicyMode: 'strict_sequential'
        });
        assert.deepEqual(
            unboundDecision.lane_decisions.map((entry) => [entry.review_type, entry.mode]),
            [['code', 'FULL'], ['test', 'FULL']]
        );
        const preflightSha256 = hash('preflight');
        const { decision_sha256: _, ...decisionCore } = {
            ...unboundDecision,
            preflight_sha256: preflightSha256
        };
        const authoritativeDecision = {
            ...decisionCore,
            decision_sha256: sha256RedactedJsonPayload(decisionCore)
        };

        const execution = buildAuthenticatedRemediationReviewExecution({
            taskId: TASK_ID,
            reviewType: 'code',
            preflightSha256,
            fullReviewScope: ['tests/node/example.test.ts'],
            authoritativeDecision,
            authoritativeClassification: classification,
            persistedDecisionSha256: authoritativeDecision.decision_sha256
        });

        assert.equal(execution.contract.review_type, 'code');
        assert.equal(execution.contract.mode, 'FULL');
        assert.equal(execution.contract.source, 'remediation_full');
        assert.equal(execution.contract.delta, null);
    });

    it('applies a valid persisted authoritative REUSE decision from the task-event timeline', () => {
        const fixture = makePersistedReusePolicyFixture();
        try {
            const profilePolicySnapshot = makeSnapshot();
            appendRestartDecision(fixture, resolveFixtureAuthoritativeDecision({
                taskId: TASK_ID,
                currentReviewType: 'test',
                classification: {
                    source: 'delta',
                    delta: makeDelta('leaf_test'),
                    profilePolicySnapshot,
                    baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
                },
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'strict_sequential',
                reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('test')]
            }));

            const result = resolvePersistedPolicy(fixture, 'code');
            assert.equal(result.blockedReason, '');
            assert.match(result.preservedScopeMismatchReason, /authoritative reuse validation accepted/iu);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('uses the latest matching persisted decision and rejects a missing required lane', () => {
        const fixture = makePersistedReusePolicyFixture();
        try {
            const profilePolicySnapshot = makeSnapshot();
            appendRestartDecision(fixture, resolveFixtureAuthoritativeDecision({
                taskId: TASK_ID,
                currentReviewType: 'test',
                classification: {
                    source: 'delta',
                    delta: makeDelta('leaf_test'),
                    profilePolicySnapshot,
                    baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
                },
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'strict_sequential',
                reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('test')]
            }));
            appendRestartDecision(fixture, resolveFixtureAuthoritativeDecision({
                taskId: TASK_ID,
                currentReviewType: 'code',
                classification: {
                    source: 'delta',
                    delta: makeDelta('leaf_test', 'code'),
                    profilePolicySnapshot,
                    baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
                },
                requiredReviews: { code: true },
                reviewExecutionPolicyMode: 'strict_sequential',
                reusableReceipts: [acceptedReceipt('code')]
            }));

            assert.match(
                resolvePersistedPolicy(fixture, 'test').blockedReason,
                /does not contain required lane 'test'/iu
            );
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects a forged or tampered persisted authoritative decision', () => {
        const fixture = makePersistedReusePolicyFixture();
        try {
            const profilePolicySnapshot = makeSnapshot();
            const decision = resolveFixtureAuthoritativeDecision({
                taskId: TASK_ID,
                currentReviewType: 'test',
                classification: {
                    source: 'delta',
                    delta: makeDelta('leaf_test'),
                    profilePolicySnapshot,
                    baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
                },
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'strict_sequential',
                reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('test')]
            });
            decision.lane_decisions[0].reason = 'tampered persisted reason';
            appendRestartDecision(fixture, decision);
            appendRecordedReview(fixture, false);

            assert.match(
                resolvePersistedPolicy(fixture, 'code', {
                    reviewRecordedSequence: latestReviewRecordedSequence(fixture),
                    remediationMode: 'FULL',
                    authoritativeDecisionSha256: decision.decision_sha256,
                    classificationSha256: decision.classification_sha256
                }).blockedReason,
                /persisted authoritative remediation decision failed validation/iu
            );
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects stale reused evidence before accepting a fresh pass with superseded baseline bindings', () => {
        const fixture = makePersistedReusePolicyFixture();
        try {
            const profilePolicySnapshot = makeSnapshot();
            const classification = {
                source: 'delta' as const,
                delta: makeDelta('leaf_test'),
                profilePolicySnapshot,
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
            };
            const decision = resolveFixtureAuthoritativeDecision({
                taskId: TASK_ID,
                currentReviewType: 'test',
                classification,
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'strict_sequential',
                reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('test')]
            });
            appendRestartDecision(fixture, decision, classification);
            appendRecordedReview(fixture, true);
            assert.match(
                resolvePersistedPolicy(fixture, 'test').blockedReason,
                /persisted remediation authority failed authentication/iu
            );

            appendRecordedReview(fixture, false);
            assert.match(
                resolvePersistedPolicy(fixture, 'test').blockedReason,
                /persisted remediation authority failed authentication/iu
            );
            assert.deepEqual(resolvePersistedPolicy(fixture, 'test', {
                reviewRecordedSequence: latestReviewRecordedSequence(fixture),
                remediationMode: 'DELTA',
                authoritativeDecisionSha256: decision.decision_sha256,
                classificationSha256: decision.classification_sha256
            }), {
                blockedReason: '',
                preservedScopeMismatchReason: ''
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('requires fresh post-restart evidence to bypass an invalidated persisted lane', () => {
        const fixture = makePersistedReusePolicyFixture();
        try {
            const profilePolicySnapshot = makeSnapshot();
            const decision = resolveFixtureAuthoritativeDecision({
                taskId: TASK_ID,
                currentReviewType: 'test',
                classification: {
                    source: 'delta',
                    delta: makeDelta('leaf_test'),
                    profilePolicySnapshot,
                    baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
                },
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'strict_sequential',
                reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('test')]
            });
            appendRestartDecision(fixture, decision);
            appendRecordedReview(fixture, true);
            assert.match(resolvePersistedPolicy(fixture, 'test').blockedReason, /bounded DELTA review is required/iu);

            appendRecordedReview(fixture, false);
            assert.match(resolvePersistedPolicy(fixture, 'test').blockedReason, /bounded DELTA review is required/iu);
            assert.deepEqual(resolvePersistedPolicy(fixture, 'test', {
                reviewRecordedSequence: latestReviewRecordedSequence(fixture),
                remediationMode: 'DELTA',
                authoritativeDecisionSha256: decision.decision_sha256,
                classificationSha256: decision.classification_sha256
            }), {
                blockedReason: '',
                preservedScopeMismatchReason: ''
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('emits one hash-bound REUSE, DELTA, or FULL decision for every effective lane', () => {
        const profilePolicySnapshot = makeSnapshot();
        const decision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'test',
            classification: {
                source: 'delta',
                delta: makeDelta('leaf_test'),
                profilePolicySnapshot,
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
            },
            requiredReviews: { code: true, refactor: true, test: true },
            reviewExecutionPolicyMode: 'strict_sequential',
            reusableReceipts: [
                acceptedReceipt('code'),
                {
                    review_type: 'refactor',
                    reuse_status: 'REJECTED',
                    findings_satisfied: true,
                    reason: 'current context binding is stale'
                },
                acceptedReceipt('test')
            ]
        });

        assert.equal(decision.status, 'READY');
        assert.deepEqual(decision.lane_decisions.map((entry) => ({
            review_type: entry.review_type,
            mode: entry.mode,
            depends_on: entry.depends_on
        })), [
            { review_type: 'code', mode: 'REUSE', depends_on: [] },
            { review_type: 'refactor', mode: 'FULL', depends_on: ['code'] },
            { review_type: 'test', mode: 'DELTA', depends_on: ['code', 'refactor'] }
        ]);
        assert.ok(decision.lane_decisions.every((entry) => /^[0-9a-f]{64}$/u.test(entry.reason_sha256)));
        assert.match(decision.decision_sha256, /^[0-9a-f]{64}$/u);
        assert.equal(decision.lane_decisions[1].reuse_eligible, true);
        assert.equal(decision.lane_decisions[2].reuse_eligible, false);
        assert.deepEqual(getAuthoritativeReviewRemediationDecisionViolations(decision, {
            expectedTaskId: TASK_ID
        }), []);

        const tamperedDecision = structuredClone(decision);
        tamperedDecision.lane_decisions[0].reason = 'forged reuse reason';
        assert.match(
            getAuthoritativeReviewRemediationDecisionViolations(tamperedDecision).join(' '),
            /reason hash is invalid|decision hash is invalid/iu
        );
    });

    it('falls back to FULL before reuse validation and blocks foreign or tampered delta trust', () => {
        const profilePolicySnapshot = makeSnapshot();
        const baseOptions = {
            taskId: TASK_ID,
            currentReviewType: 'test',
            classification: {
                source: 'delta' as const,
                delta: makeDelta('leaf_test'),
                profilePolicySnapshot,
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
            },
            requiredReviews: { code: true, test: true },
            reviewExecutionPolicyMode: 'strict_sequential' as const
        };
        const pending = resolveFixtureAuthoritativeDecision(baseOptions);
        assert.deepEqual(pending.lane_decisions.map((entry) => entry.mode), ['FULL', 'DELTA']);
        assert.match(pending.lane_decisions[0].reason, /reuse validation has not accepted/iu);

        const foreignDelta = makeDelta('leaf_test');
        foreignDelta.task_id = 'T-foreign';
        const foreign = resolveFixtureAuthoritativeDecision({
            ...baseOptions,
            classification: { ...baseOptions.classification, delta: foreignDelta }
        });
        assert.equal(foreign.status, 'BLOCKED');
        assert.deepEqual(foreign.lane_decisions.map((entry) => entry.mode), ['FULL', 'FULL']);
        assert.match(foreign.blocked_reasons.join(' '), /foreign task or review type/iu);

        const tamperedDelta = makeDelta('leaf_test');
        tamperedDelta.classification_sha256 = hash('tampered');
        const tampered = resolveFixtureAuthoritativeDecision({
            ...baseOptions,
            classification: { ...baseOptions.classification, delta: tamperedDelta }
        });
        assert.equal(tampered.status, 'BLOCKED');
        assert.match(tampered.blocked_reasons.join(' '), /classification_sha256/iu);
    });

    it('rejects a self-consistent DELTA assessment that underreports the authenticated periodic-FULL depth', () => {
        const profilePolicySnapshot = makeSnapshot();
        const delta = makeDelta('leaf_test');
        const decision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'test',
            classification: {
                source: 'delta',
                delta: rehashDelta(delta),
                profilePolicySnapshot,
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
            },
            requiredReviews: { code: true, test: true },
            reviewExecutionPolicyMode: 'strict_sequential'
        }, {
            consecutiveDeltaReviews:
                buildDefaultReviewRemediationModePolicy().max_consecutive_delta_reviews
        });

        assert.equal(decision.status, 'BLOCKED');
        assert.match(
            decision.blocked_reasons.join(' '),
            /does not match authenticated timeline and preflight mode-policy inputs/iu
        );
    });

    it('authenticates FULL assessments and keeps lane-local FULL floors from invalidating unrelated lanes', () => {
        const modePolicy = buildDefaultReviewRemediationModePolicy();
        modePolicy.delta_eligible_review_types = modePolicy.delta_eligible_review_types.filter((entry) => (
            entry !== 'code'
        ));
        const profilePolicySnapshot = {
            ...makeSnapshot(),
            review_remediation_mode_policy: modePolicy
        };
        const disabledLaneDelta = makeDelta('production', 'code', 'src/app.ts');
        const disabledLaneAssessment = evaluateReviewRemediationMode({
            policy: modePolicy,
            reviewType: 'code',
            category: 'production',
            changedFilesCount: 1,
            changedLinesTotal: 1,
            consecutiveDeltaReviews: 0
        });
        disabledLaneDelta.mode_policy_assessment = disabledLaneAssessment;
        disabledLaneDelta.full_review_required = true;
        disabledLaneDelta.full_review_reasons = disabledLaneAssessment.full_review_reasons;

        const decision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'code',
            classification: {
                source: 'delta',
                delta: rehashDelta(disabledLaneDelta),
                profilePolicySnapshot,
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
            },
            requiredReviews: { code: true, security: true },
            reviewExecutionPolicyMode: 'strict_sequential',
            reusableReceipts: [acceptedReceipt('security')]
        });

        assert.equal(decision.status, 'READY');
        assert.deepEqual(decision.invalidated_review_types, ['code']);
        assert.deepEqual(decision.preserved_review_types, ['security']);
        assert.deepEqual(decision.lane_decisions.map((entry) => ({
            review_type: entry.review_type,
            mode: entry.mode,
            reason_code: entry.reason_code
        })), [
            {
                review_type: 'code',
                mode: 'FULL',
                reason_code: 'authenticated_snapshot_requires_full_fallback'
            },
            {
                review_type: 'security',
                mode: 'REUSE',
                reason_code: 'authoritative_reuse_accepted'
            }
        ]);
        assert.match(decision.lane_decisions[0].reason, /not DELTA-eligible/iu);

        const externalFullReason = 'remediation file content is unavailable for a trustworthy delta';
        const externallyFlooredDelta = makeDelta('production', 'code', 'src/app.ts');
        const externallyFlooredAssessment = evaluateReviewRemediationMode({
            policy: buildDefaultReviewRemediationModePolicy(),
            reviewType: 'code',
            category: 'production',
            changedFilesCount: 1,
            changedLinesTotal: 1,
            consecutiveDeltaReviews: 0,
            existingFullReviewReasons: [externalFullReason]
        });
        externallyFlooredDelta.mode_policy_assessment = externallyFlooredAssessment;
        externallyFlooredDelta.full_review_required = true;
        externallyFlooredDelta.full_review_reasons = externallyFlooredAssessment.full_review_reasons;
        const externallyFlooredDecision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'code',
            classification: {
                source: 'delta',
                delta: rehashDelta(externallyFlooredDelta),
                profilePolicySnapshot: makeSnapshot(),
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(makeSnapshot())
            },
            requiredReviews: { code: true, security: true },
            reviewExecutionPolicyMode: 'strict_sequential',
            reusableReceipts: [acceptedReceipt('security')]
        });
        assert.equal(externallyFlooredDecision.status, 'READY');
        assert.deepEqual(externallyFlooredDecision.invalidated_review_types, ['code']);
        assert.equal(externallyFlooredDecision.lane_decisions[0].mode, 'FULL');
        assert.match(externallyFlooredDecision.lane_decisions[0].reason, new RegExp(externalFullReason, 'iu'));

        const periodicDelta = makeDelta('production', 'code', 'src/app.ts');
        const periodicAssessment = evaluateReviewRemediationMode({
            policy: buildDefaultReviewRemediationModePolicy(),
            reviewType: 'code',
            category: 'production',
            changedFilesCount: 1,
            changedLinesTotal: 1,
            consecutiveDeltaReviews: modePolicy.max_consecutive_delta_reviews
        });
        periodicDelta.mode_policy_assessment = periodicAssessment;
        periodicDelta.full_review_required = true;
        periodicDelta.full_review_reasons = periodicAssessment.full_review_reasons;
        const forgedPeriodicDecision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'code',
            classification: {
                source: 'delta',
                delta: rehashDelta(periodicDelta),
                profilePolicySnapshot: makeSnapshot(),
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(makeSnapshot())
            },
            requiredReviews: { code: true },
            reviewExecutionPolicyMode: 'strict_sequential'
        });
        assert.equal(forgedPeriodicDecision.status, 'BLOCKED');
        assert.match(
            forgedPeriodicDecision.blocked_reasons.join(' '),
            /does not match authenticated timeline and preflight mode-policy inputs/iu
        );
    });

    it('rejects self-consistent DELTA assessments that weaken legacy or protected FULL floors', () => {
        const legacyDelta = makeDelta('production', 'code');
        const legacyAssessment = legacyDelta.mode_policy_assessment!;
        const { assessment_sha256: _legacyHash, ...legacyAssessmentCore } = {
            ...legacyAssessment,
            legacy_fallback: true
        };
        legacyDelta.mode_policy_assessment = {
            ...legacyAssessmentCore,
            assessment_sha256: sha256RedactedJsonPayload(legacyAssessmentCore)
        };
        const legacyDecision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'code',
            classification: {
                source: 'delta',
                delta: rehashDelta(legacyDelta),
                profilePolicySnapshot: { schema_version: 1 },
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload({ schema_version: 1 })
            },
            requiredReviews: { code: true },
            reviewExecutionPolicyMode: 'strict_sequential'
        });
        assert.equal(legacyDecision.status, 'BLOCKED');
        assert.match(legacyDecision.blocked_reasons.join(' '), /legacy.*requires FULL/iu);

        const protectedDelta = makeDelta('production', 'code', 'src/app.ts');
        const protectedDecision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'code',
            classification: {
                source: 'delta',
                delta: protectedDelta,
                profilePolicySnapshot: makeSnapshot(),
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(makeSnapshot())
            },
            requiredReviews: { code: true, security: true },
            reviewExecutionPolicyMode: 'strict_sequential'
        }, {
            protectedBoundarySignals: ['security']
        });
        assert.equal(protectedDecision.status, 'BLOCKED');
        assert.match(
            protectedDecision.blocked_reasons.join(' '),
            /does not match authenticated timeline and preflight mode-policy inputs/iu
        );
    });

    it('records fresh invalidated evidence as satisfied without misclassifying it as reuse', () => {
        const profilePolicySnapshot = makeSnapshot();
        const decision = resolveFixtureAuthoritativeDecision({
            taskId: TASK_ID,
            currentReviewType: 'test',
            classification: {
                source: 'delta',
                delta: makeDelta('leaf_test'),
                profilePolicySnapshot,
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
            },
            requiredReviews: { code: true, test: true },
            reviewExecutionPolicyMode: 'strict_sequential',
            reusableReceipts: [acceptedReceipt('code'), freshReceipt('test')]
        });

        assert.equal(decision.status, 'READY');
        assert.deepEqual(decision.reused_review_types, ['code']);
        assert.deepEqual(decision.satisfied_review_types, ['code', 'test']);
        assert.deepEqual(decision.lane_decisions.map((entry) => ({
            review_type: entry.review_type,
            mode: entry.mode,
            satisfied: entry.satisfied,
            satisfaction_source: entry.satisfaction_source
        })), [
            { review_type: 'code', mode: 'REUSE', satisfied: true, satisfaction_source: 'REUSED' },
            { review_type: 'test', mode: 'DELTA', satisfied: true, satisfaction_source: 'FRESH' }
        ]);
        assert.deepEqual(getAuthoritativeReviewRemediationDecisionViolations(decision), []);
    });

    it('routes leaf remediation through focused validation and reruns only the current lane', () => {
        const beforeValidation = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test'));
        assert.equal(beforeValidation.status, 'VALIDATION_REQUIRED');
        assert.deepEqual(beforeValidation.invalidated_review_types, ['test']);
        assert.deepEqual(beforeValidation.reused_review_types, ['code', 'refactor']);
        assert.deepEqual(beforeValidation.review_required_types, ['test']);
        assert.deepEqual(beforeValidation.next_action, {
            kind: 'validation',
            target: 'focused',
            command: 'node run-focused.js'
        });

        const afterValidation = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            validationEvidence: validationEvidence('leaf_test')
        }));
        assert.equal(afterValidation.status, 'REVIEW_REQUIRED');
        assert.deepEqual(afterValidation.next_action, {
            kind: 'review',
            target: 'test',
            command: 'node review-test.js'
        });
    });

    it('routes structural remediation through focused plus affected validation in dependency order', () => {
        const beforeValidation = buildReviewRemediationRecoveryRoute(routeOptions('structural_test'));
        assert.equal(beforeValidation.validation_route, 'focused_and_affected');
        assert.deepEqual(beforeValidation.invalidated_review_types, ['refactor', 'test']);
        assert.deepEqual(beforeValidation.reused_review_types, ['code']);
        assert.equal(beforeValidation.next_action?.command, 'node run-focused-affected.js');

        const afterValidation = buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: validationEvidence('structural_test')
        }));
        assert.equal(afterValidation.next_action?.target, 'refactor');

        const evidence = validationEvidence('structural_test');
        const afterRefactor = buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: evidence,
            completedReceipts: [completedReceipt('refactor', evidence)]
        }));
        assert.equal(afterRefactor.next_action?.target, 'test');
        assert.deepEqual(
            afterRefactor.dependency_edges.find((entry) => entry.review_type === 'test')?.depends_on,
            ['code', 'refactor']
        );
    });

    it('invalidates custom downstream lanes while keeping an independent accepted lane reusable', () => {
        const reviewDependencyGraph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'security', 'architecture-boundary', 'test'],
            activeLaneIds: ['code', 'security', 'architecture-boundary', 'test'],
            requiredReviewIds: ['code', 'security', 'architecture-boundary', 'test'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'security', 'architecture-boundary', 'test'],
                dependencies: {
                    'architecture-boundary': ['code'],
                    test: ['architecture-boundary']
                }
            }
        });
        const route = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            currentReviewType: 'code',
            delta: makeDelta('leaf_test', 'code'),
            requiredReviews: { code: true, security: true, 'architecture-boundary': true, test: true },
            reviewExecutionPolicyMode: 'parallel_all',
            reviewDependencyGraph,
            reusableReceipts: [
                acceptedReceipt('code'),
                acceptedReceipt('security'),
                acceptedReceipt('architecture-boundary'),
                acceptedReceipt('test')
            ]
        }));

        assert.deepEqual(route.invalidated_review_types, ['code', 'architecture-boundary', 'test']);
        assert.deepEqual(route.preserved_review_types, ['security']);
        assert.deepEqual(route.reused_review_types, ['security']);
        assert.deepEqual(route.review_required_types, ['code', 'architecture-boundary', 'test']);
        assert.deepEqual(route.authoritative_decision.lane_decisions.map((entry) => ({
            review_type: entry.review_type,
            mode: entry.mode
        })), [
            { review_type: 'code', mode: 'DELTA' },
            { review_type: 'security', mode: 'REUSE' },
            { review_type: 'architecture-boundary', mode: 'FULL' },
            { review_type: 'test', mode: 'FULL' }
        ]);
        assert.deepEqual(route.dependency_edges, [
            { review_type: 'code', depends_on: [] },
            { review_type: 'architecture-boundary', depends_on: ['code'] },
            { review_type: 'test', depends_on: ['architecture-boundary'] }
        ]);
    });

    it('routes broad impact to ordinary validation and invalidates only currently required lanes', () => {
        const reviewDependencyGraph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'security', 'test'],
            activeLaneIds: ['code', 'security', 'test'],
            requiredReviewIds: ['code', 'security', 'test'],
            mode: 'strict_sequential',
            declaration: {
                preparation_order: ['code', 'security', 'test'],
                dependencies: {
                    security: ['code'],
                    test: ['code', 'security']
                }
            }
        });
        const beforeValidation = buildReviewRemediationRecoveryRoute(routeOptions('production', {
            currentReviewType: 'code',
            delta: makeDelta('production', 'code'),
            requiredReviews: { code: true, security: true, api: false, test: true },
            reviewDependencyGraph,
            reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('security'), acceptedReceipt('test')]
        }));
        assert.equal(beforeValidation.validation_route, 'ordinary');
        assert.deepEqual(beforeValidation.invalidated_review_types, ['code', 'security', 'test']);
        assert.deepEqual(beforeValidation.preserved_review_types, []);
        assert.deepEqual(beforeValidation.reused_review_types, []);
        assert.equal(beforeValidation.next_action?.command, validationCommands.ordinary.command);

        const afterValidation = buildReviewRemediationRecoveryRoute(routeOptions('production', {
            currentReviewType: 'code',
            delta: makeDelta('production', 'code'),
            requiredReviews: { code: true, security: true, api: false, test: true },
            reviewDependencyGraph,
            reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('security'), acceptedReceipt('test')],
            validationEvidence: validationEvidence('production', 'code')
        }));
        assert.equal(afterValidation.next_action?.target, 'code');
    });

    it('does not preserve an unaffected receipt unless reuse and findings satisfaction were accepted', () => {
        const route = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            requiredReviews: { code: true, test: true },
            reusableReceipts: [
                {
                    review_type: 'code',
                    reuse_status: 'REJECTED',
                    findings_satisfied: true,
                    reason: 'scope binding is stale'
                },
                acceptedReceipt('test')
            ],
            validationEvidence: validationEvidence('leaf_test')
        }));
        assert.deepEqual(route.preserved_review_types, ['code']);
        assert.deepEqual(route.reused_review_types, []);
        assert.deepEqual(route.rejected_reuse_review_types, ['code', 'test']);
        assert.deepEqual(route.review_required_types, ['code', 'test']);
        assert.equal(route.next_action?.target, 'code');
    });

    it('completes only after every non-reused lane has fresh satisfied evidence', () => {
        const evidence = validationEvidence('structural_test');
        const route = buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: evidence,
            completedReceipts: [
                completedReceipt('refactor', evidence),
                completedReceipt('test', evidence)
            ]
        }));
        assert.equal(route.status, 'COMPLETE');
        assert.equal(route.next_action, null);
        assert.match(route.routing_sha256, /^[0-9a-f]{64}$/u);
    });

    it('fails closed for forged validation evidence and a foreign policy snapshot binding', () => {
        const tampered = validationEvidence('leaf_test');
        tampered.delta_category = 'production';
        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            validationEvidence: tampered
        })), /validation evidence is invalid/iu);

        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            baselineProfilePolicySnapshotSha256: hash('foreign')
        })), /policy snapshot does not match/iu);

        const policy = makeSnapshot();
        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            profilePolicySnapshot: { ...policy, snapshot_hash: sha256RedactedJsonPayload(policy) },
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(policy)
        })), /policy snapshot is invalid/iu);
    });

    it('rejects completed lane names without authenticated current-cycle receipt bindings', () => {
        const evidence = validationEvidence('structural_test');
        const forged = completedReceipt('refactor', evidence);
        forged.validation_evidence_sha256 = hash('foreign-validation');
        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: evidence,
            completedReceipts: [forged]
        })), /not bound to the current remediation cycle/iu);

        const staleContext = completedReceipt('refactor', evidence);
        staleContext.review_context_sha256 = hash('stale-context');
        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: evidence,
            completedReceipts: [staleContext]
        })), /not bound to the current review context/iu);
    });

    it('uses the conservative all-required fallback for legacy task snapshots', () => {
        const profilePolicySnapshot = { schema_version: 1 };
        const legacyDelta = makeDelta('leaf_test');
        delete legacyDelta.mode_policy_assessment;
        const route = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot),
            delta: rehashDelta(legacyDelta),
            requiredReviews: { code: true, test: true },
            reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('test')]
        }));
        assert.equal(route.policy_legacy_fallback, true);
        assert.deepEqual(route.invalidated_review_types, ['code', 'test']);
        assert.deepEqual(route.reused_review_types, []);
    });
});
