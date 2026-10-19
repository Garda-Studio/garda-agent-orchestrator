import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runCompileGateCommand,
    runDocImpactGateCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand,
    runRequiredReviewsCheckCommand
} from '../../../../../../src/cli/commands/gates';
import { runCliMainWithHandling } from '../../../../../../src/cli/main';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { buildReviewContext } from '../../../../../../src/gates/review-context/build-review-context';
import { getWorkspaceSnapshot } from '../../../../../../src/gates/compile/compile-gate';
import {
    buildReviewerLaunchBindingSha256
} from '../../../../../../src/cli/commands/gate-review-handlers/launch/review-launch-input-attestation';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../../../../../src/gates/review-reuse';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance
} from '../../../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { resolveReviewerRoutingPolicy } from '../../../../../../src/gates/review/reviewer-routing';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';
import { getCurrentWorkflowConfigFileHashes } from '../../../../../../src/gates/workflow-config/workflow-config-work';
import * as childProcess from 'node:child_process';
import {
    bindFixtureEffectiveReviewSnapshot,
    seedReusableReviewEvidence as seedCurrentReusableReviewEvidence,
    writeBudgetOutputFilters
} from '../../gate-test-helpers';
import { createManagedTestTempDirectory } from '../../gate-test-temp-manager';
import { TEST_COMPILE_GATE_COMMAND, writeTestCompileFixture } from '../../gate-test-repo-bootstrap';


function createTempRepo(): string {
    const root = createManagedTestTempDirectory('repo-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    seedRuleFiles(root);
    writeTestCompileFixture(root);
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.compile_gate.command = TEST_COMPILE_GATE_COMMAND;
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.full_suite_validation.command = 'npm test';
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    fs.writeFileSync(
        path.join(root, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
        JSON.stringify(workflowConfig, null, 2) + '\n',
        'utf8'
    );
    writeProtectedControlPlaneManifest(root);
    return root;
}

const PROVIDER_ENTRYPOINT_BY_SOURCE: Record<string, string> = {
    Claude: 'CLAUDE.md',
    Codex: 'AGENTS.md',
    Gemini: 'GEMINI.md',
    Qwen: 'QWEN.md',
    GitHubCopilot: '.github/copilot-instructions.md',
    Windsurf: '.windsurf/rules/rules.md',
    Junie: '.junie/guidelines.md',
    Antigravity: '.antigravity/rules.md'
};

const PROVIDER_BRIDGE_BY_SOURCE: Record<string, string> = {
    GitHubCopilot: '.github/agents/orchestrator.md',
    Windsurf: '.windsurf/agents/orchestrator.md',
    Junie: '.junie/agents/orchestrator.md',
    Antigravity: '.antigravity/agents/orchestrator.md'
};

const TEST_REVIEW_LAUNCH_PREPARED_AT_UTC = '2026-04-28T00:00:00.000Z';
const TEST_REVIEW_LAUNCHED_AT_UTC = '2026-04-28T00:00:01.000Z';
const TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC = '2026-04-28T00:00:12.000Z';
const TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC = '2026-04-28T00:00:13.000Z';

function buildTestProviderInvocationId(taskId: string, reviewKey: string, reviewerIdentity: string): string {
    const normalizedIdentity = reviewerIdentity.replace(/^agent:/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
    return `test-${taskId}-${reviewKey}-${normalizedIdentity}`;
}

function fileSha256(pathToFile: string): string {
    return createHash('sha256').update(fs.readFileSync(pathToFile)).digest('hex');
}

function buildFixtureLaunchInputEvidence(taskId: string, reviewType: string): {
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
    const copyPastePrompt = `Delegated ${reviewType} reviewer launch prompt for ${taskId}.`;
    const copyPastePromptSha256 = createHash('sha256').update(copyPastePrompt, 'utf8').digest('hex');
    return {
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        launch_input_mode: 'copy_paste_prompt',
        launch_input_sha256: copyPastePromptSha256,
        launch_input_copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        reviewer_prompt_sha256: createHash('sha256').update(`reviewer-prompt:${taskId}:${reviewType}`, 'utf8').digest('hex'),
        role_prompt_sha256: createHash('sha256').update(`role-prompt:${taskId}:${reviewType}`, 'utf8').digest('hex'),
        prompt_template_sha256: createHash('sha256').update(`prompt-template:${taskId}:${reviewType}`, 'utf8').digest('hex'),
        output_template_sha256: createHash('sha256').update(`output-template:${taskId}:${reviewType}`, 'utf8').digest('hex'),
        evidence_manifest_sha256: createHash('sha256').update(`evidence-manifest:${taskId}:${reviewType}`, 'utf8').digest('hex')
    };
}

function seedCompletedReviewerLaunchFixture(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
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
    const launchInputEvidence = buildFixtureLaunchInputEvidence(options.taskId, options.reviewType);
    const providerInvocationId = buildTestProviderInvocationId(options.taskId, options.reviewType, options.reviewerIdentity);
    const launchTool = 'test-subagent-spawn';
    const attestationSource = 'test-subagent-spawn';
    const launchArtifactPath = path.join(
        getOrchestratorRoot(options.repoRoot),
        'runtime',
        'tmp',
        'reviews',
        options.taskId,
        options.reviewType,
        'reviewer-launch.json'
    );
    fs.mkdirSync(path.dirname(launchArtifactPath), { recursive: true });
    const launchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        reviewerPromptSha256: launchInputEvidence.reviewer_prompt_sha256
    });
    const preparedEvent = appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'Reviewer launch prepared by legacy resume fixture.', {
        task_id: options.taskId,
        review_type: options.reviewType,
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
        reviewer_launch_artifact_path: path.normalize(launchArtifactPath).replace(/\\/g, '/')
    }, { passThru: true });
    const launchArtifactText = `${JSON.stringify({
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch',
        attestation_state: 'launched',
        task_id: options.taskId,
        review_type: options.reviewType,
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
        fork_context: false
    }, null, 2)}\n`;
    fs.writeFileSync(launchArtifactPath, launchArtifactText, 'utf8');
    return {
        launchArtifactPath,
        launchArtifactSha256: fileSha256(launchArtifactPath),
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

function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
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

function runEnterTaskMode(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
    const resolvedOptions = withDefaultTaskModeRouting({
        startBanner: 'Garda captures my mind',
        ...options
    });
    const repoRoot = path.resolve(String(resolvedOptions.repoRoot || '.'));
    const routedTo = String(resolvedOptions.routedTo || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (routedTo) {
        const routedFilePath = path.join(repoRoot, routedTo);
        fs.mkdirSync(path.dirname(routedFilePath), { recursive: true });
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
        }
        writeProtectedControlPlaneManifest(repoRoot);
    }
    return runEnterTaskModeCommand(resolvedOptions);
}

function seedRuleFiles(repoRoot: string): void {
    const rulesRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    const ruleFiles = [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ];
    for (const ruleFile of ruleFiles) {
        fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
    }
}

function getReviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function getOrchestratorRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator');
}

function resolveReviewerExecutionFixture(
    _taskId: string,
    sourceOfTruth = 'Codex',
    executionProviderSource: 'provider_entrypoint' | 'provider_bridge' = 'provider_entrypoint',
    delegatedIdentity = 'agent:test-reviewer'
) {
    const routingPolicy = resolveReviewerRoutingPolicy(sourceOfTruth, executionProviderSource);
    const reviewerExecutionMode = routingPolicy.expected_execution_mode;
    return {
        reviewerExecutionMode,
        reviewerIdentity: delegatedIdentity,
        reviewerFallbackReason: null,
        trustLevel: 'INDEPENDENT_AUDITED'
    } as const;
}

function writePreflight(
    repoRoot: string,
    taskId: string,
    overrides: Record<string, unknown> = {},
    outputFileName = `${taskId}-preflight.json`
): string {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, outputFileName);
    const payload = {
        task_id: taskId,
        detection_source: 'explicit_changed_files',
        mode: 'FULL_PATH',
        metrics: { changed_lines_total: 3 },
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
    bindFixtureEffectiveReviewSnapshot(
        repoRoot,
        taskId,
        'code',
        preflightPath,
        path.join(reviewsRoot, `${taskId}-task-mode.json`)
    );
    return preflightPath;
}

function runGitBestEffort(repoRoot: string, args: string[]): void {
    childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

function ensureReviewDiffFixture(repoRoot: string, preflightPath: string): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
        : [];
    if (changedFiles.length === 0) {
        return;
    }
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        runGitBestEffort(repoRoot, ['init']);
    }
    runGitBestEffort(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGitBestEffort(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    const head = childProcess.spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    if (head.status !== 0) {
        runGitBestEffort(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
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
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        if (!fs.existsSync(absolutePath)) {
            fs.writeFileSync(absolutePath, `// legacy review fixture for ${changedFile}\n`, 'utf8');
        }
    }
}

function appendPreflightClassifiedEvent(repoRoot: string, taskId: string, preflightPath: string): void {
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
            ? { zero_diff_detected: true, status: 'BASELINE_ONLY' }
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

function writeCompilePassEvidence(repoRoot: string, taskId: string, preflightPath: string): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const crypto = require('node:crypto');
    ensureReviewDiffFixture(repoRoot, preflightPath);
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

function seedReusableReviewEvidence(
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
        sourceOfTruth?: string;
        executionProviderSource?: 'provider_entrypoint' | 'provider_bridge';
    } = {}
): string {
    const crypto = require('node:crypto');
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewKey}.md`);
    const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`);
    const artifactText = [
        '# Review',
        '',
        `Validated \`${reviewKey === 'code' ? 'src/app.ts' : 'tests/app.test.ts'}\` and the reuse contract in detail so this artifact remains realistic and non-trivial while reporting no findings for the current scope.`,
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
    ensureReviewDiffFixture(repoRoot, preflightPath);
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
    const execution = resolveReviewerExecutionFixture(
        taskId,
        options.sourceOfTruth || 'Codex',
        options.executionProviderSource || 'provider_entrypoint',
        reviewerIdentity
    );
    applyReviewerRoutingMetadata(reviewContextPath, {
        actualExecutionMode: execution.reviewerExecutionMode,
        reviewerSessionId: execution.reviewerIdentity,
        fallbackReason: execution.reviewerFallbackReason
    });
    if (options.legacyReviewContextIdentity) {
        const legacyReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = legacyReviewContext.reviewer_routing
            && typeof legacyReviewContext.reviewer_routing === 'object'
            && !Array.isArray(legacyReviewContext.reviewer_routing)
            ? legacyReviewContext.reviewer_routing as Record<string, unknown>
            : {};
        if (options.legacyReviewContextSourceOfTruth) {
            reviewerRouting.source_of_truth = options.legacyReviewContextSourceOfTruth;
        }
        delete reviewerRouting.canonical_source_of_truth;
        delete reviewerRouting.execution_provider;
        delete reviewerRouting.execution_provider_source;
        delete reviewerRouting.identity_status;
        legacyReviewContext.reviewer_routing = reviewerRouting;
        fs.writeFileSync(reviewContextPath, JSON.stringify(legacyReviewContext, null, 2) + '\n', 'utf8');
    }
    const reviewContextText = fs.readFileSync(reviewContextPath, 'utf8');
    const reviewContext = JSON.parse(reviewContextText) as Record<string, unknown>;
    const reviewTreeStateSha256 = resolveReviewTreeStateSha256(reviewContext);
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactHash = crypto.createHash('sha256').update(artifactText).digest('hex');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const preflight = JSON.parse(preflightText) as Record<string, unknown>;
    const preflightHash = crypto.createHash('sha256').update(preflightText).digest('hex');
    const routedEvent = appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'REVIEWER_DELEGATION_ROUTED',
        'INFO',
        'historical review routing recorded',
        {
            review_type: reviewKey,
            reviewer_execution_mode: execution.reviewerExecutionMode,
            reviewer_session_id: execution.reviewerIdentity,
            delegation_used: execution.reviewerExecutionMode === 'delegated_subagent',
            reviewer_fallback_reason: execution.reviewerFallbackReason
        },
        { passThru: true }
    );
    const launchEvidence = seedCompletedReviewerLaunchFixture({
        repoRoot,
        taskId,
        reviewType: reviewKey,
        reviewerIdentity: execution.reviewerIdentity,
        reviewContextSha256: reviewContextHash,
        routingEventSha256: String(routedEvent?.integrity?.event_sha256 || '').trim()
    });
    const invocationDetails = {
        task_id: taskId,
        review_type: reviewKey,
        reviewer_execution_mode: execution.reviewerExecutionMode,
        reviewer_session_id: execution.reviewerIdentity,
        reviewer_identity: execution.reviewerIdentity,
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
        invocation_attested_at_utc: TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC
    };
    const invocationEvent = appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'REVIEWER_INVOCATION_ATTESTED',
        'INFO',
        'historical reviewer invocation attested',
        invocationDetails,
        { passThru: true }
    );
    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256: preflightHash,
        scopeSha256: String((preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null,
        codeScopeSha256: reviewKey === 'code'
            ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
            : null,
        reviewContextSha256: reviewContextHash,
        reviewContextReuseSha256: computeReviewContextReuseHash(reviewContext),
        reviewTreeStateSha256,
        reviewArtifactSha256: artifactHash,
        reviewerExecutionMode: execution.reviewerExecutionMode,
        reviewerIdentity: execution.reviewerIdentity,
        reviewerFallbackReason: execution.reviewerFallbackReason,
        reviewerProvenance: buildReviewReceiptReviewerInvocationProvenance(
            'REVIEWER_INVOCATION_ATTESTED',
            invocationEvent?.integrity,
            invocationDetails
        ),
        trustLevel: execution.trustLevel
    });
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptPayload = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptPayloadSha256 = crypto.createHash('sha256').update(receiptPayload).digest('hex');
    const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(receiptPath, receiptPayload, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptPayload, 'utf8');
    fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'historical review recorded', {
        ...receipt,
        receipt_path: receiptPath.replace(/\\/g, '/'),
        receipt_sha256: receiptPayloadSha256,
        receipt_snapshot_path: receiptSnapshotPath.replace(/\\/g, '/'),
        receipt_snapshot_sha256: receiptPayloadSha256,
        review_artifact_path: artifactPath.replace(/\\/g, '/'),
        review_artifact_snapshot_path: artifactSnapshotPath.replace(/\\/g, '/'),
        review_artifact_snapshot_sha256: artifactHash,
        review_context_path: reviewContextPath.replace(/\\/g, '/')
    });
    return seedCurrentReusableReviewEvidence(
        repoRoot,
        taskId,
        reviewKey,
        verdict,
        preflightPath,
        reviewContextPath,
        reviewerIdentity,
        {
            legacyReviewContextIdentity: options.legacyReviewContextIdentity,
            legacyReviewContextSourceOfTruth: options.legacyReviewContextSourceOfTruth,
            taskModePath: options.taskModePath,
            sourceOfTruth: options.sourceOfTruth
        }
    );
}

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | default | fixture |`
    ].join('\n'), 'utf8');
}

function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[sourceOfTruth];
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: sourceOfTruth,
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2), 'utf8');
    if (routedTo) {
        const routedFilePath = path.join(repoRoot, routedTo);
        fs.mkdirSync(path.dirname(routedFilePath), { recursive: true });
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
        }
    }
}

function writeHandshakeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
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
    const providerBridgeCandidate = PROVIDER_BRIDGE_BY_SOURCE[provider] || null;
    const providerBridgePath = providerBridgeCandidate && fs.existsSync(path.join(repoRoot, providerBridgeCandidate))
        ? providerBridgeCandidate
        : null;
    const canonicalEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[canonicalSourceOfTruth] || 'AGENTS.md';
    const providerEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[provider] || null;
    const routedTo = providerBridgePath || providerEntrypoint || null;
    const executionProviderSource = providerBridgePath ? 'provider_bridge' : 'provider_entrypoint';
    if (routedTo) {
        const routedFilePath = path.join(repoRoot, routedTo);
        fs.mkdirSync(path.dirname(routedFilePath), { recursive: true });
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
        }
    }
    fs.mkdirSync(reviewsRoot, { recursive: true });
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
        canonical_entrypoint_exists: true,
        provider_bridge: providerBridgePath,
        provider_bridge_exists: providerBridgePath !== null,
        routed_to: routedTo,
        execution_provider_source: executionProviderSource,
        runtime_identity_status: 'resolved',
        reviewer_subagent_launch_status: 'launchable',
        reviewer_subagent_launch_route: routedTo,
        start_task_router_path: '.agents/workflows/start-task.md',
        start_task_router_exists: true,
        execution_context: 'materialized-bundle',
        cli_path: 'node garda-agent-orchestrator/bin/garda.js',
        effective_cwd: repoRoot.replace(/\\/g, '/'),
        workspace_root: repoRoot.replace(/\\/g, '/'),
        diagnostics: [],
        violations: []
    }, null, 2), 'utf8');
}

function runGit(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        windowsHide: true,
        encoding: 'utf8'
    });
    if (result.error) {
        throw result.error;
    }
    assert.equal(
        result.status,
        0,
        `git ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`
    );
    return result;
}

function initializeGitRepo(repoRoot: string): void {
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'test: baseline']);
}

function readTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resolveReviewTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    const treeStateSha256 = String(treeState?.tree_state_sha256 || treeState?.treeStateSha256 || '').trim().toLowerCase();
    return treeStateSha256 || null;
}

function refreshReviewReceiptProvenance(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    reviewerExecutionMode: 'delegated_subagent',
    reviewerIdentity: string
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-receipt.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const routedEvent = [...readTaskTimelineEvents(repoRoot, taskId)].reverse().find((event) => {
        if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
            return false;
        }
        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : {};
        return String(details.review_type || '').trim() === reviewKey
            && String(details.reviewer_execution_mode || '').trim() === reviewerExecutionMode
            && String(details.reviewer_session_id || '').trim() === reviewerIdentity;
    });
    assert.ok(routedEvent, `Expected routed event for ${taskId}/${reviewKey}.`);
    const routedIntegrity = (routedEvent.integrity && typeof routedEvent.integrity === 'object')
        ? routedEvent.integrity as { event_sha256?: unknown }
        : null;
    assert.ok(routedIntegrity?.event_sha256, `Expected routed event integrity for ${taskId}/${reviewKey}.`);
    const launchEvidence = seedCompletedReviewerLaunchFixture({
        repoRoot,
        taskId,
        reviewType: reviewKey,
        reviewerIdentity,
        reviewContextSha256: String(receipt.review_context_sha256 || '').trim(),
        routingEventSha256: String(routedIntegrity.event_sha256 || '').trim()
    });
    const invocationDetails = {
        task_id: taskId,
        review_type: reviewKey,
        reviewer_execution_mode: reviewerExecutionMode,
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: String(receipt.review_context_sha256 || '').trim(),
        review_tree_state_sha256: String(receipt.review_tree_state_sha256 || '').trim() || null,
        routing_event_sha256: String(routedIntegrity.event_sha256 || '').trim(),
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
        invocation_attested_at_utc: TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC
    };
    const invocationEvent = appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'REVIEWER_INVOCATION_ATTESTED',
        'INFO',
        'Reviewer invocation attested for resumed legacy review fixture.',
        invocationDetails,
        { passThru: true }
    );
    const provenance = buildReviewReceiptReviewerInvocationProvenance(
        'REVIEWER_INVOCATION_ATTESTED',
        (invocationEvent?.integrity && typeof invocationEvent.integrity === 'object')
            ? invocationEvent.integrity as any
            : null,
        invocationDetails
    );
    assert.ok(provenance, `Expected reviewer provenance for ${taskId}/${reviewKey}.`);
    receipt.reviewer_provenance = provenance;
    receipt.trust_level = 'INDEPENDENT_AUDITED';
    receipt.review_result_recorded_at_utc = receipt.recorded_at_utc;
    const reviewArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewKey}.md`);
    if (fs.existsSync(reviewArtifactPath) && fs.statSync(reviewArtifactPath).isFile()) {
        receipt.review_output_source_mtime_utc = fs.statSync(reviewArtifactPath).mtime.toISOString();
    }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
}

function loadTaskEntryRulePack(repoRoot: string, taskId: string, taskModePath = '') {
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

function loadPostPreflightRulePack(
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

function runHandshakeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
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
            execution_provider_source: artifact.execution_provider_source ?? 'explicit_provider',
            execution_context: 'materialized-bundle',
            cli_path: 'node garda-agent-orchestrator/bin/garda.js',
            passed: true,
            artifact_hash: artifactHash
        },
        { actor: 'gate', passThru: true }
    );
}

function writeShellSmokeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
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

function runShellSmokeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
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
        { provider, execution_context: 'materialized-bundle', passed: true, artifact_hash: artifactHash },
        { actor: 'gate', passThru: true }
    );
}

describe('cli/commands/gates', () => {
    it('legacy provider-bridge task-mode artifacts can resume review and completion from an explicit custom task-mode path when the default artifact drifts', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-legacy-bridge-custom-task-mode-resume';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.dirname(customTaskModePath), { recursive: true });
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        writeProtectedControlPlaneManifest(repoRoot);
        fs.writeFileSync(customTaskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume legacy provider-bridge task-mode artifact from a custom path after upgrade',
            workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(repoRoot),
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy provider-bridge task-mode entry before runtime identity split.', {
            artifact_path: customTaskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume legacy provider-bridge task-mode artifact from a custom path after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');

        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');

        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        const postPreflightRulePack = loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        assert.equal(postPreflightRulePack.exitCode, 0, JSON.stringify(postPreflightRulePack));
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation resumed after upgrade on a legacy provider-bridge custom task-mode artifact.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        fs.writeFileSync(defaultTaskModePath, JSON.stringify({
            timestamp_utc: '2026-04-17T12:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Drifted default task-mode artifact for legacy custom-path compatibility coverage',
            provider: 'Qwen',
            routed_to: 'QWEN.md',
            canonical_source_of_truth: 'Qwen',
            execution_provider: 'Qwen',
            execution_provider_source: 'task_mode',
            runtime_identity_status: 'resolved'
        }, null, 2) + '\n', 'utf8');

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(reviewsRoot, `${taskId}-code-review-context.json`),
            'agent:code-reviewer',
            {
                legacyReviewContextIdentity: true,
                taskModePath: customTaskModePath,
                sourceOfTruth: 'Antigravity',
                executionProviderSource: 'provider_bridge'
            }
        );
        const codeExecution = resolveReviewerExecutionFixture(taskId, 'Antigravity', 'provider_bridge', 'agent:code-reviewer');
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started for resumed legacy provider-bridge custom task-mode fixture.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEWER_DELEGATION_ROUTED',
            'INFO',
            'Delegated code review routed for resumed legacy provider-bridge custom task-mode fixture.',
            {
                review_type: 'code',
                reviewer_execution_mode: codeExecution.reviewerExecutionMode,
                reviewer_session_id: codeExecution.reviewerIdentity,
                delegation_used: codeExecution.reviewerExecutionMode === 'delegated_subagent',
                reviewer_fallback_reason: codeExecution.reviewerFallbackReason
            },
            { passThru: true }
        );
        refreshReviewReceiptProvenance(
            repoRoot,
            taskId,
            'code',
            codeExecution.reviewerExecutionMode,
            codeExecution.reviewerIdentity
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'Code review evidence recorded for resumed legacy provider-bridge custom task-mode fixture.',
            { review_type: 'code' }
        );

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            taskModePath: customTaskModePath,
            codeReviewVerdict: 'REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true}',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Legacy provider-bridge custom task-mode compatibility regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context keeps downstream test review blocked when upstream code review uses a legacy custom context path without strict binding metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-code-context-legacy-blocked';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        ensureReviewDiffFixture(repoRoot, preflightPath);
        const commandsPath = path.join(repoRoot, 'commands-custom-code-context-legacy-blocked.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep downstream test review blocked when legacy custom upstream review contexts fail strict gate validation',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0, JSON.stringify(compileResult));

        const reviewsRoot = getReviewsRoot(repoRoot);
        const canonicalCodeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const legacyCodeReviewContextPath = path.join(reviewsRoot, 'legacy-code-context.json');
        const codeReviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const codeReviewReceiptPath = codeReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        const blockedTestReviewContextPath = path.join(reviewsRoot, `${taskId}-blocked-test-review-context.json`);
        const blockedTestReviewContextArtifactPath = blockedTestReviewContextPath.replace(/\.json$/, '.md');
        const blockedTestScopedDiffPath = path.join(reviewsRoot, `${taskId}-blocked-test-scoped.json`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        let codeReviewBuildExitCode = 0;
        let blockedExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', canonicalCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            const canonicalContext = JSON.parse(fs.readFileSync(canonicalCodeReviewContextPath, 'utf8')) as Record<string, unknown>;
            const routing = (canonicalContext.reviewer_routing && typeof canonicalContext.reviewer_routing === 'object')
                ? canonicalContext.reviewer_routing as Record<string, unknown>
                : {};
            const legacyContext = {
                review_type: canonicalContext.review_type,
                task_scope: canonicalContext.task_scope,
                scoped_diff: canonicalContext.scoped_diff,
                reviewer_routing: {
                    ...routing,
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }
            };
            fs.writeFileSync(legacyCodeReviewContextPath, JSON.stringify(legacyContext, null, 2) + '\n', 'utf8');

            const artifactText = [
                '# Review',
                '',
                'Validated `src/app.ts` and the downstream review sequencing contract in detail, confirming that the upstream code-review artifact is otherwise realistic and non-trivial while leaving no active findings for this fixture.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n');
            fs.writeFileSync(codeReviewArtifactPath, artifactText, 'utf8');

            const crypto = require('node:crypto');
            const preflightText = fs.readFileSync(preflightPath, 'utf8');
            const preflight = JSON.parse(preflightText) as Record<string, unknown>;
            const legacyContextText = fs.readFileSync(legacyCodeReviewContextPath, 'utf8');
            const receipt = buildReviewReceipt({
                taskId,
                reviewType: 'code',
                preflightSha256: crypto.createHash('sha256').update(preflightText).digest('hex'),
                scopeSha256: String((preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null,
                codeScopeSha256: computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256,
                reviewContextSha256: crypto.createHash('sha256').update(legacyContextText).digest('hex'),
                reviewContextReuseSha256: computeReviewContextReuseHash(JSON.parse(legacyContextText) as Record<string, unknown>),
                reviewArtifactSha256: crypto.createHash('sha256').update(artifactText).digest('hex'),
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer',
                reviewerFallbackReason: null,
                trustLevel: 'LOCAL_AUDITED'
            });
            fs.writeFileSync(codeReviewReceiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Review phase started.', {
                review_type: 'code'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_SELECTED', 'INFO', 'selected', {
                skill_id: 'code-review'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {
                reference_path: '/live/skills/code-review/SKILL.md'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer',
                delegation_used: true
            }, { passThru: true });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', {
                review_type: 'code',
                review_context_path: legacyCodeReviewContextPath.replace(/\\/g, '/')
            });

            process.exitCode = 0;
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--scoped-diff-metadata-path', blockedTestScopedDiffPath,
                '--output-path', blockedTestReviewContextPath
            ]);
            blockedExitCode = Number(process.exitCode ?? 0);
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const blockedErrorOutput = blockedErrors.join('\n');
        assert.equal(codeReviewBuildExitCode, 0);
        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('missing task_id')
            || blockedErrorOutput.includes('missing preflight_path')
            || blockedErrorOutput.includes('missing preflight_sha256'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(blockedTestReviewContextPath), false);
        assert.equal(fs.existsSync(blockedTestReviewContextArtifactPath), false);
        assert.equal(fs.existsSync(blockedTestScopedDiffPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
