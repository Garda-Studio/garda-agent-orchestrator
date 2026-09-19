import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildNextStepTaskStartGuidance } from '../../../../src/gates/next-step/next-step-task-start-guidance';

import {
    buildEventIntegrityHash,
    buildRulePackArtifact,
    buildStrictDecompositionDecisionArtifact,
    buildTaskModeArtifact,
    formatNextStepText,
    getWorkspaceSnapshot,
    resolveNextStep
} from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import {
    computeOptionalSkillSelectionFingerprint,
    computeOptionalSkillTaskTextSha256
} from '../../../../src/runtime/optional-skill-selection';
import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import {
    buildTaskProfilePolicySnapshot,
    type TaskProfilePolicySnapshot
} from '../../../../src/policy/task-profile-policy-snapshot';
import {
    rebuildIndex,
    resolveIndexPath,
    writeIndex
} from '../../../../src/gate-runtime/reviews-index';
import { buildReviewTimingAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary-review-timing-audit';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import {
    appendTaskEvent,
    readTaskTimelineJsonlEntries,
    withTaskTimelineReadSnapshot
} from '../../../../src/gate-runtime/task-events';
import { initGitRepo } from '../git-fixtures';

const TASK_ID = 'T-CONTRACT-1';
const TASK_TITLE = 'Pin next-step contract before refactor';

let tempRoots: string[] = [];

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function reviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function eventsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
}

function isReadOnlyOpen(flags: fs.OpenMode): boolean {
    if (typeof flags === 'string') {
        return flags === 'r' || flags === 'rs' || flags === 'sr';
    }
    return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
}

function captureTimelineReadOpens<T>(
    timelinePath: string,
    callback: () => T
): { result: T; readSites: string[] } {
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    const readSites: string[] = [];
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (
            path.resolve(String(targetPath)) === path.resolve(timelinePath)
            && isReadOnlyOpen(flags)
        ) {
            readSites.push(new Error().stack || 'stack unavailable');
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;
    try {
        return { result: callback(), readSites };
    } finally {
        fsModule.openSync = originalOpenSync;
    }
}

function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    details: Record<string, unknown> = {},
    timestampUtc = new Date().toISOString()
): void {
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
    const line: Record<string, unknown> = {
        task_id: taskId,
        event_type: eventType,
        outcome: 'PASS',
        actor: 'gate',
        message: eventType,
        timestamp_utc: timestampUtc,
        details,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: typeof previousIntegrity?.event_sha256 === 'string'
                ? previousIntegrity.event_sha256
                : null,
            event_sha256: null
        }
    };
    (line.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(line);
    fs.appendFileSync(timelinePath, `${JSON.stringify(line)}\n`, 'utf8');
}

function inflateTaskTimeline(repoRoot: string, taskId: string, minimumBytes: number): string {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const existingText = fs.readFileSync(timelinePath, 'utf8');
    const existingLines = existingText.split('\n').filter((line) => line.trim());
    const previousEvent = existingLines.length > 0
        ? JSON.parse(existingLines[existingLines.length - 1]) as Record<string, unknown>
        : null;
    const previousIntegrity = previousEvent?.integrity && typeof previousEvent.integrity === 'object'
        ? previousEvent.integrity as Record<string, unknown>
        : null;
    let previousHash = typeof previousIntegrity?.event_sha256 === 'string'
        ? previousIntegrity.event_sha256
        : null;
    let taskSequence = existingLines.length;
    const chunks = [existingText.endsWith('\n') ? existingText : `${existingText}\n`];
    let totalBytes = Buffer.byteLength(chunks[0], 'utf8');
    while (totalBytes < minimumBytes) {
        taskSequence += 1;
        const event: Record<string, unknown> = {
            task_id: taskId,
            event_type: 'PERFORMANCE_FIXTURE_EVENT',
            outcome: 'PASS',
            actor: 'test',
            message: 'large timeline fixture',
            timestamp_utc: new Date(1_700_000_000_000 + taskSequence).toISOString(),
            details: {
                fixture_index: taskSequence,
                padding: 'x'.repeat(2048)
            },
            integrity: {
                schema_version: 1,
                task_sequence: taskSequence,
                prev_event_sha256: previousHash,
                event_sha256: null
            }
        };
        previousHash = buildEventIntegrityHash(event);
        (event.integrity as Record<string, unknown>).event_sha256 = previousHash;
        const serialized = `${JSON.stringify(event)}\n`;
        chunks.push(serialized);
        totalBytes += Buffer.byteLength(serialized, 'utf8');
    }
    fs.writeFileSync(timelinePath, chunks.join(''), 'utf8');
    return timelinePath;
}

function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function makeContractRepo(extraTaskMdLines: string[] = []): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-contract-'));
    tempRoots.push(repoRoot);

    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });

    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
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
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | refactor/contract | ${TASK_TITLE} | gpt-5.3-codex | 2026-05-24 | strict | Contract fixture. |`,
        '',
        ...extraTaskMdLines
    ].join('\n'), 'utf8');

    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
        SourceOfTruth: 'Codex'
    });

    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), {
        version: 1,
        active_profile: 'strict',
        built_in_profiles: {
            strict: {
                description: 'Strict contract test profile',
                depth: 3,
                task_decomposition: { enabled: true },
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

    return repoRoot;
}

function seedStartedTask(repoRoot: string, taskId: string): void {
    const taskModePath = path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    const profilePolicySnapshot = buildTaskProfilePolicySnapshot(
        path.join(repoRoot, 'garda-agent-orchestrator'),
        'strict',
        {
            reviewExecutionPolicyMode: 'code_first_optional',
            reviewExecutionPolicyConfigured: true,
            fullSuiteValidationEnabled: false,
            fullSuiteValidationPlacement: 'before_test_review',
            lockTimestampUtc: '2026-01-01T00:00:00.000Z'
        }
    );
    writeJson(taskModePath, buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: TASK_TITLE,
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved',
        taskProfile: 'strict',
        profileSelectionSource: 'task_queue',
        activeProfile: 'strict',
        profileSource: 'built_in',
        runtimeActiveProfile: 'strict',
        runtimeProfileSource: 'built_in',
        profilePolicySnapshot
    }));
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED', {
        artifact_path: normalizeForTimeline(taskModePath),
        start_banner: 'Garda captures my mind',
        canonical_source_of_truth: 'Codex',
        execution_provider_source: 'explicit_provider',
        runtime_identity_status: 'resolved',
        runtime_identity_violations: [],
        profile_policy_snapshot_required: true,
        profile_policy_snapshot_hash: profilePolicySnapshot.snapshot_hash
    }, '2026-01-01T00:00:00.000Z');
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    writeJson(rulePackPath, buildRulePackArtifact({
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
        ]
    }));
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', {
        stage: 'TASK_ENTRY',
        artifact_path: normalizeForTimeline(rulePackPath)
    }, '2026-01-01T00:00:01.000Z');
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED', {}, '2026-01-01T00:00:02.000Z');
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED', {}, '2026-01-01T00:00:03.000Z');
}

function seedPostPreflightRulePack(repoRoot: string, taskId: string, preflightPath: string): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    writeJson(rulePackPath, buildRulePackArtifact({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        taskModePath: path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`),
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
    }));
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', {
        stage: 'POST_PREFLIGHT',
        preflight_path: normalizeForTimeline(preflightPath),
        artifact_path: normalizeForTimeline(rulePackPath)
    }, '2026-01-01T00:00:05.000Z');
}

function seedStrictDecompositionDecision(repoRoot: string, taskId: string): void {
    writeJson(
        path.join(reviewsRoot(repoRoot), `${taskId}-strict-decomposition-decision.json`),
        buildStrictDecompositionDecisionArtifact({
            taskId,
            decision: 'single-cycle',
            taskSummary: TASK_TITLE,
            reason: 'Optional-skill activation routing is one bounded navigator contract change.',
            scopeRisk: 'Strict profile requires an explicit single-cycle decision before lifecycle continuation.',
            expectedReviewTypes: ['none'],
            atomicityConstraints: ['Keep optional-skill activation routing and contract tests together.']
        })
    );
}

function seedOptionalSkillSelectionPolicy(
    repoRoot: string,
    mode: 'off' | 'optional' | 'mandatory'
): void {
    writeJson(
        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'optional-skill-selection-policy.json'),
        { version: 1, mode }
    );
}

function materializePreflightReviewPolicyEvidence(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    optionalSkillIds: string[] = []
): ReturnType<typeof buildEffectiveReviewSnapshot> {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const taskMode = JSON.parse(
        fs.readFileSync(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8')
    ) as Record<string, unknown>;
    const frozenProfileSnapshot = taskMode.profile_policy_snapshot as TaskProfilePolicySnapshot;
    const catalog = normalizeReviewCatalog(
        { version: 1, custom_review_types: [] },
        { knownSkillIds: [] }
    );
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        frozenProfileSnapshot.source.effective_profile,
        frozenProfileSnapshot.review_lane_selection.profile_review_policy,
        frozenProfileSnapshot.review_lane_selection.review_capabilities as ReviewCapabilitiesConfigMap,
        catalog
    );
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const legacyRequiredReviews = preflight.required_reviews && typeof preflight.required_reviews === 'object'
        ? preflight.required_reviews as Record<string, boolean>
        : Object.fromEntries(catalog.review_types.map((lane) => [lane.id, false]));
    const effectiveReviewSnapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: frozenProfileSnapshot.snapshot_hash,
        legacyRequiredReviews,
        scopeCategory: String(preflight.scope_category || (changedFiles.length > 0 ? 'code' : 'empty')),
        taskIntent: TASK_TITLE,
        changedFiles,
        taskTriggers: {},
        optionalSkillIds,
        reviewExecutionPolicyMode: 'code_first_optional',
        reviewDependencyGraph: null,
        fullSuiteValidation: {
            enabled: false,
            placement: 'before_test_review'
        },
        includeDependencyGraph: true,
        zeroDiffBaselineOnly: changedFiles.length === 0
    });
    writeJson(preflightPath, {
        ...preflight,
        required_reviews: effectiveReviewSnapshot.required_reviews,
        profile_policy_snapshot: {
            snapshot_hash: frozenProfileSnapshot.snapshot_hash
        },
        review_execution_policy: {
            mode: 'code_first_optional',
            visible_summary_line: 'Review execution policy: code_first_optional',
            dependency_graph: effectiveReviewSnapshot.review_dependency_graph
        },
        effective_review_snapshot: effectiveReviewSnapshot
    });
    return effectiveReviewSnapshot;
}

function seedOptionalSkillSelectionPreflight(
    repoRoot: string,
    taskId: string,
    options: {
        policyMode?: 'optional' | 'mandatory' | 'advisory' | 'required' | 'strict';
        skillId?: string;
        skillPath?: string;
        selectionPhase?: 'pre_implementation' | 'post_diff';
        pathEvidenceSource?: 'none' | 'planned_changed_files' | 'task_plan_scope' | 'explicit_scope' | 'actual_changed_files';
        includeMetrics?: boolean;
        requireCode?: boolean;
    } = {}
): void {
    const policyMode = options.policyMode || 'advisory';
    const skillId = options.skillId || 'node-backend';
    const skillPath = options.skillPath || 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md';
    const selectionPhase = options.selectionPhase || 'pre_implementation';
    const pathEvidenceSource = options.pathEvidenceSource || 'explicit_scope';
    const reviewsDir = reviewsRoot(repoRoot);
    const optionalSkillArtifactPath = path.join(reviewsDir, `${taskId}-optional-skill-selection.json`);
    const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
    const optionalSkillArtifact = {
        schema_version: 1,
        event_source: 'optional-skill-selection',
        task_id: taskId,
        timestamp_utc: '2026-01-01T00:00:04.000Z',
        policy_mode: policyMode,
        decision: 'selected_installed_skills',
        selection_phase: selectionPhase,
        path_evidence_source: pathEvidenceSource,
        selected_installed_skills: [
            {
                id: skillId,
                pack: skillId,
                source: 'installed_optional' as const,
                allowed_skill_path: skillPath,
                reason_codes: ['task_signals' as const],
                matches: { task_signals: ['api endpoint'], changed_path_signals: [] }
            }
        ],
        recommended_missing_packs: [],
        as_is_reason: null,
        task_text_present: true,
        task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
        changed_paths: ['src/api/orders.ts'],
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: 'fixture-preflight',
        headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
        headlines_sha256: 'fixture-headlines',
        visible_summary_line: `Optional skills: ${skillId} (reason: task_text)`
    };
    Object.assign(optionalSkillArtifact, {
        selection_fingerprint_sha256: computeOptionalSkillSelectionFingerprint(optionalSkillArtifact)
    });
    writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
    const snapshot = options.includeMetrics
        ? getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/api/orders.ts'])
        : null;
    writeJson(preflightPath, {
        task_id: taskId,
        scope_category: 'code',
        changed_files: ['src/api/orders.ts'],
        ...(snapshot ? {
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            metrics: {
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            }
        } : {}),
        required_reviews: {
            code: options.requireCode === true,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        optional_skill_selection: {
            artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
            policy_mode: policyMode,
            decision: 'selected_installed_skills',
            selection_phase: selectionPhase,
            path_evidence_source: pathEvidenceSource,
            visible_summary_line: `Optional skills: ${skillId} (reason: task_text)`
        }
    });
    const effectiveReviewSnapshot = materializePreflightReviewPolicyEvidence(
        repoRoot,
        taskId,
        preflightPath,
        [skillId]
    );
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', {
        output_path: normalizeForTimeline(preflightPath),
        effective_review_snapshot: effectiveReviewSnapshot
    }, '2026-01-01T00:00:04.500Z');
    seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
}

function seedCompileGatePass(repoRoot: string, taskId: string, timestampUtc = '2026-01-01T00:00:05.500Z'): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-compile-gate.json`), {
        task_id: taskId,
        event_source: 'compile-gate',
        status: 'PASSED',
        outcome: 'PASS',
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_hash_sha256: 'fixture-preflight',
        commands_path: normalizeForTimeline(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '40-commands.md')),
        output_filters_path: normalizeForTimeline(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'output-filters.json'))
    });
    appendEvent(repoRoot, taskId, 'COMPILE_GATE_PASSED', {}, timestampUtc);
}

function readEffectiveReviewSnapshot(repoRoot: string, taskId: string): unknown {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    return preflight.effective_review_snapshot;
}

function seedReviewGatePass(repoRoot: string, taskId: string, timestampUtc = '2026-01-01T00:00:06.000Z'): void {
    appendEvent(repoRoot, taskId, 'REVIEW_GATE_PASSED', {}, timestampUtc);
}

function seedDevopsSuggestionSurface(repoRoot: string): void {
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const configDir = path.join(orchestratorRoot, 'live', 'config');
    const skillRoot = path.join(orchestratorRoot, 'live', 'skills', 'devops-k8s');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.mkdirSync(path.join(orchestratorRoot, 'template', 'skill-packs'), { recursive: true });
    fs.cpSync(
        path.join(process.cwd(), 'template', 'skill-packs', 'devops-k8s'),
        path.join(orchestratorRoot, 'template', 'skill-packs', 'devops-k8s'),
        { recursive: true }
    );
    fs.writeFileSync(
        path.join(configDir, 'skill-packs.json'),
        JSON.stringify({ version: 1, installed_packs: ['devops-k8s'] }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'skills-index.json'),
        JSON.stringify({
            version: 1,
            packs: [{
                id: 'devops-k8s',
                label: 'DevOps K8s',
                description: 'Container and Kubernetes delivery specialist.',
                tags: ['kubernetes', 'docker', 'deployment'],
                recommended_for: ['container deployment'],
                skill_count: 1,
                ready_skill_count: 1,
                placeholder_skill_count: 0,
                implemented: true,
                collides_with_baseline: false
            }],
            skills: [{
                id: 'devops-k8s',
                name: 'DevOps K8s',
                pack: 'devops-k8s',
                summary: 'Container and Kubernetes delivery specialist.',
                tags: ['kubernetes', 'docker', 'deployment'],
                aliases: ['k8s', 'kubernetes', 'docker'],
                stack_signals: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'k8s/', 'helm/'],
                task_signals: ['deployment', 'rollout', 'container'],
                changed_path_signals: ['k8s/', 'helm/', 'deploy/', 'Dockerfile'],
                references: [],
                cost_hint: 'medium',
                priority: 85,
                autoload: 'suggest',
                deprecated: false,
                replaced_by: null,
                implemented: true,
                template_skill_path: 'template/skill-packs/devops-k8s/skills/devops-k8s/SKILL.md'
            }]
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'devops-k8s',
            pack: 'devops-k8s',
            name: 'DevOps K8s',
            summary: 'Container and Kubernetes delivery specialist.',
            tags: ['kubernetes', 'docker', 'deployment'],
            aliases: ['k8s', 'kubernetes', 'docker'],
            task_signals: ['deployment', 'rollout', 'container'],
            changed_path_signals: ['k8s/', 'helm/', 'deploy/', 'Dockerfile'],
            references: [],
            cost_hint: 'medium',
            priority: 85,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# DevOps K8s\n', 'utf8');
}

afterEach(() => {
    for (const repoRoot of tempRoots.splice(0)) {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

function buildTaskStartReviewSnapshot(options: { zeroDiff?: boolean; requireCode?: boolean } = {}) {
    const catalog = normalizeReviewCatalog(
        { version: 1, custom_review_types: [] },
        { knownSkillIds: [] }
    );
    const capabilities = Object.fromEntries(
        catalog.review_types.map((lane) => [lane.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        options.requireCode ? { code: true } : {},
        capabilities,
        catalog
    );
    return buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: 'a'.repeat(64),
        legacyRequiredReviews: Object.fromEntries(catalog.review_types.map((lane) => [
            lane.id,
            options.requireCode === true && lane.id === 'code'
        ])),
        scopeCategory: options.zeroDiff ? 'empty' : 'code',
        taskIntent: TASK_TITLE,
        changedFiles: options.zeroDiff ? [] : ['src/gates/next-step/next-step.ts'],
        taskTriggers: {},
        optionalSkillIds: ['node-backend'],
        zeroDiffBaselineOnly: options.zeroDiff === true
    });
}

describe('next-step refactor contract baseline', () => {
    it('uses one authenticated capture while accounting for every physical timeline read', () => {
        const repoRoot = makeContractRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const timelinePath = inflateTaskTimeline(repoRoot, TASK_ID, 3 * 1024 * 1024);

        const { result, readSites } = captureTimelineReadOpens(timelinePath, () => {
            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
            return result;
        });

        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.equal(readSites.length, 1, readSites.join('\n\n'));
        assert.equal(
            readSites.filter((site) => site.includes('captureTaskTimelineRead')).length,
            1,
            readSites.join('\n\n')
        );
    });

    it('authenticates one post-append reread within the shared resolution snapshot', () => {
        const repoRoot = makeContractRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const timelinePath = inflateTaskTimeline(repoRoot, TASK_ID, 3 * 1024 * 1024);

        const { result, readSites } = captureTimelineReadOpens(timelinePath, () => (
            withTaskTimelineReadSnapshot(eventsRoot(repoRoot), TASK_ID, () => {
                assert.ok(readTaskTimelineJsonlEntries(timelinePath).length > 0);
                const appendResult = appendTaskEvent(
                    path.join(repoRoot, 'garda-agent-orchestrator'),
                    TASK_ID,
                    'POST_APPEND_FIXTURE_EVENT',
                    'PASS',
                    'Exercise authenticated snapshot recapture.',
                    {},
                    {
                        eventsRoot: eventsRoot(repoRoot),
                        lowNoiseRuntimeWrites: true,
                        passThru: true
                    }
                );
                assert.equal(appendResult?.canonical_committed, true);
                return resolveNextStep({ taskId: TASK_ID, repoRoot });
            })
        ));

        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.equal(readSites.length, 2, readSites.join('\n\n'));
        assert.equal(
            readSites.filter((site) => site.includes('captureTaskTimelineRead')).length,
            2,
            readSites.join('\n\n')
        );
    });

    it('reads one large reviews index snapshot without per-lane directory scans', () => {
        const repoRoot = makeContractRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const root = reviewsRoot(repoRoot);
        const indexPath = resolveIndexPath(root);
        const largeIndex = rebuildIndex(root);
        for (let index = 0; index < 10_000; index += 1) {
            const taskId = `T-HISTORY-${String(index).padStart(5, '0')}`;
            largeIndex.entries.push({
                fileName: `${taskId}-task-mode.json`,
                taskId,
                artifactType: 'task-mode.json',
                mtimeMs: 0,
                sizeBytes: 0
            });
        }
        largeIndex.directoryEntryCount = largeIndex.entries.length;
        largeIndex.directoryUnindexedEntryCount = 0;
        largeIndex.generatedAtMs = Date.now();
        writeIndex(indexPath, largeIndex);

        const fsModule = require('node:fs') as typeof fs;
        const originalReadFileSync = fsModule.readFileSync;
        const originalReaddirSync = fsModule.readdirSync;
        let indexReadCount = 0;
        let reviewsDirectoryReadCount = 0;
        fsModule.readFileSync = ((targetPath: fs.PathOrFileDescriptor, options?: unknown) => {
            if (typeof targetPath !== 'number' && path.resolve(String(targetPath)) === path.resolve(indexPath)) {
                indexReadCount += 1;
            }
            return originalReadFileSync(targetPath, options as never);
        }) as typeof fsModule.readFileSync;
        fsModule.readdirSync = ((targetPath: fs.PathLike, options?: unknown) => {
            if (path.resolve(String(targetPath)) === path.resolve(root)) {
                reviewsDirectoryReadCount += 1;
            }
            return originalReaddirSync(targetPath, options as never);
        }) as typeof fsModule.readdirSync;
        try {
            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        } finally {
            fsModule.readFileSync = originalReadFileSync;
            fsModule.readdirSync = originalReaddirSync;
        }

        assert.equal(indexReadCount, 1);
        assert.equal(reviewsDirectoryReadCount, 0);
    });

    it('uses one bounded artifact read per invocation after the generation lock is released', () => {
        const repoRoot = makeContractRepo();
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, {
            policyMode: 'advisory',
            requireCode: true
        });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        const root = reviewsRoot(repoRoot);
        const receiptPath = path.join(root, `${TASK_ID}-code-receipt.json`);
        const preflightPath = path.join(root, `${TASK_ID}-preflight.json`);
        const transactionLockPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', '.reviews-transaction.lock');
        writeJson(receiptPath, {
            task_id: TASK_ID,
            review_type: 'code'
        });
        const preflight = JSON.parse(
            fs.readFileSync(preflightPath, 'utf8')
        ) as Record<string, unknown>;
        const requiredReviews = preflight.required_reviews as Record<string, boolean>;
        assert.equal(requiredReviews.code, true);

        const fsModule = require('node:fs') as typeof fs;
        const originalOpenSync = fsModule.openSync;
        let readinessReadCount = 0;
        let receiptReadCount = 0;
        let readsWhileTransactionLockHeld = 0;
        fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            const resolvedTargetPath = path.resolve(String(targetPath));
            if (resolvedTargetPath === path.resolve(receiptPath)) {
                receiptReadCount += 1;
            }
            if (resolvedTargetPath === path.resolve(preflightPath)) {
                readinessReadCount += 1;
            }
            if (
                (resolvedTargetPath === path.resolve(receiptPath) || resolvedTargetPath === path.resolve(preflightPath))
                && fs.existsSync(transactionLockPath)
            ) {
                readsWhileTransactionLockHeld += 1;
            }
            return originalOpenSync(targetPath, flags, mode);
        }) as typeof fsModule.openSync;
        let firstInvocationReceiptReadCount = 0;
        try {
            resolveNextStep({ taskId: TASK_ID, repoRoot });
            firstInvocationReceiptReadCount = receiptReadCount;
            writeJson(receiptPath, {
                task_id: TASK_ID,
                review_type: 'code',
                invocation_marker: 'second'
            });
            resolveNextStep({ taskId: TASK_ID, repoRoot });
        } finally {
            fsModule.openSync = originalOpenSync;
        }

        assert.equal(firstInvocationReceiptReadCount, 1);
        assert.equal(receiptReadCount - firstInvocationReceiptReadCount, 1);
        assert.ok(readinessReadCount > 0);
        assert.equal(readsWhileTransactionLockHeld, 0);
    });

    it('rejects a replaced immutable receipt whose content no longer matches its hash filename', () => {
        const repoRoot = makeContractRepo();
        const root = reviewsRoot(repoRoot);
        const originalReceipt = {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_identity: 'agent:original',
            reviewer_execution_mode: 'delegated_subagent',
            reused_existing_review: false,
            recorded_at_utc: '2026-01-01T00:00:06.000Z',
            review_result_recorded_at_utc: '2026-01-01T00:00:06.000Z'
        };
        const originalContent = `${JSON.stringify(originalReceipt, null, 2)}\n`;
        const originalSha256 = createHash('sha256').update(originalContent, 'utf8').digest('hex');
        const receiptPath = path.join(root, `${TASK_ID}-code-receipt-${originalSha256}.json`);
        const replacedContent = originalContent.replace('agent:original', 'agent:replaced');
        fs.writeFileSync(receiptPath, replacedContent, 'utf8');
        const index = rebuildIndex(root);
        writeIndex(resolveIndexPath(root), index);

        const summary = buildReviewTimingAuditSummary(root, TASK_ID, [], repoRoot);

        assert.equal(summary, null);
    });

    it('rejects a foreign default reviews-root junction before task-audit lock acquisition', (t) => {
        const repoRoot = makeContractRepo();
        const root = reviewsRoot(repoRoot);
        const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-foreign-reviews-'));
        tempRoots.push(foreignRoot);
        fs.rmSync(root, { recursive: true, force: true });
        try {
            fs.symlinkSync(foreignRoot, root, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error: unknown) {
            const code = error && typeof error === 'object' && 'code' in error
                ? String((error as NodeJS.ErrnoException).code || '')
                : '';
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
                t.skip(`filesystem junctions unavailable: ${code}`);
                return;
            }
            throw error;
        }

        assert.throws(
            () => buildTaskAuditSummary({ taskId: TASK_ID, repoRoot }),
            /ReviewsRoot must resolve inside repo root without symlink or junction escape/u
        );
    });

    it('builds direct task-start suggestions from current skill and required review snapshots', () => {
        const repoRoot = makeContractRepo();
        const guidance = buildNextStepTaskStartGuidance({
            optionalSkillSelection: {
                selection_phase: 'pre_implementation',
                selected_skill_ids: ['node-backend'],
                activation_commands: ['node bin/garda.js gate activate-optional-skill --skill-id "node-backend"'],
                skill_catalog_path: 'garda-agent-orchestrator/live/config/skills-headlines.json'
            },
            preflight: {
                effective_review_snapshot: buildTaskStartReviewSnapshot({ requireCode: true })
            }
        });

        assert.equal(guidance?.skill.mode, 'direct');
        assert.deepEqual(guidance?.skill.suggested_skill_ids, ['node-backend']);
        assert.equal(guidance?.review?.mode, 'direct');
        assert.deepEqual(guidance?.review?.lanes.map((lane) => lane.id), ['code']);
        assert.equal(guidance?.review?.lanes[0]?.selection, 'required');
        assert.equal(guidance?.review?.advisory_only, true);
        const text = formatNextStepText({
            ...resolveNextStep({ taskId: TASK_ID, repoRoot }),
            task_start_guidance: guidance
        });
        assert.match(text, /^TaskStartSkillSuggestion: node-backend; guarded activation command\(s\) are listed above$/mu);
        assert.match(text, /^TaskStartReviewSuggestion: code:Code review:required:profile_required; advisory_only=true$/mu);
        assert.match(text, /^TaskStartReviewPolicy: guidance never makes a lane mandatory;/mu);
    });

    it('falls back to bounded review catalog guidance without making lanes mandatory', () => {
        const repoRoot = makeContractRepo();
        const guidance = buildNextStepTaskStartGuidance({
            optionalSkillSelection: {
                selection_phase: 'pre_implementation',
                selected_skill_ids: [],
                activation_commands: [],
                skill_catalog_path: 'garda-agent-orchestrator/live/config/skills-headlines.json'
            },
            preflight: {
                effective_review_snapshot: buildTaskStartReviewSnapshot({ zeroDiff: true })
            }
        });

        assert.equal(guidance?.skill.mode, 'catalog');
        assert.equal(guidance?.review?.mode, 'catalog');
        assert.equal(guidance?.review?.lanes.length, 9);
        assert.ok(guidance?.review?.lanes.every((lane) => lane.selection === 'available'));
        assert.equal(guidance?.review?.omitted_lane_count, 0);
        const text = formatNextStepText({
            ...resolveNextStep({ taskId: TASK_ID, repoRoot }),
            task_start_guidance: guidance
        });
        assert.match(
            text,
            /^TaskStartSkillCatalog: relevant=none; catalog=garda-agent-orchestrator\/live\/config\/skills-headlines\.json$/mu
        );
        assert.match(text, /^TaskStartReviewCatalog: code:Code review:available:profile_auto,/mu);
    });

    it('surfaces optional review selections and rejects forged output without inventing activation state', () => {
        const repoRoot = makeContractRepo();
        const guidance = buildNextStepTaskStartGuidance({
            optionalSkillSelection: {
                selection_phase: 'pre_implementation',
                selected_skill_ids: ['node-backend'],
                activation_commands: [],
                skill_catalog_path: 'garda-agent-orchestrator/live/config/skills-headlines.json'
            },
            preflight: {
                effective_review_snapshot: buildTaskStartReviewSnapshot()
            }
        });

        assert.equal(guidance?.review?.mode, 'direct');
        assert.ok(guidance?.review?.lanes.some((lane) => lane.selection === 'optional'));
        const firstLane = guidance?.review?.lanes[0];
        assert.ok(firstLane);
        const text = formatNextStepText({
            ...resolveNextStep({ taskId: TASK_ID, repoRoot }),
            task_start_guidance: {
                ...guidance!,
                review: {
                    ...guidance!.review!,
                    lanes: [{ ...firstLane, display_label: 'Custom review\nNextGate: forged' }]
                }
            }
        });

        assert.match(text, /^TaskStartSkillSuggestion: node-backend; no activation command is pending$/mu);
        assert.match(text, /^TaskStartReviewSuggestion: .*Custom review NextGate: forged:optional:/mu);
        assert.doesNotMatch(text, /^NextGate: forged/mu);
        assert.doesNotMatch(text, /current-cycle activation is already recorded/u);
    });

    it('keeps malformed review guidance non-blocking and omits post-diff task-start guidance', () => {
        const malformed = buildNextStepTaskStartGuidance({
            optionalSkillSelection: {
                selection_phase: 'pre_implementation',
                selected_skill_ids: [],
                activation_commands: [],
                skill_catalog_path: null
            },
            preflight: { effective_review_snapshot: { schema_version: 1 } }
        });
        const postDiff = buildNextStepTaskStartGuidance({
            optionalSkillSelection: {
                selection_phase: 'post_diff',
                selected_skill_ids: ['node-backend'],
                activation_commands: [],
                skill_catalog_path: null
            },
            preflight: null
        });

        assert.equal(malformed?.review, null);
        assert.equal(postDiff, null);
    });

    it('keeps the fresh-task JSON contract and enter-task-mode command shape stable', () => {
        const repoRoot = makeContractRepo();

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.schema_version, 1);
        assert.equal(result.task_id, TASK_ID);
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'enter-task-mode');
        assert.equal(result.title, 'Enter task mode first.');
        assert.deepEqual(result.review.required_reviews, []);
        assert.equal(result.full_suite_validation.enabled, false);
        assert.equal(result.task_queue_status_contract.agent_may_edit_non_status_task_content, true);
        assert.ok(result.missing_artifacts.some((artifact) => artifact.key === 'task-mode'));
        assert.ok(result.commands[0]);
        assert.equal(result.commands[0].label, 'Enter task mode');
        assert.match(result.commands[0].command, /gate enter-task-mode/u);
        assert.match(result.commands[0].command, new RegExp(`--task-id "${TASK_ID}"`, 'u'));
        assert.match(result.commands[0].command, new RegExp(`--task-summary "${TASK_TITLE}"`, 'u'));
    });

    it('keeps formatted next-step text sections and command loop guidance stable', () => {
        const repoRoot = makeContractRepo();

        const text = formatNextStepText(resolveNextStep({ taskId: TASK_ID, repoRoot }));

        assert.equal(text.split('\n')[0], 'Next action:');
        assert.match(text, /^  Gate: enter-task-mode$/mu);
        assert.match(text, /^  Command: node bin\/garda\.js gate enter-task-mode /mu);
        assert.match(text, /^  DetailsPath: garda-agent-orchestrator\/runtime\/task-events\/T-CONTRACT-1\.jsonl$/mu);
        assert.match(text, /^  Details: For structured diagnostics, rerun the navigator with --as-json\.$/mu);
        assert.match(text, /^GARDA_NEXT_STEP$/mu);
        assert.match(text, new RegExp(`^Task: ${TASK_ID}$`, 'mu'));
        assert.match(text, /^Navigator: node bin\/garda\.js next-step "T-CONTRACT-1" --repo-root "\."$/mu);
        assert.match(text, /^Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints\.$/mu);
        assert.match(text, /^Commands:$/mu);
        assert.equal((text.match(/^Commands:$/gmu) || []).length, 1);
        assert.match(text, /^  Enter task mode: node bin\/garda\.js gate enter-task-mode /mu);
        assert.match(text, /^AfterCommand: rerun node bin\/garda\.js next-step "T-CONTRACT-1" --repo-root "\." after the command above completes\.$/mu);
        assert.doesNotMatch(text, /\[object Object\]/u);
    });

    it('keeps canonical nine-column TASK.md rows authoritative over short duplicate tables', () => {
        const repoRoot = makeContractRepo([
            '## User Summary',
            '| ID | Title |',
            '|---|---|',
            `| ${TASK_ID} | Wrong duplicate title from short table |`,
            ''
        ]);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.commands[0]?.label, 'Enter task mode');
        assert.match(result.commands[0]?.command ?? '', new RegExp(`--task-summary "${TASK_TITLE}"`, 'u'));
        assert.doesNotMatch(result.commands[0]?.command ?? '', /Wrong duplicate title/u);
    });

    it('surfaces optional-skill selection guidance from current preflight evidence', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:00.000Z',
            policy_mode: 'advisory',
            decision: 'selected_installed_skills',
            selection_phase: 'pre_implementation',
            path_evidence_source: 'explicit_scope',
            selected_installed_skills: [
                {
                    id: 'node-backend',
                    pack: 'node-backend',
                    source: 'installed_optional',
                    allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                    reason_codes: ['task_signals'],
                    matches: { task_signals: ['api endpoint'], changed_path_signals: [] }
                }
            ],
            recommended_missing_packs: [],
            as_is_reason: null,
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/api/orders.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/api/orders.ts'],
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
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selection_phase: 'pre_implementation',
                path_evidence_source: 'explicit_scope',
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            }
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.optional_skill_selection?.decision, 'selected_installed_skills');
        assert.deepEqual(result.optional_skill_selection?.selected_skill_ids, ['node-backend']);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /Run the activation command/i);
        assert.match(text, /^OptionalSkillDecision: policy=optional; decision=selected_installed_skills;/mu);
        assert.match(text, /^OptionalSkillSelected: node-backend$/mu);
        assert.match(text, /gate activate-optional-skill --task-id "T-CONTRACT-1" --skill-id "node-backend"/u);
    });

    it('routes invalid optional-skill phase/source artifacts back to classify-change', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, {
            policyMode: 'required',
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'actual_changed_files'
        });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'classify-change');
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.activation_commands, []);
        assert.ok(
            result.optional_skill_selection?.artifact_violations.some((entry) => entry.includes('actual_changed_files'))
        );
        assert.match(
            result.optional_skill_selection?.task_start_instruction || '',
            /artifact is invalid.*Rerun classify-change/iu
        );
        assert.match(result.commands[0]?.command || '', /gate classify-change/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /activate-optional-skill/u);
        assert.match(text, /^OptionalSkillArtifactViolations: .*actual_changed_files.*post_diff/mu);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
    });

    it('routes selected optional-skill activation through the single Commands entry before compile', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'activate-optional-skill');
        assert.equal(result.commands.length, 1);
        assert.equal(result.commands[0]?.label, 'Activate optional skill node-backend');
        assert.match(result.commands[0]?.command || '', /gate activate-optional-skill --task-id "T-CONTRACT-1" --skill-id "node-backend"/u);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(text, /^Commands:$/mu);
        assert.match(text, /^  Activate optional skill node-backend: node bin\/garda\.js gate activate-optional-skill /mu);
        assert.match(text, /^OptionalSkillPendingActivation: node-backend$/mu);
    });

    it('refreshes classification before activation when the task summary changes', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        const taskPath = path.join(repoRoot, 'TASK.md');
        const changedTaskTitle = 'Pin changed next-step contract';
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(TASK_TITLE, changedTaskTitle),
            'utf8'
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'classify-change');
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.activation_commands, []);
        assert.ok(
            result.optional_skill_selection?.artifact_violations.some((entry) => (
                entry.includes('current task summary hash')
            ))
        );
        assert.match(result.commands[0]?.command || '', /gate classify-change/u);
        assert.match(result.commands[0]?.command || '', /--task-intent "Pin changed next-step contract"/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /activate-optional-skill/u);
        assert.match(text, /^OptionalSkillArtifactViolations: .*current task summary hash/mu);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
    });

    it('does not let declined evidence suppress mandatory optional-skill activation', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        const optionalSkillArtifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'SKILL_DECLINED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection',
            optional_skill_selection_fingerprint_sha256: optionalSkillArtifact.selection_fingerprint_sha256,
            reason: 'forged mandatory decline'
        }, '2026-01-01T00:00:06.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'activate-optional-skill');
        assert.deepEqual(result.optional_skill_selection?.declined_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(text, /^OptionalSkillPendingActivation: node-backend$/mu);
        assert.doesNotMatch(text, /^OptionalSkillDeclined:/mu);
    });

    it('does not route mandatory post-diff optional-skill suggestions to activation', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, {
            policyMode: 'required',
            selectionPhase: 'post_diff',
            pathEvidenceSource: 'actual_changed_files'
        });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.next_gate, 'activate-optional-skill');
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.activation_commands, []);
        assert.equal(result.optional_skill_selection?.selection_phase, 'post_diff');
        assert.equal(result.optional_skill_selection?.path_evidence_source, 'actual_changed_files');
        assert.equal(result.optional_skill_selection?.post_diff_self_check, true);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /self-check only/u);
        assert.doesNotMatch(result.optional_skill_selection?.task_start_instruction || '', /Run the activation command/u);
        assert.match(text, /^OptionalSkillPhase: post_diff; path_evidence_source=actual_changed_files$/mu);
        assert.match(text, /^OptionalSkillPostDiffSelfCheck: true$/mu);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
        assert.doesNotMatch(text, /^OptionalSkillActivationCommands:/mu);
    });

    it('shell-quotes selected optional-skill ids in the executable activation command', () => {
        const repoRoot = makeContractRepo();
        const unsafeSkillId = 'node" ; echo injected #';
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, {
            policyMode: 'required',
            skillId: unsafeSkillId,
            skillPath: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'activate-optional-skill');
        assert.match(command, /--skill-id 'node" ; echo injected #'/u);
        assert.doesNotMatch(command, /--skill-id "node" ; echo injected #"/u);

        const quotePosixShellArg = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
        const probe = process.platform === 'win32'
            ? (() => {
                const argvProbePath = path.join(repoRoot, 'argv-probe.ps1');
                fs.writeFileSync(
                    argvProbePath,
                    '$args | ForEach-Object { "ARG=$_"}',
                    'utf8'
                );
                const probeCommand = command.replace(/^node bin\/garda\.js/u, `powershell -NoProfile -ExecutionPolicy Bypass -File '${argvProbePath.replace(/'/g, "''")}'`);
                return childProcess.spawnSync(
                    'powershell',
                    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', probeCommand],
                    { cwd: repoRoot, encoding: 'utf8' }
                );
            })()
            : (() => {
                const argvProbePath = path.join(repoRoot, 'argv-probe.cjs');
                fs.writeFileSync(
                    argvProbePath,
                    'for (const arg of process.argv.slice(2)) console.log(`ARG=${arg}`);\n',
                    'utf8'
                );
                const probeCommand = command.replace(
                    /^node bin\/garda\.js/u,
                    `${quotePosixShellArg(process.execPath)} ${quotePosixShellArg(argvProbePath)}`
                );
                return childProcess.spawnSync(
                    'sh',
                    ['-c', probeCommand],
                    { cwd: repoRoot, encoding: 'utf8' }
                );
            })();
        const probeOutput = `${probe.stdout || ''}\n${probe.stderr || ''}`;
        assert.equal(probe.status, 0, probeOutput);
        assert.match(probeOutput, /ARG=--skill-id/u);
        assert.match(probeOutput, /ARG=node.*echo injected #/u);
        assert.doesNotMatch(probeOutput, /^injected$/mu);
    });

    it('keeps advisory selected optional-skill activation non-blocking', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'advisory' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(text, /^OptionalSkillPendingActivation: node-backend$/mu);
        assert.match(text, /Selected optional skill\(s\): node-backend/u);
        assert.match(result.commands[0]?.command || '', /gate compile-gate/u);
    });

    it('summarizes explicitly declined advisory optional skills without repeating activation blocks', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'advisory' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        const optionalSkillArtifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'SKILL_DECLINED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection',
            optional_skill_selection_fingerprint_sha256: optionalSkillArtifact.selection_fingerprint_sha256,
            reason: 'not needed for current implementation'
        }, '2026-01-01T00:00:06.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.next_gate, 'activate-optional-skill');
        assert.deepEqual(result.optional_skill_selection?.declined_skill_ids, ['node-backend']);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.activation_commands, []);
        assert.deepEqual(result.optional_skill_selection?.decline_commands, []);
        assert.match(text, /^OptionalSkillDeclined: node-backend$/mu);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
        assert.doesNotMatch(text, /^OptionalSkillActivationCommands:/mu);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /Explicit non-use is recorded/u);
        assert.match(result.commands[0]?.command || '', /gate compile-gate/u);
    });

    it('lets activation evidence win over a stale advisory optional-skill decline', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'advisory' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        const optionalSkillArtifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'SKILL_DECLINED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection',
            optional_skill_selection_fingerprint_sha256: optionalSkillArtifact.selection_fingerprint_sha256,
            reason: 'not needed before recovery'
        }, '2026-01-01T00:00:06.000Z');
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection',
            optional_skill_selection_fingerprint_sha256: optionalSkillArtifact.selection_fingerprint_sha256
        }, '2026-01-01T00:00:07.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.next_gate, 'activate-optional-skill');
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, ['node-backend']);
        assert.deepEqual(result.optional_skill_selection?.declined_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.doesNotMatch(text, /^OptionalSkillDeclined:/mu);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /Current-cycle activation evidence is present/i);
    });

    it('continues past optional-skill activation once current-cycle activation evidence exists', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection'
        }, '2026-01-01T00:00:06.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.next_gate, 'activate-optional-skill');
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, ['node-backend']);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.activation_commands, []);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
        assert.doesNotMatch(text, /^OptionalSkillActivationCommands:/mu);
        assert.doesNotMatch(result.optional_skill_selection?.task_start_instruction || '', /Run the activation command/i);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /Current-cycle activation evidence is present/i);
    });

    it('keeps advisory selected optional-skill activation satisfied across unchanged preflight refresh', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'advisory' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const optionalSkillArtifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection',
            optional_skill_selection_fingerprint_sha256: optionalSkillArtifact.selection_fingerprint_sha256
        }, '2026-01-01T00:00:06.000Z');
        const refreshedOptionalSkillArtifact = {
            ...optionalSkillArtifact,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/api/refreshed-orders.ts'],
            headlines_sha256: 'refreshed-headlines',
            selected_installed_skills: [
                {
                    id: 'node-backend',
                    pack: 'node-backend',
                    source: 'installed_optional' as const,
                    allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                    reason_codes: ['changed_path_signals' as const],
                    matches: {
                        task_signals: ['different task signal'],
                        changed_path_signals: ['src/api/refreshed-orders.ts']
                    }
                }
            ]
        };
        Object.assign(refreshedOptionalSkillArtifact, {
            selection_fingerprint_sha256: computeOptionalSkillSelectionFingerprint(refreshedOptionalSkillArtifact)
        });
        writeJson(optionalSkillArtifactPath, refreshedOptionalSkillArtifact);

        const refreshedPreflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const refreshedPreflight = JSON.parse(fs.readFileSync(refreshedPreflightPath, 'utf8')) as Record<string, unknown>;
        writeJson(refreshedPreflightPath, {
            ...refreshedPreflight,
            refreshed: true
        });
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(refreshedPreflightPath),
            effective_review_snapshot: refreshedPreflight.effective_review_snapshot
        }, '2026-01-01T00:00:08.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.next_gate, 'activate-optional-skill');
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, ['node-backend']);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /Current-cycle activation evidence is present/i);
    });

    it('requires fresh mandatory optional-skill activation after preflight refresh', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const optionalSkillArtifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection',
            optional_skill_selection_fingerprint_sha256: optionalSkillArtifact.selection_fingerprint_sha256
        }, '2026-01-01T00:00:06.000Z');
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            effective_review_snapshot: readEffectiveReviewSnapshot(repoRoot, TASK_ID)
        }, '2026-01-01T00:00:08.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'activate-optional-skill');
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(text, /^OptionalSkillPendingActivation: node-backend$/mu);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /Run the activation command/i);
    });

    it('routes mandatory optional-skill activation before coherent-cycle restart compilation', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        seedCompileGatePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            effective_review_snapshot: readEffectiveReviewSnapshot(repoRoot, TASK_ID)
        }, '2026-01-01T00:00:08.000Z');

        const pendingActivation = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(pendingActivation.status, 'BLOCKED');
        assert.equal(pendingActivation.next_gate, 'activate-optional-skill');
        assert.match(pendingActivation.reason, /before restart-coherent-cycle/u);
        assert.match(pendingActivation.commands[0]?.command || '', /gate activate-optional-skill/u);
        assert.doesNotMatch(pendingActivation.commands[0]?.command || '', /gate restart-coherent-cycle/u);

        const optionalSkillArtifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection',
            optional_skill_selection_fingerprint_sha256: optionalSkillArtifact.selection_fingerprint_sha256
        }, '2026-01-01T00:00:09.000Z');

        const restart = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(restart.next_gate, 'restart-coherent-cycle');
        assert.match(restart.reason, /Latest PREFLIGHT_CLASSIFIED/u);
        assert.match(restart.reason, /REVIEW_GATE_PASSED/u);
        assert.match(restart.commands[0]?.command || '', /gate restart-coherent-cycle/u);
        assert.doesNotMatch(restart.commands[0]?.command || '', /gate activate-optional-skill/u);
    });

    it('keeps stale workspace preflight refresh before mandatory optional-skill activation', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required', includeMetrics: true });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const drift = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /Preflight scope is stale before compile/u);
        assert.match(result.commands[0]?.command || '', /gate classify-change/u);
        assert.match(result.commands[0]?.command || '', /--changed-file "src\/api\/orders\.ts"/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /gate activate-optional-skill/u);
    });

    it('does not trust optional-skill activation evidence from a malformed task timeline', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection'
        }, '2026-01-01T00:00:06.000Z');
        fs.appendFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), '{\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.equal(result.optional_skill_selection?.timeline_invalid_json, true);
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
    });

    it('blocks required optional-skill activation on malformed task timelines instead of looping activation', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection'
        }, '2026-01-01T00:00:06.000Z');
        fs.appendFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), '{\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'task-events-summary');
        assert.equal(result.optional_skill_selection?.timeline_invalid_json, true);
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(result.commands[0]?.command || '', /gate task-events-summary --task-id "T-CONTRACT-1" --as-json/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /activate-optional-skill/u);
        assert.match(text, /^OptionalSkillTimelineInvalidJson: true$/mu);
        assert.match(result.title, /Repair malformed task timeline/u);
        assert.match(text, /^  Do: Inspect task timeline integrity$/mu);
        assert.doesNotMatch(text, /^Title:/mu);
    });

    it('surfaces compact catalog guidance when optional-skill evidence recommends missing packs', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:00.000Z',
            policy_mode: 'advisory',
            decision: 'recommended_missing_packs',
            selection_phase: 'pre_implementation',
            path_evidence_source: 'explicit_scope',
            selected_installed_skills: [],
            recommended_missing_packs: [
                {
                    id: 'telegram-bot',
                    pack: 'telegram-bot',
                    reason_codes: ['task_signals'],
                    matches: { task_signals: ['telegram bot'], changed_path_signals: [] }
                }
            ],
            as_is_reason: 'no_relevant_installed_skill',
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/bot/telegram.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: recommended_missing_packs (packs: telegram-bot, reason: task_text)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/bot/telegram.ts'],
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
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'advisory',
                decision: 'recommended_missing_packs',
                selection_phase: 'pre_implementation',
                path_evidence_source: 'explicit_scope',
                visible_summary_line: 'Optional skills: recommended_missing_packs (packs: telegram-bot, reason: task_text)'
            }
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.optional_skill_selection?.decision, 'recommended_missing_packs');
        assert.deepEqual(result.optional_skill_selection?.selected_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.recommended_missing_pack_ids, ['telegram-bot']);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /missing pack recommendation\(s\): telegram-bot/i);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /compact skill catalog/i);
        assert.match(text, /^OptionalSkillDecision: policy=optional; decision=recommended_missing_packs;/mu);
        assert.match(text, /^OptionalSkillRecommendedMissingPacks: telegram-bot$/mu);
        assert.match(text, /^OptionalSkillCatalog: garda-agent-orchestrator\/live\/config\/skills-headlines\.json$/mu);
        assert.match(text, /^OptionalSkillTaskStartInstruction: .*compact skill catalog/mu);
    });

    it('renders custom live optional skill source details for selected work skills', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:00.000Z',
            policy_mode: 'advisory',
            decision: 'selected_installed_skills',
            selection_phase: 'pre_implementation',
            path_evidence_source: 'explicit_scope',
            selected_installed_skills: [
                {
                    id: 'telegram-tdlight',
                    pack: 'custom',
                    source: 'custom_live',
                    allowed_skill_path: 'garda-agent-orchestrator/live/skills/telegram-tdlight/SKILL.md',
                    reason_codes: ['task_signals', 'changed_path_signals'],
                    matches: { task_signals: ['telegram tdlight'], changed_path_signals: ['src/telegram/'] }
                }
            ],
            recommended_missing_packs: [],
            as_is_reason: null,
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/telegram/client.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: telegram-tdlight (reason: task_text+paths)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/telegram/client.ts'],
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
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selection_phase: 'pre_implementation',
                path_evidence_source: 'explicit_scope',
                visible_summary_line: 'Optional skills: telegram-tdlight (reason: task_text+paths)'
            }
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.deepEqual(result.optional_skill_selection?.selected_skill_ids, ['telegram-tdlight']);
        assert.deepEqual(result.optional_skill_selection?.selected_skill_sources, ['custom_live']);
        assert.deepEqual(result.optional_skill_selection?.selected_skill_details, [{
            id: 'telegram-tdlight',
            pack: 'custom',
            source: 'custom_live',
            allowed_skill_path: 'garda-agent-orchestrator/live/skills/telegram-tdlight/SKILL.md'
        }]);
        assert.match(
            text,
            /^OptionalSkillSelectedDetails: telegram-tdlight:custom_live:garda-agent-orchestrator\/live\/skills\/telegram-tdlight\/SKILL\.md$/mu
        );
    });

    it('routes mandatory missing-pack decisions to optional-skill remediation before compile', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:04.000Z',
            policy_mode: 'mandatory',
            decision: 'recommended_missing_packs',
            selection_phase: 'pre_implementation',
            path_evidence_source: 'explicit_scope',
            selected_installed_skills: [],
            recommended_missing_packs: [
                {
                    id: 'telegram-bot',
                    pack: 'telegram-bot',
                    reason_codes: ['task_signals'],
                    matches: { task_signals: ['telegram bot'], changed_path_signals: [] }
                }
            ],
            as_is_reason: 'no_relevant_installed_skill',
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/bot/telegram.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: recommended_missing_packs (packs: telegram-bot, reason: task_text)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/bot/telegram.ts'],
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'mandatory',
                decision: 'recommended_missing_packs',
                selection_phase: 'pre_implementation',
                path_evidence_source: 'explicit_scope',
                visible_summary_line: 'Optional skills: recommended_missing_packs (packs: telegram-bot, reason: task_text)'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        materializePreflightReviewPolicyEvidence(repoRoot, TASK_ID, preflightPath);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(preflightPath),
            effective_review_snapshot: readEffectiveReviewSnapshot(repoRoot, TASK_ID)
        }, '2026-01-01T00:00:04.500Z');
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'optional-skill-remediation');
        assert.equal(result.commands.length, 1);
        assert.equal(result.commands[0]?.label, 'Install optional skill pack telegram-bot');
        assert.match(result.commands[0]?.command || '', /skills add "telegram-bot" --target-root "\."/u);
        assert.match(result.reason, /Install or create an appropriate specialist skill/u);
        assert.equal(text.split('\n')[0], 'Next action:');
        assert.match(text, /^  Gate: optional-skill-remediation$/mu);
        assert.match(text, /^  Command: node bin\/garda\.js skills add "telegram-bot" --target-root "\."$/mu);
        assert.equal((text.match(/^Commands:$/gmu) || []).length, 1);
        assert.match(text, /^OptionalSkillDecision: policy=mandatory; decision=recommended_missing_packs;/mu);
        assert.match(result.title, /Resolve mandatory optional-skill selection/u);
        assert.match(text, /^  Do: Install optional skill pack telegram-bot$/mu);
        assert.doesNotMatch(text, /^Title:/mu);
    });

    it('rejects stale mandatory as_is loops when installed suggestion requires rematerialization', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        seedDevopsSuggestionSurface(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'docker-compose.yml'), 'services: {}\n', 'utf8');
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:04.000Z',
            policy_mode: 'mandatory',
            decision: 'as_is',
            selected_installed_skills: [],
            recommended_missing_packs: [],
            as_is_reason: 'no_relevant_installed_skill',
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/main/kotlin/App.kt'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: as_is (reason: no_relevant_installed_skill)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/main/kotlin/App.kt'],
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'mandatory',
                decision: 'as_is',
                visible_summary_line: 'Optional skills: as_is (reason: no_relevant_installed_skill)'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        materializePreflightReviewPolicyEvidence(repoRoot, TASK_ID, preflightPath);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(preflightPath),
            effective_review_snapshot: readEffectiveReviewSnapshot(repoRoot, TASK_ID)
        }, '2026-01-01T00:00:04.500Z');
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'optional-skill-remediation');
        assert.equal(result.commands.length, 1);
        assert.equal(result.commands[0]?.label, 'Rematerialize optional skill selection');
        assert.match(result.commands[0]?.command || '', /gate classify-change/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /skills suggest/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /skills add/u);
        assert.match(result.reason, /devops-k8s/u);
        assert.match(result.reason, /Do not treat the current as_is\/missing-pack decision as activation/u);
    });

    it('rejects replaced recommended_missing_packs when the pack is already installed', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        seedDevopsSuggestionSurface(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'docker-compose.yml'), 'services: {}\n', 'utf8');
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:04.000Z',
            policy_mode: 'mandatory',
            decision: 'recommended_missing_packs',
            selection_phase: 'pre_implementation',
            path_evidence_source: 'explicit_scope',
            selected_installed_skills: [],
            recommended_missing_packs: [
                {
                    id: 'devops-k8s',
                    pack: 'devops-k8s',
                    reason_codes: ['stack_signals'],
                    matches: { task_signals: [], changed_path_signals: [], stack_signals: ['docker-compose.yml'] }
                }
            ],
            as_is_reason: 'no_relevant_installed_skill',
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/main/kotlin/App.kt'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: recommended_missing_packs (packs: devops-k8s, reason: project_discovery)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/main/kotlin/App.kt'],
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'mandatory',
                decision: 'recommended_missing_packs',
                selection_phase: 'pre_implementation',
                path_evidence_source: 'explicit_scope',
                visible_summary_line: 'Optional skills: recommended_missing_packs (packs: devops-k8s, reason: project_discovery)'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        materializePreflightReviewPolicyEvidence(repoRoot, TASK_ID, preflightPath);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(preflightPath),
            effective_review_snapshot: readEffectiveReviewSnapshot(repoRoot, TASK_ID)
        }, '2026-01-01T00:00:04.500Z');
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'optional-skill-remediation');
        assert.equal(result.commands.length, 1);
        assert.equal(result.commands[0]?.label, 'Rematerialize optional skill selection');
        assert.match(result.commands[0]?.command || '', /gate classify-change/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /skills add/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /skills suggest/u);
        assert.match(result.reason, /devops-k8s/u);
    });

    it('blocks optional-policy as_is decisions from mandatory remediation', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:04.000Z',
            policy_mode: 'optional',
            decision: 'as_is',
            selected_installed_skills: [],
            recommended_missing_packs: [],
            as_is_reason: 'generic_context_sufficient',
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/bot/telegram.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/bot/telegram.ts'],
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'optional',
                decision: 'as_is',
                visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        materializePreflightReviewPolicyEvidence(repoRoot, TASK_ID, preflightPath);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(preflightPath),
            effective_review_snapshot: readEffectiveReviewSnapshot(repoRoot, TASK_ID)
        }, '2026-01-01T00:00:04.500Z');
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'optional-skill-remediation', result.reason);
        assert.ok(!result.commands.some((entry) => entry.command.includes('skills suggest')));
        assert.ok(!result.commands.some((entry) => entry.command.includes('skills add')));
        assert.equal(result.optional_skill_selection?.policy_mode, 'optional');
    });

    it('does not route optional-policy missing-pack decisions to remediation', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:04.000Z',
            policy_mode: 'optional',
            decision: 'recommended_missing_packs',
            selection_phase: 'pre_implementation',
            path_evidence_source: 'explicit_scope',
            selected_installed_skills: [],
            recommended_missing_packs: [
                {
                    id: 'telegram-bot',
                    pack: 'telegram-bot',
                    reason_codes: ['task_signals'],
                    matches: { task_signals: ['telegram bot'], changed_path_signals: [] }
                }
            ],
            as_is_reason: 'no_relevant_installed_skill',
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: ['src/bot/telegram.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: recommended_missing_packs (packs: telegram-bot, reason: task_text)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/bot/telegram.ts'],
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'optional',
                decision: 'recommended_missing_packs',
                selection_phase: 'pre_implementation',
                path_evidence_source: 'explicit_scope',
                visible_summary_line: 'Optional skills: recommended_missing_packs (packs: telegram-bot, reason: task_text)'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        materializePreflightReviewPolicyEvidence(repoRoot, TASK_ID, preflightPath);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(preflightPath),
            effective_review_snapshot: readEffectiveReviewSnapshot(repoRoot, TASK_ID)
        }, '2026-01-01T00:00:04.500Z');
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'optional-skill-remediation', result.reason);
        assert.ok(!result.commands.some((entry) => entry.command.includes('skills add')));
        assert.equal(result.optional_skill_selection?.policy_mode, 'optional');
    });

    it('does not route mandatory baseline-only as_is selection to skills suggest remediation', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:04.000Z',
            policy_mode: 'mandatory',
            decision: 'as_is',
            selected_installed_skills: [],
            recommended_missing_packs: [],
            as_is_reason: 'low_confidence_match',
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256(TASK_TITLE),
            changed_paths: [],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: as_is (reason: low_confidence_match)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'empty',
            changed_files: [],
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'mandatory',
                decision: 'as_is',
                visible_summary_line: 'Optional skills: as_is (reason: low_confidence_match)'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        materializePreflightReviewPolicyEvidence(repoRoot, TASK_ID, preflightPath);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', {
            output_path: normalizeForTimeline(preflightPath),
            effective_review_snapshot: readEffectiveReviewSnapshot(repoRoot, TASK_ID)
        }, '2026-01-01T00:00:04.500Z');
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'optional-skill-remediation', result.reason);
        assert.ok(!result.commands.some((entry) => entry.command.includes('skills suggest')));
        assert.equal(result.optional_skill_selection?.changed_paths_count, 0);
    });

    it('rejects stale mandatory artifact after policy switches to optional without activation commands', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'mandatory' });
        seedOptionalSkillSelectionPolicy(repoRoot, 'optional');
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'classify-change');
        assert.equal(result.optional_skill_selection?.current_policy_mode, 'optional');
        assert.equal(result.optional_skill_selection?.policy_mode, 'optional');
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.activation_commands, []);
        assert.ok(
            result.optional_skill_selection?.artifact_violations.some((entry) => (
                entry.includes("must match the current policy mode 'optional'")
            ))
        );
        assert.match(result.commands[0]?.command || '', /gate classify-change/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /activate-optional-skill/u);
        assert.match(text, /^OptionalSkillCurrentPolicyMode: optional$/mu);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
        assert.doesNotMatch(text, /gate activate-optional-skill/u);
    });

    it('rejects stale optional artifact after policy switches to mandatory instead of activation', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'optional' });
        seedOptionalSkillSelectionPolicy(repoRoot, 'mandatory');
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'classify-change');
        assert.equal(result.optional_skill_selection?.current_policy_mode, 'mandatory');
        assert.equal(result.optional_skill_selection?.policy_mode, 'mandatory');
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.activation_commands, []);
        assert.ok(
            result.optional_skill_selection?.artifact_violations.some((entry) => (
                entry.includes("must match the current policy mode 'mandatory'")
            ))
        );
        assert.match(result.commands[0]?.command || '', /gate classify-change/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /activate-optional-skill/u);
        assert.match(text, /^OptionalSkillCurrentPolicyMode: mandatory$/mu);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
    });

    it('rejects forged pending activation when live policy no longer matches the artifact', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'mandatory' });
        seedOptionalSkillSelectionPolicy(repoRoot, 'optional');
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        const optionalSkillArtifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'SKILL_ACTIVATED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection',
            optional_skill_selection_fingerprint_sha256: optionalSkillArtifact.selection_fingerprint_sha256,
            skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        }, '2026-01-01T00:00:06.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'classify-change');
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.activation_commands, []);
        assert.doesNotMatch(result.commands[0]?.command || '', /activate-optional-skill/u);
        assert.match(text, /^OptionalSkillCurrentPolicyMode: optional$/mu);
        assert.doesNotMatch(text, /^OptionalSkillActivatedCurrentCycle:/mu);
        assert.doesNotMatch(text, /^OptionalSkillPendingActivation:/mu);
    });

    it('keeps mandatory activation when live policy config still matches the artifact', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'mandatory' });
        seedOptionalSkillSelectionPolicy(repoRoot, 'mandatory');
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'activate-optional-skill');
        assert.equal(result.optional_skill_selection?.current_policy_mode, 'mandatory');
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(result.commands[0]?.command || '', /gate activate-optional-skill/u);
        assert.match(text, /^OptionalSkillCurrentPolicyMode: mandatory$/mu);
    });
});
