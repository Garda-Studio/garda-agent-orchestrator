import { TASK_QUEUE_FILENAME } from '../../../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTaskMdTableRow } from '../../../../core/task-md-table';
import {
    EXIT_GATE_FAILURE
} from '../../../exit-codes';
import { buildOutputTelemetry, formatVisibleSavingsLine } from '../../../../gate-runtime/token-telemetry';
import { applyOutputFilterProfile } from '../../../../gate-runtime/output-filters';
import {
    readReviewArtifactJsonSnapshot,
    readReviewArtifactTextSnapshot,
    withReviewArtifactReadBarrier
} from '../../../../gate-runtime/review-artifacts';
import { type ReviewReceipt } from '../../../../gate-runtime/review-context';
import {
    emitMandatoryReviewPhaseStartedEvent,
    emitStatusChangedEvent
} from '../../../../gate-runtime/lifecycle-events';
import { appendMandatoryTaskEvent } from '../../../../gate-runtime/task-events';
import { assessDocImpact } from '../../../../gates/doc-impact/doc-impact';
import { isFullSuiteNotRequiredForZeroDiffNoReviewableScope } from '../../../../gates/full-suite/full-suite-validation';
import {
    buildReviewAuthorshipAttestation,
    checkRequiredReviews,
    parseSkipReviews,
    resolveExpectedReviewVerdicts,
    validateZeroDiffForReviewGate
} from '../../../../gates/required-reviews/required-reviews-check';
import { resolveRuntimeReviewerIdentity } from '../../../../gates/review/reviewer-routing';
import {
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from '../../../../gates/workspace/dirty-worktree-protection';
import {
    getRulePackEvidenceViolations
} from '../../../../gates/rule-pack/rule-pack';
import {
    getTaskModeEvidenceViolations
} from '../../../../gates/task-mode/task-mode';
import { getReviewLifecycleGuard } from '../../../../gates/review/review-lifecycle-guard';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolveDefaultReviewsPath,
    resolvePathForWrite,
    writeJsonArtifact,
    writeReviewEvidence
} from '../../../gate-cli/gates-artifacts';
import {
    expandValueList,
    parseBooleanOption
} from '../../../gate-cli/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    getErrorMessage,
    resolveOrchestratorRoot,
    isPlainObject,
    appendMetricsIfEnabled
} from '../compile/gate-flow-helpers';
import {
    evaluateGateFlowOptionalSkillSelection
} from '../support/gate-flow-runtime';
import { resolveBudgetTokensFromForecast, resolveOutputFiltersPath } from '../compile/output-budget-filter';
import { readTaskQueueStatus, syncTaskQueueStatus } from '../task/task-queue-sync';
import {
    getCompileGateEvidence,
    formatReviewArtifactRootEscapeViolation,
    formatReviewArtifactPathEscapeViolation,
    hasRequiredSpecializedReviews,
    isReviewArtifactPathInsideRoots,
    testCompileScopeDrift,
    testReviewArtifacts,
    type CompileScopeDriftResult,
    type ReviewArtifactsAuditResult
} from './review-flow-support';
import {
    ReviewFlowPreflightPathEscapeError,
    runReviewFlowPreflightPipeline
} from './review-flow-preflight-pipeline';

type OutputTelemetry = ReturnType<typeof buildOutputTelemetry>;

export interface DocImpactGateCommandOptions {
    repoRoot?: string;
    preflightPath?: string;
    docsUpdated?: unknown;
    taskId?: unknown;
    decision?: string;
    behaviorChanged?: unknown;
    changelogUpdated?: unknown;
    internalChangelogUpdated?: unknown;
    projectMemoryUpdated?: unknown;
    projectMemoryUpdateNotNeeded?: unknown;
    sensitiveScopeReviewed?: unknown;
    sensitiveReviewed?: unknown;
    rationale?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface RequiredReviewsCheckCommandOptions {
    repoRoot?: string;
    preflightPath?: string;
    taskId?: unknown;
    taskModePath?: string;
    rulePackPath?: string;
    metricsPath?: string;
    outputFiltersPath?: string;
    skipReviews?: unknown;
    codeReviewVerdict?: string;
    dbReviewVerdict?: string;
    securityReviewVerdict?: string;
    refactorReviewVerdict?: string;
    apiReviewVerdict?: string;
    testReviewVerdict?: string;
    performanceReviewVerdict?: string;
    infraReviewVerdict?: string;
    dependencyReviewVerdict?: string;
    compileEvidencePath?: string;
    skipReason?: unknown;
    reviewsRoot?: string;
    reviewEvidencePath?: string;
    overrideArtifactPath?: string;
    noOpArtifactPath?: string;
    reviewAuthorshipAttestationJson?: unknown;
    emitMetrics?: unknown;
}

interface ReviewEvidenceContext extends Record<string, unknown> {
    preflight_path: string;
    preflight_hash_sha256: string | null;
    mode: string;
    task_mode: unknown;
    compile_evidence_path: string | null;
    compile_evidence_hash_sha256: string | null;
    output_filters_path: string | null;
    scope_drift: CompileScopeDriftResult | null;
    required_reviews: Record<string, boolean>;
    verdicts: Record<string, string>;
    review_checks: Record<string, unknown>;
    skip_reviews: string[];
    skip_reason: string;
    override_artifact: string | null;
    artifact_evidence: ReviewArtifactsAuditResult;
    review_authorship_attestation?: ReturnType<typeof buildReviewAuthorshipAttestation>;
    zero_diff_guard?: unknown;
    selected_budget_tier?: string | null;
    output_telemetry?: OutputTelemetry;
}

function readCurrentTaskSummary(repoRoot: string, taskId: string, fallbackTaskSummary: string | null): string | null {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (fs.existsSync(taskPath) && fs.statSync(taskPath).isFile()) {
        for (const line of fs.readFileSync(taskPath, 'utf8').split('\n')) {
            const cells = parseTaskMdTableRow(line);
            if (cells.length >= 5 && cells[0]?.trimmed === taskId) {
                return cells[4]?.trimmed || fallbackTaskSummary;
            }
        }
    }
    return null;
}

function failPreflightPathEscapedRepo(preflightPath: string): { outputLines: string[]; exitCode: number } {
    return {
        outputLines: [
            'REVIEW_GATE_FAILED',
            'Violations:',
            `- PreflightPath must resolve inside repo root without symlink or junction escape: ${gateHelpers.normalizePath(preflightPath)}`
        ],
        exitCode: EXIT_GATE_FAILURE
    };
}

export function runDocImpactGateCommand(options: DocImpactGateCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const resolvedPreflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(String(options.preflightPath || '').trim(), repoRoot),
        'PreflightPath'
    );
    const docsUpdated = expandValueList(options.docsUpdated, { splitDelimiters: false });
    const docImpactOptions = {
        preflightPath: resolvedPreflightPath,
        taskId: String(options.taskId || ''),
        decision: options.decision || 'NO_DOC_UPDATES',
        behaviorChanged: parseBooleanOption(options.behaviorChanged, false),
        changelogUpdated: parseBooleanOption(options.changelogUpdated, false),
        internalChangelogUpdated: parseBooleanOption(options.internalChangelogUpdated, false),
        projectMemoryUpdated: parseBooleanOption(options.projectMemoryUpdated, false),
        projectMemoryUpdateNotNeeded: parseBooleanOption(options.projectMemoryUpdateNotNeeded, false),
        sensitiveReviewed: parseBooleanOption(options.sensitiveScopeReviewed != null ? options.sensitiveScopeReviewed : options.sensitiveReviewed, false),
        docsUpdated,
        rationale: String(options.rationale || ''),
        repoRoot
    };
    const artifact = assessDocImpact(docImpactOptions);

    const resolvedTaskId = artifact.task_id || null;
    const artifactPath = options.artifactPath
        ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
        : (resolvedTaskId ? resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-doc-impact.json`) : null);
    if (artifactPath) {
        writeJsonArtifact(artifactPath, artifact);
    }

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: new Date().toISOString(),
        event_type: 'doc_impact_gate_check',
        status: artifact.status,
        task_id: resolvedTaskId,
        artifact_path: normalizeOptionalPath(artifactPath),
        artifact
    }, parseBooleanOption(options.emitMetrics, true));

    if (resolvedTaskId) {
        try {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                resolvedTaskId,
                artifact.violations.length > 0 ? 'DOC_IMPACT_ASSESSMENT_FAILED' : 'DOC_IMPACT_ASSESSED',
                artifact.outcome,
                artifact.violations.length > 0 ? 'Doc impact gate failed.' : 'Doc impact gate passed.',
                artifact
            );
        } catch (error: unknown) {
            removeArtifactIfExists(artifactPath);
            throw new Error(
                `doc-impact-gate failed because mandatory lifecycle event '${artifact.violations.length > 0 ? 'DOC_IMPACT_ASSESSMENT_FAILED' : 'DOC_IMPACT_ASSESSED'}' could not be appended. ${getErrorMessage(error)}`
            );
        }
    }

    if (artifact.violations.length > 0) {
        return {
            outputLines: [
                'DOC_IMPACT_GATE_FAILED',
                'Violations:',
                ...artifact.violations.map(function (item: string) { return `- ${item}`; })
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }

    const outputLines = ['DOC_IMPACT_GATE_PASSED'];
    if (artifactPath) {
        outputLines.push(`DocImpactArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);
    }
    return { outputLines, exitCode: 0 };
}

export function runRequiredReviewsCheckCommand(options: RequiredReviewsCheckCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    let preflightPipeline;
    try {
        preflightPipeline = runReviewFlowPreflightPipeline({
            repoRoot,
            orchestratorRoot,
            taskId: String(options.taskId || ''),
            preflightPath: options.preflightPath,
            taskModePath: options.taskModePath,
            rulePackPath: options.rulePackPath
        });
    } catch (error: unknown) {
        if (error instanceof ReviewFlowPreflightPathEscapeError) {
            return failPreflightPathEscapedRepo(error.resolvedPreflightPath);
        }
        throw error;
    }
    const {
        preflight,
        validatedPreflight,
        taskModeEvidence,
        rulePackEvidence,
        timelineReadiness
    } = preflightPipeline;
    const reviewBudgetTokens = resolveBudgetTokensFromForecast(preflight.budget_forecast);

    const resolvedTaskId = validatedPreflight.resolved_task_id;
    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    const outputFiltersPath = resolveOutputFiltersPath(repoRoot, options.outputFiltersPath || '');
    const reviewLifecycleGuard = resolvedTaskId
        ? getReviewLifecycleGuard(repoRoot, resolvedTaskId, 'required-reviews-check', 'review_gate')
        : null;
    if (reviewLifecycleGuard?.status === 'BLOCK') {
        const failureOutputLines = [
            'REVIEW_GATE_FAILED',
            `Mode: ${validatedPreflight.mode}`,
            'Violations:',
            ...reviewLifecycleGuard.violations.map(function (item: string) { return `- ${item}`; })
        ];
        const filteredFailureOutput = applyOutputFilterProfile(failureOutputLines, outputFiltersPath, 'review_gate_failure_console', {
            budgetTokens: reviewBudgetTokens
        });
        const failureTelemetry = buildOutputTelemetry(failureOutputLines, filteredFailureOutput.lines, {
            filterMode: filteredFailureOutput.filter_mode,
            fallbackMode: filteredFailureOutput.fallback_mode,
            parserMode: filteredFailureOutput.parser_mode,
            parserName: filteredFailureOutput.parser_name ?? undefined,
            parserStrategy: filteredFailureOutput.parser_strategy ?? undefined
        });
        const failureVisibleSavingsLine = formatVisibleSavingsLine(failureTelemetry);
        appendMetricsIfEnabled(repoRoot, metricsPath, {
            timestamp_utc: new Date().toISOString(),
            event_type: 'review_gate_rerun_blocked',
            status: 'FAILED',
            task_id: resolvedTaskId,
            preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
            mode: validatedPreflight.mode,
            output_filters_path: normalizeOptionalPath(outputFiltersPath),
            violations: reviewLifecycleGuard.violations,
            ...failureTelemetry
        }, parseBooleanOption(options.emitMetrics, true));
        const outputLines = [...filteredFailureOutput.lines];
        if (failureVisibleSavingsLine) {
            outputLines.push(failureVisibleSavingsLine);
        }
        return { outputLines, exitCode: EXIT_GATE_FAILURE };
    }
    const skipReviewsList = parseSkipReviews(options.skipReviews || '');
    const providedVerdicts: Record<string, string> = {
        code: String(options.codeReviewVerdict || '').trim(),
        db: String(options.dbReviewVerdict || '').trim(),
        security: String(options.securityReviewVerdict || '').trim(),
        refactor: String(options.refactorReviewVerdict || '').trim(),
        api: String(options.apiReviewVerdict || '').trim(),
        test: String(options.testReviewVerdict || '').trim(),
        performance: String(options.performanceReviewVerdict || '').trim(),
        infra: String(options.infraReviewVerdict || '').trim(),
        dependency: String(options.dependencyReviewVerdict || '').trim()
    };

    const zeroDiffGuard = validateZeroDiffForReviewGate(
        preflight,
        String(resolvedTaskId || ''),
        repoRoot,
        options.noOpArtifactPath || '',
        validatedPreflight.preflight_path
    );
    const compileGateRequired = !(
        isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight)
        && zeroDiffGuard.status === 'SATISFIED_BY_AUDITED_NO_OP'
    );

    const compileGateEvidence = getCompileGateEvidence(
        repoRoot,
        resolvedTaskId,
        validatedPreflight.preflight_path,
        validatedPreflight.preflight_hash,
        options.compileEvidencePath || ''
    );
    const scopeDrift = compileGateRequired && compileGateEvidence.status === 'PASS'
        ? testCompileScopeDrift(repoRoot, compileGateEvidence)
        : null;
    const dirtyWorkspaceProtectionDrift = detectProtectedDirtyWorkspaceDrift(
        repoRoot,
        getProtectedDirtyWorkspaceScopeFromPreflight(preflight)
    );
    const errors = [...validatedPreflight.errors];
    for (const skipItem of skipReviewsList) {
        if (skipItem !== 'code') {
            errors.push(`Unsupported skip-review value '${skipItem}'. Allowed values: code.`);
        }
    }

    const skipReason = String(options.skipReason || '').trim();
    if (skipReviewsList.length > 0 && !skipReason) {
        errors.push('Skip-review override requires --skip-reason.');
    }
    if (skipReason && skipReason.length < 12) {
        errors.push('Skip-review reason is too short. Provide a concrete justification (>= 12 chars).');
    }

    errors.push(...getTaskModeEvidenceViolations(taskModeEvidence));
    errors.push(...getRulePackEvidenceViolations(rulePackEvidence));

    if (compileGateRequired) {
        switch (compileGateEvidence.status) {
            case 'TASK_ID_MISSING':
                errors.push('Compile gate evidence cannot be verified: task id is missing.');
                break;
            case 'EVIDENCE_FILE_MISSING':
                errors.push(`Compile gate evidence missing: file not found at '${compileGateEvidence.evidence_path}'. Run compile-gate first.`);
                break;
            case 'EVIDENCE_PATH_OUTSIDE_REPO':
                errors.push(`Compile gate evidence path must resolve inside repo root without symlink or junction escape: ${compileGateEvidence.evidence_path}.`);
                break;
            case 'EVIDENCE_INVALID_JSON':
                errors.push(`Compile gate evidence is invalid JSON at '${compileGateEvidence.evidence_path}'. Re-run compile-gate.`);
                break;
            case 'EVIDENCE_TASK_MISMATCH':
                errors.push(`Compile gate evidence task mismatch. Expected '${resolvedTaskId}', got '${compileGateEvidence.evidence_task_id}'.`);
                break;
            case 'EVIDENCE_SOURCE_INVALID':
                errors.push(`Compile gate evidence source is invalid. Expected 'compile-gate', got '${compileGateEvidence.evidence_source}'.`);
                break;
            case 'EVIDENCE_PREFLIGHT_HASH_MISMATCH':
                errors.push('Compile gate evidence preflight hash mismatch. Re-run compile-gate for the current preflight artifact.');
                break;
            case 'EVIDENCE_PREFLIGHT_PATH_MISMATCH':
                errors.push(`Compile gate evidence preflight path mismatch. Evidence path='${compileGateEvidence.evidence_preflight_path}'.`);
                break;
            case 'EVIDENCE_SCOPE_MISSING':
                errors.push('Compile gate evidence is missing scope snapshot fields. Re-run compile-gate.');
                break;
            case 'EVIDENCE_NOT_PASS':
                errors.push(`Compile gate did not pass. Evidence status='${compileGateEvidence.evidence_status}', outcome='${compileGateEvidence.evidence_outcome}'.`);
                break;
            default:
                break;
        }
    }

    if (scopeDrift) {
        if (scopeDrift.status === 'EVIDENCE_SCOPE_MISSING') {
            errors.push(...scopeDrift.violations);
        } else if (scopeDrift.status === 'DRIFT_DETECTED') {
            errors.push('Workspace changed after compile gate; rerun compile-gate before review gate.');
            errors.push(...scopeDrift.violations);
        }
    }
    if (dirtyWorkspaceProtectionDrift.status === 'DRIFT_DETECTED') {
        errors.push(...dirtyWorkspaceProtectionDrift.violations);
    }

    if (timelineReadiness && resolvedTaskId) {
        const optionalSkillSelectionViolations = evaluateGateFlowOptionalSkillSelection({
            orchestratorRoot,
            taskId: resolvedTaskId,
            expectedPreflightPath: validatedPreflight.preflight_path,
            expectedPreflightSha256: validatedPreflight.preflight_hash,
            taskSummary: String(readCurrentTaskSummary(repoRoot, resolvedTaskId, taskModeEvidence.task_summary) || ''),
            timelineEvidence: timelineReadiness.timelineEvidence
        });
        errors.push(...optionalSkillSelectionViolations);
        errors.push(...timelineReadiness.violations);
    }

    errors.push(...zeroDiffGuard.violations);

    const required = validatedPreflight.required_reviews;
    const skipCode = skipReviewsList.includes('code');
    const verdicts = resolveExpectedReviewVerdicts(required, providedVerdicts, skipReviewsList);
    const canSkipCode = !!required.code
        && !hasRequiredSpecializedReviews(required)
        && validatedPreflight.changed_files_count <= 1
        && validatedPreflight.changed_lines_total <= 8;

    if (skipCode && !canSkipCode) {
        errors.push('Code review override is not allowed for this change scope. Allowed only for tiny low-risk code changes (<=1 file and <=8 changed lines, with no specialized reviews).');
    }
    if (skipCode && !required.code) {
        errors.push('Code review override was requested but code review is not required by preflight.');
    }
    const reviewAuthorshipAttestation = buildReviewAuthorshipAttestation(
        required,
        options.reviewAuthorshipAttestationJson,
        skipReviewsList
    );
    const reviewAuthorshipAttestationForEvidence = reviewAuthorshipAttestation;
    errors.push(...reviewAuthorshipAttestation.violations);

    const reviewArtifactsMap: Record<string, {
        path: string;
        content: string;
        reviewContext?: Record<string, unknown>;
        reviewContextPath?: string | null;
        reviewContextSha256?: string | null;
        artifactSha256?: string | null;
        receipt?: ReviewReceipt | null;
        receiptReadError?: string | null;
    }> = {};
    const artifactReviewsRoot = options.reviewsRoot
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.reviewsRoot || '').trim(), repoRoot, { allowMissing: true }),
            'ReviewsRoot'
        )
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const artifactEvidence: ReviewArtifactsAuditResult = gateHelpers.isPathRealpathInsideRoot(
        artifactReviewsRoot,
        repoRoot,
        { allowMissing: true }
    ) ? withReviewArtifactReadBarrier(artifactReviewsRoot, () => {
        const evidence = testReviewArtifacts(
            repoRoot,
            resolvedTaskId,
            required,
            verdicts,
            skipReviewsList,
            options.reviewsRoot || ''
        );
        const evidenceReviewsRoot = evidence.reviews_root ? path.resolve(evidence.reviews_root) : artifactReviewsRoot;
        if (evidenceReviewsRoot !== artifactReviewsRoot) {
            errors.push(
                `Review artifact evidence root changed during validation: expected ${gateHelpers.normalizePath(artifactReviewsRoot)}, got ${gateHelpers.normalizePath(evidenceReviewsRoot)}.`
            );
            return evidence;
        }

        for (const entry of evidence.checked) {
            if (entry.present && entry.path) {
                try {
                    let reviewContext: Record<string, unknown> | undefined;
                    let reviewContextPath: string | null = null;
                    let reviewContextSha256: string | null = null;
                    const artifactPath = path.resolve(entry.path);
                    if (!isReviewArtifactPathInsideRoots(repoRoot, artifactReviewsRoot, artifactPath)) {
                        errors.push(formatReviewArtifactPathEscapeViolation('Review artifact path', artifactPath));
                        continue;
                    }
                    const artifactSnapshot = readReviewArtifactTextSnapshot(artifactPath);
                    if (!artifactSnapshot.valid || artifactSnapshot.value === null || !artifactSnapshot.sha256) {
                        errors.push(`Review artifact changed or became unavailable during validation: ${gateHelpers.normalizePath(artifactPath)}.`);
                        continue;
                    }
                    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
                    let receipt: ReviewReceipt | null = null;
                    let receiptReadError: string | null = null;
                    if (fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile()) {
                        if (!isReviewArtifactPathInsideRoots(repoRoot, artifactReviewsRoot, receiptPath)) {
                            errors.push(formatReviewArtifactPathEscapeViolation('Review receipt path', receiptPath));
                            continue;
                        } else {
                            try {
                                const receiptSnapshot = readReviewArtifactJsonSnapshot(receiptPath);
                                if (!receiptSnapshot.valid || !isPlainObject(receiptSnapshot.value)) {
                                    throw new Error('invalid receipt snapshot');
                                }
                                receipt = receiptSnapshot.value as unknown as ReviewReceipt;
                            } catch {
                                receiptReadError = `Review receipt for '${entry.review}' is invalid JSON: ${gateHelpers.normalizePath(receiptPath)}.`;
                                receipt = null;
                            }
                        }
                    }
                    if (entry.review_context_present && entry.review_context_path) {
                        reviewContextPath = path.resolve(entry.review_context_path);
                        if (!isReviewArtifactPathInsideRoots(repoRoot, artifactReviewsRoot, reviewContextPath)) {
                            errors.push(formatReviewArtifactPathEscapeViolation('Review context artifact path', reviewContextPath));
                            reviewContextPath = null;
                        } else if (fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile()) {
                            const reviewContextSnapshot = readReviewArtifactJsonSnapshot(reviewContextPath);
                            if (reviewContextSnapshot.valid && isPlainObject(reviewContextSnapshot.value)) {
                                reviewContext = reviewContextSnapshot.value;
                                reviewContextSha256 = reviewContextSnapshot.sha256;
                            }
                        }
                    }
                    reviewArtifactsMap[entry.review] = {
                        path: artifactPath,
                        content: artifactSnapshot.value,
                        reviewContext,
                        reviewContextPath,
                        reviewContextSha256,
                        artifactSha256: artifactSnapshot.sha256,
                        receipt,
                        receiptReadError
                    };
                } catch (e) {
                    // ignore
                }
            }
        }
        return evidence;
    }) : {
        reviews_root: gateHelpers.normalizePath(artifactReviewsRoot),
        checked: [],
        violations: [formatReviewArtifactRootEscapeViolation(artifactReviewsRoot)],
        compaction_warnings: [],
        compaction_warning_count: 0
    };

    const runtimeIdentity = resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId: resolvedTaskId,
        taskModePath: String(options.taskModePath || ''),
        allowLegacyFallback: true
    });
    if (runtimeIdentity.identity_status !== 'resolved') {
        errors.push(
            `Runtime reviewer identity must stay resolved for required-reviews-check, got '${runtimeIdentity.identity_status}'.`
        );
    }
    errors.push(...runtimeIdentity.violations);
    const baseResult = checkRequiredReviews({
        validatedPreflight: { ...validatedPreflight, errors },
        verdicts,
        skipReviews: skipReviewsList,
        compileGateEvidence: !compileGateRequired || compileGateEvidence.status === 'PASS'
            ? { status: 'PASSED' }
            : null,
        reviewArtifacts: reviewArtifactsMap,
        preflightPayload: preflight,
        canonicalSourceOfTruth: runtimeIdentity.canonical_source_of_truth,
        executionProvider: runtimeIdentity.execution_provider,
        executionProviderSource: runtimeIdentity.execution_provider_source,
        taskModePath: String(options.taskModePath || ''),
        allowLegacyReviewContextIdentityFallback: runtimeIdentity.task_mode_identity_backfilled,
        repoRoot
    });
    const allViolations = [...baseResult.violations, ...artifactEvidence.violations];
    const status = allViolations.length > 0 ? 'FAILED' : 'PASSED';
    const reviewEvidencePath = options.reviewEvidencePath
        ? requireResolvedPath(resolvePathForWrite(options.reviewEvidencePath, repoRoot), 'ReviewEvidencePath')
        : (resolvedTaskId ? resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-review-gate.json`) : null);

    let overrideArtifactPath = options.overrideArtifactPath
        ? requireResolvedPath(resolvePathForWrite(options.overrideArtifactPath, repoRoot), 'OverrideArtifactPath')
        : '';

    if (status === 'PASSED' && skipCode && resolvedTaskId) {
        if (!overrideArtifactPath) {
            const preflightDir = path.dirname(validatedPreflight.preflight_path);
            const preflightName = path.basename(validatedPreflight.preflight_path, path.extname(validatedPreflight.preflight_path));
            const baseName = preflightName.replace(/-preflight$/i, '');
            overrideArtifactPath = path.join(preflightDir, `${baseName}-override.json`);
        }
        writeJsonArtifact(overrideArtifactPath, {
            timestamp_utc: new Date().toISOString(),
            preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
            mode: validatedPreflight.mode,
            skipped_reviews: ['code'],
            reason: skipReason,
            guardrails: {
                required_db: !!required.db,
                required_security: !!required.security,
                required_refactor: !!required.refactor,
                required_api: !!required.api,
                required_test: !!required.test,
                required_performance: !!required.performance,
                required_infra: !!required.infra,
                required_dependency: !!required.dependency,
                changed_files_count: validatedPreflight.changed_files_count,
                changed_lines_total: validatedPreflight.changed_lines_total
            }
        });
    }

    const reviewEvidenceContext: ReviewEvidenceContext = {
        preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
        preflight_hash_sha256: validatedPreflight.preflight_hash,
        mode: validatedPreflight.mode,
        task_mode: taskModeEvidence,
        rule_pack: rulePackEvidence,
        compile_evidence_path: compileGateEvidence.evidence_path,
        compile_evidence_hash_sha256: compileGateEvidence.evidence_hash,
        output_filters_path: normalizeOptionalPath(outputFiltersPath),
        scope_drift: scopeDrift,
        dirty_workspace_protection: dirtyWorkspaceProtectionDrift,
        required_reviews: baseResult.required_reviews,
        verdicts,
        review_checks: baseResult.review_checks,
        skip_reviews: skipReviewsList,
        skip_reason: skipReason,
        override_artifact: normalizeOptionalPath(overrideArtifactPath),
        artifact_evidence: artifactEvidence,
        review_authorship_attestation: reviewAuthorshipAttestationForEvidence,
        zero_diff_guard: zeroDiffGuard,
        selected_budget_tier: null
    };

    const trustLevels = new Set<string>();
    if (baseResult.review_checks && typeof baseResult.review_checks === 'object') {
        for (const key of Object.keys(baseResult.review_checks)) {
            const check = (baseResult.review_checks as any)[key];
            if (check && check.trust_level) {
                trustLevels.add(check.trust_level);
            }
        }
    }
    const trustStatusLine = trustLevels.size > 0 ? `TrustStatus: ${Array.from(trustLevels).join(', ')}` : null;

    if (status === 'FAILED') {
        const failureOutputLines = [
            'REVIEW_GATE_FAILED',
            `Mode: ${validatedPreflight.mode}`,
            ...(trustStatusLine ? [trustStatusLine] : []),
            'Violations:',
            ...allViolations.map(function (item: string) { return `- ${item}`; })
        ];
        const filteredFailureOutput = applyOutputFilterProfile(failureOutputLines, outputFiltersPath, 'review_gate_failure_console', {
            budgetTokens: reviewBudgetTokens
        });
        const failureTelemetry = buildOutputTelemetry(failureOutputLines, filteredFailureOutput.lines, {
            filterMode: filteredFailureOutput.filter_mode,
            fallbackMode: filteredFailureOutput.fallback_mode,
            parserMode: filteredFailureOutput.parser_mode,
            parserName: filteredFailureOutput.parser_name ?? undefined,
            parserStrategy: filteredFailureOutput.parser_strategy ?? undefined
        });
        const failureVisibleSavingsLine = formatVisibleSavingsLine(failureTelemetry);
        reviewEvidenceContext.selected_budget_tier = filteredFailureOutput.budget_tier ?? null;
        reviewEvidenceContext.output_telemetry = failureTelemetry;
        writeReviewEvidence(reviewEvidencePath, resolvedTaskId, reviewEvidenceContext, 'FAILED', 'FAIL', allViolations);

        const failureEvent = {
            timestamp_utc: new Date().toISOString(),
            event_type: 'review_gate_check',
            status: 'FAILED',
            task_id: resolvedTaskId,
            review_evidence_path: normalizeOptionalPath(reviewEvidencePath),
            preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
            mode: validatedPreflight.mode,
            skip_reviews: skipReviewsList,
            skip_reason: skipReason,
            output_filters_path: normalizeOptionalPath(outputFiltersPath),
            compile_gate: compileGateEvidence,
            artifact_evidence: artifactEvidence,
            review_authorship_attestation: reviewAuthorshipAttestationForEvidence,
            violations: allViolations,
            ...failureTelemetry
        };
        appendMetricsIfEnabled(repoRoot, metricsPath, failureEvent, parseBooleanOption(options.emitMetrics, true));
        if (resolvedTaskId) {
            try {
                appendMandatoryTaskEvent(orchestratorRoot, resolvedTaskId, 'REVIEW_GATE_FAILED', 'FAIL', 'Required reviews gate failed.', {
                    review_evidence_path: normalizeOptionalPath(reviewEvidencePath),
                    preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
                    mode: validatedPreflight.mode,
                    skip_reviews: skipReviewsList,
                    skip_reason: skipReason,
                    compile_gate: compileGateEvidence,
                    artifact_evidence: artifactEvidence,
                    review_authorship_attestation: reviewAuthorshipAttestationForEvidence,
                    violations: allViolations
                });
            } catch (error: unknown) {
                removeArtifactIfExists(reviewEvidencePath);
                throw new Error(
                    `required-reviews-check failed because mandatory lifecycle event 'REVIEW_GATE_FAILED' could not be appended. ${getErrorMessage(error)}`
                );
            }
        }

        const outputLines = [...filteredFailureOutput.lines];
        if (failureVisibleSavingsLine) {
            outputLines.push(failureVisibleSavingsLine);
        }
        return { outputLines, exitCode: EXIT_GATE_FAILURE };
    }

    const successOutputLines = skipCode
        ? [
            'REVIEW_GATE_PASSED_WITH_OVERRIDE',
            `Mode: ${validatedPreflight.mode}`,
            'SkippedReviews: code',
            ...(overrideArtifactPath ? [`OverrideArtifact: ${gateHelpers.normalizePath(overrideArtifactPath)}`] : []),
            ...(trustStatusLine ? [trustStatusLine] : [])
        ]
        : [
            'REVIEW_GATE_PASSED',
            `Mode: ${validatedPreflight.mode}`,
            ...(trustStatusLine ? [trustStatusLine] : [])
        ];
    if (artifactEvidence.compaction_warning_count > 0) {
        successOutputLines.push(`CompactionWarnings: ${artifactEvidence.compaction_warning_count}`);
    }
    const filteredSuccessOutput = applyOutputFilterProfile(successOutputLines, outputFiltersPath, 'review_gate_success_console', {
        budgetTokens: reviewBudgetTokens
    });
    const successTelemetry = buildOutputTelemetry(successOutputLines, filteredSuccessOutput.lines, {
        filterMode: filteredSuccessOutput.filter_mode,
        fallbackMode: filteredSuccessOutput.fallback_mode,
        parserMode: filteredSuccessOutput.parser_mode,
        parserName: filteredSuccessOutput.parser_name ?? undefined,
        parserStrategy: filteredSuccessOutput.parser_strategy ?? undefined
    });
    const successVisibleSavingsLine = formatVisibleSavingsLine(successTelemetry);
    reviewEvidenceContext.selected_budget_tier = filteredSuccessOutput.budget_tier ?? null;
    reviewEvidenceContext.output_telemetry = successTelemetry;
    writeReviewEvidence(reviewEvidencePath, resolvedTaskId, reviewEvidenceContext, 'PASSED', 'PASS', []);

    const successEvent = {
        timestamp_utc: new Date().toISOString(),
        event_type: 'review_gate_check',
        status: 'PASSED',
        task_id: resolvedTaskId,
        review_evidence_path: normalizeOptionalPath(reviewEvidencePath),
        preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
        mode: validatedPreflight.mode,
        skip_reviews: skipReviewsList,
        skip_reason: skipReason,
        output_filters_path: normalizeOptionalPath(outputFiltersPath),
        compile_gate: compileGateEvidence,
        override_artifact: normalizeOptionalPath(overrideArtifactPath),
        artifact_evidence: artifactEvidence,
        review_authorship_attestation: reviewAuthorshipAttestationForEvidence,
        ...successTelemetry
    };
    appendMetricsIfEnabled(repoRoot, metricsPath, successEvent, parseBooleanOption(options.emitMetrics, true));
    if (resolvedTaskId) {
        const hasRequiredReviews = Object.values(required).some((value) => value === true);
        if (!hasRequiredReviews) {
            emitMandatoryReviewPhaseStartedEvent(orchestratorRoot, resolvedTaskId, {
                review_type: 'none',
                reason: 'no_required_reviews',
                mode: validatedPreflight.mode,
                preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path)
            });
        }
        try {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                resolvedTaskId,
                skipCode ? 'REVIEW_GATE_PASSED_WITH_OVERRIDE' : 'REVIEW_GATE_PASSED',
                'PASS',
                skipCode ? 'Required reviews gate passed with audited override.' : 'Required reviews gate passed.',
                {
                    review_evidence_path: normalizeOptionalPath(reviewEvidencePath),
                    preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
                    mode: validatedPreflight.mode,
                    skip_reviews: skipReviewsList,
                    skip_reason: skipReason,
                    compile_gate: compileGateEvidence,
                    override_artifact: normalizeOptionalPath(overrideArtifactPath),
                    artifact_evidence: artifactEvidence,
                    review_authorship_attestation: reviewAuthorshipAttestationForEvidence
                }
            );
        } catch (error: unknown) {
            removeArtifactIfExists(reviewEvidencePath);
            removeArtifactIfExists(overrideArtifactPath);
            throw new Error(
                `required-reviews-check failed because mandatory lifecycle event '${skipCode ? 'REVIEW_GATE_PASSED_WITH_OVERRIDE' : 'REVIEW_GATE_PASSED'}' could not be appended. ${getErrorMessage(error)}`
            );
        }

        const previousStatus = readTaskQueueStatus(repoRoot, resolvedTaskId);
        if (previousStatus && previousStatus !== 'IN_REVIEW') {
            emitStatusChangedEvent(orchestratorRoot, resolvedTaskId, previousStatus, 'IN_REVIEW');
            syncTaskQueueStatus(repoRoot, resolvedTaskId, 'IN_REVIEW');
        }
    }

    const outputLines = [...filteredSuccessOutput.lines];
    if (successVisibleSavingsLine) {
        outputLines.push(successVisibleSavingsLine);
    }
    return { outputLines, exitCode: 0 };
}
