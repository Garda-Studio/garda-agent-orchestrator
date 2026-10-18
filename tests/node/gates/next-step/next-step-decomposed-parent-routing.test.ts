import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { initGitRepo } from '../git-fixtures';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildDomainScopeFingerprints } from './next-step-test-support';

const TASK_ID = 'T-NEXT-1';

const ALL_REVIEW_FLAGS = Object.freeze({
    code: false,
    db: false,
    security: false,
    refactor: false,
    api: false,
    test: false,
    performance: false,
    infra: false,
    dependency: false
});

let tempRoots: string[] = [];


function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'template', 'docs', 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | ux/test | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |`,
        ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
        SourceOfTruth: 'Codex'
    });
    for (const ruleFile of [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]) {
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', ruleFile),
            `# ${ruleFile}\n`,
            'utf8'
        );
    }
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.full_suite_validation.command = 'npm test';
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
    fs.writeFileSync(
        path.join(repoRoot, 'template', 'docs', 'prompts', 'review-cycle-auto-split.md'),
        [
            '# Review Cycle Auto-Split Prompt for {{TASK_ID}}',
            '',
            'GuardReason: {{GUARD_REASON}}',
            'Counts: total_non_test_reviews={{TOTAL_NON_TEST_REVIEWS}}; failed_non_test_reviews={{FAILED_NON_TEST_REVIEWS}}; excluded_review_types={{EXCLUDED_REVIEW_TYPES}}',
            'LatestFailedReview: {{LATEST_FAILED_REVIEW}}',
            'SuggestedChildTaskIds: {{SUGGESTED_CHILD_TASK_IDS}}',
            'SuggestedReviewerFollowUpTaskId: {{SUGGESTED_FOLLOWUP_TASK_ID}}',
            '',
            '## Instructions',
            '1. Treat the parent as SPLIT_REQUIRED, create linked parent-derived suffix task IDs, then rerun next-step so the gate moves it to DECOMPOSED.',
            '2. Allocate child ids from {{SUGGESTED_CHILD_TASK_IDS}}.',
            '',
            '## Constraints',
            '- Do not mark the parent DONE merely because child tasks were created.',
            '- Do not hand-edit the parent status to bypass SPLIT_REQUIRED.',
            '- Reviewer follow-ups use {{SUGGESTED_FOLLOWUP_TASK_ID}} style ids.',
            ''
        ].join('\n'),
        'utf8'
    );
    initGitRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
    return repoRoot;
}

function reviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function eventsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}





function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}



function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome = 'PASS',
    details: Record<string, unknown> = {},
    timestampUtc?: string
): { task_sequence: number; prev_event_sha256: string | null; event_sha256: string } {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const existingLines = fs.existsSync(timelinePath)
        ? fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim())
        : [];
    const taskSequence = existingLines.length + 1;
    const previousEvent = taskSequence > 1
        ? JSON.parse(existingLines[existingLines.length - 1]) as Record<string, unknown>
        : null;
    const previousIntegrity = previousEvent?.integrity && typeof previousEvent.integrity === 'object'
        ? previousEvent.integrity as Record<string, unknown>
        : null;
    const previousEventSha256 = typeof previousIntegrity?.event_sha256 === 'string'
        ? previousIntegrity.event_sha256
        : null;
    const line: Record<string, unknown> = {
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor: 'gate',
        message: eventType,
        timestamp_utc: timestampUtc || new Date().toISOString(),
        details,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: previousEventSha256,
            event_sha256: null
        }
    };
    const integrity = line.integrity as Record<string, unknown>;
    integrity.event_sha256 = buildEventIntegrityHash(line);
    const eventSha256 = String(integrity.event_sha256 || '');
    fs.appendFileSync(timelinePath, `${JSON.stringify(line)}\n`, 'utf8');
    return {
        task_sequence: taskSequence,
        prev_event_sha256: previousEventSha256,
        event_sha256: eventSha256
    };
}

function seedStartedTask(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded next-step task',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    }));
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
    seedRulePack(repoRoot, taskId, 'TASK_ENTRY');
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
}



function seedRulePack(repoRoot: string, taskId: string, stage: 'TASK_ENTRY' | 'POST_PREFLIGHT', taskModePath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage,
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage,
        artifact_path: normalizeForTimeline(rulePackPath)
    });
}



function seedPostPreflightRulePack(repoRoot: string, taskId: string, preflightPath: string, taskModePath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
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
        ]
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage: 'POST_PREFLIGHT',
        preflight_path: normalizeForTimeline(preflightPath),
        artifact_path: normalizeForTimeline(rulePackPath)
    });
}

function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}



function writePreflight(
    repoRoot: string,
    taskId: string,
    requiredReviews: Record<string, boolean>,
    options: {
        seedPostPreflight?: boolean;
        reviewPolicyMode?: string;
        changedFiles?: string[];
        includeDomainScopeFingerprints?: boolean;
    } = {}
): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const changedFiles = options.changedFiles || ['src/app.ts'];
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
    const domainScopeFingerprints = options.includeDomainScopeFingerprints
        ? buildDomainScopeFingerprints({
            repoRoot,
            detectionSource: snapshot.detection_source,
            includeUntracked: snapshot.include_untracked,
            changedFiles
        })
        : null;
    const reviewPolicyMode = options.reviewPolicyMode || 'code_first_optional';
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'code',
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256,
            ...(domainScopeFingerprints ? { domain_scope_fingerprints: domainScopeFingerprints } : {})
        },
        required_reviews: requiredReviews,
        changed_files: changedFiles,
        review_execution_policy: {
            mode: reviewPolicyMode,
            visible_summary_line: `Review execution policy: ${reviewPolicyMode}`
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath)
    });
    if (options.seedPostPreflight !== false) {
        seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
    }
    return preflightPath;
}

function seedCompilePass(repoRoot: string, taskId: string, timestampUtc?: string): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-compile-gate.json`), {
        timestamp_utc: timestampUtc || new Date().toISOString(),
        task_id: taskId,
        event_source: 'compile-gate',
        status: 'PASSED',
        outcome: 'PASS',
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: fileSha256(preflightPath),
        scope_detection_source: snapshot.detection_source,
        scope_include_untracked: snapshot.include_untracked,
        scope_changed_files: snapshot.changed_files,
        scope_changed_files_count: snapshot.changed_files_count,
        scope_changed_lines_total: snapshot.changed_lines_total,
        scope_changed_files_sha256: snapshot.changed_files_sha256,
        scope_content_sha256: snapshot.scope_content_sha256,
        scope_sha256: snapshot.scope_sha256
    });
    appendEvent(repoRoot, taskId, 'COMPILE_GATE_PASSED', 'PASS', {}, timestampUtc);
}



function buildReviewContextScopeFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflight = fs.existsSync(preflightPath)
        ? JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>
        : {};
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    return {
        tree_state: {
            schema_version: 1,
            detection_source: String(preflight.detection_source || 'explicit_changed_files'),
            changed_files: changedFiles,
            domain_scope_fingerprints: (preflight.metrics as Record<string, unknown> | undefined)?.domain_scope_fingerprints,
            tree_state_sha256: sha256Text(JSON.stringify({
                task_id: taskId,
                review_type: reviewType,
                changed_files: changedFiles
            }))
        },
        task_scope: {
            changed_files: changedFiles,
            diff: {
                available: changedFiles.length > 0,
                source: 'test_fixture',
                char_count: changedFiles.length > 0 ? 120 : 0,
                truncated: false,
                error: null
            }
        },
        scoped_diff: {
            expected: false,
            metadata_path: path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-scoped.json`),
            metadata: null
        }
    };
}

function writeReviewEvidence(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    options: {
        verdict?: 'pass' | 'fail';
        body?: string;
        includeLaunchArtifact?: boolean;
    } = {}
): void {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const passToken = reviewType === 'code' ? 'REVIEW PASSED' : `${reviewType.toUpperCase()} REVIEW PASSED`;
    const failToken = passToken.replace(/\bPASSED\b/g, 'FAILED');
    const verdictToken = options.verdict === 'fail' ? failToken : passToken;
    const reviewContextScope = buildReviewContextScopeFixture(repoRoot, taskId, reviewType);
    const reviewTreeState = reviewContextScope.tree_state as Record<string, unknown> | undefined;
    const reviewTreeStateSha256 = String(reviewTreeState?.tree_state_sha256 || '').trim();
    const domainScopeFingerprints = reviewTreeState?.domain_scope_fingerprints;
    const reviewContext = {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        ...reviewContextScope,
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`
        }
    };
    const reviewContextText = `${JSON.stringify(reviewContext, null, 2)}\n`;
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');
    const artifactText = `# ${reviewType} review\n\n${options.body || ''}## Verdict\n${verdictToken}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const routeIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: `agent:${reviewType}-reviewer`
    });
    const launchPreparedAtUtc = '2026-04-28T00:00:00.000Z';
    const delegationStartedAtUtc = '2026-04-28T00:00:01.000Z';
    const launchedAtUtc = delegationStartedAtUtc;
    const launchCompletedAtUtc = '2026-04-28T00:00:12.000Z';
    const invocationAttestedAtUtc = '2026-04-28T00:00:13.000Z';
    const reviewResultRecordedAtUtc = '2026-04-28T00:00:30.000Z';
    let reviewerLaunchArtifactSha256 = '';
    if (options.includeLaunchArtifact !== false) {
        const launchBindingSha256 = 'c'.repeat(64);
        const reviewerLaunchArtifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            reviewType,
            'reviewer-launch.json'
        );
        const preparedIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`,
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_artifact_path: reviewerLaunchArtifactPath
        });
        writeJson(reviewerLaunchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: `test-${reviewType}-invocation`,
            launch_prepared_at_utc: launchPreparedAtUtc,
            delegation_started_at_utc: delegationStartedAtUtc,
            launched_at_utc: launchedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc,
            ...launchInputEvidenceFixture(taskId, reviewType),
            fork_context: false
        });
        appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_STARTED', 'INFO', {
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`,
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            routing_event_sha256: routeIntegrity.event_sha256,
            provider_invocation_id: `test-${reviewType}-invocation`,
            delegation_started_at_utc: delegationStartedAtUtc
        });
        reviewerLaunchArtifactSha256 = fileSha256(reviewerLaunchArtifactPath);
        appendEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_COMPLETED', 'INFO', {
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`,
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            routing_event_sha256: routeIntegrity.event_sha256,
            reviewer_launch_artifact_path: reviewerLaunchArtifactPath,
            reviewer_launch_artifact_sha256: reviewerLaunchArtifactSha256,
            provider_invocation_id: `test-${reviewType}-invocation`,
            launch_prepared_at_utc: launchPreparedAtUtc,
            delegation_started_at_utc: delegationStartedAtUtc,
            launched_at_utc: launchedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc
        });
    }
    const invocationIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: `agent:${reviewType}-reviewer`,
        reviewer_identity: `agent:${reviewType}-reviewer`,
        review_context_sha256: sha256Text(reviewContextText),
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routeIntegrity.event_sha256,
        ...(reviewerLaunchArtifactSha256
            ? {
                reviewer_launch_artifact_path: path.join(
                    repoRoot,
                    'garda-agent-orchestrator',
                    'runtime',
                    'tmp',
                    'reviews',
                    taskId,
                    reviewType,
                    'reviewer-launch.json'
                ),
                reviewer_launch_artifact_sha256: reviewerLaunchArtifactSha256,
                reviewer_launch_attestation_source: 'test-subagent-spawn',
                reviewer_launch_tool: 'test-subagent-spawn',
                provider_invocation_id: `test-${reviewType}-invocation`,
                launch_prepared_at_utc: launchPreparedAtUtc,
                delegation_started_at_utc: delegationStartedAtUtc,
                launched_at_utc: launchedAtUtc,
                launch_completed_at_utc: launchCompletedAtUtc,
                launch_input_mode: launchInputEvidenceFixture(taskId, reviewType).launch_input_mode,
                launch_input_sha256: launchInputEvidenceFixture(taskId, reviewType).launch_input_sha256,
                copy_paste_reviewer_launch_prompt_sha256: launchInputEvidenceFixture(taskId, reviewType).copy_paste_reviewer_launch_prompt_sha256,
                invocation_attested_at_utc: invocationAttestedAtUtc
            }
            : {})
    });
    writeJson(receiptPath, {
        task_id: taskId,
        review_type: reviewType,
        preflight_sha256: fileSha256(preflightPath),
        trust_level: 'INDEPENDENT_AUDITED',
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: `agent:${reviewType}-reviewer`,
        review_artifact_sha256: sha256Text(artifactText),
        review_context_sha256: sha256Text(reviewContextText),
        review_tree_state_sha256: reviewTreeStateSha256,
        domain_scope_fingerprints: domainScopeFingerprints,
        reviewer_provenance: {
            schema_version: 1,
            attestation_type: 'reviewer_invocation_attestation',
            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
            task_sequence: invocationIntegrity.task_sequence,
            prev_event_sha256: invocationIntegrity.prev_event_sha256,
            event_sha256: invocationIntegrity.event_sha256,
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            review_tree_state_sha256: reviewTreeStateSha256,
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_prepared_at_utc: launchPreparedAtUtc,
            delegation_started_at_utc: delegationStartedAtUtc,
            launched_at_utc: launchedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc,
            invocation_attested_at_utc: invocationAttestedAtUtc
        },
        recorded_at_utc: reviewResultRecordedAtUtc,
        review_result_recorded_at_utc: reviewResultRecordedAtUtc,
        review_output_source_mtime_utc: reviewResultRecordedAtUtc
    });
}




function launchInputEvidenceFixture(taskId: string, reviewType: string): Record<string, unknown> {
    const copyPastePrompt = `Delegated ${reviewType} reviewer launch prompt for ${taskId}.`;
    const copyPastePromptSha256 = sha256Text(copyPastePrompt);
    return {
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        launch_input_mode: 'copy_paste_prompt',
        launch_input_sha256: copyPastePromptSha256,
        launch_input_copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256
    };
}




function seedReviewGatePass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-review-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'REVIEW_GATE_PASSED');
}



function seedFullSuiteValidation(
    repoRoot: string,
    taskId: string,
    status: 'PASSED' | 'FAILED' | 'SKIPPED' = 'PASSED',
    timestampUtc?: string
): void {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const timelineEvents = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const latestCompile = [...timelineEvents]
        .reverse()
        .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const cycleBinding = {
        task_id: taskId,
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: fileSha256(preflightPath),
        compile_gate_timestamp: String(latestCompile?.timestamp_utc || '')
    };
    const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const workflowConfig = fs.existsSync(workflowConfigPath)
        ? JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>
        : {};
    const fullSuiteConfig = workflowConfig.full_suite_validation
        && typeof workflowConfig.full_suite_validation === 'object'
        && !Array.isArray(workflowConfig.full_suite_validation)
        ? workflowConfig.full_suite_validation as Record<string, unknown>
        : {};
    const placement = String(fullSuiteConfig.placement || 'before_test_review');
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-full-suite-validation.json`), {
        task_id: taskId,
        status,
        enabled: true,
        command: 'npm test',
        placement,
        required: status === 'SKIPPED' ? false : undefined,
        skip_reason: status === 'SKIPPED' ? 'DOCS_ONLY_SCOPE_NOT_REQUIRED' : undefined,
        exit_code: status === 'PASSED' ? 0 : status === 'SKIPPED' ? null : 1,
        cycle_binding: cycleBinding,
        output_artifact_path: status === 'SKIPPED'
            ? null
            : path.join(reviewsRoot(repoRoot), `${taskId}-full-suite-output.log`)
    });
    appendEvent(
        repoRoot,
        taskId,
        status === 'PASSED'
            ? 'FULL_SUITE_VALIDATION_PASSED'
            : status === 'SKIPPED'
                ? 'FULL_SUITE_VALIDATION_SKIPPED'
                : 'FULL_SUITE_VALIDATION_FAILED',
        status === 'FAILED' ? 'FAIL' : 'PASS',
        { cycle_binding: cycleBinding, command: 'npm test', placement },
        timestampUtc
    );
}




afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step decomposed parent routing', () => {
    it('routes explicit decomposed parent tasks to the next unfinished child', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-500 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-501` through `T-503`; do not continue the monolithic implementation. |',
            '| T-501 | 🟩 DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-502 | 🟦 TODO | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Next. |',
            '| T-503 | 🟦 TODO | P1 | workflow | Child three | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-500', repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-502"'));
        assert.ok(result.reason.includes('T-500 -> T-502'));
        assert.ok(result.reason.includes('Before entering the selected child task, inspect workflow-config.full_suite_validation.command against that child scope.'));
        assert.ok(result.reason.includes('use the existing workflow set --full-suite-command route with required operator confirmation before enter-task-mode'));
        assert.ok(result.reason.includes('leave an already-suitable command unchanged'));
        assert.ok(text.includes('Status: DECOMPOSED'));
        assert.ok(text.includes('NextGate: child-task'));
    });

    it('preserves explicit parent-derived child range order instead of jumping to the endpoint', () => {
        const repoRoot = makeTempRepo();
        const childRows = Array.from({ length: 20 }, (_, index) => {
            const childNumber = index + 1;
            const status = childNumber < 13 ? '🟩 DONE' : '🟦 TODO';
            return `| T-625-${childNumber} | ${status} | P1 | workflow | Child ${childNumber} | gpt-5.4 | 2026-05-25 | strict | ${childNumber < 13 ? 'Complete.' : 'Pending.'} |`;
        });
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-625 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-25 | strict | Split into child tasks `T-625-1` through `T-625-20`; execute child tasks in this explicit order. |',
            ...childRows,
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-625', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-625-13"'));
        assert.equal(result.commands[0].command.includes('next-step "T-625-20"'), false);
        assert.ok(result.reason.includes('T-625 -> T-625-13'));
    });

    it('ignores parent and continuation mentions when routing nested decomposed parents', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-322 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-409`, `T-410`, `T-411`, and `T-412` through normal gates, then use parent routing only after children are complete. |',
            '| T-409 | 🟪 DECOMPOSED | P1 | workflow | Nested parent | gpt-5.5 | 2026-05-06 | strict | Child of `T-322`. Execute leaf tasks `T-413`, `T-414`, and `T-415` through normal gates, then continue `T-410`/`T-411`/`T-412`. |',
            '| T-413 | 🟪 DECOMPOSED | P1 | workflow | Nested advisory parent | gpt-5.5 | 2026-05-06 | strict | Child of `T-409`. Execute child tasks `T-416` and `T-417` through normal gates. Enforcement belongs to `T-410`; materialization belongs to `T-411`. |',
            '| T-416 | 🟩 DONE | P1 | workflow | Source child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-417 | 🟩 DONE | P1 | testing | Test child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-414 | 🟩 DONE | P1 | security | Path safety child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-415 | 🟦 TODO | P1 | testing | Advisory regressions | gpt-5.5 | 2026-05-06 | strict | Next leaf. |',
            '| T-410 | 🟦 TODO | P1 | workflow | Enforcement continuation | gpt-5.5 | 2026-05-06 | strict | Continue only after T-409 leaves. |',
            '| T-411 | 🟦 TODO | P1 | workflow | Materialization continuation | gpt-5.5 | 2026-05-06 | strict | Later. |',
            '| T-412 | 🟦 TODO | P1 | testing | Split cleanup continuation | gpt-5.5 | 2026-05-06 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const parentResult = resolveNextStep({ taskId: 'T-322', repoRoot });
        const nestedResult = resolveNextStep({ taskId: 'T-409', repoRoot });
        const completedNestedResult = resolveNextStep({ taskId: 'T-413', repoRoot });

        assert.equal(parentResult.status, 'DECOMPOSED');
        assert.equal(parentResult.next_gate, 'child-task');
        assert.ok(parentResult.commands[0].command.includes('next-step "T-415"'));
        assert.ok(parentResult.reason.includes('T-322 -> T-409 -> T-415'));
        assert.equal(parentResult.reason.includes('T-410'), false);

        assert.equal(nestedResult.status, 'DECOMPOSED');
        assert.equal(nestedResult.next_gate, 'child-task');
        assert.ok(nestedResult.commands[0].command.includes('next-step "T-415"'));
        assert.ok(nestedResult.reason.includes('T-409 -> T-415'));
        assert.equal(nestedResult.reason.includes('T-410'), false);

        assert.equal(completedNestedResult.status, 'DECOMPOSED');
        assert.equal(completedNestedResult.next_gate, 'task-audit-summary');
        assert.equal(completedNestedResult.commands.length, 1);
        assert.ok(completedNestedResult.reason.includes('transitioned completed parent task(s) to DONE: T-413'));
        assert.equal(completedNestedResult.reason.includes('T-410'), false);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-413 | 🟩 DONE |'));
    });

    it('does not route completed explicit leaves to same-sentence continuation tasks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-409 | 🟪 DECOMPOSED | P1 | workflow | Nested parent | gpt-5.5 | 2026-05-06 | strict | Child of `T-322`. Execute leaf tasks `T-413`, `T-414`, and `T-415` through normal gates, then continue `T-410`/`T-411`/`T-412`. |',
            '| T-413 | 🟩 DONE | P1 | workflow | Advisory child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-414 | 🟩 DONE | P1 | security | Path safety child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-415 | 🟩 DONE | P1 | testing | Advisory regressions | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-410 | 🟦 TODO | P1 | workflow | Enforcement continuation | gpt-5.5 | 2026-05-06 | strict | Continuation, not child of T-409. |',
            '| T-411 | 🟦 TODO | P1 | workflow | Materialization continuation | gpt-5.5 | 2026-05-06 | strict | Later. |',
            '| T-412 | 🟦 TODO | P1 | testing | Split cleanup continuation | gpt-5.5 | 2026-05-06 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-409', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'task-audit-summary');
        assert.equal(result.commands.length, 1);
        assert.ok(result.reason.includes('transitioned completed parent task(s) to DONE: T-409'));
        assert.equal(result.reason.includes('T-410'), false);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-409 | 🟩 DONE |'));
    });

    it('routes legacy BLOCKED split umbrella tasks through nested decomposed children', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-265 | 🟥 BLOCKED | P1 | review | Parent | gpt-5.4 | 2026-05-02 | strict | Paused for split. Split into strict child tasks `T-359` through `T-363`; do not continue the monolithic implementation unless reopened. |',
            '| T-359 | 🟩 DONE | P1 | review | Child | gpt-5.4 | 2026-05-02 | strict | Complete. |',
            '| T-360 | 🟩 DONE | P1 | review | Child | gpt-5.4 | 2026-05-02 | strict | Complete. |',
            '| T-361 | 🟩 DONE | P1 | review | Child | gpt-5.4 | 2026-05-02 | strict | Complete. |',
            '| T-362 | 🟥 BLOCKED | P1 | review | Nested parent | gpt-5.4 | 2026-05-02 | strict | Paused for split. Continue via child tasks `T-368` through `T-370`; do not continue the monolithic implementation. |',
            '| T-363 | 🟩 DONE | P1 | review | Child | gpt-5.4 | 2026-05-02 | strict | Complete. |',
            '| T-368 | 🟩 DONE | P1 | workflow | Child | gpt-5.4 | 2026-05-02 | strict | Complete. |',
            '| T-369 | 🟩 DONE | P1 | workflow | Child | gpt-5.4 | 2026-05-02 | strict | Complete. |',
            '| T-370 | 🟦 TODO | P1 | testing | Leaf | gpt-5.4 | 2026-05-02 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-265', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-370"'));
        assert.ok(result.reason.includes('T-265 -> T-362 -> T-370'));
        assert.ok(result.reason.includes('legacy BLOCKED split umbrella'));
    });

    it('does not run parent gates when a decomposed parent has no unfinished child', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-600 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-601` through `T-602`. |',
            '| T-601 | 🟩 DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-602 | 🟩 DONE | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-600', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'task-audit-summary');
        assert.equal(result.commands.length, 1);
        assert.ok(result.reason.includes('transitioned completed parent task(s) to DONE: T-600'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-600 | 🟩 DONE |'));
    });

    it('keeps aggregate acceptance visible after gate-owned child completion on repeated next-step calls', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-603 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-604` through `T-605`. |',
            '| T-604 | 🟩 DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-605 | 🟩 DONE | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const firstResult = resolveNextStep({ taskId: 'T-603', repoRoot });
        const secondResult = resolveNextStep({ taskId: 'T-603', repoRoot });

        assert.equal(firstResult.status, 'DECOMPOSED');
        assert.equal(firstResult.next_gate, 'task-audit-summary');
        assert.match(firstResult.commands[0]?.command || '', /gate task-audit-summary --task-id "T-603"/);
        assert.ok(firstResult.reason.includes('transitioned completed parent task(s) to DONE: T-603'));
        assert.equal(secondResult.status, 'BLOCKED');
        assert.equal(secondResult.next_gate, 'decomposed-parent-obligations');
        assert.equal(secondResult.commands.length, 0);
        assert.match(secondResult.reason, /Current parent decomposition reference is missing or invalid/);
        assert.doesNotMatch(secondResult.reason, /Treat this task as terminal/);
        assert.notEqual(secondResult.next_gate, 'task-reset');
    });

    it('does not treat ordinary blocked task notes as decomposed parents', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-610 | 🟥 BLOCKED | P1 | workflow | Blocked parent | gpt-5.4 | 2026-05-05 | strict | Blocked on umbrella finding in `T-611`; do not continue the monolithic implementation until security approves. |',
            '| T-611 | 🟦 TODO | P1 | workflow | Mentioned task | gpt-5.4 | 2026-05-05 | strict | Mentioned only. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-610', repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.status, 'DECOMPOSED');
        assert.notEqual(result.next_gate, 'child-task');
        assert.equal(text.includes('next-step "T-611"'), false);
    });

    it('blocks false DONE task rows instead of hiding stale lifecycle blockers', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-620 | 🟩 DONE | P1 | review | Closed parent | gpt-5.4 | 2026-05-05 | strict | Parent umbrella closed after split children completed. |',
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, 'T-620');
        writePreflight(repoRoot, 'T-620', { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, 'T-620');
        writeReviewEvidence(repoRoot, 'T-620', 'code', { verdict: 'fail' });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const staleParentChange = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: 'T-620', repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'task-reset');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('gate task-reset --task-id "T-620" --reopen --dry-run'));
        assert.match(result.reason, /TASK\.md marks "T-620" as DONE/);
        assert.match(result.reason, /current lifecycle evidence is not terminal-clean/);
        assert.match(result.reason, /completion-gate: missing or not passed/);
        assert.match(result.reason, /Completion-gate remains the only normal owner of DONE/);
        assert.match(result.reason, /Do not hand-edit TASK\.md or run stale lifecycle gates/);
        assert.equal(result.task_queue_status_contract.authority, 'gate_owned_status_sync');
        assert.deepEqual(result.task_queue_status_contract.agent_blocked_statuses, ['IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'SPLIT_REQUIRED']);
        assert.ok(text.includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));
        assert.equal(text.includes('classify-change'), false);
        assert.equal(text.includes('compile-gate'), false);
    });

    it('blocks false DONE task rows when full-suite evidence failed before completion', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-621 | 🟩 DONE | P1 | workflow | False done | gpt-5.4 | 2026-05-05 | strict | Queue status was edited despite failed validation. |',
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, 'T-621');
        writePreflight(repoRoot, 'T-621', { ...ALL_REVIEW_FLAGS, code: false, test: false });
        seedCompilePass(repoRoot, 'T-621');
        seedReviewGatePass(repoRoot, 'T-621');
        seedFullSuiteValidation(repoRoot, 'T-621', 'FAILED');

        const result = resolveNextStep({ taskId: 'T-621', repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'task-reset');
        assert.ok(result.commands[0].command.includes('gate task-reset --task-id "T-621" --reopen --dry-run'));
        assert.match(result.reason, /TASK\.md marks "T-621" as DONE/);
        assert.match(result.reason, /completion-gate: missing or not passed/);
        assert.match(result.reason, /full-suite-validation/i);
        assert.equal(text.includes('gate full-suite-validation'), false);
        assert.equal(text.includes('gate completion-gate'), false);
    });

    it('does not short-circuit reopened TODO rows with stale lifecycle evidence', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-622 | 🟦 TODO | P1 | review | Reopened parent | gpt-5.4 | 2026-05-05 | strict | Reopened for another lifecycle cycle. |',
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, 'T-622');
        writePreflight(repoRoot, 'T-622', { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, 'T-622');
        writeReviewEvidence(repoRoot, 'T-622', 'code', { verdict: 'fail' });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reopenedParentChange = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: 'T-622', repoRoot });

        assert.notEqual(result.status, 'DONE');
        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /Preflight scope is stale/);
        assert.ok(result.commands[0].command.includes('gate classify-change'));
    });
});
