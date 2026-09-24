import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildRulePackArtifact } from '../../../../src/gates/rule-pack/rule-pack-artifact-build';
import { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
import { createTempRepo, getReviewsRoot } from '../../cli/commands/gate-test-repo-bootstrap';
import { bindFixtureEffectiveReviewSnapshot } from '../../cli/commands/gate-test-seed-helpers';

const TASK_ID = 'T-040-TEST';
const REQUIRED_ENTRY_FILES = [
    '00-core.md', '15-project-memory.md', '40-commands.md',
    '80-task-workflow.md', '90-skill-catalog.md'
];

function seedTaskEntry(repoRoot: string, depth = 2): void {
    const taskModePath = path.join(getReviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
    fs.mkdirSync(path.dirname(taskModePath), { recursive: true });
    fs.writeFileSync(taskModePath, JSON.stringify(buildTaskModeArtifact({
        taskId: TASK_ID,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: depth,
        effectiveDepth: depth,
        taskSummary: 'Build rule-pack test artifact',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    })), 'utf8');
    appendTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered', {
        artifact_path: taskModePath.replace(/\\/gu, '/')
    });
}

function seedPostPreflight(repoRoot: string): string {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    const changedFile = 'tests/node/rule-pack-fixture.test.ts';
    fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, changedFile), 'export {};\n', 'utf8');
    const requiredReviews = Object.fromEntries([
        'code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency'
    ].map((lane) => [lane, lane === 'test']));
    fs.writeFileSync(preflightPath, JSON.stringify({
        task_id: TASK_ID,
        mode: 'FULL_PATH',
        scope_category: 'test-only',
        changed_files: [changedFile],
        risk_aware_depth: { effective_depth: 2 },
        required_reviews: requiredReviews
    }), 'utf8');
    bindFixtureEffectiveReviewSnapshot(repoRoot, TASK_ID, 'test', preflightPath, '');
    appendTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight classified', {
        output_path: preflightPath.replace(/\\/gu, '/')
    });
    return preflightPath;
}

test('rule-pack builder records a valid task-entry stage and hashes the selected files', (t) => {
    const repoRoot = createTempRepo(t);
    seedTaskEntry(repoRoot);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId: TASK_ID,
        stage: 'TASK_ENTRY',
        loadedRuleFiles: REQUIRED_ENTRY_FILES
    });
    const entry = artifact.stages.task_entry;
    assert.equal(artifact.status, 'PASSED');
    assert.equal(artifact.latest_stage, 'TASK_ENTRY');
    assert.equal(entry?.effective_depth, 2);
    assert.deepEqual(entry?.missing_rule_files, []);
    assert.deepEqual(entry?.extra_rule_files, []);
    assert.equal(entry?.required_rule_count, REQUIRED_ENTRY_FILES.length);
    assert.ok(entry?.required_rule_files.every((file) => {
        const expectedHash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        return entry.required_rule_hashes[file] === expectedHash
            && entry.loaded_rule_hashes[file] === expectedHash;
    }));
});

test('rule-pack builder reports missing and extra rules while deduplicating loaded paths', (t) => {
    const repoRoot = createTempRepo(t);
    seedTaskEntry(repoRoot);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId: TASK_ID,
        stage: 'TASK_ENTRY',
        loadedRuleFiles: [
            '00-core.md', '00-core.md', '40-commands.md',
            '80-task-workflow.md', '90-skill-catalog.md', '30-code-style.md'
        ]
    });
    const entry = artifact.stages.task_entry;
    assert.equal(artifact.status, 'FAILED');
    assert.equal(entry?.loaded_rule_count, 5);
    assert.match(entry?.missing_rule_files.join(' ') || '', /15-project-memory\.md/u);
    assert.match(entry?.extra_rule_files.join(' ') || '', /30-code-style\.md/u);
    assert.match(entry?.violations.join(' ') || '', /Missing required downstream rule files/u);
    assert.throws(() => buildRulePackArtifact({
        repoRoot,
        taskId: TASK_ID,
        stage: 'POST_PREFLIGHT',
        loadedRuleFiles: REQUIRED_ENTRY_FILES
    }), /PreflightPath is required for POST_PREFLIGHT/u);
});

test('rule-pack builder binds post-preflight selection to the classified task', (t) => {
    const repoRoot = createTempRepo(t);
    seedTaskEntry(repoRoot, 1);
    const entryArtifact = buildRulePackArtifact({
        repoRoot,
        taskId: TASK_ID,
        stage: 'TASK_ENTRY',
        loadedRuleFiles: ['00-core.md', '40-commands.md', '80-task-workflow.md']
    });
    fs.writeFileSync(path.join(getReviewsRoot(repoRoot), `${TASK_ID}-rule-pack.json`),
        JSON.stringify(entryArtifact), 'utf8');
    const preflightPath = seedPostPreflight(repoRoot);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId: TASK_ID,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        loadedRuleFiles: REQUIRED_ENTRY_FILES
    });
    const post = artifact.stages.post_preflight;
    assert.equal(artifact.latest_stage, 'POST_PREFLIGHT');
    assert.equal(artifact.status, 'PASSED', post?.violations.join('\n'));
    assert.deepEqual(artifact.stages.task_entry, entryArtifact.stages.task_entry);
    assert.equal(post?.effective_depth, 2);
    assert.equal(artifact.stages.task_entry?.required_rule_count, 3);
    assert.equal(post?.required_rule_count, 5);
    assert.equal(post?.preflight_path, preflightPath.replace(/\\/gu, '/'));
    assert.equal(post?.required_reviews?.test, true);
    assert.equal(post?.missing_rule_files.length, 0);
    assert.ok(post?.preflight_rule_pack_binding_sha256);
});

test('rule-pack builder propagates empty loaded files and missing task evidence', (t) => {
    const repoRoot = createTempRepo(t);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId: TASK_ID,
        stage: 'TASK_ENTRY',
        loadedRuleFiles: []
    });
    assert.equal(artifact.status, 'FAILED');
    assert.equal(artifact.stages.task_entry?.loaded_rule_count, 0);
    assert.equal(artifact.stages.task_entry?.missing_rule_files.length, REQUIRED_ENTRY_FILES.length);
    assert.match(artifact.stages.task_entry?.violations.join(' ') || '', /Explicit loaded rule file list is required/u);
    assert.match(artifact.stages.task_entry?.violations.join(' ') || '', /Task-mode entry evidence missing/u);
});
