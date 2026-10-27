import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { initGitRepo } from '../git-fixtures';

import {
    formatNextStepText,
    resolveNextStep,
    resolveNextStepDecisionRoute
} from './next-step-test-support';
import {
    getProviderRuntimeEnvironmentKeys
} from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { writeBalancedTestProfilesConfig } from './next-step-test-support';
import { buildDomainScopeFingerprints } from './next-step-test-support';
import { createNextStepResolutionContext } from '../../../../src/gates/next-step/next-step-resolution-context';
import { resolveNextStepFromCliOptions } from '../../../../src/gates/next-step/next-step';
import { readFailedTaskModePublicationRecoveryRoute } from '../../../../src/gates/next-step/next-step-startup-routing';

const TASK_ID = 'T-NEXT-1';
const EXPECTED_LOOP_LINE = 'Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints.';

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
const PROVIDER_ENV_KEYS = getProviderRuntimeEnvironmentKeys();

function withProviderEnv<T>(updates: Record<string, string | undefined>, callback: () => T): T {
    const previousValues = new Map<string, string | undefined>();
    for (const key of PROVIDER_ENV_KEYS) {
        previousValues.set(key, process.env[key]);
        delete process.env[key];
    }
    for (const [key, value] of Object.entries(updates)) {
        if (value == null) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    try {
        return callback();
    } finally {
        for (const [key, value] of previousValues) {
            if (value == null) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
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


function seedTaskModeOnly(
    repoRoot: string,
    taskId: string,
    options: { requestedDepth?: number; effectiveDepth?: number } = {}
): void {
    const requestedDepth = options.requestedDepth ?? 2;
    const effectiveDepth = options.effectiveDepth ?? requestedDepth;
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth,
        effectiveDepth,
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












afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step startup routing', () => {
    it('previews explicit reset after failed publication removes the frozen task-mode artifact', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            artifact_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`)
        });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTRY_FAILED', 'FAIL', { reason: 'EPERM: private authority publication denied' });
        fs.unlinkSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`));

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'task-reset');
        assert.match(result.reason, /missing frozen policy snapshot/);
        assert.match(result.reason, /EPERM: private authority publication denied/);
        assert.equal(result.commands[0].command,
            `node bin/garda.js gate task-reset --task-id "${TASK_ID}" --reopen --dry-run --repo-root "."`);
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`)), false);
        assert.equal(fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8').includes('TASK_MODE_ENTRY_FAILED'), true);
    });

    it('does not reset a missing task-mode artifact without a current publication failure', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        fs.unlinkSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`));

        assert.notEqual(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, 'task-reset');
    });

    it('ignores an older failed publication after successful re-entry', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTRY_FAILED', 'FAIL', { reason: 'old publication failure' });
        seedStartedTask(repoRoot, TASK_ID);

        assert.notEqual(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, 'task-reset');
    });

    it('does not revive a failed cycle after a newer entry loses its artifact', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTRY_FAILED', 'FAIL', { reason: 'old failure' });
        seedStartedTask(repoRoot, TASK_ID);
        fs.unlinkSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`));

        assert.notEqual(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, 'task-reset');
    });

    it('does not offer canonical reset for alternate event stores or altered failure history', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', { artifact_path: taskModePath });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTRY_FAILED', 'FAIL', { reason: 'current failure' });
        fs.unlinkSync(taskModePath);
        const alternateEvents = path.join(repoRoot, 'alternate-events');
        fs.mkdirSync(alternateEvents);
        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        fs.copyFileSync(timelinePath, path.join(alternateEvents, `${TASK_ID}.jsonl`));

        assert.equal(readFailedTaskModePublicationRecoveryRoute(repoRoot, alternateEvents, TASK_ID,
            'node bin/garda.js', reviewsRoot(repoRoot), taskModePath), null);
        fs.writeFileSync(timelinePath, fs.readFileSync(timelinePath, 'utf8').replace('current failure', 'altered failure'));
        assert.equal(readFailedTaskModePublicationRecoveryRoute(repoRoot, eventsRoot(repoRoot), TASK_ID,
            'node bin/garda.js', reviewsRoot(repoRoot), taskModePath), null);
    });

    it('does not offer canonical reset when alternate review storage selects the native task-mode path', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', { artifact_path: taskModePath });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTRY_FAILED', 'FAIL', { reason: 'current failure' });
        fs.unlinkSync(taskModePath);
        const alternateReviews = path.join(repoRoot, 'alternate-reviews');
        fs.mkdirSync(alternateReviews);

        assert.notEqual(resolveNextStep({ taskId: TASK_ID, repoRoot, reviewsRoot: alternateReviews }).next_gate, 'task-reset');
    });

    it('rejects unverified legacy failures while preserving integrity-bound recovery after a legacy prefix', () => {
        const repoRoot = makeTempRepo();
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const legacy = (event_type: string, outcome: string, details: Record<string, unknown>) => JSON.stringify({
            task_id: TASK_ID, event_type, outcome, details, timestamp_utc: new Date().toISOString()
        });
        fs.writeFileSync(timelinePath, [
            legacy('TASK_MODE_ENTERED', 'PASS', { artifact_path: taskModePath }),
            legacy('TASK_MODE_ENTRY_FAILED', 'FAIL', { reason: 'unverified failure' }), ''
        ].join('\n'));
        appendEvent(repoRoot, TASK_ID, 'DIAGNOSTIC_RECORDED', 'PASS');
        assert.equal(readFailedTaskModePublicationRecoveryRoute(repoRoot, eventsRoot(repoRoot), TASK_ID,
            'node bin/garda.js', reviewsRoot(repoRoot), taskModePath), null);

        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', { artifact_path: taskModePath });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTRY_FAILED', 'FAIL', { reason: 'verified current failure' });
        assert.match(readFailedTaskModePublicationRecoveryRoute(repoRoot, eventsRoot(repoRoot), TASK_ID,
            'node bin/garda.js', reviewsRoot(repoRoot), taskModePath)?.command || '', /task-reset.*--dry-run/);
    });

    it('loads resolution context before routing a fresh task at enter-task-mode', () => {
        const repoRoot = makeTempRepo();
        const context = createNextStepResolutionContext({ taskId: TASK_ID, repoRoot });

        assert.equal(context.repoRoot, path.resolve(repoRoot));
        assert.equal(context.taskId, TASK_ID);
        assert.equal(context.reviewsRoot, reviewsRoot(repoRoot));
        assert.equal(context.eventsRoot, eventsRoot(repoRoot));
        assert.equal(context.cliPrefix, 'node bin/garda.js');
        assert.equal(context.taskModePath, path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`));
        assert.equal(context.preflightPath, path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`));
        assert.equal(context.preflightCommandPath, 'garda-agent-orchestrator/runtime/reviews/T-NEXT-1-preflight.json');
        assert.equal(context.preflight, null);
        assert.equal(context.rulePack, null);
        assert.equal(context.taskMode, null);
        assert.equal(context.preflightSha256, null);

        const result = withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, () => (
            resolveNextStepDecisionRoute(context)
        ));

        assert.equal(result.next_gate, 'enter-task-mode');
        assert.match(result.commands[0]?.command || '', /^node bin\/garda\.js gate enter-task-mode /);
    });

    it('uses a custom reviews root as the active preflight command path', () => {
        const repoRoot = makeTempRepo();
        const customReviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'custom-reviews');
        fs.mkdirSync(customReviewsRoot, { recursive: true });

        const context = createNextStepResolutionContext({
            taskId: TASK_ID,
            repoRoot,
            reviewsRoot: customReviewsRoot
        });

        assert.equal(context.preflightPath, path.join(customReviewsRoot, `${TASK_ID}-preflight.json`));
        assert.equal(context.preflightCommandPath, 'garda-agent-orchestrator/runtime/custom-reviews/T-NEXT-1-preflight.json');
    });

    it('rejects out-of-repo active preflight and reviews roots', () => {
        const repoRoot = makeTempRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-external-reviews-'));
        tempRoots.push(externalRoot);
        const externalPreflightPath = path.join(externalRoot, `${TASK_ID}-preflight.json`);
        writeJson(externalPreflightPath, { task_id: TASK_ID, changed_files: ['src/app.ts'] });

        assert.throws(
            () => createNextStepResolutionContext({
                taskId: TASK_ID,
                repoRoot,
                reviewsRoot: externalRoot
            }),
            /ReviewsRoot must resolve inside repo root without symlink or junction escape/
        );
        assert.throws(
            () => resolveNextStepFromCliOptions({
                repoRoot,
                preflightPath: externalPreflightPath
            }),
            /ReviewsRoot must resolve inside repo root without symlink or junction escape/
        );
    });

    it('points a fresh task at enter-task-mode', () => {
        const repoRoot = makeTempRepo();
        const result = withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, () => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.commands[0].command.includes('gate enter-task-mode'));
        assert.ok(!result.commands[0].command.includes('<'));
        assert.ok(result.commands[0].command.includes('--requested-depth "2"'));
        assert.ok(result.commands[0].command.includes('--task-summary "Make next-step output executable in tests"'));
        assert.equal(result.commands[0].command.includes('--start-banner'), false);
        assert.ok(result.commands[0].command.includes('--provider "Codex"'));
        const text = formatNextStepText(result);
        assert.ok(text.includes(EXPECTED_LOOP_LINE));
        assert.ok(text.includes('AfterCommand: rerun'));
    });

    it('blocks malformed task required-review metadata before printing classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/test | Validate task metadata | gpt-5.6-sol | 2026-08-20 | balanced | Required reviews: code, security, api, and test; Terra High only. |`,
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'task-metadata-validation');
        assert.match(result.reason, /invalid TASK\.md required-review declaration/);
        assert.match(result.reason, /Required reviews: lane, lane\./);
        assert.equal(result.commands.length, 0);
    });

    it('uses task profile depth for fresh task-mode command defaults', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow | Strict profile depth routing | gpt-5.5 | 2026-06-17 | strict | Test queue entry. |`,
            ''
        ].join('\n'), 'utf8');
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), {
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced',
                    depth: 2,
                    review_policy: { code: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true },
                    task_decomposition: { enabled: false }
                },
                strict: {
                    description: 'Strict',
                    depth: 3,
                    review_policy: { code: true, db: true, security: true, refactor: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: false,
                        strip_code_blocks: false,
                        scoped_diffs: true,
                        compact_reviewer_output: false
                    },
                    skills: { auto_suggest: true },
                    task_decomposition: { enabled: false }
                }
            },
            user_profiles: {}
        });

        const result = withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, () => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.commands[0].command.includes('--requested-depth "3"'));
        assert.ok(result.commands[0].command.includes('--provider "Codex"'));
    });

    it('prefers GitHub Copilot runtime markers over a Claude source-of-truth default', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
            SourceOfTruth: 'Claude'
        });

        const result = withProviderEnv({ GITHUB_COPILOT_CLI: '1' }, () => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.commands[0].command.includes('--provider "GitHubCopilot"'));
        assert.equal(result.commands[0].command.includes('--provider "Claude"'), false);
    });

    it('surfaces optional Markdown working-plan metadata on next-step output', () => {
        const repoRoot = makeTempRepo();
        const workingPlanPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'plans', `${TASK_ID}.md`);
        fs.mkdirSync(path.dirname(workingPlanPath), { recursive: true });
        fs.writeFileSync(workingPlanPath, '# Executor working plan\n\n- Optional guidance only.\n', 'utf8');

        const result = withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, () => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        assert.equal(result.next_gate, 'enter-task-mode');
        assert.equal(result.markdown_working_plan?.format, 'markdown');
        assert.equal(result.markdown_working_plan?.working_plan_path, `garda-agent-orchestrator/runtime/plans/${TASK_ID}.md`);
        assert.equal(result.markdown_working_plan?.working_plan_sha256.length, 64);
        const text = formatNextStepText(result);
        assert.ok(text.includes(`MarkdownWorkingPlanPath: garda-agent-orchestrator/runtime/plans/${TASK_ID}.md`));
        assert.ok(text.includes('MarkdownWorkingPlanSha256:'));
    });

    it('keeps Active Queue title when User Summary repeats the task id', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-036';
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '## Active Queue',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${taskId} | TODO | P1 | ai-flow | Implement AI ambiguity handling and manual fallback | gpt-5.4 | 2026-05-16 | balanced | Next-step regression fixture. |`,
            '',
            '## User Summary (RU)',
            '',
            '| ID | Summary |',
            '|---|---|',
            `| ${taskId} | Handles ambiguous AI results and manual fallback. |`,
            ''
        ].join('\n'), 'utf8');

        const result = withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, () => (
            resolveNextStep({ taskId, repoRoot })
        ));

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.commands[0].command.includes('--task-summary "Implement AI ambiguity handling and manual fallback"'));
        assert.ok(!result.commands[0].command.includes('--task-summary "T-036"'));
    });

    it('routes task-mode-only runs to TASK_ENTRY rule-pack loading', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.ok(result.commands[0].command.includes('--stage "TASK_ENTRY"'));
    });

    it('uses compact TASK_ENTRY rules for depth 1 task-mode cycles', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID, { requestedDepth: 1, effectiveDepth: 1 });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.match(command, /00-core\.md/);
        assert.match(command, /40-commands\.md/);
        assert.match(command, /80-task-workflow\.md/);
        assert.doesNotMatch(command, /40-command-reference\.md/);
        assert.doesNotMatch(command, /15-project-memory\.md/);
        assert.doesNotMatch(command, /90-skill-catalog\.md/);
    });

    it('keeps full TASK_ENTRY rules for strict depth 3 task-mode cycles', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID, { requestedDepth: 3, effectiveDepth: 3 });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.match(command, /00-core\.md/);
        assert.match(command, /15-project-memory\.md/);
        assert.match(command, /40-commands\.md/);
        assert.match(command, /80-task-workflow\.md/);
        assert.match(command, /90-skill-catalog\.md/);
        assert.doesNotMatch(command, /40-command-reference\.md/);
    });

    it('preserves custom task-mode path when routing TASK_ENTRY rule-pack loading', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-custom-task-mode.json`);
        writeJson(customTaskModePath, buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Load TASK_ENTRY rules for a custom task-mode artifact',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            artifact_path: normalizeForTimeline(customTaskModePath)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.ok(result.commands[0].command.includes('--stage "TASK_ENTRY"'));
        assert.ok(result.commands[0].command.includes(`--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`));
    });

    it('routes missing handshake and shell-smoke preflight sequentially', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');

        const missingHandshake = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHandshake.next_gate, 'handshake-diagnostics');

        seedHandshake(repoRoot, TASK_ID);
        const missingShellSmoke = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingShellSmoke.next_gate, 'shell-smoke-preflight');
    });

    it('retries failed startup diagnostics instead of advancing to classify-change', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        appendEvent(repoRoot, TASK_ID, 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'FAIL', { passed: false });

        const failedHandshake = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(failedHandshake.next_gate, 'handshake-diagnostics');
        assert.match(failedHandshake.reason, /did not pass/u);

        appendEvent(repoRoot, TASK_ID, 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'PASS', { passed: true });
        appendEvent(repoRoot, TASK_ID, 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'FAIL', { passed: false });

        const failedShellSmoke = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(failedShellSmoke.next_gate, 'shell-smoke-preflight');
        assert.match(failedShellSmoke.reason, /instead of advancing a partial restart cycle/u);
        assert.equal(failedShellSmoke.commands[0].command.includes('gate classify-change'), false);
    });

    it('routes stale TASK_ENTRY rule-pack evidence back to load-rule-pack before classify-change', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '15-project-memory.md'),
            '# 15-project-memory.md\n\nUpdated after initial rule-pack load.\n',
            'utf8'
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.ok(result.reason.includes('stale or invalid'));
        assert.ok(result.reason.includes('15-project-memory.md'));
        assert.ok(result.commands[0].command.includes('--stage "TASK_ENTRY"'));
    });

    it('routes protected source changes to task-mode restart before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n',
            'utf8'
        );
        const protectedPath = path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts');
        fs.mkdirSync(path.dirname(protectedPath), { recursive: true });
        fs.writeFileSync(protectedPath, 'export const protectedBaseline = true;\n', 'utf8');
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.project_memory_maintenance.enabled = false;
        workflowConfig.orchestrator_work_policy = { mode: 'require_operator_confirmation' };
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        initGitRepo(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(protectedPath, 'export const protectedChange = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.match(result.reason, /protected orchestrator control-plane files before classify-change/);
        assert.match(result.reason, /--orchestrator-work/);
        assert.ok(command.includes('gate enter-task-mode'));
        assert.ok(command.includes('--orchestrator-work'));
        assert.ok(command.includes('--operator-confirmed yes'));
        assert.ok(command.includes('--planned-changed-file "src/gates/next-step/next-step.ts"'));
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('preserves task-mode snapshot depth in protected source restart commands', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n',
            'utf8'
        );
        const protectedPath = path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts');
        fs.mkdirSync(path.dirname(protectedPath), { recursive: true });
        fs.writeFileSync(protectedPath, 'export const protectedBaseline = true;\n', 'utf8');
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.project_memory_maintenance.enabled = false;
        workflowConfig.orchestrator_work_policy = { mode: 'require_operator_confirmation' };
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), {
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: { description: 'Balanced', depth: 2, review_policy: { code: true }, token_economy: { enabled: true }, skills: { auto_suggest: true }, task_decomposition: { enabled: false } },
                strict: { description: 'Strict changed later', depth: 2, review_policy: { code: true }, token_economy: { enabled: true }, skills: { auto_suggest: true }, task_decomposition: { enabled: false } }
            },
            user_profiles: {}
        });
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 3,
            effectiveDepth: 3,
            requestedDepthSource: 'profile_default',
            effectiveDepthSource: 'explicit',
            taskSummary: 'Seeded strict profile depth before profile drift',
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
        fs.appendFileSync(protectedPath, 'export const protectedChange = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.ok(command.includes('--requested-depth "3"'));
        assert.ok(command.includes('--effective-depth "3"'));
    });

    it('preserves legacy effective-depth overrides in protected source restart commands', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n',
            'utf8'
        );
        const protectedPath = path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts');
        fs.mkdirSync(path.dirname(protectedPath), { recursive: true });
        fs.writeFileSync(protectedPath, 'export const protectedBaseline = true;\n', 'utf8');
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.project_memory_maintenance.enabled = false;
        workflowConfig.orchestrator_work_policy = { mode: 'require_operator_confirmation' };
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        initGitRepo(repoRoot);
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        writeJson(taskModePath, buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 3,
            taskSummary: 'Legacy effective depth override before depth source fields',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        const legacyTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete legacyTaskMode.requested_depth_source;
        delete legacyTaskMode.effective_depth_source;
        writeJson(taskModePath, legacyTaskMode);
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(protectedPath, 'export const protectedChange = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.ok(command.includes('--requested-depth "2"'));
        assert.ok(command.includes('--effective-depth "3"'));
    });

    it('routes stale preflight with new protected source changes to task-mode restart before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n',
            'utf8'
        );
        const protectedPath = path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts');
        fs.mkdirSync(path.dirname(protectedPath), { recursive: true });
        fs.writeFileSync(protectedPath, 'export const protectedBaseline = true;\n', 'utf8');
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.project_memory_maintenance.enabled = false;
        workflowConfig.orchestrator_work_policy = { mode: 'require_operator_confirmation' };
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        initGitRepo(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        fs.appendFileSync(protectedPath, 'export const protectedStalePreflightChange = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.match(result.reason, /protected orchestrator control-plane files before classify-change/);
        assert.ok(command.includes('gate enter-task-mode'));
        assert.ok(command.includes('--orchestrator-work'));
        assert.ok(command.includes('--planned-changed-file "src/gates/next-step/next-step.ts"'));
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('routes workflow-config changes to workflow-config task-mode restart before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow | Update workflow-config policy changes | gpt-5.4 | 2026-04-25 | balanced | Explicitly owns workflow-config policy changes. |`,
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n',
            'utf8'
        );
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.project_memory_maintenance.enabled = false;
        workflowConfig.orchestrator_work_policy = { mode: 'require_operator_confirmation' };
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        initGitRepo(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        workflowConfig.full_suite_validation.command = 'npm run test:sharded';
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.match(result.reason, /protected orchestrator control-plane files before classify-change/);
        assert.match(result.reason, /--orchestrator-work --workflow-config-work/);
        assert.ok(command.includes('gate enter-task-mode'));
        assert.ok(command.includes('--orchestrator-work'));
        assert.ok(command.includes('--workflow-config-work'));
        assert.ok(command.includes('--operator-confirmed yes'));
        assert.ok(command.includes('--planned-changed-file "garda-agent-orchestrator/live/config/workflow-config.json"'));
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('continues to classify ordinary source changes before preflight', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const ordinaryChange = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.equal(result.commands[0].command.includes('--orchestrator-work'), false);
    });

    it('shares one Git snapshot across next-step audit and readiness consumers', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const sharedSnapshot = true;\n', 'utf8');

        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalSpawnSync = childProcessModule.spawnSync;
        const originalExecFileSync = childProcessModule.execFileSync;
        const gitCommands: string[][] = [];
        childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
            if (command === 'git') gitCommands.push([...args]);
            return originalSpawnSync(command, args, options as never);
        }) as typeof originalSpawnSync;
        childProcessModule.execFileSync = ((command: string, args: string[], options: unknown) => {
            if (command === 'git') gitCommands.push([...args]);
            return originalExecFileSync(command, args, options as never);
        }) as typeof originalExecFileSync;
        try {
            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'classify-change', result.reason);
            assert.equal(gitCommands.filter((args) => args.includes('status')).length, 2, 'one shared observation plus the required A1 final freshness read');
            assert.equal(gitCommands.filter((args) => args.includes('config')).length, 2, 'one shared observation plus the required A1 final freshness read');
            assert.equal(gitCommands.filter((args) => args.includes('--numstat')).length, 2, 'one shared observation plus the required A1 final freshness read');
        } finally {
            childProcessModule.spawnSync = originalSpawnSync;
            childProcessModule.execFileSync = originalExecFileSync;
        }
    });

    it('routes restarted task-mode cycles through fresh startup gates before reusing old preflight', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            restarted: true
        });

        const missingRulePack = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingRulePack.next_gate, 'load-rule-pack');
        assert.match(missingRulePack.reason, /latest TASK_MODE_ENTERED/);

        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        const missingHandshake = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHandshake.next_gate, 'handshake-diagnostics');
        assert.match(missingHandshake.reason, /HANDSHAKE_DIAGNOSTICS_RECORDED/);

        seedHandshake(repoRoot, TASK_ID);
        const missingShellSmoke = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingShellSmoke.next_gate, 'shell-smoke-preflight');
        assert.match(missingShellSmoke.reason, /SHELL_SMOKE_PREFLIGHT_RECORDED/);

        seedShellSmoke(repoRoot, TASK_ID);
        const stalePreflight = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(stalePreflight.next_gate, 'classify-change');
        assert.match(stalePreflight.reason, /Preflight evidence is older than the latest TASK_MODE_ENTERED/);
        assert.ok(stalePreflight.commands[0].command.includes('--changed-file "src/app.ts"'));
    });

    it('keeps stale preflight refresh scoped to planned files when dirty baseline contains older task files', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'older-task.md'), 'older task dirty file\n', 'utf8');
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        writeJson(taskModePath, buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned preflight scope',
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
                changed_files: [
                    'docs/older-task.md'
                ],
                changed_files_sha256: sha256Text('older-task-baseline'),
                scope_sha256: sha256Text('older-task-baseline'),
                file_hashes: {
                    'docs/older-task.md': sha256Text('older task dirty file\n')
                }
            }
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY', taskModePath);
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: ['src/app.ts'],
            seedPostPreflight: false
        });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            restarted: true
        });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY', taskModePath);
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.match(result.reason, /Preflight evidence is older than the latest TASK_MODE_ENTERED/);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('docs/older-task.md'));
    });

    it('routes late TASK_ENTRY after shell-smoke through handshake and shell-smoke recovery in order', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');

        const missingHandshake = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHandshake.next_gate, 'handshake-diagnostics');
        assert.match(missingHandshake.reason, /latest startup rule-pack event/);
        assert.match(missingHandshake.reason, /no HANDSHAKE_DIAGNOSTICS_RECORDED event exists after them/);

        seedHandshake(repoRoot, TASK_ID);
        const missingShellSmoke = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingShellSmoke.next_gate, 'shell-smoke-preflight');
        assert.match(missingShellSmoke.reason, /latest HANDSHAKE_DIAGNOSTICS_RECORDED event/);
    });

    it('ignores late TASK_ENTRY after review phase when the pre-review startup cycle is coherent', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:code-reviewer';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        const lateRulePackPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-late-task-entry-rule-pack.json`);
        writeJson(lateRulePackPath, buildRulePackArtifact({
            repoRoot,
            taskId: TASK_ID,
            stage: 'TASK_ENTRY',
            taskModePath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`),
            loadedRuleFiles: [
                '00-core.md',
                '15-project-memory.md',
                '40-commands.md',
                '80-task-workflow.md',
                '90-skill-catalog.md'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'RULE_PACK_LOADED', 'PASS', {
            stage: 'TASK_ENTRY',
            artifact_path: normalizeForTimeline(lateRulePackPath)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing');
        assert.ok(result.commands[0].command.includes('gate record-review-routing'));
        assert.ok(!result.commands[0].command.includes('handshake-diagnostics'));
        assert.equal(result.commands[0].command.includes('--reviewer-identity'), false);
    });

    it('requires fresh startup diagnostics when late TASK_ENTRY recovers a failed post-preflight rule pack', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:code-reviewer';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        appendEvent(repoRoot, TASK_ID, 'RULE_PACK_LOAD_FAILED', 'FAIL', {
            stage: 'POST_PREFLIGHT'
        });
        const lateRulePackPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-recovery-task-entry-rule-pack.json`);
        writeJson(lateRulePackPath, buildRulePackArtifact({
            repoRoot,
            taskId: TASK_ID,
            stage: 'TASK_ENTRY',
            taskModePath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`),
            loadedRuleFiles: [
                '00-core.md',
                '15-project-memory.md',
                '40-commands.md',
                '80-task-workflow.md',
                '90-skill-catalog.md'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'RULE_PACK_LOADED', 'PASS', {
            stage: 'TASK_ENTRY',
            artifact_path: normalizeForTimeline(lateRulePackPath)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'handshake-diagnostics');
        assert.match(result.reason, /no HANDSHAKE_DIAGNOSTICS_RECORDED event exists after them/);
        assert.ok(result.commands[0].command.includes('gate handshake-diagnostics'));
    });

    it('routes late TASK_ENTRY after review phase through startup recovery before stale preflight refresh', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:security-reviewer';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true }, { seedPostPreflight: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'security', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'security'
        });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const securityFindingFix = true;\n', 'utf8');
        const lateRulePackPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-late-task-entry-rule-pack.json`);
        writeJson(lateRulePackPath, buildRulePackArtifact({
            repoRoot,
            taskId: TASK_ID,
            stage: 'TASK_ENTRY',
            taskModePath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`),
            loadedRuleFiles: [
                '00-core.md',
                '15-project-memory.md',
                '40-commands.md',
                '80-task-workflow.md',
                '90-skill-catalog.md'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'RULE_PACK_LOADED', 'PASS', {
            stage: 'TASK_ENTRY',
            artifact_path: normalizeForTimeline(lateRulePackPath)
        });

        const missingHandshake = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHandshake.next_gate, 'handshake-diagnostics');
        assert.ok(!missingHandshake.commands[0].command.includes('gate classify-change'));

        seedHandshake(repoRoot, TASK_ID);
        const missingShellSmoke = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingShellSmoke.next_gate, 'shell-smoke-preflight');
        assert.ok(!missingShellSmoke.commands[0].command.includes('gate classify-change'));
    });

    it('fails closed for invalid late TASK_ENTRY evidence after review phase', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:code-reviewer';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code'
        });
        appendEvent(repoRoot, TASK_ID, 'RULE_PACK_LOADED', 'PASS', {
            stage: 'TASK_ENTRY',
            artifact_path: normalizeForTimeline(path.join(reviewsRoot(repoRoot), `${TASK_ID}-missing-late-task-entry-rule-pack.json`))
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.match(result.reason, /stale or invalid/);
        assert.ok(result.commands[0].command.includes('gate load-rule-pack'));
        assert.ok(!result.commands[0].command.includes('record-review-routing'));
    });

});
