import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildStrictDecompositionDecisionArtifact } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import {
    buildStrictDecompositionDecisionRequirement
} from '../../../../src/gates/next-step/next-step-strict-decomposition-routing';
import type { NextStepProfileSummary } from '../../../../src/gates/next-step/next-step';
import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { buildEffectiveReviewSnapshot, type EffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import {
    parseTaskQueueEntriesFromContent,
    resolveStrictDecompositionSplitRoutingState
} from '../../../../src/gates/next-step/next-step-task-queue';
import { syncTaskQueueStatusFromStrictDecompositionToDecomposed } from '../../../../src/gates/next-step/next-step-task-queue-status-sync';
import {
    buildTaskProfilePolicySnapshot,
    type TaskProfilePolicySnapshot
} from '../../../../src/policy/task-profile-policy-snapshot';
import {
    listSplitRequiredWip,
    restoreSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip-operations';
import { captureAndSuspendSplitRequiredWip } from '../../../../src/gates/split-required/split-required-wip-capture';
import { suspendStrictDecompositionWipIfRequired } from '../../../../src/gates/next-step/next-step-strict-decomposition-wip';
import {
    buildQualityChecklistArtifact,
    materializeQualityChecklistAnswersTemplate
} from '../../../../src/gates/quality-checklist';
import { runQualityChecklistCommand } from '../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import {
    initGitRepo,
    runGitFixtureCommand
} from '../git-fixtures';

const TASK_ID = 'T-NEXT-1';


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
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Balanced test profile',
                depth: 2,
                task_decomposition: { enabled: true },
                review_policy: { code: true, test: 'auto' },
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

function writePreflightScope(repoRoot: string, taskId: string, changedFiles: string[]): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`), {
        task_id: taskId,
        changed_files: changedFiles
    });
}

function buildFrozenSplitReviewSnapshot(
    changedFiles: string[],
    profileSnapshot: TaskProfilePolicySnapshot
): EffectiveReviewSnapshot {
    const catalog = normalizeReviewCatalog({ version: 1, custom_review_types: [] }, { knownSkillIds: [] });
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        profileSnapshot.source.effective_profile,
        profileSnapshot.review_lane_selection.profile_review_policy,
        profileSnapshot.review_lane_selection.review_capabilities as ReviewCapabilitiesConfigMap,
        catalog
    );
    const frozenPolicy = profileSnapshot.review_execution_policy;
    return buildEffectiveReviewSnapshot({
        catalog, profilePolicy, profileSnapshotSha256: profileSnapshot.snapshot_hash,
        legacyRequiredReviews: { code: true, test: true },
        scopeCategory: 'code', taskIntent: 'Route frozen balanced split', changedFiles, taskTriggers: {},
        reviewExecutionPolicyMode: frozenPolicy.mode,
        reviewDependencyGraph: frozenPolicy.review_dependency_graph,
        fullSuiteValidation: frozenPolicy.full_suite_validation,
        includeDependencyGraph: true
    });
}

function writeFrozenPreflightScope(
    repoRoot: string,
    taskId: string,
    changedFiles: string[],
    profileSnapshot: TaskProfilePolicySnapshot
): string {
    const effectiveSnapshot = buildFrozenSplitReviewSnapshot(changedFiles, profileSnapshot);
    const frozenPolicy = profileSnapshot.review_execution_policy;
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const scope = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
    writeJson(preflightPath, {
        task_id: taskId, changed_files: changedFiles,
        detection_source: scope.detection_source, mode: 'FULL_PATH', scope_category: 'code',
        metrics: {
            changed_files_count: scope.changed_files_count,
            changed_lines_total: scope.changed_lines_total,
            changed_files_sha256: scope.changed_files_sha256,
            scope_content_sha256: scope.scope_content_sha256,
            scope_sha256: scope.scope_sha256
        },
        required_reviews: effectiveSnapshot.required_reviews,
        profile_policy_snapshot: { snapshot_hash: profileSnapshot.snapshot_hash },
        review_execution_policy: { mode: frozenPolicy.mode, dependency_graph: effectiveSnapshot.review_dependency_graph },
        effective_review_snapshot: effectiveSnapshot
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: preflightPath.replace(/\\/g, '/'),
        effective_review_snapshot: effectiveSnapshot
    });
    return preflightPath;
}







function writeStrictDecompositionDecision(
    repoRoot: string,
    taskId: string,
    options: {
        decision?: 'atomic' | 'single-cycle' | 'split-required';
        taskSummary?: string;
        expectedReviewTypes?: string[];
        proposedChildTaskIds?: string[];
        taskProfile?: string;
        schemaVersion?: number;
    } = {}
): void {
    const decision = options.decision || 'single-cycle';
    const expectedReviewTypes = options.expectedReviewTypes || ['code'];
    const proposedChildTaskIds = decision === 'split-required'
        ? (options.proposedChildTaskIds || [`${taskId}-1`, `${taskId}-2`])
        : options.proposedChildTaskIds;
    writeJson(
        path.join(reviewsRoot(repoRoot), `${taskId}-strict-decomposition-decision.json`),
        buildStrictDecompositionDecisionArtifact({
            taskId,
            decision,
            taskProfile: options.taskProfile,
            taskSummary: options.taskSummary || 'Seeded next-step task',
            reason: 'This strict task is intentionally bounded for the current lifecycle cycle.',
            scopeRisk: 'The scope is constrained by the test fixture and must keep normal review gates.',
            expectedReviewTypes,
            atomicityConstraints: ['The navigator decision and its regression expectations must land together.'],
            proposedChildTaskIds,
            workPackageContract: decision === 'split-required'
                ? {
                    schema_version: options.schemaVersion || 1,
                    finding_obligations: [],
                    work_packages: (proposedChildTaskIds || []).map((childTaskId, index) => ({
                        task_id: childTaskId,
                        profile: options.schemaVersion === 2 ? options.taskProfile : 'strict',
                        root_cause_area: `root-cause-${index + 1}`,
                        objective: `Implement independently executable root-cause package ${index + 1}.`,
                        scope_obligations: [`Preserve bounded parent scope obligation ${index + 1}.`],
                        validation_contract: [`Validate root-cause package ${index + 1} independently.`],
                        finding_obligation_ids: [],
                        required_review_types: expectedReviewTypes
                    }))
                }
                : undefined
        })
    );
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

function seedStartedTaskWithFrozenDecompositionPolicy(
    repoRoot: string,
    taskId: string,
    profile: string,
    enabled: boolean
): TaskProfilePolicySnapshot {
    const profilesConfigPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'live',
        'config',
        'profiles.json'
    );
    const profiles = JSON.parse(fs.readFileSync(profilesConfigPath, 'utf8')) as {
        built_in_profiles: Record<string, unknown>;
        user_profiles: Record<string, unknown>;
    };
    const profileEntry = {
        description: `${profile} test profile`,
        depth: 2,
        task_decomposition: { enabled },
        review_policy: { code: true, test: 'auto' },
        token_economy: {
            enabled: true,
            strip_examples: true,
            strip_code_blocks: true,
            scoped_diffs: true,
            compact_reviewer_output: true
        },
        skills: { auto_suggest: true }
    };
    if (profile === 'custom-review') {
        profiles.user_profiles[profile] = profileEntry;
    } else {
        profiles.built_in_profiles[profile] = profileEntry;
    }
    writeJson(profilesConfigPath, profiles);

    const profilePolicySnapshot = buildTaskProfilePolicySnapshot(
        path.join(repoRoot, 'garda-agent-orchestrator'),
        profile,
        {
            reviewExecutionPolicyMode: 'code_first_optional',
            reviewExecutionPolicyConfigured: true,
            fullSuiteValidationEnabled: false,
            fullSuiteValidationPlacement: 'after_compile_before_reviews',
            lockTimestampUtc: '2026-04-25T00:00:00.000Z'
        }
    );
    const taskModePath = path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    writeJson(taskModePath, buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded next-step task',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved',
        taskProfile: profile,
        profileSelectionSource: 'task_queue',
        activeProfile: profile,
        profileSource: profile === 'custom-review' ? 'user' : 'built_in',
        runtimeActiveProfile: 'balanced',
        runtimeProfileSource: 'built_in',
        profilePolicySnapshot
    }));
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(
        repoRoot,
        taskId,
        'TASK_MODE_ENTERED',
        'PASS',
        buildTaskModeTimelineDetails(taskModePath, profilePolicySnapshot)
    );
    seedRulePack(repoRoot, taskId, 'TASK_ENTRY', taskModePath);
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
    return profilePolicySnapshot;
}

function buildTaskModeTimelineDetails(
    taskModePath: string,
    profilePolicySnapshot: TaskProfilePolicySnapshot
): Record<string, unknown> {
    return {
        artifact_path: normalizeForTimeline(taskModePath),
        start_banner: 'Garda captures my mind',
        canonical_source_of_truth: 'Codex',
        execution_provider_source: 'explicit_provider',
        runtime_identity_status: 'resolved',
        runtime_identity_violations: [],
        profile_policy_snapshot_required: true,
        profile_policy_snapshot_hash: profilePolicySnapshot.snapshot_hash
    };
}



function seedRulePack(repoRoot: string, taskId: string, stage: 'TASK_ENTRY' | 'POST_PREFLIGHT', taskModePath = '', preflightPath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage,
        taskModePath,
        preflightPath: preflightPath || undefined,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md',
            ...(preflightPath ? ['30-code-style.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md'] : [])
        ]
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage,
        artifact_path: normalizeForTimeline(rulePackPath),
        ...(preflightPath ? { preflight_path: normalizeForTimeline(preflightPath) } : {})
    });
}




function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}























afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step strict decomposition', () => {
    function profileSummary(profile: string, enabled: boolean): NextStepProfileSummary {
        return {
            task_selected_profile: profile,
            profile_selection_source: 'task_queue',
            effective_profile: profile,
            effective_profile_source: 'built_in',
            runtime_active_profile: 'balanced',
            runtime_active_profile_source: 'built_in',
            task_decomposition_enabled: enabled,
            task_decomposition_configured: true,
            task_decomposition_provenance: 'explicit_profile_config',
            requested_depth: 2,
            effective_depth: 2,
            depth_escalation_reason: null,
            total_forecast_tokens: null,
            effective_forecast_tokens: null,
            token_economy_active_for_depth: null
        };
    }

    it('uses frozen decomposition capability instead of profile name as routing authority', () => {
        const taskEntry = {
            taskId: TASK_ID,
            status: 'IN_PROGRESS',
            area: 'workflow/decomposition',
            title: 'Generalize guarded decomposition routing',
            profile: 'balanced',
            notes: 'Crosses profile, UI, routing, and audit boundaries.'
        };
        const balancedEnabled = buildStrictDecompositionDecisionRequirement({
            taskId: TASK_ID,
            taskEntry,
            taskMode: { task_summary: 'Seeded next-step task' },
            preflight: null,
            profileSummary: profileSummary('balanced', true),
            requiredReviewTypes: ['code', 'security']
        });
        const strictDisabled = buildStrictDecompositionDecisionRequirement({
            taskId: TASK_ID,
            taskEntry: { ...taskEntry, profile: 'strict' },
            taskMode: { task_summary: 'Seeded next-step task' },
            preflight: null,
            profileSummary: profileSummary('strict', false),
            requiredReviewTypes: ['code', 'security']
        });

        assert.equal(balancedEnabled.required, true);
        assert.equal(balancedEnabled.taskProfile, 'balanced');
        assert.equal(strictDisabled.required, false);
    });

    it('routes from the persisted task-mode decomposition capability instead of the profile name', () => {
        const scenarios = [
            { profile: 'balanced', enabled: true, expectedGate: 'record-strict-decomposition-decision' },
            { profile: 'strict', enabled: false, expectedGate: 'classify-change' },
            { profile: 'custom-review', enabled: false, expectedGate: 'classify-change' }
        ] as const;

        for (const scenario of scenarios) {
            const repoRoot = makeTempRepo();
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                `| ${TASK_ID} | TODO | P1 | workflow/decomposition | Generalize guarded decomposition routing | gpt-5.4 | 2026-05-20 | ${scenario.profile} | Crosses profile, UI, routing, and audit boundaries. |`,
                ''
            ].join('\n'), 'utf8');
            seedStartedTaskWithFrozenDecompositionPolicy(
                repoRoot,
                TASK_ID,
                scenario.profile,
                scenario.enabled
            );

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, scenario.expectedGate, scenario.profile);
            assert.equal(result.profile?.task_decomposition_enabled, scenario.enabled, scenario.profile);
            assert.equal(
                result.profile?.task_decomposition_provenance,
                'explicit_profile_config',
                scenario.profile
            );
        }
    });

    it('fails closed to persisted disabled strict decomposition instead of the legacy profile default', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/decomposition | Generalize guarded decomposition routing | gpt-5.4 | 2026-05-20 | strict | Crosses profile, UI, routing, and audit boundaries. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTaskWithFrozenDecompositionPolicy(repoRoot, TASK_ID, 'strict', false);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.equal(result.profile?.task_decomposition_enabled, false);
        assert.equal(result.profile?.task_decomposition_provenance, 'explicit_profile_config');
    });

    it('routes risky strict tasks to a decomposition decision before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-next-step-enforcement | Make next-step require a current decomposition decision | gpt-5.4 | 2026-05-20 | strict | Risky strict workflow routing guard. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('requires a current decomposition decision'));
        assert.ok(result.reason.includes('EVIDENCE_FILE_MISSING'));
        assert.ok(result.reason.includes('task_text:decomposition'));
        assert.ok(result.commands[0].command.includes('gate record-strict-decomposition-decision'));
        assert.ok(result.commands[0].command.includes('--task-profile "strict"'));
        assert.ok(result.commands[0].command.includes('--task-summary "Seeded next-step task"'));
        assert.ok(result.commands[0].command.includes('--expected-review-type "none"'));
        // No bracketed optional syntax inside an executable command line.
        assert.equal(/\[--/u.test(result.commands[0].command), false);
        assert.equal(result.commands[0].command.includes('--work-package-contract-path'), false);
        assert.ok(result.reason.includes('when choosing split-required, add --work-package-contract-path'));
        assert.equal(text.includes('gate classify-change'), false);
        assert.equal(text.includes('gate compile-gate'), false);
    });

    it('keeps tiny local strict tasks out of the decomposition prompt', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P2 | tests/local | Fix one typo in local test wording | gpt-5.4 | 2026-05-20 | strict | Tiny local wording fix. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.equal(result.commands[0].command.includes('record-strict-decomposition-decision'), false);
    });

    it('routes broad strict multi-domain tasks with localization wording before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | ui/checks-memory-backups-reset-i18n | Surface full-suite timing, memory prompt, manual backups, reset readiness, and localization audit in UI | gpt-5.4 | 2026-05-20 | strict | Scope: Checks tab timing; Project Memory prompt path; Backup UI manual action; Task reset readiness; all affected language packs. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('task_text:broad-domains='));
        assert.ok(result.reason.includes('task_text:broad-enumerated-scope'));
        assert.ok(result.reason.includes('i18n'));
        assert.ok(result.commands[0].command.includes('gate record-strict-decomposition-decision'));
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('does not treat preview and reporting substrings as broad review or report domains', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P2 | tests/local | Preview reporting copy for memory note | gpt-5.4 | 2026-05-20 | strict | Tiny local copy check for memory wording. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.equal(text.includes('record-strict-decomposition-decision'), false);
        assert.equal(text.includes('task_text:broad-domains='), false);
    });

    it('still counts deliberate reviewer and reports aliases as broad-domain signals', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/reviewer-reports-memory | Route reviewer reports and memory workflow planning | gpt-5.4 | 2026-05-20 | strict | Scope covers reviewer routing, reports UI, project memory, and workflow gates. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('task_text:broad-domains='));
        assert.ok(result.reason.includes('review'));
        assert.ok(result.reason.includes('ui'));
        assert.ok(result.commands[0].command.includes('gate record-strict-decomposition-decision'));
    });

    it('does not let low-risk copy wording exempt broad strict multi-domain tasks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | ui/settings-memory-backup-reset-i18n | Copy UI settings, memory backup, reset, and localization audit guidance | gpt-5.4 | 2026-05-20 | strict | Scope crosses UI, configuration, project memory, backup, reset, and language-pack audit behavior. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('task_text:broad-domains='));
        assert.ok(result.commands[0].command.includes('gate record-strict-decomposition-decision'));
    });

    it('accepts current single-cycle decomposition evidence before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-next-step-enforcement | Make next-step require a current decomposition decision | gpt-5.4 | 2026-05-20 | strict | Risky strict workflow routing guard. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'single-cycle',
            taskSummary: 'Seeded next-step task',
            expectedReviewTypes: ['none']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.commands[0].command.includes('gate classify-change'));
    });

    it('rejects stale strict decomposition decisions bound to an old task summary', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-next-step-enforcement | Make next-step require a current decomposition decision | gpt-5.4 | 2026-05-20 | strict | Risky strict workflow routing guard. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            taskSummary: 'Old task summary that no longer matches the current task-mode evidence.'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('EVIDENCE_TASK_SUMMARY_MISMATCH'));
        assert.ok(result.commands[0].command.includes('--task-summary "Seeded next-step task"'));
    });

    it('suppresses ordinary gates when a current strict decomposition decision requires split', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-next-step-enforcement | Make next-step require a current decomposition decision | gpt-5.4 | 2026-05-20 | strict | Risky strict workflow routing guard. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`, `${TASK_ID}-2`]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'strict-decomposition-split-routing');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('split-required'));
        assert.ok(result.reason.includes(`${TASK_ID}-1`));
        assert.ok(result.reason.includes('missing linked proposed child tasks'));
        assert.equal(text.includes('gate classify-change'), false);
        assert.equal(text.includes('gate compile-gate'), false);
    });

    function seedVersion2BalancedSplit(repoRoot: string, firstChildProfile = 'balanced'): TaskProfilePolicySnapshot {
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/decomposition | Route frozen balanced split | test | 2026-10-07 | balanced | Child tasks: ${TASK_ID}-1, ${TASK_ID}-2. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/evidence | Validate immutable package evidence | test | 2026-10-07 | ${firstChildProfile} | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/routing | Route next bounded package | test | 2026-10-07 | balanced | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        const profileSnapshot = seedStartedTaskWithFrozenDecompositionPolicy(repoRoot, TASK_ID, 'balanced', true);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required', taskProfile: 'balanced', schemaVersion: 2
        });
        initGitRepo(repoRoot);
        return profileSnapshot;
    }

    it('routes suspended parent with newly linked children before stale preflight refresh', () => {
        const repoRoot = makeTempRepo();
        const profile = seedVersion2BalancedSplit(repoRoot);
        const queuePath = path.join(repoRoot, 'TASK.md');
        const linkedQueue = fs.readFileSync(queuePath, 'utf8');
        fs.writeFileSync(queuePath, linkedQueue.split('\n').filter(line =>
            !line.startsWith(`| ${TASK_ID}-1 |`) && !line.startsWith(`| ${TASK_ID}-2 |`)).join('\n'));
        fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 2;\n');
        const preflightPath = writeFrozenPreflightScope(repoRoot, TASK_ID, ['src/app.ts'], profile);
        seedRulePack(repoRoot, TASK_ID, 'POST_PREFLIGHT',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), preflightPath);
        const originalPreflight = fs.readFileSync(preflightPath);
        const capture = captureAndSuspendSplitRequiredWip({ repoRoot, taskId: TASK_ID, preflightPath,
            guardKind: 'strict_decomposition', guardReason: 'Preserve the real implemented parent before linking children.' });
        assert.equal(capture.status, 'CAPTURED', capture.violations.join('\n'));
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--porcelain=v1', '--', 'src']).stdout.trim(), '');
        fs.writeFileSync(queuePath, linkedQueue);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.next_gate, 'child-task', result.reason);
        assert.equal(result.status, 'DECOMPOSED');
        assert.ok(result.commands[0].command.includes(`next-step "${TASK_ID}-1"`));
        assert.deepEqual(fs.readFileSync(preflightPath), originalPreflight);
        assert.equal(listSplitRequiredWip({ repoRoot, taskId: TASK_ID }).manifests.length, 1);
        // Git may restore its configured CRLF checkout on Windows; clean source
        // and exact unchanged control-artifact bytes are checked above.
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8').replace(/\r\n/gu, '\n'), 'export const value = 1;\n');
    });

    function seedSuspendedParentAfterChildCommit(
        ignoredEvidencePath?: string, declaredPaths: string[] = [], qualityChecksEnabled = false
    ) {
        const repoRoot = makeTempRepo();
        if (qualityChecksEnabled) {
            const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config.optional_quality_checks.enabled = true;
            writeJson(configPath, config);
        }
        const childPath = path.join(repoRoot, 'src', 'child.ts');
        fs.writeFileSync(childPath, 'export const child = 1;\n');
        const profileSnapshot = seedVersion2BalancedSplit(repoRoot);
        const base = runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n');
        const ignoredInput = 'garda-agent-orchestrator/runtime/tmp/shared-parent-input.txt';
        fs.mkdirSync(path.dirname(path.join(repoRoot, ignoredInput)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, ignoredInput), 'original ignored parent input\n');
        for (const declaredPath of declaredPaths) {
            fs.mkdirSync(path.dirname(path.join(repoRoot, declaredPath)), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, declaredPath), 'original declared implementation input\n');
        }
        if (ignoredEvidencePath) {
            fs.mkdirSync(path.dirname(path.join(repoRoot, ignoredEvidencePath)), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, ignoredEvidencePath), 'retained gate-owned evidence\n');
        }
        const preflightPath = writeFrozenPreflightScope(repoRoot, TASK_ID,
            ['src/app.ts', ignoredInput, ...declaredPaths, ...(ignoredEvidencePath ? [ignoredEvidencePath] : [])], profileSnapshot);
        seedRulePack(repoRoot, TASK_ID, 'POST_PREFLIGHT',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), preflightPath);
        if (ignoredEvidencePath || qualityChecksEnabled) {
            const initialCapture = captureAndSuspendSplitRequiredWip({
                repoRoot, taskId: TASK_ID, preflightPath, guardKind: 'strict_decomposition',
                guardReason: 'Capture legacy parent scope while retaining gate-owned ignored evidence.'
            });
            assert.equal(initialCapture.status, 'CAPTURED', initialCapture.violations.join('\n'));
            if (ignoredEvidencePath) assert.equal(initialCapture.untracked_files.includes(ignoredEvidencePath), false);
            // Already-DECOMPOSED legacy status is fixture input, not transition authority.
            const queuePath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(queuePath, fs.readFileSync(queuePath, 'utf8')
                .replace(`| ${TASK_ID} | TODO |`, `| ${TASK_ID} | DECOMPOSED |`));
        } else {
            const initialRoute = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.equal(initialRoute.status, 'DECOMPOSED', initialRoute.reason);
            assert.equal(initialRoute.next_gate, 'child-task');
        }
        const suspendedParentBytes = fs.readFileSync(path.join(repoRoot, 'src', 'app.ts'));
        const capture = listSplitRequiredWip({ repoRoot, taskId: TASK_ID });
        assert.equal(capture.status, 'FOUND');
        assert.equal(capture.manifests.length, 1);
        const manifestPath = capture.manifests[0].manifest_path;
        const packageBytes: Array<{ filePath: string; bytes: Buffer }> = [];
        function snapshotDirectory(directory: string): void {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const filePath = path.join(directory, entry.name);
                assert.equal(entry.isSymbolicLink(), false);
                if (entry.isDirectory()) snapshotDirectory(filePath);
                else packageBytes.push({ filePath, bytes: fs.readFileSync(filePath) });
            }
        }
        snapshotDirectory(path.dirname(manifestPath));
        const queuePath = path.join(repoRoot, 'TASK.md');
        // Queue status is a fixture input; acceptance authority is tested by its owning gates.
        fs.writeFileSync(queuePath, fs.readFileSync(queuePath, 'utf8')
            .replace(`| ${TASK_ID}-1 | TODO |`, `| ${TASK_ID}-1 | DONE |`));
        fs.writeFileSync(childPath, 'export const child = 2;\n');
        runGitFixtureCommand(repoRoot, ['add', '--', 'src/child.ts']);
        runGitFixtureCommand(repoRoot, ['commit', '-m', 'Real child source commit after parent WIP suspension']);
        const childCommit = runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
        assert.notEqual(childCommit, base);
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--porcelain=v1', '--', 'src']).stdout.trim(), '');
        return { repoRoot, preflightPath, manifestPath, packageBytes, base, childCommit, childPath, ignoredInput, suspendedParentBytes };
    }

    function seedCompletedQualityScaffolds(declaredInput = false, qualityChecksEnabled = true,
        qualityWarning = false, rawAnswerNormalization = false) {
        const fixture = seedSuspendedParentAfterChildCommit(undefined, declaredInput
            ? [`garda-agent-orchestrator/runtime/tmp/${TASK_ID}-1-quality-checklist-answers.json`] : [], qualityChecksEnabled);
        const { repoRoot, childPath } = fixture;
        const extraTask = `${TASK_ID}-C3-I1`;
        const queuePath = path.join(repoRoot, 'TASK.md');
        fs.appendFileSync(queuePath,
            `| ${extraTask} | DONE | P1 | workflow/repair | Completed source import fixture | test | 2026-10-07 | balanced | Linked repair for ${TASK_ID}. |\n`);
        fs.writeFileSync(childPath, 'export const child = 3;\n');
        runGitFixtureCommand(repoRoot, ['add', '--', 'src/child.ts']);
        runGitFixtureCommand(repoRoot, ['commit', '-m', 'Real source import commit after accepted child']);
        const acceptedHead = runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
        assert.notEqual(acceptedHead, fixture.childCommit);
        const scaffolds: Array<{ relativePath: string; bytes: Buffer }> = [];
        for (const taskId of [`${TASK_ID}-1`, extraTask]) {
            const profile = seedStartedTaskWithFrozenDecompositionPolicy(repoRoot, taskId, 'balanced', true);
            const preflightPath = writeFrozenPreflightScope(repoRoot, taskId, ['src/child.ts'], profile);
            const materialized = materializeQualityChecklistAnswersTemplate({ repoRoot, taskId, preflightPath });
            assert.ok(materialized.status === 'created' || materialized.status === 'current');
            const answersPath = materialized.answers_path;
            const template = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
            template.answers = template.answers.map((answer: { rule_id: string }, index: number) => ({
                ...answer, status: qualityWarning && index === 0 ? 'WARN' : 'PASS',
                answer: 'Fixture assessment for the unchanged completed native input.',
                evidence_files: [], actions_taken: [], actions_required: [],
                ...(rawAnswerNormalization ? {
                    rule_id: ` ${answer.rule_id.toUpperCase()} `,
                    status: qualityWarning && index === 0 ? ' WARNED ' : ' PASSED ',
                    answer: '  Fixture assessment for the unchanged completed native input.  ',
                    evidence_files: [' src\\child.ts ', ' '],
                    actions_taken: [' Inspected the unchanged completed input. ', ' '],
                    actions_required: undefined
                } : {})
            }));
            writeJson(answersPath, template);
            const quality = runQualityChecklistCommand({ repoRoot, taskId, preflightPath, answersPath });
            assert.equal(quality.exitCode, 0, quality.outputLines.join('\n'));
            const artifact = buildQualityChecklistArtifact({ repoRoot, taskId, preflightPath, answers: template.answers });
            assert.equal(artifact.status, qualityChecksEnabled
                ? (qualityWarning ? 'WARN' : 'PASS') : 'SKIPPED_DISABLED');
            const recordedArtifact = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot),
                `${taskId}-quality-checklist.json`), 'utf8'));
            assert.equal(recordedArtifact.status, artifact.status);
            const questionsPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp',
                `${taskId}-quality-checklist-questions.md`);
            fs.writeFileSync(questionsPath, [
                `# Active quality-checklist questions for ${taskId}`, '',
                ...artifact.rules.filter(rule => rule.scope_applicability === 'active')
                    .map(rule => `- ${rule.id}: ${String(rule.prompt || '').trim()}`)
            ].join('\n') + '\n');
            // Native producer artifacts and integrity events are fixture data, not production acceptance.
            const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            appendTaskEvent(bundleRoot, taskId, 'COMPLETION_GATE_PASSED', 'PASS',
                'Completed isolated fixture.', {}, { actor: 'gate' });
            appendTaskEvent(bundleRoot, taskId, 'STATUS_CHANGED', 'INFO',
                'Terminal isolated fixture.', { new_status: 'DONE' }, { actor: 'gate' });
            for (const filePath of [answersPath, `${answersPath}.binding.json`, questionsPath]) {
                scaffolds.push({ relativePath: path.relative(repoRoot, filePath).replace(/\\/g, '/'),
                    bytes: fs.readFileSync(filePath) });
            }
        }
        return { ...fixture, acceptedHead, scaffolds };
    }

    it('retains two completed native quality triplets after real child/import commits without original-HEAD recapture', () => {
        const fixture = seedCompletedQualityScaffolds();
        const { repoRoot, preflightPath, acceptedHead, packageBytes, scaffolds } = fixture;
        const directCapture = captureAndSuspendSplitRequiredWip({
            repoRoot, taskId: TASK_ID, preflightPath, guardKind: 'strict_decomposition',
            guardReason: 'Deep identity must still reject original-HEAD recapture.'
        });
        assert.equal(directCapture.status, 'BLOCKED');
        assert.ok(directCapture.violations.some(value => value.includes(`expected HEAD ${fixture.base}; found ${acceptedHead}`)));

        const result = suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: TASK_ID });
        assert.equal(result.status, 'NOT_REQUIRED', result.violations.join('\n'));
        const route = resolveNextStep({ repoRoot, taskId: TASK_ID });
        assert.equal(route.status, 'DECOMPOSED', route.reason);
        assert.equal(route.next_gate, 'child-task');
        assert.equal(scaffolds.length, 6);
        for (const saved of scaffolds) assert.deepEqual(fs.readFileSync(path.join(repoRoot, saved.relativePath)), saved.bytes);
        for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
        assert.equal(runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), acceptedHead);
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--porcelain=v1', '--', 'src']).stdout.trim(), '');
    });

    it('retains consumed native warning inputs without creating a new gate PASS or changing saved WIP', () => {
        const fixture = seedCompletedQualityScaffolds(false, true, true);
        const result = suspendStrictDecompositionWipIfRequired({ repoRoot: fixture.repoRoot, taskId: TASK_ID });
        assert.equal(result.status, 'NOT_REQUIRED', result.violations.join('\n'));
        for (const saved of fixture.scaffolds) {
            assert.deepEqual(fs.readFileSync(path.join(fixture.repoRoot, saved.relativePath)), saved.bytes);
            if (saved.relativePath.endsWith('-answers.json')) {
                assert.equal(JSON.parse(saved.bytes.toString('utf8')).answers[0].status, 'WARN');
            }
        }
        for (const saved of fixture.packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
    });

    it('retains native-normalized raw PASS and WARN inputs after real HEAD advances but guards meaningful edits', () => {
        for (const warning of [false, true]) {
            const fixture = seedCompletedQualityScaffolds(false, true, warning, true);
            const { repoRoot, packageBytes, scaffolds, preflightPath, childPath } = fixture;
            const answersPath = path.join(repoRoot, scaffolds[0].relativePath);
            const raw = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
            const consumed = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot),
                `${TASK_ID}-1-quality-checklist.json`), 'utf8')).answers[0];
            assert.equal(raw.answers[0].status, warning ? ' WARNED ' : ' PASSED ');
            assert.equal(consumed.status, warning ? 'WARN' : 'PASS');
            assert.equal(consumed.answer, raw.answers[0].answer.trim());
            assert.deepEqual(consumed.evidence_files, ['src/child.ts']);
            assert.deepEqual(consumed.actions_required, []);
            const consumedHead = runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
            assert.equal(consumedHead, fixture.acceptedHead);
            const consumedArtifacts = [`${TASK_ID}-1`, `${TASK_ID}-C3-I1`].map(taskId => {
                const filePath = path.join(reviewsRoot(repoRoot), `${taskId}-quality-checklist.json`);
                return { filePath, bytes: fs.readFileSync(filePath) };
            });
            fs.writeFileSync(childPath, 'export const child = 4;\n');
            runGitFixtureCommand(repoRoot, ['add', '--', 'src/child.ts']);
            runGitFixtureCommand(repoRoot, ['commit', '-m', 'Real child commit after native quality consumption']);
            const laterChildHead = runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
            assert.notEqual(laterChildHead, consumedHead);
            fs.writeFileSync(childPath, 'export const child = 5;\n');
            runGitFixtureCommand(repoRoot, ['add', '--', 'src/child.ts']);
            runGitFixtureCommand(repoRoot, ['commit', '-m', 'Real source import after native quality consumption']);
            const acceptedHead = runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
            assert.notEqual(acceptedHead, laterChildHead);
            const direct = captureAndSuspendSplitRequiredWip({ repoRoot, taskId: TASK_ID, preflightPath,
                guardKind: 'strict_decomposition', guardReason: 'Deep HEAD guard must remain independent.' });
            assert.equal(direct.status, 'BLOCKED');
            assert.ok(direct.violations.some(value => value.includes(`expected HEAD ${fixture.base}; found ${acceptedHead}`)));
            const retained = suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: TASK_ID });
            assert.equal(retained.status, 'NOT_REQUIRED', retained.violations.join('\n'));
            const route = resolveNextStep({ repoRoot, taskId: TASK_ID });
            assert.equal(route.status, 'DECOMPOSED', route.reason);
            assert.equal(route.next_gate, 'child-task');
            for (const saved of scaffolds) assert.deepEqual(fs.readFileSync(path.join(repoRoot, saved.relativePath)), saved.bytes);
            for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
            for (const saved of consumedArtifacts) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
            raw.answers[0].answer += ' Meaningful unconsumed user edit.';
            writeJson(answersPath, raw);
            const editedBytes = fs.readFileSync(answersPath);
            const edited = suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: TASK_ID });
            assert.equal(edited.status, 'BLOCKED');
            assert.ok(edited.violations.some(value => value.includes(`expected HEAD ${fixture.base}; found ${acceptedHead}`)));
            assert.deepEqual(fs.readFileSync(answersPath), editedBytes);
            for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
            for (const saved of consumedArtifacts) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
            assert.equal(runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), acceptedHead);
            assert.equal(runGitFixtureCommand(repoRoot, ['status', '--porcelain=v1', '--', 'src']).stdout.trim(), '');
        }
    });

    it('rejects changed, unknown, active and unauthenticated quality inputs under the original-HEAD WIP guard', () => {
        const kinds = ['answer-edit', 'question-edit', 'binding-edit', 'missing-timeline', 'reopened-task',
            'duplicate-task', 'unknown-tmp', 'visible-source', 'declared-input', 'unknown-answer-field',
            'forged-artifact', 'corrupt-timeline', 'reentry-after-done', 'missing-questions',
            'symlink-input', 'hardlink-input', 'oversized-input', 'unconsumed-skipped-quality'];
        const actualStates: Array<{ kind: string; status: string }> = [];
        for (const kind of kinds) {
            const fixture = seedCompletedQualityScaffolds(kind === 'declared-input', kind !== 'unconsumed-skipped-quality');
            const { repoRoot, acceptedHead, packageBytes, scaffolds } = fixture;
            const answersPath = path.join(repoRoot, scaffolds[0].relativePath);
            let changedPath = answersPath;
            if (kind === 'answer-edit') {
                const template = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
                template.answers[0].answer = 'Unaccepted user work must remain intact.';
                writeJson(answersPath, template);
            } else if (kind === 'question-edit') {
                changedPath = path.join(repoRoot, scaffolds[2].relativePath);
                fs.appendFileSync(changedPath, 'Unaccepted user notes.\n');
            } else if (kind === 'binding-edit') {
                changedPath = `${answersPath}.binding.json`;
                const binding = JSON.parse(fs.readFileSync(changedPath, 'utf8'));
                binding.task_id = 'T-FOREIGN';
                writeJson(changedPath, binding);
            } else if (kind === 'missing-timeline') {
                fs.unlinkSync(path.join(eventsRoot(repoRoot), `${TASK_ID}-1.jsonl`));
            } else if (kind === 'reopened-task') {
                const queuePath = path.join(repoRoot, 'TASK.md');
                fs.writeFileSync(queuePath, fs.readFileSync(queuePath, 'utf8')
                    .replace(`| ${TASK_ID}-1 | DONE |`, `| ${TASK_ID}-1 | IN_PROGRESS |`));
            } else if (kind === 'duplicate-task') {
                fs.appendFileSync(path.join(repoRoot, 'TASK.md'),
                    `| ${TASK_ID}-1 | DONE | P1 | ambiguous | Duplicate fixture | test | 2026-10-07 | balanced | Uncertain ownership. |\n`);
            } else if (kind === 'unknown-answer-field') {
                const template = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
                template.answers[0].user_notes = 'Unaccepted implementation notes.';
                writeJson(answersPath, template);
            } else if (kind === 'forged-artifact') {
                changedPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-1-quality-checklist.json`);
                const artifact = JSON.parse(fs.readFileSync(changedPath, 'utf8'));
                artifact.answers[0].answer = 'Forged consumed assessment.';
                writeJson(changedPath, artifact);
            } else if (kind === 'corrupt-timeline') {
                changedPath = path.join(eventsRoot(repoRoot), `${TASK_ID}-1.jsonl`);
                fs.appendFileSync(changedPath, '{"forged":"missing native integrity"}\n');
            } else if (kind === 'reentry-after-done') {
                appendTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), `${TASK_ID}-1`,
                    'TASK_MODE_ENTERED', 'INFO', 'Re-enter isolated fixture.', {}, { actor: 'gate' });
            } else if (kind === 'missing-questions') {
                fs.unlinkSync(path.join(repoRoot, scaffolds[2].relativePath));
            } else if (kind === 'symlink-input' || kind === 'hardlink-input') {
                const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-foreign-quality-'));
                tempRoots.push(foreignRoot);
                const foreignPath = path.join(foreignRoot, 'foreign-input.json');
                fs.copyFileSync(answersPath, foreignPath);
                fs.unlinkSync(answersPath);
                if (kind === 'symlink-input') fs.symlinkSync(foreignPath, answersPath);
                else fs.linkSync(foreignPath, answersPath);
            } else if (kind === 'oversized-input') {
                fs.writeFileSync(answersPath, ' '.repeat(256 * 1024 + 1));
            } else if (kind === 'unknown-tmp' || kind === 'visible-source') {
                changedPath = path.join(repoRoot, kind === 'unknown-tmp'
                    ? `garda-agent-orchestrator/runtime/tmp/${TASK_ID}-draft.json` : 'unaccepted-source.ts');
                fs.writeFileSync(changedPath, 'Unaccepted implementation work.\n');
            }
            const changedBytes = fs.readFileSync(changedPath);
            const result = suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: TASK_ID });
            actualStates.push({ kind, status: result.status });
            assert.equal(result.status, 'BLOCKED', kind);
            assert.ok(result.violations.some(value => value.includes(`expected HEAD ${fixture.base}; found ${acceptedHead}`)), kind);
            assert.deepEqual(fs.readFileSync(changedPath), changedBytes, kind);
            for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes, kind);
        }
        assert.deepEqual(actualStates, kinds.map(kind => ({ kind, status: 'BLOCKED' })));
    });

    it('rejects replaced and growing quality files during bounded inventory inspection without losing WIP', () => {
        const actualStates: Array<{ kind: string; mutated: boolean; status: string }> = [];
        for (const kind of ['replaced', 'growing']) {
            const fixture = seedCompletedQualityScaffolds();
            const { repoRoot, packageBytes, scaffolds } = fixture;
            const answersPath = path.join(repoRoot, scaffolds[0].relativePath);
            let mutated = false;
            const nativeFs = require('node:fs') as typeof fs;
            const oldOpen = nativeFs.openSync;
            const oldRead = nativeFs.readSync;
            let answerDescriptor: number | null = null;
            mock.method(nativeFs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
                if (String(args[0]) === answersPath && !mutated && kind === 'replaced') {
                    mutated = true;
                    fs.renameSync(answersPath, `${answersPath}.original`);
                    fs.writeFileSync(answersPath, scaffolds[0].bytes);
                }
                const descriptor = oldOpen(...args);
                if (String(args[0]) === answersPath) answerDescriptor = descriptor;
                return descriptor;
            });
            mock.method(nativeFs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
                const count = oldRead(...args);
                if (args[0] === answerDescriptor && !mutated && kind === 'growing') {
                    mutated = true;
                    fs.appendFileSync(answersPath, '\nUnaccepted user growth.\n');
                }
                return count;
            });
            let result;
            try {
                result = suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: TASK_ID });
            } finally {
                mock.restoreAll();
            }
            actualStates.push({ kind, mutated, status: result.status });
            assert.ok(result.violations.some(value => value.includes('checkout state identity mismatch')));
            if (kind === 'replaced') {
                assert.deepEqual(fs.readFileSync(`${answersPath}.original`), scaffolds[0].bytes);
                assert.deepEqual(fs.readFileSync(answersPath), scaffolds[0].bytes);
            } else {
                assert.ok(fs.readFileSync(answersPath, 'utf8').endsWith('Unaccepted user growth.\n'));
            }
            for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
        }
        assert.deepEqual(actualStates, ['replaced', 'growing']
            .map(kind => ({ kind, mutated: true, status: 'BLOCKED' })));
    });

    it('rejects a real quality-file-to-FIFO replacement without blocking inventory inspection', {
        skip: process.platform === 'win32'
    }, () => {
        const fixture = seedCompletedQualityScaffolds();
        const answersPath = path.join(fixture.repoRoot, fixture.scaffolds[0].relativePath);
        const modulePath = require.resolve('../../../../src/gates/next-step/next-step-strict-decomposition-wip');
        const script = `
            const fs = require('node:fs'), cp = require('node:child_process');
            const native = require(process.argv[1]);
            const repoRoot = process.argv[2], answersPath = process.argv[3];
            const open = fs.openSync;
            let replaced = false;
            fs.openSync = (...args) => {
                if (String(args[0]) === answersPath && !replaced) {
                    fs.renameSync(answersPath, answersPath + '.original');
                    cp.execFileSync('mkfifo', [answersPath]);
                    replaced = true;
                }
                return open(...args);
            };
            const result = native.suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: process.argv[4] });
            if (!replaced || result.status !== 'BLOCKED'
                || !result.violations.some(v => v.includes('checkout state identity mismatch'))) process.exit(1);
            process.stdout.write('QUALITY_FIFO_REPLACEMENT_REJECTED\\n');
        `;
        const child = spawnSync(process.execPath, ['-e', script, modulePath, fixture.repoRoot, answersPath, TASK_ID], {
            timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024, encoding: 'utf8'
        });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
        assert.ok(child.stdout.includes('QUALITY_FIFO_REPLACEMENT_REJECTED'));
        assert.equal(fs.lstatSync(answersPath).isFIFO(), true);
        assert.deepEqual(fs.readFileSync(`${answersPath}.original`), fixture.scaffolds[0].bytes);
        for (const saved of fixture.packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
    });

    it('rejects original-HEAD recapture and routes a suspended balanced parent after a real child commit without changing saved WIP', () => {
        const fixture = seedSuspendedParentAfterChildCommit();
        const { repoRoot, preflightPath, manifestPath, packageBytes, base, childCommit } = fixture;
        const preflightBytes = fs.readFileSync(preflightPath);
        const directCapture = captureAndSuspendSplitRequiredWip({
            repoRoot, taskId: TASK_ID, preflightPath, guardKind: 'strict_decomposition', guardReason: 'Verify deep capture identity remains strict.'
        });
        assert.equal(directCapture.status, 'BLOCKED');
        assert.ok(directCapture.violations.some(value => value.includes(`expected HEAD ${base}; found ${childCommit}`)));
        const preview = restoreSplitRequiredWip({
            repoRoot, taskId: TASK_ID, manifestPath, includePaths: ['src/app.ts'], dryRun: true
        });
        assert.equal(preview.status, 'DRY_RUN_OK', preview.violations.join('\n'));

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'DECOMPOSED', `${result.next_gate}: ${result.reason}`);
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes(`next-step "${TASK_ID}-2"`));
        assert.equal(suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: TASK_ID }).status, 'NOT_REQUIRED');
        assert.deepEqual(fs.readFileSync(path.join(repoRoot, 'src', 'app.ts')), fixture.suspendedParentBytes);
        assert.equal(fs.readFileSync(fixture.childPath, 'utf8'), 'export const child = 2;\n');
        assert.deepEqual(fs.readFileSync(preflightPath), preflightBytes);
        for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes);
        assert.equal(listSplitRequiredWip({ repoRoot, taskId: TASK_ID }).manifests.length, 1);
        assert.equal(runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), childCommit);
    });

    it('rejects original-HEAD recapture for present staged, unstaged, visible or ignored implementation WIP', () => {
        const kinds = ['staged', 'unstaged', 'visible-untracked', 'ignored-task-tmp', 'ignored-allowed-input'];
        const actualStates: Array<{ kind: string; status: string }> = [];
        for (const kind of kinds) {
            const fixture = seedSuspendedParentAfterChildCommit();
            const { repoRoot, packageBytes, base, childCommit } = fixture;
            const relativePath = kind === 'visible-untracked' ? 'unowned.ts'
                : kind === 'ignored-task-tmp' ? `garda-agent-orchestrator/runtime/tmp/${TASK_ID}-draft.json`
                    : kind === 'ignored-allowed-input' ? fixture.ignoredInput : 'src/app.ts';
            const filePath = path.join(repoRoot, relativePath);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            const bytes = Buffer.from('current implementation must stay intact\n');
            fs.writeFileSync(filePath, bytes);
            if (kind === 'staged') runGitFixtureCommand(repoRoot, ['add', '--', relativePath]);

            const result = suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: TASK_ID });

            actualStates.push({ kind, status: result.status });
            assert.ok(result.violations.some(value => value.includes(`expected HEAD ${base}; found ${childCommit}`)), kind);
            assert.deepEqual(fs.readFileSync(filePath), bytes, kind);
            for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes, kind);
        }
        assert.deepEqual(actualStates, kinds.map(kind => ({ kind, status: 'BLOCKED' })));
    });

    it('rejects false recapture of native-retained ignored evidence after a real child commit', () => {
        const evidencePaths = [
            `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-legacy-evidence.json`,
            `garda-agent-orchestrator/runtime/task-events/${TASK_ID}-legacy-evidence.json`,
            `garda-agent-orchestrator/runtime/task-ledger/${TASK_ID}-legacy-evidence.json`,
            `garda-agent-orchestrator/runtime/project-memory/${TASK_ID}-legacy-evidence.json`,
            `garda-agent-orchestrator/runtime/wip/notes/${TASK_ID}-legacy-evidence.json`,
            'garda-agent-orchestrator/runtime/metrics.json'
        ];
        const actualStates: Array<{ path: string; status: string; nextGate: string | null }> = [];
        for (const evidencePath of evidencePaths) {
            const fixture = seedSuspendedParentAfterChildCommit(evidencePath);
            const { repoRoot, manifestPath, packageBytes, childCommit } = fixture;
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            assert.ok(manifest.ignored_runtime_artifacts.includes(evidencePath));
            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
            actualStates.push({ path: evidencePath, status: result.status, nextGate: result.next_gate });
            assert.equal(fs.readFileSync(path.join(repoRoot, evidencePath), 'utf8'), 'retained gate-owned evidence\n');
            assert.equal(runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), childCommit);
            for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes, evidencePath);
        }
        assert.deepEqual(actualStates, evidencePaths.map(filePath => ({ path: filePath, status: 'DECOMPOSED', nextGate: 'child-task' })));
    });

    it('rejects missing or foreign preflight identity and unavailable Git inventory instead of claiming no capture is required', () => {
        const kinds = ['missing-task-id', 'foreign-task-id', 'invalid-preflight', 'unavailable-git'];
        const actualStates: Array<{ kind: string; status: string }> = [];
        for (const kind of kinds) {
            const fixture = seedSuspendedParentAfterChildCommit();
            const { repoRoot, preflightPath, packageBytes } = fixture;
            const gitPath = path.join(repoRoot, '.git');
            const savedGitPath = path.join(repoRoot, 'preserved-git-fixture');
            if (kind === 'unavailable-git') fs.renameSync(gitPath, savedGitPath);
            else if (kind === 'invalid-preflight') fs.writeFileSync(preflightPath, '{invalid json');
            else {
                const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
                if (kind === 'missing-task-id') delete preflight.task_id;
                else preflight.task_id = 'T-FOREIGN';
                writeJson(preflightPath, preflight);
            }
            try {
                const result = suspendStrictDecompositionWipIfRequired({ repoRoot, taskId: TASK_ID });
                actualStates.push({ kind, status: result.status });
                assert.ok(result.violations.length > 0, kind);
                for (const saved of packageBytes) assert.deepEqual(fs.readFileSync(saved.filePath), saved.bytes, kind);
            } finally {
                if (kind === 'unavailable-git') fs.renameSync(savedGitPath, gitPath);
            }
        }
        assert.deepEqual(actualStates, kinds.map(kind => ({ kind, status: 'BLOCKED' })));
    });

    it('routes version-2 balanced children through native WIP suspension and queue transition', () => {
        const repoRoot = makeTempRepo();
        const profileSnapshot = seedVersion2BalancedSplit(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        const preflightPath = writeFrozenPreflightScope(repoRoot, TASK_ID, ['src/app.ts'], profileSnapshot);
        seedRulePack(repoRoot, TASK_ID, 'POST_PREFLIGHT',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), preflightPath);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'DECOMPOSED', formatNextStepText(result));
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes(`next-step "${TASK_ID}-1"`));
        assert.ok(result.reason.includes('linked parent-derived balanced child tasks match the decision artifact'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | 🟪 DECOMPOSED |`));
        assert.ok(fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8').includes('STRICT_DECOMPOSITION_SPLIT_ROUTED'));
        const wip = listSplitRequiredWip({ repoRoot, taskId: TASK_ID });
        assert.equal(wip.status, 'FOUND');
        assert.deepEqual(wip.manifests[0].tracked_files, ['src/app.ts']);
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--short', '--', 'src/app.ts']).stdout.trim(), '');
    });

    it('blocks version-2 child profile drift without transitioning the balanced parent', () => {
        const repoRoot = makeTempRepo();
        seedVersion2BalancedSplit(repoRoot, 'fast');
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'strict-decomposition-split-routing');
        assert.ok(result.reason.includes('child tasks without balanced profile'));
        assert.equal(result.commands.length, 0);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('DECOMPOSED'), false);
        assert.equal(fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8').includes('STRICT_DECOMPOSITION_SPLIT_ROUTED'), false);
    });

    it('rejects balanced child profile drift under the native queue transition lock', () => {
        const repoRoot = makeTempRepo();
        seedVersion2BalancedSplit(repoRoot);
        const taskPath = path.join(repoRoot, 'TASK.md');
        const before = fs.readFileSync(taskPath, 'utf8');
        const children = [`${TASK_ID}-1`, `${TASK_ID}-2`];
        assert.equal(resolveStrictDecompositionSplitRoutingState(
            parseTaskQueueEntriesFromContent(before), TASK_ID, children, 'balanced'
        ).ready, true);
        const changed = before.split('\n').map(line => line.startsWith(`| ${TASK_ID}-1 |`)
            ? line.replace('| balanced |', '| fast |') : line).join('\n');
        fs.writeFileSync(taskPath, changed, 'utf8');

        const result = syncTaskQueueStatusFromStrictDecompositionToDecomposed(repoRoot, TASK_ID, children, 'balanced');
        assert.notEqual(result.outcome, 'updated');
        assert.match(result.error_message || '', /complete balanced child task set is not valid/);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), changed);
    });

    it('routes strict split-required decisions through linked parent-derived strict children', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-split-routing | Route strict split decisions to children | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\` and \`${TASK_ID}-2\`. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/strict-decomposition-split-routing | Validate split evidence | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/strict-decomposition-split-routing | Route child execution | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`, `${TASK_ID}-2`]
        });
        initGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflightScope(repoRoot, TASK_ID, ['src/app.ts']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');
        const wip = listSplitRequiredWip({ repoRoot, taskId: TASK_ID });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes(`next-step "${TASK_ID}-1"`));
        assert.ok(result.reason.includes('linked parent-derived strict child tasks match the decision artifact'));
        assert.ok(result.reason.includes('Before entering the selected child task, inspect workflow-config.full_suite_validation.command against that child scope.'));
        assert.ok(result.reason.includes('exclude suspended siblings'));
        assert.ok(taskMd.includes(`| ${TASK_ID} | 🟪 DECOMPOSED |`));
        assert.ok(events.includes('"event_type":"STRICT_DECOMPOSITION_SPLIT_ROUTED"'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_WIP_CAPTURED"'));
        assert.equal(wip.status, 'FOUND');
        assert.equal(wip.manifests.length, 1);
        assert.equal(wip.manifests[0].guard_kind, 'strict_decomposition');
        assert.deepEqual(wip.manifests[0].tracked_files, ['src/app.ts']);
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--short', '--', 'src/app.ts']).stdout.trim(), '');
        assert.ok(text.includes('Status: DECOMPOSED'));
    });

    it('rejects stale risk-signal bypass after WIP suspension and a zero-diff preflight refresh', () => {
        const repoRoot = makeTempRepo();
        const parentRow =
            `| ${TASK_ID} | TODO | P1 | service/bounded-change | Implement bounded parent change | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\` and \`${TASK_ID}-2\`. |`;
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            parentRow,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`, `${TASK_ID}-2`]
        });
        initGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflightScope(repoRoot, TASK_ID, ['src/app.ts', 'src/adapter.ts', 'src/contract.ts']);

        const suspended = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(suspended.status, 'BLOCKED');
        assert.equal(suspended.next_gate, 'strict-decomposition-split-routing');
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--short', '--', 'src/app.ts']).stdout.trim(), '');

        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            parentRow,
            `| ${TASK_ID}-1 | TODO | P1 | service/validation | Validate bounded evidence | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | service/routing | Route bounded execution | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        writePreflightScope(repoRoot, TASK_ID, []);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');

        assert.equal(result.status, 'DECOMPOSED', `${result.next_gate}: ${result.reason}`);
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes(`next-step "${TASK_ID}-1"`));
        assert.ok(taskMd.includes(`| ${TASK_ID} | 🟪 DECOMPOSED |`));
        assert.ok(events.includes('"event_type":"STRICT_DECOMPOSITION_SPLIT_ROUTED"'));
        assert.equal(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'), false);
        assert.equal(text.includes('gate classify-change'), false);
        assert.equal(text.includes('gate compile-gate'), false);
        assert.equal(text.includes('gate review'), false);
    });

    it('suspends legacy parent WIP before routing an already decomposed strict parent to a child', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | DECOMPOSED | P1 | workflow/strict-decomposition-split-routing | Route strict split decisions to children | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\` and \`${TASK_ID}-2\`. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/strict-decomposition-split-routing | Validate split evidence | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/strict-decomposition-split-routing | Route child execution | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`, `${TASK_ID}-2`]
        });
        initGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflightScope(repoRoot, TASK_ID, ['src/app.ts']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const wip = listSplitRequiredWip({ repoRoot, taskId: TASK_ID });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes(`next-step "${TASK_ID}-1"`));
        assert.equal(wip.status, 'FOUND');
        assert.equal(wip.manifests[0].guard_kind, 'strict_decomposition');
        assert.deepEqual(wip.manifests[0].tracked_files, ['src/app.ts']);
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--short', '--', 'src/app.ts']).stdout.trim(), '');
    });

    it('blocks strict split-required routing when a proposed child is not strict', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-split-routing | Route strict split decisions to children | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\` and \`${TASK_ID}-2\`. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/strict-decomposition-split-routing | Validate split evidence | gpt-5.4 | 2026-05-20 | balanced | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/strict-decomposition-split-routing | Route child execution | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`, `${TASK_ID}-2`]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'strict-decomposition-split-routing');
        assert.ok(result.reason.includes('child tasks without strict profile'));
        assert.ok(taskMd.includes(`| ${TASK_ID} | TODO |`));
    });

    it('blocks strict split routing for terminal, placeholder, and duplicate-scope proposed children', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-split-routing | Route strict split decisions to children | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\`, \`${TASK_ID}-2\`, \`${TASK_ID}-3\`, and \`${TASK_ID}-4\`. |`,
            `| ${TASK_ID}-1 | DONE | P1 | workflow/security | Validate trust boundary | gpt-5.4 | 2026-05-20 | strict | Terminal child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/parser | First child | gpt-5.4 | 2026-05-20 | strict | Ordinal placeholder child of ${TASK_ID}. |`,
            `| ${TASK_ID}-3 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-20 | strict | First duplicate scope of ${TASK_ID}. |`,
            `| ${TASK_ID}-4 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-20 | strict | Second duplicate scope of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`, `${TASK_ID}-2`, `${TASK_ID}-3`, `${TASK_ID}-4`]
        });
        const eventPath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const beforeEvents = fs.readFileSync(eventPath, 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'strict-decomposition-split-routing');
        assert.ok(result.reason.includes('terminal child tasks cannot establish a new split'));
        assert.ok(result.reason.includes('placeholder child tasks are not meaningful work packages'));
        assert.ok(result.reason.includes('duplicate child work-package scopes'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | TODO |`));
        assert.equal(fs.readFileSync(eventPath, 'utf8'), beforeEvents);
    });

    it('blocks strict split-required routing for unexpected linked child tasks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-split-routing | Route strict split decisions to children | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\` and \`${TASK_ID}-extra\`. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/strict-decomposition-split-routing | Validate split evidence | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/strict-decomposition-split-routing | Route child execution | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-extra | TODO | P1 | workflow/strict-decomposition-split-routing | Extra child | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`, `${TASK_ID}-2`]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'strict-decomposition-split-routing');
        assert.ok(result.reason.includes('linked child tasks not declared in the decision artifact'));
        assert.ok(result.reason.includes(`${TASK_ID}-extra`));
    });
});
