/**
 * Test helpers: rule/config seeding, artifact writers, evidence builders,
 * and gate-lifecycle orchestration for test fixtures.
 *
 * Extracted from gate-test-helpers.ts to isolate seeding and evidence
 * concerns from repo bootstrapping and CLI capture.
 * All exports are test-only.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import {createHash} from 'node:crypto';
import {sha256RedactedJsonPayload} from '../../../../src/core/redaction';

import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../src/cli/commands/gates';
import {buildReviewContext} from '../../../../src/gates/review-context/build-review-context';
import {getWorkspaceSnapshot} from '../../../../src/gates/compile/compile-gate';
import {buildScopedDiff} from '../../../../src/gates/preflight/build-scoped-diff';
import {
    buildReviewContextPreflightDiffExpectations
} from '../../../../src/gates/review-context/review-context-contract';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    resolveReviewContextReuseContractBindings
} from '../../../../src/gates/review-reuse';
import {buildReviewTreeState} from '../../../../src/gates/review/review-tree-state';
import {
    buildReviewCoverageContract,
    type ReviewCoverageContract
} from '../../../../src/gates/review/review-coverage-ledger';
import {
    validateReviewFindingsContract
} from '../../../../src/gates/review/review-findings-artifact-verdict';
import {
    REVIEW_FINDINGS_SCHEMA_VERSION
} from '../../../../src/gates/review/review-findings-schema';
import {
    resolveReviewContextExecutionEvidenceBindings,
    type ReviewExecutionEvidenceBindings
} from '../../../../src/gates/review/review-evidence-contract';
import {
    buildReviewRemediationReviewContract,
    type ReviewerRemediationCoverageDeclaration,
    type ReviewRemediationReviewContract
} from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath,
    type ReviewFindingsValidationArtifact
} from '../../../../src/gates/review/review-findings-validation-artifact';
import {
    buildReviewFindingsDispositionArtifact,
    getReviewFindingsDispositionArtifactPath,
    getReviewFindingsDispositionArtifactSnapshotPath
} from '../../../../src/gates/review/review-findings-disposition-artifact';
import {resolveLockedReviewFindingPolicyFromPreflight} from '../../../../src/gates/review/review-finding-disposition';
import {resolveDefaultReviewScratchPath} from '../../../../src/gates/review/review-scratch-paths';
import {
    buildReviewerLaunchBindingSha256
} from '../../../../src/cli/commands/gate-review-handlers/launch/review-launch-input-attestation';
import {writeProtectedControlPlaneManifest} from '../../../../src/gates/shared/helpers';
import {getWorkflowConfigPreTaskBaselineState} from '../../../../src/gates/workflow-config/workflow-config-work';
import {resolveReviewerRoutingPolicy} from '../../../../src/gates/review/reviewer-routing';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance
} from '../../../../src/gate-runtime/review-context';
import {appendTaskEvent} from '../../../../src/gate-runtime/task-events';
import {loadFullSuiteValidationConfig} from '../../../../src/core/full-suite-validation-config';
import {readReviewCatalogConfigFile} from '../../../../src/core/review-catalog';
import {readReviewCapabilitiesConfigFile} from '../../../../src/core/review-capabilities';
import {loadReviewExecutionPolicyConfig} from '../../../../src/core/review-execution-policy';
import {buildEffectiveReviewSnapshot} from '../../../../src/policy/effective-review-snapshot';
import {
    resolveLegacyCompatibilityReviewCatalogBinding,
    resolveProfileReviewCatalogPolicy
} from '../../../../src/policy/profile-review-catalog-policy';
import {type TaskProfilePolicySnapshot} from '../../../../src/policy/task-profile-policy-snapshot';

import {getOrchestratorRoot, getReviewsRoot} from './gate-test-repo-bootstrap';


export {
    runClassifyChangeCommand
};

export const PROVIDER_ENTRYPOINT_BY_SOURCE: Record<string, string> = {
    Claude: 'CLAUDE.md',
    Codex: 'AGENTS.md',
    Gemini: 'GEMINI.md',
    Qwen: 'QWEN.md',
    GitHubCopilot: '.github/copilot-instructions.md',
    Windsurf: '.windsurf/rules/rules.md',
    Junie: '.junie/guidelines.md',
    Antigravity: '.antigravity/rules.md'
};

export const PROVIDER_BRIDGE_BY_SOURCE: Record<string, string> = {
    GitHubCopilot: '.github/agents/orchestrator.md',
    Windsurf: '.windsurf/agents/orchestrator.md',
    Junie: '.junie/agents/orchestrator.md',
    Antigravity: '.antigravity/agents/orchestrator.md'
};

const TEST_REVIEW_LAUNCH_PREPARED_AT_UTC = '2026-04-28T00:00:00.000Z';
const TEST_REVIEW_LAUNCHED_AT_UTC = '2026-04-28T00:00:01.000Z';
const TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC = '2026-04-28T00:00:12.000Z';
const TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC = '2026-04-28T00:00:13.000Z';
const PROVISIONAL_EFFECTIVE_REVIEW_PREFLIGHTS = new Map<string, Set<string>>();

function provisionalPreflightKey(repoRoot: string, taskId: string): string {
    return `${path.resolve(repoRoot)}\0${taskId}`;
}

function registerProvisionalEffectiveReviewPreflight(
    repoRoot: string,
    taskId: string,
    preflightPath: string
): void {
    const key = provisionalPreflightKey(repoRoot, taskId);
    const registered = PROVISIONAL_EFFECTIVE_REVIEW_PREFLIGHTS.get(key) || new Set<string>();
    registered.add(path.resolve(preflightPath));
    PROVISIONAL_EFFECTIVE_REVIEW_PREFLIGHTS.set(key, registered);
}

function rebindProvisionalEffectiveReviewPreflights(
    repoRoot: string,
    taskId: string,
    taskModePath: string
): void {
    const key = provisionalPreflightKey(repoRoot, taskId);
    const registered = PROVISIONAL_EFFECTIVE_REVIEW_PREFLIGHTS.get(key);
    if (!registered) return;
    PROVISIONAL_EFFECTIVE_REVIEW_PREFLIGHTS.delete(key);
    for (const preflightPath of registered) {
        if (!fs.existsSync(preflightPath)) continue;
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        delete preflight.effective_review_snapshot;
        fs.writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');
        bindFixtureEffectiveReviewSnapshot(repoRoot, taskId, 'code', preflightPath, taskModePath);
    }
}

function buildTestProviderInvocationId(taskId: string, reviewKey: string, reviewerIdentity: string): string {
    const normalizedIdentity = reviewerIdentity.replace(/^agent:/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
    return `test-${taskId}-${reviewKey}-${normalizedIdentity}`;
}

function buildFixtureLaunchInputEvidence(taskId: string, reviewKey: string): {
    copy_paste_reviewer_launch_prompt: string;
    copy_paste_reviewer_launch_prompt_sha256: string;
    launch_input_mode: 'copy_paste_prompt';
    launch_input_sha256: string;
    launch_input_copy_paste_reviewer_launch_prompt_sha256: string;
    reviewer_prompt_sha256: string;
    role_prompt_sha256: string;
    prompt_template_sha256: string;
    output_template_sha256: string;
    evidence_manifest_sha256: string;
} {
    const copyPastePrompt = `Delegated ${reviewKey} reviewer launch prompt for ${taskId}.`;
    const copyPastePromptSha256 = createHash('sha256').update(copyPastePrompt, 'utf8').digest('hex');
    return {
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        launch_input_mode: 'copy_paste_prompt',
        launch_input_sha256: copyPastePromptSha256,
        launch_input_copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        reviewer_prompt_sha256: createHash('sha256').update(`reviewer-prompt:${taskId}:${reviewKey}`, 'utf8').digest('hex'),
        role_prompt_sha256: createHash('sha256').update(`role-prompt:${taskId}:${reviewKey}`, 'utf8').digest('hex'),
        prompt_template_sha256: createHash('sha256').update(`prompt-template:${taskId}:${reviewKey}`, 'utf8').digest('hex'),
        output_template_sha256: createHash('sha256').update(`output-template:${taskId}:${reviewKey}`, 'utf8').digest('hex'),
        evidence_manifest_sha256: createHash('sha256').update(`evidence-manifest:${taskId}:${reviewKey}`, 'utf8').digest('hex')
    };
}

function seedCompletedReviewerLaunchFixture(options: {
    repoRoot: string;
    taskId: string;
    reviewKey: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewExecutionBindings: ReviewExecutionEvidenceBindings;
}): {
    launchArtifactPath: string;
    launchArtifactSha256: string;
    launchInputMode: 'copy_paste_prompt';
    launchInputSha256: string;
    copyPastePromptSha256: string;
    providerInvocationId: string;
    launchTool: string;
    attestationSource: string;
} {
    const launchInputEvidence = buildFixtureLaunchInputEvidence(options.taskId, options.reviewKey);
    const providerInvocationId = buildTestProviderInvocationId(options.taskId, options.reviewKey, options.reviewerIdentity);
    const launchTool = 'test-subagent-spawn';
    const attestationSource = 'test-subagent-spawn';
    const launchArtifactPath = resolveDefaultReviewScratchPath(
        options.repoRoot,
        options.taskId,
        options.reviewKey,
        'reviewer-launch.json'
    );
    fs.mkdirSync(path.dirname(launchArtifactPath), {recursive: true});
    const launchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId: options.taskId,
        reviewType: options.reviewKey,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        reviewerPromptSha256: launchInputEvidence.reviewer_prompt_sha256
    });
    const preparedEvent = appendTaskEvent(
        getOrchestratorRoot(options.repoRoot),
        options.taskId,
        'REVIEWER_LAUNCH_PREPARED',
        'INFO',
        'reviewer launch prepared',
        {
            task_id: options.taskId,
            review_type: options.reviewKey,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: options.reviewContextSha256,
            routing_event_sha256: options.routingEventSha256,
            reviewer_prompt_sha256: launchInputEvidence.reviewer_prompt_sha256,
            role_prompt_sha256: launchInputEvidence.role_prompt_sha256,
            prompt_template_sha256: launchInputEvidence.prompt_template_sha256,
            output_template_sha256: launchInputEvidence.output_template_sha256,
            evidence_manifest_sha256: launchInputEvidence.evidence_manifest_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_artifact_path: path.normalize(launchArtifactPath).replace(/\\/g, '/'),
            ...options.reviewExecutionBindings
        },
        {passThru: true}
    );
    const launchArtifact = {
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch',
        attestation_state: 'launched',
        task_id: options.taskId,
        review_type: options.reviewKey,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: options.reviewerIdentity,
        reviewer_session_id: options.reviewerIdentity,
        review_context_sha256: options.reviewContextSha256,
        routing_event_sha256: options.routingEventSha256,
        launch_binding_sha256: launchBindingSha256,
        prepared_launch_event_sha256: String(preparedEvent?.integrity?.event_sha256 || '').trim(),
        launch_tool: launchTool,
        provider_invocation_id: providerInvocationId,
        launch_prepared_at_utc: TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
        delegation_started_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launched_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launch_completed_at_utc: TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
        ...launchInputEvidence,
        ...options.reviewExecutionBindings,
        fork_context: false
    };
    const launchArtifactText = JSON.stringify(launchArtifact, null, 2);
    fs.writeFileSync(launchArtifactPath, launchArtifactText, 'utf8');
    return {
        launchArtifactPath,
        launchArtifactSha256: createHash('sha256').update(launchArtifactText, 'utf8').digest('hex'),
        launchInputMode: launchInputEvidence.launch_input_mode,
        launchInputSha256: launchInputEvidence.launch_input_sha256,
        copyPastePromptSha256: launchInputEvidence.copy_paste_reviewer_launch_prompt_sha256,
        providerInvocationId,
        launchTool,
        attestationSource
    };
}

function resolveAttestedTaskModeRoute(provider: string): string | null {
    const normalizedProvider = String(provider || '').trim();
    if (!normalizedProvider) {
        return null;
    }
    return PROVIDER_BRIDGE_BY_SOURCE[normalizedProvider] || PROVIDER_ENTRYPOINT_BY_SOURCE[normalizedProvider] || null;
}


export function writeReviewCapabilitiesConfig(
    repoRoot: string,
    overrides: Partial<Record<'code' | 'db' | 'security' | 'refactor' | 'api' | 'test' | 'performance' | 'infra' | 'dependency', boolean>> = {}
): string {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    const configPath = path.join(configDir, 'review-capabilities.json');
    fs.mkdirSync(configDir, {recursive: true});
    fs.writeFileSync(configPath, JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: true,
        ...overrides
    }, null, 2) + '\n', 'utf8');
    return configPath;
}

export function writeBudgetOutputFilters(repoRoot: string): string {
    const outputFiltersPath = path.join(
        getOrchestratorRoot(repoRoot),
        'runtime',
        'test-config',
        'output-filters.json'
    );
    fs.mkdirSync(path.dirname(outputFiltersPath), {recursive: true});
    fs.writeFileSync(outputFiltersPath, JSON.stringify({
        version: 2,
        budget_profiles: {
            enabled: true,
            tiers: [
                {
                    label: 'tight',
                    max_tokens: null,
                    passthrough_ceiling_max_lines: 12,
                    fail_tail_lines: 3,
                    max_matches: 5,
                    max_parser_lines: 6,
                    truncate_line_max_chars: 160
                }
            ]
        },
        profiles: {
            compile_success_console: {
                description: 'Compile success telemetry',
                operations: []
            },
            compile_failure_console_generic: {
                description: 'Compile failure telemetry',
                operations: []
            },
            review_gate_success_console: {
                description: 'Review gate success telemetry',
                operations: []
            },
            review_gate_failure_console: {
                description: 'Review gate failure telemetry',
                operations: []
            }
        }
    }, null, 2), 'utf8');
    return outputFiltersPath;
}

export function writeBalancedProfilesConfig(repoRoot: string): string {
    const configPath = path.join(
        getOrchestratorRoot(repoRoot),
        'live',
        'config',
        'profiles.json'
    );
    fs.mkdirSync(path.dirname(configPath), {recursive: true});
    fs.writeFileSync(configPath, `${JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Balanced integration-test profile.',
                depth: 2,
                task_decomposition: {
                    enabled: false
                },
                review_policy: {
                    code: true,
                    db: 'auto',
                    security: 'auto',
                    refactor: 'auto',
                    api: 'auto',
                    test: 'auto',
                    performance: 'auto',
                    infra: 'auto',
                    dependency: 'auto'
                },
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'balanced',
                    findings: {
                        critical: 'fix_now',
                        high: 'fix_now',
                        medium: 'fix_now',
                        low: 'create_follow_up'
                    },
                    residual_risk: 'create_follow_up'
                },
                review_follow_up_policy: {
                    schema_version: 1,
                    materialization_mode: 'grouped_by_parent'
                },
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: true,
                    compact_reviewer_output: true
                },
                skills: {
                    auto_suggest: true
                }
            }
        },
        user_profiles: {}
    }, null, 2)}\n`, 'utf8');
    return configPath;
}

export function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO', profile = 'default'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | ${profile} | fixture |`
    ].join('\n'), 'utf8');
}

export function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(initAnswersPath), {recursive: true});
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: sourceOfTruth,
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: ''
    }, null, 2), 'utf8');
}


export function withDefaultTaskModeRouting<T extends {
    repoRoot?: string;
    provider?: unknown;
    routedTo?: unknown
}>(options: T): T {
    if (String(options.routedTo || '').trim()) {
        return options;
    }
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    const explicitProvider = String(options.provider || '').trim();
    if (explicitProvider) {
        const routedTo = resolveAttestedTaskModeRoute(explicitProvider);
        return routedTo
            ? {
                ...options,
                provider: explicitProvider,
                routedTo
            }
            : options;
    }
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return options;
    }

    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        const routedTo = resolveAttestedTaskModeRoute(sourceOfTruth);
        if (!sourceOfTruth || !routedTo) {
            return options;
        }
        return {
            ...options,
            provider: sourceOfTruth,
            routedTo
        };
    } catch {
        return options;
    }
}

export function runEnterTaskMode(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
    const resolvedOptions = withDefaultTaskModeRouting({
        startBanner: 'Garda captures my mind',
        ...options
    });
    const repoRoot = path.resolve(String(resolvedOptions.repoRoot || '.'));
    const routedTo = String(resolvedOptions.routedTo || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (routedTo) {
        const routedFilePath = path.join(repoRoot, routedTo);
        fs.mkdirSync(path.dirname(routedFilePath), {recursive: true});
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
            if (fs.existsSync(path.join(repoRoot, '.git'))) {
                runGit(repoRoot, ['add', '--', routedTo]);
                runGit(repoRoot, ['commit', '-m', 'test: seed routed workflow fixture', '--', routedTo]);
            }
        }
    }
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        const taskId = String(resolvedOptions.taskId || '').trim();
        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        initializeGitRepoWithMaterializedScope(
            repoRoot,
            taskId ? readChangedFilesFromPreflight(preflightPath) : []
        );
    }
    const manifestPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'protected-control-plane-manifest.json');
    if (!fs.existsSync(manifestPath)) {
        const workflowConfigBaseline = getWorkflowConfigPreTaskBaselineState(repoRoot);
        if (
            workflowConfigBaseline.changed_files.length === 0
            && workflowConfigBaseline.compatibility_baseline_files.length === 0
        ) {
            writeProtectedControlPlaneManifest(repoRoot);
        }
    }
    const result = runEnterTaskModeCommand(resolvedOptions);
    if (result.exitCode === 0) {
        const taskId = String(resolvedOptions.taskId || '').trim();
        const explicitTaskModePath = String(resolvedOptions.artifactPath || '').trim();
        const taskModePath = explicitTaskModePath
            ? path.resolve(repoRoot, explicitTaskModePath)
            : path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        rebindProvisionalEffectiveReviewPreflights(repoRoot, taskId, taskModePath);
    }
    return result;
}


export function createReviewerRoutingFixture(
    sourceOfTruth: string,
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const normalizedSourceOfTruth = String(sourceOfTruth).trim() || 'Codex';
    const attestedRoute = resolveAttestedTaskModeRoute(normalizedSourceOfTruth);
    const executionProviderSource = (
        attestedRoute
        && PROVIDER_BRIDGE_BY_SOURCE[normalizedSourceOfTruth] === attestedRoute
    )
        ? 'provider_bridge'
        : 'provider_entrypoint';
    const policy = resolveReviewerRoutingPolicy(normalizedSourceOfTruth, executionProviderSource);
    return {
        source_of_truth: normalizedSourceOfTruth,
        canonical_source_of_truth: normalizedSourceOfTruth,
        execution_provider: normalizedSourceOfTruth,
        execution_provider_source: executionProviderSource,
        identity_status: 'resolved',
        capability_level: policy.capability_level,
        delegation_required: policy.delegation_required,
        expected_execution_mode: policy.expected_execution_mode,
        fallback_allowed: policy.fallback_allowed,
        fallback_reason_required: policy.fallback_reason_required,
        actual_execution_mode: null,
        reviewer_session_id: null,
        fallback_reason: null,
        ...overrides
    };
}

export function resolveReviewerExecutionFixture(
    _taskId: string,
    sourceOfTruth = 'Codex',
    delegatedIdentity = 'agent:test-reviewer'
): {
    reviewerExecutionMode: ReturnType<typeof resolveReviewerRoutingPolicy>['expected_execution_mode'];
    reviewerIdentity: string;
    reviewerFallbackReason: null;
    trustLevel: 'INDEPENDENT_AUDITED';
} {
    const normalizedSourceOfTruth = String(sourceOfTruth).trim() || 'Codex';
    const attestedRoute = resolveAttestedTaskModeRoute(normalizedSourceOfTruth);
    const executionProviderSource = (
        attestedRoute
        && PROVIDER_BRIDGE_BY_SOURCE[normalizedSourceOfTruth] === attestedRoute
    )
        ? 'provider_bridge'
        : 'provider_entrypoint';
    return {
        reviewerExecutionMode: resolveReviewerRoutingPolicy(normalizedSourceOfTruth, executionProviderSource).expected_execution_mode,
        reviewerIdentity: delegatedIdentity,
        reviewerFallbackReason: null,
        trustLevel: 'INDEPENDENT_AUDITED'
    };
}


export function writePreflight(
    repoRoot: string,
    taskId: string,
    overrides: Record<string, unknown> = {},
    outputFileName = `${taskId}-preflight.json`
): string {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, {recursive: true});
    const preflightPath = path.join(reviewsRoot, outputFileName);
    const payload = {
        task_id: taskId,
        detection_source: 'explicit_changed_files',
        mode: 'FULL_PATH',
        metrics: {changed_lines_total: 1},
        required_reviews: {
            code: true,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        profile_policy_snapshot: {
            review_finding_policy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'fix_now',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        },
        triggers: {},
        changed_files: ['src/app.ts'],
        ...overrides
    };
    fs.writeFileSync(preflightPath, JSON.stringify(payload, null, 2), 'utf8');
    if (!Object.prototype.hasOwnProperty.call(overrides, 'effective_review_snapshot')) {
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        bindFixtureEffectiveReviewSnapshot(
            repoRoot,
            taskId,
            'code',
            preflightPath,
            taskModePath
        );
        if (!fs.existsSync(taskModePath)) {
            registerProvisionalEffectiveReviewPreflight(repoRoot, taskId, preflightPath);
        }
    }
    return preflightPath;
}

const GIT_FIXTURE_MAX_SETUP_ATTEMPTS = 3;
const GIT_FIXTURE_SETUP_RETRY_DELAYS_MS = [25, 75];

function isGitFixtureSetupCommand(args: string[]): boolean {
    return args[0] === 'init' || args[0] === 'config';
}

export function isTransientGitFixtureSetupError(output: string): boolean {
    const normalized = output.replace(/\\/g, '/');
    return /permission denied/i.test(normalized)
        || /could not set ['"]?core\.ignorecase['"]?/i.test(normalized)
        || /\.git\/config/i.test(normalized)
        || /index\.lock/i.test(normalized);
}

function sleepGitFixtureRetryDelay(attempt: number): void {
    const delayMs = GIT_FIXTURE_SETUP_RETRY_DELAYS_MS[Math.min(attempt - 1, GIT_FIXTURE_SETUP_RETRY_DELAYS_MS.length - 1)] || 0;
    const deadline = Date.now() + delayMs;
    while (Date.now() < deadline) {
        // Bounded fixture-only backoff for transient Windows temp git config locks.
    }
}

function gitFixtureOutput(result: childProcess.SpawnSyncReturns<string>): string {
    return [
        result.error instanceof Error ? result.error.message : '',
        result.stdout || '',
        result.stderr || ''
    ].filter(Boolean).join('\n');
}

export function formatGitFixtureFailureMessage(
    repoRoot: string,
    args: string[],
    result: childProcess.SpawnSyncReturns<string>,
    attempts: number
): string {
    const output = gitFixtureOutput(result).trim() || '<no output>';
    return [
        `git fixture command failed in ${repoRoot}`,
        `Command: git ${args.join(' ')}`,
        `Attempts: ${attempts}`,
        `ExitStatus: ${String(result.status)}`,
        `Output: ${output}`
    ].join('\n');
}

export function runGit(
    repoRoot: string,
    args: string[],
    options: { retryFixtureSetup?: boolean } = {}
): childProcess.SpawnSyncReturns<string> {
    const maxAttempts = options.retryFixtureSetup && isGitFixtureSetupCommand(args)
        ? GIT_FIXTURE_MAX_SETUP_ATTEMPTS
        : 1;
    let result: childProcess.SpawnSyncReturns<string> | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        result = childProcess.spawnSync('git', args, {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8'
        });
        if (result.status === 0 && !result.error) {
            return result;
        }
        if (
            attempt < maxAttempts
            && isTransientGitFixtureSetupError(gitFixtureOutput(result))
        ) {
            sleepGitFixtureRetryDelay(attempt);
            continue;
        }
        break;
    }

    assert.ok(result !== null);
    assert.equal(
        result.status,
        0,
        formatGitFixtureFailureMessage(repoRoot, args, result, maxAttempts)
    );
    return result;
}

export function initializeGitRepo(repoRoot: string): void {
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const runtimeIgnore = 'garda-agent-orchestrator/runtime/';
    const existingGitignore = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf8')
        : '';
    if (!existingGitignore.split(/\r?\n/u).includes(runtimeIgnore)) {
        fs.writeFileSync(
            gitignorePath,
            `${existingGitignore}${existingGitignore && !existingGitignore.endsWith('\n') ? '\n' : ''}${runtimeIgnore}\n`,
            'utf8'
        );
    }
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        runGit(repoRoot, ['init'], {retryFixtureSetup: true});
    }

    const configPath = path.join(repoRoot, '.git', 'config');
    if (fs.existsSync(configPath)) {
        const userConfig = '\n[core]\n\tautocrlf = false\n\teol = lf\n\tsafecrlf = false\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[user]\n\tname = Garda Tests\n\temail = garda-tests@example.com\n';
        fs.appendFileSync(configPath, userConfig, 'utf8');
    }

    runGit(repoRoot, ['add', '.']);
    const status = runGit(repoRoot, ['status', '--porcelain']).stdout.trim();
    if (status) {
        runGit(repoRoot, ['commit', '-m', 'test: baseline']);
    }
}

function runGitBestEffort(repoRoot: string, args: string[], options: { retryFixtureSetup?: boolean } = {}): void {
    try {
        runGit(repoRoot, args, options);
    } catch {
        // Review fixtures can be pre-seeded by individual tests; this helper only best-effort fills gaps.
    }
}

function runGitBestEffortRaw(repoRoot: string, args: string[]): void {
    childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

function readChangedFilesFromPreflight(preflightPath: string): string[] {
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return ['src/app.ts'];
    }
    try {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        return Array.isArray(preflight.changed_files)
            ? preflight.changed_files
                .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
                .filter(Boolean)
            : ['src/app.ts'];
    } catch {
        return ['src/app.ts'];
    }
}

type MaterializedScopeEntry = {
    absolutePath: string;
    originalContent: Buffer | null;
};

function pathEscapesRoot(rootPath: string, candidatePath: string): boolean {
    const relativePath = path.relative(rootPath, candidatePath);
    return relativePath === '..'
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath);
}

function lstatFixturePath(candidatePath: string): fs.Stats | null {
    try {
        return fs.lstatSync(candidatePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function assertMaterializedScopeHasNoSymlink(
    repoRoot: string,
    absolutePath: string,
    relativePath: string
): void {
    const pathFromRoot = path.relative(repoRoot, absolutePath);
    let currentPath = repoRoot;
    for (const segment of pathFromRoot.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        const pathStat = lstatFixturePath(currentPath);
        if (pathStat === null) {
            return;
        }
        if (pathStat.isSymbolicLink()) {
            throw new Error(`Test changed-file fixture must not traverse a symlink: ${relativePath}`);
        }
        if (currentPath !== absolutePath && !pathStat.isDirectory()) {
            throw new Error(`Test changed-file fixture parent must be a directory: ${relativePath}`);
        }
    }
}

function resolveExistingFixtureAncestor(candidatePath: string): string {
    let currentPath = candidatePath;
    while (lstatFixturePath(currentPath) === null) {
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            break;
        }
        currentPath = parentPath;
    }
    return currentPath;
}

function resolveMaterializedScopeEntries(
    repoRoot: string,
    changedFiles: readonly string[]
): MaterializedScopeEntry[] {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const realRepoRoot = fs.realpathSync(resolvedRepoRoot);
    const gitDirectory = path.join(resolvedRepoRoot, '.git');
    const entriesByPath = new Map<string, MaterializedScopeEntry>();

    for (const rawRelativePath of changedFiles) {
        const relativePath = String(rawRelativePath || '').trim();
        if (!relativePath || relativePath.startsWith(':') || path.isAbsolute(relativePath)) {
            throw new Error(`Test changed-file fixture must stay inside repo root: ${String(rawRelativePath)}`);
        }
        const absolutePath = path.resolve(resolvedRepoRoot, relativePath);
        if (
            absolutePath === resolvedRepoRoot
            || pathEscapesRoot(resolvedRepoRoot, absolutePath)
            || absolutePath === gitDirectory
            || !pathEscapesRoot(gitDirectory, absolutePath)
        ) {
            throw new Error(`Test changed-file fixture must stay inside repo root: ${relativePath}`);
        }

        assertMaterializedScopeHasNoSymlink(resolvedRepoRoot, absolutePath, relativePath);
        const existingAncestor = resolveExistingFixtureAncestor(absolutePath);
        const realExistingAncestor = fs.realpathSync(existingAncestor);
        if (pathEscapesRoot(realRepoRoot, realExistingAncestor)) {
            throw new Error(`Test changed-file fixture must stay inside repo root: ${relativePath}`);
        }

        let originalContent: Buffer | null = null;
        const fileStat = lstatFixturePath(absolutePath);
        if (fileStat !== null) {
            if (!fileStat.isFile()) {
                throw new Error(`Test changed-file fixture must be a regular file: ${relativePath}`);
            }
            const realFilePath = fs.realpathSync(absolutePath);
            if (pathEscapesRoot(realRepoRoot, realFilePath)) {
                throw new Error(`Test changed-file fixture must stay inside repo root: ${relativePath}`);
            }
            originalContent = fs.readFileSync(absolutePath);
        }

        const dedupeKey = process.platform === 'win32'
            ? absolutePath.toLocaleLowerCase('en-US')
            : absolutePath;
        if (!entriesByPath.has(dedupeKey)) {
            entriesByPath.set(dedupeKey, {absolutePath, originalContent});
        }
    }

    return [...entriesByPath.values()];
}

export function initializeGitRepoWithMaterializedScope(repoRoot: string, changedFiles: readonly string[]): void {
    if (fs.existsSync(path.join(repoRoot, '.git'))) {
        return;
    }

    const materializedScope = resolveMaterializedScopeEntries(repoRoot, changedFiles);
    const preparedEntries: MaterializedScopeEntry[] = [];
    try {
        for (const entry of materializedScope) {
            preparedEntries.push(entry);
            fs.mkdirSync(path.dirname(entry.absolutePath), {recursive: true});
            fs.writeFileSync(
                entry.absolutePath,
                entry.originalContent === null
                    ? Buffer.alloc(0)
                    : Buffer.concat([entry.originalContent, Buffer.from('\n')])
            );
        }
        initializeGitRepo(repoRoot);
    } finally {
        for (const entry of preparedEntries) {
            if (entry.originalContent !== null) {
                fs.writeFileSync(entry.absolutePath, entry.originalContent);
            } else if (lstatFixturePath(entry.absolutePath) !== null) {
                fs.unlinkSync(entry.absolutePath);
            }
        }
    }
}

export function prepareReviewDiffFixture(repoRoot: string, preflightPath: string): void {
    const changedFiles = readChangedFilesFromPreflight(preflightPath);
    if (changedFiles.length === 0) {
        return;
    }

    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        runGitBestEffort(repoRoot, ['init'], {retryFixtureSetup: true});
    }
    const configPath = path.join(repoRoot, '.git', 'config');
    if (fs.existsSync(configPath)) {
        const userConfig = '\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[user]\n\tname = Garda Tests\n\temail = garda-tests@example.com\n';
        fs.appendFileSync(configPath, userConfig, 'utf8');
    }
    const head = childProcess.spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    if (head.status !== 0) {
        const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        if (fs.existsSync(workflowConfigPath)) {
            runGitBestEffortRaw(repoRoot, ['add', '--', 'garda-agent-orchestrator/live/config/workflow-config.json']);
        }
        runGitBestEffortRaw(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
    }

    for (const changedFile of changedFiles) {
        if (
            changedFile.startsWith('/')
            || changedFile.startsWith('../')
            || changedFile.includes('/../')
            || changedFile.startsWith(':')
        ) {
            continue;
        }
        const absolutePath = path.join(repoRoot, ...changedFile.split('/'));
        fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
        if (!fs.existsSync(absolutePath)) {
            fs.writeFileSync(absolutePath, `// review fixture for ${changedFile}\n`, 'utf8');
            continue;
        }
        const pathStatus = childProcess.spawnSync('git', ['status', '--porcelain', '--', changedFile], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        if (pathStatus.status === 0 && !String(pathStatus.stdout || '').trim()) {
            fs.appendFileSync(absolutePath, '\n', 'utf8');
        }
    }
}

function readReviewPreflightFixture(repoRoot: string, taskId: string): {
    preflightPath: string;
    preflightSha256: string | null;
    preflight: Record<string, unknown>;
} {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return {
            preflightPath,
            preflightSha256: null,
            preflight: {}
        };
    }
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    return {
        preflightPath,
        preflightSha256: createHash('sha256').update(preflightText).digest('hex'),
        preflight: JSON.parse(preflightText) as Record<string, unknown>
    };
}

function buildManualReviewContextTaskScopeFixture(preflight: Record<string, unknown>): Record<string, unknown> {
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files
            .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
            .filter(Boolean)
        : [];
    return {
        changed_files: changedFiles,
        changed_file_count: changedFiles.length,
        diff: {
            available: changedFiles.length > 0,
            source: 'fixture_task_diff',
            char_count: changedFiles.length > 0 ? 120 : 0,
            truncated: false
        }
    };
}

function buildReceiptBackedReviewContextFixture(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    reviewerEvidence: ReturnType<typeof resolveDefaultReviewerEvidence>,
    options: {
        allowLegacyManualReviewContext?: boolean;
        legacyMarkdownArtifact?: boolean;
    } = {}
): { reviewContext: Record<string, unknown>; reviewContextText: string } {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-review-context.json`);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    if (
        fs.existsSync(preflightPath)
        && fs.statSync(preflightPath).isFile()
        && options.allowLegacyManualReviewContext !== true
    ) {
        bindFixtureEffectiveReviewSnapshot(repoRoot, taskId, reviewKey, preflightPath, '');
        prepareReviewDiffFixture(repoRoot, preflightPath);
        buildReviewContext({
            reviewType: reviewKey,
            depth: 2,
            preflightPath,
            tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
            scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`),
            outputPath: reviewContextPath,
            repoRoot
        });
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: reviewerEvidence.executionMode,
            reviewerSessionId: reviewerEvidence.reviewerIdentity,
            fallbackReason: reviewerEvidence.reviewerFallbackReason
        });
        const reviewContextText = fs.readFileSync(reviewContextPath, 'utf8');
        return {
            reviewContext: JSON.parse(reviewContextText) as Record<string, unknown>,
            reviewContextText
        };
    }

    if (options.allowLegacyManualReviewContext !== true) {
        throw new Error(
            'Manual review-context fixtures require explicit allowLegacyManualReviewContext opt-in. ' +
            `Missing or bypassed preflight artifact: ${preflightPath}`
        );
    }

    const preflightFixture = readReviewPreflightFixture(repoRoot, taskId);
    if (preflightFixture.preflightSha256) {
        prepareReviewDiffFixture(repoRoot, preflightFixture.preflightPath);
    }
    const promptArtifactPath = reviewContextPath.replace(/\.json$/, '.md');
    const promptArtifactText = [
        `# ${reviewKey} review fixture`,
        '',
        `Fixture prompt artifact for ${taskId}/${reviewKey}.`
    ].join('\n');
    fs.writeFileSync(promptArtifactPath, promptArtifactText, 'utf8');
    const promptArtifactSha256 = createHash('sha256').update(promptArtifactText).digest('hex');
    const changedFiles = Array.isArray(preflightFixture.preflight.changed_files)
        ? preflightFixture.preflight.changed_files
            .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
            .filter(Boolean)
        : [];
    const metrics = preflightFixture.preflight.metrics
    && typeof preflightFixture.preflight.metrics === 'object'
    && !Array.isArray(preflightFixture.preflight.metrics)
        ? preflightFixture.preflight.metrics as Record<string, unknown>
        : {};
    const reviewExecution = buildReviewRemediationReviewContract({
        taskId,
        reviewType: reviewKey,
        preflightSha256: preflightFixture.preflightSha256
            || createHash('sha256').update(JSON.stringify(preflightFixture.preflight)).digest('hex'),
        fullReviewScope: changedFiles
    });
    const coverageContract = buildReviewCoverageContract({
        reviewType: reviewKey,
        changedFiles
    });
    const reviewTreeState = buildReviewTreeState({
        repoRoot,
        detectionSource: preflightFixture.preflight.detection_source || 'explicit_changed_files',
        includeUntracked: preflightFixture.preflight.include_untracked !== false,
        changedFiles,
        metrics
    });
    const reviewContext = {
        schema_version: options.legacyMarkdownArtifact === true ? 2 : 4,
        task_id: taskId,
        review_type: reviewKey,
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: preflightFixture.preflightSha256,
        task_scope: buildManualReviewContextTaskScopeFixture(preflightFixture.preflight),
        scoped_diff: {
            expected: false,
            metadata_path: path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`).replace(/\\/g, '/'),
            metadata: null
        },
        tree_state: reviewTreeState,
        coverage_contract: coverageContract,
        coverage_scope: {
            changed_files: changedFiles,
            changed_file_count: changedFiles.length,
            changed_files_sha256: createHash('sha256').update(changedFiles.join('\n')).digest('hex')
        },
        review_execution: reviewExecution,
        rule_context: {
            artifact_path: promptArtifactPath.replace(/\\/g, '/'),
            preferred_prompt_artifact: promptArtifactPath.replace(/\\/g, '/'),
            artifact_sha256: promptArtifactSha256,
            token_economy_active: false
        },
        reviewer_routing: createReviewerRoutingFixture(reviewerEvidence.sourceOfTruth, {
            ...reviewerEvidence.routingOverrides
        })
    };
    return {
        reviewContext,
        reviewContextText: JSON.stringify(reviewContext, null, 2)
    };
}

function resolveFixtureReviewTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    const treeStateSha256 = String(treeState?.tree_state_sha256 || '').trim().toLowerCase();
    return treeStateSha256 || null;
}

export function appendPreflightClassifiedEvent(repoRoot: string, taskId: string, preflightPath: string): void {
    const normalizedPreflightPath = preflightPath.replace(/\\/g, '/');
    const existingEvents = readTaskTimelineEvents(repoRoot, taskId);
    const latestMatchingEvent = [...existingEvents].reverse().find((event) => (
        event.event_type === 'PREFLIGHT_CLASSIFIED'
        && String((event.details as Record<string, unknown> | undefined)?.output_path || '') === normalizedPreflightPath
    ));
    if (latestMatchingEvent) {
        return;
    }

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const mode = String(preflight.mode || 'FULL_PATH');
    const changedFilesCount = Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0;
    const changedLinesTotal = Number(metrics.changed_lines_total || 0);
    const zeroDiffGuard = preflight.zero_diff_guard && typeof preflight.zero_diff_guard === 'object' && !Array.isArray(preflight.zero_diff_guard)
        ? preflight.zero_diff_guard
        : (changedFilesCount === 0 && changedLinesTotal === 0
            ? {zero_diff_detected: true, status: 'BASELINE_ONLY'}
            : null);
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'PREFLIGHT_CLASSIFIED',
        'INFO',
        zeroDiffGuard
            ? `Preflight completed with mode ${mode} (zero-diff baseline only).`
            : `Preflight completed with mode ${mode}.`,
        {
            mode,
            output_path: normalizedPreflightPath,
            changed_files_count: changedFilesCount,
            changed_lines_total: changedLinesTotal,
            required_reviews: preflight.required_reviews || {},
            zero_diff_guard: zeroDiffGuard
        }
    );
}

export function writeCompilePassEvidence(repoRoot: string, taskId: string, preflightPath: string): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const crypto = require('node:crypto');
    prepareReviewDiffFixture(repoRoot, preflightPath);
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const preflight = JSON.parse(preflightText) as Record<string, unknown>;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const detectionSource = String(preflight.detection_source || 'explicit_changed_files').trim() || 'explicit_changed_files';
    const includeUntracked = preflight.include_untracked !== false;
    const workspaceSnapshot = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, changedFiles);
    const preflightHashSha256 = crypto.createHash('sha256').update(preflightText).digest('hex');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-compile-gate.json`), JSON.stringify({
        task_id: taskId,
        event_source: 'compile-gate',
        status: 'PASSED',
        outcome: 'PASS',
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: preflightHashSha256,
        scope_detection_source: detectionSource,
        scope_include_untracked: includeUntracked,
        scope_changed_files: workspaceSnapshot.changed_files,
        scope_changed_files_count: workspaceSnapshot.changed_files_count,
        scope_changed_lines_total: workspaceSnapshot.changed_lines_total,
        scope_changed_files_sha256: workspaceSnapshot.changed_files_sha256,
        scope_content_sha256: workspaceSnapshot.scope_content_sha256,
        scope_sha256: workspaceSnapshot.scope_sha256
    }, null, 2), 'utf8');
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Compile gate passed.', {
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: preflightHashSha256
    });
}

function prepareScopedDiffFixture(repoRoot: string, preflightPath: string, reviewType: string): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const scopedDiffExpected = buildReviewContextPreflightDiffExpectations(preflight, reviewType).expectedScopedDiff;
    if (!scopedDiffExpected) {
        return;
    }
    const pathsConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
    if (!fs.existsSync(pathsConfigPath) || !fs.statSync(pathsConfigPath).isFile()) {
        return;
    }
    prepareReviewDiffFixture(repoRoot, preflightPath);
    const reviewsRoot = getReviewsRoot(repoRoot);
    buildScopedDiff({
        reviewType,
        preflightPath,
        pathsConfigPath,
        outputPath: path.join(reviewsRoot, `${preflight.task_id}-${reviewType}-scoped.diff`),
        metadataPath: path.join(reviewsRoot, `${preflight.task_id}-${reviewType}-scoped.json`),
        repoRoot
    });
}

function readSeededSourceOfTruth(repoRoot: string): string {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return 'Codex';
    }
    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        return typeof payload.SourceOfTruth === 'string' && payload.SourceOfTruth.trim()
            ? payload.SourceOfTruth.trim()
            : 'Codex';
    } catch {
        return 'Codex';
    }
}

function resolveDefaultReviewerEvidence(repoRoot: string, _taskId: string, reviewKey: string): {
    sourceOfTruth: string;
    executionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason: null;
    routingOverrides: Record<string, unknown>;
} {
    const sourceOfTruth = readSeededSourceOfTruth(repoRoot);
    const policy = resolveReviewerRoutingPolicy(sourceOfTruth, 'provider_entrypoint');
    const executionMode = 'delegated_subagent';
    const delegatedReviewerIdentity = reviewKey === 'code'
        ? 'agent:code-reviewer'
        : reviewKey === 'test'
            ? 'agent:test-reviewer'
            : `agent:${reviewKey}-reviewer`;
    const reviewerIdentity = delegatedReviewerIdentity;
    const reviewerFallbackReason = null;
    return {
        sourceOfTruth,
        executionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        routingOverrides: {
            execution_provider_source: 'provider_entrypoint',
            delegation_required: policy.delegation_required,
            expected_execution_mode: policy.expected_execution_mode,
            fallback_allowed: policy.fallback_allowed,
            fallback_reason_required: policy.fallback_reason_required,
            actual_execution_mode: executionMode,
            reviewer_session_id: reviewerIdentity,
            fallback_reason: reviewerFallbackReason
        }
    };
}

function sha256JsonFixture(value: unknown): string {
    return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function attachFixtureFindingsDispositionEvidence(options: {
    receipt: Record<string, unknown>;
    artifactPath: string;
    taskId: string;
    reviewType: string;
    validationArtifact: ReviewFindingsValidationArtifact;
    validationArtifactPath: string;
    validationArtifactSha256: string;
    preflight: Record<string, unknown> | null;
}): { artifactSha256: string | null; resultSha256: string | null } {
    if (!options.validationArtifact.validation_result.accepted) {
        return { artifactSha256: null, resultSha256: null };
    }
    const artifactPath = getReviewFindingsDispositionArtifactPath(options.artifactPath);
    const artifact = buildReviewFindingsDispositionArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validationArtifact: options.validationArtifact,
        validationArtifactPath: options.validationArtifactPath,
        validationArtifactSha256: options.validationArtifactSha256,
        policyResolution: resolveLockedReviewFindingPolicyFromPreflight(options.preflight)
    });
    const artifactSha256 = sha256JsonFixture(artifact);
    const snapshotPath = getReviewFindingsDispositionArtifactSnapshotPath(artifactPath, artifactSha256);
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    fs.writeFileSync(snapshotPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    options.receipt.review_findings_disposition = artifact.disposition_result;
    options.receipt.review_findings_disposition_artifact = {
        artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
        artifact_sha256: artifactSha256,
        snapshot_path: path.normalize(snapshotPath).replace(/\\/g, '/'),
        snapshot_sha256: artifactSha256,
        disposition_result_sha256: artifact.disposition_result_sha256,
        policy_id: artifact.policy.policy_id,
        policy_source: artifact.policy.policy_source,
        item_count: artifact.summary.item_count,
        fix_now_count: artifact.summary.fix_now_count,
        follow_up_pending_count: artifact.summary.follow_up_pending_count,
        ignored_count: artifact.summary.ignored_count,
        blocking_count: artifact.summary.blocking_count
    };
    return {
        artifactSha256,
        resultSha256: artifact.disposition_result_sha256
    };
}

function resolveFixtureReviewExecution(reviewContext: Record<string, unknown>): {
    contract: ReviewRemediationReviewContract;
    declaration: ReviewerRemediationCoverageDeclaration;
} {
    const contract = reviewContext.review_execution as ReviewRemediationReviewContract | undefined;
    assert.ok(contract, 'Fixture review context is missing review_execution.');
    return {
        contract,
        declaration: {
            mode: contract.mode,
            contract_sha256: contract.contract_sha256,
            covered_delta_targets: contract.delta?.required_delta_targets || [],
            inspected_prior_finding_ids: contract.finding_reconciliation.resolvable_finding_ids
        }
    };
}

function resolveFixtureReviewExecutionBindings(
    contract: ReviewRemediationReviewContract
): ReviewExecutionEvidenceBindings {
    return {
        review_execution_mode: contract.mode,
        review_execution_contract_sha256: contract.contract_sha256,
        review_execution_full_scope_sha256: contract.full_review_scope_sha256,
        review_execution_complete_scope_lineage_sha256: contract.complete_scope_lineage_sha256,
        review_execution_finding_reconciliation_sha256:
            sha256RedactedJsonPayload(contract.finding_reconciliation)
    };
}

function buildFixtureFindingsReport(options: {
    taskId: string;
    reviewKey: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string | null;
    coverageContract: ReviewCoverageContract;
    reviewExecution: ReviewerRemediationCoverageDeclaration;
    findingSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
    findingDescription?: string;
    residualRisk?: boolean;
}): Record<string, unknown> {
    const defaultEvidenceFile = options.coverageContract.obligations.find((entry) => entry.kind === 'file')?.target
        || 'src/app.ts';
    const findingId = 'F-001';
    const finding = {
        id: findingId,
        title: 'Fixture active finding',
        description: options.findingDescription
            || 'Seeded failed-review fixture finding for downstream gate behavior.',
        evidence: [{
            location: `${defaultEvidenceFile}:1`,
            observation: 'The fixture intentionally records an active finding.'
        }],
        coverage_obligation_ids: options.coverageContract.obligations.map((obligation) => obligation.id)
    };
    const findingIds = options.findingSeverity ? [findingId] : [];
    const residualRisk = {
        id: 'R-001',
        description: 'Seeded residual-risk fixture for downstream gate behavior.',
        evidence: [{
            location: `${defaultEvidenceFile}:1`,
            observation: 'The fixture intentionally records a residual risk.'
        }]
    };
    return {
        schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
        task_id: options.taskId,
        review_type: options.reviewKey,
        review_context_sha256: options.reviewContextSha256,
        tree_state_sha256: options.reviewTreeStateSha256,
        validation_notes: [{
            id: 'N-001',
            topic: 'fixture-scope',
            note: `Validated the complete ${options.reviewKey} fixture scope and every generated coverage obligation.`,
            evidence: [{
                location: `${defaultEvidenceFile}:1`,
                observation: `Concrete fixture evidence covers the ${options.reviewKey} review scope.`
            }]
        }],
        coverage_ledger: {
            coverage_contract_sha256: options.coverageContract.contract_sha256,
            entries: options.coverageContract.required
                ? options.coverageContract.obligations.map((obligation) => ({
                    obligation_id: obligation.id,
                    evidence: [{
                        location: `${obligation.kind === 'file' ? obligation.target : defaultEvidenceFile}:1`,
                        observation: `Concrete fixture evidence covers ${obligation.kind} ${obligation.target} for receipt-backed review behavior.`
                    }],
                    finding_ids: findingIds
                }))
                : []
        },
        review_execution: options.reviewExecution,
        findings: {
            critical: options.findingSeverity === 'critical' ? [finding] : [],
            high: options.findingSeverity === 'high' ? [finding] : [],
            medium: options.findingSeverity === 'medium' ? [finding] : [],
            low: options.findingSeverity === 'low' ? [finding] : []
        },
        residual_risks: options.residualRisk ? [residualRisk] : [],
        reviewer_notes: []
    };
}

function buildFixtureFindingsContent(options: {
    taskId: string;
    reviewKey: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string | null;
    coverageContract: ReviewCoverageContract;
    reviewExecution: ReviewerRemediationCoverageDeclaration;
    verdict: string;
    findingDescription?: string;
    findingSeverity?: 'critical' | 'high' | 'medium' | 'low' | null;
    residualRisk?: boolean;
}): string {
    const report = buildFixtureFindingsReport({
        taskId: options.taskId,
        reviewKey: options.reviewKey,
        reviewContextSha256: options.reviewContextSha256,
        reviewTreeStateSha256: options.reviewTreeStateSha256,
        coverageContract: options.coverageContract,
        reviewExecution: options.reviewExecution,
        findingDescription: options.findingDescription,
        findingSeverity: options.findingSeverity === undefined
            ? (/\bFAILED\b/u.test(options.verdict) ? 'high' : null)
            : options.findingSeverity,
        residualRisk: options.residualRisk
    });
    return `${JSON.stringify(report, null, 2)}\n`;
}

export function writePassingReviewOutputFromContext(options: {
    taskId: string;
    reviewType: string;
    reviewContextPath: string;
    outputPath: string;
}): void {
    const reviewContextText = fs.readFileSync(options.reviewContextPath, 'utf8');
    const reviewContext = JSON.parse(reviewContextText) as Record<string, unknown>;
    const coverageContract = reviewContext.coverage_contract as ReviewCoverageContract | undefined;
    const treeState = reviewContext.tree_state as Record<string, unknown> | undefined;
    const reviewTreeStateSha256 = String(
        treeState?.tree_state_sha256
        || treeState?.treeStateSha256
        || ''
    ).trim() || null;
    assert.ok(coverageContract, `Missing coverage_contract in ${options.reviewContextPath}`);
    assert.ok(reviewTreeStateSha256, `Missing tree_state_sha256 in ${options.reviewContextPath}`);
    const reviewExecution = resolveFixtureReviewExecution(reviewContext);
    fs.writeFileSync(options.outputPath, buildFixtureFindingsContent({
        taskId: options.taskId,
        reviewKey: options.reviewType,
        reviewContextSha256: createHash('sha256').update(reviewContextText, 'utf8').digest('hex'),
        reviewTreeStateSha256,
        coverageContract,
        reviewExecution: reviewExecution.declaration,
        verdict: 'REVIEW PASSED'
    }), 'utf8');
}

export function writeReceiptBackedReviewArtifact(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    verdict: string,
    contentLines?: string[],
    options: {
        allowLegacyManualReviewContext?: boolean;
        findingSeverity?: 'critical' | 'high' | 'medium' | 'low' | null;
        legacyMarkdownArtifact?: boolean;
        preserveExistingReviewContext?: boolean;
        rawArtifactContent?: boolean;
        residualRisk?: boolean;
    } = {}
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, {recursive: true});
    const reviewerEvidence = resolveDefaultReviewerEvidence(repoRoot, taskId, reviewKey);
    const explicitContent = contentLines ? contentLines.join('\n') : null;
    let content = explicitContent || [
        '# Review',
        '',
        `Verified changes in \`src/app.ts\`. This review artifact content has been extended with more words to ensure it strictly passes the newly introduced triviality check, which demands at least thirty words if there are no meaningful findings or risks.`,
        '',
        verdict,
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        verdict
    ].join('\n');
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewKey}.md`);
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-review-context.json`);
    const existingReviewContextText = options.preserveExistingReviewContext === true
        ? fs.readFileSync(reviewContextPath, 'utf8')
        : null;
    const {
        reviewContext,
        reviewContextText
    } = existingReviewContextText === null
        ? buildReceiptBackedReviewContextFixture(repoRoot, taskId, reviewKey, reviewerEvidence, options)
        : {
            reviewContext: JSON.parse(existingReviewContextText) as Record<string, unknown>,
            reviewContextText: existingReviewContextText
        };
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');
    const coverageContract = reviewContext.coverage_contract as ReviewCoverageContract;
    const reviewExecution = resolveFixtureReviewExecution(reviewContext);
    const launchReviewExecutionBindings = resolveFixtureReviewExecutionBindings(reviewExecution.contract);

    const crypto = require('node:crypto');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const reviewTreeStateSha256 = resolveFixtureReviewTreeStateSha256(reviewContext);
    if (Number(reviewContext.schema_version) >= 3 && options.rawArtifactContent !== true) {
        content = buildFixtureFindingsContent({
            taskId,
            reviewKey,
            reviewContextSha256: reviewContextHash,
            reviewTreeStateSha256,
            coverageContract,
            reviewExecution: reviewExecution.declaration,
            verdict,
            findingDescription: explicitContent || undefined,
            findingSeverity: options.findingSeverity,
            residualRisk: options.residualRisk
        });
    }
    fs.writeFileSync(artifactPath, content, 'utf8');
    const artifactHash = crypto.createHash('sha256').update(content).digest('hex');

    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'review started', {
        review_type: reviewKey
    });
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', {skill_id: skillId});
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {reference_path: `/live/skills/${skillId}/SKILL.md`});
    const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
        review_type: reviewKey,
        reviewer_execution_mode: reviewerEvidence.executionMode,
        reviewer_session_id: reviewerEvidence.reviewerIdentity,
        reviewer_fallback_reason: reviewerEvidence.reviewerFallbackReason,
        delegation_used: reviewerEvidence.executionMode === 'delegated_subagent',
        ...launchReviewExecutionBindings
    }, {passThru: true});
    const launchEvidence = seedCompletedReviewerLaunchFixture({
        repoRoot,
        taskId,
        reviewKey,
        reviewerIdentity: reviewerEvidence.reviewerIdentity,
        reviewContextSha256: reviewContextHash,
        routingEventSha256: String(routedEvent?.integrity?.event_sha256 || '').trim(),
        reviewExecutionBindings: launchReviewExecutionBindings
    });
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    let preflightSha256: string | null = null;
    let scopeSha256: string | null = null;
    let reviewScopeSha256: string | null = null;
    let codeScopeSha256: string | null = null;
    let reviewContextReuseSha256: string | null = null;
    let preflightPayload: Record<string, unknown> | null = null;
    if (fs.existsSync(preflightPath) && fs.statSync(preflightPath).isFile()) {
        const preflightText = fs.readFileSync(preflightPath, 'utf8');
        const preflight = JSON.parse(preflightText) as Record<string, unknown>;
        preflightPayload = preflight;
        preflightSha256 = crypto.createHash('sha256').update(preflightText).digest('hex');
        scopeSha256 = String(
            (preflight.metrics as Record<string, unknown> | undefined)?.scope_sha256
            || (preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256
            || ''
        ).trim() || null;
        reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256;
        codeScopeSha256 = reviewKey !== 'test'
            ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
            : null;
        reviewContextReuseSha256 = computeReviewContextReuseHash(reviewContext);
    }
    const invocationDetails = {
        task_id: taskId,
        review_type: reviewKey,
        reviewer_execution_mode: reviewerEvidence.executionMode,
        reviewer_session_id: reviewerEvidence.reviewerIdentity,
        reviewer_identity: reviewerEvidence.reviewerIdentity,
        review_context_sha256: reviewContextHash,
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routedEvent?.integrity?.event_sha256,
        reviewer_launch_artifact_path: path.normalize(launchEvidence.launchArtifactPath).replace(/\\/g, '/'),
        reviewer_launch_artifact_sha256: launchEvidence.launchArtifactSha256,
        reviewer_launch_attestation_source: launchEvidence.attestationSource,
        reviewer_launch_tool: launchEvidence.launchTool,
        provider_invocation_id: launchEvidence.providerInvocationId,
        launch_prepared_at_utc: TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
        delegation_started_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launched_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launch_completed_at_utc: TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
        launch_input_mode: launchEvidence.launchInputMode,
        launch_input_sha256: launchEvidence.launchInputSha256,
        copy_paste_reviewer_launch_prompt_sha256: launchEvidence.copyPastePromptSha256,
        invocation_attested_at_utc: TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC,
        ...launchReviewExecutionBindings
    };
    const invocationEvent = appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEWER_INVOCATION_ATTESTED',
        'INFO',
        'reviewer invocation attested',
        invocationDetails,
        {passThru: true}
    );
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        'REVIEWER_INVOCATION_ATTESTED',
        invocationEvent?.integrity,
        invocationDetails
    );

    const reviewContextContractBindings = resolveReviewContextReuseContractBindings(reviewContext);
    const reviewExecutionEvidence = resolveReviewContextExecutionEvidenceBindings(reviewContext);
    if (Number(reviewContext.schema_version) >= 4) {
        assert.ok(reviewExecutionEvidence.bindings, reviewExecutionEvidence.violations.join('\n'));
    }
    const reviewExecutionBindings = reviewExecutionEvidence.bindings || launchReviewExecutionBindings;
    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256,
        scopeSha256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewContextSha256: reviewContextHash,
        reviewTreeStateSha256,
        reviewExecutionMode: reviewExecutionBindings.review_execution_mode,
        reviewExecutionContractSha256: reviewExecutionBindings.review_execution_contract_sha256,
        reviewExecutionFullScopeSha256: reviewExecutionBindings.review_execution_full_scope_sha256,
        reviewExecutionCompleteScopeLineageSha256:
            reviewExecutionBindings.review_execution_complete_scope_lineage_sha256,
        reviewExecutionFindingReconciliationSha256:
            reviewExecutionBindings.review_execution_finding_reconciliation_sha256,
        reviewContextReuseSha256,
        reviewCoverageContractSha256: reviewContextContractBindings.coverageContractSha256,
        reviewRuleContextSha256: reviewContextContractBindings.ruleContextSha256,
        reviewArtifactSha256: artifactHash,
        reviewerExecutionMode: reviewerEvidence.executionMode,
        reviewerIdentity: reviewerEvidence.reviewerIdentity,
        reviewerFallbackReason: reviewerEvidence.reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: 'INDEPENDENT_AUDITED'
    });
    const receiptRecord = receipt as unknown as Record<string, unknown>;
    if (Number(reviewContext.schema_version) >= 3) {
        const findingsValidation = validateReviewFindingsContract({
            content,
            expectedTaskId: taskId,
            expectedReviewType: reviewKey,
            expectedReviewContextSha256: reviewContextHash,
            expectedTreeStateSha256: reviewTreeStateSha256 || undefined,
            coverageContract,
            expectedReviewExecutionContract: reviewExecution.contract,
            repoRoot
        });
        if (!explicitContent) {
            assert.equal(findingsValidation.valid, true, findingsValidation.violations.join('\n'));
        }
        const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
        const validationArtifact = buildReviewFindingsValidationArtifact({
            taskId,
            reviewType: reviewKey,
            validation: findingsValidation,
            reviewOutputSha256: artifactHash,
            reviewArtifactPath: artifactPath,
            reviewArtifactSha256: artifactHash,
            reviewContextPath,
            reviewContextSha256: reviewContextHash,
            preflightPath,
            preflightSha256,
            scopeSha256,
            reviewScopeSha256,
            codeScopeSha256,
            reviewTreeStateSha256,
            coverageContract
        });
        const validationArtifactSha256 = sha256JsonFixture(validationArtifact);
        const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
            validationArtifactPath,
            validationArtifactSha256
        );
        fs.writeFileSync(validationArtifactPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
        fs.writeFileSync(validationArtifactSnapshotPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
        receiptRecord.review_coverage = findingsValidation.coverage_validation;
        receiptRecord.review_output_format = 'findings_json';
        receiptRecord.review_output_schema_version = findingsValidation.report?.schema_version ?? null;
        receiptRecord.review_findings_report_sha256 = findingsValidation.report
            ? sha256JsonFixture(findingsValidation.report)
            : null;
        if (findingsValidation.report) {
            receiptRecord.review_findings_report = findingsValidation.report;
        }
        receiptRecord.review_findings_validation = {
            artifact_path: path.normalize(validationArtifactPath).replace(/\\/g, '/'),
            artifact_sha256: validationArtifactSha256,
            snapshot_path: path.normalize(validationArtifactSnapshotPath).replace(/\\/g, '/'),
            snapshot_sha256: validationArtifactSha256,
            status: validationArtifact.validation_result.status,
            accepted: validationArtifact.validation_result.accepted,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            violation_count: validationArtifact.validation_result.violations.length
        };
        const dispositionEvidence = attachFixtureFindingsDispositionEvidence({
            receipt: receiptRecord,
            artifactPath,
            taskId,
            reviewType: reviewKey,
            validationArtifact,
            validationArtifactPath,
            validationArtifactSha256,
            preflight: preflightPayload
        });
        receiptRecord.review_output_contract = {
            schema_version: 1,
            format: 'findings_json',
            report_sha256: findingsValidation.report ? sha256JsonFixture(findingsValidation.report) : null,
            validation_artifact_sha256: validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            disposition_artifact_sha256: dispositionEvidence.artifactSha256,
            disposition_result_sha256: dispositionEvidence.resultSha256,
            raw_output_sha256: artifactHash,
            review_artifact_sha256: artifactHash,
            review_context_sha256: reviewContextHash,
            review_tree_state_sha256: reviewTreeStateSha256,
            ...reviewExecutionBindings,
            coverage_contract_sha256: coverageContract.contract_sha256,
            reviewer_identity: reviewerEvidence.reviewerIdentity,
            reviewer_provenance_event_sha256: reviewerProvenance?.event_sha256 ?? null
        };
    }
    receiptRecord.review_result_recorded_at_utc = receipt.recorded_at_utc;
    receiptRecord.review_output_source_mtime_utc = fs.statSync(artifactPath).mtime.toISOString();
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptPayload = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptPayloadSha256 = crypto.createHash('sha256').update(receiptPayload).digest('hex');
    const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(receiptPath, receiptPayload, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptPayload, 'utf8');
    fs.writeFileSync(artifactSnapshotPath, content, 'utf8');

    const reviewOutcome = /\bFAILED\b/u.test(verdict) ? 'FAIL' : 'PASS';
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', reviewOutcome, 'recorded', {
        ...receipt,
        receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
        receipt_sha256: receiptPayloadSha256,
        receipt_snapshot_path: path.normalize(receiptSnapshotPath).replace(/\\/g, '/'),
        receipt_snapshot_sha256: receiptPayloadSha256,
        review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
        review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
        review_artifact_snapshot_sha256: artifactHash,
        review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
    });
}

export function writeCleanReviewArtifact(repoRoot: string, taskId: string, reviewKey: string, verdict: string): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, reviewKey, verdict);
}

export function seedReusableReviewEvidence(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    verdict: string,
    preflightPath: string,
    reviewContextPath: string,
    reviewerIdentity = 'agent:test-reviewer',
    options: {
        legacyReviewContextIdentity?: boolean;
        legacyReviewContextSourceOfTruth?: string;
        taskModePath?: string | null;
        omitInvocationTreeState?: boolean;
        receiptReviewContextSha256Override?: string | null;
        reviewCoverageContractSha256Override?: string | null;
        reviewRuleContextSha256Override?: string | null;
        omitReviewRuleContextBinding?: boolean;
        omitReviewFindingsValidationExecutionBinding?: boolean;
        omitReceiptExecutionBindings?: boolean;
        reviewFindingsValidationExecutionBindingOverrides?: Partial<ReviewExecutionEvidenceBindings>;
        reviewContextSchemaVersion?: 3 | 4;
        sourceOfTruth?: string;
        invocationTimingOverride?: {
            launchPreparedAtUtc?: string;
            delegationStartedAtUtc?: string;
            launchedAtUtc?: string;
            launchCompletedAtUtc?: string;
            invocationAttestedAtUtc?: string;
        };
    } = {}
): string {
    const crypto = require('node:crypto');
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, {recursive: true});
    const sourceOfTruth = options.sourceOfTruth || readSeededSourceOfTruth(repoRoot);
    const execution = resolveReviewerExecutionFixture(taskId, sourceOfTruth, reviewerIdentity);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewKey}.md`);
    const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`);
    let artifactText = '';
    bindFixtureEffectiveReviewSnapshot(repoRoot, taskId, reviewKey, preflightPath, options.taskModePath || '');
    prepareReviewDiffFixture(repoRoot, preflightPath);
    prepareScopedDiffFixture(repoRoot, preflightPath, reviewKey);
    buildReviewContext({
        reviewType: reviewKey,
        depth: 2,
        preflightPath,
        taskModePath: options.taskModePath || '',
        tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
        scopedDiffMetadataPath,
        outputPath: reviewContextPath,
        repoRoot
    });
    const executionMode = execution.reviewerExecutionMode;
    const resolvedReviewerIdentity = execution.reviewerIdentity;
    const reviewerFallbackReason = execution.reviewerFallbackReason;
    applyReviewerRoutingMetadata(reviewContextPath, {
        actualExecutionMode: executionMode,
        reviewerSessionId: resolvedReviewerIdentity,
        fallbackReason: reviewerFallbackReason
    });
    if (options.legacyReviewContextIdentity || options.reviewContextSchemaVersion !== undefined) {
        const legacyReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = legacyReviewContext.reviewer_routing
        && typeof legacyReviewContext.reviewer_routing === 'object'
        && !Array.isArray(legacyReviewContext.reviewer_routing)
            ? legacyReviewContext.reviewer_routing as Record<string, unknown>
            : {};
        if (options.reviewContextSchemaVersion !== undefined) {
            legacyReviewContext.schema_version = options.reviewContextSchemaVersion;
        }
        if (options.legacyReviewContextSourceOfTruth) {
            reviewerRouting.source_of_truth = options.legacyReviewContextSourceOfTruth;
        }
        if (options.legacyReviewContextIdentity) {
            delete reviewerRouting.canonical_source_of_truth;
            delete reviewerRouting.execution_provider;
            delete reviewerRouting.execution_provider_source;
            delete reviewerRouting.identity_status;
        }
        legacyReviewContext.reviewer_routing = reviewerRouting;
        fs.writeFileSync(reviewContextPath, JSON.stringify(legacyReviewContext, null, 2) + '\n', 'utf8');
    }
    const reviewContextText = fs.readFileSync(reviewContextPath, 'utf8');
    const reviewContext = JSON.parse(reviewContextText) as Record<string, unknown>;
    const coverageContract = reviewContext.coverage_contract as ReviewCoverageContract;
    const reviewExecution = resolveFixtureReviewExecution(reviewContext);
    const launchReviewExecutionBindings = resolveFixtureReviewExecutionBindings(reviewExecution.contract);
    const reviewTreeStateSha256 = resolveFixtureReviewTreeStateSha256(reviewContext);
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    artifactText = Number(reviewContext.schema_version) >= 3
        ? buildFixtureFindingsContent({
            taskId,
            reviewKey,
            reviewContextSha256: reviewContextHash,
            reviewTreeStateSha256,
            coverageContract,
            reviewExecution: reviewExecution.declaration,
            verdict
        })
        : [
            '# Review',
            '',
            '## Validation Notes',
            `Validated the complete ${reviewKey} reuse scope and every generated coverage obligation.`,
            '',
            '## Findings by Severity',
            'None',
            '',
            '## Deferred Findings',
            'None',
            '',
            '## Residual Risks',
            'None',
            '',
            '## Verdict',
            verdict
        ].join('\n');
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactHash = crypto.createHash('sha256').update(artifactText).digest('hex');
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const preflight = JSON.parse(preflightText) as Record<string, unknown>;
    const preflightHash = crypto.createHash('sha256').update(preflightText).digest('hex');
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'historical review started', {
        review_type: reviewKey
    });
    const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', {skill_id: skillId});
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {reference_path: `/live/skills/${skillId}/SKILL.md`});
    const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'reusable review routing recorded', {
        review_type: reviewKey,
        reviewer_execution_mode: executionMode,
        reviewer_session_id: resolvedReviewerIdentity,
        reviewer_fallback_reason: reviewerFallbackReason,
        delegation_used: true,
        ...launchReviewExecutionBindings
    }, {passThru: true});
    const launchEvidence = seedCompletedReviewerLaunchFixture({
        repoRoot,
        taskId,
        reviewKey,
        reviewerIdentity: resolvedReviewerIdentity,
        reviewContextSha256: reviewContextHash,
        routingEventSha256: String(routedEvent?.integrity?.event_sha256 || '').trim(),
        reviewExecutionBindings: launchReviewExecutionBindings
    });
    const invocationDetails: Record<string, unknown> = {
        task_id: taskId,
        review_type: reviewKey,
        reviewer_execution_mode: executionMode,
        reviewer_session_id: resolvedReviewerIdentity,
        reviewer_identity: resolvedReviewerIdentity,
        review_context_sha256: reviewContextHash,
        routing_event_sha256: routedEvent?.integrity?.event_sha256,
        reviewer_launch_artifact_path: path.normalize(launchEvidence.launchArtifactPath).replace(/\\/g, '/'),
        reviewer_launch_artifact_sha256: launchEvidence.launchArtifactSha256,
        reviewer_launch_attestation_source: launchEvidence.attestationSource,
        reviewer_launch_tool: launchEvidence.launchTool,
        provider_invocation_id: launchEvidence.providerInvocationId,
        launch_prepared_at_utc: options.invocationTimingOverride?.launchPreparedAtUtc ?? TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
        delegation_started_at_utc: options.invocationTimingOverride?.delegationStartedAtUtc ?? TEST_REVIEW_LAUNCHED_AT_UTC,
        launched_at_utc: options.invocationTimingOverride?.launchedAtUtc ?? TEST_REVIEW_LAUNCHED_AT_UTC,
        launch_completed_at_utc: options.invocationTimingOverride?.launchCompletedAtUtc ?? TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
        launch_input_mode: launchEvidence.launchInputMode,
        launch_input_sha256: launchEvidence.launchInputSha256,
        copy_paste_reviewer_launch_prompt_sha256: launchEvidence.copyPastePromptSha256,
        invocation_attested_at_utc: options.invocationTimingOverride?.invocationAttestedAtUtc ?? TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC,
        ...launchReviewExecutionBindings
    };
    if (!options.omitInvocationTreeState) {
        invocationDetails.review_tree_state_sha256 = reviewTreeStateSha256;
    }
    const invocationEvent = appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEWER_INVOCATION_ATTESTED',
        'INFO',
        'reusable reviewer invocation attested',
        invocationDetails,
        {passThru: true}
    );
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        'REVIEWER_INVOCATION_ATTESTED',
        invocationEvent?.integrity,
        invocationDetails
    );
    const receiptReviewContextSha256 = String(options.receiptReviewContextSha256Override || '').trim().toLowerCase() || reviewContextHash;
    const scopeSha256 = String(
        (preflight.metrics as Record<string, unknown> | undefined)?.scope_sha256
        || (preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256
        || ''
    ).trim() || null;
    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256;
    const codeScopeSha256 = reviewKey !== 'test'
        ? computeReviewReuseCodeScopeFingerprint(reviewKey, preflight, repoRoot).code_scope_sha256
        : null;
    const reviewContextContractBindings = resolveReviewContextReuseContractBindings(reviewContext);
    const reviewExecutionEvidence = resolveReviewContextExecutionEvidenceBindings(reviewContext);
    if (reviewExecutionEvidence.required) {
        assert.ok(reviewExecutionEvidence.bindings, reviewExecutionEvidence.violations.join('\n'));
    }
    const reviewExecutionBindings = reviewExecutionEvidence.bindings;
    const reviewCoverageContractSha256 = options.reviewCoverageContractSha256Override !== undefined
        ? options.reviewCoverageContractSha256Override
        : reviewContextContractBindings.coverageContractSha256;
    const reviewRuleContextSha256 = options.omitReviewRuleContextBinding === true
        ? undefined
        : options.reviewRuleContextSha256Override !== undefined
            ? options.reviewRuleContextSha256Override
            : reviewContextContractBindings.ruleContextSha256;
    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256: preflightHash,
        scopeSha256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewContextSha256: receiptReviewContextSha256,
        reviewTreeStateSha256,
        reviewExecutionMode: reviewExecutionBindings?.review_execution_mode,
        reviewExecutionContractSha256: reviewExecutionBindings?.review_execution_contract_sha256,
        reviewExecutionFullScopeSha256: reviewExecutionBindings?.review_execution_full_scope_sha256,
        reviewExecutionCompleteScopeLineageSha256:
            reviewExecutionBindings?.review_execution_complete_scope_lineage_sha256,
        reviewExecutionFindingReconciliationSha256:
            reviewExecutionBindings?.review_execution_finding_reconciliation_sha256,
        reviewContextReuseSha256: computeReviewContextReuseHash(reviewContext),
        reviewCoverageContractSha256,
        reviewRuleContextSha256,
        reviewArtifactSha256: artifactHash,
        reviewerExecutionMode: executionMode,
        reviewerIdentity: resolvedReviewerIdentity,
        reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: execution.trustLevel
    });
    const receiptRecord = receipt as unknown as Record<string, unknown>;
    if (Number(reviewContext.schema_version) >= 3) {
        const findingsValidation = validateReviewFindingsContract({
            content: artifactText,
            expectedTaskId: taskId,
            expectedReviewType: reviewKey,
            expectedReviewContextSha256: reviewContextHash,
            expectedTreeStateSha256: reviewTreeStateSha256 || undefined,
            coverageContract,
            expectedReviewExecutionContract: reviewExecution.contract,
            repoRoot
        });
        assert.equal(findingsValidation.valid, true, findingsValidation.violations.join('\n'));
        const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
        const validationArtifact = buildReviewFindingsValidationArtifact({
            taskId,
            reviewType: reviewKey,
            validation: findingsValidation,
            reviewOutputSha256: artifactHash,
            reviewArtifactPath: artifactPath,
            reviewArtifactSha256: artifactHash,
            reviewContextPath,
            reviewContextSha256: reviewContextHash,
            preflightPath,
            preflightSha256: preflightHash,
            scopeSha256,
            reviewScopeSha256,
            codeScopeSha256,
            reviewTreeStateSha256,
            coverageContract
        });
        let validationResultMutated = false;
        if (options.omitReviewFindingsValidationExecutionBinding === true) {
            delete validationArtifact.validation_result.bindings.execution;
            validationResultMutated = true;
        }
        if (options.reviewFindingsValidationExecutionBindingOverrides !== undefined) {
            const validationExecution = validationArtifact.validation_result.bindings.execution;
            assert.ok(validationExecution, 'Fixture execution binding overrides require schema-4 execution evidence.');
            Object.assign(validationExecution, options.reviewFindingsValidationExecutionBindingOverrides);
            validationResultMutated = true;
        }
        if (validationResultMutated) {
            validationArtifact.validation_result_sha256 = sha256JsonFixture(validationArtifact.validation_result);
        }
        const validationArtifactSha256 = sha256JsonFixture(validationArtifact);
        const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
            validationArtifactPath,
            validationArtifactSha256
        );
        fs.writeFileSync(validationArtifactPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
        fs.writeFileSync(validationArtifactSnapshotPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
        receiptRecord.review_coverage = findingsValidation.coverage_validation;
        receiptRecord.review_output_format = 'findings_json';
        receiptRecord.review_output_schema_version = findingsValidation.report?.schema_version ?? null;
        receiptRecord.review_findings_report_sha256 = findingsValidation.report
            ? sha256JsonFixture(findingsValidation.report)
            : null;
        if (findingsValidation.report) {
            receiptRecord.review_findings_report = findingsValidation.report;
        }
        receiptRecord.review_findings_validation = {
            artifact_path: path.normalize(validationArtifactPath).replace(/\\/g, '/'),
            artifact_sha256: validationArtifactSha256,
            snapshot_path: path.normalize(validationArtifactSnapshotPath).replace(/\\/g, '/'),
            snapshot_sha256: validationArtifactSha256,
            status: validationArtifact.validation_result.status,
            accepted: validationArtifact.validation_result.accepted,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            violation_count: validationArtifact.validation_result.violations.length
        };
        const dispositionEvidence = attachFixtureFindingsDispositionEvidence({
            receipt: receiptRecord,
            artifactPath,
            taskId,
            reviewType: reviewKey,
            validationArtifact,
            validationArtifactPath,
            validationArtifactSha256,
            preflight
        });
        receiptRecord.review_output_contract = {
            schema_version: 1,
            format: 'findings_json',
            report_sha256: findingsValidation.report ? sha256JsonFixture(findingsValidation.report) : null,
            validation_artifact_sha256: validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            disposition_artifact_sha256: dispositionEvidence.artifactSha256,
            disposition_result_sha256: dispositionEvidence.resultSha256,
            raw_output_sha256: artifactHash,
            review_artifact_sha256: artifactHash,
            review_context_sha256: reviewContextHash,
            review_tree_state_sha256: reviewTreeStateSha256,
            ...(reviewExecutionBindings || {}),
            coverage_contract_sha256: coverageContract.contract_sha256,
            reviewer_identity: resolvedReviewerIdentity,
            reviewer_provenance_event_sha256: reviewerProvenance?.event_sha256 ?? null
        };
        if (options.omitReceiptExecutionBindings === true) {
            for (const field of [
                'review_execution_mode',
                'review_execution_contract_sha256',
                'review_execution_full_scope_sha256',
                'review_execution_complete_scope_lineage_sha256',
                'review_execution_finding_reconciliation_sha256'
            ]) {
                delete receiptRecord[field];
                delete (receiptRecord.review_output_contract as Record<string, unknown>)[field];
            }
        }
    }
    receiptRecord.review_result_recorded_at_utc = receipt.recorded_at_utc;
    receiptRecord.review_output_source_mtime_utc = fs.statSync(artifactPath).mtime.toISOString();
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptPayload = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptPayloadSha256 = crypto.createHash('sha256').update(receiptPayload).digest('hex');
    const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(receiptPath, receiptPayload, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptPayload, 'utf8');
    fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'reusable review recorded', {
        ...receipt,
        receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
        receipt_sha256: receiptPayloadSha256,
        receipt_snapshot_path: path.normalize(receiptSnapshotPath).replace(/\\/g, '/'),
        receipt_snapshot_sha256: receiptPayloadSha256,
        review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
        review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
        review_artifact_snapshot_sha256: artifactHash,
        review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
    });
    return reviewContextPath;
}

export function bindFixtureEffectiveReviewSnapshot(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    preflightPath: string,
    taskModePath: string,
    options: { ensureSkillEntrypoints?: boolean } = {}
): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, any>;
    if (preflight.effective_review_snapshot) {
        ensureFixtureReviewSkillEntrypoints(
            getOrchestratorRoot(repoRoot),
            preflight.effective_review_snapshot,
            reviewKey
        );
        return;
    }
    const resolvedTaskModePath = taskModePath || path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    const taskMode = fs.existsSync(resolvedTaskModePath)
        ? JSON.parse(fs.readFileSync(resolvedTaskModePath, 'utf8')) as Record<string, unknown>
        : {};
    const profileSnapshotCandidate = taskMode.profile_policy_snapshot || preflight.profile_policy_snapshot;
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const catalog = readReviewCatalogConfigFile(path.join(orchestratorRoot, 'live', 'config', 'review-catalog.json'));
    const hasLockedProfileSnapshot = Boolean(
        profileSnapshotCandidate
        && typeof profileSnapshotCandidate === 'object'
        && typeof (profileSnapshotCandidate as Record<string, unknown>).snapshot_hash === 'string'
        && typeof (profileSnapshotCandidate as Record<string, unknown>).source === 'object'
        && typeof (profileSnapshotCandidate as Record<string, unknown>).review_lane_selection === 'object'
        && typeof (profileSnapshotCandidate as Record<string, unknown>).review_execution_policy === 'object'
    );
    const profileSnapshot = hasLockedProfileSnapshot
        ? profileSnapshotCandidate as TaskProfilePolicySnapshot
        : null;
    const requiredReviews = preflight.required_reviews || {};
    const legacyCompatibilityBinding = profileSnapshot
        ? null
        : resolveLegacyCompatibilityReviewCatalogBinding(
            readReviewCapabilitiesConfigFile(
                path.join(orchestratorRoot, 'live', 'config', 'review-capabilities.json')
            ),
            catalog
        );
    const profilePolicy = profileSnapshot
        ? resolveProfileReviewCatalogPolicy(
            String(profileSnapshot.source.effective_profile),
            profileSnapshot.review_lane_selection.profile_review_policy,
            profileSnapshot.review_lane_selection.review_capabilities,
            catalog
        )
        : legacyCompatibilityBinding!.profile_policy;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry: unknown) => String(entry))
        : [];
    const reviewExecutionPolicy = profileSnapshot?.review_execution_policy
        || {
            ...loadReviewExecutionPolicyConfig(repoRoot),
            review_dependency_graph: null,
            full_suite_validation: loadFullSuiteValidationConfig(repoRoot)
        };
    const effectiveReviewSnapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: profileSnapshot?.snapshot_hash
            || legacyCompatibilityBinding!.profile_snapshot_sha256,
        legacyRequiredReviews: requiredReviews,
        scopeCategory: String(preflight.scope_category || 'code'),
        taskIntent: `Seed reusable review evidence for ${taskId}`,
        changedFiles,
        taskTriggers: preflight.triggers || {},
        zeroDiffBaselineOnly: changedFiles.length === 0,
        reviewExecutionPolicyMode: reviewExecutionPolicy.mode,
        reviewDependencyGraph: reviewExecutionPolicy.review_dependency_graph || null,
        fullSuiteValidation: reviewExecutionPolicy.full_suite_validation
    });
    if (options.ensureSkillEntrypoints !== false) {
        ensureFixtureReviewSkillEntrypoints(orchestratorRoot, effectiveReviewSnapshot, reviewKey);
    }
    if (profileSnapshot) {
        preflight.profile_policy_snapshot = profileSnapshot;
    }
    preflight.effective_review_snapshot = effectiveReviewSnapshot;
    preflight.required_reviews = { ...effectiveReviewSnapshot.required_reviews };
    preflight.review_execution_policy = {
        mode: reviewExecutionPolicy.mode,
        visible_summary_line:
            `Review execution policy: ${reviewExecutionPolicy.mode}`,
        dependency_graph: effectiveReviewSnapshot.review_dependency_graph
    };
    fs.writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');
}

function ensureFixtureReviewSkillEntrypoints(
    orchestratorRoot: string,
    effectiveReviewSnapshot: Record<string, any>,
    reviewKey: string
): void {
    const lanes = Array.isArray(effectiveReviewSnapshot.lanes) ? effectiveReviewSnapshot.lanes : [];
    const lane = lanes.find((candidate: Record<string, any>) => candidate.id === reviewKey);
    const fixtureSkillIds = Array.isArray(lane?.definition?.skill_ids)
        ? lane.definition.skill_ids.map((entry: unknown) => String(entry || '').trim()).filter(Boolean)
        : [];
    for (const fixtureSkillId of fixtureSkillIds) {
        const fixtureSkillPath = path.join(orchestratorRoot, 'live', 'skills', fixtureSkillId, 'SKILL.md');
        if (!fs.existsSync(fixtureSkillPath)) {
            fs.mkdirSync(path.dirname(fixtureSkillPath), { recursive: true });
            fs.writeFileSync(fixtureSkillPath, `# ${fixtureSkillId} fixture\n`, 'utf8');
        }
    }
}

export function writeHandshakeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    let canonicalSourceOfTruth = provider;
    if (fs.existsSync(initAnswersPath) && fs.statSync(initAnswersPath).isFile()) {
        try {
            const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
            const seededSourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
            if (seededSourceOfTruth) {
                canonicalSourceOfTruth = seededSourceOfTruth;
            }
        } catch {
            // Keep the lightweight test fixture tolerant of malformed init answers.
        }
    }
    const canonicalEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[canonicalSourceOfTruth] || null;
    const providerBridgeCandidate = PROVIDER_BRIDGE_BY_SOURCE[provider] || null;
    const providerBridgePath = providerBridgeCandidate && fs.existsSync(path.join(repoRoot, providerBridgeCandidate))
        ? providerBridgeCandidate
        : null;
    const providerEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[provider] || null;
    const routedTo = providerBridgePath || providerEntrypoint || null;
    const executionProviderSource = providerBridgePath ? 'provider_bridge' : 'provider_entrypoint';

    fs.mkdirSync(reviewsRoot, {recursive: true});
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-handshake.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'handshake-diagnostics',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        provider,
        execution_provider: provider,
        canonical_source_of_truth: canonicalSourceOfTruth,
        canonical_entrypoint: canonicalEntrypoint,
        canonical_entrypoint_exists: canonicalEntrypoint !== null && fs.existsSync(path.join(repoRoot, canonicalEntrypoint)),
        provider_bridge: providerBridgePath,
        provider_bridge_exists: providerBridgePath !== null && fs.existsSync(path.join(repoRoot, providerBridgePath)),
        routed_to: routedTo,
        execution_provider_source: executionProviderSource,
        runtime_identity_status: 'resolved',
        reviewer_subagent_launch_status: 'launchable',
        reviewer_subagent_launch_route: routedTo,
        start_task_router_path: '.agents/workflows/start-task.md',
        start_task_router_exists: fs.existsSync(path.join(repoRoot, '.agents/workflows/start-task.md')),
        execution_context: 'materialized-bundle',
        cli_path: 'node garda-agent-orchestrator/bin/garda.js',
        effective_cwd: repoRoot.replace(/\\/g, '/'),
        workspace_root: repoRoot.replace(/\\/g, '/'),
        diagnostics: [],
        violations: []
    }, null, 2), 'utf8');
}

export function writeShellSmokeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, {recursive: true});
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-shell-smoke.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'shell-smoke-preflight',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        provider,
        execution_context: 'materialized-bundle',
        effective_cwd: repoRoot.replace(/\\/g, '/'),
        workspace_root: repoRoot.replace(/\\/g, '/'),
        probes: [],
        violations: []
    }, null, 2), 'utf8');
}


export function loadTaskEntryRulePack(repoRoot: string, taskId: string, taskModePath = '') {
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'TASK_ENTRY',
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

export function loadPostPreflightRulePack(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    ensurePreflightClassified = true,
    artifactPath = '',
    taskModePath = ''
) {
    if (ensurePreflightClassified) {
        appendPreflightClassifiedEvent(repoRoot, taskId, preflightPath);
    }
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        artifactPath,
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '30-code-style.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

export function runHandshakeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
    writeHandshakeArtifact(repoRoot, taskId, provider);
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const artifactPath = path.join(orchestratorRoot, 'runtime', 'reviews', `${taskId}-handshake.json`);
    const artifactContent = fs.readFileSync(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactContent) as Record<string, unknown>;
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(artifactContent).digest('hex');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'PASS',
        `Handshake diagnostics passed: provider=${provider}, context=materialized-bundle.`,
        {
            provider,
            execution_provider: artifact.execution_provider ?? provider,
            canonical_source_of_truth: artifact.canonical_source_of_truth ?? provider,
            execution_provider_source: artifact.execution_provider_source ?? 'provider_entrypoint',
            execution_context: 'materialized-bundle',
            cli_path: 'node garda-agent-orchestrator/bin/garda.js',
            passed: true,
            artifact_hash: artifactHash
        },
        {actor: 'gate', passThru: true}
    );
}

export function runShellSmokeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
    writeShellSmokeArtifact(repoRoot, taskId, provider);
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const artifactPath = path.join(orchestratorRoot, 'runtime', 'reviews', `${taskId}-shell-smoke.json`);
    const artifactContent = fs.readFileSync(artifactPath, 'utf8');
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(artifactContent).digest('hex');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PASS',
        `Shell smoke preflight passed: provider=${provider}, context=materialized-bundle.`,
        {provider, execution_context: 'materialized-bundle', passed: true, artifact_hash: artifactHash},
        {actor: 'gate', passThru: true}
    );
}

export function prepareCurrentReviewPhase(repoRoot: string, taskId: string, preflightPath: string, provider = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    let seededSourceOfTruth = '';
    if (fs.existsSync(initAnswersPath) && fs.statSync(initAnswersPath).isFile()) {
        try {
            const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
            seededSourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        } catch {
            seededSourceOfTruth = '';
        }
    }
    const shouldPinExplicitProvider = !!provider && provider !== seededSourceOfTruth;
    runEnterTaskMode({
        repoRoot,
        taskId,
        taskSummary: `Prepare review lifecycle for ${taskId}`,
        ...(shouldPinExplicitProvider
            ? {provider, routedTo: resolveAttestedTaskModeRoute(provider)}
            : {})
    });
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    runHandshakeForTask(repoRoot, taskId, provider);
    runShellSmokeForTask(repoRoot, taskId, provider);
    assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
    writeCompilePassEvidence(repoRoot, taskId, preflightPath);
}

export function runExplicitPreflight(
    repoRoot: string,
    taskId: string,
    taskIntent: string,
    changedFiles: string[],
    outputFileName = `${taskId}-preflight.json`,
    taskModePath = ''
): string {
    const preflightPath = path.join(getReviewsRoot(repoRoot), outputFileName);
    const result = runClassifyChangeCommand({
        repoRoot,
        taskId,
        taskIntent,
        changedFiles,
        taskModePath,
        outputPath: preflightPath,
        emitMetrics: false
    });
    const payload = JSON.parse(result.outputText);
    assert.equal(payload.task_id, taskId);
    return preflightPath;
}


export function readTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function findLastTimelineEventIndex(
    events: Array<Record<string, unknown>>,
    predicate: (event: Record<string, unknown>) => boolean
): number {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return index;
        }
    }
    return -1;
}

export function readTaskQueueStatusFromTaskFile(repoRoot: string, taskId: string): string | null {
    const statusPattern = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED|DECOMPOSED)\b/i;
    const taskPath = path.join(repoRoot, 'TASK.md');
    const lines = fs.readFileSync(taskPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed.split('|').map((cell) => cell.trim()).filter(Boolean);
        if (cells.length < 2 || cells[0] !== taskId) {
            continue;
        }
        const statusMatch = statusPattern.exec(cells[1]);
        return statusMatch ? statusMatch[1].toUpperCase() : null;
    }
    return null;
}
