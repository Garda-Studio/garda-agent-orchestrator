import {
    EXIT_GATE_FAILURE,
    appendTaskEvent,
    assert,
    cloneRunScopedTempRepo,
    createTempRepo,
    describe,
    fileSha256,
    findLastTimelineEventIndex,
    fs,
    getReviewsRoot,
    initializeGitRepo,
    it,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    markAsSourceCheckout,
    path,
    prepareScopedDiffFixture,
    readTaskTimelineEvents,
    runBuildReviewContextCommand,
    runEnterTaskMode,
    runExplicitPreflight,
    runGit,
    runHandshakeForTask,
    runRestartReviewCycleCommandRaw,
    runRestartReviewCycleCommand,
    runShellSmokeForTask,
    seedInitAnswers,
    seedQualityChecklistIfRequired,
    seedRemediationRepoBase,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeProtectedControlPlaneManifest,
    writeCompilePassEvidence,
    writeProfilesConfig,
    writeReviewCapabilitiesConfig,
    writeReceiptBackedReviewArtifact,
    writeSimpleCompileCommandsFile
} from './gates-review-cycle-fixtures';
import { resolveNextStep } from '../../../../../../src/gates/next-step/next-step';
import { classifyReviewRemediationFix } from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-remediation';
import {
    buildReviewEvidenceOnlyRestartPlan,
    resolveRuntimeDecisionInputs
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import {
    bindAuthoritativeRemediationDecisionToPreflight,
    buildAuthenticatedRemediationReviewExecution,
    resolvePersistedRemediationReusePolicy
} from '../../../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { sha256RedactedJsonPayload } from '../../../../../../src/core/redaction';
import type {
    ReviewFindingsDispositionArtifact
} from '../../../../../../src/gates/review/review-findings-disposition-artifact';
import type {
    ReviewFindingsValidationArtifact
} from '../../../../../../src/gates/review/review-findings-validation-artifact';
import {
    buildReviewRemediationBaselineArtifact
} from '../../../../../../src/gates/review-remediation/review-remediation-baseline';
import {
    classifyReviewRemediationDelta,
    ReviewRemediationDeltaClassification
} from '../../../../../../src/gates/review-remediation/review-remediation-delta';
import {
    buildReviewRemediationDeltaBase
} from '../../../../../../src/gates/review-remediation/review-remediation-delta-contract';
import {
    resolveAuthoritativeReviewRemediationDecision
} from '../../../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import {
    buildDefaultReviewRemediationRerunPolicy
} from '../../../../../../src/policy/review-remediation-rerun-policy';
import {
    buildDefaultReviewRemediationModePolicy
} from '../../../../../../src/policy/review-remediation-mode-policy';
import { compileReviewDependencyGraph } from '../../../../../../src/core/review-dependency-graph';

const IGNORED_CHANGELOG_PATH = 'garda-agent-orchestrator/live/docs/changes/CHANGELOG.md';
const ROOT_IGNORED_CHANGELOG_PATH = 'CHANGELOG.md';
const REMEDIATION_PART_ENV = 'GARDA_REVIEW_CYCLE_REMEDIATION_PART';
const SHARED_IGNORED_CHANGELOG_TASK_ID = 'T-940-ignored-changelog-shared';

function buildLeafTestDeltaClassification(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    changedFile: string;
    preflightPath: string;
    preflightSha256: string;
    profilePolicySnapshot: unknown;
    modePolicy?: ReturnType<typeof buildDefaultReviewRemediationModePolicy>;
}): ReviewRemediationDeltaClassification {
    const reviewsRoot = getReviewsRoot(options.repoRoot);
    writeRepoFile(options.repoRoot, options.changedFile, 'assert.equal(actual, expected);\n');
    const reviewArtifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`);
    const validationArtifactPath = path.join(
        reviewsRoot,
        `${options.taskId}-${options.reviewType}-findings-validation.json`
    );
    const dispositionArtifactPath = path.join(
        reviewsRoot,
        `${options.taskId}-${options.reviewType}-findings-disposition.json`
    );
    const baselinePath = path.join(
        reviewsRoot,
        `${options.taskId}-${options.reviewType}-remediation-baseline.json`
    );
    const treeSha256 = sha256RedactedJsonPayload({ task_id: options.taskId, tree: 'baseline' });
    const scopeSha256 = sha256RedactedJsonPayload({ changed_files: [options.changedFile] });
    const reviewScopeSha256 = sha256RedactedJsonPayload({ review_scope: [options.changedFile] });
    const contextSha256 = sha256RedactedJsonPayload({ review_type: options.reviewType });
    const finding = {
        id: 'F-001',
        severity: 'high' as const,
        title: 'Leaf-test assertion needs remediation',
        description: 'The focused assertion must be corrected and reviewed as an exact DELTA.',
        evidence_locations: [`${options.changedFile}:1`],
        coverage_obligation_ids: []
    };
    const validationResult = {
        status: 'accepted' as const,
        accepted: true,
        detected: true,
        violations: [],
        coverage_status: null,
        normalized_inventory: {
            finding_count: 1,
            residual_risk_count: 0,
            findings_by_severity: {
                critical: [],
                high: [finding],
                medium: [],
                low: []
            },
            residual_risks: []
        },
        evidence_diagnostics: {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [finding.evidence_locations[0]],
            finding_evidence_locations: [finding.evidence_locations[0]],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 1
        },
        bindings: {
            input: { review_output_sha256: sha256RedactedJsonPayload('review-output') },
            output: {
                review_artifact_path: reviewArtifactPath.replace(/\\/gu, '/'),
                review_artifact_sha256: ''
            },
            context: {
                review_context_path: path.join(reviewsRoot, `${options.taskId}-${options.reviewType}-context.json`)
                    .replace(/\\/gu, '/'),
                review_context_sha256: contextSha256
            },
            scope: {
                preflight_path: options.preflightPath.replace(/\\/gu, '/'),
                preflight_sha256: options.preflightSha256,
                scope_sha256: scopeSha256,
                review_scope_sha256: reviewScopeSha256,
                code_scope_sha256: null
            },
            tree: { review_tree_state_sha256: treeSha256 },
            coverage_contract_sha256: sha256RedactedJsonPayload('coverage')
        }
    };
    fs.writeFileSync(reviewArtifactPath, 'authenticated failed test review\n', 'utf8');
    const reviewArtifactSha256 = fileSha256(reviewArtifactPath);
    assert.ok(reviewArtifactSha256);
    validationResult.bindings.output.review_artifact_sha256 = reviewArtifactSha256;
    const validationArtifact: ReviewFindingsValidationArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_validation',
        task_id: options.taskId,
        review_type: options.reviewType,
        validation_result: validationResult,
        validation_result_sha256: sha256RedactedJsonPayload(validationResult)
    };
    fs.writeFileSync(validationArtifactPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
    const validationArtifactSha256 = fileSha256(validationArtifactPath);
    assert.ok(validationArtifactSha256);
    const reviewFindingPolicy = {
        schema_version: 1 as const,
        policy_id: 'balanced' as const,
        findings: {
            critical: 'fix_now' as const,
            high: 'fix_now' as const,
            medium: 'create_follow_up' as const,
            low: 'create_follow_up' as const
        },
        residual_risk: 'create_follow_up' as const
    };
    const dispositionResult = {
        schema_version: 1 as const,
        policy_id: 'balanced' as const,
        policy_source: 'preflight_profile_policy_snapshot' as const,
        policy_diagnostics: [],
        findings: {
            critical: { action: 'fix_now' as const, ids: [], count: 0 },
            high: { action: 'fix_now' as const, ids: [finding.id], count: 1 },
            medium: { action: 'create_follow_up' as const, ids: [], count: 0 },
            low: { action: 'create_follow_up' as const, ids: [], count: 0 }
        },
        residual_risks: { action: 'create_follow_up' as const, ids: [], count: 0 },
        counts_by_action: { fix_now: 1, create_follow_up: 0, ignore: 0 },
        blocking_count: 1,
        blocking_ids: [finding.id],
        non_blocking_count: 0,
        total_count: 1,
        verdict: 'fail_for_fix_now' as const
    };
    const dispositionArtifact: ReviewFindingsDispositionArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_disposition',
        task_id: options.taskId,
        review_type: options.reviewType,
        derivation_source: 'garda_locked_policy_evaluation',
        source_validation: {
            artifact_path: validationArtifactPath.replace(/\\/gu, '/'),
            artifact_sha256: validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            status: 'accepted',
            accepted: true
        },
        policy: {
            policy_id: 'balanced',
            policy_source: 'preflight_profile_policy_snapshot',
            policy_diagnostics: [],
            review_finding_policy: reviewFindingPolicy
        },
        disposition_result: dispositionResult,
        disposition_result_sha256: sha256RedactedJsonPayload(dispositionResult),
        items: [{
            id: finding.id,
            kind: 'finding',
            severity: finding.severity,
            action: 'fix_now',
            source_rule: 'review_finding_policy.findings.high',
            policy_source: 'preflight_profile_policy_snapshot',
            blocking: true,
            materialization_status: 'requires_fix_now',
            audit_status: 'retained_in_disposition_artifact'
        }],
        summary: {
            item_count: 1,
            fix_now_count: 1,
            follow_up_pending_count: 0,
            ignored_count: 0,
            blocking_count: 1,
            non_blocking_count: 0
        }
    };
    fs.writeFileSync(dispositionArtifactPath, `${JSON.stringify(dispositionArtifact, null, 2)}\n`, 'utf8');
    const dispositionArtifactSha256 = fileSha256(dispositionArtifactPath);
    assert.ok(dispositionArtifactSha256);
    const receipt = {
        task_id: options.taskId,
        review_type: options.reviewType,
        review_artifact_sha256: reviewArtifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeSha256,
        review_findings_report_sha256: sha256RedactedJsonPayload('findings-report')
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    const receiptSha256 = fileSha256(receiptPath);
    assert.ok(receiptSha256);
    const deltaBase = buildReviewRemediationDeltaBase({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewTreeStateSha256: treeSha256,
        changedFiles: [options.changedFile]
    });
    const baseline = buildReviewRemediationBaselineArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewArtifactPath,
        reviewArtifactSha256,
        receiptPath,
        receiptSha256,
        receipt,
        validationArtifactPath,
        validationArtifactSha256,
        validationArtifact,
        dispositionArtifactPath,
        dispositionArtifactSha256,
        dispositionArtifact,
        profilePolicySnapshot: options.profilePolicySnapshot,
        deltaBase
    });
    fs.copyFileSync(receiptPath, baseline.bindings.receipt.snapshot_path);
    fs.copyFileSync(reviewArtifactPath, baseline.bindings.review_artifact.snapshot_path);
    fs.copyFileSync(validationArtifactPath, baseline.bindings.findings_validation.snapshot_path);
    fs.copyFileSync(dispositionArtifactPath, baseline.bindings.findings_disposition.snapshot_path);
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    const baselineSha256 = fileSha256(baselinePath);
    assert.ok(baselineSha256);
    writeRepoFile(
        options.repoRoot,
        options.changedFile,
        'assert.equal(actual, expected);\nassert.equal(receipt.mode, "DELTA");\n'
    );
    return classifyReviewRemediationDelta({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        baselineArtifactPath: baselinePath,
        baselineArtifactSha256: baselineSha256,
        currentChangedFiles: [options.changedFile],
        structuralTestChangedLinesThreshold: 20,
        modePolicy: options.modePolicy
    });
}

function seedBaselineCompileGatePass(options: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    commandsPath?: string;
    outputFiltersPath?: string;
    emitMetrics?: boolean;
}): { exitCode: number; outputLines: string[] } {
    writeCompilePassEvidence(options.repoRoot, options.taskId, options.preflightPath);
    return {
        exitCode: 0,
        outputLines: ['COMPILE_GATE_PASSED']
    };
}

function writeRepoFile(repoRoot: string, relativePath: string, content: string): void {
    const filePath = path.join(repoRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function appendIgnoredChangelogRule(repoRoot: string, changelogPath = IGNORED_CHANGELOG_PATH): void {
    fs.appendFileSync(
        path.join(repoRoot, '.gitignore'),
        `${changelogPath}\n`,
        'utf8'
    );
}

function buildIgnoredChangelogImpactAnalysis(changelogPath = IGNORED_CHANGELOG_PATH): string {
    return [
        `Reviewer finding: failed review requires release-note remediation in ${changelogPath}.`,
        `Intended fix: update only the ignored changelog remediation target ${changelogPath}.`,
        `Affected files/contracts: ${changelogPath} is the affected release-note artifact and runtime contracts stay unchanged.`,
        `API/runtime/artifact/test impact: artifact impact is limited to the release-note evidence in ${changelogPath}.`,
        'Possible side effects: review reuse must fail closed if code or runtime behavior changes appear.',
        'Required targeted checks: restart-review-cycle must refresh preflight, compile, and review context evidence.',
        'Scope or review-type changes: the ignored changelog is in scope only because the failed review named it.',
        'Related blockers/follow-up: no separate follow-up is needed for this same failed-review blocker.'
    ].join(' ');
}

describe('cli/commands/gates – authenticated remediation execution persistence', {
    skip: Boolean(process.env[REMEDIATION_PART_ENV])
}, () => {
    it('reloads origin and non-origin FULL authority and rejects forged persisted remediation authority', () => {
        const taskId = 'T-992-3-2-persisted-authority';
        const preflightSha256 = 'a'.repeat(64);
        const fullReviewScope = ['src/app.ts', 'tests/app.test.ts'];
        const classification = {
            source: 'runtime_fix' as const,
            classification: {
                category: 'production',
                reason: 'Production remediation invalidates origin and downstream lanes.',
                blocked_before_reuse: false,
                invalidated_review_types: ['code', 'security']
            }
        };
        const decision = bindAuthoritativeRemediationDecisionToPreflight(
            resolveAuthoritativeReviewRemediationDecision({
                taskId,
                currentReviewType: 'code',
                classification,
                requiredReviews: { code: true, security: true },
                reviewExecutionPolicyMode: 'strict_sequential'
            }),
            preflightSha256
        );
        const persistedDecision = JSON.parse(JSON.stringify(decision)) as typeof decision;
        const originExecution = buildAuthenticatedRemediationReviewExecution({
            taskId,
            reviewType: 'code',
            preflightSha256,
            fullReviewScope,
            authoritativeDecision: persistedDecision,
            authoritativeClassification: classification
        });
        const nonOriginExecution = buildAuthenticatedRemediationReviewExecution({
            taskId,
            reviewType: 'security',
            preflightSha256,
            fullReviewScope,
            authoritativeDecision: persistedDecision,
            authoritativeClassification: classification
        });

        assert.equal(originExecution.contract.mode, 'FULL');
        assert.equal(nonOriginExecution.contract.mode, 'FULL');
        assert.equal(originExecution.contract.authoritative_decision_sha256, decision.decision_sha256);
        assert.equal(nonOriginExecution.contract.authoritative_decision_sha256, decision.decision_sha256);

        const forgedDecision = JSON.parse(JSON.stringify(persistedDecision)) as typeof persistedDecision;
        forgedDecision.lane_decisions[1].mode = 'REUSE';
        assert.throws(
            () => buildAuthenticatedRemediationReviewExecution({
                taskId,
                reviewType: 'security',
                preflightSha256,
                fullReviewScope,
                authoritativeDecision: forgedDecision,
                authoritativeClassification: classification
            }),
            /persisted authoritative remediation decision is invalid.*hash is invalid/iu
        );
    });

    it('reloads a persisted DELTA restart and rejects stale or forged DELTA authority', () => {
        const repoRoot = createTempRepo();
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskId = 'T-992-3-2-persisted-delta-authority';
        const reviewType = 'test';
        const changedFile = 'tests/node/example.test.ts';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const preflightPayload = { changed_files: [changedFile] };
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(preflightPath, `${JSON.stringify(preflightPayload)}\n`, 'utf8');
        const preflightSha256 = fileSha256(preflightPath);
        assert.ok(preflightSha256);
        const legacyProfilePolicySnapshot = {
            review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy(),
            review_remediation_rerun_policy_diagnostics: ['persisted DELTA fixture policy']
        };
        const legacyClassification = {
            source: 'delta' as const,
            delta: buildLeafTestDeltaClassification({
                repoRoot,
                taskId,
                reviewType,
                changedFile,
                preflightPath,
                preflightSha256,
                profilePolicySnapshot: legacyProfilePolicySnapshot
            }),
            profilePolicySnapshot: legacyProfilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(legacyProfilePolicySnapshot)
        };
        const legacyDecision = bindAuthoritativeRemediationDecisionToPreflight(
            resolveAuthoritativeReviewRemediationDecision({
                taskId,
                currentReviewType: reviewType,
                classification: legacyClassification,
                requiredReviews: { test: true },
                reviewExecutionPolicyMode: 'strict_sequential'
            }),
            preflightSha256
        );

        try {
            appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Review cycle restarted.', {
                task_id: taskId,
                event_type: 'REVIEW_CYCLE_RESTARTED',
                status: 'PASSED',
                preflight_sha256: preflightSha256,
                authoritative_review_decision: legacyDecision,
                authoritative_review_classification: legacyClassification
            });
            const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
            const legacyPersisted = resolvePersistedRemediationReusePolicy({
                events: readTaskTimelineEvents(repoRoot, taskId),
                taskId,
                reviewType,
                preflightPath,
                timelinePath,
                preflightPayload
            });
            assert.match(legacyPersisted.blockedReason, /FULL review.*legacy remediation evidence/iu);
            assert.equal(legacyPersisted.reviewExecutionContract?.mode, 'FULL');
            assert.equal(legacyPersisted.reviewExecutionContract?.source, 'remediation_full');

            const modePolicy = buildDefaultReviewRemediationModePolicy();
            const profilePolicySnapshot = {
                ...legacyProfilePolicySnapshot,
                review_remediation_mode_policy: modePolicy,
                review_remediation_mode_policy_diagnostics: ['persisted DELTA fixture mode policy']
            };
            const classification = {
                source: 'delta' as const,
                delta: buildLeafTestDeltaClassification({
                    repoRoot,
                    taskId,
                    reviewType,
                    changedFile,
                    preflightPath,
                    preflightSha256,
                    profilePolicySnapshot,
                    modePolicy
                }),
                profilePolicySnapshot,
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot)
            };
            const decision = bindAuthoritativeRemediationDecisionToPreflight(
                resolveAuthoritativeReviewRemediationDecision({
                    taskId,
                    currentReviewType: reviewType,
                    classification,
                    modePolicyValidationInputs: {
                        consecutiveDeltaReviews: 0,
                        protectedBoundarySignals: [],
                        taskCriteriaChanged: false,
                        policyChanged: false,
                        uncertainCrossFileImpact: false
                    },
                    requiredReviews: { test: true },
                    reviewExecutionPolicyMode: 'strict_sequential'
                }),
                preflightSha256
            );
            appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Authenticated review cycle restarted.', {
                task_id: taskId,
                event_type: 'REVIEW_CYCLE_RESTARTED',
                status: 'PASSED',
                preflight_sha256: preflightSha256,
                authoritative_review_decision: decision,
                authoritative_review_classification: classification
            });
            const events = readTaskTimelineEvents(repoRoot, taskId);
            const persisted = resolvePersistedRemediationReusePolicy({
                events,
                taskId,
                reviewType,
                preflightPath,
                timelinePath,
                preflightPayload
            });
            assert.match(persisted.blockedReason, /bounded DELTA review is required/iu);
            assert.equal(persisted.reviewExecutionContract?.mode, 'DELTA');
            assert.equal(persisted.reviewExecutionContract?.source, 'remediation_delta');
            assert.equal(
                persisted.reviewExecutionValidationAuthority?.authoritativeDecisionSha256,
                decision.decision_sha256
            );

            fs.writeFileSync(preflightPath, `${JSON.stringify({ changed_files: [changedFile], stale: true })}\n`, 'utf8');
            const stale = resolvePersistedRemediationReusePolicy({
                events,
                taskId,
                reviewType,
                preflightPath,
                timelinePath,
                preflightPayload
            });
            assert.equal(stale.reviewExecutionContract, undefined);

            fs.writeFileSync(preflightPath, `${JSON.stringify(preflightPayload)}\n`, 'utf8');
            const forgedDecision = JSON.parse(JSON.stringify(decision)) as typeof decision;
            forgedDecision.lane_decisions[0].mode = 'FULL';
            appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Forged restart.', {
                task_id: taskId,
                event_type: 'REVIEW_CYCLE_RESTARTED',
                status: 'PASSED',
                preflight_sha256: preflightSha256,
                authoritative_review_decision: forgedDecision,
                authoritative_review_classification: classification
            });
            const forged = resolvePersistedRemediationReusePolicy({
                events: readTaskTimelineEvents(repoRoot, taskId),
                taskId,
                reviewType,
                preflightPath,
                timelinePath,
                preflightPayload
            });
            assert.equal(forged.failClosed, true);
            assert.match(forged.blockedReason, /persisted authoritative remediation decision failed validation/iu);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('forces a lane-local FULL fallback for unsupported authenticated review execution telemetry', () => {
        const repoRoot = createTempRepo();
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskId = 'T-1013-4-2-unsupported-review-mode';
        const reviewType = 'test';
        const changedFile = 'tests/node/example.test.ts';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const preflightPayload = { changed_files: [changedFile] };
        const profilePolicySnapshot = {
            review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy(),
            review_remediation_rerun_policy_diagnostics: ['fixture rerun policy'],
            review_remediation_mode_policy: buildDefaultReviewRemediationModePolicy(),
            review_remediation_mode_policy_diagnostics: ['fixture mode policy']
        };
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(preflightPath, `${JSON.stringify(preflightPayload)}\n`, 'utf8');
        const preflightSha256 = fileSha256(preflightPath);
        assert.ok(preflightSha256);
        buildLeafTestDeltaClassification({
            repoRoot,
            taskId,
            reviewType,
            changedFile,
            preflightPath,
            preflightSha256,
            profilePolicySnapshot
        });
        const mutableBaselinePath = path.join(
            reviewsRoot,
            `${taskId}-${reviewType}-remediation-baseline.json`
        );
        const baselineSha256 = fileSha256(mutableBaselinePath);
        assert.ok(baselineSha256);
        const immutableBaselinePath = path.join(
            reviewsRoot,
            `${taskId}-${reviewType}-remediation-baseline-${baselineSha256}.json`
        );
        fs.copyFileSync(mutableBaselinePath, immutableBaselinePath);
        appendTaskEvent(bundleRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'Unsupported mode fixture.', {
            review_type: reviewType,
            review_execution_mode: 'UNKNOWN',
            remediation_baseline_snapshot_path: immutableBaselinePath,
            remediation_baseline_snapshot_sha256: baselineSha256
        });

        try {
            const result = resolveRuntimeDecisionInputs({
                repoRoot,
                taskId,
                remediationReviewType: reviewType,
                requiredReviewTypes: ['code', 'test'],
                remediationFixClassification: {
                    category: 'leaf_test',
                    reason: 'fixture leaf-test remediation',
                    blocked_before_reuse: false,
                    invalidated_review_types: [reviewType]
                },
                profilePolicySnapshot,
                currentChangedFiles: [changedFile],
                reviewTriggerPolicy: {
                    test_path_regexes: ['(^|/)tests?/'],
                    test_refactor_structural_path_regexes: ['(^|/)tests?/helpers?/'],
                    test_refactor_changed_lines_threshold: 20
                },
                allowAuthenticatedDelta: true,
                preflightPayload
            });
            const classification = result.classification as {
                source: 'runtime_fix';
                classification: { reason: string; invalidated_review_types: string[] };
            };
            assert.equal(classification.source, 'runtime_fix');
            assert.deepEqual(classification.classification.invalidated_review_types, [reviewType]);
            assert.match(classification.classification.reason, /unsupported review execution mode.*FULL/iu);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});

interface IgnoredChangelogTemplate {
    readonly repoRoot: string;
    readonly commandsRelativePath: string;
    readonly outputFiltersRelativePath: string;
}

const ignoredChangelogTemplates = new Map<string, IgnoredChangelogTemplate>();

function getIgnoredChangelogTemplate(changelogPath: string): IgnoredChangelogTemplate {
    const cached = ignoredChangelogTemplates.get(changelogPath);
    if (cached) {
        return cached;
    }
    const repoRoot = createTempRepo();
    seedRemediationRepoBase(repoRoot);
    appendIgnoredChangelogRule(repoRoot, changelogPath);
    writeReviewCapabilitiesConfig(repoRoot);
    writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 0;\n');
    writeRepoFile(repoRoot, changelogPath, '# Changelog\n\n- Initial ignored release note.\n');
    const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
        repoRoot,
        'ignored-changelog-template'
    );
    initializeGitRepo(repoRoot);
    writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
    const snapshotRoot = cloneRunScopedTempRepo(repoRoot);
    const template = {
        repoRoot: snapshotRoot,
        commandsRelativePath: path.relative(repoRoot, commandsPath),
        outputFiltersRelativePath: path.relative(repoRoot, outputFiltersPath)
    };
    ignoredChangelogTemplates.set(changelogPath, template);
    return template;
}

interface PreparedIgnoredChangelogFixture {
    readonly repoRoot: string;
    readonly resetSnapshotRoot: string;
    readonly preflightRelativePath: string;
    readonly commandsRelativePath: string;
    readonly outputFiltersRelativePath: string;
    useCount: number;
}

const preparedIgnoredChangelogFixtures =
    new Map<string, Promise<PreparedIgnoredChangelogFixture>>();

function restorePreparedRepo(sourceRoot: string, targetRoot: string): void {
    assert.notEqual(path.resolve(sourceRoot), path.resolve(targetRoot));
    fs.mkdirSync(targetRoot, { recursive: true });
    for (const entry of fs.readdirSync(targetRoot)) {
        fs.rmSync(path.join(targetRoot, entry), {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50
        });
    }
    for (const entry of fs.readdirSync(sourceRoot)) {
        fs.cpSync(path.join(sourceRoot, entry), path.join(targetRoot, entry), { recursive: true });
    }
}

async function getPreparedIgnoredChangelogFixture(
    taskId: string,
    changelogPath: string,
    plannedChangedFiles: readonly string[]
): Promise<PreparedIgnoredChangelogFixture> {
    const fixtureKey = JSON.stringify({ taskId, changelogPath, plannedChangedFiles });
    let fixturePromise = preparedIgnoredChangelogFixtures.get(fixtureKey);
    if (!fixturePromise) {
        fixturePromise = (async () => {
            const template = getIgnoredChangelogTemplate(changelogPath);
            const repoRoot = cloneRunScopedTempRepo(template.repoRoot);
            const commandsPath = path.join(repoRoot, template.commandsRelativePath);
            const outputFiltersPath = path.join(repoRoot, template.outputFiltersRelativePath);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Restart review cycle with explicit ignored changelog remediation',
                plannedChangedFiles
            });
            loadTaskEntryRulePack(repoRoot, taskId);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            const preflightPath = runExplicitPreflight(
                repoRoot,
                taskId,
                'Restart review cycle with explicit ignored changelog remediation',
                ['src/app.ts']
            );
            loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
            const compileResult = await seedBaselineCompileGatePass({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                outputFiltersPath,
                emitMetrics: false
            });
            assert.equal(compileResult.exitCode, 0);
            return {
                repoRoot,
                resetSnapshotRoot: cloneRunScopedTempRepo(repoRoot),
                preflightRelativePath: path.relative(repoRoot, preflightPath),
                commandsRelativePath: template.commandsRelativePath,
                outputFiltersRelativePath: template.outputFiltersRelativePath,
                useCount: 0
            };
        })();
        preparedIgnoredChangelogFixtures.set(fixtureKey, fixturePromise);
    }
    return fixturePromise;
}

async function prepareIgnoredChangelogFixture(
    taskId: string,
    _suffix: string,
    changelogPath = IGNORED_CHANGELOG_PATH,
    plannedChangedFiles = ['src/app.ts']
): Promise<{
    repoRoot: string;
    preflightPath: string;
    commandsPath: string;
    outputFiltersPath: string;
}> {
    const fixture = await getPreparedIgnoredChangelogFixture(
        taskId,
        changelogPath,
        plannedChangedFiles
    );
    if (fixture.useCount > 0) {
        restorePreparedRepo(fixture.resetSnapshotRoot, fixture.repoRoot);
    }
    fixture.useCount += 1;
    return {
        repoRoot: fixture.repoRoot,
        preflightPath: path.join(fixture.repoRoot, fixture.preflightRelativePath),
        commandsPath: path.join(fixture.repoRoot, fixture.commandsRelativePath),
        outputFiltersPath: path.join(fixture.repoRoot, fixture.outputFiltersRelativePath)
    };
}

function writeFailedIgnoredChangelogReviewRequest(
    repoRoot: string,
    taskId: string,
    changelogPath = IGNORED_CHANGELOG_PATH
): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
        '# Code Review',
        '',
        `Finding: failed review requires release-note remediation in ${changelogPath}.`,
        '',
        'CODE REVIEW FAILED',
        '',
        '## Findings by Severity',
        `- Blocking: add the explicit ignored changelog target ${changelogPath}.`,
        '',
        '## Residual Risks',
        'The release-note artifact remains missing from the current review-cycle recovery scope.',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ]);
}

function writeFailedIgnoredChangelogPathFirstReviewRequest(
    repoRoot: string,
    taskId: string,
    changelogPath = IGNORED_CHANGELOG_PATH
): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
        '# Code Review',
        '',
        `${changelogPath} is missing the required release-note entry for this failed review.`,
        '',
        'CODE REVIEW FAILED',
        '',
        '## Findings by Severity',
        `- Blocking: ${changelogPath} is required for release-note remediation.`,
        '',
        '## Residual Risks',
        'The release-note artifact remains missing from the current review-cycle recovery scope.',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ]);
}

function writeFailedIgnoredChangelogExampleOnlyReviewRequest(
    repoRoot: string,
    taskId: string,
    changelogPath = IGNORED_CHANGELOG_PATH
): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
        '# Code Review',
        '',
        `High: support path-first findings such as ${changelogPath} is missing the required release-note entry.`,
        '',
        'CODE REVIEW FAILED',
        '',
        '## Findings by Severity',
        'High: update the parser behavior; the example path is not the requested remediation target.',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ]);
}

function writeFailedSourceOnlyReviewRequest(repoRoot: string, taskId: string): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
        '# Code Review',
        '',
        'Finding: failed review requires source remediation in src/app.ts.',
        '',
        'CODE REVIEW FAILED',
        '',
        '## Findings by Severity',
        '- Blocking: update src/app.ts for the failed review.',
        '',
        '## Residual Risks',
        'The source remediation remains incomplete.',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ]);
}

function replaceReceiptBoundReviewIdentity(
    repoRoot: string,
    taskId: string,
    identity: { taskId?: string; reviewType?: string }
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
    const report = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    if (identity.taskId) {
        report.task_id = identity.taskId;
    }
    if (identity.reviewType) {
        report.review_type = identity.reviewType;
    }
    fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.review_artifact_sha256 = fileSha256(artifactPath);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

async function resumeReviewReuseAfterChecklist(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    reviewTypes: string[]
): Promise<{ reusedReviewTypes: string[]; launchRequiredReviewTypes: string[] }> {
    seedQualityChecklistIfRequired(repoRoot, taskId);
    const reusedReviewTypes: string[] = [];
    const launchRequiredReviewTypes: string[] = [];
    for (const reviewType of reviewTypes) {
        prepareScopedDiffFixture(repoRoot, preflightPath, reviewType);
        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType,
            depth: 3,
            preflightPath,
            outputPath: path.join(
                getReviewsRoot(repoRoot),
                `${taskId}-${reviewType}-review-context.json`
            )
        });
        if (result.reusedReviewEvidence) {
            reusedReviewTypes.push(reviewType);
        } else {
            launchRequiredReviewTypes.push(reviewType);
        }
    }
    return { reusedReviewTypes, launchRequiredReviewTypes };
}

describe('cli/commands/gates – review-cycle remediation reuse basics', {
    skip: process.env[REMEDIATION_PART_ENV] !== 'reuse-basic'
}, () => {
    it('restart-review-cycle reuses unaffected lanes and rejects forged persisted remediation authority', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-reuse';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-reuse');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the review cycle and reuse code review evidence before rebuilding downstream test context',
            plannedChangedFiles: [
                'commands-restart-review-cycle-reuse.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle and reuse code review evidence before rebuilding downstream test context',
            ['src/app.ts', 'tests/app.test.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );
        const securityReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW PASSED',
            preflightPath,
            securityReviewContextPath,
            'agent:security-reviewer'
        );
        const refactorReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-refactor-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'refactor',
            'REFACTOR REVIEW PASSED',
            preflightPath,
            refactorReviewContextPath,
            'agent:refactor-reviewer'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: failed review blocker requires isolating the _testHooks helper in src/app.ts.',
                'Intended fix: constrain _testHooks exposure in src/app.ts without changing production behavior.',
                'Affected files/contracts: src/app.ts and tests/app.test.ts are the affected files; external contracts stay unchanged.',
                'API/runtime/artifact/test impact: test hook isolation only; no product contract or privileged handling impact is intended.',
                'Possible side effects: review reuse must fail closed if unrelated behavior changes appear.',
                'Required targeted checks: compile gate and downstream test review context assertions cover the fix.',
                'Scope or review-type changes: test hook isolation invalidates code review while preserving security and refactor evidence.',
                'Related blockers/follow-up: no separate follow-up is needed for this isolated hook fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /RemediationFixClassification: test_hook_isolation; invalidated_review_types=code, test; preserved_review_types=security, refactor/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);
        const resumedReuse = await resumeReviewReuseAfterChecklist(
            repoRoot,
            taskId,
            preflightPath,
            ['code', 'security', 'refactor']
        );
        assert.deepEqual(resumedReuse.launchRequiredReviewTypes, ['code']);
        assert.deepEqual(resumedReuse.reusedReviewTypes, ['security', 'refactor']);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const authoritativeDecision = remediationArtifact.authoritative_review_decision as Record<string, unknown>;
        const authoritativeClassification = remediationArtifact.authoritative_review_classification as Record<string, unknown>;
        assert.equal(authoritativeClassification.source, 'runtime_fix');
        assert.equal(
            (authoritativeClassification.classification as Record<string, unknown>).category,
            'test_hook_isolation'
        );
        const codeReviewContext = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`),
            'utf8'
        )) as Record<string, unknown>;
        const codeReviewExecution = codeReviewContext.review_execution as Record<string, unknown>;
        assert.equal(codeReviewExecution.mode, 'FULL');
        assert.equal(codeReviewExecution.source, 'remediation_full');
        assert.equal(
            codeReviewExecution.authoritative_decision_sha256,
            authoritativeDecision.decision_sha256
        );

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const handshakeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const shellSmokeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const firstCompileIndex = events.findIndex((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const lastHandshakeIndex = handshakeIndexes.at(-1) ?? -1;
        const lastShellSmokeIndex = shellSmokeIndexes.at(-1) ?? -1;
        const restartEvent = events.find((event) => event.event_type === 'REVIEW_CYCLE_RESTARTED');
        assert.deepEqual(
            (restartEvent?.details as Record<string, unknown>)?.authoritative_review_classification,
            authoritativeClassification
        );
        assert.ok(lastCompileIndex >= 0);
        assert.equal(handshakeIndexes.length, 2);
        assert.equal(shellSmokeIndexes.length, 2);
        assert.ok(firstCompileIndex >= 0);
        assert.ok(firstCompileIndex > shellSmokeIndexes[0]);
        assert.ok(lastHandshakeIndex > firstCompileIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);
        assert.ok(lastCompileIndex > lastShellSmokeIndex);
        assert.ok(lastCodeReviewPhaseIndex > lastCompileIndex);

        appendTaskEvent(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'Fresh code review with non-blocking follow-up recorded after remediation.',
            {
                task_id: taskId,
                review_type: 'code',
                preflight_sha256: fileSha256(preflightPath),
                reused_existing_review: false,
                review_findings_disposition: {
                    verdict: 'pass_with_follow_up_or_ignored_findings',
                    blocking_count: 0,
                    follow_up_pending_count: 1
                }
            }
        );
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        const freshFollowUpPassResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 3,
            preflightPath,
            outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)
        });
        assert.doesNotMatch(
            freshFollowUpPassResult.outputLines.join('\n'),
            /review reuse blocked by persisted remediation classification/
        );
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const timelinePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${taskId}.jsonl`
        );
        const timelineLines = fs.readFileSync(timelinePath, 'utf8').trimEnd().split('\n');
        const restartLineIndex = timelineLines.findIndex((line) => (
            (JSON.parse(line) as Record<string, unknown>).event_type === 'REVIEW_CYCLE_RESTARTED'
        ));
        assert.ok(restartLineIndex >= 0);
        const tamperedRestartEvent = JSON.parse(timelineLines[restartLineIndex]) as Record<string, unknown>;
        const tamperedRestartDetails = tamperedRestartEvent.details as Record<string, unknown>;
        const tamperedAuthoritativeClassification =
            tamperedRestartDetails.authoritative_review_classification as Record<string, unknown>;
        const tamperedRuntimeClassification =
            tamperedAuthoritativeClassification.classification as Record<string, unknown>;
        tamperedRuntimeClassification.category = 'forged_preserved_scope';
        timelineLines[restartLineIndex] = JSON.stringify(tamperedRestartEvent);
        fs.writeFileSync(timelinePath, `${timelineLines.join('\n')}\n`, 'utf8');

        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        await assert.rejects(
            () => runBuildReviewContextCommand({
                repoRoot,
                reviewType: 'code',
                depth: 3,
                preflightPath,
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)
            }),
            /persisted remediation timeline failed hash-chain integrity validation/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle blocks review reuse for fail-closed remediation classifications', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-fail-closed-reuse';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-fail-closed-reuse');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the review cycle without reusing fail-closed runtime remediation evidence',
            plannedChangedFiles: [
                'commands-restart-review-cycle-fail-closed-reuse.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle without reusing fail-closed runtime remediation evidence',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );
        const securityReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW PASSED',
            preflightPath,
            securityReviewContextPath,
            'agent:security-reviewer'
        );
        const refactorReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-refactor-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'refactor',
            'REFACTOR REVIEW PASSED',
            preflightPath,
            refactorReviewContextPath,
            'agent:refactor-reviewer'
        );

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: failed review blocker changes runtime deletion behavior and trust handling in src/app.ts.',
                'Intended fix: update the runtime deletion execution path in src/app.ts and refresh review evidence.',
                'Affected files/contracts: src/app.ts is the affected file and its trust-sensitive runtime behavior changes.',
                'API/runtime/artifact/test impact: runtime behavior and trust changes require fail-closed review handling.',
                'Possible side effects: stale security evidence could miss a trust-boundary regression.',
                'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                'Scope or review-type changes: all affected review types must be reconsidered before reuse.',
                'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /RemediationFixClassification: unknown; invalidated_review_types=code, security, refactor; preserved_review_types=none/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor/);
        const resumedReuse = await resumeReviewReuseAfterChecklist(
            repoRoot,
            taskId,
            preflightPath,
            ['code', 'security', 'refactor']
        );
        assert.deepEqual(resumedReuse.reusedReviewTypes, []);
        assert.deepEqual(
            resumedReuse.launchRequiredReviewTypes,
            ['code', 'security', 'refactor']
        );

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        assert.deepEqual(reviewReuse.reused_review_types, []);
        assert.deepEqual(reviewReuse.launch_required_review_types, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle blocks non-test remediation files outside the failed review scope', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-expanded-source';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-expanded-source');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle refuses expanded source remediation',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle refuses expanded source remediation',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        fs.writeFileSync(path.join(repoRoot, 'src', 'extra.ts'), 'export const extra = true;\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [
                'src/app.ts',
                `garda-agent-orchestrator/runtime/manual-validation/${taskId}/gradle-test.log`,
                `garda-agent-orchestrator/runtime/manual-validation/${taskId}/review-evidence.json`
            ],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTART_FAILED/);
        assert.match(output, /non-test files outside the failed review scope changed: src\/extra.ts/);

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const reviewsIndex = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), 'reviews-index.json'),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(remediationArtifact.status, 'BLOCKED');
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).category,
            'runtime_behavior'
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).scope_category,
            'expanded_non_test_blocked'
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).blocked_before_reuse,
            true
        );
        assert.equal(
            (remediationArtifact.remediation_scope as Record<string, unknown>).status,
            'BLOCKED'
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_non_test_files,
            ['src/extra.ts']
        );
        assert.ok((reviewsIndex.entries as Array<Record<string, unknown>>).some((entry) => (
            entry.fileName === `${taskId}-review-remediation-cycle.json`
            && entry.taskId === taskId
            && entry.artifactType === 'review-remediation-cycle.json'
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle allows task-scoped manual-validation evidence refresh files', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-manual-validation';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-manual-validation');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle after refreshing manual validation evidence',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle after refreshing manual validation evidence',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const manualValidationRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', taskId);
        fs.mkdirSync(manualValidationRoot, { recursive: true });
        fs.writeFileSync(path.join(manualValidationRoot, 'gradle-test.log'), 'BUILD SUCCESSFUL\n', 'utf8');
        fs.writeFileSync(path.join(manualValidationRoot, 'review-evidence.json'), JSON.stringify({
            schema_version: 1,
            task_id: taskId,
            selected_logs: [
                {
                    path: 'gradle-test.log',
                    command: './gradlew test',
                    exit_code: 0,
                    review_types: ['test']
                }
            ]
        }, null, 2), 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [
                'src/app.ts',
                `garda-agent-orchestrator/runtime/manual-validation/${taskId}/gradle-test.log`,
                `garda-agent-orchestrator/runtime/manual-validation/${taskId}/review-evidence.json`
            ],
            impactAnalysis: [
                'Reviewer finding: failed review could not inspect attached manual validation evidence for the test lane.',
                'Intended fix: add task-scoped runtime/manual-validation selector and log artifacts for reviewer handoff.',
                'Affected files/contracts: src/app.ts remains the scoped source file and garda-agent-orchestrator/runtime/manual-validation artifacts are attached evidence only.',
                'API/runtime/artifact/test impact: runtime artifact impact is limited to reviewer evidence; tests are not changed by the selector refresh.',
                'Possible side effects: review reuse must fail closed if the runtime evidence changes behavior or expands source scope.',
                'Required targeted checks: compile gate, review context build, and manual-validation evidence handoff checks cover the refresh.',
                'Scope or review-type changes: only the test evidence handoff is refreshed; source scope stays unchanged.',
                'Related blockers/follow-up: no separate follow-up is needed for task-owned manual-validation evidence refresh.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const remediationScope = remediationArtifact.remediation_scope as Record<string, unknown>;
        assert.equal(remediationScope.status, 'OK');
        assert.deepEqual(remediationScope.expanded_non_test_files, []);
        assert.ok((remediationScope.current_changed_files as string[]).includes(
            `garda-agent-orchestrator/runtime/manual-validation/${taskId}/review-evidence.json`
        ));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle includes allowed test-only expansion in explicit refresh scope', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-explicit-test-expansion';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-explicit-test-expansion');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle preserves explicit test-only remediation scope',
            plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle preserves explicit test-only remediation scope',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts', 'tests/app.test.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            ['tests/app.test.ts']
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).category,
            'test_coverage_only'
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).scope_category,
            'test_only_expansion'
        );
        assert.deepEqual(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).invalidated_review_types,
            ['refactor', 'test']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle uses expanded remediation files for semantic classification', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-892-restart-review-cycle-semantic-test-expansion';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-semantic-test-expansion');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle classifies only the remediation delta',
            plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle classifies only the remediation delta',
            ['src/app.ts', 'tests/app.test.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'remediation-only.test.ts'),
            'it("covers the failed review path", () => {});\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', 'tests/app.test.ts'],
            impactAnalysis: [
                'Reviewer finding: test reviewer reported missing coverage for tests/remediation-only.test.ts retry routing.',
                'Intended fix: add tests/remediation-only.test.ts as assertion coverage for the failed test lane only.',
                'Affected files/contracts: tests/remediation-only.test.ts is the affected file; source contracts are unchanged.',
                'API/runtime/artifact/test impact: test impact is limited to added coverage assertions and no product files are touched.',
                'Possible side effects: the restart may preserve non-test review receipts and invalidate only the test review.',
                'Required targeted checks: focused review-cycle classification checks cover the remediation artifact fields.',
                'Scope or review-type changes: review-type impact stays in test; code, security, and refactor remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is a test file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, [
            'src/app.ts',
            'tests/app.test.ts',
            'tests/remediation-only.test.ts'
        ]);

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'test_only_expansion');
        assert.deepEqual(classification.invalidated_review_types, ['refactor', 'test']);
        assert.deepEqual(evidence.semantic_changed_files, ['tests/remediation-only.test.ts']);
        assert.equal(evidence.semantic_scope_source, 'expanded_files');
        assert.equal(evidence.test_refactor_trigger_reason, 'new_test_file');
        assert.deepEqual(evidence.test_refactor_trigger_files, ['tests/remediation-only.test.ts']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle reuses upstream non-test evidence after failed test remediation adds only tests', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-892-restart-review-cycle-test-only-rerun';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-test-only-rerun');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle returns test-only remediation to test review',
            plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts', 'tests/remediation-only.test.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle returns test-only remediation to test review',
            ['src/app.ts', 'tests/app.test.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`),
            'agent:code-reviewer'
        );
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-security-review-context.json`),
            'agent:security-reviewer'
        );
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'refactor',
            'REFACTOR REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-refactor-review-context.json`),
            'agent:refactor-reviewer'
        );

        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'remediation-only.test.ts'),
            'it("covers the failed test review rerun", () => {});\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', 'tests/app.test.ts'],
            impactAnalysis: [
                'Reviewer finding: test reviewer reported missing coverage for failed test review rerun routing.',
                'Intended fix: add tests/remediation-only.test.ts assertion coverage only for the failed test lane.',
                'Affected files/contracts: tests/remediation-only.test.ts is the affected file; source contracts are unchanged.',
                'API/runtime/artifact/test impact: test impact is limited to added coverage assertions and no product files are touched.',
                'Possible side effects: stale upstream code, security, or refactor evidence must not be relaunched when lane-domain fingerprints match.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover the remediation artifact.',
                'Scope or review-type changes: review-type impact stays in test; code, security, and refactor remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is a test file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const resumedReuse = await resumeReviewReuseAfterChecklist(
            repoRoot,
            taskId,
            preflightPath,
            ['code', 'security', 'refactor']
        );

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'test_only_expansion');
        assert.deepEqual(classification.invalidated_review_types, ['refactor', 'test']);
        assert.equal(evidence.test_refactor_trigger_reason, 'new_test_file');
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            ['code', 'security']
        );
        assert.deepEqual(
            [...resumedReuse.reusedReviewTypes].sort(),
            ['code', 'security']
        );
        assert.deepEqual(
            [...resumedReuse.launchRequiredReviewTypes].sort(),
            ['refactor']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});

describe('cli/commands/gates – review-cycle remediation reuse policy', {
    skip: process.env[REMEDIATION_PART_ENV] !== 'reuse-policy'
}, () => {
    it('review-evidence-only restart ignores an unchanged dirty-workspace baseline file', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-evidence-only-dirty-baseline';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'review-evidence-only-dirty-baseline'
        );
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'user-change.test.ts'), 'it("belongs to the user", () => {});\n', 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart only invalid delegated review evidence with an unchanged dirty baseline',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart only invalid delegated review evidence with an unchanged dirty baseline',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            reviewEvidenceOnly: true,
            reviewType: 'code',
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: review_evidence_only/u);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(remediationArtifact.status, 'PASSED');
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).previous_changed_files,
            ['src/app.ts']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review-evidence-only restart compares resumed task scope after symmetric dirty-baseline exclusion', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-evidence-only-resumed-dirty-scope';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'review-evidence-only-resumed-dirty-scope'
        );
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const resumedValue = 1;\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Resume invalid delegated review evidence with task scope already present in the dirty baseline',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Resume invalid delegated review evidence with task scope already present in the dirty baseline',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            reviewEvidenceOnly: true,
            reviewType: 'code',
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: review_evidence_only/u);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('schedules every graph-invalidated descendant after evidence-only reviewer failure', () => {
        const dependencyGraph = compileReviewDependencyGraph({
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
        const classification = classifyReviewRemediationFix(
            {
                status: 'OK',
                previousChangedFiles: ['src/app.ts'],
                currentChangedFiles: [],
                expandedFiles: [],
                expandedNonTestFiles: [],
                allowedTestOnlyExpansionFiles: []
            },
            ['code', 'architecture-boundary', 'test'],
            undefined,
            ['(^|/)tests?/'],
            undefined,
            {
                reviewEvidenceOnly: true,
                remediationReviewType: 'code',
                reviewDependencyGraph: dependencyGraph
            }
        );

        assert.deepEqual(classification.invalidated_review_types, ['code', 'architecture-boundary', 'test']);
        assert.deepEqual(buildReviewEvidenceOnlyRestartPlan(
            classification.invalidated_review_types,
            'code'
        ), {
            launchRequiredReviewTypes: ['code', 'architecture-boundary', 'test'],
            pendingReviewTypes: ['code', 'architecture-boundary', 'test'],
            pendingReason: 'failed delegated reviewer evidence invalidated the failed lane and every frozen-graph downstream lane',
            nextStep: 'Rerun next-step to materialize preserved review evidence and prepare fresh reviewer launches for invalidated lanes: code, architecture-boundary, test.'
        });
    });

    it('restart-review-cycle preserves upstream lanes when failed test remediation edits an existing test file', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-existing-test-remediation-reuse';
        const sourceFile = 'src/api/orders.ts';
        const performanceFile = 'perf/review-routing.ts';
        const testFile = 'tests/node/gates/quality-checklist/quality-checklist.test.ts';
        const changedFiles = [sourceFile, performanceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'existing-test-remediation-reuse');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle after failed test review edits existing test coverage only',
            plannedChangedFiles: changedFiles
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const orderStatus = "draft";\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'perf'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, performanceFile), 'export const routingBudgetMs = 25;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("keeps review routing covered", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle after failed test review edits existing test coverage only',
            changedFiles
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        for (const reviewType of ['api', 'code', 'performance', 'refactor', 'security']) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                `${reviewType.toUpperCase()} REVIEW PASSED`,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            'it("keeps review routing covered", () => { assert.equal(1, 1); });\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertion for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; product contracts stay unchanged.`,
                `API/runtime/artifact/test impact: only test impact is expected from ${testFile}; runtime and artifacts stay unchanged.`,
                'Possible side effects: stale upstream api, code, performance, security, or refactor evidence must not be relaunched when lane-domain fingerprints match.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover the existing test-file remediation path.',
                'Scope or review-type changes: review-type impact stays in test; api, code, performance, security, and refactor remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const resumedReuse = await resumeReviewReuseAfterChecklist(
            repoRoot,
            taskId,
            preflightPath,
            ['code', 'security', 'refactor', 'api', 'performance']
        );

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const authoritativeDecision = remediationArtifact.authoritative_review_decision as Record<string, unknown>;
        const authoritativeLaneDecisions = authoritativeDecision.lane_decisions as Array<Record<string, unknown>>;
        const authoritativeLaneByType = new Map(
            authoritativeLaneDecisions.map((lane) => [String(lane.review_type), lane])
        );
        const evidence = classification.evidence as Record<string, unknown>;
        const expectedPreservedReviews = ['api', 'code', 'performance', 'refactor', 'security'];
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'previous_scope_only');
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(evidence.semantic_changed_files, [testFile]);
        assert.equal(evidence.semantic_scope_source, 'impact_analysis_files');
        assert.equal(authoritativeDecision.status, 'READY');
        assert.equal(authoritativeDecision.classification_source, 'runtime_fix');
        assert.deepEqual(authoritativeDecision.invalidated_review_types, ['test']);
        assert.equal(authoritativeLaneByType.get('test')?.mode, 'FULL');
        assert.equal(authoritativeLaneByType.get('test')?.reuse_eligible, false);
        assert.ok(expectedPreservedReviews.every((reviewType) => (
            authoritativeLaneByType.get(reviewType)?.reuse_eligible === true
        )));
        assert.match(String(authoritativeDecision.decision_sha256), /^[0-9a-f]{64}$/u);
        const timelineEvents = readTaskTimelineEvents(repoRoot, taskId);
        const restartEventIndex = findLastTimelineEventIndex(
            timelineEvents,
            (event) => event.event_type === 'REVIEW_CYCLE_RESTARTED'
        );
        const restartEvent = timelineEvents[restartEventIndex];
        assert.equal(
            ((restartEvent?.details as Record<string, unknown>)
                ?.authoritative_review_decision as Record<string, unknown>)?.decision_sha256,
            authoritativeDecision.decision_sha256
        );
        assert.deepEqual(
            [...resumedReuse.reusedReviewTypes].sort(),
            expectedPreservedReviews,
            restartResult.outputLines.join('\n')
        );
        assert.deepEqual(resumedReuse.launchRequiredReviewTypes, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle preserves every supported code-dependent review lane after test-only remediation', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-910-all-supported-lanes-test-remediation';
        const sourceFile = 'src/app.ts';
        const dbFile = 'db/schema.sql';
        const infraFile = 'scripts/deploy.ps1';
        const dependencyFile = 'package.json';
        const testFile = 'tests/app.test.ts';
        const changedFiles = [sourceFile, dbFile, infraFile, dependencyFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot, { infra: true });
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'all-supported-lanes-test-remediation');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle preserves every supported code-dependent lane after test-only remediation',
            plannedChangedFiles: changedFiles
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, dbFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, dbFile), 'create table orders(id integer primary key);\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, infraFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, infraFile), 'Write-Output "deploy"\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, dependencyFile), JSON.stringify({ dependencies: { leftpad: '1.0.0' } }, null, 2) + '\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("keeps the baseline path covered", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle preserves every supported code-dependent lane after test-only remediation',
            changedFiles
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.equal((preflight.required_reviews as Record<string, boolean>).db, true);
        assert.equal((preflight.required_reviews as Record<string, boolean>).dependency, true);
        assert.equal((preflight.required_reviews as Record<string, boolean>).infra, true);
        const upstreamReviews: Array<[string, string]> = [
            ['code', 'REVIEW PASSED'],
            ['db', 'DB REVIEW PASSED'],
            ['dependency', 'DEPENDENCY REVIEW PASSED'],
            ['infra', 'INFRA REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ];
        for (const [reviewType, verdict] of upstreamReviews) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            'it("keeps the baseline path covered", () => { assert.equal(1, 1); });\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertion for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; source, database, infra, and dependency files remain unchanged.`,
                'API/runtime/artifact/test impact: no API or runtime behavior change; only test coverage changes.',
                'Possible side effects: stale upstream code, db, security, refactor, infra, or dependency evidence must not be relaunched when lane-domain fingerprints match.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover all supported code-dependent lane preservation.',
                'Scope or review-type changes: review-type impact stays in test; every supported non-test lane remains a reuse candidate.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const resumedReuse = await resumeReviewReuseAfterChecklist(
            repoRoot,
            taskId,
            preflightPath,
            ['code', 'security', 'refactor', 'db', 'dependency', 'infra']
        );

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const expectedPreservedReviews = ['code', 'db', 'dependency', 'infra', 'refactor', 'security'];
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'previous_scope_only');
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(evidence.semantic_changed_files, [testFile]);
        assert.equal(evidence.semantic_scope_source, 'impact_analysis_files');
        assert.deepEqual(
            [...resumedReuse.reusedReviewTypes].sort(),
            expectedPreservedReviews,
            restartResult.outputLines.join('\n')
        );
        assert.deepEqual(resumedReuse.launchRequiredReviewTypes, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle ignores unchanged product-file mentions in failed test remediation impact text', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-908-negated-runtime-test-remediation';
        const sourceFile = 'src/api/orders.ts';
        const performanceFile = 'perf/review-routing.ts';
        const testFile = 'tests/node/gates/next-step/next-step-quality-checklist-routing.test.ts';
        const changedFiles = [sourceFile, performanceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'negated-runtime-test-remediation');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle after failed test review with unchanged product files',
            plannedChangedFiles: changedFiles
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.mkdirSync(path.dirname(path.join(repoRoot, sourceFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const orderStatus = "draft";\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, performanceFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, performanceFile), 'export const routingBudgetMs = 25;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("keeps quality checklist routing covered", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle after failed test review with unchanged product files',
            changedFiles
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const upstreamReviews: Array<[string, string]> = [
            ['api', 'API REVIEW PASSED'],
            ['code', 'REVIEW PASSED'],
            ['performance', 'PERFORMANCE REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ];
        for (const [reviewType, verdict] of upstreamReviews) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            'it("keeps quality checklist routing covered", () => { assert.equal(1, 1); });\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertion for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; ${sourceFile} remains unchanged and ${performanceFile} remains unchanged.`,
                'API/runtime/artifact/test impact: no API or runtime behavior change; runtime and artifacts stay unchanged, and only test coverage changes.',
                'Possible side effects: stale upstream api, code, performance, security, or refactor evidence must not be relaunched when lane-domain fingerprints match.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover negated runtime impact wording.',
                'Scope or review-type changes: review-type impact stays in test; every unchanged non-test lane remains a reuse candidate.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const resumedReuse = await resumeReviewReuseAfterChecklist(
            repoRoot,
            taskId,
            preflightPath,
            ['code', 'security', 'refactor', 'api', 'performance']
        );

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const expectedPreservedReviews = ['api', 'code', 'performance', 'refactor', 'security'];
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'previous_scope_only');
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(evidence.semantic_changed_files, [testFile]);
        assert.equal(evidence.semantic_scope_source, 'impact_analysis_files');
        assert.equal(evidence.test_refactor_trigger_reason, null);
        assert.deepEqual(
            [...resumedReuse.reusedReviewTypes].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(resumedReuse.launchRequiredReviewTypes, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle invalidates test-scoped refactor when existing test remediation exceeds the configured churn threshold', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-910-large-test-remediation-refactor';
        const sourceFile = 'src/app.ts';
        const testFile = 'tests/app.test.ts';
        const changedFiles = [sourceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'large-test-remediation-refactor');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle after large test-only remediation',
            plannedChangedFiles: changedFiles
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("works", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle after large test-only remediation',
            changedFiles
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        for (const [reviewType, verdict] of [
            ['code', 'REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ] as Array<[string, string]>) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            Array.from({ length: 25 }, (_, index) => `it("covers path ${index}", () => { assert.equal(${index}, ${index}); });`).join('\n') + '\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported broad missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertions for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; ${sourceFile} remains unchanged.`,
                'API/runtime/artifact/test impact: no API or runtime behavior change; only test coverage changes.',
                'Possible side effects: large test-domain churn should receive test-scoped refactor review without relaunching unchanged source lanes.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover threshold-triggered test refactor.',
                'Scope or review-type changes: review-type impact includes refactor and test; code and security remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const resumedReuse = await resumeReviewReuseAfterChecklist(
            repoRoot,
            taskId,
            preflightPath,
            ['code', 'security', 'refactor']
        );

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        assert.equal(classification.category, 'test_coverage_only');
        assert.deepEqual(classification.invalidated_review_types, ['refactor', 'test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            ['code', 'security']
        );
        assert.equal(evidence.test_refactor_trigger_reason, 'test_domain_changed_lines_threshold');
        assert.equal(evidence.test_refactor_changed_lines_threshold, 20);
        assert.ok(Number(evidence.test_refactor_changed_lines_total) > 20);
        assert.deepEqual(
            [...resumedReuse.reusedReviewTypes].sort(),
            ['code', 'security']
        );
        assert.deepEqual(
            [...resumedReuse.launchRequiredReviewTypes].sort(),
            ['refactor']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps refactor review reusable when structural test triggers are explicitly disabled', () => {
        const testFile = 'tests/helpers/recovery-fixture.ts';
        const classification = classifyReviewRemediationFix(
            {
                status: 'OK',
                previousChangedFiles: [testFile],
                currentChangedFiles: [testFile],
                expandedFiles: [],
                expandedNonTestFiles: [],
                allowedTestOnlyExpansionFiles: []
            },
            ['code', 'refactor', 'test'],
            {
                status: 'RECORDED',
                source: 'inline',
                summary: `Reviewer finding and intended fix affect only ${testFile}; test impact is isolated and runtime behavior stays unchanged.`,
                required_topics: [],
                affected_files: [testFile]
            },
            ['(^|/)tests?/'],
            undefined,
            {
                testRefactorChangedLinesThreshold: 100,
                testRefactorStructuralPathRegexes: [],
                changedFileStats: { [testFile]: { changed_lines: 1 } }
            }
        );

        assert.equal(classification.category, 'test_coverage_only');
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(classification.preserved_review_types, ['code', 'refactor']);
        assert.equal(classification.evidence.test_refactor_trigger_reason, null);
        assert.deepEqual(classification.evidence.test_refactor_trigger_files, []);
        assert.equal(classification.evidence.test_refactor_changed_lines_threshold, 100);
    });

    it('expands an upstream remediation classification through custom graph descendants only', () => {
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
        const classification = classifyReviewRemediationFix(
            {
                status: 'OK',
                previousChangedFiles: ['src/app.ts'],
                currentChangedFiles: ['src/app.ts'],
                expandedFiles: [],
                expandedNonTestFiles: [],
                allowedTestOnlyExpansionFiles: []
            },
            ['code', 'security', 'architecture-boundary', 'test'],
            {
                status: 'RECORDED',
                source: 'inline',
                summary: [
                    'Reviewer finding: isolate the _testHooks helper in src/app.ts.',
                    'Intended fix: constrain only test hook exposure without runtime behavior changes.',
                    'Affected files/contracts: src/app.ts changes while public contracts stay stable.',
                    'API/runtime/artifact/test impact: test hook isolation only.',
                    'Possible side effects: downstream graph lanes must refresh.',
                    'Required targeted checks: graph remediation classification.',
                    'Scope or review-type changes: code and its dependent lanes are affected.',
                    'Related blockers/follow-up: none.'
                ].join(' '),
                required_topics: [],
                affected_files: ['src/app.ts']
            },
            ['(^|/)tests?/'],
            undefined,
            { reviewDependencyGraph }
        );

        assert.equal(classification.category, 'test_hook_isolation');
        assert.deepEqual(classification.invalidated_review_types, ['code', 'architecture-boundary', 'test']);
        assert.deepEqual(classification.preserved_review_types, ['security']);
    });

    it('restart-review-cycle fails closed when live test-trigger policy drifts after task entry', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-frozen-recovery-trigger-policy';
        const sourceFile = 'src/app.ts';
        const testFile = 'quality/structural-fixture.ts';
        const changedFiles = [sourceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const pathsConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
        const frozenPathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8')) as {
            triggers: Record<string, string[]>;
            test_refactor_changed_lines_threshold?: number;
        };
        frozenPathsConfig.triggers.test = ['(^|/)quality/'];
        frozenPathsConfig.triggers.test_refactor_structural = ['(^|/)quality/structural-fixture\\.ts$'];
        frozenPathsConfig.test_refactor_changed_lines_threshold = 100;
        fs.writeFileSync(pathsConfigPath, `${JSON.stringify(frozenPathsConfig, null, 2)}\n`, 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'frozen-recovery-trigger-policy');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep recovery trigger classification bound to the task snapshot',
            plannedChangedFiles: changedFiles
        });

        const livePathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8')) as {
            triggers: Record<string, string[]>;
            test_refactor_changed_lines_threshold?: number;
        };
        livePathsConfig.triggers.test = ['(^|/)tests?/'];
        livePathsConfig.triggers.test_refactor_structural = ['(^|/)tests/helpers?/'];
        livePathsConfig.test_refactor_changed_lines_threshold = 1000;
        fs.writeFileSync(pathsConfigPath, `${JSON.stringify(livePathsConfig, null, 2)}\n`, 'utf8');
        runGit(repoRoot, ['add', 'garda-agent-orchestrator/live/config/paths.json']);
        runGit(repoRoot, ['commit', '-m', 'test: mutate live trigger policy after task entry']);

        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'export const fixture = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Keep recovery trigger classification bound to the task snapshot',
            changedFiles
        );
        const frozenPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.equal(
            (frozenPreflight.required_reviews as Record<string, boolean>).security,
            true
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        for (const [reviewType, verdict] of [
            ['code', 'REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ] as Array<[string, string]>) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(path.join(repoRoot, testFile), 'export const fixture = 2;\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer requested a focused fixture correction in ${testFile}.`,
                `Intended fix: edit ${testFile} only while leaving ${sourceFile} unchanged.`,
                `Affected files/contracts: only the frozen-policy test fixture ${testFile} changes.`,
                'API/runtime/artifact/test impact: no API or runtime contract changes; the delta is test-domain-only.',
                'Possible side effects: mutable live trigger config must not change the active task review policy.',
                'Required targeted checks: recovery classification must use the task snapshot test and structural regexes plus threshold.',
                'Scope or review-type changes: refactor and test require fresh review; code and security remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is required.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        assert.match(
            restartResult.outputLines.join('\n'),
            /Task profile policy inputs changed after preflight \(paths\).*Re-enter task mode/isu
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle ignores historical protected scope when remediation delta is test-only', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-906-protected-scope-test-only-remediation';
        const sourceFile = 'src/cli/commands/workflow/workflow-command-set.ts';
        const testFile = 'tests/node/reports/ui-dashboard-assets.test.ts';
        const changedFiles = [sourceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'protected-scope-test-only-remediation'
        );

        fs.mkdirSync(path.dirname(path.join(repoRoot, sourceFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const previousRule = true;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("renders previous UI state", () => {});\n', 'utf8');
        writeProtectedControlPlaneManifest(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart failed test review after test-only remediation with protected historical scope',
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            plannedChangedFiles: changedFiles
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const previousRule = false;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("renders the updated UI state", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart failed test review after test-only remediation with protected historical scope',
            changedFiles
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const upstreamReviews: Array<[string, string]> = [
            ['code', 'REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ];
        for (const [reviewType, verdict] of upstreamReviews) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            'it("renders the updated UI state", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertion for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; product contracts stay unchanged.`,
                `API/runtime/artifact/test impact: only test impact is expected from ${testFile}; runtime and artifacts stay unchanged.`,
                'Possible side effects: historical protected preflight scope must not force fresh upstream reviewers when the remediation delta is test-only.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover the protected historical scope path.',
                'Scope or review-type changes: review-type impact stays in test; code, security, and refactor remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const triggers = refreshedPreflight.triggers as Record<string, unknown>;
        assert.equal(triggers.protected_control_plane_changed, true);
        assert.deepEqual(triggers.changed_protected_files, [sourceFile]);

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        const expectedPreservedReviews = ['code', 'refactor', 'security'];
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'previous_scope_only');
        assert.doesNotMatch(String(classification.reason), /protected-control-plane changes/);
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(evidence.semantic_changed_files, [testFile]);
        assert.equal(evidence.semantic_scope_source, 'impact_analysis_files');
        assert.deepEqual(
            [...((reviewReuse.reused_review_types as string[]) || [])].sort(),
            [],
            restartResult.outputLines.join('\n')
        );
        assert.deepEqual(reviewReuse.launch_required_review_types, []);
        assert.deepEqual(
            [...((reviewReuse.pending_review_types as string[]) || [])].sort(),
            ['code', 'refactor', 'security', 'test']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classifies semantic remediation variants without repeating the full restart workflow', () => {
        const cases: Array<{
            suffix: string;
            changedFile?: string;
            impactAnalysis: string;
            expectedCategory: string;
            expectedReuseCandidate: boolean;
            expectedInvalidatedReviewTypes: string[];
            expectedPreservedReviewTypes: string[];
        }> = [
            {
                suffix: 'test-hooks',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker requires isolating the _testHooks helper in src/app.ts.',
                    'Intended fix: constrain _testHooks exposure in src/app.ts without changing production behavior.',
                    'Affected files/contracts: src/app.ts is the affected file; public contracts stay unchanged.',
                    'API/runtime/artifact/test impact: test hook isolation only; no public contract or security impact is intended.',
                    'Possible side effects: review reuse must fail closed if unrelated behavior changes appear.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: code review may be invalidated, but security and refactor remain candidates.',
                    'Related blockers/follow-up: no separate follow-up is needed for this isolated hook fix.'
                ].join(' '),
                expectedCategory: 'test_hook_isolation',
                expectedReuseCandidate: true,
                expectedInvalidatedReviewTypes: ['code'],
                expectedPreservedReviewTypes: ['refactor', 'security']
            },
            {
                suffix: 'protected-test-hooks',
                changedFile: 'garda-agent-orchestrator/src/cli/app.ts',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker requires isolating the _testHooks helper in garda-agent-orchestrator/src/cli/app.ts.',
                    'Intended fix: constrain _testHooks exposure in the protected CLI control-plane file without changing production behavior.',
                    'Affected files/contracts: garda-agent-orchestrator/src/cli/app.ts is the affected file; public contracts stay unchanged.',
                    'API/runtime/artifact/test impact: test hook isolation only is intended, but protected-control-plane scope must still fail closed.',
                    'Possible side effects: stale security or refactor evidence could miss a protected control-plane regression.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: protected control-plane scope invalidates all required review evidence before reuse.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'test_hook_isolation',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'api-surface',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker changes the public API surface in src/app.ts.',
                    'Intended fix: update the exported API contract in src/app.ts and refresh review evidence.',
                    'Affected files/contracts: src/app.ts is the affected file and its public API contract changes.',
                    'API/runtime/artifact/test impact: public API surface changes require fail-closed review handling.',
                    'Possible side effects: downstream callers may rely on the previous exported contract.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: all affected review types must be reconsidered before reuse.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'api_surface',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['api', 'code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'security',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker touches credential redaction in src/app.ts.',
                    'Intended fix: update security-sensitive token handling in src/app.ts.',
                    'Affected files/contracts: src/app.ts is the affected file and security-sensitive handling changes.',
                    'API/runtime/artifact/test impact: secret redaction evidence must be refreshed.',
                    'Possible side effects: leaked credentials would be a security regression.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: security review must be fresh before any reuse decision.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'security_sensitive',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'runtime-behavior',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker changes observable runtime behavior in src/app.ts.',
                    'Intended fix: update the execution path in src/app.ts and require fresh review evidence.',
                    'Affected files/contracts: src/app.ts is the affected file and runtime behavior changes.',
                    'API/runtime/artifact/test impact: behavior change at runtime requires fail-closed review handling.',
                    'Possible side effects: existing callers may observe different runtime behavior.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: all affected review types must be reconsidered before reuse.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'runtime_behavior',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'source-fallback-runtime',
                impactAnalysis: [
                    'Reviewer finding: the final human report can grow with every non-blocking finding in src/app.ts.',
                    'Intended fix: cap the human preview at ten entries and append the exact remaining count.',
                    'Affected files/contracts: src/app.ts changes while complete machine-readable evidence remains available.',
                    'API/runtime/artifact/test impact: human presentation becomes bounded; schemas and gate APIs remain unchanged.',
                    'Possible side effects: only the first ten entries appear in the concise report.',
                    'Required targeted checks: a high-cardinality bounded-size regression covers the fix.',
                    'Scope or review-type changes: the source and test scope remain unchanged.',
                    'Related blockers/follow-up: the finding is fixed now without a follow-up.'
                ].join(' '),
                expectedCategory: 'runtime_behavior',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'structure-only',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker requires refactor structure cleanup in src/app.ts.',
                    'Intended fix: extract internal helper structure in src/app.ts without changing behavior.',
                    'Affected files/contracts: src/app.ts is the affected file; public contracts stay unchanged.',
                    'Artifact/test impact: refactor structure only; no public contract or privileged handling impact is intended.',
                    'Possible side effects: structural decomposition should preserve existing outputs.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: refactor review may be invalidated, but unrelated reviews remain candidates.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'refactor_structure',
                expectedReuseCandidate: true,
                expectedInvalidatedReviewTypes: ['refactor'],
                expectedPreservedReviewTypes: ['code', 'security']
            },
            {
                suffix: 'ambiguous',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker mixes public API surface and refactor structure in src/app.ts.',
                    'Intended fix: update the public API surface while also changing internal decomposition.',
                    'Affected files/contracts: src/app.ts is the affected file and multiple contracts may shift.',
                    'API/runtime/artifact/test impact: public API surface and refactor structure evidence both matter.',
                    'Possible side effects: mixed semantic scope makes reuse unsafe.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: fail closed because multiple review classes are implicated.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'unknown',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            }
        ];

        for (const scenario of cases) {
            const changedFile = scenario.changedFile || 'src/app.ts';
            const requiredReviewTypes = scenario.expectedInvalidatedReviewTypes.includes('api')
                ? ['api', 'code', 'refactor', 'security']
                : ['code', 'refactor', 'security'];
            const classification = classifyReviewRemediationFix(
                {
                    status: 'OK',
                    previousChangedFiles: [changedFile],
                    currentChangedFiles: [changedFile],
                    expandedFiles: [],
                    expandedNonTestFiles: [],
                    allowedTestOnlyExpansionFiles: []
                },
                requiredReviewTypes,
                {
                    status: 'RECORDED',
                    source: 'inline',
                    summary: scenario.impactAnalysis,
                    required_topics: [],
                    affected_files: [changedFile]
                },
                ['(^|/)tests?/'],
                scenario.changedFile
                    ? {
                        triggers: {
                            protected_control_plane_changed: true,
                            changed_protected_files: [changedFile]
                        }
                    }
                    : undefined
            );
            assert.equal(classification.category, scenario.expectedCategory);
            assert.equal(classification.scope_category, 'previous_scope_only');
            assert.equal(classification.non_test_review_reuse_candidate, scenario.expectedReuseCandidate);
            assert.deepEqual(classification.invalidated_review_types, scenario.expectedInvalidatedReviewTypes);
            assert.deepEqual(classification.preserved_review_types, scenario.expectedPreservedReviewTypes);
            assert.deepEqual(classification.affected_file_groups.source, [changedFile]);
            assert.equal(classification.review_reuse_decision_order, 'classification_before_reuse');
        }
    });

});

describe('cli/commands/gates – review-cycle remediation scope expansion', {
    skip: process.env[REMEDIATION_PART_ENV] !== 'scope-expansion'
}, () => {
    it('restart-review-cycle preserves previous source scope when explicit refresh lists only test remediation', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-explicit-subset';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-explicit-subset');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle preserves prior source scope when explicit remediation scope is narrow',
            plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle preserves prior source scope when explicit remediation scope is narrow',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['tests/app.test.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts', 'tests/app.test.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).code, true);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle normalizes Windows separators in explicit remediation scope', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-windows-separators';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-windows-separators');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle normalizes explicit Windows separator paths',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle normalizes explicit Windows separator paths',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src\\app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_non_test_files,
            []
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle allows __tests__ files as test-only remediation expansion', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-dunder-tests';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-dunder-tests');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle treats __tests__ as test remediation scope',
            plannedChangedFiles: ['src/app.ts', 'src/__tests__/app-helper.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle treats __tests__ as test remediation scope',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        fs.mkdirSync(path.join(repoRoot, 'src', '__tests__'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', '__tests__', 'app-helper.ts'), 'export const ok = true;\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/__tests__/app-helper.ts', 'src/app.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            ['src/__tests__/app-helper.ts']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle uses classifier test regexes for non-JavaScript test expansion', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-classifier-test-regex';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-classifier-test-regex');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle uses classifier test regexes for remediation scope',
            plannedChangedFiles: ['src/app.ts', 'src/app.test.py']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle uses classifier test regexes for remediation scope',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.test.py'), 'def test_app():\n    assert True\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.test.py', 'src/app.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            ['src/app.test.py']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle excludes dirty workspace baseline tests from explicit refresh expansion', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-baseline-test-exclusion';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-baseline-test-exclusion');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'baseline.test.ts'), 'it("unrelated", () => {});\n', 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle does not absorb dirty baseline test files',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle does not absorb dirty baseline test files',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await seedBaselineCompileGatePass({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            []
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_files,
            ['tests/baseline.test.ts']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});

describe('cli/commands/gates – ignored changelog remediation binding', {
    concurrency: false,
    skip: process.env[REMEDIATION_PART_ENV] !== 'ignored-changelog-binding'
}, () => {
    it('restart-review-cycle accepts an explicit ignored changelog remediation target named by the blocker', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-accepted');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added the failed-review release note.\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogReviewRequest(repoRoot, taskId);
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, [
            IGNORED_CHANGELOG_PATH,
            'src/app.ts'
        ]);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const ignoredTargets = remediationArtifact.ignored_remediation_targets as Record<string, unknown>;
        assert.equal(ignoredTargets.status, 'OK');
        assert.deepEqual(
            (ignoredTargets.targets as Array<Record<string, unknown>>).map((target) => target.path),
            [IGNORED_CHANGELOG_PATH]
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_non_test_files,
            []
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    for (const foreignIdentity of [
        {
            label: 'task',
            mutate: (taskId: string) => ({ taskId: `${taskId}-foreign` })
        },
        {
            label: 'review type',
            mutate: () => ({ reviewType: 'test' })
        }
    ]) {
        it(`restart-review-cycle rejects ignored remediation approval from a foreign structured review ${foreignIdentity.label}`, { concurrency: false }, async () => {
            const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
            const {
                repoRoot,
                preflightPath,
                commandsPath,
                outputFiltersPath
            } = await prepareIgnoredChangelogFixture(taskId, `ignored-changelog-foreign-${foreignIdentity.label}`);

            writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
            writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Foreign review must not approve this note.\n');
            prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
            writeFailedIgnoredChangelogReviewRequest(repoRoot, taskId);
            replaceReceiptBoundReviewIdentity(repoRoot, taskId, foreignIdentity.mutate(taskId));

            const restartResult = await runRestartReviewCycleCommand({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                outputFiltersPath,
                changedFiles: [IGNORED_CHANGELOG_PATH],
                impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
                emitMetrics: false
            });

            assert.notEqual(restartResult.exitCode, 0);
            assert.match(
                restartResult.outputLines.join('\n'),
                /ignored remediation target .* is not approved/
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
    }

    it('restart-review-cycle accepts a path-first ignored changelog blocker finding', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-path-first');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added the path-first failed-review release note.\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogPathFirstReviewRequest(repoRoot, taskId);
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.ignored_remediation_targets as Record<string, unknown>).violations,
            []
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle accepts a root ignored changelog target named by a path-first blocker', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(
            taskId,
            'root-ignored-changelog-path-first',
            ROOT_IGNORED_CHANGELOG_PATH
        );

        writeRepoFile(repoRoot, ROOT_IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added the root ignored release note.\n');
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogPathFirstReviewRequest(repoRoot, taskId, ROOT_IGNORED_CHANGELOG_PATH);
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [ROOT_IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(ROOT_IGNORED_CHANGELOG_PATH),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.ok((refreshedPreflight.changed_files as string[]).includes(ROOT_IGNORED_CHANGELOG_PATH));
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const targets = (remediationArtifact.ignored_remediation_targets as Record<string, unknown>)
            .targets as Array<Record<string, unknown>>;
        assert.deepEqual(targets.map((target) => target.path), [ROOT_IGNORED_CHANGELOG_PATH]);
        assert.equal(targets[0].sha256, fileSha256(path.join(repoRoot, ROOT_IGNORED_CHANGELOG_PATH)));
        assert.deepEqual(targets[0].approved_by, ['review_finding']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle accepts an ignored changelog remediation target approved by task plan', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(
            taskId,
            'ignored-changelog-task-plan',
            IGNORED_CHANGELOG_PATH,
            ['src/app.ts', IGNORED_CHANGELOG_PATH]
        );

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedSourceOnlyReviewRequest(repoRoot, taskId);
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added the task-plan approved release note.\n');
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.ok((refreshedPreflight.changed_files as string[]).includes(IGNORED_CHANGELOG_PATH));
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const targets = (remediationArtifact.ignored_remediation_targets as Record<string, unknown>)
            .targets as Array<Record<string, unknown>>;
        assert.deepEqual(targets.map((target) => target.path), [IGNORED_CHANGELOG_PATH]);
        assert.deepEqual(targets[0].approved_by, ['task_plan']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects an explicit ignored file that is not approved by blocker evidence', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-unapproved');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Unapproved ignored release note.\n');
        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: unrelated docs or artifacts must not be absorbed by review-cycle recovery.',
                'Required targeted checks: compile gate and review-cycle scope assertions cover the source fix.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /ignored remediation target .* is not approved/);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(remediationArtifact.status, 'BLOCKED');
        assert.equal(remediationArtifact.reason, 'ignored_remediation_target_invalid');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects ignored-only changed-file self-approval through impact analysis', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-impact-only');

        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Impact-only ignored release note.\n');
        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle ignores impact-analysis-only ignored path mentions outside changed scope', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-impact-mention-unchanged');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                `Possible side effects: do not update ${IGNORED_CHANGELOG_PATH}; release notes stay outside this remediation.`,
                'Required targeted checks: compile gate and review-cycle scope assertions cover the source fix.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle ignores generated review markdown when approving ignored remediation targets', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-generated-context-only');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Context-only ignored release note.\n');
        fs.writeFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.md`),
            [
                '# Generated Review Context',
                '',
                `This generated handoff mentions ${IGNORED_CHANGELOG_PATH}, but it is not the failed review output.`
            ].join('\n'),
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: generated review context must not approve ignored remediation targets.',
                'Required targeted checks: restart-review-cycle rejects context-only ignored-file mentions.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});

describe('cli/commands/gates – ignored changelog remediation guards', {
    concurrency: false,
    skip: process.env[REMEDIATION_PART_ENV] !== 'ignored-changelog-guards'
}, () => {
    it('restart-review-cycle rejects ignored paths mentioned only as failed-review diagnostics', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-diagnostic-only');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Diagnostic-only ignored release note.\n');
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
            '# Code Review',
            '',
            `Diagnostic reproduction: the resolver accepted ${IGNORED_CHANGELOG_PATH} when it appeared in unrelated context text.`,
            '',
            '## Findings by Severity',
            'High: restrict ignored remediation approval to actionable failed-review requests and guarded evidence.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'CODE REVIEW FAILED'
        ]);

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: diagnostic examples in failed reviews must not approve ignored paths.',
                'Required targeted checks: restart-review-cycle rejects diagnostic-only ignored-file mentions.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects ignored paths mentioned only in failed-review examples', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-example-only');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Example-only ignored release note.\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogExampleOnlyReviewRequest(repoRoot, taskId);
        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: example wording in failed reviews must not approve ignored paths.',
                'Required targeted checks: restart-review-cycle rejects example-only ignored-file mentions.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects negated failed-review ignored path mentions', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-negated-review');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Negated ignored release note.\n');
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
            '# Code Review',
            '',
            `Do not update ${IGNORED_CHANGELOG_PATH}; remove this ignored release-note change from the remediation scope.`,
            '',
            '## Findings by Severity',
            'High: keep ignored release-note artifacts outside this failed-review remediation.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'CODE REVIEW FAILED'
        ]);

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: negated failed-review text must not approve ignored paths.',
                'Required targeted checks: restart-review-cycle rejects negated ignored-file mentions.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle accepts current guarded hash evidence for an ignored remediation target', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-current-guard');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedSourceOnlyReviewRequest(repoRoot, taskId);
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Updated with guarded hash evidence.\n');
        const currentSha256 = fileSha256(path.join(repoRoot, ...IGNORED_CHANGELOG_PATH.split('/')));
        const impactAnalysisPath = path.join(getReviewsRoot(repoRoot), `${taskId}-impact-analysis.json`);
        fs.writeFileSync(impactAnalysisPath, JSON.stringify({
            'reviewer finding': 'failed review requires source remediation; guarded ignored-file evidence supplies release-note scope',
            'intended fix': `carry the ignored changelog remediation target ${IGNORED_CHANGELOG_PATH} only through guarded current hash evidence`,
            'affected files and contracts': `${IGNORED_CHANGELOG_PATH} is the affected artifact; runtime contracts stay unchanged`,
            'api/runtime/artifact/test impact': `artifact impact is limited to ${IGNORED_CHANGELOG_PATH} with compile evidence refreshed`,
            'possible side effects': 'review reuse must fail closed if guarded ignored-file evidence is stale or hashless',
            'required targeted checks': 'restart-review-cycle must accept a matching guarded ignored-file hash',
            'scope or review-type changes': 'the ignored changelog is in scope only with current guarded hash evidence',
            'related blocker or follow-up decision': 'no follow-up is needed for current guarded evidence',
            ignored_remediation_targets: [
                {
                    path: IGNORED_CHANGELOG_PATH,
                    sha256: currentSha256,
                    reason: 'current guarded evidence approves ignored remediation'
                }
            ]
        }, null, 2), 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysisPath,
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.ok((refreshedPreflight.changed_files as string[]).includes(IGNORED_CHANGELOG_PATH));
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const targets = (remediationArtifact.ignored_remediation_targets as Record<string, unknown>)
            .targets as Array<Record<string, unknown>>;
        assert.deepEqual(targets.map((target) => target.path), [IGNORED_CHANGELOG_PATH]);
        assert.equal(targets[0].sha256, currentSha256);
        assert.deepEqual(targets[0].approved_by, ['guarded_remediation_evidence']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects stale guarded hash evidence for an ignored remediation target', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-stale-hash');
        const oldSha256 = fileSha256(path.join(repoRoot, ...IGNORED_CHANGELOG_PATH.split('/')));
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Updated after hash capture.\n');
        const impactAnalysisPath = path.join(getReviewsRoot(repoRoot), `${taskId}-impact-analysis.json`);
        fs.writeFileSync(impactAnalysisPath, JSON.stringify({
            'reviewer finding': `failed review requires release-note remediation in ${IGNORED_CHANGELOG_PATH}`,
            'intended fix': `update the ignored changelog remediation target ${IGNORED_CHANGELOG_PATH}`,
            'affected files and contracts': `${IGNORED_CHANGELOG_PATH} and src/app.ts are the affected files; runtime contracts stay unchanged`,
            'api/runtime/artifact/test impact': `artifact impact is limited to ${IGNORED_CHANGELOG_PATH} with compile evidence refreshed`,
            'possible side effects': 'review reuse must fail closed if guarded ignored-file evidence is stale',
            'required targeted checks': 'restart-review-cycle must validate the ignored file hash before preflight refresh',
            'scope or review-type changes': 'the ignored changelog is in scope only with current guarded hash evidence',
            'related blocker or follow-up decision': 'no follow-up is needed for current guarded evidence',
            ignored_remediation_targets: [
                {
                    path: IGNORED_CHANGELOG_PATH,
                    sha256: oldSha256,
                    reason: 'failed review requested changelog remediation'
                }
            ]
        }, null, 2), 'utf8');

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysisPath,
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target hash mismatch/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects hashless guarded evidence for an ignored remediation target', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-hashless-guard');
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Updated without guarded hash.\n');
        const impactAnalysisPath = path.join(getReviewsRoot(repoRoot), `${taskId}-impact-analysis.json`);
        fs.writeFileSync(impactAnalysisPath, JSON.stringify({
            'reviewer finding': `failed review requires release-note remediation in ${IGNORED_CHANGELOG_PATH}`,
            'intended fix': `update the ignored changelog remediation target ${IGNORED_CHANGELOG_PATH}`,
            'affected files and contracts': `${IGNORED_CHANGELOG_PATH} and src/app.ts are the affected files; runtime contracts stay unchanged`,
            'api/runtime/artifact/test impact': `artifact impact is limited to ${IGNORED_CHANGELOG_PATH} with compile evidence refreshed`,
            'possible side effects': 'review reuse must fail closed if guarded ignored-file evidence is missing a hash',
            'required targeted checks': 'restart-review-cycle must require a current hash for guarded ignored-file evidence',
            'scope or review-type changes': 'the ignored changelog is in scope only with current guarded hash evidence',
            'related blocker or follow-up decision': 'no follow-up is needed for current guarded evidence',
            ignored_remediation_targets: [
                {
                    path: IGNORED_CHANGELOG_PATH,
                    reason: 'hashless guarded evidence must not approve ignored remediation'
                }
            ]
        }, null, 2), 'utf8');

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysisPath,
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /guarded evidence must include current sha256/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refreshes mixed tracked and explicit ignored remediation scope', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-mixed');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 3;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Documented the source remediation.\n');
        writeFailedIgnoredChangelogReviewRequest(repoRoot, taskId);
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                `Reviewer finding: failed review requires source remediation in src/app.ts and release-note remediation in ${IGNORED_CHANGELOG_PATH}.`,
                `Intended fix: update src/app.ts and the explicit ignored changelog ${IGNORED_CHANGELOG_PATH}.`,
                `Affected files/contracts: src/app.ts and ${IGNORED_CHANGELOG_PATH} are affected while public contracts stay unchanged.`,
                'API/runtime/artifact/test impact: runtime evidence comes from src/app.ts and artifact evidence comes from the ignored changelog.',
                'Possible side effects: review reuse must fail closed if source behavior or ignored artifact evidence drifts.',
                'Required targeted checks: compile gate and review-cycle scope assertions cover the mixed remediation.',
                'Scope or review-type changes: refreshed preflight must include both tracked and explicit ignored files.',
                'Related blockers/follow-up: both changes resolve the same failed-review blocker.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, [
            IGNORED_CHANGELOG_PATH,
            'src/app.ts'
        ]);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.ignored_remediation_targets as Record<string, unknown>).violations,
            []
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('next-step includes explicit ignored changelog remediation in failed-review restart command', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'next-step-ignored-changelog');
        void commandsPath;
        void outputFiltersPath;
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added reviewer-requested note.\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogPathFirstReviewRequest(repoRoot, taskId);
        writeRepoFile(repoRoot, 'tests/remediation-only.test.ts', 'it("covers remediation", () => {});\n');

        const nextStep = resolveNextStep({ taskId, repoRoot });
        const commandText = nextStep.commands.map((command) => command.command).join('\n');
        assert.match(commandText, /restart-review-cycle/, JSON.stringify(nextStep, null, 2));
        assert.match(commandText, new RegExp(`--changed-file "${IGNORED_CHANGELOG_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('next-step does not include example-only ignored changelog mentions in failed-review restart command', { concurrency: false }, async () => {
        const taskId = SHARED_IGNORED_CHANGELOG_TASK_ID;
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'next-step-example-only-ignored-changelog');
        void commandsPath;
        void outputFiltersPath;
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Example-only reviewer note.\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogExampleOnlyReviewRequest(repoRoot, taskId);
        writeRepoFile(repoRoot, 'tests/remediation-only.test.ts', 'it("covers remediation", () => {});\n');

        const nextStep = resolveNextStep({ taskId, repoRoot });
        const commandText = nextStep.commands.map((command) => command.command).join('\n');
        assert.match(commandText, /restart-review-cycle/, JSON.stringify(nextStep, null, 2));
        assert.doesNotMatch(
            commandText,
            new RegExp(`--changed-file "${IGNORED_CHANGELOG_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
