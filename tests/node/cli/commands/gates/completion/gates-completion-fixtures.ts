import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';

import {
    runEnterTaskModeCommand,
    runLoadRulePackCommand,
    runRequiredReviewsCheckCommand as runRequiredReviewsCheckCommandBase
} from '../../../../../../src/cli/commands/gates';
import { buildReviewContext } from '../../../../../../src/gates/review-context/build-review-context';
import type { ReviewCoverageContract } from '../../../../../../src/gates/review/review-coverage-ledger';
import { validateReviewFindingsContract } from '../../../../../../src/gates/review/review-findings-artifact-verdict';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath
} from '../../../../../../src/gates/review/review-findings-validation-artifact';
import { resolveDefaultReviewScratchPath } from '../../../../../../src/gates/review/review-scratch-paths';
import { getWorkspaceSnapshot } from '../../../../../../src/gates/compile/compile-gate';
import {
    buildReviewerLaunchBindingSha256
} from '../../../../../../src/cli/commands/gate-review-handlers/launch/review-launch-input-attestation';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint
} from '../../../../../../src/gates/review-reuse';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance
} from '../../../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { resolveReviewerRoutingPolicy } from '../../../../../../src/gates/review/reviewer-routing';
import {
    fileSha256,
    normalizePath,
    writeProtectedControlPlaneManifest
} from '../../../../../../src/gates/shared/helpers';
import {
    assessTrustBoundaryAnalysisApplicability,
    TRUST_BOUNDARY_ANALYSIS_RULE_ID
} from '../../../../../../src/core/trust-boundary-analysis';
import {
    QUALITY_CHECKLIST_ID,
    resolveDefaultQualityChecklistArtifactPath
} from '../../../../../../src/gates/quality-checklist';
import {
    initializeGitRepo as initializeCanonicalGitRepo,
    initializeGitRepoWithMaterializedScope,
    prepareReviewDiffFixture as prepareCanonicalReviewDiffFixture,
    bindFixtureEffectiveReviewSnapshot,
    writeBalancedProfilesConfig,
    writePreflight as writeCanonicalPreflight,
    writeReceiptBackedReviewArtifact as writeCanonicalReceiptBackedReviewArtifact
} from '../../gate-test-helpers';
import { createManagedTestTempDirectory } from '../../gate-test-temp-manager';
import { TEST_COMPILE_GATE_COMMAND, writeTestCompileFixture } from '../../gate-test-repo-bootstrap';

const GIT_INIT_RETRY_DELAYS_MS = [0, 25, 100];
const RETRYABLE_GIT_INIT_PATTERNS = /\b(?:EACCES|EBUSY|ENOTEMPTY|EPERM|Permission denied)\b/i;
const TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH =
    'tests/node/gates/review-context/review-context-trust-boundary-fixture.test.ts';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256JsonFixture(value: unknown): string {
    return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function buildFixtureFindingsReport(options: {
    taskId: string;
    reviewKey: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string | null;
    coverageContract: ReviewCoverageContract;
    failed: boolean;
}): Record<string, unknown> {
    const defaultEvidenceFile = options.coverageContract.obligations.find((entry) => entry.kind === 'file')?.target
        || 'src/app.ts';
    const findingId = 'F-001';
    const finding = {
        id: findingId,
        title: 'Fixture active finding',
        description: 'Seeded failed-review fixture finding for downstream gate behavior.',
        evidence: [{
            location: `${defaultEvidenceFile}:1`,
            observation: 'The fixture intentionally records an active finding.'
        }],
        coverage_obligation_ids: options.coverageContract.obligations.map((obligation) => obligation.id)
    };
    return {
        schema_version: 1,
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
                    finding_ids: options.failed ? [findingId] : []
                }))
                : []
        },
        findings: {
            critical: [],
            high: options.failed ? [finding] : [],
            medium: [],
            low: []
        },
        residual_risks: [],
        reviewer_notes: []
    };
}

function buildFixtureFindingsContent(options: {
    taskId: string;
    reviewKey: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string | null;
    coverageContract: ReviewCoverageContract;
    verdict: string;
}): string {
    const report = buildFixtureFindingsReport({
        taskId: options.taskId,
        reviewKey: options.reviewKey,
        reviewContextSha256: options.reviewContextSha256,
        reviewTreeStateSha256: options.reviewTreeStateSha256,
        coverageContract: options.coverageContract,
        failed: /\bFAILED\b/u.test(options.verdict)
    });
    return `${JSON.stringify(report, null, 2)}\n`;
}

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
        delegation_required: routingPolicy.delegation_required,
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

async function captureExpectedAsyncError(callback: () => Promise<void>): Promise<Error> {
    try {
        await callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
}

function createTempRepo(): string {
    const root = createManagedTestTempDirectory('repo-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    writeTestCompileFixture(root);
    seedRuleFiles(root);
    seedProjectMemoryOffWorkflowConfig(root);
    writeBalancedProfilesConfig(root);
    writeProtectedControlPlaneManifest(root);
    return root;
}

function seedProjectMemoryOffWorkflowConfig(repoRoot: string): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
        compile_gate: {
            command: TEST_COMPILE_GATE_COMMAND
        },
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        },
        project_memory_maintenance: {
            enabled: false,
            mode: 'check',
            run_before_final_closeout: true,
            require_user_approval_for_writes: true,
            max_compact_summary_chars: 12000,
            read_strategy: 'index_first',
            impact_artifact_retention_days: 30
        }
    }, null, 2), 'utf8');
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
    fs.mkdirSync(path.dirname(launchArtifactPath), { recursive: true });
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
        path.join(options.repoRoot, 'garda-agent-orchestrator'),
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
            reviewer_launch_artifact_path: path.normalize(launchArtifactPath).replace(/\\/g, '/')
        },
        { passThru: true }
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
    const result = runEnterTaskModeCommand(resolvedOptions);
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    const taskId = String(resolvedOptions.taskId || '').trim();
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (taskId && fs.existsSync(preflightPath)) {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        delete preflight.effective_review_snapshot;
        fs.writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');
        bindFixtureEffectiveReviewSnapshot(
            repoRoot,
            taskId,
            'code',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`)
        );
    }
    return result;
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

function loadTaskEventsIoModule(): { appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>; } {
    const taskEventsIoModule = require(path.join(__dirname, '../../../../../../src/gate-runtime/timeline/task-events-io.js')) as {
        appendMandatoryTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
    };
    const lifecycleAppendProxy = {} as { appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>; };
    Object.defineProperty(lifecycleAppendProxy, 'appendTaskEventAsync', {
        configurable: true,
        enumerable: true,
        get() {
            return taskEventsIoModule.appendMandatoryTaskEventAsync;
        },
        set(value: (...args: unknown[]) => Promise<unknown>) {
            taskEventsIoModule.appendMandatoryTaskEventAsync = value;
        }
    });
    return lifecycleAppendProxy;
}

function loadTimelineSummaryModule(): { reconcileTimelineSummaryForTask: (...args: unknown[]) => void; } {
    return require(path.join(__dirname, '../../../../../../src/gate-runtime/timeline/timeline-summary.js')) as {
        reconcileTimelineSummaryForTask: (...args: unknown[]) => void;
    };
}

function writePreflight(
    repoRoot: string,
    taskId: string,
    overrides: Record<string, unknown> = {},
    outputFileName = `${taskId}-preflight.json`
): string {
    return writeCanonicalPreflight(repoRoot, taskId, {
        metrics: { changed_lines_total: 3 },
        ...overrides
    }, outputFileName);
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

function buildPassedReviewAuthorshipAttestationJson(preflightPath: string): string | undefined {
    if (!fs.existsSync(preflightPath)) {
        return undefined;
    }
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const requiredReviews = preflight.required_reviews && typeof preflight.required_reviews === 'object' && !Array.isArray(preflight.required_reviews)
        ? preflight.required_reviews as Record<string, unknown>
        : {};
    const attestations = Object.fromEntries(
        Object.entries(requiredReviews)
            .filter(([, required]) => required === true)
            .map(([reviewType]) => [reviewType, true])
    );
    return Object.keys(attestations).length > 0 ? JSON.stringify(attestations) : undefined;
}

function runRequiredReviewsCheckCommand(
    options: Parameters<typeof runRequiredReviewsCheckCommandBase>[0]
): ReturnType<typeof runRequiredReviewsCheckCommandBase> {
    return runRequiredReviewsCheckCommandBase({
        ...options,
        reviewAuthorshipAttestationJson: options.reviewAuthorshipAttestationJson
            ?? buildPassedReviewAuthorshipAttestationJson(String(options.preflightPath || ''))
    });
}

function resolveReviewTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    const treeStateSha256 = String(treeState?.tree_state_sha256 || treeState?.treeStateSha256 || '').trim().toLowerCase();
    return treeStateSha256 || null;
}

function prepareReviewDiffFixture(repoRoot: string, preflightPath: string): void {
    prepareCanonicalReviewDiffFixture(repoRoot, preflightPath);
}

function writeReceiptBackedReviewArtifact(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    verdict: string,
    contentLines?: string[]
): void {
    writeCanonicalReceiptBackedReviewArtifact(
        repoRoot,
        taskId,
        reviewKey,
        verdict,
        contentLines
    );
}

function writeCleanReviewArtifact(repoRoot: string, taskId: string, reviewKey: string, verdict: string): void {
    seedTrustBoundaryChecklistIfRequired(repoRoot, taskId);
    writeCanonicalReceiptBackedReviewArtifact(repoRoot, taskId, reviewKey, verdict);
}

function seedTrustBoundaryChecklistIfRequired(repoRoot: string, taskId: string): void {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath)) {
        return;
    }
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    if (!assessTrustBoundaryAnalysisApplicability(preflight).required) {
        return;
    }
    const preflightSha256 = fileSha256(preflightPath);
    if (!preflightSha256) {
        throw new Error(`Trust-boundary fixture preflight is unreadable: ${preflightPath}`);
    }
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(repoRoot, taskId);
    const evidencePath = path.join(repoRoot, TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    if (!fs.existsSync(evidencePath)) {
        fs.writeFileSync(
            evidencePath,
            "test('rejects replaced trust-boundary evidence', () => { assert.equal(true, true); });\n",
            'utf8'
        );
    }
    const artifact = {
        task_id: taskId,
        checklist_id: QUALITY_CHECKLIST_ID,
        preflight_sha256: preflightSha256,
        status: 'PASS',
        rules: [{
            id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
            scope_applicability: 'active'
        }],
        answers: [{
            rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
            trust_boundary_matrix: [{
                boundary_id: 'TB-COMPLETION-FIXTURE-001',
                boundary: 'Completion fixture input to protected review-context validation',
                authority_source: 'Hash-chained QUALITY_CHECKLIST_RECORDED fixture event',
                mutable_inputs: ['preflight evidence', 'quality-checklist artifact'],
                integrity_evidence: ['artifact sha256', 'preflight sha256'],
                canonical_reconstruction: 'Rebuild the fixture from current preflight evidence.',
                toctou_replay: 'Reject stale or replaced fixture evidence.',
                negative_paths: [{
                    kind: 'replaced',
                    scenario: 'rejects replaced trust-boundary evidence',
                    expected_behavior: 'Reject review-context construction.',
                    evidence_files: [
                        `${TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH}#rejects replaced trust-boundary evidence`
                    ]
                }]
            }]
        }]
    };
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const artifactSha256 = fileSha256(artifactPath);
    if (!artifactSha256) {
        throw new Error(`Trust-boundary fixture artifact is unreadable: ${artifactPath}`);
    }
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'QUALITY_CHECKLIST_RECORDED',
        'PASS',
        'Quality checklist completion fixture recorded.',
        {
            artifact_path: normalizePath(artifactPath),
            artifact_hash: artifactSha256,
            status: 'PASS',
            outcome: 'PASS',
            checklist_id: QUALITY_CHECKLIST_ID,
            preflight_path: normalizePath(path.resolve(preflightPath)),
            preflight_sha256: preflightSha256
        },
        { actor: 'gate' }
    );
}

function synchronizePreflightWithMaterializedScope(repoRoot: string, preflightPath: string): void {
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        return;
    }
    prepareCanonicalReviewDiffFixture(repoRoot, preflightPath);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const detectionSource = String(preflight.detection_source || 'explicit_changed_files').trim()
        || 'explicit_changed_files';
    const includeUntracked = preflight.include_untracked !== false;
    const snapshot = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, changedFiles);
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    preflight.changed_files = snapshot.changed_files;
    preflight.include_untracked = includeUntracked;
    preflight.metrics = {
        ...metrics,
        changed_files_count: snapshot.changed_files_count,
        changed_lines_total: snapshot.changed_lines_total,
        changed_files_sha256: snapshot.changed_files_sha256,
        scope_content_sha256: snapshot.scope_content_sha256,
        scope_sha256: snapshot.scope_sha256
    };
    fs.writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');
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
        reviewerRoutingOverrides?: Record<string, unknown>;
    } = {}
): string {
    const crypto = require('node:crypto');
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewKey}.md`);
    const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`);
    prepareReviewDiffFixture(repoRoot, preflightPath);
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
    if (options.reviewerRoutingOverrides && Object.keys(options.reviewerRoutingOverrides).length > 0) {
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing
            && typeof reviewContext.reviewer_routing === 'object'
            && !Array.isArray(reviewContext.reviewer_routing)
            ? reviewContext.reviewer_routing as Record<string, unknown>
            : {};
        reviewContext.reviewer_routing = {
            ...reviewerRouting,
            ...options.reviewerRoutingOverrides
        };
        fs.writeFileSync(reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');
    }
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
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const coverageContract = reviewContext.coverage_contract as ReviewCoverageContract | undefined;
    const artifactText = Number(reviewContext.schema_version) >= 3 && coverageContract
        ? buildFixtureFindingsContent({
            taskId,
            reviewKey,
            reviewContextSha256: reviewContextHash,
            reviewTreeStateSha256,
            coverageContract,
            verdict
        })
        : [
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
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactHash = crypto.createHash('sha256').update(artifactText).digest('hex');
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const preflight = JSON.parse(preflightText) as Record<string, unknown>;
    const preflightHash = crypto.createHash('sha256').update(preflightText).digest('hex');
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical review routing recorded', {
        review_type: reviewKey,
        reviewer_execution_mode: execution.reviewerExecutionMode,
        reviewer_session_id: execution.reviewerIdentity,
        delegation_used: execution.reviewerExecutionMode === 'delegated_subagent',
        reviewer_fallback_reason: execution.reviewerFallbackReason
    }, { passThru: true });
    const launchEvidence = seedCompletedReviewerLaunchFixture({
        repoRoot,
        taskId,
        reviewKey,
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
        'historical reviewer invocation attested',
        invocationDetails,
        { passThru: true }
    );
    const scopeSha256 = String(
        (preflight.metrics as Record<string, unknown> | undefined)?.scope_sha256
        || (preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256
        || ''
    ).trim() || null;
    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256;
    const codeScopeSha256 = reviewKey === 'code'
        ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
        : null;
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        'REVIEWER_INVOCATION_ATTESTED',
        invocationEvent?.integrity,
        invocationDetails
    );
    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256: preflightHash,
        scopeSha256,
        reviewScopeSha256,
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
    if (Number(reviewContext.schema_version) >= 3 && coverageContract) {
        const findingsValidation = validateReviewFindingsContract({
            content: artifactText,
            expectedTaskId: taskId,
            expectedReviewType: reviewKey,
            expectedReviewContextSha256: reviewContextHash,
            expectedTreeStateSha256: reviewTreeStateSha256 || undefined,
            coverageContract,
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
        const validationArtifactSha256 = sha256JsonFixture(validationArtifact);
        const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
            validationArtifactPath,
            validationArtifactSha256
        );
        fs.writeFileSync(validationArtifactPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
        fs.writeFileSync(validationArtifactSnapshotPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
        receiptRecord.review_coverage = findingsValidation.coverage_validation;
        receiptRecord.review_output_sha256 = artifactHash;
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
        receiptRecord.review_output_contract = {
            schema_version: 1,
            format: 'findings_json',
            report_sha256: findingsValidation.report ? sha256JsonFixture(findingsValidation.report) : null,
            validation_artifact_sha256: validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            raw_output_sha256: artifactHash,
            review_artifact_sha256: artifactHash,
            review_context_sha256: reviewContextHash,
            review_tree_state_sha256: reviewTreeStateSha256,
            coverage_contract_sha256: coverageContract.contract_sha256,
            reviewer_identity: execution.reviewerIdentity,
            reviewer_provenance_event_sha256: reviewerProvenance?.event_sha256 ?? null
        };
    }
    receiptRecord.review_result_recorded_at_utc = receipt.recorded_at_utc;
    receiptRecord.review_output_source_mtime_utc = fs.statSync(artifactPath).mtime.toISOString();
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptSha256 = crypto.createHash('sha256').update(receiptText).digest('hex');
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptSha256}.json`);
    fs.writeFileSync(receiptPath, receiptText, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptText, 'utf8');
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'historical review recorded', {
        ...receipt,
        receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
        receipt_sha256: receiptSha256,
        receipt_snapshot_path: path.normalize(receiptSnapshotPath).replace(/\\/g, '/'),
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
        review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
        review_artifact_snapshot_sha256: artifactHash,
        review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
    });
    return reviewContextPath;
}

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | default | fixture |`
    ].join('\n'), 'utf8');
}

function readTaskQueueStatusFromTaskFile(repoRoot: string, taskId: string): string | null {
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

function sleepSync(milliseconds: number): void {
    if (milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function spawnGit(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        windowsHide: true,
        encoding: 'utf8'
    });
}

function isRetryableGitInitFailure(args: string[], result: childProcess.SpawnSyncReturns<string>): boolean {
    if (args[0] !== 'init') {
        return false;
    }
    const output = `${String(result.error?.message || '')}\n${String(result.stderr || '')}\n${String(result.stdout || '')}`;
    return RETRYABLE_GIT_INIT_PATTERNS.test(output);
}

function runGit(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
    let result: childProcess.SpawnSyncReturns<string> | null = null;
    for (const retryDelayMs of GIT_INIT_RETRY_DELAYS_MS) {
        sleepSync(retryDelayMs);
        result = spawnGit(repoRoot, args);
        if (!result.error && result.status === 0) {
            return result;
        }
        if (!isRetryableGitInitFailure(args, result)) {
            break;
        }
    }
    assert.ok(result, `git ${args.join(' ')} did not run`);
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
    initializeCanonicalGitRepo(repoRoot);
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
    const result = runLoadRulePackCommand({
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
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    return result;
}

function loadPostPreflightRulePack(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    ensurePreflightClassified = true,
    artifactPath = '',
    taskModePath = ''
) {
    synchronizePreflightWithMaterializedScope(repoRoot, preflightPath);
    if (ensurePreflightClassified) {
        appendPreflightClassifiedEvent(repoRoot, taskId, preflightPath);
    }
    const result = runLoadRulePackCommand({
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
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    return result;
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

export {
    PROVIDER_ENTRYPOINT_BY_SOURCE,
    PROVIDER_BRIDGE_BY_SOURCE,
    escapeRegExp,
    createReviewerRoutingFixture,
    resolveReviewerExecutionFixture,
    captureExpectedAsyncError,
    createTempRepo,
    withDefaultTaskModeRouting,
    runEnterTaskMode,
    seedRuleFiles,
    getReviewsRoot,
    getOrchestratorRoot,
    loadTaskEventsIoModule,
    loadTimelineSummaryModule,
    writePreflight,
    appendPreflightClassifiedEvent,
    writeCompilePassEvidence,
    runRequiredReviewsCheckCommand,
    prepareReviewDiffFixture,
    writeReceiptBackedReviewArtifact,
    writeCleanReviewArtifact,
    seedReusableReviewEvidence,
    seedTaskQueue,
    readTaskQueueStatusFromTaskFile,
    seedInitAnswers,
    writeHandshakeArtifact,
    runGit,
    initializeGitRepo,
    readTaskTimelineEvents,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    writeShellSmokeArtifact,
    runShellSmokeForTask
};
