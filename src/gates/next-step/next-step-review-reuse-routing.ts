import { buildBundleRelativePath } from '../../core/constants';
import { quoteCommandValue } from '../../core/command-quoting';
import type {
    ReviewerResultRecoveryIdentityResolution
} from '../review/security/reviewer-result-recovery-identity';
import type {
    DelegatedReviewLaunchArtifactState
} from './next-step-review-readiness-routing';
import type {
    ReviewOutputCorrectionHandoffEvidence
} from './next-step-review-artifact-readers';

export interface ReviewReuseRoutingCommand {
    label: string;
    command: string;
}

export interface ReviewReuseRoutingRoute {
    status: 'BLOCKED';
    nextGate: string;
    title: string;
    reason: string;
    commands: ReviewReuseRoutingCommand[];
}

export interface ReviewReuseScopedDiffReadiness {
    ready: boolean;
    reason: string;
}

export interface FocusedIntermediateReviewEvidence {
    available: boolean;
    reason: string | null;
}

export type ReviewReuseCandidateHint = 'current-context-candidate' | 'validation-required';

export function isReviewSatisfiedBySemanticCycleResume(options: {
    reviewType: string;
    ordinarySatisfied: boolean;
    semanticResumeReusable: boolean;
    acceptedReviewTypes: readonly string[];
}): boolean {
    return options.ordinarySatisfied || (
        options.semanticResumeReusable
        && options.acceptedReviewTypes.includes(options.reviewType)
    );
}

export function isFullSuiteSatisfiedBySemanticCycleResume(options: {
    semanticResumeReusable: boolean;
    acceptedFullSuite: boolean;
    currentConfigMatches: boolean;
}): boolean {
    return options.semanticResumeReusable
        && options.acceptedFullSuite
        && options.currentConfigMatches;
}

export interface StrictSequentialUpstreamReuseRouteOptions {
    reviewPolicyMode: string;
    downstreamReviewType: string;
    upstreamReviewType: string;
    reuseCandidateHint: ReviewReuseCandidateHint;
    upstreamScopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    upstreamReviewerReadinessChain: string;
    upstreamReviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
    };
}

export function resolveStrictSequentialUpstreamReuseRoute(
    options: StrictSequentialUpstreamReuseRouteOptions
): ReviewReuseRoutingRoute {
    const validationRequired = options.reuseCandidateHint === 'validation-required';
    if (!options.upstreamScopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.upstreamReviewType}' scoped diff metadata before downstream '${options.downstreamReviewType}'.`,
            reason:
                `${options.upstreamScopedDiffReadiness.reason} Configured review policy '${options.reviewPolicyMode}' ` +
                `requires lane-domain-current '${options.upstreamReviewType}' PASS evidence to be rebound before ` +
                `continuing to downstream '${options.downstreamReviewType}' after a domain-limited remediation. ` +
                `${validationRequired
                    ? 'Reuse eligibility validation is still required before treating that PASS evidence as reusable. '
                    : ''
                }` +
                `${options.upstreamReviewerReadinessChain} ${options.upstreamReviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    const reuseReason = validationRequired
        ? `The existing '${options.upstreamReviewType}' PASS evidence is lane-domain current after a domain-limited remediation, ` +
            'but its exact review-context/reuse hash eligibility has not been validated for the current preflight, ' +
            `so rebuild '${options.upstreamReviewType}' review context and let build-review-context validate reuse eligibility ` +
            'before treating that PASS evidence as reusable or deciding a fresh reviewer is required.'
        : `The existing '${options.upstreamReviewType}' PASS evidence is lane-domain current after a domain-limited remediation, ` +
            `so rebuild '${options.upstreamReviewType}' review context to materialize reuse instead of launching a fresh ` +
            `'${options.upstreamReviewType}' reviewer.`;

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Materialize '${options.upstreamReviewType}' review reuse before downstream '${options.downstreamReviewType}'.`,
        reason:
            `Configured review policy '${options.reviewPolicyMode}' requires current-cycle '${options.upstreamReviewType}' ` +
            `binding before downstream '${options.downstreamReviewType}' review-context preparation. ${reuseReason} ` +
            `${options.upstreamReviewerReadinessChain} ${options.upstreamReviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export interface FailedReviewRemediationRouteOptions {
    taskId: string;
    reviewType: string;
    verdictToken: string;
    failureKind: string | null;
    failureReason: string | null;
    currentReviewRecordedEvidenceCurrent: boolean;
    focusedIntermediateEvidence: FocusedIntermediateReviewEvidence;
    currentReviewContextPrepared: boolean;
    scopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    downstreamReviewTypes: readonly string[];
    reviewerResultRecoveryIdentity: ReviewerResultRecoveryIdentityResolution | null;
    launchArtifactState: DelegatedReviewLaunchArtifactState;
    correctionHandoff?: ReviewOutputCorrectionHandoffEvidence | null;
    commands: {
        restartReviewCycle: ReviewReuseRoutingCommand;
        rerunNavigator: ReviewReuseRoutingCommand;
        compileGate: ReviewReuseRoutingCommand;
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
        recordCorrectionTransport?: ReviewReuseRoutingCommand;
        recordCorrectionInvocation?: ReviewReuseRoutingCommand;
        recordResult: ReviewReuseRoutingCommand;
    };
}

function buildAttestedCorrectionRecordResultCommand(options: FailedReviewRemediationRouteOptions): ReviewReuseRoutingCommand {
    const handoff = options.correctionHandoff;
    const providerAction = handoff?.providerAction || null;
    const providerResponseOutputPath = handoff?.providerResponseOutputPath || null;
    const targetIdentity = handoff?.targetReviewerIdentity || null;
    const launchInputSha256 = handoff?.launchInputSha256 || null;
    const providerInvocationEventSha256 = providerAction === 'launch_correction_only_reviewer'
        ? handoff?.correctionProducerInvocationEventSha256 || null
        : handoff?.reviewerInvocationEventSha256 || null;
    const attestedProducerIdentity = handoff?.correctionProducerIdentity || null;
    const attestedProviderInvocationId = providerAction === 'continue_api_conversation'
        ? handoff?.originalProviderInvocationId || null
        : handoff?.correctionProviderInvocationId || null;
    const attestedSource = handoff?.correctionAttestationSource || null;
    const correctionProducerIdentity = targetIdentity && targetIdentity !== 'new_correction_only_reviewer'
        ? targetIdentity
        : attestedProducerIdentity || '<agent:resolved-provider-correction-reviewer-id>';
    const forkContext = providerAction === 'launch_correction_only_reviewer'
        ? ' --correction-fork-context false'
        : '';
    const recordResultCommand = providerAction === 'launch_correction_only_reviewer' && providerResponseOutputPath
        ? bindRecordResultOutputPath(options.commands.recordResult.command, providerResponseOutputPath)
        : options.commands.recordResult.command;
    return {
        ...options.commands.recordResult,
        label: 'After the bound reviewer correction returns, record its attested corrected review result',
        command:
            `${recordResultCommand} ` +
            `--correction-producer-identity ${quoteCommandValue(correctionProducerIdentity)} ` +
            `--correction-provider-invocation-id ${quoteCommandValue(
                attestedProviderInvocationId || '<provider-owned correction invocation id>'
            )} ` +
            `--correction-provider-invocation-event-sha256 ${quoteCommandValue(
                providerInvocationEventSha256 || '<provider-owned correction invocation event sha256>'
            )} ` +
            `--correction-attestation-source ${quoteCommandValue(
                attestedSource || '<provider-owned correction attestation source>'
            )} ` +
            `--correction-launch-input-sha256 ${quoteCommandValue(
                launchInputSha256 || '<persisted correction input sha256>'
            )}` +
            forkContext
    };
}

function bindRecordResultOutputPath(command: string, reviewOutputPath: string): string {
    const pipedInputPrefix = "'<paste exact delegated reviewer output here>' | ";
    const unpipedCommand = command.startsWith(pipedInputPrefix)
        ? command.slice(pipedInputPrefix.length)
        : command;
    const outputPathArgument = `--review-output-path ${quoteCommandValue(reviewOutputPath)}`;
    if (unpipedCommand.includes('--review-output-stdin')) {
        return unpipedCommand.replace('--review-output-stdin', outputPathArgument);
    }
    if (unpipedCommand.includes('--review-output-path')) {
        return unpipedCommand;
    }
    return `${unpipedCommand} ${outputPathArgument}`;
}

export function resolveFailedReviewRemediationRoute(
    options: FailedReviewRemediationRouteOptions
): ReviewReuseRoutingRoute | null {
    if (options.failureKind === 'review-correction-full-review-required') {
        return {
            status: 'BLOCKED',
            nextGate: 'restart-review-cycle',
            title: `Launch a fresh full '${options.reviewType}' reviewer after correction fallback.`,
            reason:
                `The bound '${options.reviewType}' review-output correction cannot safely continue ` +
                `(${options.failureReason || 'correction provenance or semantic binding is unavailable'}). ` +
                'The rejected raw output and typed diagnostics remain audit evidence. Restart only this review cycle, ' +
                'then build a fresh context and launch a full reviewer; do not edit evidence or treat this as an implementation defect.',
            commands: [options.commands.restartReviewCycle]
        };
    }
    if (options.failureKind === 'review-correction-transport-selection-required') {
        if (!options.correctionHandoff?.originalProviderInvocationId) {
            return {
                status: 'BLOCKED',
                nextGate: 'restart-review-cycle',
                title: `Launch a fresh full '${options.reviewType}' reviewer after correction transport fallback.`,
                reason:
                    `The '${options.reviewType}' correction package has no authenticated original provider invocation ` +
                    'binding, so provider session availability cannot be attested safely. Preserve the rejected output ' +
                    'and restart only this review cycle instead of executing a transport command with placeholder provenance.',
                commands: [options.commands.restartReviewCycle]
            };
        }
        if (!options.commands.recordCorrectionTransport) {
            return {
                status: 'BLOCKED',
                nextGate: 'restart-review-cycle',
                title: `Recover '${options.reviewType}' correction transport routing.`,
                reason:
                    `The '${options.reviewType}' correction package requires provider-controller session evidence, but ` +
                    'the navigator did not materialize its transport-selection command. Restart only this review cycle ' +
                    'instead of accepting an unattested correction.',
                commands: [options.commands.restartReviewCycle]
            };
        }
        if (!options.reviewerResultRecoveryIdentity?.ready) {
            const identityReason = options.reviewerResultRecoveryIdentity?.reason || 'resolved_identity_missing';
            return {
                status: 'BLOCKED',
                nextGate: 'restart-review-cycle',
                title: `Recover '${options.reviewType}' reviewer identity before transport selection.`,
                reason:
                    `The '${options.reviewType}' correction package requires a provider-controller session probe, but the ` +
                    `current reviewer attempt is not authenticated (${identityReason}). Preserve the rejected output and ` +
                    'restart only this review cycle so a fresh delegated launch re-establishes identity and provenance.',
                commands: [options.commands.restartReviewCycle]
            };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'record-review-output-correction-transport',
            title: `Record authenticated '${options.reviewType}' correction transport.`,
            reason:
                `The '${options.reviewType}' correction package cannot use an authenticated live continuation response. ` +
                'Record `closed`/`stateless` with canonical fail-closed evidence so Garda can choose the API or ' +
                'correction-only fallback. A caller-provided source string can never authorize live continuation; live ' +
                'selection is frozen only when record-review-result accepts a corrected response bound to the original invocation.',
            commands: [options.commands.recordCorrectionTransport]
        };
    }
    if (options.failureKind === 'review-validation-rejected') {
        if (!options.reviewerResultRecoveryIdentity?.ready) {
            const identityReason = options.reviewerResultRecoveryIdentity?.reason || 'resolved_identity_missing';
            return {
                status: 'BLOCKED',
                nextGate: 'restart-review-cycle',
                title: `Recover '${options.reviewType}' reviewer identity before recording corrected findings.`,
                reason:
                    `System validation rejected the '${options.reviewType}' review findings report, but the current delegated ` +
                    `review attempt does not provide one unambiguous resolved reviewer identity (${identityReason}). ` +
                    'Preserve the rejected output as audit evidence and restart the review cycle so a fresh delegated reviewer launch ' +
                    're-establishes current identity and provenance before record-review-result is offered again.',
                commands: [options.commands.restartReviewCycle]
            };
        }
        const providerAction = options.correctionHandoff?.providerAction || null;
        const correctionProducerInvocationEventSha256 =
            options.correctionHandoff?.correctionProducerInvocationEventSha256 || null;
        const correctionLaunchState = options.correctionHandoff?.launchState || null;
        if (
            providerAction === 'launch_correction_only_reviewer'
            && !/^[0-9a-f]{64}$/u.test(correctionProducerInvocationEventSha256 || '')
        ) {
            return {
                status: 'BLOCKED',
                nextGate: 'record-review-output-correction-invocation',
                title: correctionLaunchState === 'delegation_started'
                    ? `Complete the correction-only '${options.reviewType}' reviewer invocation after it returns.`
                    : `Launch and record one correction-only '${options.reviewType}' reviewer delegation.`,
                reason: correctionLaunchState === 'delegation_started'
                    ? `System validation rejected the '${options.reviewType}' review findings report ` +
                        `(${options.failureReason || 'review findings validation rejected'}). ` +
                        'The provider-backed delegation start is already frozen. Wait for that exact correction reviewer to return, ' +
                        'then run the command below; it can only complete the persisted identity and invocation attempt.'
                    : `System validation rejected the '${options.reviewType}' review findings report ` +
                        `(${options.failureReason || 'review findings validation rejected'}). ` +
                        'Launch exactly one clean-context correction-only reviewer with the persisted correction package, then run the ' +
                        'command below immediately to freeze only the provider-backed delegation start. Rerun next-step and wait for ' +
                        'that reviewer before completing invocation attestation.',
                commands: [options.commands.recordCorrectionInvocation || options.commands.recordResult]
            };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'record-review-result',
            title: `Execute the bound '${options.reviewType}' correction handoff, then record its result.`,
            reason:
                `System validation rejected the '${options.reviewType}' review findings report ` +
                `(${options.failureReason || 'review findings validation rejected'}). ` +
                'This is review/report correction work, not an implementation defect. Execute exactly the persisted ' +
                'ReviewerCorrectionHandoff through provider tools before running the command below. The handoff selects continuation ' +
                'of the original reviewer, API conversation continuation, or one clean-context correction-only reviewer and binds its input. ' +
                'Then pipe the returned corrected JSON to record-review-result before remediation or downstream reviews; ' +
                'do not author findings in the main-agent session.',
            commands: [buildAttestedCorrectionRecordResultCommand(options)]
        };
    }

    if (options.failureKind === 'launch-package' && options.currentReviewRecordedEvidenceCurrent) {
        return {
            status: 'BLOCKED',
            nextGate: 'reviewer-launch-retry',
            title: `Retry '${options.reviewType}' reviewer launch package.`,
            reason:
                `Recorded '${options.reviewType}' review verdict is '${options.verdictToken}', ` +
                `but the failure matches reviewer launch package or binding evidence (${options.failureReason || 'launch package mismatch'}). ` +
                'Preserve the failed review artifact and receipt as audit evidence; do not edit them by hand and do not make fake implementation changes. ' +
                `Restart the review cycle to rebuild '${options.reviewType}' launch metadata and launch a fresh reviewer before downstream reviews.`,
            commands: [options.commands.restartReviewCycle]
        };
    }

    if (
        options.failureKind === 'missing-focused-validation-evidence'
        && options.currentReviewRecordedEvidenceCurrent
        && options.focusedIntermediateEvidence.available
    ) {
        return {
            status: 'BLOCKED',
            nextGate: 'restart-review-cycle',
            title: `Restart '${options.reviewType}' review after focused validation evidence.`,
            reason:
                `Recorded '${options.reviewType}' review verdict is '${options.verdictToken}', ` +
                `but the only failure is missing focused validation evidence (${options.failureReason || 'missing focused validation evidence'}). ` +
                `${options.focusedIntermediateEvidence.reason || 'Current task-owned focused validation evidence is available.'} ` +
                'Preserve the failed review artifact and receipt as audit evidence; do not edit them by hand and do not make fake implementation changes. ' +
                `Restart the review cycle to rebuild '${options.reviewType}' context and launch a fresh reviewer for the same scope before downstream reviews.`,
            commands: [options.commands.restartReviewCycle]
        };
    }

    if (options.failureKind === 'missing-validation-evidence' && options.currentReviewRecordedEvidenceCurrent) {
        const selectorPath = buildBundleRelativePath(`runtime/manual-validation/${options.taskId}/review-evidence.json`);
        return {
            status: 'BLOCKED',
            nextGate: 'review-evidence-refresh',
            title: `Refresh '${options.reviewType}' review evidence attachments.`,
            reason:
                `Recorded '${options.reviewType}' review verdict is '${options.verdictToken}', ` +
                `but the failure matches missing attached validation evidence (${options.failureReason || 'missing validation evidence'}). ` +
                'Preserve the failed review artifact and receipt as audit evidence; do not edit them by hand and do not make fake implementation changes. ' +
                `Create or update the manual-validation evidence selector '${selectorPath}' with root task_id=${JSON.stringify(options.taskId)} matching the current task and its directory, alongside selected_logs entries for the already-run validation logs; each entry must include path, command, and exit_code or status, and may set review_types to ['${options.reviewType}']. ` +
                'Manual logs are untrusted supplemental evidence; they never replace mandatory gates or review receipts. ' +
                'Do not add task-scoped runtime/manual-validation files to preflight --changed-file scope; restart-review-cycle treats them as ignored attachment evidence and refreshes only the affected review lane plus policy-required dependencies. ' +
                'After the selector is current, run restart-review-cycle with task-specific impact analysis, then rebuild the failed review context and launch a fresh reviewer before downstream reviews.',
            commands: [options.commands.restartReviewCycle]
        };
    }

    if (options.failureKind === 'stale-validation-evidence' && options.currentReviewRecordedEvidenceCurrent) {
        return {
            status: 'BLOCKED',
            nextGate: 'compile-gate',
            title: `Refresh validation evidence for '${options.reviewType}' review.`,
            reason:
                `Recorded '${options.reviewType}' review verdict is '${options.verdictToken}', ` +
                `but the failure matches stale compile/full-suite validation evidence (${options.failureReason || 'stale validation evidence'}). ` +
                'Preserve the failed review artifact and receipt as audit evidence; do not edit them by hand and do not make fake implementation changes. ' +
                'Rerun compile-gate for the current preflight; next-step will then require any configured full-suite validation before rebuilding and relaunching the failed review lane.',
            commands: [options.commands.compileGate]
        };
    }

    if (options.currentReviewRecordedEvidenceCurrent) {
        const downstreamText = options.downstreamReviewTypes.length > 0
            ? ` Dependent reviews currently blocked by this failure: ${options.downstreamReviewTypes.join(', ')}.`
            : '';
        return {
            status: 'BLOCKED',
            nextGate: 'implementation',
            title: `Fix failed '${options.reviewType}' review findings before continuing.`,
            reason:
                `Recorded '${options.reviewType}' review verdict is '${options.verdictToken}'. ` +
                `Do not launch downstream reviewers or rerun '${options.reviewType}' before implementation changes are made. ` +
                `Fix the findings, rerun compile-gate, then rebuild and rerun '${options.reviewType}' review.${downstreamText}`,
            commands: [options.commands.rerunNavigator]
        };
    }

    if (options.currentReviewContextPrepared) {
        return null;
    }

    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.reviewType}' scoped diff metadata.`,
            reason:
                `${options.scopedDiffReadiness.reason} A previous '${options.reviewType}' review recorded ` +
                `'${options.verdictToken}', but scoped diff metadata must be refreshed ` +
                `before rebuilding '${options.reviewType}' review context. ${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Refresh '${options.reviewType}' review context after implementation changes.`,
        reason:
            `A previous '${options.reviewType}' review recorded '${options.verdictToken}', ` +
            'but that failed-review routing is no longer current after the latest compile cycle. ' +
            `Rebuild '${options.reviewType}' review context and launch a fresh reviewer before any dependent reviews. ` +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export interface DownstreamDependencyRebindRouteOptions {
    reviewPolicyMode: string;
    downstreamReviewType: string;
    upstreamReviewType: string;
    scopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
    };
}

export function resolveDownstreamDependencyRebindRoute(
    options: DownstreamDependencyRebindRouteOptions
): ReviewReuseRoutingRoute {
    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.downstreamReviewType}' scoped diff metadata.`,
            reason:
                `${options.scopedDiffReadiness.reason} Rebinding '${options.downstreamReviewType}' after upstream ` +
                `'${options.upstreamReviewType}' review evidence requires current scoped diff metadata before rebuilding the review context. ` +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Refresh '${options.downstreamReviewType}' review context after upstream review reuse.`,
        reason:
            `Configured review policy '${options.reviewPolicyMode}' requires '${options.downstreamReviewType}' to start after upstream ` +
            `'${options.upstreamReviewType}' evidence. Current '${options.downstreamReviewType}' evidence is otherwise present, ` +
            `but its latest review phase predates the upstream review record, so rebind '${options.downstreamReviewType}' through build-review-context/reuse before required-reviews-check and completion. ` +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export interface ReviewGateStaleUpstreamRecoveryRouteOptions {
    upstreamReviewType: string;
    reuseCandidateHint: ReviewReuseCandidateHint;
    scopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
    };
}

export interface ReviewGateStaleContextPrecheckRecoveryRouteOptions {
    reviewType: string;
    scopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
    };
}

export function resolveReviewGateStaleContextPrecheckRecoveryRoute(
    options: ReviewGateStaleContextPrecheckRecoveryRouteOptions
): ReviewReuseRoutingRoute {
    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.reviewType}' scoped diff metadata before required reviews check.`,
            reason:
                `${options.scopedDiffReadiness.reason} Required review '${options.reviewType}' has PASS evidence, ` +
                'but its review-context binding is stale for the current preflight. Rebuild scoped metadata before ' +
                're-binding that lane so required-reviews-check is not suggested when it is known to fail. ' +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Rebind stale '${options.reviewType}' review context before required reviews check.`,
        reason:
            `Required review '${options.reviewType}' has PASS evidence, but its review-context binding is stale ` +
            'for the current preflight. Rebuild the review context before required-reviews-check so the gate is not ' +
            'suggested when it is known to fail on stale bindings. ' +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export function resolveReviewGateStaleUpstreamRecoveryRoute(
    options: ReviewGateStaleUpstreamRecoveryRouteOptions
): ReviewReuseRoutingRoute {
    const validationRequired = options.reuseCandidateHint === 'validation-required';
    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.upstreamReviewType}' scoped diff metadata after review gate failure.`,
            reason:
                `${options.scopedDiffReadiness.reason} The latest required-reviews-check failure indicates stale upstream ` +
                `'${options.upstreamReviewType}' context/routing evidence; rebuild scoped metadata before re-binding that upstream lane. ` +
                `${validationRequired
                    ? 'Reuse eligibility validation is still required before treating that PASS evidence as reusable. '
                    : ''
                }` +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    const reuseReason = validationRequired
        ? `Rebind '${options.upstreamReviewType}' through build-review-context so reuse eligibility validation can run ` +
            'before treating that PASS evidence as reusable or deciding a fresh reviewer is required, preserving fail-closed review validation.'
        : `Rebind '${options.upstreamReviewType}' through build-review-context/reuse before rerunning required-reviews-check, ` +
            'preserving fail-closed review validation.';

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Recover stale upstream '${options.upstreamReviewType}' review evidence after review gate failure.`,
        reason:
            `The latest required-reviews-check failed after compile, and upstream '${options.upstreamReviewType}' is lane-domain current ` +
            `but its review-context/routing binding is stale for the current preflight. ${reuseReason} ` +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}
