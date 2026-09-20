import * as fs from 'node:fs';

import { sha256RedactedJsonPayload } from '../../../../core/redaction';
import { isPlainRecord } from '../../../../core/records';
import {
    buildReviewContext
} from '../../../../gates/review-context/build-review-context';
import { readReviewContextChangedFiles } from '../../../../gates/review-context/review-context-diff';
import { fileSha256 } from '../../../../gates/shared/helpers';
import { assertReviewLifecycleGuardFromEntries } from '../../../../gates/review/review-lifecycle-guard';
import {
    assertRequiredUpstreamReviewDependencies
} from '../../../../gates/review/review-dependencies';
import {
    computeReviewContextReuseHash
} from '../../../../gates/review-reuse/review-reuse';
import {
    getAuthoritativeReviewRemediationDecisionViolations,
    type AuthoritativeReviewRemediationDecision,
    type ReviewRemediationDecisionClassification
} from '../../../../gates/review-remediation/review-remediation-recovery-routing';
import {
    buildReviewRemediationReviewContract,
    getReviewRemediationReviewContractViolations,
    type ReviewRemediationAuthoritativeDecisionBinding,
    type ReviewRemediationReviewContract,
    type ReviewRemediationReviewContractValidationAuthority
} from '../../../../gates/review-remediation/review-remediation-review-contract';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events';
import {
    buildAcceptedCurrentPassReviewContextCommandResult,
    buildGeneratedReviewContextCommandResult,
    resolveBuildReviewContextCommandInputs,
    type BuildReviewContextCommandOptions,
    type BuildReviewContextCommandResult
} from './review-context-command-binding';
import {
    emitCurrentPassReviewContextReuseAccepted,
    emitGeneratedReviewContextPreparationTelemetry
} from './review-context-telemetry';
import {
    tryAcceptCurrentPassReviewEvidence
} from './review-context-flow-current-pass-reuse';
import {
    tryReuseReviewEvidence,
    type ReviewReuseResult
} from './review-context-flow-historical-reuse';

export {
    readTimelineEventsSummary,
    type BuildReviewContextCommandOptions,
    type BuildReviewContextCommandResult
} from './review-context-command-binding';

function taskEventSequence(event: Record<string, unknown>): number {
    return isPlainRecord(event.integrity)
        ? Number(event.integrity.task_sequence) || 0
        : 0;
}

export interface AuthenticatedFreshPassReviewEvidence {
    reviewRecordedSequence: number;
    remediationMode: string | null;
    authoritativeDecisionSha256: string | null;
    classificationSha256: string | null;
}

function hasAuthenticatedFreshPassAfterBoundary(options: {
    evidence: AuthenticatedFreshPassReviewEvidence | null;
    boundarySequence: number;
    authoritativeDecision?: AuthoritativeReviewRemediationDecision | null;
    laneMode?: unknown;
}): boolean {
    const evidence = options.evidence;
    if (!evidence || evidence.reviewRecordedSequence <= options.boundarySequence) {
        return false;
    }
    if (!options.authoritativeDecision) {
        return true;
    }
    return evidence.remediationMode === String(options.laneMode || '').trim().toUpperCase()
        && evidence.authoritativeDecisionSha256 === options.authoritativeDecision.decision_sha256
        && evidence.classificationSha256 === options.authoritativeDecision.classification_sha256;
}

export interface PersistedRemediationReusePolicy {
    blockedReason: string;
    preservedScopeMismatchReason: string;
    reviewExecutionContract?: ReviewRemediationReviewContract | null;
    reviewExecutionValidationAuthority?: ReviewRemediationReviewContractValidationAuthority | null;
    persistedRemediationReuseRequired?: boolean;
    acceptsPreservedCurrentPassContract?: boolean;
    failClosed?: boolean;
}

export function bindAuthoritativeRemediationDecisionToPreflight(
    decision: AuthoritativeReviewRemediationDecision,
    preflightSha256: string
): ReviewRemediationAuthoritativeDecisionBinding {
    const normalizedPreflightSha256 = String(preflightSha256 || '').trim().toLowerCase();
    if ('preflight_sha256' in decision) {
        const existingBinding = decision as ReviewRemediationAuthoritativeDecisionBinding;
        const violations = getAuthoritativeReviewRemediationDecisionViolations(existingBinding);
        if (existingBinding.preflight_sha256 !== normalizedPreflightSha256) {
            violations.push('authoritative remediation decision preflight_sha256 is stale.');
        }
        if (violations.length > 0) {
            throw new Error(`Persisted authoritative remediation decision is invalid: ${violations.join(' ')}`);
        }
        return existingBinding;
    }
    const decisionWithoutHash = {
        ...decision,
        preflight_sha256: normalizedPreflightSha256
    } as Record<string, unknown>;
    delete decisionWithoutHash.decision_sha256;
    return {
        ...decisionWithoutHash,
        decision_sha256: sha256RedactedJsonPayload(decisionWithoutHash)
    } as unknown as ReviewRemediationAuthoritativeDecisionBinding;
}

function emptyPersistedRemediationReusePolicy(
    overrides: Partial<PersistedRemediationReusePolicy> = {}
): PersistedRemediationReusePolicy {
    return {
        blockedReason: '',
        preservedScopeMismatchReason: '',
        ...overrides
    };
}

export function buildAuthenticatedRemediationReviewExecution(options: {
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    fullReviewScope: readonly string[];
    authoritativeDecision: AuthoritativeReviewRemediationDecision;
    authoritativeClassification: ReviewRemediationDecisionClassification;
    persistedDecisionSha256?: string | null;
}): {
    contract: ReviewRemediationReviewContract;
    validationAuthority: ReviewRemediationReviewContractValidationAuthority;
} {
    const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
        options.authoritativeDecision,
        options.preflightSha256
    );
    const contract = buildReviewRemediationReviewContract({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.preflightSha256,
        fullReviewScope: options.fullReviewScope,
        authoritativeDecision,
        classification: options.authoritativeClassification
    });
    const validationAuthority: ReviewRemediationReviewContractValidationAuthority = {
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.preflightSha256,
        mode: contract.mode,
        fullReviewScope: options.fullReviewScope,
        persistedDecisionSha256: options.persistedDecisionSha256
            ?? options.authoritativeDecision.decision_sha256,
        authoritativeDecisionSha256: options.authoritativeDecision.decision_sha256,
        authoritativeClassificationSha256: options.authoritativeDecision.classification_sha256,
        authoritativeDecision,
        authoritativeClassification: options.authoritativeClassification
    };
    const violations = getReviewRemediationReviewContractViolations(contract, validationAuthority);
    if (violations.length > 0) {
        throw new Error(`Authenticated remediation review execution is invalid: ${violations.join(' ')}`);
    }
    return { contract, validationAuthority };
}

export function resolvePersistedRemediationReusePolicy(options: {
    events: Record<string, unknown>[];
    taskId: string;
    reviewType: string;
    preflightPath: string;
    timelinePath: string;
    preflightPayload?: Record<string, unknown> | null;
    authenticatedFreshPassReviewEvidence?: AuthenticatedFreshPassReviewEvidence | null;
}): PersistedRemediationReusePolicy {
    const resolvedPreflightSha256 = fileSha256(options.preflightPath);
    if (!resolvedPreflightSha256) {
        return emptyPersistedRemediationReusePolicy();
    }
    const preflightSha256 = resolvedPreflightSha256.toLowerCase();
    let preflightPayload = options.preflightPayload || null;
    if (!preflightPayload) {
        try {
            preflightPayload = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8')) as Record<string, unknown>;
        } catch {
            preflightPayload = null;
        }
    }
    const fullReviewScope = readReviewContextChangedFiles(preflightPayload?.changed_files);
    const hasMatchingRestartEvent = options.events.some((event) => {
        const details = isPlainRecord(event.details) ? event.details : {};
        return String(event.event_type || '').trim() === 'REVIEW_CYCLE_RESTARTED'
            && String(details.task_id || '').trim() === options.taskId
            && String(details.preflight_sha256 || '').trim().toLowerCase() === preflightSha256;
    });
    if (
        hasMatchingRestartEvent
        && !inspectTaskEventFile(options.timelinePath, options.taskId).status.startsWith('PASS')
    ) {
        return emptyPersistedRemediationReusePolicy({
            blockedReason:
                'review reuse blocked because the persisted remediation timeline failed hash-chain integrity validation',
            failClosed: true
        });
    }
    for (let index = options.events.length - 1; index >= 0; index -= 1) {
        const event = options.events[index];
        const details = isPlainRecord(event.details) ? event.details : {};
        if (
            String(event.event_type || '').trim() !== 'REVIEW_CYCLE_RESTARTED'
            || String(details.task_id || '').trim() !== options.taskId
            || String(details.event_type || '').trim() !== 'REVIEW_CYCLE_RESTARTED'
            || String(details.status || '').trim() !== 'PASSED'
            || String(details.preflight_sha256 || '').trim().toLowerCase() !== preflightSha256
            || taskEventSequence(event) <= 0
        ) {
            continue;
        }
        if (details.authoritative_review_decision !== undefined) {
            const authoritativeDecision = details.authoritative_review_decision;
            const violations = getAuthoritativeReviewRemediationDecisionViolations(
                authoritativeDecision,
                { expectedTaskId: options.taskId }
            );
            if (violations.length > 0 || !isPlainRecord(authoritativeDecision)) {
                return emptyPersistedRemediationReusePolicy({
                    blockedReason:
                        `review reuse blocked because the persisted authoritative remediation decision `
                        + `failed validation: ${violations.join(' ')}`,
                    failClosed: true
                });
            }
            if (authoritativeDecision.status !== 'READY') {
                return emptyPersistedRemediationReusePolicy({
                    blockedReason:
                        `review reuse blocked because the persisted authoritative remediation decision is `
                        + `${String(authoritativeDecision.status || 'unknown')}`,
                    failClosed: true
                });
            }
            const authoritativeClassification = details.authoritative_review_classification;
            if (authoritativeClassification !== undefined) {
                if (!isPlainRecord(authoritativeClassification) || !preflightPayload) {
                    return emptyPersistedRemediationReusePolicy({
                        blockedReason:
                            'review reuse blocked because the persisted authoritative remediation classification is invalid',
                        failClosed: true
                    });
                }
            }
            const laneDecision = Array.isArray(authoritativeDecision.lane_decisions)
                ? authoritativeDecision.lane_decisions.find((entry) => (
                    isPlainRecord(entry)
                    && String(entry.review_type || '').trim().toLowerCase() === options.reviewType
                ))
                : undefined;
            if (!isPlainRecord(laneDecision)) {
                return emptyPersistedRemediationReusePolicy({
                    blockedReason:
                        `review reuse blocked because the persisted authoritative remediation decision `
                        + `does not contain required lane '${options.reviewType}'`,
                    failClosed: true
                });
            }
            if (
                laneDecision.reuse_eligible !== true
                && hasAuthenticatedFreshPassAfterBoundary({
                    evidence: options.authenticatedFreshPassReviewEvidence || null,
                    boundarySequence: taskEventSequence(event),
                    authoritativeDecision:
                        authoritativeDecision as unknown as AuthoritativeReviewRemediationDecision,
                    laneMode: laneDecision.mode
                })
            ) {
                return emptyPersistedRemediationReusePolicy();
            }
            if (authoritativeClassification !== undefined) {
                const typedDecision = authoritativeDecision as unknown as AuthoritativeReviewRemediationDecision;
                const typedClassification = authoritativeClassification as unknown as ReviewRemediationDecisionClassification;
                const authorityLane = typedDecision.lane_decisions.find((entry) => (
                    entry.review_type === typedDecision.current_review_type
                ));
                if (!authorityLane || authorityLane.mode === 'REUSE') {
                    return emptyPersistedRemediationReusePolicy({
                        blockedReason:
                            'review reuse blocked because the persisted remediation authority has no executable FULL/DELTA origin lane',
                        failClosed: true
                    });
                }
                try {
                    buildAuthenticatedRemediationReviewExecution({
                        taskId: options.taskId,
                        reviewType: authorityLane.review_type,
                        preflightSha256,
                        fullReviewScope,
                        authoritativeDecision: typedDecision,
                        authoritativeClassification: typedClassification,
                        persistedDecisionSha256: typedDecision.decision_sha256
                    });
                } catch (error: unknown) {
                    return emptyPersistedRemediationReusePolicy({
                            blockedReason:
                                'review reuse blocked because the persisted remediation authority failed authentication: '
                            + (error instanceof Error ? error.message : String(error)),
                        failClosed: true
                    });
                }
            }
            if (laneDecision.reuse_eligible !== true) {
                let execution = {
                    contract: null as ReviewRemediationReviewContract | null,
                    validationAuthority: null as ReviewRemediationReviewContractValidationAuthority | null
                };
                if (authoritativeClassification !== undefined && laneDecision.mode !== 'REUSE') {
                    try {
                        execution = buildAuthenticatedRemediationReviewExecution({
                            taskId: options.taskId,
                            reviewType: options.reviewType,
                            preflightSha256,
                            fullReviewScope,
                            authoritativeDecision: authoritativeDecision as unknown as AuthoritativeReviewRemediationDecision,
                            authoritativeClassification:
                                authoritativeClassification as unknown as ReviewRemediationDecisionClassification,
                            persistedDecisionSha256: String(authoritativeDecision.decision_sha256 || '')
                        });
                    } catch (error: unknown) {
                        return emptyPersistedRemediationReusePolicy({
                            blockedReason:
                                'review reuse blocked because the persisted lane execution failed authentication: '
                                + (error instanceof Error ? error.message : String(error)),
                            failClosed: true
                        });
                    }
                }
                return emptyPersistedRemediationReusePolicy({
                    blockedReason: String(laneDecision.reason || '').trim()
                        || `review reuse blocked by authoritative remediation lane '${options.reviewType}'`,
                    reviewExecutionContract: execution.contract,
                    reviewExecutionValidationAuthority: execution.validationAuthority
                });
            }
            if (authoritativeClassification !== undefined && laneDecision.mode === 'REUSE') {
                return emptyPersistedRemediationReusePolicy({
                    preservedScopeMismatchReason: String(laneDecision.reason || '').trim(),
                    persistedRemediationReuseRequired: true
                });
            }
            let execution = {
                contract: null as ReviewRemediationReviewContract | null,
                validationAuthority: null as ReviewRemediationReviewContractValidationAuthority | null
            };
            if (authoritativeClassification !== undefined) {
                try {
                    execution = buildAuthenticatedRemediationReviewExecution({
                        taskId: options.taskId,
                        reviewType: options.reviewType,
                        preflightSha256,
                        fullReviewScope,
                        authoritativeDecision: authoritativeDecision as unknown as AuthoritativeReviewRemediationDecision,
                        authoritativeClassification:
                            authoritativeClassification as unknown as ReviewRemediationDecisionClassification,
                        persistedDecisionSha256: String(authoritativeDecision.decision_sha256 || '')
                    });
                } catch (error: unknown) {
                    return emptyPersistedRemediationReusePolicy({
                        blockedReason:
                            'review reuse blocked because the persisted lane execution failed authentication: '
                            + (error instanceof Error ? error.message : String(error)),
                        failClosed: true
                    });
                }
            }
            return emptyPersistedRemediationReusePolicy({
                blockedReason: '',
                preservedScopeMismatchReason: String(laneDecision.reason || '').trim(),
                acceptsPreservedCurrentPassContract: authoritativeClassification !== undefined
                    && laneDecision.mode === 'FULL'
                    && laneDecision.reuse_eligible === true
                    && laneDecision.invalidated === false
                    && laneDecision.satisfied === false
                    && laneDecision.reason_code === 'authoritative_reuse_pending',
                reviewExecutionContract: execution.contract,
                reviewExecutionValidationAuthority: execution.validationAuthority
            });
        }
        const category = String(details.remediation_category || '').trim() || 'unknown';
        const invalidatedReviewTypes = new Set(
            Array.isArray(details.invalidated_review_types)
                ? details.invalidated_review_types
                    .map((entry) => String(entry || '').trim().toLowerCase())
                    .filter(Boolean)
                : []
        );
        if (invalidatedReviewTypes.has(options.reviewType)) {
            if (hasAuthenticatedFreshPassAfterBoundary({
                evidence: options.authenticatedFreshPassReviewEvidence || null,
                boundarySequence: taskEventSequence(event),
            })) {
                    return emptyPersistedRemediationReusePolicy();
                }
            return emptyPersistedRemediationReusePolicy({
                blockedReason:
                    `review reuse blocked by persisted remediation classification '${category}' ` +
                    `for invalidated review type '${options.reviewType}'`,
            });
        }
        return emptyPersistedRemediationReusePolicy({
            blockedReason: '',
            preservedScopeMismatchReason:
                `persisted remediation classification '${category}' preserved review type '${options.reviewType}'`
        });
    }
    return emptyPersistedRemediationReusePolicy();
}

export function shouldAcceptCurrentPassReviewEvidence(
    evidence: { accepted: boolean; reusedExistingReview: boolean } | null,
    reviewReuseBlockedReason: string
): boolean {
    return evidence?.accepted === true
        && (!reviewReuseBlockedReason || evidence.reusedExistingReview === false);
}

function reviewContextMatchesExecutionContract(
    reviewContextPath: string,
    contract: ReviewRemediationReviewContract | null | undefined
): boolean {
    if (!contract) {
        return true;
    }
    try {
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewExecution = isPlainRecord(reviewContext.review_execution)
            ? reviewContext.review_execution
            : null;
        return String(reviewExecution?.contract_sha256 || '').trim().toLowerCase()
            === contract.contract_sha256;
    } catch {
        return false;
    }
}

export async function runBuildReviewContextCommand(
    options: BuildReviewContextCommandOptions
): Promise<BuildReviewContextCommandResult> {
    const {
        repoRoot,
        reviewType,
        depth,
        preflightPath,
        preflightPayload,
        taskModePath,
        taskId,
        taskModeEvidence,
        runtimeReviewerIdentity,
        timelinePath,
        timelineSummary,
        tokenEconomyConfigPath,
        outputPath,
        scopedDiffMetadataPath,
        focusedRequiredTestPath,
        reviewReuseBlockedReason,
        reviewExecutionContract,
        reviewExecutionValidationAuthority,
        persistedRemediationReuseRequired
    } = resolveBuildReviewContextCommandInputs(options);
    if ((reviewExecutionContract === null) !== (reviewExecutionValidationAuthority === null)) {
        throw new Error('Review execution contract and validation authority must be supplied together.');
    }
    const explicitReviewExecutionViolations = reviewExecutionContract && reviewExecutionValidationAuthority
        ? getReviewRemediationReviewContractViolations(
            reviewExecutionContract,
            reviewExecutionValidationAuthority
        )
        : [];
    if (explicitReviewExecutionViolations.length > 0) {
        throw new Error(
            `Explicit remediation review execution authority is invalid: `
            + explicitReviewExecutionViolations.join(' ')
        );
    }
    const explicitLaneDecision = reviewExecutionValidationAuthority?.authoritativeDecision?.lane_decisions
        .find((entry) => entry.review_type === reviewType) || null;
    let persistedRemediationReusePolicy = emptyPersistedRemediationReusePolicy();
    let currentPassReviewEvidence = null as ReturnType<typeof tryAcceptCurrentPassReviewEvidence> | null;
    if (taskId) {
        assertReviewLifecycleGuardFromEntries(
            String(timelinePath),
            timelineSummary?.events || [],
            timelineSummary?.hasInvalidLines === true,
            'build-review-context',
            'review_phase'
        );
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: timelineSummary?.events || [],
            taskModePath,
            runtimeReviewerIdentity
        });
        currentPassReviewEvidence = tryAcceptCurrentPassReviewEvidence({
            repoRoot,
            taskId,
            reviewType,
            preflightPath,
            preflightPayload,
            reviewContextPath: outputPath,
            timelineEventsSummary: timelineSummary
        });
        if (timelineSummary) {
            const authenticatedFreshPassReviewEvidence = currentPassReviewEvidence.accepted
                && currentPassReviewEvidence.reusedExistingReview === false
                && currentPassReviewEvidence.reviewRecordedSequence !== null
                ? {
                    reviewRecordedSequence: currentPassReviewEvidence.reviewRecordedSequence,
                    remediationMode: currentPassReviewEvidence.remediationMode,
                    authoritativeDecisionSha256:
                        currentPassReviewEvidence.remediationAuthoritativeDecisionSha256,
                    classificationSha256: currentPassReviewEvidence.remediationClassificationSha256
                }
                : null;
            persistedRemediationReusePolicy = resolvePersistedRemediationReusePolicy({
                events: timelineSummary.events as unknown as Record<string, unknown>[],
                taskId,
                reviewType,
                preflightPath,
                timelinePath: String(timelinePath),
                preflightPayload,
                authenticatedFreshPassReviewEvidence
            });
        }
    }
    const effectiveReviewExecutionContract = reviewExecutionContract
        || persistedRemediationReusePolicy.reviewExecutionContract;
    const effectiveReviewExecutionValidationAuthority = reviewExecutionValidationAuthority
        || persistedRemediationReusePolicy.reviewExecutionValidationAuthority;
    if (persistedRemediationReusePolicy.failClosed) {
        throw new Error(persistedRemediationReusePolicy.blockedReason);
    }
    const effectiveReviewReuseBlockedReason = reviewReuseBlockedReason
        || (explicitLaneDecision?.reuse_eligible === false
            ? explicitLaneDecision.reason
            : '')
        || persistedRemediationReusePolicy.blockedReason;
    const effectiveRemediationPreservedScopeMismatchReason =
        (explicitLaneDecision?.reuse_eligible === true
            ? explicitLaneDecision.reason
            : '')
        || persistedRemediationReusePolicy.preservedScopeMismatchReason;
    const effectivePersistedRemediationReuseRequired = persistedRemediationReuseRequired
        || persistedRemediationReusePolicy.persistedRemediationReuseRequired;
    let previousReviewContextReuseSha256: string | null = null;
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).isFile()) {
        try {
            previousReviewContextReuseSha256 = computeReviewContextReuseHash(
                JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>
            );
        } catch {
            previousReviewContextReuseSha256 = null;
        }
    }
    const currentPassReviewEvidenceAccepted = shouldAcceptCurrentPassReviewEvidence(
        currentPassReviewEvidence,
        effectiveReviewReuseBlockedReason
    ) && reviewContextMatchesExecutionContract(
        currentPassReviewEvidence?.reviewContextPath || outputPath,
        reviewExecutionContract
            || (persistedRemediationReusePolicy.acceptsPreservedCurrentPassContract
                ? undefined
                : effectiveReviewExecutionContract)
    );
    if (currentPassReviewEvidenceAccepted && currentPassReviewEvidence) {
        await emitCurrentPassReviewContextReuseAccepted({
            repoRoot,
            taskId,
            reviewType,
            depth,
            preflightPath,
            reviewContextPath: currentPassReviewEvidence.reviewContextPath,
            ruleContextArtifactPath: currentPassReviewEvidence.ruleContextArtifactPath,
            currentPassReviewEvidence,
            telemetryLockTimeoutMs: options.telemetryLockTimeoutMs,
            telemetryLockRetryMs: options.telemetryLockRetryMs
        });
        return buildAcceptedCurrentPassReviewContextCommandResult({
            reviewType,
            reviewContextPath: currentPassReviewEvidence.reviewContextPath,
            ruleContextArtifactPath: currentPassReviewEvidence.ruleContextArtifactPath,
            tokenEconomyActive: currentPassReviewEvidence.tokenEconomyActive === true,
            reusedExistingReview: currentPassReviewEvidence.reusedExistingReview,
            receiptPath: currentPassReviewEvidence.receiptPath,
            reviewerExecutionMode: currentPassReviewEvidence.reviewerExecutionMode,
            reviewerIdentity: currentPassReviewEvidence.reviewerIdentity,
            reason: currentPassReviewEvidence.reason
        });
    }
    const result = buildReviewContext({
        reviewType,
        depth,
        preflightPath,
        preflightPayload,
        taskModePath: taskModePath || null,
        taskModeEvidence,
        runtimeReviewerIdentity,
        tokenEconomyConfigPath,
        tokenEconomyConfigData: options.tokenEconomyConfigData || null,
        scopedDiffMetadataPath,
        outputPath,
        repoRoot,
        focusedRequiredTestPath,
        ruleContextSectionsCache: options.ruleContextSectionsCache || null,
        ruleFileContentCache: options.ruleFileContentCache || null,
        reviewExecutionContract: effectiveReviewExecutionContract,
        reviewExecutionValidationAuthority: effectiveReviewExecutionValidationAuthority
    });
    let reviewReuseResult: ReviewReuseResult = {
        reused: false,
        receiptPath: null,
        reviewerExecutionMode: null,
        reviewerIdentity: null,
        reason: 'reuse check not run'
    };

    if (taskId) {
        await emitGeneratedReviewContextPreparationTelemetry({
            repoRoot,
            taskId,
            reviewType,
            depth,
            preflightPath,
            outputPath: result.output_path,
            ruleContextArtifactPath: result.rule_context.artifact_path,
            selectedSkill: result.rule_context.selected_skill,
            telemetryLockTimeoutMs: options.telemetryLockTimeoutMs,
            telemetryLockRetryMs: options.telemetryLockRetryMs
        });

        try {
            reviewReuseResult = effectiveReviewReuseBlockedReason
                ? {
                    reused: false,
                    receiptPath: null,
                    reviewerExecutionMode: null,
                    reviewerIdentity: null,
                    reason: effectiveReviewReuseBlockedReason
                }
                : await tryReuseReviewEvidence({
                    repoRoot,
                    taskId,
                    reviewType,
                    preflightPath,
                    preflightPayload,
                    reviewContextPath: outputPath,
                    previousReviewContextReuseSha256,
                    timelineEventsSummary: timelineSummary,
                    remediationPreservedScopeMismatchReason:
                        effectiveRemediationPreservedScopeMismatchReason || null
                });
        } catch (error: unknown) {
            reviewReuseResult = {
                reused: false,
                receiptPath: null,
                reviewerExecutionMode: null,
                reviewerIdentity: null,
                reason: `review reuse check failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    if (effectivePersistedRemediationReuseRequired && !reviewReuseResult.reused) {
        throw new Error(
            `Persisted authoritative remediation decision requires accepted current-cycle reused evidence `
            + `for '${reviewType}', but that evidence is missing, stale, or forged. `
            + `Reuse validation: ${reviewReuseResult.reason}`
        );
    }

    return buildGeneratedReviewContextCommandResult({
        reviewType,
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        tokenEconomyActive: result.token_economy_active,
        reviewReuseResult,
        currentPassReviewEvidenceAccepted,
        currentPassReviewEvidenceReason:
            effectiveReviewReuseBlockedReason
            || currentPassReviewEvidence?.reason
            || 'current PASS reuse check not run'
    });
}
