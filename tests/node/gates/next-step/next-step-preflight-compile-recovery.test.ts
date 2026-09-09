import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { initGitRepo } from '../git-fixtures';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { getWorkspaceSnapshotCached } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { writeBalancedTestProfilesConfig } from './next-step-test-support';
import { buildDomainScopeFingerprints } from './next-step-test-support';
import {
    readCompileReadiness,
    readPreflightWorkspaceReadiness
} from '../../../../src/gates/next-step/next-step-compile-full-suite-readiness';
import {
    getPreflightRefreshChangedFiles,
    getTaskModeDirtyWorkspaceBaselineChangedFiles,
    getTaskModeDirtyWorkspaceBaselineFileHashes
} from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';

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
    writeBalancedTestProfilesConfig(repoRoot);
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
            schema_version: 2,
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

function writeGitAutoPreflight(
    repoRoot: string,
    taskId: string,
    requiredReviews: Record<string, boolean>
): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
    const domainScopeFingerprints = buildDomainScopeFingerprints({
        repoRoot,
        detectionSource: snapshot.detection_source,
        includeUntracked: snapshot.include_untracked,
        changedFiles: snapshot.changed_files
    });
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
            domain_scope_fingerprints: domainScopeFingerprints
        },
        required_reviews: requiredReviews,
        changed_files: snapshot.changed_files,
        review_execution_policy: {
            mode: 'code_first_optional',
            visible_summary_line: 'Review execution policy: code_first_optional'
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath)
    });
    seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
    return preflightPath;
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

function seedDocImpactPass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-doc-impact.json`), {
        task_id: taskId,
        decision: 'NO_DOC_UPDATES',
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'DOC_IMPACT_ASSESSED');
}






afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step preflight compile recovery', () => {
    it('keeps compile readiness current through the split compatibility facade', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);

        const readiness = readCompileReadiness(repoRoot, reviewsRoot(repoRoot), eventsRoot(repoRoot), TASK_ID, preflightPath);

        assert.equal(readiness.ready, true);
        assert.equal(readiness.reason, 'Compile gate evidence is current.');

    });

    it('recovers an explicit authorized-scope mismatch when an authorized file is unchanged', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'unchanged.ts'), 'export const unchanged = true;\n', 'utf8');
        initGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        const authorizedFiles = ['src/app.ts', 'src/unchanged.ts'];
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, authorizedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            scope_category: 'code',
            metrics: {
                authorized_files_count: snapshot.authorized_files_count,
                authorized_files_sha256: snapshot.authorized_files_sha256,
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            required_reviews: { ...ALL_REVIEW_FLAGS },
            authorized_files: snapshot.authorized_files,
            changed_files: snapshot.changed_files
        });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), {
            timestamp_utc: new Date().toISOString(),
            task_id: TASK_ID,
            event_source: 'compile-gate',
            status: 'PASSED',
            outcome: 'PASS',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_hash_sha256: fileSha256(preflightPath),
            scope_detection_source: snapshot.detection_source,
            scope_include_untracked: snapshot.include_untracked,
            scope_authorized_files: snapshot.authorized_files,
            scope_authorized_files_count: snapshot.authorized_files_count,
            scope_authorized_files_sha256: snapshot.authorized_files_sha256,
            scope_changed_files: snapshot.changed_files,
            scope_changed_files_count: snapshot.changed_files_count,
            scope_changed_lines_total: snapshot.changed_lines_total,
            scope_changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256
        });

        const readiness = readCompileReadiness(
            repoRoot,
            reviewsRoot(repoRoot),
            eventsRoot(repoRoot),
            TASK_ID,
            preflightPath
        );

        assert.equal(readiness.ready, true);
        assert.equal(readiness.reason, 'Compile gate evidence is current.');

        const compilePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`);
        const malformedEvidence = JSON.parse(fs.readFileSync(compilePath, 'utf8')) as Record<string, unknown>;
        malformedEvidence.scope_authorized_files_count = `${snapshot.authorized_files_count}corrupt`;
        writeJson(compilePath, malformedEvidence);

        const malformedReadiness = readCompileReadiness(
            repoRoot,
            reviewsRoot(repoRoot),
            eventsRoot(repoRoot),
            TASK_ID,
            preflightPath
        );
        assert.equal(malformedReadiness.ready, false);
        assert.equal(
            malformedReadiness.reason,
            'Compile gate authorized scope evidence is invalid; rerun compile-gate.'
        );

        malformedEvidence.scope_authorized_files_count = snapshot.authorized_files_count;
        malformedEvidence.scope_authorized_files_sha256 = '0'.repeat(64);
        writeJson(compilePath, malformedEvidence);

        const mismatchedHashReadiness = readCompileReadiness(
            repoRoot,
            reviewsRoot(repoRoot),
            eventsRoot(repoRoot),
            TASK_ID,
            preflightPath
        );
        assert.equal(mismatchedHashReadiness.ready, false);
        assert.equal(
            mismatchedHashReadiness.reason,
            'Compile gate authorized scope evidence is invalid; rerun compile-gate.'
        );
    });

    it('keeps preflight workspace readiness stale when the materialized diff changes', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 3;\n', 'utf8');

        const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
            allowDocsOnlyDelta: false
        });

        assert.equal(readiness.ready, false);
        assert.match(readiness.reason, /Preflight scope is stale before compile/);
        assert.match(readiness.reason, /scope_content_sha256/);
    });

    it('rejects dirty-baseline aliases and external symlinks before next-step hashes or refreshes them', () => {
        const repoRoot = makeTempRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-external-'));
        tempRoots.push(externalRoot);
        const externalSecretPath = path.join(externalRoot, 'secret.ts');
        const externalSecretContent = 'export const secret = true;\n';
        const externalLinkPath = path.join(repoRoot, 'src', 'external-link.ts');
        const traversalAlias = 'src/../src/external-link.ts';
        const absoluteAlias = externalLinkPath;
        fs.writeFileSync(externalSecretPath, externalSecretContent, 'utf8');
        initGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        try {
            fs.symlinkSync(externalSecretPath, externalLinkPath, 'file');
        } catch {
            return;
        }
        const externalHash = sha256Text(externalSecretContent);
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.triggers = {
            dirty_workspace_protected_files: [traversalAlias, absoluteAlias, 'src/external-link.ts'],
            dirty_workspace_protected_file_hashes: {
                [traversalAlias]: externalHash,
                [absoluteAlias]: externalHash,
                'src/external-link.ts': externalHash
            },
            dirty_workspace_baseline_changed_files: [traversalAlias, absoluteAlias, 'src/external-link.ts']
        };
        const taskMode = {
            orchestrator_work: true,
            dirty_workspace_baseline: {
                changed_files: [traversalAlias, absoluteAlias, 'src/external-link.ts'],
                file_hashes: {
                    [traversalAlias]: externalHash,
                    [absoluteAlias]: externalHash,
                    'src/external-link.ts': externalHash
                }
            }
        };
        const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
            dirtyWorkspaceBaselineChangedFiles: taskMode.dirty_workspace_baseline.changed_files,
            dirtyWorkspaceBaselineFileHashes: taskMode.dirty_workspace_baseline.file_hashes,
            allowDocsOnlyDelta: false
        });
        assert.equal(readiness.ready, false);
        assert.match(readiness.reason, /missing from preflight: \[src\/external-link\.ts\]/);
        assert.deepEqual(getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode), []);
        assert.deepEqual(getTaskModeDirtyWorkspaceBaselineFileHashes(repoRoot, taskMode), {});
        assert.deepEqual(getPreflightRefreshChangedFiles(repoRoot, taskMode, preflight), ['src/app.ts']);
    });

    it('keeps valid in-root dirty-baseline files usable after alias normalization', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        const changedContent = 'export const owned = true;\n';
        const changedPath = 'src/owned.ts';
        const traversalAlias = 'src/../src/owned.ts';
        const absoluteAlias = path.join(repoRoot, changedPath);
        fs.writeFileSync(path.join(repoRoot, changedPath), changedContent, 'utf8');

        const ownedHash = sha256Text(changedContent);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: [changedPath]
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.changed_files = [changedPath];
        preflight.triggers = {
            dirty_workspace_protected_files: [traversalAlias, absoluteAlias, changedPath],
            dirty_workspace_protected_file_hashes: {
                [traversalAlias]: ownedHash,
                [absoluteAlias]: ownedHash,
                [changedPath]: ownedHash
            },
            dirty_workspace_baseline_changed_files: [traversalAlias, absoluteAlias, changedPath]
        };
        const taskMode = {
            orchestrator_work: true,
            dirty_workspace_baseline: {
                changed_files: [traversalAlias, absoluteAlias, changedPath],
                file_hashes: {
                    [traversalAlias]: ownedHash,
                    [absoluteAlias]: ownedHash,
                    [changedPath]: ownedHash
                }
            }
        };

        assert.deepEqual(getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode), [changedPath]);
        assert.deepEqual(getTaskModeDirtyWorkspaceBaselineFileHashes(repoRoot, taskMode), {
            [changedPath]: ownedHash
        });
        assert.deepEqual(getPreflightRefreshChangedFiles(repoRoot, taskMode, preflight), [changedPath]);
    });

    it('keeps planned-scope readiness waiting until the planned source diff materializes', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        const plannedPath = 'src/new-feature.ts';
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, [plannedPath]);
        const preflight = {
            task_id: TASK_ID,
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            scope_category: 'code',
            metrics: {
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            changed_files: [plannedPath],
            required_reviews: {
                code: true
            }
        };

        const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
            plannedChangedFiles: [plannedPath],
            allowDocsOnlyDelta: false
        });

        assert.equal(readiness.ready, false);
        assert.equal(readiness.awaitingMaterializedPlannedScope, true);
        assert.match(readiness.reason, /current git workspace has no materialized diff/);
    });

    it('routes refreshed preflight after a closed cycle to restart-coherent-cycle before downstream gates', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(result.reason.includes('Latest PREFLIGHT_CLASSIFIED'));
        assert.ok(result.reason.includes('HANDSHAKE_DIAGNOSTICS_RECORDED'));
        assert.ok(result.commands[0].command.includes('gate restart-coherent-cycle'));
        assert.ok(result.commands[0].command.includes('--preflight-path'));
        assert.ok(result.commands[0].command.includes(
            "--task-intent 'Make next-step output executable in tests'"
        ));
        assert.ok(!result.commands[0].command.includes("--task-intent 'Seeded next-step task'"));
    });

    it('prints operator confirmation placeholders for protected coherent-cycle restart commands', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Restart protected coherent cycle',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: ['src/app.ts']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(command.includes('gate restart-coherent-cycle'));
        assert.ok(command.includes("--task-intent 'Make next-step output executable in tests'"));
        assert.ok(!command.includes("--task-intent 'Restart protected coherent cycle'"));
        assert.ok(command.includes('--operator-confirmed yes'));
        assert.ok(command.includes("--operator-confirmed-at-utc '<ISO-8601 timestamp>'"));
    });

    it('routes preflight refreshed after implementation compile and review phase to restart before expensive gates', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, TASK_ID, 'IMPLEMENTATION_STARTED', 'INFO');
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(result.reason.includes('REVIEW_PHASE_STARTED'));
        assert.ok(result.reason.includes('HANDSHAKE_DIAGNOSTICS_RECORDED'));
        assert.ok(result.reason.includes('expensive review work'));
        assert.ok(result.commands[0].command.includes('gate restart-coherent-cycle'));
        assert.ok(!['compile-gate', 'build-review-context', 'prepare-reviewer-launch', 'required-reviews-check'].includes(result.next_gate));
    });

    it('blocks restarted compile recovery when the persisted restart-completed event is missing', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);

        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(result.reason.includes('no persisted restart-completed event'));
        assert.ok(result.reason.includes('stdout-only success'));
        assert.ok(result.commands[0].command.includes('gate restart-coherent-cycle'));
    });

    it('accepts restarted compile recovery when the persisted restart-completed event matches current artifacts', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);

        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const compileEvidencePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`);
        appendEvent(repoRoot, TASK_ID, 'COHERENT_CYCLE_RESTARTED', 'PASS', {
            restart_event_schema_version: 1,
            task_id: TASK_ID,
            event_type: 'COHERENT_CYCLE_RESTARTED',
            task_mode_path: taskModePath.replace(/\\/g, '/'),
            task_mode_sha256: fileSha256(taskModePath),
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: fileSha256(preflightPath),
            compile_evidence_path: compileEvidencePath.replace(/\\/g, '/'),
            compile_evidence_sha256: fileSha256(compileEvidencePath),
            detected_changed_files_count: 1,
            elapsed_ms: 1,
            restart_reason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
            next_step_summary: 'continue after persisted restart evidence'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'restart-coherent-cycle', result.reason);
    });

    it('accepts persisted restart evidence when recovery flow records preflight after implementation boundary', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'IMPLEMENTATION_STARTED', 'INFO');
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const compileEvidencePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`);
        appendEvent(repoRoot, TASK_ID, 'COHERENT_CYCLE_RESTARTED', 'PASS', {
            restart_event_schema_version: 1,
            task_id: TASK_ID,
            event_type: 'COHERENT_CYCLE_RESTARTED',
            task_mode_path: taskModePath.replace(/\\/g, '/'),
            task_mode_sha256: fileSha256(taskModePath),
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: fileSha256(preflightPath),
            compile_evidence_path: compileEvidencePath.replace(/\\/g, '/'),
            compile_evidence_sha256: fileSha256(compileEvidencePath),
            detected_changed_files_count: 1,
            elapsed_ms: 1,
            restart_reason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
            next_step_summary: 'continue after persisted restart evidence'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'restart-coherent-cycle', result.reason);
    });

    it('blocks restarted compile recovery when restart evidence points to a stale compile artifact', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);

        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID, '2026-07-01T00:00:00.000Z');
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const compileEvidencePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`);
        const staleCompileEvidencePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate-stale.json`);
        fs.copyFileSync(compileEvidencePath, staleCompileEvidencePath);
        seedCompilePass(repoRoot, TASK_ID, '2026-07-01T00:01:00.000Z');
        appendEvent(repoRoot, TASK_ID, 'COHERENT_CYCLE_RESTARTED', 'PASS', {
            restart_event_schema_version: 1,
            task_id: TASK_ID,
            event_type: 'COHERENT_CYCLE_RESTARTED',
            task_mode_path: taskModePath.replace(/\\/g, '/'),
            task_mode_sha256: fileSha256(taskModePath),
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: fileSha256(preflightPath),
            compile_evidence_path: staleCompileEvidencePath.replace(/\\/g, '/'),
            compile_evidence_sha256: fileSha256(staleCompileEvidencePath),
            detected_changed_files_count: 1,
            elapsed_ms: 1,
            restart_reason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
            next_step_summary: 'continue after persisted restart evidence'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(result.reason.includes('compile_evidence_path does not match the latest compile evidence artifact'));
        assert.ok(result.commands[0].command.includes('gate restart-coherent-cycle'));
    });

    it('routes refreshed preflight after a failed completion cycle to restart-coherent-cycle', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(result.reason.includes('COMPLETION_GATE_FAILED'));
        assert.ok(result.reason.includes('SHELL_SMOKE_PREFLIGHT_RECORDED'));
        assert.ok(result.commands[0].command.includes('gate restart-coherent-cycle'));
    });

    it('routes stale preflight scope back to classify-change before compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const drift = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('Preflight scope is stale before compile'));
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.ok(result.commands[0].command.includes('--changed-file "src/app.ts"'));
        assert.deepEqual(result.invalidation_impact?.stale_artifact_classes, ['preflight/scope', 'compile evidence']);
        assert.deepEqual(result.invalidation_impact?.minimal_recovery_chain, [
            'classify-change',
            'rerun navigator for POST_PREFLIGHT, compile, and review refresh decisions'
        ]);
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, ['none indicated']);

        const text = formatNextStepText(result);
        assert.match(text, /InvalidationImpact:/);
        assert.match(text, /StaleArtifacts: preflight\/scope, compile evidence/);
        assert.match(text, /MinimalRecoveryChain: classify-change -> rerun navigator for POST_PREFLIGHT, compile, and review refresh decisions/);
    });

    it('reruns compile after a scope-drift compile failure is recovered by newer preflight evidence', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const oldPreflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const oldPreflightHash = fileSha256(oldPreflightPath);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const drift = 2;\n', 'utf8');
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), {
            timestamp_utc: new Date().toISOString(),
            task_id: TASK_ID,
            event_source: 'compile-gate',
            status: 'FAILED',
            outcome: 'FAIL',
            error:
                'Preflight scope drift detected. Refresh preflight for the current scope before compile: rerun classify-change, rerun load-rule-pack --stage POST_PREFLIGHT, and then rerun compile-gate.',
            preflight_path: oldPreflightPath.replace(/\\/g, '/'),
            preflight_hash_sha256: oldPreflightHash
        });
        appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_FAILED', 'FAIL');
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.ok(result.reason.includes('failed compile evidence is no longer current'), result.reason);
        assert.ok(result.reason.includes('predates latest preflight'), result.reason);
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
    });

    it('includes failed compile infra recovery hints in compile-gate recovery text', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), {
            timestamp_utc: new Date().toISOString(),
            task_id: TASK_ID,
            event_source: 'compile-gate',
            status: 'FAILED',
            outcome: 'FAIL',
            error: 'Compile command failed.',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_hash_sha256: fileSha256(preflightPath),
            infra_recovery_hint: {
                kind: 'docker_daemon_unavailable',
                title: 'Docker daemon is unavailable to the compile command.',
                hint:
                    'Start Docker Desktop or the Docker service, verify "docker info" works in this shell, ' +
                    'then rerun next-step before compile-gate.'
            }
        });
        appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_FAILED', 'FAIL');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.ok(result.reason.includes('InfraRecoveryHint:'), result.reason);
        assert.ok(result.reason.includes('Docker daemon is unavailable'), result.reason);
        assert.ok(text.includes('InfraRecoveryHint:'), text);
        assert.ok(text.includes('docker info'), text);
    });

    it('routes protected manifest compile failure to a fresh orchestrator-work task-mode entry', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), {
            timestamp_utc: new Date().toISOString(),
            task_id: TASK_ID,
            event_source: 'compile-gate',
            status: 'FAILED',
            outcome: 'FAIL',
            error:
                'Trusted protected control-plane manifest was already drifted before task start: src/app.ts. ' +
                `Restart task mode with: node bin/garda.js gate enter-task-mode --task-id "${TASK_ID}" ` +
                '--orchestrator-work --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_hash_sha256: fileSha256(preflightPath)
        });
        appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_FAILED', 'FAIL');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.match(result.reason, /protected task-mode restart/iu);
        assert.ok(result.commands[0].command.includes('gate enter-task-mode'));
        assert.ok(result.commands[0].command.includes('--orchestrator-work'));
        assert.ok(result.commands[0].command.includes('--upgrade-existing-task-mode'));
        assert.ok(result.commands[0].command.includes('--operator-confirmed-at-utc "<ISO-8601 timestamp>"'));
        assert.ok(!result.commands[0].command.includes('gate compile-gate'));

        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        appendEvent(repoRoot, TASK_ID, 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'PASS');
        appendEvent(repoRoot, TASK_ID, 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PASS');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const recoveredResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(recoveredResult.next_gate, 'compile-gate', recoveredResult.reason);
        assert.match(recoveredResult.reason, /predates the latest task-mode restart/iu);
        assert.ok(recoveredResult.commands[0].command.includes('gate compile-gate'));
        assert.ok(!recoveredResult.commands[0].command.includes('gate enter-task-mode'));
    });

    it('refreshes explicit preflight when later rework adds a source file after review evidence exists', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = 2;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'gates', 'task-audit-summary.ts'),
            'export const auditSummaryRefresh = true;\n',
            'utf8'
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('missing from preflight: [src/gates/task-audit-summary.ts]'));
        assert.ok(result.commands[0].command.includes('--changed-file "src/app.ts"'));
        assert.ok(result.commands[0].command.includes('--changed-file "src/gates/task-audit-summary.ts"'));
        assert.ok(!result.commands[0].command.includes('build-review-context'));
    });

    it('refreshes explicit preflight before full-suite when the current git snapshot has a new file', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: true,
                command: 'npm test',
                placement: 'before_test_review'
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            }
        });
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned-only preflight with a cross-domain task delta',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: ['src/app.ts']
        }));
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = 2;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('stale preflight authorized file set [src/app.ts] differs from current git snapshot [package.json, src/app.ts]'));
        assert.ok(result.reason.includes('missing from preflight: [package.json]'));
        assert.ok(!result.commands[0].command.includes('full-suite-validation'));
        assert.ok(result.commands[0].command.includes('--changed-file "src/app.ts"'));
        assert.ok(result.commands[0].command.includes('--changed-file "package.json"'));
    });

    it('rejects cross-domain task deltas hidden by a materialized planned-only preflight', () => {
        const repoRoot = makeTempRepo();
        fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'planned.test.ts'), 'export const planned = 1;\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'tests', 'node', 'planned.test.ts'), 'export const changed = 2;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: ['tests/node/planned.test.ts'],
            seedPostPreflight: false
        });
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');

        const readiness = readPreflightWorkspaceReadiness(
            repoRoot,
            JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            { plannedChangedFiles: ['tests/node/planned.test.ts'] }
        );

        assert.equal(readiness.ready, false);
        assert.match(readiness.reason, /missing from preflight: \[package\.json\]/u);
        assert.deepEqual(readiness.currentChangedFiles, ['package.json', 'tests/node/planned.test.ts']);
    });

    it('does not reintroduce stale protected dirty-baseline files into stale preflight refresh commands', () => {
        const repoRoot = makeTempRepo();
        const legacyPath = path.join(repoRoot, 'src', 'legacy.ts');
        fs.writeFileSync(legacyPath, 'export const legacy = 1;\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = 2;\n', 'utf8');
        fs.appendFileSync(legacyPath, 'export const temporary = 2;\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh stale protected dirty baseline scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: baselineSnapshot.changed_files,
            dirtyWorkspaceBaseline: {
                detection_source: baselineSnapshot.detection_source,
                include_untracked: baselineSnapshot.include_untracked,
                changed_files: baselineSnapshot.changed_files,
                changed_files_sha256: baselineSnapshot.changed_files_sha256,
                scope_sha256: baselineSnapshot.scope_sha256,
                file_hashes: Object.fromEntries(
                    baselineSnapshot.changed_files.map((changedFile) => [
                        changedFile,
                        fileSha256(path.join(repoRoot, changedFile))
                    ])
                )
            }
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: baselineSnapshot.changed_files
        });
        seedCompilePass(repoRoot, TASK_ID);
        fs.writeFileSync(legacyPath, 'export const legacy = 1;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /no longer current: \[src\/legacy\.ts\]/);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('--changed-file "src/legacy.ts"'));
    });

    it('keeps planned ignored workflow-config files comparable during preflight freshness checks', () => {
        const repoRoot = makeTempRepo();
        const workflowConfigFile = 'garda-agent-orchestrator/live/config/workflow-config.json';
        initGitRepo(repoRoot, {
            gitignoreContent: [
                'garda-agent-orchestrator/runtime/',
                `${workflowConfigFile}`,
                ''
            ].join('\n')
        });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = 2;\n', 'utf8');
        writeJson(path.join(repoRoot, workflowConfigFile), {
            full_suite_validation: {
                enabled: true,
                command: 'npm test',
                placement: 'after_compile_before_reviews'
            }
        });
        const changedFiles = [workflowConfigFile, 'src/app.ts'];
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

        const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
            plannedChangedFiles: changedFiles,
            dirtyWorkspaceBaselineChangedFiles: changedFiles,
            dirtyWorkspaceBaselineFileHashes: {
                [workflowConfigFile]: fileSha256(path.join(repoRoot, workflowConfigFile)),
                'src/app.ts': fileSha256(path.join(repoRoot, 'src', 'app.ts'))
            }
        });

        assert.equal(readiness.ready, true, readiness.reason);
        assert.ok(!readiness.reason.includes('no longer current'), readiness.reason);
    });

    it('keeps explicitly planned dirty-baseline files current before failed-review remediation', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        const changedFile = 'src/app.ts';
        fs.writeFileSync(path.join(repoRoot, changedFile), 'export const value = 2;\n', 'utf8');
        const changedFiles = [changedFile];
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

        const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: 'code',
            failedReviewVerdict: 'REVIEW FAILED',
            plannedChangedFiles: changedFiles,
            dirtyWorkspaceBaselineChangedFiles: baselineSnapshot.changed_files,
            dirtyWorkspaceBaselineFileHashes: {
                [changedFile]: fileSha256(path.join(repoRoot, changedFile))
            },
            allowDocsOnlyDelta: false
        });

        assert.equal(readiness.ready, true, readiness.reason);
        assert.deepEqual(readiness.currentChangedFiles, changedFiles);
    });

    it('keeps dirty-baseline files in stale preflight refresh commands when they changed after task start', () => {
        const repoRoot = makeTempRepo();
        const legacyPath = path.join(repoRoot, 'src', 'legacy.ts');
        fs.writeFileSync(legacyPath, 'export const legacy = 1;\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = 2;\n', 'utf8');
        fs.appendFileSync(legacyPath, 'export const taskStartBaseline = 2;\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh stale dirty baseline scope after new edits',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: ['src/app.ts'],
            dirtyWorkspaceBaseline: {
                detection_source: baselineSnapshot.detection_source,
                include_untracked: baselineSnapshot.include_untracked,
                changed_files: baselineSnapshot.changed_files,
                changed_files_sha256: baselineSnapshot.changed_files_sha256,
                scope_sha256: baselineSnapshot.scope_sha256,
                file_hashes: Object.fromEntries(
                    baselineSnapshot.changed_files.map((changedFile) => [
                        changedFile,
                        fileSha256(path.join(repoRoot, changedFile))
                    ])
                )
            }
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: ['src/app.ts']
        });
        seedCompilePass(repoRoot, TASK_ID);
        fs.appendFileSync(legacyPath, 'export const postStartEdit = 3;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /missing from preflight: \[src\/legacy\.ts\]/);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "src/legacy.ts"'));
    });

    it('drops line-ending-restored files from stale preflight refresh commands', () => {
        const repoRoot = makeTempRepo();
        const eolPath = path.join(repoRoot, 'src', 'line-ending.ts');
        fs.writeFileSync(eolPath, 'export const lineEnding = 1;\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = 2;\n', 'utf8');
        fs.writeFileSync(eolPath, 'export const lineEnding = 1;\r\n', 'utf8');
        const staleScope = ['src/app.ts', 'src/line-ending.ts'];
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: staleScope
        });
        seedCompilePass(repoRoot, TASK_ID);
        fs.writeFileSync(eolPath, 'export const lineEnding = 1;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /no longer current: \[src\/line-ending\.ts\]/);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('--changed-file "src/line-ending.ts"'));
    });

    it('preserves explicit preflight scope when an unchanged dirty baseline predates normal task mode', () => {
        const repoRoot = makeTempRepo();
        const legacyPath = path.join(repoRoot, 'src', 'legacy.ts');
        fs.writeFileSync(legacyPath, 'export const legacy = 1;\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(legacyPath, 'export const userBaseline = 2;\n', 'utf8');
        const legacyBaselineHash = fileSha256(legacyPath);
        seedStartedTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const taskChange = 2;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: ['src/app.ts']
        });
        const appSnapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const metrics = preflight.metrics as Record<string, unknown>;
        metrics.actual_changed_files = appSnapshot.changed_files;
        metrics.actual_changed_files_sha256 = appSnapshot.changed_files_sha256;
        preflight.authorized_files = ['src/app.ts'];
        preflight.include_untracked = true;
        preflight.triggers = {
            dirty_workspace_baseline_changed_files: ['src/legacy.ts'],
            dirty_workspace_protected_files: ['src/legacy.ts'],
            dirty_workspace_protected_file_hashes: {
                'src/legacy.ts': legacyBaselineHash
            }
        };
        writeJson(preflightPath, preflight);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const refreshedTaskChange = 3;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        assert.ok(!command.includes('--changed-file "src/legacy.ts"'), command);
    });
});
