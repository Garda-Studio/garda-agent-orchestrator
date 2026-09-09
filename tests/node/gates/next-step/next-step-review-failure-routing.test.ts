import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import type { EffectiveReviewExecutionPolicyMode } from '../../../../src/core/review-execution-policy';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import {
    buildTaskProfilePolicySnapshot,
    type TaskProfilePolicySnapshot
} from '../../../../src/policy/task-profile-policy-snapshot';
import { resolveNextStep } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildDomainScopeFingerprints } from './next-step-test-support';
import {
    seedAuthenticatedReviewerLaunchFixture
} from './next-step-reviewer-launch-fixtures';
import { runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import {
    buildReviewCoverageContract,
    type ReviewCoverageContract
} from '../../../../src/gates/review/review-coverage-ledger';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath
} from '../../../../src/gates/review/review-findings-validation-artifact';
import {
    readReviewArtifactState
} from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import {
    readPostReviewFocusedIntermediateEvidence
} from '../../../../src/gates/next-step/next-step-focused-intermediate-evidence';
import {
    getCurrentReviewerLaunchArtifactEvidenceForInvocation
} from '../../../../src/gates/next-step/next-step-reviewer-launch-evidence';
import {
    inspectTaskEventFile
} from '../../../../src/gate-runtime/task-events-integrity';
import {
    buildReviewFindingsDispositionArtifact,
    getReviewFindingsDispositionArtifactPath,
    getReviewFindingsDispositionArtifactSnapshotPath
} from '../../../../src/gates/review/review-findings-disposition-artifact';
import {
    materializeReviewFindingsFollowUpTasks
} from '../../../../src/gates/review/review-findings-follow-up-tasks';
import {
    resolveLockedReviewFindingPolicyFromPreflight
} from '../../../../src/gates/review/review-finding-disposition';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../../../../src/gates/review-reuse/review-reuse';
import { resolveReviewCoverageChangedFiles } from '../../../../src/gates/review-context/review-coverage-scope';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../src/gates/review/review-evidence-contract';
import {
    buildReviewOutputCorrectionArtifact,
    persistReviewOutputCorrection
} from '../../../../src/gates/review/review-output-correction';
import { initGitRepo } from '../git-fixtures';

const TASK_ID = 'T-NEXT-1';
const nodeRequire = createRequire(__filename);
const DEFAULT_APP_SOURCE = 'export const value = 1;\n';
const PREFLIGHT_CHANGED_APP_SOURCE = 'export const value = 1;\n// Review routing fixture change.\n';
const FOCUSED_COMMAND_TIMEOUT_MS = process.platform === 'win32' ? 120_000 : 60_000;

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
let sharedRepoTemplateRoot: string | null = null;

function populateTempRepo(repoRoot: string): void {
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
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), DEFAULT_APP_SOURCE, 'utf8');
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
}

function getSharedRepoTemplateRoot(): string {
    if (sharedRepoTemplateRoot) {
        return sharedRepoTemplateRoot;
    }
    sharedRepoTemplateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-template-'));
    populateTempRepo(sharedRepoTemplateRoot);
    seedRunnableFocusedIntermediateCommand(sharedRepoTemplateRoot, { markTestChanged: false });
    initGitRepo(sharedRepoTemplateRoot, {
        gitignoreContent: 'TASK.md\ngarda-agent-orchestrator/runtime/\n'
    });
    return sharedRepoTemplateRoot;
}

function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-'));
    fs.cpSync(getSharedRepoTemplateRoot(), repoRoot, { recursive: true });
    tempRoots.push(repoRoot);
    return repoRoot;
}

function markTaskInProgress(repoRoot: string, taskId: string): void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const content = fs.readFileSync(taskPath, 'utf8');
    fs.writeFileSync(
        taskPath,
        content.replace(`| ${taskId} | TODO |`, `| ${taskId} | IN_PROGRESS |`),
        'utf8'
    );
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

function sha256Json(value: unknown): string {
    return sha256Text(`${JSON.stringify(value, null, 2)}\n`);
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
    const taskModePath = path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    const profilePolicySnapshot = buildTaskProfilePolicySnapshot(
        path.join(repoRoot, 'garda-agent-orchestrator'),
        'balanced',
        {
            reviewExecutionPolicyMode: 'code_first_optional',
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
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', buildTaskModeTimelineDetails(
        taskModePath,
        profilePolicySnapshot
    ));
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
        reviewPolicyMode?: EffectiveReviewExecutionPolicyMode;
        reviewFindingPolicy?: {
            schema_version: 1;
            policy_id: 'soft' | 'balanced' | 'strict' | 'custom';
            findings: {
                critical: 'fix_now';
                high: 'fix_now' | 'create_follow_up' | 'ignore';
                medium: 'fix_now' | 'create_follow_up' | 'ignore';
                low: 'fix_now' | 'create_follow_up' | 'ignore';
            };
            residual_risk: 'fix_now' | 'create_follow_up' | 'ignore';
        };
        reviewFollowUpPolicy?: {
            schema_version: 1;
            materialization_mode: 'per_finding' | 'grouped_by_parent';
        };
        reviewFollowUpTaskClosurePolicy?: {
            schema_version: 1;
            eligible: boolean;
            configured: boolean;
            valid: boolean;
            provenance: 'per_finding' | 'grouped_by_parent' | null;
            source_notes_sha256: string | null;
            skip_low_findings: boolean;
            forbid_child_tasks: boolean;
            diagnostics: string[];
        };
        changedFiles?: string[];
        includeDomainScopeFingerprints?: boolean;
    } = {}
): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const changedFiles = options.changedFiles || ['src/app.ts'];
    const appPath = path.join(repoRoot, 'src', 'app.ts');
    if (
        changedFiles.includes('src/app.ts')
        && fs.existsSync(appPath)
        && fs.readFileSync(appPath, 'utf8') === DEFAULT_APP_SOURCE
    ) {
        fs.writeFileSync(appPath, PREFLIGHT_CHANGED_APP_SOURCE, 'utf8');
    }
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
    const taskMode = JSON.parse(
        fs.readFileSync(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8')
    ) as Record<string, unknown>;
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
        taskIntent: 'Exercise failed review routing',
        changedFiles,
        taskTriggers: {},
        reviewExecutionPolicyMode: reviewPolicyMode,
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
            snapshot_hash: frozenProfileSnapshot.snapshot_hash,
            ...(options.reviewFindingPolicy
                ? { review_finding_policy: options.reviewFindingPolicy }
                : {}),
            ...(options.reviewFollowUpPolicy
                ? { review_follow_up_policy: options.reviewFollowUpPolicy }
                : {}),
            ...(options.reviewFollowUpTaskClosurePolicy
                ? { review_follow_up_task_closure_policy: options.reviewFollowUpTaskClosurePolicy }
                : {})
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
        seedPostPreflightRulePack(
            repoRoot,
            taskId,
            preflightPath,
            path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`)
        );
    }
    return preflightPath;
}

function seedCompilePass(
    repoRoot: string,
    taskId: string,
    timestampUtc?: string,
    changedFiles: string[] = ['src/app.ts']
): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
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

function currentReviewCoverageContractSha256(repoRoot: string, reviewType = 'code'): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    return buildReviewCoverageContract({
        reviewType,
        changedFiles: resolveReviewCoverageChangedFiles({ reviewType, preflight, repoRoot })
    }).contract_sha256;
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
        coverage_scope: {
            changed_files: resolveReviewCoverageChangedFiles({ reviewType, preflight, repoRoot })
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
        contextSchemaVersion?: number;
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
    const preflight = fs.existsSync(preflightPath)
        ? JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>
        : {};
    const coverageContract = buildReviewCoverageContract({
        reviewType,
        changedFiles: resolveReviewCoverageChangedFiles({ reviewType, preflight, repoRoot })
    });
    const reviewExecution = buildReviewRemediationReviewContract({
        taskId,
        reviewType,
        preflightSha256: fileSha256(preflightPath),
        fullReviewScope: resolveReviewCoverageChangedFiles({ reviewType, preflight, repoRoot })
    });
    const reviewContext = {
        ...(options.contextSchemaVersion
            ? { schema_version: options.contextSchemaVersion }
            : {}),
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        ...reviewContextScope,
        coverage_contract: coverageContract,
        ...(Number(options.contextSchemaVersion || 0) >= 4
            ? { review_execution: reviewExecution }
            : {}),
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`
        }
    };
    const reviewContextText = `${JSON.stringify(reviewContext, null, 2)}\n`;
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');
    const artifactText = `# ${reviewType} review\n\n${options.body || ''}## Verdict\n${verdictToken}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const authenticatedLaunch = options.includeLaunchArtifact !== false
        ? seedAuthenticatedReviewerLaunchFixture({
            repoRoot,
            taskId,
            reviewType,
            reviewerIdentity: `agent:${reviewType}-reviewer`,
            reviewContextPath,
            reviewTreeStateSha256,
            appendEvent,
            includeInvocation: false
        })
        : null;
    const routeIntegrity = authenticatedLaunch?.routeIntegrity
        ?? appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
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
    let reviewerLaunchArtifactSha256 = authenticatedLaunch?.launchArtifactSha256 || '';
    if (options.includeLaunchArtifact !== false && !authenticatedLaunch) {
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

function resolveReviewExecutionFixture(reviewContext: Record<string, unknown>) {
    const contract = reviewContext.review_execution as ReturnType<typeof buildReviewRemediationReviewContract>;
    assert.ok(contract, 'Fixture review context must include review_execution.');
    const evidence = resolveReviewContextExecutionEvidenceBindings(reviewContext);
    assert.ok(evidence.bindings, evidence.violations.join('\n'));
    return {
        contract,
        bindings: evidence.bindings,
        declaration: {
            mode: contract.mode,
            contract_sha256: contract.contract_sha256,
            covered_delta_targets: contract.delta?.required_delta_targets || [],
            inspected_prior_finding_ids: contract.finding_reconciliation.resolvable_finding_ids
        }
    };
}

function writeJsonFocusedValidationReviewEvidence(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    requiredTestPath: string,
    options: {
        markerField?: 'title' | 'description';
    } = {}
): void {
    writeReviewEvidence(repoRoot, taskId, reviewType, {
        verdict: 'fail',
        contextSchemaVersion: 4
    });
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const coverageContract = reviewContext.coverage_contract as ReviewCoverageContract;
    const reviewExecution = resolveReviewExecutionFixture(reviewContext);
    assert.ok(coverageContract?.obligations?.length, 'fixture coverage contract must have obligations');
    const primaryObligation = coverageContract.obligations[0];
    const evidence = {
        location: `${requiredTestPath}:1`,
        observation: `The changed focused test ${requiredTestPath} requires a current task-owned focused validation run.`
    };
    const marker = `[garda:evidence-only:missing-focused-validation] test=${requiredTestPath}; action=run-and-record-focused-test`;
    const markerField = options.markerField ?? 'title';
    const report = {
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        review_context_sha256: fileSha256(reviewContextPath),
        tree_state_sha256: String((reviewContext.tree_state as Record<string, unknown> | undefined)?.tree_state_sha256 || ''),
        validation_notes: [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer attempted the smallest relevant focused test after prior execution evidence was unavailable.',
            command: `node scripts/node-foundation/build-scripts.cjs test.js ${requiredTestPath}`,
            command_outcome: 'unavailable',
            diagnostics: 'The isolated reviewer environment could not execute the repository test wrapper.',
            evidence: [evidence]
        }],
        coverage_ledger: {
            coverage_contract_sha256: coverageContract.contract_sha256,
            entries: coverageContract.obligations.map((obligation, index) => ({
                obligation_id: obligation.id,
                evidence: [{
                    location: `${requiredTestPath}:1`,
                    observation: `Reviewed coverage obligation ${obligation.id} for ${obligation.target}.`
                }],
                finding_ids: index === 0 ? ['F-000'] : []
            }))
        },
        review_execution: reviewExecution.declaration,
        findings: {
            critical: [],
            high: [],
            medium: [{
                id: 'F-000',
                title: markerField === 'title' ? marker : 'Missing focused validation evidence for the named changed test.',
                description: markerField === 'description'
                    ? marker
                    : 'The review handoff does not include current focused validation evidence for the named changed test.',
                evidence: [evidence],
                coverage_obligation_ids: [primaryObligation.id]
            }],
            low: []
        },
        residual_risks: [],
        reviewer_notes: ['Findings-only JSON artifact used for focused-validation recovery routing.']
    };
    const artifactText = `${JSON.stringify(report, null, 2)}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactSha256 = fileSha256(artifactPath);
    const reviewContextSha256 = fileSha256(reviewContextPath);
    const reviewTreeStateSha256 = String((reviewContext.tree_state as Record<string, unknown> | undefined)?.tree_state_sha256 || '');
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    const scopeSha256 = String(metrics?.scope_sha256 || metrics?.changed_files_sha256 || '').trim().toLowerCase() || null;
    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256;
    const codeScopeSha256 = computeReviewReuseCodeScopeFingerprint(reviewType, preflight, repoRoot).code_scope_sha256;
    const findingsValidation = validateReviewFindingsContract({
        content: artifactText,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        expectedReviewContextSha256: reviewContextSha256,
        expectedTreeStateSha256: reviewTreeStateSha256,
        coverageContract,
        expectedReviewExecutionContract: reviewExecution.contract,
        repoRoot
    });
    assert.equal(findingsValidation.valid, true, findingsValidation.violations.join('\n'));
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId,
        reviewType,
        validation: findingsValidation,
        reviewOutputSha256: artifactSha256,
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: artifactSha256,
        reviewContextPath,
        reviewContextSha256,
        preflightPath,
        preflightSha256: fileSha256(preflightPath),
        scopeSha256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewTreeStateSha256,
        coverageContract
    });
    const validationArtifactSha256 = sha256Json(validationArtifact);
    const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
        validationArtifactPath,
        validationArtifactSha256
    );
    writeJson(validationArtifactPath, validationArtifact);
    writeJson(validationArtifactSnapshotPath, validationArtifact);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.review_artifact_sha256 = artifactSha256;
    receipt.review_output_sha256 = artifactSha256;
    receipt.review_coverage = findingsValidation.coverage_validation;
    receipt.review_output_format = 'findings_json';
    receipt.review_output_schema_version = findingsValidation.report?.schema_version ?? null;
    receipt.review_findings_report_sha256 = findingsValidation.report ? sha256Json(findingsValidation.report) : null;
    receipt.review_findings_report = findingsValidation.report;
    Object.assign(receipt, reviewExecution.bindings);
    receipt.scope_sha256 = scopeSha256;
    receipt.review_scope_sha256 = reviewScopeSha256;
    receipt.code_scope_sha256 = codeScopeSha256;
    receipt.review_findings_validation = {
        artifact_path: path.normalize(validationArtifactPath).replace(/\\/g, '/'),
        artifact_sha256: validationArtifactSha256,
        snapshot_path: path.normalize(validationArtifactSnapshotPath).replace(/\\/g, '/'),
        snapshot_sha256: validationArtifactSha256,
        status: validationArtifact.validation_result.status,
        accepted: validationArtifact.validation_result.accepted,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        violation_count: validationArtifact.validation_result.violations.length
    };
    receipt.review_output_contract = {
        schema_version: 1,
        format: 'findings_json',
        report_sha256: findingsValidation.report ? sha256Json(findingsValidation.report) : null,
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        raw_output_sha256: artifactSha256,
        review_artifact_sha256: artifactSha256,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        ...reviewExecution.bindings,
        coverage_contract_sha256: coverageContract.contract_sha256,
        reviewer_identity: `agent:${reviewType}-reviewer`,
        reviewer_provenance_event_sha256: (receipt.reviewer_provenance as Record<string, unknown> | undefined)?.event_sha256 ?? null
    };
    writeJson(receiptPath, receipt);
}

function writeRejectedFindingsValidationReviewEvidence(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    options: {
        preserveStaleReceipt?: boolean;
        apiCorrectionProviderInvocationId?: string;
    } = {}
): void {
    writeReviewEvidence(repoRoot, taskId, reviewType, {
        verdict: 'pass',
        contextSchemaVersion: 4
    });
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const coverageContract = reviewContext.coverage_contract as ReviewCoverageContract;
    const reviewExecution = resolveReviewExecutionFixture(reviewContext);
    const reviewContextSha256 = fileSha256(reviewContextPath);
    const reviewTreeStateSha256 = String((reviewContext.tree_state as Record<string, unknown> | undefined)?.tree_state_sha256 || '');
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    const scopeSha256 = String(metrics?.scope_sha256 || metrics?.changed_files_sha256 || '').trim().toLowerCase() || null;
    const artifactText = `${JSON.stringify({
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        review_context_sha256: reviewContextSha256,
        tree_state_sha256: reviewTreeStateSha256,
        validation_notes: [],
        coverage_ledger: {
            coverage_contract_sha256: coverageContract.contract_sha256,
            entries: [{
                obligation_id: coverageContract.obligations[0]?.id || 'FILE-001',
                evidence: [{
                    location: 'src/app.ts:1',
                    observation: 'Intentionally incomplete report used to trigger system validation rejection.'
                }],
                finding_ids: []
            }]
        },
        review_execution: reviewExecution.declaration,
        findings: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [],
        reviewer_notes: []
    }, null, 2)}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const validation = validateReviewFindingsContract({
        content: artifactText,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        expectedReviewContextSha256: reviewContextSha256,
        expectedTreeStateSha256: reviewTreeStateSha256,
        coverageContract,
        expectedReviewExecutionContract: reviewExecution.contract,
        repoRoot
    });
    assert.equal(validation.valid, false);
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId,
        reviewType,
        validation,
        reviewOutputSha256: fileSha256(artifactPath),
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: null,
        reviewContextPath,
        reviewContextSha256,
        preflightPath,
        preflightSha256: fileSha256(preflightPath),
        scopeSha256,
        reviewScopeSha256: null,
        codeScopeSha256: null,
        reviewTreeStateSha256,
        coverageContract
    });
    writeJson(validationArtifactPath, validationArtifact);
    const launchArtifactPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'tmp',
        'reviews',
        taskId,
        reviewType,
        'reviewer-launch.json'
    );
    const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const reviewerInvocationEventSha256 = String(
        (receipt.reviewer_provenance as Record<string, unknown> | undefined)?.event_sha256 || ''
    ).trim().toLowerCase();
    assert.match(reviewerInvocationEventSha256, /^[0-9a-f]{64}$/u);
    const correctionArtifact = buildReviewOutputCorrectionArtifact({
        taskId,
        reviewType,
        rejectedOutputPath: artifactPath,
        rejectedOutputSha256: fileSha256(artifactPath),
        reviewContextPath,
        reviewContextSha256,
        reviewTreeStateSha256,
        reviewerIdentity: String(launchArtifact.reviewer_identity || 'agent:code-reviewer'),
        reviewerAttemptId: String(
            launchArtifact.reviewer_launch_attempt_id
            || launchArtifact.provider_invocation_id
            || 'fixture-correction-attempt'
        ),
        reviewerInvocationEventSha256,
        validationArtifactPath,
        validationArtifactSha256: fileSha256(validationArtifactPath),
        violations: validation.violations,
        capabilities: {
            live_reviewer_continuation: !options.apiCorrectionProviderInvocationId,
            api_conversation_continuation: Boolean(options.apiCorrectionProviderInvocationId),
            correction_only_invocation: true
        },
        providerId: options.apiCorrectionProviderInvocationId ? 'Codex' : null,
        providerInvocationId: options.apiCorrectionProviderInvocationId || null,
        sessionAvailability: options.apiCorrectionProviderInvocationId ? 'pending' : undefined
    });
    persistReviewOutputCorrection({
        repoRoot,
        reviewArtifactPath: artifactPath,
        rawOutput: artifactText,
        artifact: correctionArtifact
    });
    if (!options.preserveStaleReceipt) {
        fs.rmSync(receiptPath, { force: true });
    }
}

function writeAcceptedFindingsDispositionReviewEvidence(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    options: {
        findingSeverity?: 'medium' | 'low';
        followUpFindingCount?: number;
    } = {}
): void {
    writeReviewEvidence(repoRoot, taskId, reviewType, {
        verdict: 'pass',
        contextSchemaVersion: 4
    });
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const coverageContract = reviewContext.coverage_contract as ReviewCoverageContract;
    const reviewExecution = resolveReviewExecutionFixture(reviewContext);
    const findingSeverity = options.findingSeverity ?? 'medium';
    const followUpFindingCount = options.followUpFindingCount ?? 1;
    const followUpFindingIds = Array.from({ length: followUpFindingCount }, (_, index) => `F-${String(index + 1).padStart(3, '0')}`);
    const followUpFindings = followUpFindingIds.map((findingId, index) => {
        const obligation = coverageContract.obligations[index] || coverageContract.obligations[0];
        return {
            id: findingId,
            title: `Accepted follow-up finding ${index + 1}`,
            description: 'Balanced policy should materialize this accepted finding as a follow-up task.',
            evidence: [{
                location: 'src/app.ts:1',
                observation: 'The accepted finding remains non-blocking only after follow-up materialization.'
            }],
            coverage_obligation_ids: [obligation.id]
        };
    });
    const reviewContextSha256 = fileSha256(reviewContextPath);
    const reviewTreeStateSha256 = String((reviewContext.tree_state as Record<string, unknown> | undefined)?.tree_state_sha256 || '');
    const artifactText = `${JSON.stringify({
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        review_context_sha256: reviewContextSha256,
        tree_state_sha256: reviewTreeStateSha256,
        validation_notes: [{
            id: 'N-001',
            topic: 'follow-up disposition',
            note: 'Reviewed accepted follow-up disposition routing.',
            evidence: [{
                location: 'src/app.ts:1',
                observation: 'Accepted finding should be materialized as a follow-up task.'
            }]
        }],
        coverage_ledger: {
            coverage_contract_sha256: coverageContract.contract_sha256,
            entries: coverageContract.obligations.map((obligation, index) => ({
                obligation_id: obligation.id,
                evidence: [{
                    location: 'src/app.ts:1',
                    observation: `Covered obligation ${obligation.id} for accepted follow-up disposition routing.`
                }],
                finding_ids: followUpFindingIds[index] ? [followUpFindingIds[index]] : []
            }))
        },
        review_execution: reviewExecution.declaration,
        findings: {
            critical: [],
            high: [],
            medium: findingSeverity === 'medium' ? followUpFindings : [],
            low: findingSeverity === 'low' ? followUpFindings : []
        },
        residual_risks: [],
        reviewer_notes: []
    }, null, 2)}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactSha256 = fileSha256(artifactPath);
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    const scopeSha256 = String(metrics?.scope_sha256 || metrics?.changed_files_sha256 || '').trim().toLowerCase() || null;
    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256;
    const codeScopeSha256 = computeReviewReuseCodeScopeFingerprint(reviewType, preflight, repoRoot).code_scope_sha256;
    const validation = validateReviewFindingsContract({
        content: artifactText,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        expectedReviewContextSha256: reviewContextSha256,
        expectedTreeStateSha256: reviewTreeStateSha256,
        coverageContract,
        expectedReviewExecutionContract: reviewExecution.contract,
        repoRoot
    });
    assert.equal(validation.valid, true, validation.violations.join('\n'));
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId,
        reviewType,
        validation,
        reviewOutputSha256: artifactSha256,
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: artifactSha256,
        reviewContextPath,
        reviewContextSha256,
        preflightPath,
        preflightSha256: fileSha256(preflightPath),
        scopeSha256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewTreeStateSha256,
        coverageContract
    });
    const validationArtifactSha256 = sha256Json(validationArtifact);
    const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
        validationArtifactPath,
        validationArtifactSha256
    );
    writeJson(validationArtifactPath, validationArtifact);
    writeJson(validationArtifactSnapshotPath, validationArtifact);
    const policyResolution = resolveLockedReviewFindingPolicyFromPreflight(preflight);
    const dispositionArtifactPath = getReviewFindingsDispositionArtifactPath(artifactPath);
    const dispositionArtifact = buildReviewFindingsDispositionArtifact({
        taskId,
        reviewType,
        validationArtifact,
        validationArtifactPath,
        validationArtifactSha256,
        policyResolution
    });
    const dispositionArtifactSha256 = sha256Json(dispositionArtifact);
    const dispositionArtifactSnapshotPath = getReviewFindingsDispositionArtifactSnapshotPath(
        dispositionArtifactPath,
        dispositionArtifactSha256
    );
    writeJson(dispositionArtifactPath, dispositionArtifact);
    writeJson(dispositionArtifactSnapshotPath, dispositionArtifact);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.review_artifact_sha256 = artifactSha256;
    receipt.review_output_sha256 = artifactSha256;
    receipt.review_coverage = validation.coverage_validation;
    receipt.review_output_format = 'findings_json';
    receipt.review_output_schema_version = validation.report?.schema_version ?? null;
    receipt.review_findings_report_sha256 = validation.report ? sha256Json(validation.report) : null;
    receipt.review_findings_report = validation.report;
    Object.assign(receipt, reviewExecution.bindings);
    receipt.scope_sha256 = scopeSha256;
    receipt.review_scope_sha256 = reviewScopeSha256;
    receipt.code_scope_sha256 = codeScopeSha256;
    receipt.review_findings_validation = {
        artifact_path: path.normalize(validationArtifactPath).replace(/\\/g, '/'),
        artifact_sha256: validationArtifactSha256,
        snapshot_path: path.normalize(validationArtifactSnapshotPath).replace(/\\/g, '/'),
        snapshot_sha256: validationArtifactSha256,
        status: validationArtifact.validation_result.status,
        accepted: validationArtifact.validation_result.accepted,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        violation_count: validationArtifact.validation_result.violations.length
    };
    receipt.review_findings_disposition = dispositionArtifact.disposition_result;
    receipt.review_findings_disposition_artifact = {
        artifact_path: path.normalize(dispositionArtifactPath).replace(/\\/g, '/'),
        artifact_sha256: dispositionArtifactSha256,
        snapshot_path: path.normalize(dispositionArtifactSnapshotPath).replace(/\\/g, '/'),
        snapshot_sha256: dispositionArtifactSha256,
        disposition_result_sha256: dispositionArtifact.disposition_result_sha256,
        policy_id: dispositionArtifact.disposition_result.policy_id,
        policy_source: dispositionArtifact.disposition_result.policy_source,
        item_count: dispositionArtifact.summary.item_count,
        fix_now_count: dispositionArtifact.summary.fix_now_count,
        follow_up_pending_count: dispositionArtifact.summary.follow_up_pending_count,
        ignored_count: dispositionArtifact.summary.ignored_count,
        blocking_count: dispositionArtifact.summary.blocking_count
    };
    receipt.review_output_contract = {
        schema_version: 1,
        format: 'findings_json',
        report_sha256: validation.report ? sha256Json(validation.report) : null,
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        disposition_artifact_sha256: dispositionArtifactSha256,
        disposition_result_sha256: dispositionArtifact.disposition_result_sha256,
        raw_output_sha256: artifactSha256,
        review_artifact_sha256: artifactSha256,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        ...reviewExecution.bindings,
        coverage_contract_sha256: coverageContract.contract_sha256,
        reviewer_identity: `agent:${reviewType}-reviewer`,
        reviewer_provenance_event_sha256: (receipt.reviewer_provenance as Record<string, unknown> | undefined)?.event_sha256 ?? null
    };
    writeJson(receiptPath, receipt);
}




function writeFocusedIntermediateEvidence(
    repoRoot: string,
    taskId: string,
    options: {
        artifactHash?: string;
        commandSource?: 'node-test' | 'targeted-test' | 'typecheck' | 'validation';
        eventArtifactPath?: string;
        eventOutcome?: 'PASSED' | 'FAILED';
        exitCode?: number;
        recordStatus?: 'PASSED' | 'FAILED';
        recordTaskId?: string;
        timestampUtc?: string;
        command?: string;
        mutateOutputArtifactAfterRecord?: boolean;
        eventOutputArtifactHash?: string;
        includeCurrentBindings?: boolean;
    } = {}
): void {
    const commandSource = options.commandSource ?? 'targeted-test';
    const command = options.command ?? 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-evidence.test.ts';
    const commandHash = sha256Text(command).slice(0, 12);
    const artifactPath = path.join(
        reviewsRoot(repoRoot),
        `${taskId}-intermediate-command-${commandSource}-${commandHash}.json`
    );
    const outputPath = path.join(
        reviewsRoot(repoRoot),
        `${taskId}-intermediate-command-${commandSource}-${commandHash}.log`
    );
    const exitCode = options.exitCode ?? 0;
    const recordStatus = options.recordStatus ?? 'PASSED';
    fs.writeFileSync(outputPath, 'focused validation passed\n', 'utf8');
    const outputArtifactSha256 = fileSha256(outputPath);
    const outputArtifactSizeBytes = fs.statSync(outputPath).size;
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const currentBindings = options.includeCurrentBindings === false
        ? {}
        : {
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            coverage_contract_sha256: currentReviewCoverageContractSha256(repoRoot)
        };
    writeJson(artifactPath, {
        schema_version: 1,
        task_id: options.recordTaskId ?? taskId,
        command_source: commandSource,
        command,
        status: recordStatus,
        exit_code: exitCode,
        duration_ms: 1,
        output_artifact: outputPath,
        output_artifact_sha256: options.eventOutputArtifactHash ?? outputArtifactSha256,
        output_artifact_size_bytes: outputArtifactSizeBytes,
        ...currentBindings,
        output_telemetry: {}
    });
    appendEvent(repoRoot, taskId, 'INTERMEDIATE_COMMAND_RUN', options.eventOutcome ?? recordStatus, {
        command_source: commandSource,
        command,
        artifact_path: normalizeForTimeline(options.eventArtifactPath ?? artifactPath),
        artifact_sha256: options.artifactHash ?? fileSha256(artifactPath),
        output_artifact_path: normalizeForTimeline(outputPath),
        output_artifact_sha256: outputArtifactSha256,
        output_artifact_size_bytes: outputArtifactSizeBytes,
        ...currentBindings,
        exit_code: exitCode
    }, options.timestampUtc);
    if (options.mutateOutputArtifactAfterRecord) {
        fs.writeFileSync(outputPath, 'tampered focused validation output\n', 'utf8');
    }
}

function seedRunnableFocusedIntermediateCommand(
    repoRoot: string,
    options: { markTestChanged?: boolean } = {}
): void {
    const scriptPath = path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');
    const npmTestScriptPath = path.join(repoRoot, 'scripts', 'node-foundation', 'npm-focused-test.cjs');
    const testPath = path.join(repoRoot, 'tests', 'node', 'gates', 'focused-evidence.test.ts');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
        testPath,
        options.markTestChanged === false
            ? 'export {};\n'
            : 'export {};\n// Focused evidence fixture change.\n',
        'utf8'
    );
    fs.writeFileSync(
        scriptPath,
        [
            "if (process.argv[2] !== 'test.js' || process.argv[3] !== 'tests/node/gates/focused-evidence.test.ts') process.exit(2);",
            "console.log('focused evidence fixture passed');",
            ''
        ].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        npmTestScriptPath,
        [
            "if (process.argv[2] !== 'tests/node/gates/focused-evidence.test.ts') process.exit(2);",
            "console.log('npm focused evidence fixture passed');",
            ''
        ].join('\n'),
        'utf8'
    );
    writeJson(path.join(repoRoot, 'package.json'), {
        private: true,
        scripts: {
            test: 'node scripts/node-foundation/npm-focused-test.cjs'
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











after(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
    if (sharedRepoTemplateRoot) {
        fs.rmSync(sharedRepoTemplateRoot, { recursive: true, force: true });
        sharedRepoTemplateRoot = null;
    }
});


describe('gates/next-step', { concurrency: 2 }, () => {
    it('routes back to failed code remediation instead of independent review lanes after a current failed code review', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                '- High: `src/first.ts:10` forged evidence is accepted; impact: trust bypass; remediation: bind the receipt hash.',
                '- Medium: `src/later.ts:42` later category is skipped; impact: incomplete review; remediation: finish the complete sweep.',
                '',
                '## Deferred Findings',
                'none',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.match(result.reason, /Do not launch downstream reviewers/);
        assert.match(result.reason, /CODE REVIEW FAILED/u);
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
    });

    it('routes rejected findings validation back to review result correction instead of implementation remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeRejectedFindingsValidationReviewEvidence(repoRoot, TASK_ID, 'code');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-review-result');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Execute the bound 'code' correction handoff/);
        assert.match(result.reason, /provider tools before running the command/);
        assert.ok(result.commands[0].command.includes('gate record-review-result'));
        assert.ok(result.commands[0].command.includes('--reviewer-identity "agent:code-reviewer"'));
        assert.ok(result.commands[0].command.includes('--correction-provider-invocation-id'));
        assert.ok(result.commands[0].command.includes('--correction-provider-invocation-event-sha256'));
        assert.ok(result.commands[0].command.includes('--correction-attestation-source'));
        assert.equal(result.commands[0].command.includes('agent:pending'), false);
        assert.ok(!result.commands[0].command.includes('compile-gate'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
    });

    it('routes current rejected validation to correction when an older receipt still exists', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeRejectedFindingsValidationReviewEvidence(repoRoot, TASK_ID, 'code', {
            preserveStaleReceipt: true
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-review-result');
        assert.match(result.title, /Execute the bound 'code' correction handoff/);
        assert.ok(result.commands[0].command.includes('--reviewer-identity "agent:code-reviewer"'));
        assert.equal(result.commands[0].command.includes('restart-review-cycle'), false);
    });

    it('rejects a correction transport provider invocation that is not bound to the authenticated reviewer event', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeRejectedFindingsValidationReviewEvidence(repoRoot, TASK_ID, 'code', {
            apiCorrectionProviderInvocationId: 'forged-provider-invocation'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'restart-review-cycle');
        assert.match(result.reason, /cannot safely continue|provenance or semantic binding is unavailable/u);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(result.commands[0].command.includes(
            '--task-intent "Make next-step output executable in tests"'
        ));
        assert.ok(!result.commands[0].command.includes('--task-intent "Seeded next-step task"'));
        assert.ok(result.commands[0].command.includes('--review-evidence-only'));
        assert.equal(result.commands[0].command.includes('--changed-file'), false);
        assert.equal(result.commands[0].command.includes('forged-provider-invocation'), false);
        assert.equal(result.commands[0].command.includes('record-review-output-correction-transport'), false);
    });

    it('routes an authenticated correction transport through the bound reviewer invocation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeRejectedFindingsValidationReviewEvidence(repoRoot, TASK_ID, 'code', {
            apiCorrectionProviderInvocationId: 'test-code-invocation'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-review-output-correction-transport');
        assert.match(result.commands[0].command, /record-review-output-correction-transport/u);
        assert.ok(result.commands[0].command.includes('--reviewer-identity "agent:code-reviewer"'));
        assert.ok(result.commands[0].command.includes('--provider-invocation-id "test-code-invocation"'));
        assert.equal(result.commands[0].command.includes('restart-review-cycle'), false);
    });

    it('preserves passed upstream reviews while correcting a rejected downstream report', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code', {
            followUpFindingCount: 0
        });
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'security', {
            followUpFindingCount: 0
        });
        writeRejectedFindingsValidationReviewEvidence(repoRoot, TASK_ID, 'refactor');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'refactor');
        assert.match(result.title, /Execute the bound 'refactor' correction handoff/);
        assert.ok(result.commands[0].command.includes('--review-type "refactor"'));
        assert.equal(result.commands[0].command.includes('restart-review-cycle'), false);
        assert.equal(result.commands[0].command.includes('build-review-context'), false);
    });

    it('routes terminalized findings validation failure back to correction when the completed attempt is authenticated', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeRejectedFindingsValidationReviewEvidence(repoRoot, TASK_ID, 'code');
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
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const rejectedLaunchArtifactSha256 = fileSha256(launchArtifactPath);
        const validationArtifactPath = getReviewFindingsValidationArtifactPath(
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`)
        );
        const validationArtifactSha256 = fileSha256(validationArtifactPath);
        const launchFailedAtUtc = '2026-04-28T00:00:14.000Z';
        const failedLaunchArtifact = {
            ...launchArtifact,
            attestation_state: 'launch_failed',
            launch_failure_stage: 'review_findings_validation',
            launch_failure_reason: 'Review findings validation rejected the delegated reviewer output.',
            launch_failed_at_utc: launchFailedAtUtc,
            rejected_reviewer_launch_artifact_sha256: rejectedLaunchArtifactSha256,
            review_findings_validation_artifact_path: validationArtifactPath.replace(/\\/g, '/'),
            review_findings_validation_artifact_sha256: validationArtifactSha256
        };
        writeJson(launchArtifactPath, failedLaunchArtifact);
        const failedLaunchArtifactSha256 = fileSha256(launchArtifactPath);
        const unauthenticatedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(unauthenticatedResult.status, 'BLOCKED');
        assert.equal(unauthenticatedResult.next_gate, 'restart-review-cycle');
        assert.doesNotMatch(unauthenticatedResult.title, /Recover failed 'code' delegated reviewer launch/);
        assert.match(unauthenticatedResult.reason, /current_attempt_not_launched|current_attempt_not_resolved/);

        const failureIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_FAILED', 'FAIL', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:code-reviewer',
            reviewer_identity: 'agent:code-reviewer',
            review_context_sha256: String(launchArtifact.review_context_sha256 || ''),
            routing_event_sha256: String(launchArtifact.routing_event_sha256 || ''),
            reviewer_launch_attempt_id: String(launchArtifact.reviewer_launch_attempt_id || ''),
            reviewer_launch_artifact_path: launchArtifactPath.replace(/\\/g, '/'),
            reviewer_launch_artifact_sha256: failedLaunchArtifactSha256,
            rejected_reviewer_launch_artifact_sha256: rejectedLaunchArtifactSha256,
            provider_invocation_id: String(launchArtifact.provider_invocation_id || ''),
            delegation_started_at_utc: String(launchArtifact.delegation_started_at_utc || ''),
            launch_failed_at_utc: launchFailedAtUtc,
            launch_failure_stage: 'review_findings_validation',
            launch_failure_reason: 'Review findings validation rejected the delegated reviewer output.',
            review_findings_validation_artifact_path: validationArtifactPath.replace(/\\/g, '/'),
            review_findings_validation_artifact_sha256: validationArtifactSha256
        });

        const timelinePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${TASK_ID}.jsonl`
        );
        assert.match(inspectTaskEventFile(timelinePath, TASK_ID).status, /^PASS/u);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const failedReviewState = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            preflightPath,
            fileSha256(preflightPath),
            JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        const failedLaunchEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
            repoRoot,
            path.dirname(timelinePath),
            TASK_ID,
            failedReviewState
        );
        assert.equal(
            failedLaunchEvidence.state,
            'provider_failed',
            JSON.stringify({ failedLaunchEvidence, failedReviewState })
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-review-result');
        assert.match(result.title, /Execute the bound 'code' correction handoff/);
        assert.ok(result.commands[0].command.includes('gate record-review-result'));
        assert.equal(result.commands[0].command.includes('--correction-attestation-source'), true);
        assert.equal(result.commands[0].command.includes('restart-review-cycle'), false);
        assert.equal(result.commands[0].command.includes('agent:pending'), false);
        assert.match(failureIntegrity.event_sha256, /^[0-9a-f]{64}$/);

        const validationArtifactContent = fs.readFileSync(validationArtifactPath);
        fs.appendFileSync(validationArtifactPath, '\n', 'utf8');
        const tamperedValidationResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(tamperedValidationResult.status, 'BLOCKED');
        assert.equal(tamperedValidationResult.next_gate, 'restart-review-cycle');
        assert.doesNotMatch(tamperedValidationResult.title, /Recover failed 'code' delegated reviewer launch/);
        assert.ok(tamperedValidationResult.commands.every((entry) => !entry.command.includes('record-review-result')));

        fs.writeFileSync(validationArtifactPath, validationArtifactContent);
        const restoredValidationResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.match(restoredValidationResult.title, /Execute the bound 'code' correction handoff/);

        const timelineLines = fs.readFileSync(timelinePath, 'utf8').trim().split(/\r?\n/);
        const lastEvent = JSON.parse(timelineLines[timelineLines.length - 1]) as Record<string, unknown>;
        (lastEvent.integrity as Record<string, unknown>).event_sha256 = '0'.repeat(64);
        timelineLines[timelineLines.length - 1] = JSON.stringify(lastEvent);
        fs.writeFileSync(timelinePath, `${timelineLines.join('\n')}\n`, 'utf8');
        const corruptedTimelineResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(corruptedTimelineResult.status, 'BLOCKED');
        assert.equal(corruptedTimelineResult.next_gate, 'restart-review-cycle');
        assert.doesNotMatch(corruptedTimelineResult.title, /Recover failed 'code' delegated reviewer launch/);
        assert.ok(corruptedTimelineResult.commands.every((entry) => !entry.command.includes('record-review-result')));
    });

    it('authenticates ordinary provider failures for both launch-input modes and rejects tampered input evidence', () => {
        for (const launchInputMode of ['copy_paste_prompt', 'launch_artifact_path'] as const) {
            const repoRoot = makeTempRepo();
            seedStartedTask(repoRoot, TASK_ID);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
            seedCompilePass(repoRoot, TASK_ID);
            writeReviewEvidence(repoRoot, TASK_ID, 'code');
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
            const launchArtifact = JSON.parse(
                fs.readFileSync(launchArtifactPath, 'utf8')
            ) as Record<string, unknown>;
            launchArtifact.evidence_type = 'delegated_reviewer_launch_preparation';
            launchArtifact.attestation_state = 'launch_failed';
            launchArtifact.launch_failure_stage = 'provider_invocation';
            launchArtifact.launch_failure_reason = 'Provider rejected delegated reviewer invocation.';
            if (launchInputMode === 'launch_artifact_path') {
                const launchInputArtifactPath = String(
                    launchArtifact.reviewer_launch_input_artifact_path || ''
                );
                const launchInputArtifactSha256 = String(
                    launchArtifact.reviewer_launch_input_artifact_sha256 || ''
                );
                launchArtifact.launch_input_mode = launchInputMode;
                launchArtifact.launch_input_sha256 = launchInputArtifactSha256;
                launchArtifact.launch_input_artifact_path = normalizeForTimeline(launchInputArtifactPath);
                launchArtifact.launch_input_artifact_sha256 = launchInputArtifactSha256;
                launchArtifact.reviewer_launch_input_artifact_path = normalizeForTimeline(launchInputArtifactPath);
                launchArtifact.reviewer_launch_input_artifact_sha256 = launchInputArtifactSha256;
                launchArtifact.prepared_reviewer_launch_artifact_sha256 = 'a'.repeat(64);
            }
            writeJson(launchArtifactPath, launchArtifact);
            appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_FAILED', 'FAIL', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer',
                reviewer_identity: 'agent:code-reviewer',
                review_context_sha256: String(launchArtifact.review_context_sha256 || ''),
                routing_event_sha256: String(launchArtifact.routing_event_sha256 || ''),
                reviewer_launch_attempt_id: String(launchArtifact.reviewer_launch_attempt_id || ''),
                provider_invocation_id: String(launchArtifact.provider_invocation_id || ''),
                delegation_started_at_utc: String(launchArtifact.delegation_started_at_utc || ''),
                launch_failure_stage: 'provider_invocation',
                provider_failure_reason: 'Provider rejected delegated reviewer invocation.'
            });
            const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
            const state = readReviewArtifactState(
                reviewsRoot(repoRoot),
                TASK_ID,
                'code',
                preflightPath,
                fileSha256(preflightPath),
                JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
                repoRoot
            );
            const evidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
                repoRoot,
                eventsRoot(repoRoot),
                TASK_ID,
                state
            );
            assert.equal(evidence.state, 'provider_failed', launchInputMode);

            if (launchInputMode === 'launch_artifact_path') {
                fs.appendFileSync(String(launchArtifact.reviewer_launch_input_artifact_path), '\n', 'utf8');
            } else {
                launchArtifact.launch_input_sha256 = '0'.repeat(64);
                writeJson(launchArtifactPath, launchArtifact);
            }
            const tamperedEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
                repoRoot,
                eventsRoot(repoRoot),
                TASK_ID,
                state
            );
            assert.equal(tamperedEvidence.state, 'missing_or_invalid', launchInputMode);
        }
    });

    it('routes fix_now findings-only review evidence to implementation remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'strict',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'fix_now',
                    low: 'fix_now'
                },
                residual_risk: 'fix_now'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code');

        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            fileSha256(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.failed, true);
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.fix_now, 1);
        assert.ok(state.violations.some((violation) => violation.includes('fix_now findings or residual risks')));

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.ok(!result.commands[0].command.includes('record-review-result'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
    });

    it('routes forbid-child closure findings to current-task remediation instead of descendant materialization', () => {
        const taskId = `${TASK_ID}-F1`;
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, taskId);
        writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            },
            reviewFollowUpTaskClosurePolicy: {
                schema_version: 1,
                eligible: true,
                configured: true,
                valid: true,
                provenance: 'per_finding',
                source_notes_sha256: 'a'.repeat(64),
                skip_low_findings: false,
                forbid_child_tasks: true,
                diagnostics: ['Frozen from explicit per_finding task metadata.']
            }
        });
        seedCompilePass(repoRoot, taskId);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, taskId, 'code');

        const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            taskId,
            'code',
            preflightPath,
            fileSha256(preflightPath),
            JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.fix_now, 1);
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.create_follow_up, 0);

        const result = resolveNextStep({ taskId, repoRoot });

        assert.equal(result.next_gate, 'implementation');
        assert.match(result.title, /Fix failed 'code' review findings/u);
        assert.doesNotMatch(result.title, /follow-up tasks/iu);
    });

    it('routes skip-low closure findings as explicitly ignored without blockers or follow-ups', () => {
        const taskId = `${TASK_ID}-F1`;
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, taskId);
        writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            },
            reviewFollowUpTaskClosurePolicy: {
                schema_version: 1,
                eligible: true,
                configured: true,
                valid: true,
                provenance: 'per_finding',
                source_notes_sha256: 'b'.repeat(64),
                skip_low_findings: true,
                forbid_child_tasks: true,
                diagnostics: ['Frozen from explicit per_finding task metadata.']
            }
        });
        seedCompilePass(repoRoot, taskId);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, taskId, 'code', {
            findingSeverity: 'low'
        });

        const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            taskId,
            'code',
            preflightPath,
            fileSha256(preflightPath),
            JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.ignore, 1);
        assert.equal(state.reviewFindingsDisposition?.blocking_count, 0);
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.create_follow_up, 0);

        const result = resolveNextStep({ taskId, repoRoot });

        assert.notEqual(result.next_gate, 'implementation');
        assert.notEqual(result.next_gate, 'materialize-review-follow-up-tasks');
        assert.equal(result.next_gate, 'build-review-context');
        assert.equal(result.review.next_review_type, 'security');
    });

    it('routes accepted create_follow_up dispositions to follow-up task materialization before downstream reviews', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code');

        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            fileSha256(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.contextCurrent, true, state.violations.join('\n'));
        assert.equal(
            state.reviewFindingsDisposition?.counts_by_action.create_follow_up,
            1,
            JSON.stringify(state.reviewFindingsDisposition)
        );
        assert.equal(state.ready, true, state.violations.join('\n'));
        assert.equal(state.reviewFindingsFollowUpSatisfied, false);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'materialize-review-follow-up-tasks', `${result.next_gate}: ${result.title} :: ${result.reason}`);
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Materialize 'code' review follow-up tasks/);
        assert.match(result.reason, /Accepted 'code' findings disposition requires 1 follow-up item/);
        assert.match(result.reason, /before downstream review, reuse, required-review, or completion decisions/);
        assert.ok(result.commands[0].command.includes('gate materialize-review-follow-up-tasks'));
        assert.ok(result.commands[0].command.includes('--disposition-artifact-path'));
        assert.ok(result.commands[0].command.includes('--receipt-path'));
        assert.ok(result.commands[0].command.includes('--artifact-path'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
    });

    it('blocks accepted deferred receipt source drift before ordinary classify-change recovery', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            },
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'post-review-source-mutation-guard', result.reason);
        assert.match(result.title, /Stop unauthorized post-review source mutation/);
        assert.match(result.reason, /domain\(s\) implementation/);
        assert.match(result.reason, /Do not normalize these changes through classify-change/);
        assert.deepEqual(result.commands, []);
    });

    it('defers grouped follow-up materialization until every required review lane is satisfied', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            },
            reviewFollowUpPolicy: {
                schema_version: 1,
                materialization_mode: 'grouped_by_parent'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code');

        const beforeFinalLane = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(beforeFinalLane.next_gate, 'materialize-review-follow-up-tasks');
        assert.equal(
            beforeFinalLane.next_gate,
            'build-review-context',
            `${beforeFinalLane.next_gate}: ${beforeFinalLane.title} :: ${beforeFinalLane.reason}`
        );
        assert.equal(beforeFinalLane.review.next_review_type, 'security');

        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        const afterFinalLane = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(afterFinalLane.status, 'BLOCKED');
        assert.equal(
            afterFinalLane.next_gate,
            'materialize-review-follow-up-tasks',
            `${afterFinalLane.next_gate}: ${afterFinalLane.title} :: ${afterFinalLane.reason}`
        );
        assert.match(afterFinalLane.reason, /All currently required review lanes are complete/);
    });

    it('continues to downstream reviews after valid materialized follow-up tasks satisfy accepted dispositions', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code');
        const receipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const dispositionArtifact = receipt.review_findings_disposition_artifact as Record<string, unknown>;

        const materialized = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'code',
            dispositionArtifactPath: String(dispositionArtifact.artifact_path),
            receiptPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`)
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.deepEqual(materialized.created_task_ids, [`${TASK_ID}-F1`]);
        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            fileSha256(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.contextCurrent, true, state.violations.join('\n'));
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.create_follow_up, 1);
        assert.equal(state.reviewFindingsFollowUpSatisfied, true, state.violations.join('\n'));
        assert.equal(state.ready, true, state.violations.join('\n'));

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'materialize-review-follow-up-tasks');
        assert.equal(result.next_gate, 'build-review-context', `${result.next_gate}: ${result.title} :: ${result.reason}`);
        assert.equal(result.review.next_review_type, 'security');
        assert.match(result.title, /Prepare 'security' review context/);
    });

    it('reads TASK.md once per next-step evaluation across review lanes with multiple follow-up fingerprints', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code', { followUpFindingCount: 3 });
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'security', { followUpFindingCount: 2 });
        const materializedByLane = (['code', 'security'] as const).map((reviewType) => {
            const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
            const dispositionArtifact = receipt.review_findings_disposition_artifact as Record<string, unknown>;
            return materializeReviewFindingsFollowUpTasks({
                repoRoot,
                taskId: TASK_ID,
                reviewType,
                dispositionArtifactPath: String(dispositionArtifact.artifact_path),
                receiptPath
            });
        });

        assert.equal(materializedByLane[0].status, 'MATERIALIZED', materializedByLane[0].output_lines.join('\n'));
        assert.deepEqual(materializedByLane[0].created_task_ids, [`${TASK_ID}-F1`, `${TASK_ID}-F2`, `${TASK_ID}-F3`]);
        assert.equal(materializedByLane[1].status, 'MATERIALIZED', materializedByLane[1].output_lines.join('\n'));
        assert.deepEqual(materializedByLane[1].created_task_ids, [`${TASK_ID}-F4`, `${TASK_ID}-F5`]);
        const taskPath = path.join(repoRoot, 'TASK.md');
        const mutableFs = nodeRequire('node:fs') as typeof fs;
        const originalReadFileSync = mutableFs.readFileSync;
        let taskReads = 0;
        mutableFs.readFileSync = ((file: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
            if (typeof file === 'string' && path.resolve(file) === path.resolve(taskPath)) {
                taskReads += 1;
            }
            return originalReadFileSync(file as never, ...(args as never[]));
        }) as typeof fs.readFileSync;
        try {
            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.notEqual(result.next_gate, 'materialize-review-follow-up-tasks');
            assert.notEqual(result.status, 'FAILED', `${result.next_gate}: ${result.title} :: ${result.reason}`);
        } finally {
            mutableFs.readFileSync = originalReadFileSync;
        }
        assert.equal(taskReads, 1);
    });

    it('rejects stale materialized follow-up artifacts without current TASK.md fingerprint rows', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code');
        const receipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const dispositionArtifact = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        const dispositionPath = String(dispositionArtifact.artifact_path);
        const dispositionSha256 = String(dispositionArtifact.artifact_sha256);
        writeJson(dispositionPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json'), {
            schema_version: 1,
            artifact_type: 'review_findings_follow_up_tasks',
            task_id: TASK_ID,
            review_type: 'code',
            status: 'MATERIALIZED',
            created_at_utc: '2026-07-15T00:00:00.000Z',
            source_disposition: {
                artifact_path: dispositionPath,
                artifact_sha256: dispositionSha256,
                disposition_result_sha256: null
            },
            source_validation: {
                artifact_path: null,
                artifact_sha256: null,
                validation_result_sha256: null,
                status: 'accepted',
                accepted: true
            },
            source_receipt: {
                receipt_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`),
                receipt_sha256: null
            },
            items: [{
                source_item_id: 'F-001',
                source_item_kind: 'finding',
                severity: 'medium',
                action: 'create_follow_up',
                source_rule: 'review_finding_policy.findings.medium',
                source_policy: 'balanced',
                blocking: false,
                fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                materialization_status: 'created',
                task_id: `${TASK_ID}-F1`,
                title: 'Stale follow-up row',
                description: 'The artifact claims a row exists but TASK.md does not contain its fingerprint.',
                evidence_locations: ['src/app.ts:1'],
                remediation: 'Keep TASK.md follow-up rows current.'
            }],
            summary: {
                item_count: 1,
                follow_up_obligation_count: 1,
                created_task_count: 1,
                reused_task_count: 0,
                blocked_task_count: 0,
                not_required_count: 0
            },
            violations: []
        });

        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            fileSha256(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.reviewFindingsFollowUpSatisfied, false);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'materialize-review-follow-up-tasks', `${result.next_gate}: ${result.title} :: ${result.reason}`);
        assert.equal(result.review.next_review_type, 'code');
    });

    it('rejects materialized follow-up artifacts that point to unrelated task rows', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code');
        const receipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const dispositionArtifact = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        const dispositionPath = String(dispositionArtifact.artifact_path);
        const dispositionSha256 = String(dispositionArtifact.artifact_sha256);
        const fingerprint = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                /\n$/u,
                `| T-OTHER-F1 | TODO | P2 | workflow | Unrelated follow-up | gpt-5.5 | 2026-07-15 | balanced | review_follow_up_fingerprint=${fingerprint}. |\n`
            ),
            'utf8'
        );
        writeJson(dispositionPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json'), {
            schema_version: 1,
            artifact_type: 'review_findings_follow_up_tasks',
            task_id: TASK_ID,
            review_type: 'code',
            status: 'MATERIALIZED',
            created_at_utc: '2026-07-15T00:00:00.000Z',
            source_disposition: {
                artifact_path: dispositionPath,
                artifact_sha256: dispositionSha256,
                disposition_result_sha256: null
            },
            source_validation: {
                artifact_path: null,
                artifact_sha256: null,
                validation_result_sha256: null,
                status: 'accepted',
                accepted: true
            },
            source_receipt: {
                receipt_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`),
                receipt_sha256: null
            },
            items: [{
                source_item_id: 'F-001',
                source_item_kind: 'finding',
                severity: 'medium',
                action: 'create_follow_up',
                source_rule: 'review_finding_policy.findings.medium',
                source_policy: 'balanced',
                blocking: false,
                fingerprint,
                materialization_status: 'already_materialized',
                task_id: 'T-OTHER-F1',
                title: 'Unrelated follow-up row',
                description: 'The artifact points at another task family.',
                evidence_locations: ['src/app.ts:1'],
                remediation: 'Require parent-derived follow-up task ids.'
            }],
            summary: {
                item_count: 1,
                follow_up_obligation_count: 1,
                created_task_count: 0,
                reused_task_count: 1,
                blocked_task_count: 0,
                not_required_count: 0
            },
            violations: []
        });

        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            fileSha256(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.reviewFindingsFollowUpSatisfied, false);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'materialize-review-follow-up-tasks', `${result.next_gate}: ${result.title} :: ${result.reason}`);
        assert.equal(result.review.next_review_type, 'code');
    });

    it('rejects materialized follow-up artifacts whose fingerprint is not derived from the current disposition item', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code');
        const receipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const dispositionArtifact = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        const dispositionPath = String(dispositionArtifact.artifact_path);
        const dispositionSha256 = String(dispositionArtifact.artifact_sha256);
        const forgedFingerprint = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                /\n$/u,
                `| ${TASK_ID}-F1 | TODO | P2 | workflow | Forged follow-up fingerprint | gpt-5.5 | 2026-07-15 | balanced | review_follow_up_fingerprint=${forgedFingerprint}. |\n`
            ),
            'utf8'
        );
        writeJson(dispositionPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json'), {
            schema_version: 1,
            artifact_type: 'review_findings_follow_up_tasks',
            task_id: TASK_ID,
            review_type: 'code',
            status: 'MATERIALIZED',
            created_at_utc: '2026-07-15T00:00:00.000Z',
            source_disposition: {
                artifact_path: dispositionPath,
                artifact_sha256: dispositionSha256,
                disposition_result_sha256: null
            },
            source_validation: {
                artifact_path: null,
                artifact_sha256: null,
                validation_result_sha256: null,
                status: 'accepted',
                accepted: true
            },
            source_receipt: {
                receipt_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`),
                receipt_sha256: null
            },
            items: [{
                source_item_id: 'F-001',
                source_item_kind: 'finding',
                severity: 'medium',
                action: 'create_follow_up',
                source_rule: 'review_finding_policy.findings.medium',
                source_policy: 'balanced',
                blocking: false,
                fingerprint: forgedFingerprint,
                materialization_status: 'created',
                task_id: `${TASK_ID}-F1`,
                title: 'Forged follow-up fingerprint',
                description: 'The TASK row and artifact agree with each other but not with the disposition-derived fingerprint.',
                evidence_locations: ['src/app.ts:1'],
                remediation: 'Bind follow-up satisfaction to the current disposition item fingerprint.'
            }],
            summary: {
                item_count: 1,
                follow_up_obligation_count: 1,
                created_task_count: 1,
                reused_task_count: 0,
                blocked_task_count: 0,
                not_required_count: 0
            },
            violations: []
        });

        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            fileSha256(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.create_follow_up, 1);
        assert.equal(state.reviewFindingsFollowUpSatisfied, false);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'materialize-review-follow-up-tasks', `${result.next_gate}: ${result.title} :: ${result.reason}`);
        assert.equal(result.review.next_review_type, 'code');
    });

    it('rejects incomplete materialized follow-up artifacts that omit accepted follow-up obligations', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code', { followUpFindingCount: 2 });
        const receipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const dispositionArtifact = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        const dispositionPath = String(dispositionArtifact.artifact_path);
        const dispositionSha256 = String(dispositionArtifact.artifact_sha256);
        const fingerprint = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                /\n$/u,
                `| ${TASK_ID}-F1 | TODO | P2 | workflow | Materialized one follow-up | gpt-5.5 | 2026-07-15 | balanced | review_follow_up_fingerprint=${fingerprint}. |\n`
            ),
            'utf8'
        );
        writeJson(dispositionPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json'), {
            schema_version: 1,
            artifact_type: 'review_findings_follow_up_tasks',
            task_id: TASK_ID,
            review_type: 'code',
            status: 'MATERIALIZED',
            created_at_utc: '2026-07-15T00:00:00.000Z',
            source_disposition: {
                artifact_path: dispositionPath,
                artifact_sha256: dispositionSha256,
                disposition_result_sha256: null
            },
            source_validation: {
                artifact_path: null,
                artifact_sha256: null,
                validation_result_sha256: null,
                status: 'accepted',
                accepted: true
            },
            source_receipt: {
                receipt_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`),
                receipt_sha256: null
            },
            items: [{
                source_item_id: 'F-001',
                source_item_kind: 'finding',
                severity: 'medium',
                action: 'create_follow_up',
                source_rule: 'review_finding_policy.findings.medium',
                source_policy: 'balanced',
                blocking: false,
                fingerprint,
                materialization_status: 'created',
                task_id: `${TASK_ID}-F1`,
                title: 'Materialized one follow-up row',
                description: 'The artifact omits the second accepted follow-up obligation.',
                evidence_locations: ['src/app.ts:1'],
                remediation: 'Keep TASK.md follow-up rows current.'
            }],
            summary: {
                item_count: 1,
                follow_up_obligation_count: 1,
                created_task_count: 1,
                reused_task_count: 0,
                blocked_task_count: 0,
                not_required_count: 0
            },
            violations: []
        });

        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            fileSha256(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.create_follow_up, 2);
        assert.equal(state.reviewFindingsFollowUpSatisfied, false);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'materialize-review-follow-up-tasks', `${result.next_gate}: ${result.title} :: ${result.reason}`);
        assert.equal(result.review.next_review_type, 'code');
    });

    it('rejects duplicated materialized follow-up items that reuse one task row for multiple obligations', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, {
            reviewFindingPolicy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeAcceptedFindingsDispositionReviewEvidence(repoRoot, TASK_ID, 'code', { followUpFindingCount: 2 });
        const receipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const dispositionArtifact = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        const dispositionPath = String(dispositionArtifact.artifact_path);
        const dispositionSha256 = String(dispositionArtifact.artifact_sha256);
        const fingerprint = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                /\n$/u,
                `| ${TASK_ID}-F1 | TODO | P2 | workflow | Materialized duplicated follow-up | gpt-5.5 | 2026-07-15 | balanced | review_follow_up_fingerprint=${fingerprint}. |\n`
            ),
            'utf8'
        );
        const duplicatedFollowUp = {
            source_item_id: 'F-001',
            source_item_kind: 'finding',
            severity: 'medium',
            action: 'create_follow_up',
            source_rule: 'review_finding_policy.findings.medium',
            source_policy: 'balanced',
            blocking: false,
            fingerprint,
            materialization_status: 'created',
            task_id: `${TASK_ID}-F1`,
            title: 'Duplicated follow-up row',
            description: 'The artifact duplicates one follow-up row for multiple obligations.',
            evidence_locations: ['src/app.ts:1'],
            remediation: 'Keep TASK.md follow-up rows current.'
        };
        writeJson(dispositionPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json'), {
            schema_version: 1,
            artifact_type: 'review_findings_follow_up_tasks',
            task_id: TASK_ID,
            review_type: 'code',
            status: 'MATERIALIZED',
            created_at_utc: '2026-07-15T00:00:00.000Z',
            source_disposition: {
                artifact_path: dispositionPath,
                artifact_sha256: dispositionSha256,
                disposition_result_sha256: null
            },
            source_validation: {
                artifact_path: null,
                artifact_sha256: null,
                validation_result_sha256: null,
                status: 'accepted',
                accepted: true
            },
            source_receipt: {
                receipt_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`),
                receipt_sha256: null
            },
            items: [
                duplicatedFollowUp,
                duplicatedFollowUp
            ],
            summary: {
                item_count: 2,
                follow_up_obligation_count: 2,
                created_task_count: 2,
                reused_task_count: 0,
                blocked_task_count: 0,
                not_required_count: 0
            },
            violations: []
        });

        const state = readReviewArtifactState(
            reviewsRoot(repoRoot),
            TASK_ID,
            'code',
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            fileSha256(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>,
            repoRoot
        );
        assert.equal(state.reviewFindingsDisposition?.counts_by_action.create_follow_up, 2);
        assert.equal(state.reviewFindingsFollowUpSatisfied, false);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'materialize-review-follow-up-tasks', `${result.next_gate}: ${result.title} :: ${result.reason}`);
        assert.equal(result.review.next_review_type, 'code');
    });

    it('routes launch-package review failures to review-cycle retry without implementation changes', () => {
        const launchFailureBodies = [
            'Reviewer failed before code review because reviewer_prompt_sha256 did not match the prepared launch package.\n\n',
            'Reviewer failed before code review because review_context_sha256 must match the current launch package.\n\n',
            'Reviewer failed before code review because review_tree_state_sha256 mismatch invalidates launch binding.\n\n',
            'Reviewer launch artifact is not eligible for invocation attestation: launch_binding_sha256 does not match.\n\n'
        ];
        for (const body of launchFailureBodies) {
            const repoRoot = makeTempRepo();
            seedStartedTask(repoRoot, TASK_ID);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
            seedCompilePass(repoRoot, TASK_ID);
            writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail', body });

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.next_gate, 'reviewer-launch-retry');
            assert.equal(result.review.next_review_type, 'code');
            assert.match(result.title, /Retry 'code' reviewer launch package/);
            assert.match(result.reason, /Preserve the failed review artifact and receipt/);
            assert.match(result.reason, /do not make fake implementation changes/);
            assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
            assert.ok(result.commands[0].command.includes('--impact-analysis'));
            assert.ok(result.commands[0].command.includes('<replace with main-agent remediation impact analysis>'));
            assert.ok(!result.commands[0].command.includes('reviewer finding; intended fix; affected files/contracts'));
            assert.ok(!result.commands[0].command.includes('record-review-result'));
            assert.ok(!result.commands[0].command.includes('compile-gate'));
        }
    });

    it('routes evidence-only missing manual-validation failures to evidence refresh without implementation changes', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test', {
            verdict: 'fail',
            body:
                'Reviewer could not validate the task because existing runtime/manual-validation/T-089 Gradle test and check logs were omitted from the handoff evidence. ' +
                'The implementation diff itself was not reviewed as defective; refresh attached validation evidence and relaunch review.\n\n'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-evidence-refresh');
        assert.equal(result.review.next_review_type, 'test');
        assert.match(result.title, /Refresh 'test' review evidence attachments/);
        assert.match(result.reason, /missing attached validation evidence/);
        assert.match(result.reason, /do not make fake implementation changes/);
        assert.match(result.reason, /manual-validation evidence selector/);
        assert.match(result.reason, /garda-agent-orchestrator\/runtime\/manual-validation\/T-NEXT-1\/review-evidence\.json/);
        assert.match(result.reason, /selected_logs entries/);
        assert.match(result.reason, /path, command, and exit_code or status/);
        assert.match(result.reason, /review_types to \['test'\]/);
        assert.match(result.reason, /Do not add task-scoped runtime\/manual-validation files to preflight --changed-file scope/);
        assert.equal(result.commands[0].label, 'Restart review cycle after manual-validation evidence refresh');
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
        assert.ok(result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('runtime/manual-validation'));
        assert.ok(!result.commands[0].command.includes('--changed-file'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
    });

    it('restarts a failed code review after a bound focused intermediate test passes for supported severity forms', async () => {
        const focusedFinding = '[garda:evidence-only:missing-focused-validation] test=tests/node/gates/focused-evidence.test.ts; action=run-and-record-focused-test';
        for (const finding of [
            `- Medium: ${focusedFinding}`,
            `Medium:\n- ${focusedFinding}`,
            `### Medium\n- ${focusedFinding}`
        ]) {
            const repoRoot = makeTempRepo();
            seedStartedTask(repoRoot, TASK_ID);
            seedRunnableFocusedIntermediateCommand(repoRoot);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
                changedFiles: ['tests/node/gates/focused-evidence.test.ts']
            });
            seedCompilePass(repoRoot, TASK_ID, undefined, ['tests/node/gates/focused-evidence.test.ts']);
            writeReviewEvidence(repoRoot, TASK_ID, 'code', {
                verdict: 'fail',
                body: [
                    '## Findings by Severity',
                    finding,
                    '',
                    '## Deferred Findings',
                    'None',
                    ''
                ].join('\n')
            });
            const commandResult = await runIntermediateCommandCommand({
                repoRoot,
                taskId: TASK_ID,
                commandSource: 'targeted-test',
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-evidence.test.ts',
                preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
                coverageContractSha256: currentReviewCoverageContractSha256(repoRoot),
                timeoutMs: FOCUSED_COMMAND_TIMEOUT_MS
            });
            assert.equal(commandResult.exitCode, 0);

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
            assert.match(result.title, /focused validation evidence/);
            assert.match(result.reason, /intermediate-command-targeted-test-[a-f0-9]{12}\.json/);
            assert.match(result.reason, /do not make fake implementation changes/);
            assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
            assert.ok(!result.commands[0].command.includes('--changed-file'));
        }
    });

    it('restarts a failed code review when the required focused test is not in changed files', async () => {
        const repoRoot = makeTempRepo();
        const requiredTestPath = 'tests/node/gates/focused-evidence.test.ts';
        const focusedFinding = `[garda:evidence-only:missing-focused-validation] test=${requiredTestPath}; action=run-and-record-focused-test`;
        seedStartedTask(repoRoot, TASK_ID);
        seedRunnableFocusedIntermediateCommand(repoRoot, { markTestChanged: false });
        fs.writeFileSync(path.join(repoRoot, 'src', 'focused-remediation.ts'), 'export const focusedRemediation = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/focused-remediation.ts']
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['src/focused-remediation.ts']);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                `- Medium: ${focusedFinding}`,
                '',
                '## Deferred Findings',
                'None',
                ''
            ].join('\n')
        });
        const commandResult = await runIntermediateCommandCommand({
            repoRoot,
            taskId: TASK_ID,
            commandSource: 'targeted-test',
            command: `node scripts/node-foundation/build-scripts.cjs test.js ${requiredTestPath}`,
            preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            coverageContractSha256: currentReviewCoverageContractSha256(repoRoot),
            timeoutMs: FOCUSED_COMMAND_TIMEOUT_MS
        });
        assert.equal(commandResult.exitCode, 0);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.match(result.reason, /focused validation evidence/);
        assert.match(result.reason, new RegExp(requiredTestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('proceeds to required reviews when findings-only JSON contains only evidence-only F-000', async () => {
        for (const markerField of ['title', 'description'] as const) {
            const repoRoot = makeTempRepo();
            const requiredTestPath = 'tests/node/gates/focused-evidence.test.ts';
            seedStartedTask(repoRoot, TASK_ID);
            seedRunnableFocusedIntermediateCommand(repoRoot);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
                changedFiles: [requiredTestPath]
            });
            seedCompilePass(repoRoot, TASK_ID, '2026-04-28T00:00:20.000Z', [requiredTestPath]);
            writeJsonFocusedValidationReviewEvidence(repoRoot, TASK_ID, 'code', requiredTestPath, { markerField });

            const commandResult = await runIntermediateCommandCommand({
                repoRoot,
                taskId: TASK_ID,
                commandSource: 'targeted-test',
                command: `node scripts/node-foundation/build-scripts.cjs test.js ${requiredTestPath}`,
                preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
                coverageContractSha256: currentReviewCoverageContractSha256(repoRoot),
                timeoutMs: FOCUSED_COMMAND_TIMEOUT_MS
            });
            assert.equal(commandResult.exitCode, 0, markerField);

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'required-reviews-check', markerField + ': ' + result.reason);
            assert.match(result.reason, /review gate has not validated them/);
            assert.ok(result.commands[0].command.includes('gate required-reviews-check'));
            assert.ok(!result.commands[0].command.includes('restart-review-cycle'));
        }
    });

    it('fails closed when a severity heading does not contain a bullet finding', async () => {
        const focusedFinding = '[garda:evidence-only:missing-focused-validation] test=tests/node/gates/focused-evidence.test.ts; action=run-and-record-focused-test';
        for (const finding of [
            `### Medium\n${focusedFinding}`,
            `### Medium: ${focusedFinding}`,
            `### Medium\n- ${focusedFinding}\nAuthorization bypass remains in the implementation.`
        ]) {
            const repoRoot = makeTempRepo();
            seedStartedTask(repoRoot, TASK_ID);
            seedRunnableFocusedIntermediateCommand(repoRoot);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
                changedFiles: ['tests/node/gates/focused-evidence.test.ts']
            });
            seedCompilePass(repoRoot, TASK_ID, undefined, ['tests/node/gates/focused-evidence.test.ts']);
            writeReviewEvidence(repoRoot, TASK_ID, 'code', {
                verdict: 'fail',
                body: [
                    '## Findings by Severity',
                    finding,
                    '',
                    '## Deferred Findings',
                    'None',
                    ''
                ].join('\n')
            });
            const commandResult = await runIntermediateCommandCommand({
                repoRoot,
                taskId: TASK_ID,
                commandSource: 'targeted-test',
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-evidence.test.ts',
                preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
                coverageContractSha256: currentReviewCoverageContractSha256(repoRoot),
                timeoutMs: FOCUSED_COMMAND_TIMEOUT_MS
            });
            assert.equal(commandResult.exitCode, 0);

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'implementation', result.reason);
        }
    });

    it('restarts a failed code review after a producer-recorded npm focused test passes', async () => {
        const repoRoot = makeTempRepo();
        const focusedFinding = '[garda:evidence-only:missing-focused-validation] test=tests/node/gates/focused-evidence.test.ts; action=run-and-record-focused-test';
        seedStartedTask(repoRoot, TASK_ID);
        seedRunnableFocusedIntermediateCommand(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['tests/node/gates/focused-evidence.test.ts']
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['tests/node/gates/focused-evidence.test.ts']);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                `- Medium: ${focusedFinding}`,
                '',
                '## Deferred Findings',
                'None',
                ''
            ].join('\n')
        });

        const commandResult = await runIntermediateCommandCommand({
            repoRoot,
            taskId: TASK_ID,
            commandSource: 'targeted-test',
            command: 'npm test -- tests/node/gates/focused-evidence.test.ts',
            preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            coverageContractSha256: currentReviewCoverageContractSha256(repoRoot),
            timeoutMs: FOCUSED_COMMAND_TIMEOUT_MS
        });
        assert.equal(commandResult.exitCode, 0);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.match(result.reason, /intermediate-command-targeted-test-[a-f0-9]{12}\.json/);
    });

    it('restarts after producer-recorded focused evidence uses caller-designated in-root paths', async () => {
        const repoRoot = makeTempRepo();
        const focusedFinding = '[garda:evidence-only:missing-focused-validation] test=tests/node/gates/focused-evidence.test.ts; action=run-and-record-focused-test';
        const customEvidenceRoot = path.join(reviewsRoot(repoRoot), 'custom-focused-evidence');
        seedStartedTask(repoRoot, TASK_ID);
        seedRunnableFocusedIntermediateCommand(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['tests/node/gates/focused-evidence.test.ts']
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['tests/node/gates/focused-evidence.test.ts']);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                `- Medium: ${focusedFinding}`,
                '',
                '## Deferred Findings',
                'None',
                ''
            ].join('\n')
        });

        const commandResult = await runIntermediateCommandCommand({
            repoRoot,
            taskId: TASK_ID,
            commandSource: 'targeted-test',
            command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-evidence.test.ts',
            artifactPath: path.join(customEvidenceRoot, 'focused-command.json'),
            outputPath: path.join(customEvidenceRoot, 'focused-command.log'),
            preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            coverageContractSha256: currentReviewCoverageContractSha256(repoRoot),
            timeoutMs: FOCUSED_COMMAND_TIMEOUT_MS
        });
        assert.equal(commandResult.exitCode, 0);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.match(result.reason, /custom-focused-evidence\/focused-command\.json/);
    });

    it('fails closed for stale, forged, foreign, failed, external, and scope-mismatched focused intermediate evidence', () => {
        const scenarios: Array<{
            name: string;
            configureEvidence?: (repoRoot: string) => void;
            mutateScope?: (repoRoot: string) => void;
        }> = [
            {
                name: 'forged hash',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    artifactHash: '0'.repeat(64)
                })
            },
            {
                name: 'foreign task record',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    recordTaskId: 'T-FOREIGN'
                })
            },
            {
                name: 'mutated output artifact',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    mutateOutputArtifactAfterRecord: true
                })
            },
            {
                name: 'event output hash mismatch',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    eventOutputArtifactHash: '0'.repeat(64)
                })
            },
            {
                name: 'failed record',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    eventOutcome: 'FAILED',
                    exitCode: 1,
                    recordStatus: 'FAILED'
                })
            },
            {
                name: 'typecheck command that only names the focused test',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    commandSource: 'typecheck',
                    command: 'npm run typecheck -- tests/node/gates/focused-evidence.test.ts'
                })
            },
            {
                name: 'validation command that only names the focused test',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    commandSource: 'validation',
                    command: 'npm run validate -- tests/node/gates/focused-evidence.test.ts'
                })
            },
            {
                name: 'external artifact path',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    eventArtifactPath: path.join(repoRoot, '..', 'focused-evidence.json')
                })
            },
            {
                name: 'stale event',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    timestampUtc: '2026-04-28T00:00:20.000Z'
                })
            },
            {
                name: 'unbound preflight and coverage binding',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    includeCurrentBindings: false
                })
            },
            {
                name: 'required focused test mismatch',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/other-scope.test.ts'
                })
            },
            {
                name: 'test path prefix collision',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-evidence.test.tsx'
                })
            },
            {
                name: 'targeted-test direct node test command',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    command: 'node --test tests/node/gates/focused-evidence.test.ts'
                })
            },
            {
                name: 'node-test node-foundation wrapper command',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    commandSource: 'node-test',
                    command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-evidence.test.ts'
                })
            },
            {
                name: 'whitespace-padded npm focused test path',
                configureEvidence: (repoRoot) => writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
                    command: 'npm test -- " tests/node/gates/focused-evidence.test.ts "'
                })
            }
        ];

        for (const scenario of scenarios) {
            const repoRoot = makeTempRepo();
            seedStartedTask(repoRoot, TASK_ID);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
                changedFiles: ['tests/node/gates/focused-evidence.test.ts']
            });
            seedCompilePass(repoRoot, TASK_ID, undefined, ['tests/node/gates/focused-evidence.test.ts']);
            writeReviewEvidence(repoRoot, TASK_ID, 'code', {
                verdict: 'fail',
                body: [
                    '## Findings by Severity',
                    '- Medium: [garda:evidence-only:missing-focused-validation] test=tests/node/gates/focused-evidence.test.ts; action=run-and-record-focused-test',
                    '',
                    '## Deferred Findings',
                    'None',
                    ''
                ].join('\n')
            });
            scenario.configureEvidence?.(repoRoot);
            scenario.mutateScope?.(repoRoot);

            const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
            const receipt = JSON.parse(
                fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`), 'utf8')
            ) as {
                review_result_recorded_at_utc?: string;
                reviewer_provenance?: { task_sequence?: number };
            };
            const evidence = readPostReviewFocusedIntermediateEvidence({
                repoRoot,
                reviewsRoot: reviewsRoot(repoRoot),
                eventsRoot: eventsRoot(repoRoot),
                taskId: TASK_ID,
                reviewType: 'code',
                reviewArtifactPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`),
                reviewResultRecordedAtUtc: receipt.review_result_recorded_at_utc ?? null,
                reviewerProvenanceTaskSequence: receipt.reviewer_provenance?.task_sequence ?? null,
                changedFiles: ['tests/node/gates/focused-evidence.test.ts'],
                expectedPreflightPath: preflightPath,
                expectedPreflightSha256: fileSha256(preflightPath),
                expectedCoverageContractSha256: currentReviewCoverageContractSha256(repoRoot)
            });

            assert.equal(evidence.available, false, scenario.name + ': invalid evidence was accepted');
            if (scenario.name === 'forged hash') {
                const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
                assert.notEqual(result.next_gate, 'restart-review-cycle', scenario.name + ': ' + result.reason);
            }
        }
    });

    it('fails closed when a focused-evidence marker contains an additional implementation defect', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const focusedTestPath = path.join(repoRoot, 'tests', 'node', 'gates', 'focused-evidence.test.ts');
        fs.mkdirSync(path.dirname(focusedTestPath), { recursive: true });
        fs.writeFileSync(focusedTestPath, 'export {};\n// Focused evidence fixture change.\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['tests/node/gates/focused-evidence.test.ts']
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['tests/node/gates/focused-evidence.test.ts']);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                '- Medium: [garda:evidence-only:missing-focused-validation] test=tests/node/gates/focused-evidence.test.ts; action=run-and-record-focused-test; implementation is flaky and times out under load.',
                '',
                '## Deferred Findings',
                'None',
                ''
            ].join('\n')
        });
        writeFocusedIntermediateEvidence(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'implementation', result.reason);
    });

    it('does not let a different changed test mentioned outside the failed finding restart review', () => {
        const repoRoot = makeTempRepo();
        const requiredTestPath = 'tests/node/gates/focused-evidence.test.ts';
        const unrelatedTestPath = 'tests/node/gates/other-focused-evidence.test.ts';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: [requiredTestPath, unrelatedTestPath]
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, [requiredTestPath, unrelatedTestPath]);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                `- Medium: [garda:evidence-only:missing-focused-validation] test=${requiredTestPath}; action=run-and-record-focused-test`,
                '',
                '## Validation Notes',
                `${unrelatedTestPath} was mentioned only as unrelated validation context.`,
                '',
                '## Deferred Findings',
                'None',
                ''
            ].join('\n')
        });
        writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
            command: `node scripts/node-foundation/build-scripts.cjs test.js ${unrelatedTestPath}`
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'restart-review-cycle', result.reason);
    });

    it('does not substitute an incidental changed-test reference for the test named by the focused marker', () => {
        const repoRoot = makeTempRepo();
        const changedTestPath = 'tests/node/gates/focused-evidence.test.ts';
        const foreignTestPath = 'tests/node/gates/foreign-focused-evidence.test.ts';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: [changedTestPath]
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, [changedTestPath]);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                `- Medium: [garda:evidence-only:missing-focused-validation] test=${foreignTestPath}; action=run-and-record-focused-test`,
                `<!-- unrelated changed test: ${changedTestPath} -->`,
                '',
                '## Deferred Findings',
                'None',
                ''
            ].join('\n')
        });
        writeFocusedIntermediateEvidence(repoRoot, TASK_ID, {
            command: `node scripts/node-foundation/build-scripts.cjs test.js ${changedTestPath}`
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'restart-review-cycle', result.reason);
    });

    it('routes evidence-only stale validation failures to compile refresh instead of implementation self-loop', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                '- High: The only blocker is stale full-suite validation evidence that no longer matches the current preflight.',
                '',
                '## Validation Notes',
                'No implementation defects were found; compile-gate and full-suite validation evidence must be fresh before meaningful code review can pass.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Refresh validation evidence for 'code' review/);
        assert.match(result.reason, /stale compile\/full-suite validation evidence/);
        assert.match(result.reason, /do not make fake implementation changes/);
        assert.match(result.reason, /configured full-suite validation/);
        assert.equal(result.commands[0].label, 'Run compile gate to refresh validation evidence');
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
        assert.ok(!result.commands[0].command.includes('gate next-step'));
    });

    it('routes reverse-order stale validation failures to compile refresh', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                '- High: The only blocker is that compile-gate evidence is stale and validation logs do not match the current preflight.',
                '',
                '## Validation Notes',
                'No implementation defects were found; refresh validation evidence before relaunching code review.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.reason, /stale compile\/full-suite validation evidence/);
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
    });

    it('routes template-shaped evidence-only validation failures to evidence refresh', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test', {
            verdict: 'fail',
            body: [
                '## Validation Notes',
                'Reviewer could not find attached runtime/manual-validation logs for this task.',
                '',
                '## Findings by Severity',
                'None.',
                '',
                '## Deferred Findings',
                'None.',
                '',
                '## Residual Risks',
                'Manual validation evidence must be attached before a meaningful test review.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-evidence-refresh');
        assert.equal(result.review.next_review_type, 'test');
        assert.match(result.reason, /missing attached validation evidence/);
    });

    it('routes evidence-only validation failures that use generic defect wording with empty findings', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test', {
            verdict: 'fail',
            body: [
                '## Validation Notes',
                'The only defect is missing runtime/manual-validation logs in the reviewer handoff.',
                '',
                '## Findings by Severity',
                'None.',
                '',
                '## Deferred Findings',
                'None.',
                '',
                '## Residual Risks',
                'Manual validation evidence must be attached before a meaningful test review.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-evidence-refresh');
        assert.equal(result.review.next_review_type, 'test');
        assert.match(result.reason, /missing attached validation evidence/);
    });

    it('routes findings-section-only missing manual-validation failures to evidence refresh', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test', {
            verdict: 'fail',
            body: [
                '## Validation Notes',
                'Review cannot be completed until manual validation logs are available.',
                '',
                '## Findings by Severity',
                'Medium: missing runtime/manual-validation logs in the reviewer handoff.',
                '',
                '## Deferred Findings',
                'None.',
                '',
                '## Residual Risks',
                'None.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-evidence-refresh');
        assert.equal(result.review.next_review_type, 'test');
        assert.match(result.reason, /missing attached validation evidence/);
    });

    it('routes missing manual-validation finding lines with benign no-other-findings wording to evidence refresh', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test', {
            verdict: 'fail',
            body: [
                '## Validation Notes',
                'Review cannot be completed until manual validation logs are available.',
                '',
                '## Findings by Severity',
                'Medium: missing runtime/manual-validation logs in the reviewer handoff; no other findings.',
                '',
                '## Deferred Findings',
                'None.',
                '',
                '## Residual Risks',
                'None.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-evidence-refresh');
        assert.equal(result.review.next_review_type, 'test');
        assert.match(result.reason, /missing attached validation evidence/);
    });

    it('keeps real review findings that mention missing manual-validation evidence on implementation remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                '- High: The failed-review classifier misroutes real implementation defects into review-evidence-refresh when missing manual-validation evidence is mentioned.',
                '',
                '## Evidence',
                'The handoff also omitted runtime/manual-validation logs, but the implementation finding above is blocking.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.match(result.reason, /Fix the findings/);
        assert.ok(!result.commands[0].command.includes('review-evidence-refresh'));
    });

    it('keeps real implementation defects that mention stale validation evidence on implementation remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                '- High: The retry route can accept stale full-suite validation evidence after a current preflight, which is a real implementation defect.',
                '',
                '## Evidence',
                'The validation evidence is stale, but the blocking issue is the incorrect route implementation.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.ok(!result.commands[0].command.includes('compile-gate'));
    });

    it('keeps mixed stale-validation and authorization findings on implementation remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'security', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                '- High: Stale full-suite validation evidence was present, and the route can expose unauthorized token handling by skipping implementation remediation.',
                '',
                '## Evidence',
                'Access control, credential, and token handling must stay on the implementation path when mentioned as a blocking security finding.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'security');
        assert.match(result.title, /Fix failed 'security' review findings/);
        assert.ok(!result.commands[0].command.includes('compile-gate'));
    });

    it('keeps mixed stale-validation and exploit-class findings on implementation remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'security', {
            verdict: 'fail',
            body: [
                '## Findings by Severity',
                '- High: Stale full-suite validation evidence was present, and this route can hide SQL injection remediation behind compile-gate refresh.',
                '',
                '## Evidence',
                'Exploit-class vulnerabilities such as injection, XSS, SSRF, path traversal, and RCE must stay on implementation remediation.',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'security');
        assert.match(result.title, /Fix failed 'security' review findings/);
        assert.ok(!result.commands[0].command.includes('compile-gate'));
    });

    it('keeps prose-only real defects that mention missing manual-validation evidence on implementation remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security', {
            verdict: 'fail',
            body:
                'The report also notes missing runtime/manual-validation logs. ' +
                'The actual defect is that selected logs are read without bounded memory controls, so a task log can exhaust process memory before review context is built.\n\n'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'security');
        assert.match(result.title, /Fix failed 'security' review findings/);
        assert.ok(!result.commands[0].command.includes('review-evidence-refresh'));
    });

    it('keeps real code-review failures on implementation remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            verdict: 'fail',
            body:
                'P1: The implementation skips input validation, binding validation accepts invalid state, ' +
                'and a receipt where review_context_sha256 does not match the current context can bypass checks.\n\n'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.match(result.reason, /Fix the findings/);
        assert.ok(!result.commands[0].command.includes('restart-review-cycle'));
    });

    it('routes T-004-2-style failed-review rework to restart-review-cycle before stale preflight refresh', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        markTaskInProgress(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'restart-review-cycle');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Restart failed 'code' review remediation cycle/);
        assert.match(result.reason, /scope_sha256=/);
        assert.match(result.reason, /Stale failed review detected: 'code'/);
        assert.match(result.reason, /cheapest valid recovery path/);
        assert.match(result.reason, /before refreshing preflight/);
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(result.commands[0].command.includes(
            '--task-intent "Make next-step output executable in tests"'
        ));
        assert.ok(!result.commands[0].command.includes('--task-intent "Seeded next-step task"'));
        assert.ok(result.commands[0].command.includes(`--preflight-path "garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json"`));
        assert.ok(result.commands[0].command.includes('--impact-analysis'));
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
        assert.ok(!result.commands[0].command.includes('gate restart-coherent-cycle'));
        assert.ok(!result.commands[0].command.includes('compile-gate'));
    });

    it('preserves current task intent when closed-review remediation requires a coherent restart', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        markTaskInProgress(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_PASSED', 'PASS');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'restart-coherent-cycle', result.reason);
        assert.ok(command.includes('gate restart-coherent-cycle'), command);
        assert.ok(command.includes("--task-intent 'Make next-step output executable in tests'"), command);
        assert.ok(!command.includes("--task-intent 'Seeded next-step task'"), command);
    });

    it('refreshes preflight before restart-review-cycle when failed-review remediation expands non-test scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        markTaskInProgress(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/app.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['src/app.ts']);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        fs.writeFileSync(path.join(repoRoot, 'src', 'extra.ts'), 'export const extra = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /expanded 'code' remediation scope/);
        assert.match(result.reason, /restart-review-cycle would fail its scope-boundary guard/);
        assert.ok(command.includes('gate classify-change'), command);
        assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        assert.ok(command.includes('--changed-file "src/extra.ts"'), command);
        assert.ok(!command.includes('gate restart-review-cycle'));
        assert.ok(!command.includes('gate build-review-context'));
        assert.ok(!command.includes('gate prepare-reviewer-launch'));
        assert.ok(!command.includes('gate record-review-routing'));
        assert.ok(!command.includes('gate required-reviews-check'));
    });

    it('includes reviewer-required docs outside planned scope in failed-review remediation refresh', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        markTaskInProgress(repoRoot, TASK_ID);
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        taskMode.planned_changed_files = ['src/app.ts'];
        writeJson(taskModePath, taskMode);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/app.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['src/app.ts']);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        const docsPath = path.join(repoRoot, 'docs', 'cli-reference.md');
        fs.mkdirSync(path.dirname(docsPath), { recursive: true });
        fs.writeFileSync(docsPath, 'Use an npm wrapper for compound full-suite commands.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.match(result.title, /expanded 'code' remediation scope/);
        assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        assert.ok(command.includes('--changed-file "docs/cli-reference.md"'), command);
    });

    it('keeps task-owned manual-validation attachments on restart-review-cycle route', () => {
        const repoRoot = makeTempRepo();
        markTaskInProgress(repoRoot, TASK_ID);
        initGitRepo(repoRoot, {
            gitignoreContent: [
                'garda-agent-orchestrator/runtime/reviews/',
                'garda-agent-orchestrator/runtime/task-events/',
                'garda-agent-orchestrator/runtime/tmp/',
                ''
            ].join('\n')
        });
        seedStartedTask(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/app.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['src/app.ts']);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        const manualValidationRoot = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'manual-validation',
            TASK_ID
        );
        fs.mkdirSync(manualValidationRoot, { recursive: true });
        fs.writeFileSync(path.join(manualValidationRoot, 'gradle-test.log'), 'BUILD SUCCESSFUL\n', 'utf8');
        fs.writeFileSync(
            path.join(manualValidationRoot, 'review-evidence.json'),
            JSON.stringify({
                task_id: TASK_ID,
                selected_logs: [{
                    path: 'gradle-test.log',
                    command: './gradlew test',
                    status: 'PASSED',
                    review_types: ['code']
                }]
            }, null, 2) + '\n',
            'utf8'
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Restart failed 'code' review remediation cycle/);
        assert.ok(command.includes('gate restart-review-cycle'), command);
        assert.ok(command.includes(`--preflight-path "garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json"`), command);
        assert.ok(!command.includes('gate classify-change'), command);
        assert.ok(!command.includes('runtime/manual-validation'), command);
        assert.ok(!command.includes('gate prepare-reviewer-launch'), command);
        assert.ok(!command.includes('gate record-review-routing'), command);
        assert.ok(!command.includes('gate required-reviews-check'), command);
    });

    it('routes T-004-3-style frontend code-review remediation to restart-review-cycle', () => {
        const repoRoot = makeTempRepo();
        const frontendPath = path.join(repoRoot, 'frontend', 'src', 'App.tsx');
        fs.mkdirSync(path.dirname(frontendPath), { recursive: true });
        fs.writeFileSync(frontendPath, 'export function App() { return <main>before</main>; }\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        markTaskInProgress(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['frontend/src/App.tsx'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['frontend/src/App.tsx']);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        fs.writeFileSync(frontendPath, 'export function App() { return <main>after</main>; }\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.reason, /Stale failed review detected: 'code'/);
        assert.match(result.reason, /avoids a standalone classify-change/);
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
    });

    it('routes T-004-3-style db migration remediation to restart-review-cycle', () => {
        const repoRoot = makeTempRepo();
        const migrationPath = path.join(repoRoot, 'db', 'migrations', '001-init.sql');
        fs.mkdirSync(path.dirname(migrationPath), { recursive: true });
        fs.writeFileSync(migrationPath, 'create table audit_log(id integer primary key);\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        markTaskInProgress(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, db: true }, {
            changedFiles: ['db/migrations/001-init.sql'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID, undefined, ['db/migrations/001-init.sql']);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'db'
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'db', { verdict: 'fail' });

        fs.writeFileSync(migrationPath, 'create table audit_log(id integer primary key, actor text not null);\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assert.equal(result.review.next_review_type, 'db');
        assert.match(result.reason, /Stale failed review detected: 'db'/);
        assert.match(result.reason, /coherent-cycle ordering/);
        assert.ok(result.commands[0].command.includes('gate restart-review-cycle'));
        assert.ok(!result.commands[0].command.includes('gate restart-coherent-cycle'));
    });

    it('routes failed-review remediation through current startup evidence before stale preflight refresh', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');

        const missingHandshake = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHandshake.next_gate, 'handshake-diagnostics', missingHandshake.reason);
        assert.match(missingHandshake.reason, /latest startup rule-pack event/);
        assert.match(missingHandshake.reason, /no HANDSHAKE_DIAGNOSTICS_RECORDED event exists after them/);
        assert.equal(missingHandshake.commands[0].command.includes('gate classify-change'), false);

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-handshake.json`), { task_id: TASK_ID, status: 'PASS' });
        appendEvent(repoRoot, TASK_ID, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        const missingShellSmoke = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingShellSmoke.next_gate, 'shell-smoke-preflight', missingShellSmoke.reason);
        assert.match(missingShellSmoke.reason, /latest HANDSHAKE_DIAGNOSTICS_RECORDED event/);
        assert.equal(missingShellSmoke.commands[0].command.includes('gate classify-change'), false);
    });

    it('does not treat non-verdict fail-token mentions as failed review verdicts', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            body: [
                '## Reviewer Notes',
                'Historical note:',
                'REVIEW FAILED',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context');
        assert.equal(result.review.next_review_type, 'test', result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "test"'));
    });
});
