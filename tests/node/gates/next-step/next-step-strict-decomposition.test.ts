import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildStrictDecompositionDecisionArtifact } from './next-step-test-support';
import {
    buildStrictDecompositionDecisionRequirement
} from '../../../../src/gates/next-step/next-step-strict-decomposition-routing';
import type { NextStepProfileSummary } from '../../../../src/gates/next-step/next-step';
import {
    buildTaskProfilePolicySnapshot,
    type TaskProfilePolicySnapshot
} from '../../../../src/policy/task-profile-policy-snapshot';
import {
    listSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip-operations';
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








function writeStrictDecompositionDecision(
    repoRoot: string,
    taskId: string,
    options: {
        decision?: 'atomic' | 'single-cycle' | 'split-required';
        taskSummary?: string;
        expectedReviewTypes?: string[];
        proposedChildTaskIds?: string[];
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
            taskSummary: options.taskSummary || 'Seeded next-step task',
            reason: 'This strict task is intentionally bounded for the current lifecycle cycle.',
            scopeRisk: 'The scope is constrained by the test fixture and must keep normal review gates.',
            expectedReviewTypes,
            atomicityConstraints: ['The navigator decision and its regression expectations must land together.'],
            proposedChildTaskIds,
            workPackageContract: decision === 'split-required'
                ? {
                    schema_version: 1,
                    finding_obligations: [],
                    work_packages: (proposedChildTaskIds || []).map((childTaskId, index) => ({
                        task_id: childTaskId,
                        profile: 'strict',
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
): void {
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
        assert.ok(result.commands[0].command.includes(
            '[--work-package-contract-path "<required only for split-required>"]'
        ));
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
