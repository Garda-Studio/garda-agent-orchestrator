import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import type { EffectiveReviewExecutionPolicyMode } from '../../../../src/core/review-execution-policy';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import {
    buildTaskProfilePolicySnapshot,
    type TaskProfilePolicySnapshot
} from '../../../../src/policy/task-profile-policy-snapshot';
import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { assertGateChainDecision } from '../../cli/commands/gate-test-gatechain';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildTaskAuditSummary, synchronizeFinalCloseoutArtifacts } from './next-step-test-support';
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

const FORBIDDEN_DEFAULT_REVIEWER_RESERVATION_GUIDANCE = [
    'STANDBY',
    'standby',
    'idle wait',
    'idle reviewer',
    'resumable session',
    'resumable reviewer',
    'reviewer reservation',
    'pre-launch reviewer reservation',
    'reserve a reviewer',
    'keep the reviewer alive',
    'wait for further instructions'
];

function assertNoDefaultReviewerReservationGuidance(text: string): void {
    for (const forbiddenText of FORBIDDEN_DEFAULT_REVIEWER_RESERVATION_GUIDANCE) {
        assert.equal(
            text.includes(forbiddenText),
            false,
            `default reviewer launch guidance must not include ${forbiddenText}`
        );
    }
}

let tempRoots: string[] = [];

const LATENCY_PLANNED_FILES = Array.from({ length: 34 }, (_, index) => `src/planned-${index}.ts`);

function resolveLaunchWithoutUnusedIgnoreReads(repoRoot: string): ReturnType<typeof resolveNextStep> {
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const originalSpawnSync = childProcess.spawnSync;
    const originalExecFileSync = childProcess.execFileSync;
    let ignoreCalls = 0;
    let trackedWorkspaceReadCalls = 0;
    let untrackedWorkspaceReadCalls = 0;
    childProcess.spawnSync = ((file: string, args: string[], options: unknown) => {
        if (file === 'git' && args.includes('check-ignore')) ignoreCalls++;
        return originalSpawnSync(file, args, options as never);
    }) as typeof originalSpawnSync;
    childProcess.execFileSync = ((file: string, args: string[], options: unknown) => {
        if (file === 'git' && args.includes('--name-only')) {
            trackedWorkspaceReadCalls++;
            return `${['src/app.ts', ...LATENCY_PLANNED_FILES].join('\n')}\n`;
        }
        if (file === 'git' && args.includes('--others')) {
            untrackedWorkspaceReadCalls++;
            return '';
        }
        return originalExecFileSync(file, args, options as never);
    }) as typeof originalExecFileSync;
    try {
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(ignoreCalls, 2, 'full route retains only the two required ignored-file queries');
        assert.equal(trackedWorkspaceReadCalls, 1, 'resolveNextStep shares one successful tracked workspace read');
        assert.equal(untrackedWorkspaceReadCalls, 1, 'resolveNextStep shares one successful untracked workspace read');
        return result;
    } finally {
        childProcess.spawnSync = originalSpawnSync;
        childProcess.execFileSync = originalExecFileSync;
    }
}


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
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Balanced test profile',
                depth: 2,
                task_decomposition: { enabled: false },
                review_policy: { code: 'auto', test: 'auto' },
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: true,
                    compact_reviewer_output: true
                },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    });
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


function writeProjectMemoryWorkflowConfig(
    repoRoot: string,
    options: { enabled?: boolean; mode?: 'off' | 'check' | 'update' | 'strict'; fullSuiteEnabled?: boolean } = {}
): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = options.fullSuiteEnabled ?? false;
    config.full_suite_validation.command = 'npm test';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.project_memory_maintenance.enabled = options.enabled ?? true;
    config.project_memory_maintenance.mode = options.mode ?? 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
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
    timestampUtc?: string,
    actor = 'gate'
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
        actor,
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

function appendRestartBoundary(
    repoRoot: string,
    taskId: string,
    eventType: 'COHERENT_CYCLE_RESTARTED' | 'REVIEW_CYCLE_RESTARTED',
    options: {
        invalidatedReviewTypes?: unknown;
        preservedReviewTypes?: string[];
        actor?: string;
        outcome?: string;
        detailsTaskId?: string;
        detailsEventType?: string;
        status?: string;
    } = {}
): void {
    appendEvent(repoRoot, taskId, eventType, options.outcome || 'PASS', {
        task_id: options.detailsTaskId || taskId,
        event_type: options.detailsEventType || eventType,
        status: options.status || 'PASSED',
        invalidated_review_types: options.invalidatedReviewTypes ?? [],
        preserved_review_types: options.preservedReviewTypes || []
    }, undefined, options.actor || 'orchestrator');
}

function seedStartedTask(
    repoRoot: string,
    taskId: string,
    reviewPolicyMode: EffectiveReviewExecutionPolicyMode = 'code_first_optional',
    plannedChangedFiles: string[] = []
): void {
    const taskModePath = path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    const profilePolicySnapshot = buildTaskProfilePolicySnapshot(
        path.join(repoRoot, 'garda-agent-orchestrator'),
        'balanced',
        {
            reviewExecutionPolicyMode: reviewPolicyMode,
            reviewExecutionPolicyConfigured: true,
            fullSuiteValidationEnabled: false,
            fullSuiteValidationPlacement: 'after_compile_before_reviews',
            lockTimestampUtc: '2026-04-25T00:00:00.000Z'
        }
    );
    writeJson(taskModePath, buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded next-step task',
        plannedChangedFiles,
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved',
        taskProfile: 'balanced',
        profileSelectionSource: 'task_queue',
        activeProfile: 'balanced',
        profileSource: 'built_in',
        runtimeActiveProfile: 'balanced',
        runtimeProfileSource: 'built_in',
        profilePolicySnapshot
    }));
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', {
        artifact_path: normalizeForTimeline(taskModePath),
        start_banner: 'Garda captures my mind',
        canonical_source_of_truth: 'Codex',
        execution_provider_source: 'explicit_provider',
        runtime_identity_status: 'resolved',
        runtime_identity_violations: [],
        profile_policy_snapshot_required: true,
        profile_policy_snapshot_hash: profilePolicySnapshot.snapshot_hash
    });
    seedRulePack(repoRoot, taskId, 'TASK_ENTRY', taskModePath);
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
    const catalog = normalizeReviewCatalog(
        { version: 1, custom_review_types: [] },
        { knownSkillIds: [] }
    );
    const taskModePath = path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
    const frozenProfileSnapshot = taskMode.profile_policy_snapshot as TaskProfilePolicySnapshot;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        frozenProfileSnapshot.source.effective_profile,
        frozenProfileSnapshot.review_lane_selection.profile_review_policy,
        frozenProfileSnapshot.review_lane_selection.review_capabilities as ReviewCapabilitiesConfigMap,
        catalog
    );
    const effectiveReviewSnapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: frozenProfileSnapshot.snapshot_hash,
        legacyRequiredReviews: requiredReviews,
        scopeCategory: 'code',
        taskIntent: 'Exercise next-step reviewer launch routing',
        changedFiles,
        taskTriggers: {},
        reviewExecutionPolicyMode: reviewPolicyMode as EffectiveReviewExecutionPolicyMode,
        reviewDependencyGraph: null,
        fullSuiteValidation: {
            enabled: false,
            placement: 'after_compile_before_reviews'
        },
        includeDependencyGraph: true
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
            ...(domainScopeFingerprints ? { domain_scope_fingerprints: domainScopeFingerprints } : {})
        },
        required_reviews: requiredReviews,
        changed_files: changedFiles,
        profile_policy_snapshot: {
            snapshot_hash: frozenProfileSnapshot.snapshot_hash
        },
        review_execution_policy: {
            mode: reviewPolicyMode,
            visible_summary_line: `Review execution policy: ${reviewPolicyMode}`,
            dependency_graph: effectiveReviewSnapshot.review_dependency_graph
        },
        effective_review_snapshot: effectiveReviewSnapshot
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath),
        effective_review_snapshot: effectiveReviewSnapshot
    });
    if (options.seedPostPreflight !== false) {
        seedPostPreflightRulePack(repoRoot, taskId, preflightPath, taskModePath);
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
        schema_version: 2,
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
        reviewOutputPath?: string;
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
            reviewer_session_id: `agent:${reviewType}-reviewer`,
            delegation_required: true,
            expected_execution_mode: 'delegated_subagent',
            fallback_allowed: false,
            fallback_reason_required: false
        }
    };
    const reviewContextText = `${JSON.stringify(reviewContext, null, 2)}\n`;
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');
    const artifactText = `# ${reviewType} review\n\n${options.body || ''}## Verdict\n${verdictToken}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    appendEvent(repoRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', {
        review_type: reviewType,
        output_path: reviewContextPath
    });
    const routeIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: `agent:${reviewType}-reviewer`
    });
    const launchPreparedAtUtc = '2026-04-28T00:00:00.000Z';
    const launchedAtUtc = '2026-04-28T00:00:01.000Z';
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
            ...preparedReviewerLaunchPathFields(repoRoot, taskId, reviewType)
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId,
            reviewType,
            reviewerIdentity: `agent:${reviewType}-reviewer`,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId,
            reviewType,
            reviewerIdentity: `agent:${reviewType}-reviewer`,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: `test-${reviewType}-invocation`,
            delegationStartedAtUtc: launchedAtUtc
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
            ...inputPin.controlArtifactFields,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: `test-${reviewType}-invocation`,
            launch_prepared_at_utc: launchPreparedAtUtc,
            delegation_started_at_utc: launchedAtUtc,
            launched_at_utc: launchedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc,
            ...(options.reviewOutputPath
                ? { review_output_path: options.reviewOutputPath.replace(/\\/g, '/') }
                : {}),
            ...launchInputEvidenceFixture(taskId, reviewType),
            fork_context: false
        });
        reviewerLaunchArtifactSha256 = fileSha256(reviewerLaunchArtifactPath);
        appendLaunchCompletedEventForTest({
            repoRoot,
            taskId,
            reviewType,
            reviewerIdentity: `agent:${reviewType}-reviewer`,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchArtifactPath: reviewerLaunchArtifactPath,
            providerInvocationId: `test-${reviewType}-invocation`,
            delegationStartedAtUtc: launchedAtUtc,
            launchCompletedAtUtc
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
                delegation_started_at_utc: launchedAtUtc,
                launched_at_utc: launchedAtUtc,
                launch_completed_at_utc: launchCompletedAtUtc,
                launch_input_mode: launchInputEvidenceFixture(taskId, reviewType).launch_input_mode,
                launch_input_sha256: launchInputEvidenceFixture(taskId, reviewType).launch_input_sha256,
                copy_paste_reviewer_launch_prompt_sha256: launchInputEvidenceFixture(taskId, reviewType).copy_paste_reviewer_launch_prompt_sha256,
                invocation_attested_at_utc: invocationAttestedAtUtc
            }
            : {})
    });
    const reviewerProvenance = {
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
        delegation_started_at_utc: launchedAtUtc,
        launched_at_utc: launchedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc,
        invocation_attested_at_utc: invocationAttestedAtUtc
    };
    const receipt = {
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
        reviewer_provenance: reviewerProvenance,
        recorded_at_utc: reviewResultRecordedAtUtc,
        review_result_recorded_at_utc: reviewResultRecordedAtUtc,
        review_output_source_mtime_utc: reviewResultRecordedAtUtc
    };
    writeJson(receiptPath, receipt);
    const receiptSha256 = fileSha256(receiptPath);
    const receiptSnapshotPath = path.join(
        reviewsRoot(repoRoot),
        `${taskId}-${reviewType}-receipt-${receiptSha256}.json`
    );
    const artifactSha256 = fileSha256(artifactPath);
    const artifactSnapshotPath = path.join(
        reviewsRoot(repoRoot),
        `${taskId}-${reviewType}-artifact-${artifactSha256}.md`
    );
    fs.copyFileSync(receiptPath, receiptSnapshotPath);
    fs.copyFileSync(artifactPath, artifactSnapshotPath);
    appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', options.verdict === 'fail' ? 'FAIL' : 'PASS', {
        ...receipt,
        receipt_path: receiptPath,
        receipt_sha256: receiptSha256,
        receipt_snapshot_path: receiptSnapshotPath,
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_path: artifactPath,
        review_artifact_sha256: artifactSha256,
        review_artifact_snapshot_path: artifactSnapshotPath,
        review_artifact_snapshot_sha256: artifactSha256,
        review_context_path: reviewContextPath,
        review_context_sha256: sha256Text(reviewContextText),
        review_tree_state_sha256: reviewTreeStateSha256
    });
}



function writeReviewContextOnly(repoRoot: string, taskId: string, reviewType: string, reviewerIdentity: string): void {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    writeJson(reviewContextPath, {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        ...buildReviewContextScopeFixture(repoRoot, taskId, reviewType),
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        }
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

function reviewerLaunchFixturePaths(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    explicitLaunchArtifactPath?: string
): {
    launchArtifactPath: string;
    launchInputArtifactPath: string;
} {
    const launchArtifactPath = explicitLaunchArtifactPath || path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            reviewType,
            'reviewer-launch.json'
        );
    return {
        launchArtifactPath,
        launchInputArtifactPath: path.join(path.dirname(launchArtifactPath), 'reviewer-launch-input.json')
    };
}

function reviewerLaunchAttemptIdForTest(taskId: string, reviewType: string): string {
    return `test-${taskId}-${reviewType}-launch-attempt`;
}

function preparedReviewerLaunchPathFields(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    explicitLaunchArtifactPath?: string
): Record<string, unknown> {
    const fixturePaths = reviewerLaunchFixturePaths(
        repoRoot,
        taskId,
        reviewType,
        explicitLaunchArtifactPath
    );
    return {
        reviewer_launch_attempt_id: reviewerLaunchAttemptIdForTest(taskId, reviewType),
        reviewer_launch_artifact_path: fixturePaths.launchArtifactPath.replace(/\\/g, '/'),
        reviewer_launch_input_artifact_path: fixturePaths.launchInputArtifactPath.replace(/\\/g, '/')
    };
}

function pinPreparedReviewerLaunchInputForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextPath: string;
    routingEventSha256: string;
    launchBindingSha256: string;
    preparedLaunchEventSha256: string;
    launchArtifactPath?: string;
}): {
    launchArtifactPath: string;
    launchInputArtifactPath: string;
    launchInputArtifactSha256: string;
    controlArtifactFields: Record<string, unknown>;
} {
    const fixturePaths = reviewerLaunchFixturePaths(
        options.repoRoot,
        options.taskId,
        options.reviewType,
        options.launchArtifactPath
    );
    const reviewerLaunchAttemptId = reviewerLaunchAttemptIdForTest(options.taskId, options.reviewType);
    const launchInputEvidence = launchInputEvidenceFixture(options.taskId, options.reviewType);
    writeJson(fixturePaths.launchInputArtifactPath, {
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch_input',
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: options.reviewerIdentity,
        review_context_sha256: fileSha256(options.reviewContextPath),
        routing_event_sha256: options.routingEventSha256,
        launch_binding_sha256: options.launchBindingSha256,
        reviewer_launch_attempt_id: reviewerLaunchAttemptId,
        prepared_launch_event_sha256: options.preparedLaunchEventSha256,
        copy_paste_reviewer_launch_prompt: launchInputEvidence.copy_paste_reviewer_launch_prompt,
        copy_paste_reviewer_launch_prompt_sha256:
            launchInputEvidence.copy_paste_reviewer_launch_prompt_sha256
    });
    const launchInputArtifactSha256 = fileSha256(fixturePaths.launchInputArtifactPath);
    const pinnedIntegrity = appendEvent(
        options.repoRoot,
        options.taskId,
        'REVIEWER_LAUNCH_INPUT_PINNED',
        'INFO',
        {
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: fileSha256(options.reviewContextPath),
            routing_event_sha256: options.routingEventSha256,
            launch_binding_sha256: options.launchBindingSha256,
            reviewer_launch_attempt_id: reviewerLaunchAttemptId,
            prepared_launch_event_sha256: options.preparedLaunchEventSha256,
            reviewer_launch_artifact_path: fixturePaths.launchArtifactPath.replace(/\\/g, '/'),
            reviewer_launch_input_artifact_path: fixturePaths.launchInputArtifactPath.replace(/\\/g, '/'),
            reviewer_launch_input_artifact_sha256: launchInputArtifactSha256
        }
    );
    return {
        ...fixturePaths,
        launchInputArtifactSha256,
        controlArtifactFields: {
            reviewer_launch_attempt_id: reviewerLaunchAttemptId,
            reviewer_launch_input_artifact_path: fixturePaths.launchInputArtifactPath.replace(/\\/g, '/'),
            reviewer_launch_input_artifact_sha256: launchInputArtifactSha256,
            reviewer_launch_input_pinned_event_sha256: pinnedIntegrity.event_sha256,
            reviewer_launch_input_pinned_event_task_sequence: pinnedIntegrity.task_sequence,
            copy_paste_reviewer_launch_prompt: launchInputEvidence.copy_paste_reviewer_launch_prompt,
            copy_paste_reviewer_launch_prompt_sha256:
                launchInputEvidence.copy_paste_reviewer_launch_prompt_sha256
        }
    };
}

function appendDelegationStartedEventForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextPath: string;
    routingEventSha256: string;
    launchBindingSha256: string;
    preparedLaunchEventSha256: string;
    providerInvocationId: string;
    delegationStartedAtUtc?: string;
}): void {
    const delegationStartedAtUtc = options.delegationStartedAtUtc || '2026-04-28T00:00:00.000Z';
    appendEvent(options.repoRoot, options.taskId, 'REVIEWER_DELEGATION_STARTED', 'INFO', {
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: options.reviewerIdentity,
        reviewer_identity: options.reviewerIdentity,
        review_context_sha256: fileSha256(options.reviewContextPath),
        routing_event_sha256: options.routingEventSha256,
        launch_binding_sha256: options.launchBindingSha256,
        prepared_launch_event_sha256: options.preparedLaunchEventSha256,
        reviewer_launch_attempt_id: reviewerLaunchAttemptIdForTest(options.taskId, options.reviewType),
        provider_invocation_id: options.providerInvocationId,
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc
    });
}

function appendProviderFailureEventForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextPath: string;
    routingEventSha256: string;
    providerInvocationId: string;
    delegationStartedAtUtc?: string;
}): void {
    const delegationStartedAtUtc = options.delegationStartedAtUtc || '2026-04-28T00:00:00.000Z';
    appendEvent(options.repoRoot, options.taskId, 'REVIEWER_PROVIDER_FAILED', 'FAIL', {
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: options.reviewerIdentity,
        reviewer_identity: options.reviewerIdentity,
        review_context_sha256: fileSha256(options.reviewContextPath),
        routing_event_sha256: options.routingEventSha256,
        reviewer_launch_attempt_id: reviewerLaunchAttemptIdForTest(options.taskId, options.reviewType),
        provider_invocation_id: options.providerInvocationId,
        delegation_started_at_utc: delegationStartedAtUtc,
        provider_failure_reason: 'provider returned launch failure before review output'
    });
}

function appendLaunchCompletedEventForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextPath: string;
    routingEventSha256: string;
    launchArtifactPath: string;
    providerInvocationId: string;
    delegationStartedAtUtc?: string;
    launchCompletedAtUtc?: string;
}): void {
    const delegationStartedAtUtc = options.delegationStartedAtUtc || '2026-04-28T00:00:00.000Z';
    const launchCompletedAtUtc = options.launchCompletedAtUtc || '2026-04-28T00:00:12.000Z';
    appendEvent(options.repoRoot, options.taskId, 'REVIEWER_LAUNCH_COMPLETED', 'INFO', {
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: options.reviewerIdentity,
        reviewer_identity: options.reviewerIdentity,
        review_context_sha256: fileSha256(options.reviewContextPath),
        routing_event_sha256: options.routingEventSha256,
        reviewer_launch_artifact_path: options.launchArtifactPath,
        reviewer_launch_artifact_sha256: fileSha256(options.launchArtifactPath),
        reviewer_launch_attempt_id: reviewerLaunchAttemptIdForTest(options.taskId, options.reviewType),
        provider_invocation_id: options.providerInvocationId,
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc
    });
}

function seedCompletedReviewerLaunchAndInvocation(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string,
    options: {
        includeInvocation?: boolean;
        reviewOutputPath?: string;
        attestationState?: 'delegation_started' | 'launched';
    } = {}
): void {
    const attestationState = options.attestationState || 'launched';
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const routeIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity
    });
    const launchBindingSha256 = 'c'.repeat(64);
    const preparedIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        routing_event_sha256: routeIntegrity.event_sha256,
        launch_binding_sha256: launchBindingSha256,
        ...preparedReviewerLaunchPathFields(repoRoot, taskId, reviewType)
    });
    const inputPin = pinPreparedReviewerLaunchInputForTest({
        repoRoot,
        taskId,
        reviewType,
        reviewerIdentity,
        reviewContextPath,
        routingEventSha256: routeIntegrity.event_sha256,
        launchBindingSha256,
        preparedLaunchEventSha256: preparedIntegrity.event_sha256
    });
    appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_STARTED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        routing_event_sha256: routeIntegrity.event_sha256,
        launch_binding_sha256: launchBindingSha256,
        prepared_launch_event_sha256: preparedIntegrity.event_sha256,
        reviewer_launch_attempt_id: reviewerLaunchAttemptIdForTest(taskId, reviewType),
        provider_invocation_id: `test-${reviewType}-invocation`,
        delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
        launched_at_utc: '2026-04-28T00:00:00.000Z'
    });
    const launchArtifactPath = inputPin.launchArtifactPath;
    writeJson(launchArtifactPath, {
        schema_version: 1,
        evidence_type: attestationState === 'launched'
            ? 'delegated_reviewer_launch'
            : 'delegated_reviewer_launch_preparation',
        attestation_state: attestationState,
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        routing_event_sha256: routeIntegrity.event_sha256,
        launch_binding_sha256: launchBindingSha256,
        prepared_launch_event_sha256: preparedIntegrity.event_sha256,
        ...inputPin.controlArtifactFields,
        launch_tool: 'test-subagent-spawn',
        provider_invocation_id: `test-${reviewType}-invocation`,
        delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
        launched_at_utc: '2026-04-28T00:00:00.000Z',
        ...(attestationState === 'launched'
            ? { launch_completed_at_utc: '2026-04-28T00:00:12.000Z' }
            : {}),
        ...(options.reviewOutputPath ? { review_output_path: options.reviewOutputPath.replace(/\\/g, '/') } : {}),
        ...launchInputEvidenceFixture(taskId, reviewType),
        fork_context: false
    });
    if (attestationState === 'launched') {
        appendLaunchCompletedEventForTest({
            repoRoot,
            taskId,
            reviewType,
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchArtifactPath,
            providerInvocationId: `test-${reviewType}-invocation`
        });
    }
    if (options.includeInvocation === false || attestationState !== 'launched') {
        return;
    }
    const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
    appendEvent(repoRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        review_tree_state_sha256: readReviewContextTreeStateSha256(repoRoot, taskId, reviewType),
        routing_event_sha256: routeIntegrity.event_sha256,
        reviewer_launch_artifact_path: launchArtifactPath,
        reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
        reviewer_launch_attestation_source: 'test-subagent-spawn',
        reviewer_launch_tool: 'test-subagent-spawn',
        provider_invocation_id: `test-${reviewType}-invocation`,
        delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
        launched_at_utc: '2026-04-28T00:00:00.000Z',
        launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
        launch_input_mode: launchArtifact.launch_input_mode,
        launch_input_sha256: launchArtifact.launch_input_sha256,
        copy_paste_reviewer_launch_prompt_sha256: launchArtifact.copy_paste_reviewer_launch_prompt_sha256
    });
}

function readReviewContextTreeStateSha256(repoRoot: string, taskId: string, reviewType: string): string {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
    const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : {};
    return String(treeState.tree_state_sha256 || '').trim();
}

function writeFreshReviewContextWithoutRouting(repoRoot: string, taskId: string, reviewType: string): string {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    writeJson(reviewContextPath, {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        ...buildReviewContextScopeFixture(repoRoot, taskId, reviewType),
        reviewer_routing: {
            actual_execution_mode: null,
            reviewer_session_id: null
        }
    });
    return reviewContextPath;
}

function seedReviewGatePass(repoRoot: string, taskId: string, passedReviewTypes: readonly string[] = []): void {
    const reviewChecks: Record<string, unknown> = {};
    const requiredReviews: Record<string, boolean> = {};
    for (const reviewType of passedReviewTypes) {
        requiredReviews[reviewType] = true;
        reviewChecks[reviewType] = {
            required: true,
            skipped_by_override: false,
            receipt_valid: true,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: `agent:${reviewType}-reviewer`,
            reviewer_fallback_reason: null,
            trust_level: 'INDEPENDENT_AUDITED',
            verdict: reviewType === 'code' ? 'REVIEW PASSED' : `${reviewType.toUpperCase()} REVIEW PASSED`,
            reviewer_routing_policy: {
                delegation_required: true,
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                fallback_reason_required: false
            }
        };
    }
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-review-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        preflight_hash_sha256: fs.existsSync(preflightPath) ? fileSha256(preflightPath) : null,
        ...(passedReviewTypes.length > 0
            ? {
                required_reviews: requiredReviews,
                review_checks: reviewChecks,
                review_authorship_attestation: {
                    status: 'PASSED',
                    required_reviews: requiredReviews,
                    required_review_types: passedReviewTypes,
                    attested_review_types: passedReviewTypes,
                    attestations: Object.fromEntries(passedReviewTypes.map((reviewType) => [reviewType, true])),
                    skipped_reviews: {},
                    violations: []
                }
            }
            : {})
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

function seedCompletionPass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-completion-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'COMPLETION_GATE_PASSED');
}


function materializeFinalCloseout(repoRoot: string, taskId: string): void {
    const summary = buildTaskAuditSummary({ taskId, repoRoot });
    synchronizeFinalCloseoutArtifacts(summary);
}



afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});


describe('gates/next-step', () => {
    it('exposes parallel_all launch batches without collapsing JSON or human output to one lane', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID, 'parallel_all');
        writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            { reviewPolicyMode: 'parallel_all' }
        );
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.review.next_review_type, 'code');
        assert.deepEqual(result.review.launchable_review_types, ['code', 'security', 'refactor', 'test']);
        assert.deepEqual(result.review.blocked_review_lanes, []);
        assert.match(text, /NextReview: code/);
        assert.match(text, /ReviewLaunchableBatch: code, security, refactor, test/);
    });

    it('exposes blocked review lanes with dependency reasons while preserving single next review compatibility', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true, security: true, api: true, test: true },
            { reviewPolicyMode: 'code_first_optional' }
        );
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.review.next_review_type, 'code');
        assert.deepEqual(result.review.launchable_review_types, ['code', 'security']);
        assert.deepEqual(result.review.blocked_review_lanes, [
            {
                review_type: 'api',
                blocked_by: ['code'],
                reason: 'Waiting for current-cycle code review artifacts and receipts to pass.'
            },
            {
                review_type: 'test',
                blocked_by: ['code', 'security', 'api'],
                reason: 'Waiting for current-cycle code, security, api review artifacts and receipts to pass.'
            }
        ]);
        assert.match(text, /NextReview: code/);
        assert.match(text, /ReviewLaunchableBatch: code, security/);
        assert.match(text, /BlockedReviewLanes: api blocked by code; test blocked by code, security, api/);
    });

    it('keeps a single-review launch batch compatible with legacy NextReview consumers', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.review.next_review_type, 'code');
        assert.deepEqual(result.review.launchable_review_types, ['code']);
        assert.deepEqual(result.review.blocked_review_lanes, []);
        assert.match(text, /NextReview: code/);
        assert.match(text, /ReviewLaunchableBatch: code/);
    });

    it('routes to fresh reviewer routing after stale failed review context has been rebuilt', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        seedCompilePass(repoRoot, TASK_ID);
        const rebuiltContextPath = writeFreshReviewContextWithoutRouting(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code',
            output_path: normalizeForTimeline(rebuiltContextPath)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-review-routing');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Record 'code' delegated reviewer routing/);
        assert.ok(result.commands[0].command.includes('record-review-routing'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('omits the prepared review context identity when suggesting prepare-reviewer-launch', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.reason.includes('task-owned reviewer launch metadata'));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-routing-to-launch-prepared',
            status: 'pass'
        });
        assert.ok(result.reason.includes('Reviewer readiness chain: preflight scope=current -> review context=current'));
        assert.ok(result.reason.includes('routing=current'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
        assert.ok(result.reason.includes('invocation=blocked until launch artifact'));
        assert.ok(result.reason.includes('ProviderLaunchTarget:'));
        assert.ok(result.reason.includes('launch clean-context reviewers'));
        assert.ok(result.reason.includes('launch one clean-context delegated reviewer with the exact CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath'));
        assertNoDefaultReviewerReservationGuidance(`${result.reason}\n${result.commands.map((entry) => entry.command).join('\n')}`);
        assert.equal(result.commands[0].label, 'Prepare delegated reviewer launch metadata');
        assert.equal(result.commands[0].command.includes('--reviewer-identity'), false);
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
    });

    it('routes to record-reviewer-delegation-started after current launch metadata is prepared', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const alternateLaunchArtifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'alternate-reviewer-launch.json'
        );
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(
                repoRoot,
                TASK_ID,
                'code',
                alternateLaunchArtifactPath
            )
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            launchArtifactPath: alternateLaunchArtifactPath
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        const launchInputArtifactPath = inputPin.launchInputArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            launch_input_mode: 'launch_artifact_path',
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-reviewer-delegation-started');
        assert.ok(result.reason.includes('launch metadata'));
        assert.ok(result.reason.includes('Launch the delegated reviewer with exactly one opaque handoff mode'));
        assert.ok(result.reason.includes('Do not mix the two launch-input modes'));
        assert.ok(result.reason.includes('pass the ReviewerLaunchInputArtifactSha256 value to the CLI flag --launch-input-sha256'));
        assert.ok(result.reason.includes('do not invent a --launch-input-artifact-sha256 flag'));
        assert.ok(result.reason.includes('Do not reconstruct reviewer prompts from memory'));
        assert.ok(result.reason.includes('Provider-owned placeholders in the command are --reviewer-identity, --provider-invocation-id, and --attestation-source'));
        assert.ok(result.reason.includes('If the provider exposes one subagent id, use that resolved id for both --reviewer-identity and --provider-invocation-id'));
        assert.ok(result.reason.includes('Launch-input artifact path, launch-input hash, review type, and fork-context are already gate-owned command fragments when printed'));
        assert.ok(result.reason.includes('ReviewerOneShotLaunchHint: launch a fresh delegated reviewer once with the exact opaque handoff'));
        assert.ok(result.reason.includes(`ReviewerLaunchInputArtifactPath: ${launchInputArtifactPath.replace(/\\/g, '/')}`));
        assert.ok(result.reason.includes(`launch_input_sha256=${inputPin.launchInputArtifactSha256}`));
        assert.ok(result.reason.includes('ReviewerLaunchArtifactPath is main-agent control metadata'));
        assert.equal(result.reason.includes('this handshake is not review evidence'), false);
        assert.ok(result.reason.includes('Do not open or summarize'));
        assert.ok(result.reason.includes('Launch a real subagent using built-in tools'));
        assert.ok(result.reason.includes('if for some reason that is impossible right now, you must stop and report this to the user'));
        assert.ok(result.reason.includes('this is expected behavior in this repository'));
        assert.ok(result.reason.includes('record-reviewer-delegation-started'));
        assert.ok(result.reason.includes('ProviderLaunchTarget:'));
        assert.ok(result.reason.includes('launch clean-context reviewers'));
        assert.ok(result.reason.includes('launch artifact=prepared'));
        assert.ok(result.reason.includes('invocation=blocked until launch completion'));
        assertNoDefaultReviewerReservationGuidance(`${result.reason}\n${result.commands.map((entry) => entry.command).join('\n')}`);
        assert.equal(result.commands.length, 2);
        assert.equal(result.commands[0].label, 'Record delegated reviewer start from reviewer-facing launch artifact');
        assert.ok(result.commands[0].command.includes('gate record-reviewer-delegation-started'));
        assert.ok(result.commands[0].command.includes('--reviewer-identity "<agent:resolved-provider-reviewer-id-from-delegated-agent>"'));
        assert.ok(result.commands[0].command.includes('--provider-invocation-id "<provider-owned invocation id from delegated reviewer launch result>"'));
        assert.ok(result.commands[0].command.includes('--attestation-source "<provider-owned attestation source from delegated reviewer launch result>"'));
        assert.ok(result.commands[0].command.includes('--launch-input-mode "launch_artifact_path"'));
        assert.equal(result.commands[1].label, 'Record delegated reviewer start from exact copy-paste prompt');
        assert.ok(result.commands[1].command.includes('gate record-reviewer-delegation-started'));
        assert.ok(result.commands[1].command.includes('--launch-input-mode "copy_paste_prompt"'));
        assert.equal(result.commands[1].command.includes('--launch-input-artifact-path'), false);
        const normalizedAlternateLaunchArtifactPath = alternateLaunchArtifactPath
            .replace(`${repoRoot}${path.sep}`, '')
            .replace(/\\/g, '/');
        assert.ok(result.commands[0].command.replace(/\\/g, '/').includes(
            `--reviewer-launch-artifact-path "${normalizedAlternateLaunchArtifactPath}"`
        ));
        assert.ok(result.commands[1].command.replace(/\\/g, '/').includes(
            `--reviewer-launch-artifact-path "${normalizedAlternateLaunchArtifactPath}"`
        ));
        assert.equal(
            result.commands.some((entry) => entry.command.replace(/\\/g, '/').includes(
                `runtime/tmp/reviews/${TASK_ID}/code/reviewer-launch.json`
            )),
            false
        );
        assert.ok(result.commands[1].command.includes(
            `--launch-input-sha256 "${String(inputPin.controlArtifactFields.copy_paste_reviewer_launch_prompt_sha256)}"`
        ));
        assert.ok(result.known_non_blocking_signals.some((signal) => (
            signal.id === 'reviewer_provider_owned_placeholder_values'
            && signal.action_required === false
        )));
        assert.ok(formatNextStepText(result).includes('Known non-blocking notes: Provider-owned reviewer launch placeholders are external values'));
        assert.equal(formatNextStepText(result).includes('KnownNonBlockingSignals:'), false);
        const normalizedCommand = result.commands[0].command.replace(/\\/g, '/');
        assert.ok(normalizedCommand.includes(`--launch-input-artifact-path "${launchInputArtifactPath.replace(/\\/g, '/')}"`));
        assert.ok(result.commands[0].command.includes(`--launch-input-sha256 "${inputPin.launchInputArtifactSha256}"`));
        assert.ok(!result.commands[0].command.includes('--launch-input-artifact-sha256'));
        assert.ok(!result.commands[0].command.includes('--launched-at-utc'));
    });

    it('does not treat pre-launch reviewer completion as review progress', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields,
            ...launchInputEvidenceFixture(TASK_ID, 'code')
        });
        const prematureReviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'review-output-from-premature-completion.md'
        );
        fs.writeFileSync(prematureReviewOutputPath, '# code review\n\n## Verdict\nREVIEW PASSED\n', 'utf8');
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_COMPLETED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            reviewer_launch_artifact_path: launchArtifactPath,
            reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
            provider_invocation_id: 'premature-provider-completed-before-delegation-start',
            review_output_path: prematureReviewOutputPath.replace(/\\/g, '/')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-reviewer-delegation-started', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('launch artifact=prepared'));
        assert.ok(result.reason.includes('invocation=blocked until launch completion'));
        assert.ok(result.commands[0].command.includes('gate record-reviewer-delegation-started'));
        assert.ok(!result.commands.some((entry) => /record-review-result|required-reviews-check|completion-gate|task-audit-summary/u.test(entry.command)));
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-review-gate.json`)), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-completion-gate.json`)), false);
    });

    it('routes copy-paste delegation start to an exact copy-paste completion command', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        const launchInputArtifactPath = inputPin.launchInputArtifactPath;
        const copyPastePrompt = 'Delegated code reviewer launch prompt.';
        const copyPastePromptSha256 = sha256Text(copyPastePrompt);
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            copy_paste_reviewer_launch_prompt: copyPastePrompt,
            copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256
        });
        const pinnedInputArtifactSha256 = inputPin.launchInputArtifactSha256;
        const pinnedCopyPastePromptSha256 = String(
            inputPin.controlArtifactFields.copy_paste_reviewer_launch_prompt_sha256
        );
        writeJson(launchArtifactPath, {
            ...JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')),
            ...inputPin.controlArtifactFields,
            attestation_state: 'delegation_started',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_input_mode: 'copy_paste_prompt',
            launch_input_sha256: pinnedCopyPastePromptSha256,
            reviewer_launch_input_artifact_sha256: pinnedInputArtifactSha256,
            fork_context: false
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'complete-reviewer-launch', result.reason);
        assert.equal(result.commands[0].label, 'Complete delegated reviewer launch metadata');
        assert.ok(result.reason.includes('Provider-owned placeholders in the command are only --attestation-source'));
        assert.ok(result.reason.includes('Launch-input artifact path, launch-input hash, reviewer identity, review type, and fork-context are already gate-owned command fragments when printed'));
        assert.ok(result.commands[0].command.includes('gate complete-reviewer-launch'));
        assert.ok(result.commands[0].command.includes('--reviewer-execution-mode "delegated_subagent"'));
        assert.ok(result.commands[0].command.includes(`--reviewer-identity "${reviewerIdentity}"`));
        assert.ok(result.commands[0].command.includes('--attestation-source "<provider-owned attestation source from delegated reviewer launch result>"'));
        assert.ok(result.commands[0].command.includes('--fork-context false'));
        assert.ok(result.commands[0].command.includes('--record-invocation'));
        assert.ok(result.known_non_blocking_signals.some((signal) => (
            signal.id === 'reviewer_provider_owned_placeholder_values'
            && signal.action_required === false
        )));
        const normalizedCommand = result.commands[0].command.replace(/\\/g, '/');
        assert.ok(normalizedCommand.includes(`--reviewer-launch-artifact-path "garda-agent-orchestrator/runtime/tmp/reviews/${TASK_ID}/code/reviewer-launch.json"`));
        assert.ok(result.commands[0].command.includes('--launch-input-mode "copy_paste_prompt"'));
        assert.equal(normalizedCommand.includes('--launch-input-artifact-path'), false);
        assert.ok(result.commands[0].command.includes(`--launch-input-sha256 "${pinnedCopyPastePromptSha256}"`));
        assert.ok(!result.commands[0].command.includes('--launch-input-artifact-sha256'));
    });

    it('routes provider-failed delegation-started launch to failed launch recovery', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID, 'code_first_optional', LATENCY_PLANNED_FILES);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/app.ts', ...LATENCY_PLANNED_FILES]
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        appendProviderFailureEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        const launchInputArtifactPath = inputPin.launchInputArtifactPath;
        const copyPastePrompt = 'Delegated code reviewer launch prompt.';
        const copyPastePromptSha256 = sha256Text(copyPastePrompt);
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            copy_paste_reviewer_launch_prompt: copyPastePrompt,
            copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256
        });
        const pinnedInputArtifactSha256 = inputPin.launchInputArtifactSha256;
        writeJson(launchArtifactPath, {
            ...JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')),
            ...inputPin.controlArtifactFields,
            attestation_state: 'delegation_started',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_input_mode: 'launch_artifact_path',
            launch_input_sha256: pinnedInputArtifactSha256,
            launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            launch_input_artifact_sha256: pinnedInputArtifactSha256,
            prepared_reviewer_launch_artifact_sha256: pinnedInputArtifactSha256,
            reviewer_launch_input_artifact_sha256: pinnedInputArtifactSha256,
            fork_context: false
        });

        const result = resolveLaunchWithoutUnusedIgnoreReads(repoRoot);

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.equal(result.commands[0].label, 'Restart/supersede failed delegated reviewer launch');
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
        assert.ok(result.commands[0].command.includes(
            '--task-intent "Make next-step output executable in tests"'
        ));
        assert.ok(!result.commands[0].command.includes('--task-intent "Seeded next-step task"'));
        assert.ok(result.commands[0].command.includes(`--preflight-path "garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json"`));
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(result.commands[0].command.includes('--review-evidence-only'));
        assert.ok(!result.commands[0].command.includes('--changed-file'));
        assert.ok(result.reason.includes('provider recorded a failed launch before review output was available'));
        assert.ok(result.reason.includes('do not complete the old launch'));
        assert.ok(result.reason.includes('do not reuse the failed reviewer session'));
        assert.ok(result.reason.includes('launch artifact=provider failed'));
        assert.ok(result.reason.includes('invocation=blocked until launch recovery'));
        assert.ok(!result.commands[0].command.includes('complete-reviewer-launch'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
    });

    it('routes resumed delegation-started launch with missing review output to orphaned launch recovery', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID, 'code_first_optional', LATENCY_PLANNED_FILES);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/app.ts', ...LATENCY_PLANNED_FILES]
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        const launchInputArtifactPath = inputPin.launchInputArtifactPath;
        const reviewOutputPath = path.join(path.dirname(launchArtifactPath), 'review-output-from-orphaned-launch.md');
        appendEvent(repoRoot, TASK_ID, 'CONTROLLER_SESSION_RESUMED', 'INFO', {
            task_id: TASK_ID,
            resumed_after_delegated_reviewer_launch: true
        });
        const copyPastePrompt = 'Delegated code reviewer launch prompt.';
        const copyPastePromptSha256 = sha256Text(copyPastePrompt);
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            copy_paste_reviewer_launch_prompt: copyPastePrompt,
            copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
            review_output_path: reviewOutputPath.replace(/\\/g, '/')
        });
        const pinnedInputArtifactSha256 = inputPin.launchInputArtifactSha256;
        writeJson(launchArtifactPath, {
            ...JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')),
            ...inputPin.controlArtifactFields,
            attestation_state: 'delegation_started',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_input_mode: 'launch_artifact_path',
            launch_input_sha256: pinnedInputArtifactSha256,
            launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            launch_input_artifact_sha256: pinnedInputArtifactSha256,
            prepared_reviewer_launch_artifact_sha256: pinnedInputArtifactSha256,
            reviewer_launch_input_artifact_sha256: pinnedInputArtifactSha256,
            fork_context: false
        });

        const result = resolveLaunchWithoutUnusedIgnoreReads(repoRoot);

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.equal(result.commands[0].label, 'Restart/supersede orphaned delegated reviewer launch');
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
        assert.ok(result.commands[0].command.includes(
            '--task-intent "Make next-step output executable in tests"'
        ));
        assert.ok(!result.commands[0].command.includes('--task-intent "Seeded next-step task"'));
        assert.ok(result.commands[0].command.includes(`--preflight-path "garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json"`));
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(result.commands[0].command.includes('--review-evidence-only'));
        assert.ok(!result.commands[0].command.includes('--changed-file'));
        assert.ok(result.reason.includes('abandoned delegated reviewer launch'));
        assert.ok(result.reason.includes('do not complete the old launch'));
        assert.ok(result.reason.includes('launch artifact=orphaned'));
        assert.ok(result.reason.includes('invocation=blocked until launch recovery'));
        assert.ok(!result.commands[0].command.includes('complete-reviewer-launch'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
    });

    it('routes a completed launch with missing bound review output to orphaned launch recovery', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-t97954';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const launchArtifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'reviewer-launch.json'
        );
        const reviewOutputPath = path.join(path.dirname(launchArtifactPath), 'missing-review-output.md');
        seedCompletedReviewerLaunchAndInvocation(
            repoRoot,
            TASK_ID,
            'code',
            reviewerIdentity,
            { reviewOutputPath }
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.equal(result.commands[0].label, 'Restart/supersede orphaned delegated reviewer launch');
        assert.ok(result.reason.includes('completed reviewer launch has no bound review output'));
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
    });

    it('recovers a stale completed launch with missing bound output before fresh routing', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-stale-launch';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const launchArtifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'reviewer-launch.json'
        );
        const reviewOutputPath = path.join(path.dirname(launchArtifactPath), 'missing-stale-review-output.md');
        seedCompletedReviewerLaunchAndInvocation(
            repoRoot,
            TASK_ID,
            'code',
            reviewerIdentity,
            { reviewOutputPath }
        );
        seedCompilePass(repoRoot, TASK_ID);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        writeJson(reviewContextPath, {
            ...refreshedReviewContext,
            review_cycle_marker: 'refreshed-after-launch'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.equal(result.commands[0].label, 'Restart/supersede orphaned delegated reviewer launch');
        assert.ok(result.reason.includes('completed reviewer launch has no bound review output'));
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
        assert.ok(!result.commands[0].command.includes('gate record-review-routing'));
    });

    it('does not rediscover a stale orphan after review-cycle restart invalidates its lane', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-invalidated-launch';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'missing-invalidated-review-output.md'
        );
        seedCompletedReviewerLaunchAndInvocation(
            repoRoot,
            TASK_ID,
            'code',
            reviewerIdentity,
            { reviewOutputPath }
        );
        seedCompilePass(repoRoot, TASK_ID);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        writeJson(reviewContextPath, {
            ...refreshedReviewContext,
            review_cycle_marker: 'refreshed-after-invalidating-restart'
        });
        appendRestartBoundary(repoRoot, TASK_ID, 'REVIEW_CYCLE_RESTARTED', {
            invalidatedReviewTypes: ['code'],
            preservedReviewTypes: ['test']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing', result.reason);
        assert.ok(result.commands[0].command.includes('gate record-review-routing'));
        assert.ok(!result.commands.some((entry) => entry.command.includes('gate restart-review-cycle')));
    });

    it('invalidates a current routing when review-cycle restart follows its launch', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-current-before-restart';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'missing-current-before-restart-output.md'
        );
        seedCompletedReviewerLaunchAndInvocation(
            repoRoot,
            TASK_ID,
            'code',
            reviewerIdentity,
            { reviewOutputPath }
        );
        appendRestartBoundary(repoRoot, TASK_ID, 'REVIEW_CYCLE_RESTARTED', {
            invalidatedReviewTypes: ['code'],
            preservedReviewTypes: ['test']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing', result.reason);
        assert.ok(result.commands[0].command.includes('gate record-review-routing'));
        assert.ok(!result.commands.some((entry) => entry.command.includes('gate restart-review-cycle')));
    });

    it('keeps a current routing created after an invalidating review-cycle restart', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-current-after-restart';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendRestartBoundary(repoRoot, TASK_ID, 'REVIEW_CYCLE_RESTARTED', {
            invalidatedReviewTypes: ['code'],
            preservedReviewTypes: ['test']
        });
        const reviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'missing-current-after-restart-output.md'
        );
        seedCompletedReviewerLaunchAndInvocation(
            repoRoot,
            TASK_ID,
            'code',
            reviewerIdentity,
            { reviewOutputPath }
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
    });

    it('keeps stale orphan recovery for a lane preserved by review-cycle restart', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-preserved-launch';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'missing-preserved-review-output.md'
        );
        seedCompletedReviewerLaunchAndInvocation(
            repoRoot,
            TASK_ID,
            'code',
            reviewerIdentity,
            { reviewOutputPath }
        );
        seedCompilePass(repoRoot, TASK_ID);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        writeJson(reviewContextPath, {
            ...refreshedReviewContext,
            review_cycle_marker: 'refreshed-after-preserving-restart'
        });
        appendRestartBoundary(repoRoot, TASK_ID, 'REVIEW_CYCLE_RESTARTED', {
            invalidatedReviewTypes: ['test'],
            preservedReviewTypes: ['code']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
    });

    it('does not rediscover any stale orphan before a coherent-cycle restart', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-coherent-launch';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'missing-coherent-review-output.md'
        );
        seedCompletedReviewerLaunchAndInvocation(
            repoRoot,
            TASK_ID,
            'code',
            reviewerIdentity,
            { reviewOutputPath }
        );
        seedCompilePass(repoRoot, TASK_ID);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        writeJson(reviewContextPath, {
            ...refreshedReviewContext,
            review_cycle_marker: 'refreshed-after-coherent-restart'
        });
        appendRestartBoundary(repoRoot, TASK_ID, 'COHERENT_CYCLE_RESTARTED');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing', result.reason);
        assert.ok(result.commands[0].command.includes('gate record-review-routing'));
        assert.ok(!result.commands.some((entry) => entry.command.includes('gate restart-review-cycle')));
    });

    it('does not trust malformed or unauthenticated invalidating restart boundaries', () => {
        const invalidBoundaries = [
            { name: 'non-orchestrator actor', options: { actor: 'gate' } },
            { name: 'failed outcome', options: { outcome: 'FAIL' } },
            { name: 'mismatched details task', options: { detailsTaskId: 'T-OTHER' } },
            { name: 'mismatched details event type', options: { detailsEventType: 'COHERENT_CYCLE_RESTARTED' } },
            { name: 'failed details status', options: { status: 'FAILED' } },
            { name: 'non-array invalidated lanes', options: { invalidatedReviewTypes: 'code' } }
        ];
        for (const invalidBoundary of invalidBoundaries) {
            const repoRoot = makeTempRepo();
            const reviewerIdentity = `agent:019dc191-3d81-7091-aca0-${invalidBoundary.name.replace(/\W+/g, '-')}`;
            seedStartedTask(repoRoot, TASK_ID);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
            seedCompilePass(repoRoot, TASK_ID);
            writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
            const reviewOutputPath = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                'reviews',
                TASK_ID,
                'code',
                `missing-${invalidBoundary.name.replace(/\W+/g, '-')}-output.md`
            );
            seedCompletedReviewerLaunchAndInvocation(
                repoRoot,
                TASK_ID,
                'code',
                reviewerIdentity,
                { reviewOutputPath }
            );
            seedCompilePass(repoRoot, TASK_ID);
            const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
            const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
            writeJson(reviewContextPath, {
                ...refreshedReviewContext,
                review_cycle_marker: `refreshed-after-${invalidBoundary.name}`
            });
            appendRestartBoundary(repoRoot, TASK_ID, 'REVIEW_CYCLE_RESTARTED', {
                invalidatedReviewTypes: ['code'],
                ...invalidBoundary.options
            });

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'restart-review-cycle', invalidBoundary.name);
            assert.ok(result.commands[0].command.includes('gate restart-review-cycle'), invalidBoundary.name);
        }
    });

    it('does not recover a stale completed launch after its review result was accepted', () => {
        const repoRoot = makeTempRepo();
        const cleanedReviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'cleaned-stale-review-output.md'
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            reviewOutputPath: cleanedReviewOutputPath
        });
        seedCompilePass(repoRoot, TASK_ID);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        writeJson(reviewContextPath, {
            ...refreshedReviewContext,
            review_cycle_marker: 'refreshed-after-accepted-result'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'restart-review-cycle', result.reason);
        assert.ok(!result.commands.some((entry) => entry.command.includes('gate restart-review-cycle')));
    });

    it('does not recover a stale delegation-started launch as a completed orphan', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-stale-in-flight';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'missing-stale-in-flight-output.md'
        );
        seedCompletedReviewerLaunchAndInvocation(
            repoRoot,
            TASK_ID,
            'code',
            reviewerIdentity,
            {
                attestationState: 'delegation_started',
                reviewOutputPath
            }
        );
        seedCompilePass(repoRoot, TASK_ID);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        writeJson(reviewContextPath, {
            ...refreshedReviewContext,
            review_cycle_marker: 'refreshed-while-reviewer-in-flight'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'restart-review-cycle', result.reason);
        assert.ok(!result.commands.some((entry) => entry.command.includes('gate restart-review-cycle')));
    });

    it('does not orphan a completed launch after an accepted result cleans the bound review output', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        const cleanedReviewOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            TASK_ID,
            'code',
            'cleaned-review-output.md'
        );
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            reviewOutputPath: cleanedReviewOutputPath
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check', result.reason);
        assert.ok(!result.commands.some((entry) => entry.command.includes('restart-review-cycle')));
    });

    it('routes delegation-started refactor launch to completion before record-review-result', () => {
        const repoRoot = makeTempRepo();
        const reviewType = 'refactor';
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-refactor';
        seedStartedTask(repoRoot, TASK_ID, 'code_first_optional', LATENCY_PLANNED_FILES);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, refactor: true }, {
            changedFiles: ['src/app.ts', ...LATENCY_PLANNED_FILES]
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, reviewType, reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-review-context.json`);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}.md`);
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-receipt.json`);
        const artifactText = '# refactor review\n\n## Verdict\nREFACTOR REVIEW PASSED\n';
        fs.writeFileSync(artifactPath, artifactText, 'utf8');
        writeJson(receiptPath, {
            task_id: TASK_ID,
            review_type: reviewType,
            trust_level: 'INDEPENDENT_AUDITED',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_artifact_sha256: sha256Text(artifactText),
            review_context_sha256: fileSha256(reviewContextPath),
            reviewer_provenance: {
                controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                event_sha256: '0'.repeat(64),
                reviewer_identity: reviewerIdentity,
                review_context_sha256: fileSha256(reviewContextPath)
            }
        });
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, reviewType)
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType,
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType,
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-refactor-invocation'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        const launchInputArtifactPath = inputPin.launchInputArtifactPath;
        const copyPastePrompt = 'Delegated refactor reviewer launch prompt.';
        const copyPastePromptSha256 = sha256Text(copyPastePrompt);
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: TASK_ID,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            reviewer_launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            copy_paste_reviewer_launch_prompt: copyPastePrompt,
            copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256
        });
        const launchInputArtifactSha256 = inputPin.launchInputArtifactSha256;
        writeJson(launchArtifactPath, {
            ...JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')),
            ...inputPin.controlArtifactFields,
            attestation_state: 'delegation_started',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-refactor-invocation',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_input_mode: 'launch_artifact_path',
            launch_input_sha256: launchInputArtifactSha256,
            launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            launch_input_artifact_sha256: launchInputArtifactSha256,
            prepared_reviewer_launch_artifact_sha256: launchInputArtifactSha256,
            reviewer_launch_input_artifact_sha256: launchInputArtifactSha256,
            fork_context: false
        });

        const result = resolveLaunchWithoutUnusedIgnoreReads(repoRoot);

        assert.equal(result.next_gate, 'complete-reviewer-launch', result.reason);
        assert.equal(result.review.next_review_type, reviewType);
        assert.ok(result.commands[0].command.includes('gate complete-reviewer-launch'));
        assert.ok(!result.commands[0].command.includes('gate record-review-result'));
        assert.ok(result.reason.includes('launch artifact=delegation started'));
    });

    it('routes to record-review-invocation after current completed launch metadata is present', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });
        appendLaunchCompletedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-123'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-invocation', result.reason);
        assert.ok(result.reason.includes('launch metadata'));
        assert.ok(result.reason.includes('already contains completed launch evidence'));
        assert.ok(!result.reason.includes('Launch the delegated reviewer with the prepared prompt'));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-launch-completed-to-invocation',
            status: 'pass'
        });
        assert.ok(result.reason.includes('launch artifact=launched'));
        assert.ok(result.reason.includes('invocation=missing current-cycle attestation'));
        assert.equal(result.commands[0].label, 'Record delegated reviewer launch attestation');
        assert.ok(result.commands[0].command.includes('gate record-review-invocation'));
    });

    it('routes completed launch artifacts without parent completion telemetry to exact completion recovery', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
            review_output_path: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'review-output-from-launch.md').replace(/\\/g, '/'),
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'complete-reviewer-launch', result.reason);
        assert.ok(result.reason.includes('durable launched control artifact'));
        assert.ok(result.reason.includes('matching REVIEWER_LAUNCH_COMPLETED lifecycle event is absent'));
        assert.ok(result.commands[0].command.includes('--provider-invocation-id "test-invocation-123"'));
        assert.ok(result.commands[0].command.includes('--launch-input-mode "copy_paste_prompt"'));
        assert.ok(result.commands[0].command.includes(
            `--launch-input-sha256 "${String(launchInputEvidenceFixture(TASK_ID, 'code').launch_input_sha256)}"`
        ));
        assert.equal(result.commands[0].command.includes('--launch-input-artifact-path'), false);
        assert.ok(!result.commands[0].command.includes('prepare-reviewer-launch'));
        assert.ok(!result.commands.some((entry) => /record-review-result|required-reviews-check|completion-gate|task-audit-summary/u.test(entry.command)));
    });

    it('does not route launched metadata without delegation-started telemetry to record-review-invocation', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_STARTED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
    });

    it('does not route stripped completed launch metadata to record-review-invocation', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        seedCompletedReviewerLaunchAndInvocation(repoRoot, TASK_ID, 'code', reviewerIdentity, {
            includeInvocation: false
        });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'reviewer-launch.json');
        const strippedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        for (const key of [
            'copy_paste_reviewer_launch_prompt',
            'copy_paste_reviewer_launch_prompt_sha256',
            'launch_input_mode',
            'launch_input_sha256',
            'launch_input_copy_paste_reviewer_launch_prompt_sha256'
        ]) {
            delete strippedArtifact[key];
        }
        writeJson(launchArtifactPath, strippedArtifact);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
    });

    it('does not route stale completed launch metadata to record-review-invocation', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: 'a'.repeat(64),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
    });

    it('routes to record-review-result with review-output-path after current context invocation is attested and output path is known', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-invocation-123'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
            review_output_path: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'review-output-from-launch.md').replace(/\\/g, '/'),
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        appendLaunchCompletedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-123'
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            review_tree_state_sha256: readReviewContextTreeStateSha256(repoRoot, TASK_ID, 'code'),
            routing_event_sha256: routeIntegrity.event_sha256,
            reviewer_launch_artifact_path: launchArtifactPath,
            reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
            reviewer_launch_attestation_source: 'test-subagent-spawn',
            reviewer_launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
            launch_input_mode: launchArtifact.launch_input_mode,
            launch_input_sha256: launchArtifact.launch_input_sha256,
            copy_paste_reviewer_launch_prompt_sha256: launchArtifact.copy_paste_reviewer_launch_prompt_sha256
        });
        fs.writeFileSync(String(launchArtifact.review_output_path), 'review output placeholder\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.commands[0].label, 'Record delegated review output file, then close reviewer');
        assert.ok(result.commands[0].command.includes(`--reviewer-identity "${reviewerIdentity}"`));
        assert.ok(!result.commands[0].command.includes('--review-output-stdin'));
        assert.ok(result.commands[0].command.includes(`--review-output-path "garda-agent-orchestrator/runtime/tmp/reviews/${TASK_ID}/code/review-output-from-launch.md"`));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-invocation-to-result',
            status: 'pass'
        });
        assert.ok(result.reason.includes('invocation=attested'));
        assert.ok(result.reason.includes('review output/receipt=receipt invalid or stale'));
    });

    it('carries one-shot delegated review evidence through required reviews, completion, and final audit routing', () => {
        const repoRoot = makeTempRepo();
        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: false, mode: 'check' });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        const reviewGateResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(reviewGateResult.next_gate, 'required-reviews-check', reviewGateResult.reason);
        assert.ok(reviewGateResult.commands[0].command.includes('gate required-reviews-check'));
        assert.ok(!reviewGateResult.commands[0].command.includes('record-review-result'));

        seedReviewGatePass(repoRoot, TASK_ID, ['code']);
        const docImpactResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(docImpactResult.next_gate, 'doc-impact-gate', docImpactResult.reason);
        assert.ok(docImpactResult.commands[0].command.includes('gate doc-impact-gate'));

        seedDocImpactPass(repoRoot, TASK_ID);
        const completionResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(completionResult.next_gate, 'completion-gate', completionResult.reason);
        assert.ok(completionResult.commands[0].command.includes('gate completion-gate'));

        seedCompletionPass(repoRoot, TASK_ID);
        const taskAuditResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(taskAuditResult.next_gate, 'task-audit-summary', taskAuditResult.reason);
        assert.ok(taskAuditResult.missing_artifacts.some((artifact) => artifact.key === 'final-closeout-json'));
        assert.ok(taskAuditResult.missing_artifacts.some((artifact) => artifact.key === 'final-closeout-markdown'));
        assert.ok(taskAuditResult.missing_artifacts.some((artifact) => artifact.key === 'final-user-report'));

        const auditSummary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        assert.deepEqual(auditSummary.final_closeout.review_integrity_attestation?.observed_issues || [], []);

        materializeFinalCloseout(repoRoot, TASK_ID);
        const completeResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(completeResult.status, 'DONE', completeResult.reason);
        assert.ok(!completeResult.commands.some((entry) => /required-reviews-check|completion-gate|task-audit-summary/u.test(entry.command)));
    });

    it('routes to record-review-result after planned reviewer identity is rebound to resolved provider identity', () => {
        const repoRoot = makeTempRepo();
        const plannedReviewerIdentity = `agent:pending:${TASK_ID}-code`;
        const resolvedReviewerIdentity = 'agent:cursor-resolved-reviewer';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', plannedReviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: plannedReviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: plannedReviewerIdentity,
            reviewer_identity: plannedReviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity: plannedReviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity: resolvedReviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-planned-rebind-invocation'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: resolvedReviewerIdentity,
            planned_reviewer_identity: plannedReviewerIdentity,
            reviewer_identity_resolved_at_utc: '2026-04-28T00:00:00.000Z',
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-planned-rebind-invocation',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
            review_output_path: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'review-output-from-rebound-launch.md').replace(/\\/g, '/'),
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        appendLaunchCompletedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity: resolvedReviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchArtifactPath,
            providerInvocationId: 'test-planned-rebind-invocation'
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: resolvedReviewerIdentity,
            reviewer_identity: resolvedReviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            review_tree_state_sha256: readReviewContextTreeStateSha256(repoRoot, TASK_ID, 'code'),
            routing_event_sha256: routeIntegrity.event_sha256,
            reviewer_launch_artifact_path: launchArtifactPath,
            reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
            reviewer_launch_attestation_source: 'test-subagent-spawn',
            reviewer_launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-planned-rebind-invocation',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
            launch_input_mode: launchArtifact.launch_input_mode,
            launch_input_sha256: launchArtifact.launch_input_sha256,
            copy_paste_reviewer_launch_prompt_sha256: launchArtifact.copy_paste_reviewer_launch_prompt_sha256
        });
        fs.writeFileSync(String(launchArtifact.review_output_path), 'review output placeholder\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.commands[0].label, 'Record delegated review output file, then close reviewer');
        assert.ok(result.commands[0].command.includes(`--reviewer-identity "${resolvedReviewerIdentity}"`));
        assert.ok(result.reason.includes('invocation=attested'));
    });

    it('does not route to record-review-result when invocation identity differs from resolved launch identity', () => {
        const repoRoot = makeTempRepo();
        const plannedReviewerIdentity = `agent:pending:${TASK_ID}-code`;
        const resolvedLaunchReviewerIdentity = 'agent:cursor-resolved-reviewer-a';
        const mismatchedInvocationReviewerIdentity = 'agent:cursor-resolved-reviewer-b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', plannedReviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: plannedReviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: plannedReviewerIdentity,
            reviewer_identity: plannedReviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            ...preparedReviewerLaunchPathFields(repoRoot, TASK_ID, 'code')
        });
        const inputPin = pinPreparedReviewerLaunchInputForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity: plannedReviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256
        });
        appendDelegationStartedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity: resolvedLaunchReviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchBindingSha256,
            preparedLaunchEventSha256: preparedIntegrity.event_sha256,
            providerInvocationId: 'test-mismatched-rebind-invocation'
        });
        const launchArtifactPath = inputPin.launchArtifactPath;
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: resolvedLaunchReviewerIdentity,
            planned_reviewer_identity: plannedReviewerIdentity,
            reviewer_identity_resolved_at_utc: '2026-04-28T00:00:00.000Z',
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            ...inputPin.controlArtifactFields,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-mismatched-rebind-invocation',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
            review_output_path: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'review-output-from-rebound-launch.md').replace(/\\/g, '/'),
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        appendLaunchCompletedEventForTest({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            reviewerIdentity: resolvedLaunchReviewerIdentity,
            reviewContextPath,
            routingEventSha256: routeIntegrity.event_sha256,
            launchArtifactPath,
            providerInvocationId: 'test-mismatched-rebind-invocation'
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: mismatchedInvocationReviewerIdentity,
            reviewer_identity: mismatchedInvocationReviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            review_tree_state_sha256: readReviewContextTreeStateSha256(repoRoot, TASK_ID, 'code'),
            routing_event_sha256: routeIntegrity.event_sha256,
            reviewer_launch_artifact_path: launchArtifactPath,
            reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
            reviewer_launch_attestation_source: 'test-subagent-spawn',
            reviewer_launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-mismatched-rebind-invocation',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
            launch_input_mode: launchArtifact.launch_input_mode,
            launch_input_sha256: launchArtifact.launch_input_sha256,
            copy_paste_reviewer_launch_prompt_sha256: launchArtifact.copy_paste_reviewer_launch_prompt_sha256
        });
        fs.writeFileSync(String(launchArtifact.review_output_path), 'review output placeholder\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-invocation', result.reason);
        assert.ok(result.commands[0].command.includes('gate record-review-invocation'));
        assert.ok(result.commands[0].command.includes(`--reviewer-identity "${resolvedLaunchReviewerIdentity}"`));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
        assert.ok(result.reason.includes('invocation=missing current-cycle attestation'));
    });

    it('keeps explicit stdin fallback when current launch metadata has no review output path', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        seedCompletedReviewerLaunchAndInvocation(repoRoot, TASK_ID, 'code', reviewerIdentity);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.commands[0].label, 'Pipe delegated review output into stdin, then close reviewer');
        assert.ok(result.commands[0].command.startsWith("'<paste exact delegated reviewer output here>' | "));
        assert.ok(result.commands[0].command.includes('--review-output-stdin'));
        assert.ok(!result.commands[0].command.includes('--review-output-path'));
    });

    it('does not route to record-review-result when invocation telemetry exists without current completed launch metadata', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { includeLaunchArtifact: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
        assert.ok(result.reason.includes('invocation=blocked until launch artifact'));
    });

    it('routes failed old review receipts through launch preparation after current context rebuild', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:code-reviewer';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID, '2026-04-28T00:00:00.000Z');
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        seedCompilePass(repoRoot, TASK_ID, '2026-04-28T00:01:00.000Z');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code',
            output_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`)
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch', result.reason);
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.equal(result.commands[0].command.includes('--reviewer-identity'), false);
        assert.ok(!result.commands[0].command.includes('record-review-result'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
        assert.ok(result.reason.includes('invocation=blocked until launch artifact'));
    });

    it('does not treat current context invocation telemetry without matching tree-state binding as attested', () => {
        for (const reviewTreeStateSha256 of [undefined, 'f'.repeat(64)] as const) {
            const repoRoot = makeTempRepo();
            const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
            seedStartedTask(repoRoot, TASK_ID);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
            seedCompilePass(repoRoot, TASK_ID);
            writeReviewEvidence(repoRoot, TASK_ID, 'code');
            writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
            const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
            const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: reviewerIdentity
            });
            appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: reviewerIdentity,
                reviewer_identity: reviewerIdentity,
                review_context_sha256: fileSha256(reviewContextPath),
                ...(reviewTreeStateSha256 ? { review_tree_state_sha256: reviewTreeStateSha256 } : {}),
                routing_event_sha256: routeIntegrity.event_sha256
            });

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'prepare-reviewer-launch');
            assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        }
    });

    it('routes fresh review contexts without routing telemetry to record-review-routing first', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', 'agent:code-reviewer');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing');
        assert.ok(result.commands[0].command.includes('gate record-review-routing'));
        assert.equal(result.commands[0].command.includes('--reviewer-identity'), false);
    });

    it('omits planned reviewer identity from routing and prepare commands until provider launch resolves it', () => {
        const repoRoot = makeTempRepo();
        const plannedReviewerIdentity = `agent:pending:${TASK_ID}-code`;
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', plannedReviewerIdentity);

        const routingResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(routingResult.next_gate, 'record-review-routing');
        assert.ok(routingResult.commands[0].command.includes('gate record-review-routing'));
        assert.equal(routingResult.commands[0].command.includes('--reviewer-identity'), false);

        appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: plannedReviewerIdentity
        });

        const prepareResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(prepareResult.next_gate, 'prepare-reviewer-launch');
        assert.ok(prepareResult.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.equal(prepareResult.commands[0].command.includes('--reviewer-identity'), false);
        assert.ok(prepareResult.reason.includes('planned reviewer identity until the provider launch returns the resolved reviewer id'));
    });

    it('routes stale review context bindings back to build-review-context after preflight refresh', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const refreshed = 3;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context');
        assert.ok(result.reason.includes('stale for the current preflight'));
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
    });

    it('blocks downstream review when receipt provenance hash does not match routing telemetry', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reviewer_provenance = {
            ...(receipt.reviewer_provenance as Record<string, unknown>),
            event_sha256: 'b'.repeat(64)
        };
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('fresh delegated-review launch evidence is missing, stale, or spoof-like'));
    });
});
