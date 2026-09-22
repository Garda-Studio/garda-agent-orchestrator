import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';
import { createHash } from 'node:crypto';

import {
    runCompileGateCommand,
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand} from '../../../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../../../src/cli/main';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { buildReviewTreeState } from '../../../../../../src/gates/review/review-tree-state';
import {
    buildReviewerLaunchBindingSha256
} from '../../../../../../src/cli/commands/gate-review-handlers/launch/review-launch-input-attestation';
import {
    resolveReviewExecutionRuntimeBindings,
    type ReviewExecutionRuntimeBindings
} from '../../../../../../src/cli/commands/gate-review-handlers/context/review-context-runtime-validation';
import {
    applyReviewerRoutingMetadata
} from '../../../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { GARDA_NO_DELEGATE_ENV } from '../../../../../../src/core/review-delegation-policy';
import {
    buildReviewRemediationReviewContract
} from '../../../../../../src/gates/review-remediation/review-remediation-review-contract';

import {
    createTempRepo,
    seedTaskQueue,
    seedInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    runEnterTaskMode,
    createReviewerRoutingFixture,
    writePreflight,
    prepareReviewDiffFixture,
    writeReceiptBackedReviewArtifact,
    writeCleanReviewArtifact,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    prepareCurrentReviewPhase,
    readTaskTimelineEvents,
    readTaskQueueStatusFromTaskFile} from '../../gate-test-helpers';
import {
    buildNoFindingsJsonReviewReport
} from '../review-result/gates-command-review-result-fixtures';

const TEST_REVIEW_LAUNCH_PREPARED_AT_UTC = '2026-04-28T00:00:00.000Z';
const TEST_REVIEW_LAUNCHED_AT_UTC = '2026-04-28T00:00:01.000Z';
const TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC = '2026-04-28T00:00:12.000Z';
const TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC = '2026-04-28T00:00:13.000Z';

function buildTestProviderInvocationId(taskId: string, reviewType: string, reviewerIdentity: string): string {
    const normalizedIdentity = reviewerIdentity.replace(/^agent:/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
    return `test-${taskId}-${reviewType}-${normalizedIdentity}`;
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
    reviewExecutionBindings: ReviewExecutionRuntimeBindings;
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
    const preparedEvent = appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'Reviewer launch prepared by test controller fixture.', {
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
        reviewer_launch_artifact_path: path.normalize(launchArtifactPath).replace(/\\/g, '/'),
        ...options.reviewExecutionBindings
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
        ...options.reviewExecutionBindings,
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


function fileSha256(pathToFile: string): string {
    return createHash('sha256').update(fs.readFileSync(pathToFile)).digest('hex');
}

// Manual review-context fixtures are used only by CLI routing/receipt tests that
// do not exercise production review-context construction.
function manualReviewContextTaskScopeFixture(repoRoot: string, taskId: string): Record<string, unknown> {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    let changedFiles = ['src/app.ts'];
    if (fs.existsSync(preflightPath) && fs.statSync(preflightPath).isFile()) {
        try {
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            changedFiles = Array.isArray(preflight.changed_files)
                ? preflight.changed_files
                    .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
                    .filter(Boolean)
                : changedFiles;
        } catch {
            // Keep the stable default fixture.
        }
    }
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

function manualReviewContextBindingFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflightSha256 = fs.existsSync(preflightPath)
        ? createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex')
        : null;
    const treeState = manualReviewContextTreeStateFixture(repoRoot, taskId);
    const preflight = fs.existsSync(preflightPath)
        ? JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>
        : {};
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
        : [];
    return {
        ...(treeState ? { schema_version: 2, tree_state: treeState } : {}),
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: preflightSha256,
        review_execution: buildReviewRemediationReviewContract({
            taskId,
            reviewType,
            preflightSha256: preflightSha256 || '0'.repeat(64),
            fullReviewScope: changedFiles
        }),
        rule_context: manualReviewContextRuleContextFixture(repoRoot, taskId, reviewType)
    };
}

function manualReviewContextRuleContextFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.md`);
    let artifactText: string;
    if (fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile()) {
        artifactText = fs.readFileSync(artifactPath, 'utf8');
    } else {
        artifactText = [
            `# ${reviewType} Review Context`,
            '',
            `Fixture prompt artifact for ${taskId}.`,
            '',
            '## Task Scope',
            '- src/app.ts'
        ].join('\n');
        fs.writeFileSync(artifactPath, `${artifactText}\n`, 'utf8');
        artifactText = `${artifactText}\n`;
    }
    return {
        artifact_path: artifactPath.replace(/\\/g, '/'),
        artifact_sha256: createHash('sha256').update(artifactText, 'utf8').digest('hex'),
        preferred_prompt_artifact: artifactPath.replace(/\\/g, '/')
    };
}


function manualReviewContextTreeStateFixture(repoRoot: string, taskId: string): Record<string, unknown> | null {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return null;
    }
    try {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const changedFiles = Array.isArray(preflight.changed_files)
            ? preflight.changed_files.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
            : ['src/app.ts'];
        const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
            ? preflight.metrics as Record<string, unknown>
            : null;
        return buildReviewTreeState({
            repoRoot,
            detectionSource: preflight.detection_source || 'explicit_changed_files',
            includeUntracked: preflight.include_untracked !== false,
            changedFiles,
            metrics
        }) as unknown as Record<string, unknown>;
    } catch {
        return null;
    }
}

function readReviewTreeStateSha256FromContextPath(reviewContextPath: string): string | null {
    if (!fs.existsSync(reviewContextPath) || !fs.statSync(reviewContextPath).isFile()) {
        return null;
    }
    try {
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
            ? reviewContext.tree_state as Record<string, unknown>
            : null;
        const treeStateSha256 = String(treeState?.tree_state_sha256 || treeState?.treeStateSha256 || '').trim().toLowerCase();
        return treeStateSha256 || null;
    } catch {
        return null;
    }
}

function reviewContextScopedDiffFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    return {
        expected: false,
        metadata_path: path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-scoped.json`).replace(/\\/g, '/'),
        metadata: null
    };
}

async function recordReviewRoutingViaCli(options: {
    taskId: string;
    reviewType: string;
    repoRoot: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason?: string;
    reviewContextPath?: string;
}) {
    const args = [
        'gate',
        'record-review-routing',
        '--task-id', options.taskId,
        '--review-type', options.reviewType,
        '--repo-root', options.repoRoot,
        '--reviewer-execution-mode', options.reviewerExecutionMode,
        '--reviewer-identity', options.reviewerIdentity
    ];
    if (options.reviewerFallbackReason) {
        args.push('--reviewer-fallback-reason', options.reviewerFallbackReason);
    }
    await runCliMainWithHandling(args);
    if ((process.exitCode ?? 0) !== 0) {
        return;
    }
    const taskEventsPath = path.join(getOrchestratorRoot(options.repoRoot), 'runtime', 'task-events', `${options.taskId}.jsonl`);
    if (!fs.existsSync(taskEventsPath)) {
        return;
    }
    attestReviewerInvocationForTest({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewContextPath: options.reviewContextPath || path.join(
            getReviewsRoot(options.repoRoot),
            `${options.taskId}-${options.reviewType}-review-context.json`
        ),
        reviewerIdentity: options.reviewerIdentity,
        reviewerExecutionMode: options.reviewerExecutionMode
    });
}

function attestReviewerInvocationForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewContextPath: string;
    reviewerIdentity: string;
    reviewerExecutionMode?: 'delegated_subagent';
}): void {
    const reviewerExecutionMode = options.reviewerExecutionMode || 'delegated_subagent';
    const events = readTaskTimelineEvents(options.repoRoot, options.taskId);
    const routedEvent = [...events].reverse().find((event) => (
        event.event_type === 'REVIEWER_DELEGATION_ROUTED'
        && String((event.details as Record<string, unknown> | undefined)?.review_type || '').trim().toLowerCase() === options.reviewType
        && String((event.details as Record<string, unknown> | undefined)?.reviewer_session_id || '').trim() === options.reviewerIdentity
        && String((event.details as Record<string, unknown> | undefined)?.reviewer_execution_mode || '').trim() === reviewerExecutionMode
    ));
    const routedIntegrity = routedEvent?.integrity as { event_sha256?: string } | null | undefined;
    assert.ok(routedIntegrity?.event_sha256, `Missing routed reviewer integrity for ${options.taskId}/${options.reviewType}.`);
    applyReviewerRoutingMetadata(options.reviewContextPath, {
        actualExecutionMode: reviewerExecutionMode,
        reviewerSessionId: options.reviewerIdentity,
        fallbackReason: null
    });
    const reviewContext = JSON.parse(
        fs.readFileSync(options.reviewContextPath, 'utf8')
    ) as Record<string, unknown>;
    const reviewExecutionBindings = resolveReviewExecutionRuntimeBindings(reviewContext);
    const crypto = require('node:crypto');
    const reviewContextSha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(options.reviewContextPath))
        .digest('hex');
    const reviewTreeStateSha256 = readReviewTreeStateSha256FromContextPath(options.reviewContextPath);
    const launchEvidence = seedCompletedReviewerLaunchFixture({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256,
        routingEventSha256: String(routedIntegrity.event_sha256).trim(),
        reviewExecutionBindings
    });
    if (events.some((event) => (
        event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
        && String((event.details as Record<string, unknown> | undefined)?.review_type || '').trim().toLowerCase() === options.reviewType
        && String((event.details as Record<string, unknown> | undefined)?.reviewer_session_id || '').trim() === options.reviewerIdentity
        && String((event.details as Record<string, unknown> | undefined)?.review_context_sha256 || '').trim().toLowerCase() === reviewContextSha256
        && (!reviewTreeStateSha256 || String((event.details as Record<string, unknown> | undefined)?.review_tree_state_sha256 || '').trim().toLowerCase() === reviewTreeStateSha256)
        && String((event.details as Record<string, unknown> | undefined)?.routing_event_sha256 || '').trim().toLowerCase() === String(routedIntegrity.event_sha256).trim().toLowerCase()
        && String((event.details as Record<string, unknown> | undefined)?.reviewer_launch_artifact_sha256 || '').trim().toLowerCase() === launchEvidence.launchArtifactSha256
    ))) {
        return;
    }
    appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', 'Reviewer invocation attested by test controller fixture.', {
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: reviewerExecutionMode,
        reviewer_session_id: options.reviewerIdentity,
        reviewer_identity: options.reviewerIdentity,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routedIntegrity.event_sha256,
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
        ...reviewExecutionBindings
    });
}







describe('gates command required reviews', () => {
    it('passes required reviews gate with compile evidence and review artifact', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
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
            taskSummary: 'Update app flow'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        const reviewArtifactPaths = new Set([
            path.resolve(reviewsRoot, `${taskId}-code.md`),
            path.resolve(reviewsRoot, `${taskId}-code-review-context.json`),
            path.resolve(reviewsRoot, `${taskId}-code-receipt.json`)
        ]);
        const reviewReadSites = new Map<string, string[]>();
        const fsModule = require('node:fs') as typeof fs;
        const originalOpenSync = fsModule.openSync;
        fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            const resolvedPath = path.resolve(String(targetPath));
            if (reviewArtifactPaths.has(resolvedPath)) {
                const sites = reviewReadSites.get(resolvedPath) || [];
                sites.push(new Error().stack || 'missing stack');
                reviewReadSites.set(resolvedPath, sites);
            }
            return originalOpenSync(targetPath, flags, mode);
        }) as typeof fsModule.openSync;

        let result: ReturnType<typeof runRequiredReviewsCheckCommand> | null = null;
        try {
            result = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath,
                codeReviewVerdict: 'REVIEW PASSED',
                reviewAuthorshipAttestationJson: '{"code":true}',
                outputFiltersPath,
                emitMetrics: false
            });
        } finally {
            fsModule.openSync = originalOpenSync;
        }

        const evidencePath = path.join(reviewsRoot, `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.ok(result);
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.equal(result.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.event_source, 'required-reviews-check');
        assert.equal(evidence.review_authorship_attestation.status, 'PASSED');
        assert.deepEqual(evidence.review_authorship_attestation.attestations, { code: true });
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some((event) => (
            event.event_type === 'STATUS_CHANGED'
            && event.details
            && typeof event.details === 'object'
            && (event.details as Record<string, unknown>).new_status === 'IN_REVIEW'
        )));
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903\s*\|\s*🟧 IN_REVIEW\s*\|/);
        for (const reviewArtifactPath of reviewArtifactPaths) {
            const sites = reviewReadSites.get(reviewArtifactPath) || [];
            assert.equal(sites.length, 1, `${reviewArtifactPath}\n${sites.join('\n\n')}`);
            assert.match(sites[0], /readReviewArtifactBytesBounded/u, sites[0]);
        }

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects otherwise valid review evidence when no-delegate mode is active', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-no-delegate-required-reviews';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const previousNoDelegate = process.env[GARDA_NO_DELEGATE_ENV];
        process.env[GARDA_NO_DELEGATE_ENV] = '1';
        try {
            const result = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath,
                codeReviewVerdict: 'REVIEW PASSED',
                reviewAuthorshipAttestationJson: '{"code":true}',
                outputFiltersPath,
                emitMetrics: false
            });

            const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
            const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
            const renderedOutput = result.outputLines.join('\n');
            const renderedViolations = Array.isArray(evidence.violations)
                ? evidence.violations.join('\n')
                : '';
            assert.notEqual(result.exitCode, 0);
            assert.equal(evidence.status, 'FAILED');
            assert.match(
                `${renderedOutput}\n${renderedViolations}`,
                /Mandatory review evidence cannot pass because delegated reviewer launch is 'blocked'/
            );
            assert.match(`${renderedOutput}\n${renderedViolations}`, /GARDA_NO_DELEGATE is active/);
        } finally {
            if (previousNoDelegate === undefined) {
                delete process.env[GARDA_NO_DELEGATE_ENV];
            } else {
                process.env[GARDA_NO_DELEGATE_ENV] = previousNoDelegate;
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('defaults required review verdicts from preflight when CLI verdict flags are omitted', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-defaulted-verdicts';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
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
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        writeCleanReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            reviewAuthorshipAttestationJson: '{"code":true,"test":true}',
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.equal(result.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.equal(evidence.verdicts.code, 'REVIEW PASSED');
        assert.equal(evidence.verdicts.test, 'TEST REVIEW PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });


    it('passes required review and completion flow for delegated test review evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: false,
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
        const commandsPath = path.join(repoRoot, 'commands.md');
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
            taskSummary: 'Validate delegated test review flow',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Review phase started.', {
            review_type: 'test'
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        prepareReviewDiffFixture(repoRoot, preflightPath);
        fs.writeFileSync(artifactPath, [
            '# Test Review',
            '',
            'Verified changes in `src/app.ts`. This review artifact content has been extended with more words to ensure it strictly passes the newly introduced triviality check, which demands at least thirty words if there are no meaningful findings or risks.',
            '',
            'TEST REVIEW PASSED',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'TEST REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'test'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'test'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                routed_to: '.antigravity/agents/orchestrator.md',
                provider_bridge: '.antigravity/agents/orchestrator.md',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: '.antigravity/agents/orchestrator.md'
            })
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: 'testing-strategy' });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {
            reference_path: '/live/skills/testing-strategy/SKILL.md'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'test',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'test',
                reviewContextPath,
                reviewerIdentity: 'agent:test-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            testReviewVerdict: 'TEST REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"test":true}',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.ok(reviewResult.outputLines.includes('TrustStatus: INDEPENDENT_AUDITED'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Test fixture exercises delegated test review only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.review_artifacts?.test?.receipt?.trust_level, 'INDEPENDENT_AUDITED');
        assert.ok(completionResult.review_trust_summary?.visible_summary_line?.includes('INDEPENDENT_AUDITED'));
        assert.ok(completionResult.review_trust_summary?.policy_summary_line?.includes('independent reviewer launch attestation satisfies mandatory review'));

        const previousCompletionExitCode = process.exitCode;
        const previousCompletionCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'completion-gate',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousCompletionCwd);
            process.exitCode = previousCompletionExitCode;
        }
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check and completion prefer canonical review-context artifacts over stale legacy default files', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-canonical-review-context-preferred';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: {
                changed_lines_total: 3
            },
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
        prepareReviewDiffFixture(repoRoot, preflightPath);
        const commandsPath = path.join(repoRoot, 'commands-canonical-review-context-preferred.md');
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
            taskSummary: 'Prefer canonical review-context artifacts over stale legacy default files',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
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
        assert.equal(compileResult.exitCode, 0);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const canonicalContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const legacyContextPath = path.join(reviewsRoot, `${taskId}-code-context.json`);
        const reviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let buildExitCode = 0;
        let recordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', canonicalContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            fs.writeFileSync(
                reviewOutputPath,
                `${JSON.stringify(buildNoFindingsJsonReviewReport(canonicalContextPath, taskId, 'code'), null, 2)}\n`,
                'utf8'
            );
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--review-context-path', canonicalContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            recordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.equal(recordExitCode, 0);

        const canonicalContext = JSON.parse(fs.readFileSync(canonicalContextPath, 'utf8')) as Record<string, unknown>;
        const staleLegacyContext = {
            ...canonicalContext,
            preflight_sha256: 'stale-legacy-hash',
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:stale-legacy-reviewer'
            }
        };
        fs.writeFileSync(legacyContextPath, JSON.stringify(staleLegacyContext, null, 2) + '\n', 'utf8');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true}',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Canonical review-context path selection is an internal gate-contract change.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });


    it('required-reviews-check allows a fresh review cycle after a newer compile pass', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-rerun-review-gate-recovered';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-rerun.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow review-gate rerun after a new compile cycle'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Prior review gate passed.', {});

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true}',
            emitMetrics: false
        });

        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });


    it('passes required review and completion flow for delegated evidence on bridge-backed providers', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
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
        const commandsPath = path.join(repoRoot, 'commands.md');
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
            taskSummary: 'Validate delegated review flow on a bridge-backed provider after fallback removal',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Review phase started.', {
            review_type: 'code'
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        prepareReviewDiffFixture(repoRoot, preflightPath);
        fs.writeFileSync(artifactPath, [
            '# Code Review',
            '',
            'Validated the Antigravity delegated reviewer path across `src/cli/main.ts`, `src/gates/required-reviews-check.ts`, and `src/gates/completion.ts`, confirming that bridge-backed providers materialize delegated reviewer routing, receipts, and completion evidence through the standard mandatory flow.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                routed_to: '.antigravity/agents/orchestrator.md',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: '.antigravity/agents/orchestrator.md'
            })
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: 'code-review' });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {
            reference_path: '/live/skills/code-review/SKILL.md'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath,
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true}',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Test fixture exercises conditional-provider fallback review flow only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });


});
