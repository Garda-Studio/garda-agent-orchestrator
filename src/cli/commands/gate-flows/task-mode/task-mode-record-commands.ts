import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import {
    appendMandatoryTaskEvent,
    appendTaskEvent,
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import {
    buildRulePackArtifact,
    getPostPreflightRulePackRebindDecision,
    getPostPreflightSequenceEvidence,
    getRulePackEvidence,
    getRulePackEvidenceViolations,
    resolveRulePackArtifactPath
} from '../../../../gates/rule-pack/rule-pack';
import {
    buildNoOpArtifact,
    resolveCurrentNoOpPreflightPath,
    resolveNoOpArtifactPath
} from '../../../../gates/task-mode/no-op';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import { getWorkspaceSnapshotCached } from '../../../../gates/workspace/workspace-snapshot-cache';
import {
    buildStrictDecompositionDecisionArtifact,
    resolveStrictDecompositionDecisionArtifactPath
} from '../../../../gates/task-mode/strict-decomposition-decision';
import {
    readStrictDecompositionWorkPackageContractFile,
    validateStrictDecompositionWorkPackageFindingSources
} from '../../../../gates/task-mode/strict-decomposition-work-package-contract';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolvePathForWrite,
    writeJsonArtifact
} from '../../../gate-cli/gates-artifacts';
import {
    expandValueList,
    normalizeRulePackStage,
    parseBooleanOption
} from '../../../gate-cli/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    appendMetricsIfEnabled,
    getErrorMessage,
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';
import {
    buildGateCommandPrefix,
    quotePowerShellCliValue
} from './task-mode-command-format';

export interface LoadRulePackCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    stage?: unknown;
    preflightPath?: string;
    taskModePath?: string;
    loadedRuleFiles?: unknown;
    actor?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface BindRulePackToPreflightCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    preflightPath?: string;
    taskModePath?: string;
    actor?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface RecordNoOpCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    classification?: unknown;
    reason?: unknown;
    actor?: unknown;
    preflightPath?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface RecordStrictDecompositionDecisionCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    decision?: unknown;
    taskProfile?: unknown;
    taskSummary?: unknown;
    reason?: unknown;
    scopeRisk?: unknown;
    expectedReviewTypes?: unknown;
    atomicityConstraints?: unknown;
    proposedChildTaskIds?: unknown;
    workPackageContractPath?: unknown;
    actor?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

function resolveContainedStrictDecompositionWritePath(repoRoot: string, pathValue: string, label: string): string {
    const resolvedPath = requireResolvedPath(gateHelpers.resolvePathInsideRepo(pathValue, repoRoot, {
        allowMissing: true,
        enforceInside: true
    }), label);
    if (!gateHelpers.isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })) {
        throw new Error(`${label} must stay inside repo root after realpath resolution: ${gateHelpers.normalizePath(resolvedPath)}`);
    }
    return resolvedPath;
}

function buildLoadRulePackPostPreflightRemediationCommand(
    repoRoot: string,
    taskId: string,
    preflightPath: string | null,
    requiredRuleFiles: string[],
    taskModePath = ''
): string {
    const absoluteRepoRoot = path.resolve(repoRoot);
    const parts: string[] = [
        `${buildGateCommandPrefix(repoRoot)} gate load-rule-pack`,
        `--repo-root ${quotePowerShellCliValue(absoluteRepoRoot)}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--stage ${quotePowerShellCliValue('POST_PREFLIGHT')}`
    ];
    if (preflightPath) {
        const relativePreflightPath = gateHelpers.normalizePath(
            path.relative(absoluteRepoRoot, path.resolve(preflightPath))
        );
        parts.push(`--preflight-path ${quotePowerShellCliValue(relativePreflightPath)}`);
    }
    const trimmedTaskModePath = String(taskModePath || '').trim();
    if (trimmedTaskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(trimmedTaskModePath)}`);
    }
    for (const ruleFile of requiredRuleFiles) {
        const relativeRuleFile = gateHelpers.normalizePath(
            path.relative(absoluteRepoRoot, path.resolve(ruleFile))
        );
        parts.push(`--loaded-rule-file ${quotePowerShellCliValue(relativeRuleFile)}`);
    }
    return parts.join(' ');
}

export function runLoadRulePackCommand(options: LoadRulePackCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const stage = normalizeRulePackStage(options.stage);
    const artifactPath = resolveRulePackArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage,
        loadedRuleFiles: expandValueList(options.loadedRuleFiles || [], { splitDelimiters: true }),
        preflightPath: String(options.preflightPath || ''),
        taskModePath: String(options.taskModePath || ''),
        actor: String(options.actor || 'orchestrator'),
        artifactPath
    });
    const stageArtifact = stage === 'TASK_ENTRY'
        ? artifact.stages.task_entry
        : artifact.stages.post_preflight;
    if (!stageArtifact) {
        throw new Error(`Rule-pack artifact did not produce stage '${stage}'.`);
    }

    writeJsonArtifact(artifactPath, artifact);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: stageArtifact.timestamp_utc,
        event_type: 'rule_pack_loaded',
        status: stageArtifact.status,
        task_id: taskId,
        stage,
        artifact_path: normalizeOptionalPath(artifactPath),
        preflight_path: stageArtifact.preflight_path,
        required_rule_count: stageArtifact.required_rule_count,
        loaded_rule_count: stageArtifact.loaded_rule_count,
        missing_rule_files: stageArtifact.missing_rule_files,
        actor: stageArtifact.actor
    }, parseBooleanOption(options.emitMetrics, true));

    try {
        appendMandatoryTaskEvent(
            orchestratorRoot,
            taskId,
            stageArtifact.status === 'PASSED' ? 'RULE_PACK_LOADED' : 'RULE_PACK_LOAD_FAILED',
            stageArtifact.outcome,
            stageArtifact.status === 'PASSED'
                ? `Rule pack loaded for ${stage}.`
                : `Rule pack load failed for ${stage}.`,
            {
                stage,
                artifact_path: normalizeOptionalPath(artifactPath),
                preflight_path: stageArtifact.preflight_path,
                required_rule_files: stageArtifact.required_rule_files,
                loaded_rule_files: stageArtifact.loaded_rule_files,
                missing_rule_files: stageArtifact.missing_rule_files,
                effective_depth: stageArtifact.effective_depth,
                required_reviews: stageArtifact.required_reviews,
                actor: stageArtifact.actor
            }
        );
    } catch (error: unknown) {
        removeArtifactIfExists(artifactPath);
        throw new Error(
            `load-rule-pack failed because mandatory lifecycle event '${stageArtifact.status === 'PASSED' ? 'RULE_PACK_LOADED' : 'RULE_PACK_LOAD_FAILED'}' could not be appended. ${getErrorMessage(error)}`
        );
    }

    if (stageArtifact.status !== 'PASSED') {
        const failureLines: string[] = [
            'RULE_PACK_LOAD_FAILED',
            `Stage: ${stage}`,
            `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            'Violations:',
            ...stageArtifact.violations.map(function (item) { return `- ${item}`; })
        ];
        if (stage === 'POST_PREFLIGHT' && stageArtifact.missing_rule_files.length > 0) {
            failureLines.push(
                'Remediation:',
                `  ${buildLoadRulePackPostPreflightRemediationCommand(
                    repoRoot, taskId, stageArtifact.preflight_path, stageArtifact.required_rule_files, String(options.taskModePath || '')
                )}`
            );
        }
        return { outputLines: failureLines, exitCode: EXIT_GATE_FAILURE };
    }

    return {
        outputLines: [
            'RULE_PACK_LOADED',
            `Stage: ${stage}`,
            `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            `RequiredRuleCount: ${stageArtifact.required_rule_count}`,
            `LoadedRuleCount: ${stageArtifact.loaded_rule_count}`
        ],
        exitCode: 0
    };
}

export function runBindRulePackToPreflightCommand(options: BindRulePackToPreflightCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const artifactPath = resolveRulePackArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    const preflightPath = String(options.preflightPath || '').trim();
    if (!preflightPath) {
        return {
            outputLines: [
                'RULE_PACK_BIND_FAILED',
                'Stage: POST_PREFLIGHT',
                `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
                'Reason: PreflightPath is required for POST_PREFLIGHT rule-pack rebinding.'
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
    const decision = getPostPreflightRulePackRebindDecision(repoRoot, taskId, preflightPath, {
        artifactPath,
        taskModePath: String(options.taskModePath || '')
    });

    if (!decision.can_bind) {
        return {
            outputLines: [
                'RULE_PACK_BIND_FAILED',
                'Stage: POST_PREFLIGHT',
                `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
                `Reason: ${decision.reason}`
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }

    const result = runLoadRulePackCommand({
        ...options,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        loadedRuleFiles: decision.loaded_rule_files,
        actor: String(options.actor || 'orchestrator:rule-pack-rebind'),
        artifactPath
    });
    if (result.exitCode !== 0) {
        return result;
    }

    return {
        outputLines: [
            'RULE_PACK_BOUND',
            'Stage: POST_PREFLIGHT',
            `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            `RequiredRuleCount: ${decision.required_rule_files.length}`,
            `ReusedLoadedRuleCount: ${decision.loaded_rule_files.length}`,
            `PreviousPreflightPath: ${decision.previous_preflight_path || '<none>'}`,
            `PreviousRulePackSequence: ${decision.previous_rule_pack_sequence ?? '<none>'}`
        ],
        exitCode: 0
    };
}

function readNoOpPreflightBinding(repoRoot: string, taskId: string, explicitPath: unknown) {
    try {
        const preflightPath = resolveCurrentNoOpPreflightPath(repoRoot, taskId, explicitPath);
        const context = getPreflightContext(preflightPath, taskId);
        if (context.preflight.task_id !== taskId) {
            throw new Error('Preflight must declare the exact current task identity.');
        }
        if (!Array.isArray(context.preflight.changed_files)
            || !Number.isFinite(context.changed_lines_total)
            || context.changed_lines_total !== 0 || context.changed_files_count !== 0) {
            throw new Error('No-op artifact requires a valid zero-diff preflight.');
        }
        const rulePack = getRulePackEvidence(repoRoot, taskId, 'POST_PREFLIGHT', { preflightPath });
        const sequence = getPostPreflightSequenceEvidence(repoRoot, taskId, preflightPath);
        const violations = [...getRulePackEvidenceViolations(rulePack), ...sequence.violations];
        if (violations.length > 0 || !sequence.binding_equivalent_to_current_preflight) {
            throw new Error(`Current preflight binding is invalid. ${violations.join(' ')}`);
        }
        const currentScope = getWorkspaceSnapshotCached(
            repoRoot, context.detection_source, context.include_untracked, context.authorized_files,
            { noCache: true, readOnly: true }
        );
        if (currentScope.changed_files_count !== 0 || currentScope.changed_lines_total !== 0
            || context.scope_sha256 && context.scope_sha256 !== currentScope.scope_sha256
            || context.scope_content_sha256 && context.scope_content_sha256 !== currentScope.scope_content_sha256) {
            throw new Error('Preflight workspace scope is stale or no longer zero-diff.');
        }
        const preflightSha256 = gateHelpers.fileSha256(preflightPath);
        if (!preflightSha256) {
            throw new Error('Current preflight cannot be hashed.');
        }
        return { preflightPath, preflightSha256 };
    } catch (error) {
        throw new Error(`Cannot record no-op: ${getErrorMessage(error)} Run next-step "${taskId}" to refresh native preflight and rule binding.`);
    }
}

function assertDistinctNoOpPublicationPaths(filePaths: string[]): void {
    const identities = filePaths.map((filePath) => {
        let ancestor = filePath;
        while (!fs.existsSync(ancestor)) {
            ancestor = path.dirname(ancestor);
        }
        const physicalPath = path.join(fs.realpathSync.native(ancestor), path.relative(ancestor, filePath));
        return {
            path: process.platform === 'win32' ? physicalPath.toLowerCase() : physicalPath,
            file: fs.existsSync(filePath) ? fs.statSync(filePath, { bigint: true }) : null
        };
    });
    for (let index = 0; index < identities.length; index += 1) {
        const current = identities[index];
        if (identities.slice(0, index).some((previous) => current.path === previous.path
            || current.file && previous.file && current.file.ino > 0n
            && current.file.dev === previous.file.dev && current.file.ino === previous.file.ino)) {
            throw new Error('Cannot record no-op: publication paths must be distinct from each other and the preflight input.');
        }
    }
}

export function runRecordNoOpCommand(options: RecordNoOpCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const reason = String(options.reason || '').trim();
    if (!reason) {
        throw new Error('Reason is required.');
    }
    const artifactPath = options.artifactPath
        ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
        : resolveNoOpArtifactPath(repoRoot, taskId, '');
    const { preflightPath, preflightSha256 } = readNoOpPreflightBinding(repoRoot, taskId, options.preflightPath);
    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    const emitMetrics = parseBooleanOption(options.emitMetrics, true);
    assertDistinctNoOpPublicationPaths(emitMetrics
        ? [preflightPath, artifactPath, metricsPath]
        : [preflightPath, artifactPath]);

    const artifact = buildNoOpArtifact({
        taskId,
        classification: options.classification,
        reason,
        actor: options.actor,
        preflightPath,
        preflightSha256
    });
    writeJsonArtifact(artifactPath, artifact);

    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.timestamp_utc,
        event_type: 'no_op_recorded',
        task_id: taskId,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        classification: artifact.classification,
        preflight_path: artifact.preflight_path,
        preflight_sha256: artifact.preflight_sha256
    }, emitMetrics);

    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'NO_OP_RECORDED',
        'INFO',
        'Audited no-op recorded.',
        {
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_sha256: gateHelpers.fileSha256(artifactPath),
            classification: artifact.classification,
            reason: artifact.reason,
            preflight_path: artifact.preflight_path,
            preflight_sha256: artifact.preflight_sha256
        }
    );

    return {
        outputLines: [
            'NO_OP_RECORDED',
            `TaskId: ${taskId}`,
            `Classification: ${artifact.classification}`,
            `ArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`
        ],
        exitCode: 0
    };
}

export function runRecordStrictDecompositionDecisionCommand(
    options: RecordStrictDecompositionDecisionCommandOptions
): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const artifactPath = resolveStrictDecompositionDecisionArtifactPath(
        repoRoot,
        taskId,
        String(options.artifactPath || '')
    );

    const artifact = buildStrictDecompositionDecisionArtifact({
        taskId,
        decision: options.decision,
        taskProfile: options.taskProfile,
        taskSummary: options.taskSummary,
        reason: options.reason,
        scopeRisk: options.scopeRisk,
        expectedReviewTypes: expandValueList(options.expectedReviewTypes || [], { splitDelimiters: true }),
        atomicityConstraints: expandValueList(options.atomicityConstraints || [], { splitDelimiters: false }),
        proposedChildTaskIds: expandValueList(options.proposedChildTaskIds || [], { splitDelimiters: true }),
        workPackageContract: readStrictDecompositionWorkPackageContractFile(
            repoRoot,
            options.workPackageContractPath
        )
    });
    if (artifact.work_package_contract) {
        const sourceViolations = validateStrictDecompositionWorkPackageFindingSources(
            repoRoot,
            taskId,
            artifact.work_package_contract
        );
        if (sourceViolations.length > 0) {
            throw new Error(`WorkPackageContract finding sources are invalid: ${sourceViolations.join(' ')}`);
        }
    }
    writeJsonArtifact(artifactPath, artifact);

    const metricsPath = options.metricsPath
        ? resolveContainedStrictDecompositionWritePath(repoRoot, options.metricsPath, 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.timestamp_utc,
        event_type: 'strict_decomposition_decision_recorded',
        task_id: taskId,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        decision: artifact.decision,
        task_profile: artifact.task_profile,
        expected_review_types: artifact.expected_review_types,
        expected_review_types_declared_none: artifact.expected_review_types_declared_none,
        proposed_child_task_ids: artifact.proposed_children.map((child) => child.task_id),
        work_package_task_ids: artifact.work_package_contract?.work_packages.map((entry) => entry.task_id) || [],
        finding_obligation_ids: artifact.work_package_contract?.finding_obligations.map((entry) => entry.obligation_id) || [],
        work_package_contract_sha256: artifact.work_package_contract_sha256,
        task_summary_sha256: artifact.task_summary_sha256
    }, parseBooleanOption(options.emitMetrics, true));

    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'STRICT_DECOMPOSITION_DECISION_RECORDED',
        'INFO',
        'Strict decomposition decision recorded.',
        {
            artifact_path: gateHelpers.normalizePath(artifactPath),
            decision: artifact.decision,
            task_profile: artifact.task_profile,
            expected_review_types: artifact.expected_review_types,
            expected_review_types_declared_none: artifact.expected_review_types_declared_none,
            proposed_child_task_ids: artifact.proposed_children.map((child) => child.task_id),
            work_package_task_ids: artifact.work_package_contract?.work_packages.map((entry) => entry.task_id) || [],
            finding_obligation_ids: artifact.work_package_contract?.finding_obligations.map((entry) => entry.obligation_id) || [],
            work_package_contract_sha256: artifact.work_package_contract_sha256,
            task_summary_sha256: artifact.task_summary_sha256
        }
    );

    return {
        outputLines: [
            'STRICT_DECOMPOSITION_DECISION_RECORDED',
            `TaskId: ${taskId}`,
            `Decision: ${artifact.decision}`,
            `ExpectedReviews: ${artifact.expected_review_types_declared_none ? 'none' : artifact.expected_review_types.join(',')}`,
            `ProposedChildren: ${artifact.proposed_children.map((child) => child.task_id).join(',') || 'none'}`,
            `WorkPackages: ${artifact.work_package_contract?.work_packages.length || 0}`,
            `FindingObligations: ${artifact.work_package_contract?.finding_obligations.length || 0}`,
            `ArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`
        ],
        exitCode: 0
    };
}
