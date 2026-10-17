import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    bindFixtureEffectiveReviewSnapshot,
    writeBudgetOutputFilters
} from '../../gate-test-helpers';
import { createManagedTestTempDirectory } from '../../gate-test-temp-manager';

import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    runDocImpactGateCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand,
    runRequiredReviewsCheckCommand
} from '../../../../../../src/cli/commands/gates';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { buildReviewTreeState } from '../../../../../../src/gates/review/review-tree-state';
import {
    buildReviewerLaunchBindingSha256
} from '../../../../../../src/cli/commands/gate-review-handlers/launch/review-launch-input-attestation';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../../../../../src/gates/review-reuse';
import {
    initializeGitRepo,
    initializeGitRepoWithMaterializedScope,
    runGit
} from '../../gate-test-seed-helpers';
import {
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance
} from '../../../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { resolveReviewerRoutingPolicy } from '../../../../../../src/gates/review/reviewer-routing';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { computeProtectedSnapshotDigest, writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';
import { serializeTaskPlan, validateTaskPlan } from '../../../../../../src/schemas/task-plan';

const TEST_COMPILE_GATE_COMMAND = 'node -e "console.log(\'build ok\')"';

function createReviewerRoutingFixture(
    sourceOfTruth: string,
    executionProviderSource: 'provider_entrypoint' | 'provider_bridge' = 'provider_entrypoint',
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const normalizedSourceOfTruth = String(sourceOfTruth).trim() || 'Codex';
    const routingPolicy = resolveReviewerRoutingPolicy(normalizedSourceOfTruth, executionProviderSource);
    return {
        source_of_truth: normalizedSourceOfTruth,
        canonical_source_of_truth: normalizedSourceOfTruth,
        execution_provider: normalizedSourceOfTruth,
        execution_provider_source: executionProviderSource,
        identity_status: 'resolved',
        capability_level: routingPolicy.capability_level,
        expected_execution_mode: routingPolicy.expected_execution_mode,
        fallback_allowed: routingPolicy.fallback_allowed,
        fallback_reason_required: routingPolicy.fallback_reason_required,
        actual_execution_mode: null,
        reviewer_session_id: null,
        fallback_reason: null,
        ...overrides
    };
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

function createTempRepo(): string {
    const root = createManagedTestTempDirectory('repo-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'skills', 'code-review'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    fs.writeFileSync(
        path.join(root, 'garda-agent-orchestrator', 'live', 'skills', 'code-review', 'SKILL.md'),
        '# code-review fixture\n',
        'utf8'
    );
    seedRuleFiles(root);
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

function writeCompileGateCommand(repoRoot: string, command: string): void {
    const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
    workflowConfig.compile_gate.command = command;
    fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');
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
    const preparedEvent = appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'Reviewer launch prepared by protected drift fixture.', {
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

function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
    if (String(options.provider || '').trim() || String(options.routedTo || '').trim()) {
        return options;
    }
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return options;
    }

    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[sourceOfTruth];
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
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        const taskId = String(resolvedOptions.taskId || '').trim();
        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const changedFiles = fs.existsSync(preflightPath)
            ? (
                JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as { changed_files?: unknown[] }
            ).changed_files?.map((entry) => String(entry || '').trim()).filter(Boolean) || []
            : [];
        initializeGitRepoWithMaterializedScope(repoRoot, changedFiles);
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

function writeDriftedProtectedManifest(
    repoRoot: string,
    changedFiles: string[] = ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'],
    options: { isSourceCheckout?: boolean } = {}
): void {
    const manifestPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'protected-control-plane-manifest.json');
    const rulesRoot = path.join(getOrchestratorRoot(repoRoot), 'live', 'docs', 'agent-rules');
    const crypto = require('node:crypto');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const protectedSnapshot: Record<string, string> = {};
    for (const ruleFile of fs.readdirSync(rulesRoot).filter((entry) => entry.endsWith('.md')).sort()) {
        const relativePath = `garda-agent-orchestrator/live/docs/agent-rules/${ruleFile}`;
        const contents = fs.readFileSync(path.join(rulesRoot, ruleFile), 'utf8');
        protectedSnapshot[relativePath] = crypto.createHash('sha256').update(contents).digest('hex');
    }
    const workflowConfigPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'workflow-config.json');
    if (fs.existsSync(workflowConfigPath)) {
        const contents = fs.readFileSync(workflowConfigPath, 'utf8');
        protectedSnapshot['garda-agent-orchestrator/live/config/workflow-config.json'] = crypto
            .createHash('sha256')
            .update(contents)
            .digest('hex');
    }
    for (const changedFile of changedFiles) {
        protectedSnapshot[changedFile] = '0'.repeat(64);
    }
    fs.writeFileSync(manifestPath, JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: '2026-04-02T16:59:00.000Z',
        workspace_root: repoRoot.replace(/\\/g, '/'),
        orchestrator_root: getOrchestratorRoot(repoRoot).replace(/\\/g, '/'),
        protected_roots: ['garda-agent-orchestrator/live/docs/agent-rules/'],
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: options.isSourceCheckout === true
    }, null, 2), 'utf8');
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
        triggers: {},
        changed_files: ['src/app.ts'],
        ...overrides
    };
    fs.writeFileSync(preflightPath, JSON.stringify(payload, null, 2), 'utf8');
    return preflightPath;
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

function runExplicitPreflight(
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
    payload.review_coverage_contract_required = false;
    fs.writeFileSync(preflightPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return preflightPath;
}

function readReviewPreflightFixture(repoRoot: string, taskId: string): {
    preflight: Record<string, unknown>;
    preflightPath: string;
    preflightSha256: string | null;
} {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return {
            preflight: {},
            preflightPath,
            preflightSha256: null
        };
    }
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const crypto = require('node:crypto');
    return {
        preflight: JSON.parse(preflightText) as Record<string, unknown>,
        preflightPath,
        preflightSha256: crypto.createHash('sha256').update(preflightText).digest('hex')
    };
}

function buildReviewContextTaskScopeFixture(preflight: Record<string, unknown>): Record<string, unknown> {
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

function resolveReviewTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    const treeStateSha256 = String(treeState?.tree_state_sha256 || treeState?.treeStateSha256 || '').trim().toLowerCase();
    return treeStateSha256 || null;
}

function writeReceiptBackedReviewArtifact(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    verdict: string,
    contentLines?: string[]
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const execution = resolveReviewerExecutionFixture(taskId, 'Codex');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const content = (contentLines || [
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
    ]).join('\n');
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewKey}.md`);
    fs.writeFileSync(artifactPath, content, 'utf8');
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-review-context.json`);
    const preflightFixture = readReviewPreflightFixture(repoRoot, taskId);
    const crypto = require('node:crypto');
    const promptArtifactPath = reviewContextPath.replace(/\.json$/, '.md');
    const promptArtifactText = [
        `# ${reviewKey} review fixture`,
        '',
        `Fixture prompt artifact for ${taskId}/${reviewKey}.`
    ].join('\n');
    fs.writeFileSync(promptArtifactPath, promptArtifactText, 'utf8');
    const promptArtifactSha256 = crypto.createHash('sha256').update(promptArtifactText).digest('hex');
    const changedFiles = Array.isArray(preflightFixture.preflight.changed_files)
        ? preflightFixture.preflight.changed_files.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
        : [];
    const metrics = preflightFixture.preflight.metrics && typeof preflightFixture.preflight.metrics === 'object' && !Array.isArray(preflightFixture.preflight.metrics)
        ? preflightFixture.preflight.metrics as Record<string, unknown>
        : {};
    const reviewTreeState = buildReviewTreeState({
        repoRoot,
        detectionSource: preflightFixture.preflight.detection_source || 'explicit_changed_files',
        includeUntracked: preflightFixture.preflight.include_untracked !== false,
        changedFiles,
        metrics
    });
    const reviewContext = {
        task_id: taskId,
        review_type: reviewKey,
        preflight_path: preflightFixture.preflightPath.replace(/\\/g, '/'),
        preflight_sha256: preflightFixture.preflightSha256,
        task_scope: buildReviewContextTaskScopeFixture(preflightFixture.preflight),
        scoped_diff: {
            expected: false,
            metadata_path: path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`).replace(/\\/g, '/'),
            metadata: null
        },
        tree_state: reviewTreeState,
        rule_context: {
            artifact_path: promptArtifactPath.replace(/\\/g, '/'),
            preferred_prompt_artifact: promptArtifactPath.replace(/\\/g, '/'),
            artifact_sha256: promptArtifactSha256,
            token_economy_active: false
        },
        reviewer_routing: createReviewerRoutingFixture('Codex', 'provider_entrypoint', {
            actual_execution_mode: execution.reviewerExecutionMode,
            reviewer_session_id: execution.reviewerIdentity,
            fallback_reason: execution.reviewerFallbackReason
        })
    };
    const reviewContextText = `${JSON.stringify(reviewContext, null, 2)}\n`;
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');
    const reviewTreeStateSha256 = resolveReviewTreeStateSha256(reviewContext);

    // Authenticity hardening: write a verifiable receipt.
    const artifactHash = crypto.createHash('sha256').update(content).digest('hex');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    let reviewerProvenance: ReturnType<typeof buildReviewReceiptReviewerProvenance> | null = null;
    const writeReceipt = () => {
        const scopeSha256 = String((preflightFixture.preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null;
        const codeScopeSha256 = reviewKey === 'code' && preflightFixture.preflightSha256
            ? computeCodeReviewScopeFingerprint(preflightFixture.preflight, repoRoot).code_scope_sha256
            : null;
        const receipt = buildReviewReceipt({
            taskId,
            reviewType: reviewKey,
            preflightSha256: preflightFixture.preflightSha256,
            scopeSha256,
            codeScopeSha256,
            reviewContextSha256: reviewContextHash,
            reviewContextReuseSha256: computeReviewContextReuseHash(reviewContext),
            reviewTreeStateSha256,
            reviewArtifactSha256: artifactHash,
            reviewerExecutionMode: execution.reviewerExecutionMode,
            reviewerIdentity: execution.reviewerIdentity,
            reviewerFallbackReason: execution.reviewerFallbackReason,
            reviewerProvenance,
            trustLevel: execution.trustLevel
        });
        const receiptRecord = receipt as unknown as Record<string, unknown>;
        receiptRecord.review_result_recorded_at_utc = receipt.recorded_at_utc;
        receiptRecord.review_output_source_mtime_utc = fs.statSync(artifactPath).mtime.toISOString();
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    };
    writeReceipt();

    // Emit mandatory telemetry for authenticity
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    if (fs.existsSync(path.join(orchestratorRoot, 'runtime', 'task-events', `${taskId}.jsonl`))) {
        const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'review started', {
            review_type: reviewKey
        });
        appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: skillId });
        appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', { reference_path: `/live/skills/${skillId}/SKILL.md` });
        const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
            review_type: reviewKey,
            reviewer_execution_mode: execution.reviewerExecutionMode,
            reviewer_session_id: execution.reviewerIdentity,
            delegation_used: execution.reviewerExecutionMode === 'delegated_subagent',
            reviewer_fallback_reason: execution.reviewerFallbackReason
        }, { passThru: true });
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
            orchestratorRoot,
            taskId,
            'REVIEWER_INVOCATION_ATTESTED',
            'INFO',
            'reviewer invocation attested',
            invocationDetails,
            { passThru: true }
        );
        reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
            'REVIEWER_INVOCATION_ATTESTED',
            invocationEvent?.integrity,
            invocationDetails
        );
        writeReceipt();
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', { review_type: reviewKey });
    }
}

function writeCleanReviewArtifact(repoRoot: string, taskId: string, reviewKey: string, verdict: string): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, reviewKey, verdict);
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
    const canonicalEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[canonicalSourceOfTruth] || 'AGENTS.md';
    const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[provider] || null;
    const providerBridgeCandidate = PROVIDER_BRIDGE_BY_SOURCE[provider] || null;
    const providerBridgePath = providerBridgeCandidate && fs.existsSync(path.join(repoRoot, providerBridgeCandidate))
        ? providerBridgeCandidate
        : null;
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
        execution_provider_source: 'explicit_provider',
        runtime_identity_status: 'resolved',
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

function readTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
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
    bindFixtureEffectiveReviewSnapshot(repoRoot, taskId, 'code', preflightPath, taskModePath);
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
    it('fails preflight before writing an artifact when protected control-plane scope lacks orchestrator work', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-preflight-protected';
        const protectedFile = 'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md';
        const nonProtectedFile = 'src/app.ts';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update protected orchestration rules'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(
            path.join(repoRoot, ...protectedFile.split('/')),
            '# changed protected command rules\n',
            'utf8'
        );
        fs.writeFileSync(
            path.join(repoRoot, nonProtectedFile),
            'const a = 2;\nconst b = 2;\nconsole.log(a + b);\n',
            'utf8'
        );

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        let error: Error | null = null;
        try {
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update protected orchestration rules',
                changedFiles: [protectedFile, nonProtectedFile],
                outputPath: preflightPath,
                emitMetrics: false
            });
        } catch (caught: unknown) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }

        assert.ok(error);
        assert.ok(error.message.includes('--orchestrator-work'));
        assert.ok(error.message.includes('--operator-confirmed yes'));
        assert.ok(error.message.includes('--operator-confirmed-at-utc "<ISO-8601 timestamp>"'));
        assert.ok(error.message.includes(protectedFile));
        assert.ok(error.message.includes('Suggested command:'));
        assert.ok(error.message.includes(`--planned-changed-file "${protectedFile}"`));
        assert.ok(error.message.includes(`--planned-changed-file "${nonProtectedFile}"`));
        assert.equal(fs.existsSync(preflightPath), false);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'PREFLIGHT_CLASSIFIED'), false);
        assert.equal(events.some((event) => event.event_type === 'PREFLIGHT_FAILED'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves explicit planned scope when protected recovery differs from the dirty workspace', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-explicit-protected-scope';
        const protectedFile = 'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md';
        const nonProtectedFile = 'src/app.ts';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve explicit protected recovery scope'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        let error: Error | null = null;
        try {
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Preserve explicit protected recovery scope',
                changedFiles: [protectedFile, nonProtectedFile],
                outputPath: preflightPath,
                emitMetrics: false
            });
        } catch (caught: unknown) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }

        assert.ok(error);
        assert.ok(error.message.includes('Suggested command:'));
        assert.ok(error.message.includes(`--planned-changed-file "${protectedFile}"`));
        assert.ok(error.message.includes(`--planned-changed-file "${nonProtectedFile}"`));
        assert.equal(fs.existsSync(preflightPath), false);

        const failedEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'PREFLIGHT_FAILED');
        assert.ok(failedEvent);
        const failedDetails = failedEvent.details as Record<string, unknown>;
        assert.equal(
            failedDetails.preflight_failure_reason_code,
            'protected_scope_requires_orchestrator_work'
        );
        assert.deepEqual(
            failedDetails.authorized_scope_changed_files,
            [protectedFile, nonProtectedFile].sort()
        );
        assert.deepEqual(failedDetails.changed_protected_files, [protectedFile]);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when preflight already recorded trusted protected manifest drift before task start', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-manifest-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            triggers: {
                protected_control_plane_manifest_status: 'DRIFT',
                protected_control_plane_manifest_changed_files: ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-manifest-drift.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject ordinary compile on trusted manifest drift'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Trusted protected control-plane manifest was already drifted before task start')));
        assert.ok(result.outputLines.some((line) => line.includes('Restart task mode with:')));
        assert.ok(result.outputLines.some((line) => line.includes('--orchestrator-work')));
        assert.ok(result.outputLines.some((line) => line.includes('--planned-changed-file "src/app.ts"')));
        assert.equal(result.outputLines.some((line) => line.includes('--planned-changed-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md"')), false);
        assert.ok(result.outputLines.some((line) => line.includes('next-step')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when inherited protected baseline drift expands after preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-manifest-drift-expanded';
        const baselineProtectedPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md');
        const extraProtectedPath = path.join(repoRoot, 'garda-agent-orchestrator', 'src', 'cli', 'main.ts');
        const extraProtectedFile = 'garda-agent-orchestrator/src/cli/main.ts';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.mkdirSync(path.dirname(extraProtectedPath), { recursive: true });
        fs.writeFileSync(extraProtectedPath, 'console.log("baseline protected file");\n', 'utf8');
        initializeGitRepo(repoRoot);
        runGit(repoRoot, ['add', extraProtectedFile]);
        const extraProtectedStatus = runGit(repoRoot, ['status', '--porcelain', '--', extraProtectedFile]);
        if (extraProtectedStatus.stdout.trim()) {
            runGit(repoRoot, ['commit', '-m', 'test: add protected baseline file']);
        }
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(baselineProtectedPath, '# baseline protected drift\n', 'utf8');
        writeDriftedProtectedManifest(repoRoot);
        const manifestPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'protected-control-plane-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
        manifest.protected_roots = [
            ...new Set([
                ...(Array.isArray(manifest.protected_roots) ? manifest.protected_roots : []),
                'garda-agent-orchestrator/src/cli/'
            ])
        ];
        manifest.protected_snapshot[extraProtectedFile] = require('node:crypto')
            .createHash('sha256')
            .update(fs.readFileSync(extraProtectedPath, 'utf8'))
            .digest('hex');
        manifest.protected_snapshot_sha256 = computeProtectedSnapshotDigest(manifest.protected_snapshot);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block manifest drift that expands beyond the inherited protected baseline'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Block manifest drift that expands beyond the inherited protected baseline',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(extraProtectedPath, 'console.log("expanded protected drift");\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-manifest-drift-expanded.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Trusted protected control-plane manifest drift detected before compile gate')));
        assert.ok(result.outputLines.some((line) => line.includes(extraProtectedFile)));
        assert.ok(result.outputLines.some((line) => line.includes('next-step')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when source-checkout inherited manifest drift expands after preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-source-checkout-manifest-drift-expanded';
        const extraProtectedPath = path.join(repoRoot, 'src', 'cli', 'main.ts');
        const extraProtectedFile = 'src/cli/main.ts';
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
            name: 'garda-agent-orchestrator',
            version: '0.0.0-test'
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.mkdirSync(path.dirname(extraProtectedPath), { recursive: true });
        fs.writeFileSync(extraProtectedPath, 'console.log("baseline protected file");\n', 'utf8');
        initializeGitRepo(repoRoot);
        runGit(repoRoot, ['add', 'package.json', extraProtectedFile]);
        const extraProtectedStatus = runGit(repoRoot, ['status', '--porcelain', '--', 'package.json', extraProtectedFile]);
        if (extraProtectedStatus.stdout.trim()) {
            runGit(repoRoot, ['commit', '-m', 'test: add source checkout protected baseline file']);
        }
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeDriftedProtectedManifest(
            repoRoot,
            ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'],
            { isSourceCheckout: true }
        );
        const manifestPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'protected-control-plane-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
        manifest.protected_roots = [
            ...new Set([
                ...(Array.isArray(manifest.protected_roots) ? manifest.protected_roots : []),
                'src/cli/'
            ])
        ];
        manifest.protected_snapshot[extraProtectedFile] = createHash('sha256')
            .update(fs.readFileSync(extraProtectedPath, 'utf8'))
            .digest('hex');
        manifest.protected_snapshot_sha256 = computeProtectedSnapshotDigest(manifest.protected_snapshot);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block source-checkout manifest drift that expands after preflight'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Block source-checkout manifest drift that expands after preflight',
            ['src/app.ts']
        );
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.equal(
            preflight.triggers.protected_control_plane_manifest_baseline_allowance_status,
            'SOURCE_CHECKOUT_INHERITED_DRIFT'
        );
        assert.deepEqual(
            preflight.triggers.protected_control_plane_manifest_changed_files,
            ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(extraProtectedPath, 'console.log("expanded protected drift");\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-source-checkout-manifest-drift-expanded.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Trusted protected control-plane manifest drift detected before compile gate')));
        assert.ok(result.outputLines.some((line) => line.includes(extraProtectedFile)));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when a protected pre-existing dirty file changes outside explicit scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901dirty-protected';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const unrelatedPath = path.join(repoRoot, 'src', 'unrelated.ts');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 34;\nconst b = 55;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(unrelatedPath, 'export const unrelated = "before";\n', 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Protect unrelated dirty workspace edits'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Protect unrelated dirty workspace edits', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.deepEqual(preflight.triggers.dirty_workspace_protected_files, ['src/unrelated.ts']);
        assert.equal(preflight.triggers.dirty_workspace_protection_status, 'PASS');
        assert.equal(
            preflight.triggers.dirty_workspace_protection_assessment,
            'INFO_IGNORED_PROTECTED_LOCAL_BASELINE'
        );

        fs.writeFileSync(unrelatedPath, 'export const unrelated = "after";\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-protected.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Protected pre-existing workspace edits changed outside task scope')));
        assert.ok(result.outputLines.some((line) => line.includes('no longer match the task-mode baseline')));
        assert.ok(result.outputLines.some((line) => line.includes('Clean/stash the local baseline drift or restart task mode')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails completion gate when a protected pre-existing dirty file changes after review passed', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903dirty-completion';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const unrelatedPath = path.join(repoRoot, 'src', 'unrelated.ts');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 89;\nconst b = 144;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(unrelatedPath, 'export const unrelated = "baseline";\n', 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Protect unrelated dirty workspace edits through completion'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Protect unrelated dirty workspace edits through completion',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-dirty-completion.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
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
            rationale: 'Internal cleanup only, no public behavior change.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        fs.writeFileSync(unrelatedPath, 'export const unrelated = "mutated";\n', 'utf8');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.violations.some((item: string) => item.includes('Protected pre-existing workspace edits changed outside task scope')));
        assert.equal(completionResult.dirty_workspace_protection_evidence.status, 'DRIFT_DETECTED');
        assert.equal(
            completionResult.dirty_workspace_protection_evidence.assessment,
            'PROTECTED_LOCAL_BASELINE_DRIFT'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes completion gate when protected manifest drift is inherited baseline only', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903manifest-drift-baseline-only';
        const protectedRulePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(protectedRulePath, '# baseline protected drift\n', 'utf8');
        writeDriftedProtectedManifest(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow inherited protected manifest drift through completion'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = "task change";\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow inherited protected manifest drift through completion',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-manifest-drift-completion.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
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
            rationale: 'Ordinary task scope stayed non-protected; no operator-facing docs changed.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.status, 'PASSED');
        assert.equal(completionResult.dirty_workspace_protection_evidence.status, 'PASS');
        assert.deepEqual(completionResult.isolation_mode_warnings, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes compile gate when source-checkout inherited manifest drift stays unchanged after preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-source-checkout-manifest-drift-unchanged';
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
            name: 'garda-agent-orchestrator',
            version: '0.0.0-test'
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        runGit(repoRoot, ['add', 'package.json']);
        const packageStatus = runGit(repoRoot, ['status', '--porcelain', '--', 'package.json']);
        if (packageStatus.stdout.trim()) {
            runGit(repoRoot, ['commit', '-m', 'test: add source checkout package marker']);
        }
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeDriftedProtectedManifest(
            repoRoot,
            ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'],
            { isSourceCheckout: true }
        );

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow unchanged source-checkout inherited manifest drift through compile'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow unchanged source-checkout inherited manifest drift through compile',
            ['src/app.ts']
        );
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.equal(
            preflight.triggers.protected_control_plane_manifest_baseline_allowance_status,
            'SOURCE_CHECKOUT_INHERITED_DRIFT'
        );
        assert.deepEqual(
            preflight.triggers.protected_control_plane_manifest_changed_files,
            ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const commandsPath = path.join(repoRoot, 'commands-source-checkout-manifest-drift-unchanged.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.equal(result.outputLines[0], 'COMPILE_GATE_PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('emits restart command on unrelated protected manifest drift without widening planned scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-compile-restart-cmd';
        const driftedFile = 'garda-agent-orchestrator/live/docs/agent-rules/00-core.md';

        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Test compile-gate restart command on manifest drift'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            triggers: {
                protected_control_plane_manifest_status: 'MATCH',
                protected_control_plane_manifest_changed_files: []
            }
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        writeDriftedProtectedManifest(repoRoot, [driftedFile]);

        const commandsPath = path.join(repoRoot, 'commands-compile-restart.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Trusted protected control-plane manifest drift detected before compile gate')));
        assert.ok(result.outputLines.some((line) => line.includes(driftedFile)));
        assert.ok(result.outputLines.some((line) => line.includes('Restart task mode with:')));
        assert.ok(result.outputLines.some((line) => line.includes('--orchestrator-work')));
        assert.ok(result.outputLines.some((line) => line.includes('--planned-changed-file "src/app.ts"')));
        assert.equal(result.outputLines.some((line) => line.includes(`--planned-changed-file "${driftedFile}"`)), false);
        assert.ok(result.outputLines.some((line) => line.includes('next-step')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('includes task-owned generated protected manifest drift in compile-gate restart command', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-compile-generated-restart-cmd';
        const generatedFile = 'dist/src/app.js';

        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Test task-owned generated manifest drift in restart command'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            triggers: {
                protected_control_plane_manifest_status: 'MATCH',
                protected_control_plane_manifest_changed_files: []
            }
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        writeDriftedProtectedManifest(repoRoot, [generatedFile]);

        const commandsPath = path.join(repoRoot, 'commands-compile-generated-restart.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Trusted protected control-plane manifest drift detected before compile gate')));
        assert.ok(result.outputLines.some((line) => line.includes(generatedFile)));
        assert.ok(result.outputLines.some((line) => line.includes('Restart task mode with:')));
        assert.ok(result.outputLines.some((line) => line.includes('--orchestrator-work')));
        assert.ok(result.outputLines.some((line) => line.includes('--planned-changed-file "src/app.ts"')));
        assert.ok(result.outputLines.some((line) => line.includes(`--planned-changed-file "${generatedFile}"`)));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change restart command keeps explicitly supplied protected files in planned scope', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-merge-planned-scope';
        const protectedFile = 'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md';
        const nonProtectedFile = 'src/app.ts';
        const extraPlannedFile = 'src/feature/extra.ts';

        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Merge planned and observed protected scope',
            plannedChangedFiles: [extraPlannedFile]
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(
            path.join(repoRoot, ...protectedFile.split('/')),
            '# changed protected command rules\n',
            'utf8'
        );
        fs.writeFileSync(
            path.join(repoRoot, nonProtectedFile),
            'const a = 2;\nconst b = 2;\nconsole.log(a + b);\n',
            'utf8'
        );

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        let error: Error | null = null;
        try {
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Merge planned and observed protected scope',
                changedFiles: [protectedFile, nonProtectedFile],
                outputPath: preflightPath,
                emitMetrics: false
            });
        } catch (caught: unknown) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }

        assert.ok(error);
        assert.ok(error.message.includes('--orchestrator-work'));
        assert.ok(error.message.includes('--operator-confirmed yes'));
        assert.ok(error.message.includes('--operator-confirmed-at-utc "<ISO-8601 timestamp>"'));
        assert.ok(error.message.includes('Suggested command:'));
        assert.ok(error.message.includes(`--planned-changed-file "${protectedFile}"`));
        assert.ok(error.message.includes(`--planned-changed-file "${nonProtectedFile}"`));
        assert.ok(error.message.includes(`--planned-changed-file "${extraPlannedFile}"`));
        assert.equal(fs.existsSync(preflightPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change restart command excludes mutable optional task-mode metadata from copy-paste remediation', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-exact-rerun-metadata';
        const protectedFile = 'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md';
        const planPath = path.join(repoRoot, 'runtime-plan.json');
        const normalizedPlanPath = planPath.replace(/\\/g, '/');

        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(planPath, serializeTaskPlan(validateTaskPlan({
            schema_version: 1,
            task_id: taskId,
            status: 'approved',
            goal: 'Preserve exact rerun metadata',
            scope_files: [protectedFile],
            risk_level: 'medium',
            steps: [{ id: 'verify', title: 'Verify protected entry remediation' }]
        })), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve exact rerun metadata',
            requestedDepth: 2,
            effectiveDepth: 3,
            actor: 'review-operator',
            planPath
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const taskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        assert.equal((taskModeArtifact.plan as Record<string, unknown>).plan_path, normalizedPlanPath);

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        let error: Error | null = null;
        try {
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Preserve exact rerun metadata',
                changedFiles: [protectedFile],
                outputPath: preflightPath,
                emitMetrics: false
            });
        } catch (caught: unknown) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }

        assert.ok(error);
        assert.ok(error.message.includes('--effective-depth "3"'), error.message);
        assert.equal(error.message.includes('--actor "review-operator"'), false);
        assert.equal(error.message.includes(`--plan-path "${normalizedPlanPath}"`), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('emits restart command when compile command generates a protected file causing post-compile drift', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-compile-drift';
        const generatedFile = 'garda-agent-orchestrator/live/docs/agent-rules/generated-rule.md';
        const generatedFileAbs = path.join(repoRoot, ...generatedFile.split('/'));
        const compileScript = `require('node:fs').writeFileSync('${generatedFile}', '# modified by compile')`;

        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeCompileGateCommand(repoRoot, `node -e "${compileScript}"`);

        fs.mkdirSync(path.dirname(generatedFileAbs), { recursive: true });
        fs.writeFileSync(generatedFileAbs, '# initial content\n', 'utf8');
        writeDriftedProtectedManifest(repoRoot, []);

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Test post-compile manifest drift'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'app.ts'),
            'const a = 2;\nconst b = 2;\nconsole.log(a + b);\n',
            'utf8'
        );
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Test post-compile manifest drift', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const triggers = preflight.triggers as Record<string, unknown>;
        assert.equal(triggers.protected_control_plane_manifest_status, 'MATCH');

        const commandsPath = path.join(repoRoot, 'commands-post-compile-drift.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            `node -e "${compileScript}"`,
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Trusted protected control-plane manifest drift detected before compile output validation')));
        assert.ok(result.outputLines.some((line) => line.includes(generatedFile)));
        assert.ok(result.outputLines.some((line) => line.includes('Restart task mode with:')));
        assert.ok(result.outputLines.some((line) => line.includes('--orchestrator-work')));
        assert.ok(result.outputLines.some((line) => line.includes('--planned-changed-file "src/app.ts"')));
        assert.ok(result.outputLines.some((line) => line.includes(`--planned-changed-file "${generatedFile}"`)));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts only the source-checkout publish manifest hash generated by compile-gate', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-compile-publish-manifest';
        const taskFile = 'scripts/task-input.ts';
        const manifestFile = 'dist/publish-runtime-manifest.json';
        const manifestPath = path.join(repoRoot, ...manifestFile.split('/'));
        const compileScript =
            "require('node:fs').writeFileSync('dist/publish-runtime-manifest.json', JSON.stringify({version:2})+'\\n')";

        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
            name: 'garda-agent-orchestrator',
            version: '0.0.0-test'
        }, null, 2) + '\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, ...taskFile.split('/')), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, '{"version":1}\n', 'utf8');
        writeCompileGateCommand(repoRoot, `node -e "${compileScript}"`);
        writeProtectedControlPlaneManifest(repoRoot);
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'TASK.md\ngarda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Accept compile-owned publish manifest output'
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, ...taskFile.split('/')), 'export const value = 2;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Accept compile-owned publish manifest output',
            [taskFile]
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const commandsPath = path.join(repoRoot, 'commands-post-compile-publish-manifest.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            `node -e "${compileScript}"`,
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.equal(result.outputLines[0], 'COMPILE_GATE_PASSED');
        const compileEvidence = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, any>;
        assert.deepEqual(
            compileEvidence.compile_generated_protected_artifacts?.changed_files,
            [manifestFile]
        );
        assert.equal(
            compileEvidence.compile_generated_protected_artifacts?.entries?.[0]?.after_sha256,
            fileSha256(manifestPath)
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
