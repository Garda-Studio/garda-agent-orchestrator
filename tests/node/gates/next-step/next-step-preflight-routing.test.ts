import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';
import { readTaskQueueEntries } from '../../../../src/core/task-queue-read';
import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import type { EffectiveReviewExecutionPolicyMode } from '../../../../src/core/review-execution-policy';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import {
    buildTaskProfilePolicySnapshot,
    type TaskProfilePolicySnapshot
} from '../../../../src/policy/task-profile-policy-snapshot';
import { computeTaskPlanDigest, validateTaskPlan } from '../../../../src/schemas/task-plan';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildDomainScopeFingerprints } from './next-step-test-support';
import {
    seedGitAutoCompilePass,
    writeNoOpEvidence
} from './next-step-completion-fixtures';

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
    const fixtureProfile = {
        description: 'Preflight routing fixture profile',
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
    };
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: fixtureProfile,
            strict: {
                ...fixtureProfile,
                description: 'Strict preflight routing fixture profile',
                depth: 3
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





function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function materializeTaskModeProfileSnapshot(
    repoRoot: string,
    taskId: string,
    details: Record<string, unknown>
): Record<string, unknown> {
    const artifactPathValue = String(details.artifact_path || '').trim();
    const taskModePath = artifactPathValue
        ? path.resolve(repoRoot, artifactPathValue)
        : path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    if (!fs.existsSync(taskModePath)) {
        return details;
    }
    const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
    const taskProfile = readTaskQueueEntries(repoRoot).get(taskId)?.profile || 'balanced';
    const profilePolicySnapshot = buildTaskProfilePolicySnapshot(
        path.join(repoRoot, 'garda-agent-orchestrator'),
        taskProfile,
        {
            reviewExecutionPolicyMode: 'code_first_optional',
            reviewExecutionPolicyConfigured: true,
            fullSuiteValidationEnabled: false,
            fullSuiteValidationPlacement: 'after_compile_before_reviews',
            lockTimestampUtc: '2026-04-25T00:00:00.000Z'
        }
    );
    taskMode.task_profile = profilePolicySnapshot.source.task_profile;
    taskMode.profile_selection_source = profilePolicySnapshot.source.profile_selection_source;
    taskMode.active_profile = profilePolicySnapshot.source.effective_profile;
    taskMode.profile_source = profilePolicySnapshot.source.effective_profile_source;
    taskMode.runtime_active_profile = profilePolicySnapshot.source.runtime_active_profile;
    taskMode.runtime_profile_source = profilePolicySnapshot.source.runtime_profile_source;
    taskMode.profile_policy_snapshot_required = true;
    taskMode.profile_policy_snapshot = profilePolicySnapshot;
    writeJson(taskModePath, taskMode);
    return {
        ...details,
        profile_policy_snapshot_required: true,
        profile_policy_snapshot_hash: profilePolicySnapshot.snapshot_hash
    };
}

function materializePreflightTimelineDetails(
    repoRoot: string,
    taskId: string,
    details: Record<string, unknown>
): Record<string, unknown> {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath)) {
        return details;
    }
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    return {
        output_path: normalizeForTimeline(preflightPath),
        ...details,
        ...(preflight.effective_review_snapshot
            ? { effective_review_snapshot: preflight.effective_review_snapshot }
            : {})
    };
}



function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome = 'PASS',
    details: Record<string, unknown> = {},
    timestampUtc?: string
): { task_sequence: number; prev_event_sha256: string | null; event_sha256: string } {
    const eventDetails = eventType === 'TASK_MODE_ENTERED'
        ? materializeTaskModeProfileSnapshot(repoRoot, taskId, details)
        : eventType === 'PREFLIGHT_CLASSIFIED'
            ? materializePreflightTimelineDetails(repoRoot, taskId, details)
            : details;
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
        details: eventDetails,
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


function seedTaskModeOnly(repoRoot: string, taskId: string): void {
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
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
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

function seedHandshake(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
}

function seedShellSmoke(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
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


function getLoadedRuleFileBasenames(command: string): string[] {
    return [...command.matchAll(/--loaded-rule-file "([^"]+)"/g)]
        .map((match) => path.basename(match[1]))
        .sort();
}

function buildPreflightReviewPolicyEvidence(
    repoRoot: string,
    taskId: string,
    requiredReviews: Record<string, boolean>,
    changedFiles: string[],
    options: {
        reviewPolicyMode?: EffectiveReviewExecutionPolicyMode;
        scopeCategory?: string;
        zeroDiffBaselineOnly?: boolean;
    } = {}
): {
    profilePolicySnapshot: { snapshot_hash: string };
    reviewExecutionPolicy: {
        mode: EffectiveReviewExecutionPolicyMode;
        visible_summary_line: string;
        dependency_graph: ReturnType<typeof buildEffectiveReviewSnapshot>['review_dependency_graph'];
    };
    effectiveReviewSnapshot: ReturnType<typeof buildEffectiveReviewSnapshot>;
} {
    const catalog = normalizeReviewCatalog(
        { version: 1, custom_review_types: [] },
        { knownSkillIds: [] }
    );
    const taskModePath = path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    const taskMode = fs.existsSync(taskModePath)
        ? JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>
        : null;
    let frozenProfileSnapshot = taskMode?.profile_policy_snapshot as TaskProfilePolicySnapshot | null;
    if (!frozenProfileSnapshot) {
        const taskProfile = readTaskQueueEntries(repoRoot).get(taskId)?.profile || 'balanced';
        frozenProfileSnapshot = buildTaskProfilePolicySnapshot(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            taskProfile,
            {
                reviewExecutionPolicyMode: 'code_first_optional',
                reviewExecutionPolicyConfigured: true,
                fullSuiteValidationEnabled: false,
                fullSuiteValidationPlacement: 'after_compile_before_reviews',
                lockTimestampUtc: '2026-04-25T00:00:00.000Z'
            }
        );
        const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
        const timelineDeclaresSnapshot = fs.existsSync(timelinePath)
            && fs.readFileSync(timelinePath, 'utf8').includes(
                `"profile_policy_snapshot_hash":"${frozenProfileSnapshot.snapshot_hash}"`
            );
        if (taskMode && timelineDeclaresSnapshot) {
            materializeTaskModeProfileSnapshot(repoRoot, taskId, {});
            frozenProfileSnapshot = (
                JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>
            ).profile_policy_snapshot as TaskProfilePolicySnapshot;
        }
    }
    const reviewPolicyMode = options.reviewPolicyMode
        || frozenProfileSnapshot.review_execution_policy.mode;
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
        scopeCategory: options.scopeCategory || 'code',
        taskIntent: 'Exercise next-step preflight routing',
        changedFiles,
        taskTriggers: {},
        zeroDiffBaselineOnly: options.zeroDiffBaselineOnly === true,
        reviewExecutionPolicyMode: reviewPolicyMode,
        reviewDependencyGraph: null,
        fullSuiteValidation: {
            enabled: false,
            placement: 'after_compile_before_reviews'
        },
        includeDependencyGraph: true
    });
    return {
        profilePolicySnapshot: {
            snapshot_hash: frozenProfileSnapshot.snapshot_hash
        },
        reviewExecutionPolicy: {
            mode: reviewPolicyMode,
            visible_summary_line: `Review execution policy: ${reviewPolicyMode}`,
            dependency_graph: effectiveReviewSnapshot.review_dependency_graph
        },
        effectiveReviewSnapshot
    };
}

function writePreflight(
    repoRoot: string,
    taskId: string,
    requiredReviews: Record<string, boolean>,
    options: {
        seedPostPreflight?: boolean;
        reviewPolicyMode?: EffectiveReviewExecutionPolicyMode;
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
    const reviewPolicyEvidence = buildPreflightReviewPolicyEvidence(
        repoRoot,
        taskId,
        requiredReviews,
        changedFiles,
        { reviewPolicyMode: options.reviewPolicyMode }
    );
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
        ...(reviewPolicyEvidence
            ? {
                profile_policy_snapshot: reviewPolicyEvidence.profilePolicySnapshot,
                review_execution_policy: reviewPolicyEvidence.reviewExecutionPolicy,
                effective_review_snapshot: reviewPolicyEvidence.effectiveReviewSnapshot
            }
            : {
                review_execution_policy: {
                    mode: options.reviewPolicyMode || 'code_first_optional',
                    visible_summary_line: `Review execution policy: ${options.reviewPolicyMode || 'code_first_optional'}`
                }
            })
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath),
        ...(reviewPolicyEvidence
            ? { effective_review_snapshot: reviewPolicyEvidence.effectiveReviewSnapshot }
            : {})
    });
    if (options.seedPostPreflight !== false) {
        seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
    }
    return preflightPath;
}

function writeBaselineOnlyPreflight(
    repoRoot: string,
    taskId: string,
    options: {
        seedPostPreflight?: boolean;
        requiredReviews?: Partial<Record<keyof typeof ALL_REVIEW_FLAGS, boolean>>;
    } = {}
): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
    const requiredReviews = { ...ALL_REVIEW_FLAGS, ...options.requiredReviews };
    const reviewPolicyEvidence = buildPreflightReviewPolicyEvidence(
        repoRoot,
        taskId,
        requiredReviews,
        [],
        {
            scopeCategory: 'empty',
            zeroDiffBaselineOnly: true
        }
    );
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'empty',
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256
        },
        required_reviews: requiredReviews,
        changed_files: [],
        ...(reviewPolicyEvidence
            ? {
                profile_policy_snapshot: reviewPolicyEvidence.profilePolicySnapshot,
                review_execution_policy: reviewPolicyEvidence.reviewExecutionPolicy,
                effective_review_snapshot: reviewPolicyEvidence.effectiveReviewSnapshot
            }
            : {
                review_execution_policy: {
                    mode: 'code_first_optional',
                    visible_summary_line: 'Review execution policy: code_first_optional'
                }
            }),
        profile_guardrails: {
            zero_diff_no_reviewable_scope: true
        },
        zero_diff_guard: {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true,
            no_op_artifact_suffix: '-no-op.json',
            rationale: 'Preflight on a clean workspace is baseline-only.'
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath),
        ...(reviewPolicyEvidence
            ? { effective_review_snapshot: reviewPolicyEvidence.effectiveReviewSnapshot }
            : {})
    });
    if (options.seedPostPreflight !== false) {
        seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
    }
    return preflightPath;
}

function buildDirtyBaselinePreflightError(preTaskModifiedFiles: string[]): string {
    return [
        `Workspace already contained modified files before task-mode entry: ${preTaskModifiedFiles.join(', ')}.`,
        'This run is invalid as a normal orchestrated task start because task-mode entry must happen before any edits.',
        'The optional start marker is a one-time orchestrator-mode UX marker, not a file-state claim.',
        'Clean/stash unrelated changes, or rerun classify-change with --use-staged or explicit --changed-file scope after entering task mode.'
    ].join(' ');
}

function seedDirtyBaselinePreflightFailure(
    repoRoot: string,
    taskId: string,
    preTaskModifiedFiles: string[],
    options: {
        currentWorkspaceFiles?: string[];
        structured?: boolean;
    } = {}
): void {
    appendEvent(repoRoot, taskId, 'PREFLIGHT_FAILED', 'FAIL', {
        error: buildDirtyBaselinePreflightError(preTaskModifiedFiles),
        task_intent: 'Recover dirty-baseline preflight scope',
        ...(options.structured === false
            ? {}
            : {
                preflight_failure_reason_code: 'dirty_baseline_requires_explicit_scope',
                pre_task_modified_files: preTaskModifiedFiles,
                dirty_workspace_baseline_changed_files: preTaskModifiedFiles,
                current_workspace_changed_files: options.currentWorkspaceFiles || preTaskModifiedFiles,
                explicit_changed_files_provided: false,
                use_staged: false,
                include_untracked: true
            })
    });
}

function seedAuthenticatedSplitCheckpointTask(repoRoot: string): {
    parentTaskId: string;
    checkpointCommit: string;
    detectionSource: string;
} {
    const parentTaskId = TASK_ID.split('-').slice(0, -1).join('-');
    initGitRepo(repoRoot);

    fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const checkpointScope = true;\n', 'utf8');
    runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
    runGitFixtureCommand(repoRoot, [
        'commit',
        '-m',
        `checkpoint(split): preserve ${parentTaskId} dirty diff before decomposition`
    ]);
    const checkpointCommit = runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
    const baseCommit = runGitFixtureCommand(repoRoot, ['rev-parse', `${checkpointCommit}^`]).stdout.trim();

    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${parentTaskId} | DECOMPOSED | P1 | workflow | Parent checkpoint | gpt-5.4 | 2026-04-25 | balanced | Split checkpoint \`${checkpointCommit}\` preserves parent work. Child tasks: \`${TASK_ID}\`. |`,
        `| ${TASK_ID} | TODO | P1 | workflow | Child checkpoint | gpt-5.4 | 2026-04-25 | balanced | Child of \`${parentTaskId}\`. Checkpoint: \`${checkpointCommit}\`. Checkpoint files: \`src/app.ts\`. |`,
        ''
    ].join('\n'), 'utf8');
    runGitFixtureCommand(repoRoot, ['add', 'TASK.md']);
    runGitFixtureCommand(repoRoot, ['commit', '-m', 'test: bind split checkpoint tasks']);

    return {
        parentTaskId,
        checkpointCommit,
        detectionSource: `git_split_checkpoint:${baseCommit}:${checkpointCommit}`
    };
}




















afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step preflight routing', () => {
    it('routes to classify-change before preflight and POST_PREFLIGHT rules after preflight', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const missingPreflight = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingPreflight.next_gate, 'classify-change');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { seedPostPreflight: false });
        const missingPostPreflight = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingPostPreflight.next_gate, 'load-rule-pack');
        assert.ok(missingPostPreflight.commands[0].command.includes('--stage "POST_PREFLIGHT"'));
        assert.ok(!missingPostPreflight.commands[0].command.includes('<task-specific-rule-file>'));
        assert.deepEqual(getLoadedRuleFileBasenames(missingPostPreflight.commands[0].command), [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]);
    });

    it('routes baseline-only code-changing task intent to implementation instead of compile', () => {
        for (const taskSummary of [
            'Route planned code-changing tasks to implementation before compile',
            'Route planned code changing tasks to implementation before compile',
            'Enforce next-step implementation routing before compile',
            'Rename next-step implementation state before compile',
            'Harden next-step preflight scope before compile',
            'Validate next-step planned scope before compile',
            'Prevent next-step compile before implementation',
            'Avoid false record-no-op routing for tasks that still require implementation',
            'Remove obsolete next-step gate logic',
            'Replace next-step compile routing with implementation routing',
            'Correct navigator no-op intent classification',
            'Prevent docs only wording from bypassing the implementation gate',
            'Avoid no changes required wording from bypassing the implementation gate',
            'Prevent audit-only: update next-step gate docs from bypassing implementation',
            'Update project memory map before compile',
            'Refresh ignored project-memory scope before compile'
        ]) {
            const repoRoot = makeTempRepo();
            initGitRepo(repoRoot);
            writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
                taskId: TASK_ID,
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary,
                startBanner: 'Garda captures my mind',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            }));
            appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
            seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
            seedHandshake(repoRoot, TASK_ID);
            seedShellSmoke(repoRoot, TASK_ID);
            writeBaselineOnlyPreflight(repoRoot, TASK_ID);

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'implementation', taskSummary);
            assert.equal(result.commands.length, 0);
            assert.match(result.reason, /BASELINE_ONLY with no reviewable diff/u);
            assert.match(result.reason, /Do not run compile-gate/u);
        }
    });

    it('does not treat no-op inside a longer area slug as explicit no-op intent', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8')
                .replace('ux/test', 'workflow/no-op-blocked-state-distinction'),
            'utf8'
        );
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 3,
            effectiveDepth: 3,
            taskSummary: 'Distinguish audited zero-diff no-op from implementation tasks blocked in next-step',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writeBaselineOnlyPreflight(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'implementation', result.reason);
        assert.equal(result.commands.length, 0);
    });

    it('does not let baseline compile evidence satisfy an implementation task', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 3,
            effectiveDepth: 3,
            taskSummary: 'Avoid false record-no-op routing for tasks that still require implementation',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writeBaselineOnlyPreflight(repoRoot, TASK_ID);

        const beforeCompile = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(beforeCompile.next_gate, 'implementation', beforeCompile.reason);
        assert.equal(beforeCompile.commands.length, 0);

        seedGitAutoCompilePass(repoRoot, TASK_ID);
        const baselineResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(baselineResult.next_gate, 'implementation', baselineResult.reason);
        assert.equal(baselineResult.commands.length, 0);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const implemented = true;\n', 'utf8');
        const implementedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(implementedResult.next_gate, 'classify-change', implementedResult.reason);
    });

    it('accepts current audited no-op evidence as the explicit implementation escape hatch', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 3,
            effectiveDepth: 3,
            taskSummary: 'Avoid false record-no-op routing for tasks that still require implementation',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        const preflightPath = writeBaselineOnlyPreflight(repoRoot, TASK_ID);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.notEqual(result.next_gate, 'implementation', result.reason);
        assert.notEqual(result.next_gate, 'record-no-op', result.reason);
    });

    it('recovers dirty-baseline preflight failure with staged scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const stagedRecovery = true;\n', 'utf8');
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        seedDirtyBaselinePreflightFailure(repoRoot, TASK_ID, ['src/app.ts']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.match(result.title, /staged scope/u);
        assert.ok(command.includes('gate classify-change'));
        assert.ok(command.includes('--use-staged'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('recovers dirty-baseline preflight failure with planned explicit scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Recover dirty-baseline preflight with planned scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedRecovery = true;\n', 'utf8');
        seedDirtyBaselinePreflightFailure(repoRoot, TASK_ID, ['src/app.ts']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.match(result.title, /explicit task scope/u);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('--use-staged'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('prioritizes protected orchestrator restart over dirty-baseline staged recovery', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n',
            'utf8'
        );
        const protectedPath = path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts');
        fs.mkdirSync(path.dirname(protectedPath), { recursive: true });
        fs.writeFileSync(protectedPath, 'export const protectedBaseline = true;\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const stagedRecovery = true;\n', 'utf8');
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        fs.appendFileSync(protectedPath, 'export const protectedRecovery = true;\n', 'utf8');
        seedDirtyBaselinePreflightFailure(repoRoot, TASK_ID, ['src/app.ts'], {
            currentWorkspaceFiles: ['src/app.ts', 'src/gates/next-step/next-step.ts']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.match(result.reason, /protected control-plane scope must be recovered first/u);
        assert.ok(command.includes('gate enter-task-mode'));
        assert.ok(command.includes('--orchestrator-work'));
        assert.ok(command.includes('--operator-confirmed yes'));
        assert.ok(command.includes('--planned-changed-file "src/gates/next-step/next-step.ts"'));
        assert.ok(!command.includes('--use-staged'));
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('prioritizes workflow-config restart over dirty-baseline recovery', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n',
            'utf8'
        );
        const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
        workflowConfig.full_suite_validation = {
            ...(workflowConfig.full_suite_validation as Record<string, unknown>),
            command: 'npm run test:workflow-config-recovery'
        };
        writeJson(workflowConfigPath, workflowConfig);
        seedDirtyBaselinePreflightFailure(repoRoot, TASK_ID, ['garda-agent-orchestrator/live/config/workflow-config.json']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.match(result.reason, /protected control-plane scope must be recovered first/u);
        assert.ok(command.includes('gate enter-task-mode'));
        assert.ok(command.includes('--orchestrator-work'));
        assert.ok(command.includes('--workflow-config-work'));
        assert.ok(command.includes('--operator-confirmed yes'));
        assert.ok(command.includes('--planned-changed-file "garda-agent-orchestrator/live/config/workflow-config.json"'));
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('blocks dirty-baseline preflight failure when task scope cannot be inferred', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        const dirtyFiles = Array.from({ length: 14 }, (_, index) => `docs/dirty-${index + 1}.md`);
        for (const dirtyFile of dirtyFiles) {
            fs.writeFileSync(path.join(repoRoot, dirtyFile), `dirty ${dirtyFile}\n`, 'utf8');
        }
        seedDirtyBaselinePreflightFailure(repoRoot, TASK_ID, dirtyFiles);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'manual-scope-selection', result.reason);
        assert.equal(result.commands.length, 0);
        assert.match(result.reason, /cannot safely infer/u);
        assert.match(result.reason, /Candidate dirty paths/u);
        assert.match(result.reason, /\+2 more/u);
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('blocks legacy text-only dirty-baseline preflight failure without repeating unscoped classify', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'legacy-dirty.md'), 'legacy dirty\n', 'utf8');
        seedDirtyBaselinePreflightFailure(repoRoot, TASK_ID, ['docs/legacy-dirty.md'], { structured: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'manual-scope-selection', result.reason);
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('docs/legacy-dirty.md'));
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('surfaces ignored structured planned files before compile', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot, { gitignoreContent: 'ignored-plan/**\n' });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Create ignored planned file before compile',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['ignored-plan/generated.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writeBaselineOnlyPreflight(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'materialize-planned-scope', result.reason);
        assert.equal(result.commands.length, 0);
        assert.match(result.reason, /Structured planned files: "ignored-plan\/generated\.ts"/u);
        assert.match(result.reason, /Planned files ignored by git scope: "ignored-plan\/generated\.ts"/u);
    });

    it('uses attached JSON task-plan scope files with canonical plan digest', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot, { gitignoreContent: 'ignored-plan/**\n' });
        const planRelativePath = `garda-agent-orchestrator/runtime/plans/${TASK_ID}.json`;
        const planPath = path.join(repoRoot, ...planRelativePath.split('/'));
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        const plan = validateTaskPlan({
            schema_version: 1,
            task_id: TASK_ID,
            status: 'approved',
            goal: 'Create ignored generated file before compile',
            scope_files: ['ignored-plan/generated.ts'],
            risk_level: 'low',
            steps: [
                { id: 'materialize', title: 'Create ignored generated file' }
            ]
        });
        const planSha256 = computeTaskPlanDigest(plan);
        fs.writeFileSync(planPath, `${JSON.stringify({ ...plan, plan_sha256: planSha256 }, null, 2)}\n`, 'utf8');
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Create ignored planned file before compile',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plan: {
                plan_path: planRelativePath,
                plan_sha256: planSha256,
                plan_summary: 'Create ignored generated file'
            }
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writeBaselineOnlyPreflight(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'materialize-planned-scope', result.reason);
        assert.match(result.reason, /Structured planned files: "ignored-plan\/generated\.ts"/u);
        assert.match(result.reason, /Planned files ignored by git scope: "ignored-plan\/generated\.ts"/u);
    });

    it('ignores unauthorized attached JSON task-plan scope before compile', () => {
        const cases = [
            {
                name: 'wrong task id',
                planTaskId: 'T-NEXT-OTHER',
                status: 'approved',
                taskModeSha256: 'computed',
                expectedDiagnostic: /Attached task plan ignored: plan task_id 'T-NEXT-OTHER' does not match active task 'T-NEXT-1'\./u
            },
            {
                name: 'draft plan',
                planTaskId: TASK_ID,
                status: 'draft',
                taskModeSha256: 'computed',
                expectedDiagnostic: /Attached task plan ignored: plan status is 'draft', not approved\./u
            },
            {
                name: 'missing task-mode sha',
                planTaskId: TASK_ID,
                status: 'approved',
                taskModeSha256: '',
                expectedDiagnostic: /Attached task plan ignored: task-mode plan_sha256 is missing\./u
            }
        ] as const;
        for (const testCase of cases) {
            const repoRoot = makeTempRepo();
            initGitRepo(repoRoot, { gitignoreContent: 'ignored-plan/**\n' });
            const planRelativePath = `garda-agent-orchestrator/runtime/plans/${testCase.name.replace(/\s+/gu, '-')}.json`;
            const planPath = path.join(repoRoot, ...planRelativePath.split('/'));
            fs.mkdirSync(path.dirname(planPath), { recursive: true });
            const plan = validateTaskPlan({
                schema_version: 1,
                task_id: testCase.planTaskId,
                status: testCase.status,
                goal: 'Create ignored generated file before compile',
                scope_files: ['ignored-plan/generated.ts'],
                risk_level: 'low',
                steps: [
                    { id: 'materialize', title: 'Create ignored generated file' }
                ]
            });
            const planSha256 = computeTaskPlanDigest(plan);
            fs.writeFileSync(planPath, `${JSON.stringify({ ...plan, plan_sha256: planSha256 }, null, 2)}\n`, 'utf8');
            const taskModeArtifact = buildTaskModeArtifact({
                taskId: TASK_ID,
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Create ignored planned file before compile',
                startBanner: 'Garda captures my mind',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved',
                plan: {
                    plan_path: planRelativePath,
                    plan_sha256: planSha256,
                    plan_summary: 'Create ignored generated file'
                }
            });
            if (testCase.taskModeSha256 !== 'computed' && taskModeArtifact.plan) {
                taskModeArtifact.plan.plan_sha256 = testCase.taskModeSha256;
            }
            writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), taskModeArtifact);
            appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
            seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
            seedHandshake(repoRoot, TASK_ID);
            seedShellSmoke(repoRoot, TASK_ID);
            writeBaselineOnlyPreflight(repoRoot, TASK_ID);

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'implementation', testCase.name);
            assert.equal(result.commands.length, 0);
            assert.match(result.reason, /No authorized structured planned files are available/u);
            assert.match(result.reason, testCase.expectedDiagnostic);
            assert.doesNotMatch(result.reason, /Structured planned files: "ignored-plan\/generated\.ts"/u);
        }
    });

    it('does not treat optional Markdown working-plan scope as gate-owned planned files', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot, { gitignoreContent: 'ignored-plan/**\n' });
        const markdownPlanRelativePath = `garda-agent-orchestrator/runtime/plans/${TASK_ID}.md`;
        const markdownPlanPath = path.join(repoRoot, ...markdownPlanRelativePath.split('/'));
        fs.mkdirSync(path.dirname(markdownPlanPath), { recursive: true });
        fs.writeFileSync(markdownPlanPath, [
            `# ${TASK_ID} working plan`,
            '',
            '## Scope',
            '- ignored-plan/generated.ts',
            ''
        ].join('\n'), 'utf8');
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Record optional executor guidance',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            markdownWorkingPlan: {
                format: 'markdown',
                working_plan_path: markdownPlanRelativePath,
                working_plan_sha256: fileSha256(markdownPlanPath),
                byte_count: fs.statSync(markdownPlanPath).size
            }
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writeBaselineOnlyPreflight(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'implementation', result.reason);
        assert.equal(result.commands.length, 0);
        assert.doesNotMatch(result.reason, /Structured planned files/u);
        assert.doesNotMatch(result.reason, /ignored-plan\/generated\.ts/u);
    });

    it('routes baseline-only no-op intent directly to audited no-op evidence', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Audit-only: update next-step gate docs',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writeBaselineOnlyPreflight(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-no-op');
        assert.match(result.commands[0].command, /gate record-no-op/u);

        seedGitAutoCompilePass(repoRoot, TASK_ID);
        const afterCompile = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(afterCompile.next_gate, 'record-no-op', afterCompile.reason);
    });

    it('honors explicit audit and no-change metadata forms', () => {
        for (const { taskRowReplacement, taskSummary } of [
            {
                taskRowReplacement: '| ux/test | Audit-only: update next-step gate docs | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |',
                taskSummary: 'Review explicit task metadata'
            },
            {
                taskRowReplacement: '| ux/test | Review next-step metadata | gpt-5.4 | 2026-04-25 | balanced | Audit-only task. Update next-step gate docs. |',
                taskSummary: 'Review explicit task metadata'
            },
            {
                taskRowReplacement: '| workflow/no-op | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |',
                taskSummary: 'Review explicit task metadata'
            },
            {
                taskRowReplacement: '| workflow/noop | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |',
                taskSummary: 'Review explicit task metadata'
            },
            ...[
                'No-op: update next-step gate docs',
                'Already done: update next-step gate docs',
                'Closeout only: update next-step gate docs',
                'Docs only: update next-step gate docs',
                'No code changes required: update next-step gate docs',
                'No implementation required: update next-step gate docs'
            ].map((summary) => ({
                taskRowReplacement: '| ux/test | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |',
                taskSummary: summary
            }))
        ]) {
            const repoRoot = makeTempRepo();
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    '| ux/test | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |',
                    taskRowReplacement
                ),
                'utf8'
            );
            initGitRepo(repoRoot);
            writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
                taskId: TASK_ID,
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary,
                startBanner: 'Garda captures my mind',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            }));
            appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
            seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
            seedHandshake(repoRoot, TASK_ID);
            seedShellSmoke(repoRoot, TASK_ID);
            writeBaselineOnlyPreflight(repoRoot, TASK_ID);

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.equal(result.next_gate, 'record-no-op', result.reason);

            seedGitAutoCompilePass(repoRoot, TASK_ID);
            const afterCompile = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.equal(afterCompile.next_gate, 'record-no-op', afterCompile.reason);
        }
    });

    it('honors a dated audit-only review marker in task notes despite code-changing note text', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                '| ux/test | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |',
                '| workflow/workflow-set-downstream-automation-alignment | Check downstream automation and docs for the stricter workflow set contract | gpt-5.4 | 2026-07-02 | balanced | Child task. Reviewed 2026-07-02: audit-only. Check scripts and downstream automation that mutate workflow settings; they must route through audited workflow set. |'
            ),
            'utf8'
        );
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Check downstream automation and docs for the stricter workflow set contract',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writeBaselineOnlyPreflight(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.next_gate, 'record-no-op', result.reason);

        seedGitAutoCompilePass(repoRoot, TASK_ID);
        const afterCompile = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(afterCompile.next_gate, 'record-no-op', afterCompile.reason);
    });

    it('continues normal implemented diffs to compile gate', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.match(result.commands[0].command, /gate compile-gate/u);
    });

    it('uses task-mode planned scope when building the initial classify-change command', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Polish next-step planned scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: [
                'src/gates/next-step.ts',
                'docs/cli-reference.md'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--task-intent "Polish next-step planned scope"'));
        assert.ok(command.includes('--changed-file "docs/cli-reference.md"'));
        assert.ok(command.includes('--changed-file "src/gates/next-step.ts"'));
        assert.ok(!command.includes('<path>'));
        assert.ok(!command.includes('<task summary>'));
    });

    it('keeps task-owned ignored workflow-config in the initial classify-change command', () => {
        const repoRoot = makeTempRepo();
        const workflowConfigRelativePath = 'garda-agent-orchestrator/live/config/workflow-config.json';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), `${workflowConfigRelativePath}\n`, 'utf8');
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Audit temporary workflow-config override',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: [workflowConfigRelativePath]
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes(`--changed-file "${workflowConfigRelativePath}"`));
        assert.ok(!command.includes('<path>'));
    });

    it('adds changed dependency lockfile siblings to planned manifest classify-change commands', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Update dependency manifest',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['package.json']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'sibling-drift.ts'), 'export const siblingDrift = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "package.json"'));
        assert.ok(command.includes('--changed-file "package-lock.json"'));
        assert.ok(!command.includes('src/sibling-drift.ts'));
    });

    it('adds changed dependency manifest siblings to planned lockfile classify-change commands', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Close lockfile split child after manifest remediation',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['package-lock.json']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "package-lock.json"'));
        assert.ok(command.includes('--changed-file "package.json"'));
        assert.ok(!command.includes('CHANGELOG.md'));
    });

    it('blocks planned-scope preflight until the planned files have a materialized diff', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Create planned docs after classification',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'materialize-planned-scope');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('planned --changed-file hints [src/app.ts]'));
        assert.ok(result.reason.includes('no materialized diff'));
        assert.ok(result.reason.includes('rerun next-step'));
    });

    it('keeps unrelated sibling drift out of planned-scope materialization recovery', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Create planned source after classification',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- unrelated note\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'materialize-planned-scope');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('planned --changed-file hints [src/app.ts]'));
        assert.ok(!result.reason.includes('CHANGELOG.md'));
    });

    it('rejects planned-scope preflight missing post-entry drift after planned files materialize', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Create planned docs after classification',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedMaterialized = true;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('Refresh classify-change for the current scope first'));
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "CHANGELOG.md"'));
        assert.ok(!command.includes('<path>'));
    });

    it('refreshes planned dependency manifest scope with changed lockfile siblings', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh package manifest and lockfile',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['package.json']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['package.json'] });
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /missing from preflight: \[CHANGELOG\.md, package-lock\.json\]/);
        assert.ok(command.includes('--changed-file "package.json"'));
        assert.ok(command.includes('--changed-file "package-lock.json"'));
        assert.ok(command.includes('--changed-file "CHANGELOG.md"'));
    });

    it('refreshes planned dependency lockfile scope with changed manifest siblings', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh lockfile split child after manifest remediation',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['package-lock.json']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['package-lock.json'] });
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /missing from preflight: \[CHANGELOG\.md, package\.json\]/);
        assert.ok(command.includes('--changed-file "package-lock.json"'));
        assert.ok(command.includes('--changed-file "package.json"'));
        assert.ok(command.includes('--changed-file "CHANGELOG.md"'));
    });

    it('includes related test changes when refreshing planned source scope', () => {
        const repoRoot = makeTempRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates', 'next-step'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts'),
            'export const nextStep = true;\n',
            'utf8'
        );
        fs.mkdirSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'node', 'gates', 'next-step', 'next-step-preflight-routing.test.ts'),
            'import assert from "node:assert/strict";\n',
            'utf8'
        );
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned source and related tests',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/gates/next-step/next-step.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/gates/next-step/next-step.ts'] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts'), 'export const plannedNextStep = true;\n', 'utf8');
        fs.appendFileSync(
            path.join(repoRoot, 'tests', 'node', 'gates', 'next-step', 'next-step-preflight-routing.test.ts'),
            'assert.ok(true);\n',
            'utf8'
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/gates/next-step/next-step.ts"'));
        assert.ok(command.includes('--changed-file "tests/node/gates/next-step/next-step-preflight-routing.test.ts"'));
    });

    it('accepts refreshed planned source scope with related tests and no-diff planned hints', () => {
        const repoRoot = makeTempRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates', 'next-step'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts'), 'export const nextStep = true;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step-helper.ts'), 'export const helper = true;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step', 'next-step-preflight-routing.test.ts'), 'export const testCase = true;\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Accept planned source and related test scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: [
                'src/gates/next-step/next-step.ts',
                'src/gates/next-step/next-step-helper.ts'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts'), 'export const plannedNextStep = true;\n', 'utf8');
        fs.appendFileSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step', 'next-step-preflight-routing.test.ts'), 'export const relatedTest = true;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            seedPostPreflight: false,
            changedFiles: [
                'src/gates/next-step/next-step.ts',
                'src/gates/next-step/next-step-helper.ts',
                'tests/node/gates/next-step/next-step-preflight-routing.test.ts'
            ]
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const actualChangedFiles = [
            'src/gates/next-step/next-step.ts',
            'tests/node/gates/next-step/next-step-preflight-routing.test.ts'
        ];
        preflight.authorized_files = [
            'src/gates/next-step/next-step.ts',
            'src/gates/next-step/next-step-helper.ts',
            'tests/node/gates/next-step/next-step-preflight-routing.test.ts'
        ];
        (preflight.metrics as Record<string, unknown>).actual_changed_files = actualChangedFiles;
        (preflight.metrics as Record<string, unknown>).actual_changed_files_sha256 =
            sha256Text(actualChangedFiles.join('\n'));
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'classify-change', result.reason);
        assert.ok(!result.reason.includes('no longer current: [src/gates/next-step/next-step-helper.ts]'), result.reason);
    });

    it('uses staged scope for first classify-change when unstaged sibling drift is present', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Classify staged task change',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const stagedTaskChange = true;\n', 'utf8');
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- unrelated unstaged note\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--use-staged'));
        assert.ok(!command.includes('CHANGELOG.md'));
    });

    it('uses staged scope for split child classify-change when sibling drift is present', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-PARENT | DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-06-25 | strict | Child tasks: `T-NEXT-1` and `T-NEXT-2`. |',
            `| ${TASK_ID} | TODO | P1 | workflow/split-child | First split child | gpt-5.5 | 2026-06-25 | strict | Child of T-PARENT; isolate staged child scope from sibling drift. |`,
            '| T-NEXT-2 | TODO | P1 | workflow/split-child | Sibling split child | gpt-5.5 | 2026-06-25 | strict | Sibling child. |',
            ''
        ].join('\n'), 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'First split child staged implementation',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const splitChildChange = true;\n', 'utf8');
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(path.join(repoRoot, 'src', 'sibling-drift.ts'), 'export const siblingDrift = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--use-staged'));
        assert.ok(!command.includes('src/sibling-drift.ts'));
    });

    it('refreshes workflow-config preflight when dirty-baseline source files are outside scope', () => {
        const repoRoot = makeTempRepo();
        const workflowConfigPath = 'template/config/workflow-config.json';
        fs.mkdirSync(path.join(repoRoot, 'template', 'config'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, workflowConfigPath), '{\n  "version": 1\n}\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const hiddenDirtyBaseline = true;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, workflowConfigPath), '{\n  "version": 2\n}\n', 'utf8');

        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
            detection_source: baselineSnapshot.detection_source,
            include_untracked: !!baselineSnapshot.include_untracked,
            changed_files: baselineSnapshot.changed_files,
            changed_files_sha256: baselineSnapshot.changed_files_sha256,
            scope_sha256: baselineSnapshot.scope_sha256,
            file_hashes: Object.fromEntries(
                baselineSnapshot.changed_files.map((changedFile) => [
                    changedFile,
                    fileSha256(path.join(repoRoot, changedFile))
                ])
            )
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected workflow config scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            workflowConfigWork: true,
            plannedChangedFiles: [workflowConfigPath],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: [workflowConfigPath]
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.triggers = {
            changed_workflow_config_files: [workflowConfigPath],
            dirty_workspace_baseline_changed_files: baselineSnapshot.changed_files,
            dirty_workspace_baseline_changed_files_sha256: baselineSnapshot.changed_files_sha256,
            dirty_workspace_protected_files: ['src/app.ts'],
            dirty_workspace_protected_files_sha256: sha256Text('src/app.ts'),
            dirty_workspace_protected_file_hashes: {
                'src/app.ts': fileSha256(path.join(repoRoot, 'src', 'app.ts'))
            },
            dirty_workspace_protection_status: 'PASS',
            dirty_workspace_protection_changed_files: []
        };
        writeJson(preflightPath, preflight);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /workflow-config preflight is underscoped/);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "template/config/workflow-config.json"'));
    });

    it('preserves custom task-mode path when building classify-change commands', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-custom-task-mode.json`);
        writeJson(customTaskModePath, buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Classify custom task-mode scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            artifact_path: normalizeForTimeline(customTaskModePath)
        });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY', customTaskModePath);
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--task-intent "Classify custom task-mode scope"'));
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes(`--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`));
    });

    it('preserves planned changed files when refreshing a stale scoped preflight', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh a scoped next-step preflight',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: [
                'src/app.ts',
                'docs/cli-reference.md'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const drift = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "docs/cli-reference.md"'));
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('<path>'));
    });

    it('keeps planned refresh explicit when current workspace has no planned-file intersection', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'older-task.md'), 'unrelated dirty file\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
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
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh a no-intersection planned preflight',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            dirtyWorkspaceBaseline,
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('docs/older-task.md'));
    });

    it('rejects stale same-domain baseline files from planned preflight refresh scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        const unrelatedBaselinePath = 'src/older-task.ts';
        fs.writeFileSync(path.join(repoRoot, ...unrelatedBaselinePath.split('/')), 'export const olderTask = true;\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
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
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned scope without same-domain baseline files',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            dirtyWorkspaceBaseline,
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const currentTask = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        assert.ok(!command.includes(unrelatedBaselinePath), command);
    });

    it('does not widen planned refresh through stale explicit preflight files', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'older-task.md'), 'unrelated dirty file\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
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
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh stale explicit preflight without widening planned scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            dirtyWorkspaceBaseline,
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: ['src/app.ts', 'docs/older-task.md']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('docs/older-task.md'));
    });

    it('accepts refreshed planned-scope preflight when unrelated dirty files remain outside the task scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'older-task.md'), 'unrelated dirty file\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
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
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Use refreshed planned preflight in a dirty workspace',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: ['src/app.ts'],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedRefresh = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
    });

    it('refreshes planned-scope preflight when a new unplanned file appears after planned files are materialized', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'extra'), { recursive: true });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned preflight with new unplanned current edits',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedRefresh = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.writeFileSync(path.join(repoRoot, 'src', 'extra', 'unplanned.ts'), 'export const unplanned = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('missing from preflight: [src/extra/unplanned.ts]'), result.reason);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "src/extra/unplanned.ts"'));
    });

    it('refreshes planned-scope preflight when a new unplanned file appears before planned files are materialized', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'extra'), { recursive: true });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned preflight with early unplanned current edits',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.writeFileSync(path.join(repoRoot, 'src', 'extra', 'unplanned.ts'), 'export const unplanned = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('missing from preflight: [src/extra/unplanned.ts]'), result.reason);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "src/extra/unplanned.ts"'));
    });

    it('keeps ignored task-owned TASK.md metadata in stale preflight refresh commands', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot, {
            gitignoreContent: 'TASK.md\ngarda-agent-orchestrator/runtime/\n'
        });
        const taskMdPath = path.join(repoRoot, 'TASK.md');
        const taskMdBaselineHash = fileSha256(taskMdPath);
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: ['TASK.md'],
            changed_files_sha256: sha256Text('TASK.md'),
            scope_sha256: null,
            file_hashes: {
                'TASK.md': taskMdBaselineHash
            }
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned source after task queue metadata changes',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: ['src/app.ts'],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedRefresh = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.appendFileSync(taskMdPath, '\nOperator note after preflight.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('missing from preflight: [TASK.md]'), result.reason);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "TASK.md"'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('refreshes stale preflight with authenticated split-checkpoint detection source and exact files', () => {
        const repoRoot = makeTempRepo();
        const checkpoint = seedAuthenticatedSplitCheckpointTask(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: ['src/app.ts'],
            seedPostPreflight: false
        });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            restarted: true
        });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.match(result.reason, /Preflight evidence is older than the latest TASK_MODE_ENTERED/);
        assert.ok(command.includes(`--detection-source "${checkpoint.detectionSource}"`), command);
        assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        assert.ok(!command.includes('--changed-file "<path>"'), command);
    });

    it('keeps route-specific refresh scope when split-checkpoint metadata does not match current drift', () => {
        const repoRoot = makeTempRepo();
        const checkpoint = seedAuthenticatedSplitCheckpointTask(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: ['src/app.ts'],
            seedPostPreflight: false
        });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            restarted: true
        });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.mkdirSync(path.join(repoRoot, 'src', 'extra'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'extra', 'unplanned.ts'), 'export const unplanned = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.ok(command.includes('--changed-file "src/extra/unplanned.ts"'), command);
        assert.ok(!command.includes(`--detection-source "${checkpoint.detectionSource}"`), command);
        assert.ok(!command.includes('--changed-file "<path>"'), command);
    });

    it('recovers dirty-baseline classify failure with authenticated split-checkpoint scope', () => {
        const repoRoot = makeTempRepo();
        const checkpoint = seedAuthenticatedSplitCheckpointTask(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        seedDirtyBaselinePreflightFailure(repoRoot, TASK_ID, ['src/app.ts']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.match(result.reason, /authenticated split-checkpoint scope/);
        assert.ok(command.includes(`--detection-source "${checkpoint.detectionSource}"`), command);
        assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        assert.ok(!command.includes('--use-staged'), command);
        assert.ok(!command.includes('--changed-file "<path>"'), command);
    });

    it('keeps protected preflight recovery on authenticated split-checkpoint scope when unrelated files are dirty', () => {
        const repoRoot = makeTempRepo();
        const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
        workflowConfig.orchestrator_work_policy = { mode: 'require_operator_confirmation' };
        writeJson(workflowConfigPath, workflowConfig);
        seedAuthenticatedSplitCheckpointTask(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        const unrelatedPath = 'template/skills/unrelated/SKILL.md';
        fs.mkdirSync(path.join(repoRoot, 'template', 'skills', 'unrelated'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, ...unrelatedPath.split('/')), '# unrelated user change\n', 'utf8');
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_FAILED', 'FAIL', {
            error:
                'Preflight scope touches protected orchestrator control-plane files without task-mode --orchestrator-work: src/app.ts. ' +
                'Restart with enter-task-mode --orchestrator-work before preflight classification.'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.ok(command.includes('--orchestrator-work'), command);
        assert.ok(command.includes('--planned-changed-file "src/app.ts"'), command);
        assert.ok(!command.includes(unrelatedPath), command);
        assert.equal((command.match(/--planned-changed-file /gu) || []).length, 1, command);
    });

    it('restarts task mode with planned scope after protected pre-existing baseline drift', () => {
        const repoRoot = makeTempRepo();
        const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
        workflowConfig.orchestrator_work_policy = { mode: 'require_operator_confirmation' };
        writeJson(workflowConfigPath, workflowConfig);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Recover protected baseline drift',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: ['src/app.ts'],
            dirtyWorkspaceBaseline: {
                detection_source: 'git_auto',
                include_untracked: true,
                changed_files: ['src/older-task.ts'],
                changed_files_sha256: sha256Text('src/older-task.ts'),
                scope_sha256: sha256Text('src/older-task.ts'),
                file_hashes: {}
            }
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_FAILED', 'FAIL', {
            error:
                'Protected pre-existing workspace edits changed outside task scope: src/older-task.ts. ' +
                'These files no longer match the task-mode baseline. Clean/stash the local baseline drift or restart task mode with the intended files in scope before continuing.'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.match(result.reason, /existing planned scope/iu);
        assert.ok(command.includes('--orchestrator-work'), command);
        assert.ok(command.includes('--planned-changed-file "src/app.ts"'), command);
        assert.ok(!command.includes('src/older-task.ts'), command);
        assert.equal((command.match(/--planned-changed-file /gu) || []).length, 1, command);
    });

    it('uses current git-auto workspace files when refreshing stale unscoped preflight', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const currentWorkspaceRefresh = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('uses orchestrator-work dirty workspace baseline when refreshing stale protected preflight', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const protectedRefresh = true;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI\n\nprotected refresh\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
            detection_source: baselineSnapshot.detection_source,
            include_untracked: !!baselineSnapshot.include_untracked,
            changed_files: baselineSnapshot.changed_files,
            changed_files_sha256: baselineSnapshot.changed_files_sha256,
            scope_sha256: baselineSnapshot.scope_sha256,
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from dirty baseline',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "docs/cli-reference.md"'));
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('expands dirty-baseline directory placeholders before printing classify-change refresh scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.mkdirSync(path.join(repoRoot, 'src', 'generated'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'generated', 'new-feature.ts'), 'export const generatedFeature = true;\n', 'utf8');
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: ['src/generated'],
            changed_files_sha256: sha256Text('src/generated'),
            scope_sha256: sha256Text('src/generated'),
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from dirty directory baseline',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/generated/new-feature.ts"'));
        assert.ok(!command.includes('--changed-file "src/generated"'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('preserves deleted tracked file path when replaced by an untracked directory', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'generated'), 'export const oldGenerated = true;\n', 'utf8');
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.rmSync(path.join(repoRoot, 'src', 'generated'));
        fs.mkdirSync(path.join(repoRoot, 'src', 'generated'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'generated', 'new-feature.ts'), 'export const generatedFeature = true;\n', 'utf8');
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: ['src/generated'],
            changed_files_sha256: sha256Text('src/generated'),
            scope_sha256: sha256Text('src/generated'),
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from file-to-directory replacement',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/generated"'));
        assert.ok(command.includes('--changed-file "src/generated/new-feature.ts"'));
    });

    it('rejects outside-root scope and canonicalizes absolute in-root directory placeholders', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.mkdirSync(path.join(repoRoot, 'src', 'generated'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'generated', 'new-feature.ts'),
            'export const generatedFeature = true;\n',
            'utf8'
        );
        const absoluteDirectory = normalizeForTimeline(path.join(repoRoot, 'src', 'generated'));
        const rootDirectory = normalizeForTimeline(repoRoot);
        const changedFiles = [
            '../outside-generated',
            '.',
            rootDirectory,
            absoluteDirectory
        ];
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: changedFiles,
            changed_files_sha256: sha256Text(changedFiles.join('\n')),
            scope_sha256: sha256Text(changedFiles.join('\n')),
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from unsafe directory baseline',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/generated/new-feature.ts"'));
        assert.ok(!command.includes('--changed-file "../outside-generated"'));
        assert.ok(!command.includes('--changed-file "."'));
        assert.ok(!command.includes(`--changed-file "${rootDirectory}"`));
        assert.ok(!command.includes(`--changed-file "${absoluteDirectory}"`));
    });

    it('rejects symlink directory placeholders that resolve outside the repo root', { skip: process.platform === 'win32' }, () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-outside-'));
        tempRoots.push(outsideDirectory);
        fs.writeFileSync(path.join(outsideDirectory, 'hidden.ts'), 'export const hidden = true;\n', 'utf8');
        fs.symlinkSync(outsideDirectory, path.join(repoRoot, 'src', 'linked-generated'), 'dir');
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: ['src/linked-generated'],
            changed_files_sha256: sha256Text('src/linked-generated'),
            scope_sha256: sha256Text('src/linked-generated'),
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from symlink directory baseline',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(!command.includes('--changed-file "src/linked-generated"'));
    });
});
