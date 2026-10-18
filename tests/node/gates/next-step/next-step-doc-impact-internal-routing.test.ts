import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { splitCommandLine } from '../../../../src/core/command-line';
import { normalizeReviewTriggerPolicyFromPaths } from '../../../../src/policy/review-trigger-policy';
import { assessDocImpact } from '../../../../src/gates/doc-impact';
import { buildDocImpactCommandPlan } from '../../../../src/gates/next-step/next-step-doc-closeout-readiness';
import {
    createTempRepo, getReviewsRoot, removeTempRepoWithRetry, runCliWithCapturedOutput
} from '../../cli/commands/gate-test-helpers';

const taskId = 'T-1';
const internalChangelog = 'garda-agent-orchestrator/live/docs/changes/CHANGELOG.md';
const memoryFile = 'garda-agent-orchestrator/live/docs/project-memory/compact.md';

function fixture(changedFiles: string[]) {
    const repoRoot = createTempRepo();
    for (const [file, content] of [
        ['TASK.md', '# Task queue\n'],
        ['CHANGELOG.md', '# Public changelog\n'],
        ['docs/guide.md', '# User guide\n'],
        [internalChangelog, '- T-1: internal behavior contract.\n'],
        [memoryFile, '# Current module map\nT-1: current closeout contract.\n']
    ]) {
        const destination = path.join(repoRoot, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
    }
    const preflight = { task_id: taskId, changed_files: changedFiles, triggers: { api: true } };
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, JSON.stringify(preflight));
    return { repoRoot, preflight, preflightPath };
}

function generate(f: ReturnType<typeof fixture>, additional: string[] = []) {
    return buildDocImpactCommandPlan('node bin/garda.js', taskId, f.preflightPath,
        f.preflight, f.repoRoot, additional);
}

function declaredDocs(command: string): string[] {
    const argv = splitCommandLine(command);
    return argv.flatMap((value, index) => value === '--docs-updated' ? [argv[index + 1]] : []);
}

test('generated doc-impact uses frozen source/test roles and actual behavioral scope without a public changelog', async () => {
    const f = fixture(['docs/view.mdx', 'quality/test.md', 'README.md', memoryFile]);
    try {
        const configPath = path.join(f.repoRoot, 'garda-agent-orchestrator/live/config/paths.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const roles = { file_roles: { 'docs/view.mdx': 'source', 'quality/test.md': 'test' } };
        fs.writeFileSync(configPath, JSON.stringify(roles));
        fs.mkdirSync(path.join(f.repoRoot, 'quality'), { recursive: true });
        fs.writeFileSync(path.join(f.repoRoot, 'docs/view.mdx'), 'export default function View() {}\n');
        fs.writeFileSync(path.join(f.repoRoot, 'quality/test.md'), 'purchase assertion\n');
        Object.assign(f.preflight, { scope_category: 'mixed', profile_policy_snapshot: {
            review_trigger_policy: normalizeReviewTriggerPolicyFromPaths(roles)
        } });
        fs.writeFileSync(f.preflightPath, JSON.stringify(f.preflight));
        const plan = generate(f);
        assert.deepEqual(declaredDocs(plan.command), ['README.md']);
        assert.match(plan.command, /--behavior-changed true/u);
        assert.match(plan.command, /--changelog-updated false/u);
        assert.match(plan.command, /--project-memory-updated true/u);
        assert.equal(plan.requiresProjectMemoryBeforeAssessment, true);
        const result = await runCliWithCapturedOutput(splitCommandLine(plan.command).slice(2), { cwd: f.repoRoot });
        assert.equal(result.exitCode, 0, [...result.logs, ...result.errors].join('\n'));
    } finally { removeTempRepoWithRetry(f.repoRoot); }
});

test('generated mixed closeout command routes internal evidence separately and the real CLI gate accepts it', async () => {
    const f = fixture(['src/app.ts', 'docs/guide.md', 'CHANGELOG.md', 'TASK.md', internalChangelog, memoryFile]);
    try {
        const plan = generate(f, ['TASK.md', internalChangelog, memoryFile, 'docs/guide.md']);
        assert.deepEqual(declaredDocs(plan.command), ['CHANGELOG.md', 'docs/guide.md']);
        assert.match(plan.command, /--internal-changelog-updated true/u);
        assert.match(plan.command, /--project-memory-updated true/u);
        assert.match(plan.command, /--changelog-updated true/u);
        assert.match(plan.command, /--sensitive-scope-reviewed true/u);
        const result = await runCliWithCapturedOutput(splitCommandLine(plan.command).slice(2), { cwd: f.repoRoot });
        assert.equal(result.exitCode, 0, [...result.logs, ...result.errors].join('\n'));
        const artifact = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(f.repoRoot), `${taskId}-doc-impact.json`), 'utf8'));
        assert.deepEqual(artifact.docs_updated, ['CHANGELOG.md', 'docs/guide.md']);
        assert.equal(artifact.internal_changelog_updated, true);
        assert.equal(artifact.project_memory_updated, true);
    } finally { removeTempRepoWithRetry(f.repoRoot); }
});

test('generated internal-only command has no user docs and retains explicit internal fields', async () => {
    const f = fixture(['TASK.md', internalChangelog, memoryFile]);
    try {
        const plan = generate(f);
        assert.deepEqual(declaredDocs(plan.command), []);
        assert.match(plan.command, /--decision "NO_DOC_UPDATES"/u);
        assert.match(plan.command, /--changelog-updated false/u);
        assert.match(plan.command, /--internal-changelog-updated true/u);
        assert.match(plan.command, /--project-memory-updated true/u);
        const result = await runCliWithCapturedOutput(splitCommandLine(plan.command).slice(2), { cwd: f.repoRoot });
        assert.equal(result.exitCode, 0, [...result.logs, ...result.errors].join('\n'));
    } finally { removeTempRepoWithRetry(f.repoRoot); }
});

test('collected and additional path aliases cannot reclassify internal evidence as user documentation', async () => {
    const f = fixture([]);
    try {
        const aliases = [' ./TASK.md ', 'TaSk.MD', './' + internalChangelog,
            internalChangelog.replaceAll('/', '\\'), path.join(f.repoRoot, internalChangelog),
            'garda-agent-orchestrator/live/docs/changes/../changes/CHANGELOG.md',
            './' + memoryFile, path.join(f.repoRoot, memoryFile),
            ...['TASK.md', internalChangelog, memoryFile].map(file => `../${path.basename(f.repoRoot)}/${file}`)];
        for (const source of ['collected', 'additional']) {
            f.preflight.changed_files = source === 'collected' ? aliases : [];
            const plan = generate(f, source === 'additional' ? aliases : []);
            assert.deepEqual(declaredDocs(plan.command), [], source);
            assert.match(plan.command, /--internal-changelog-updated true/u);
            assert.match(plan.command, /--project-memory-updated true/u);
            const result = await runCliWithCapturedOutput(splitCommandLine(plan.command).slice(2), { cwd: f.repoRoot });
            assert.equal(result.exitCode, 0, [...result.logs, ...result.errors].join('\n'));
            const artifact = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(f.repoRoot), `${taskId}-doc-impact.json`), 'utf8'));
            assert.deepEqual(artifact.docs_updated, []);
            assert.equal(artifact.internal_changelog_updated, true);
            assert.equal(artifact.project_memory_updated, true);
        }
    } finally { removeTempRepoWithRetry(f.repoRoot); }
});

test('internal changelog evidence rejects sibling and descendant task prefixes', () => {
    const f = fixture([]);
    try {
        const rejectedStatuses: string[] = [];
        for (const reference of ['T-10', 'T-1A', 'XT-1', 'T-1-1']) {
            fs.writeFileSync(path.join(f.repoRoot, internalChangelog), `- ${reference}: another task.\n`);
            const result = assessDocImpact({ preflightPath: f.preflightPath, taskId, repoRoot: f.repoRoot,
                decision: 'NO_DOC_UPDATES', behaviorChanged: true, internalChangelogUpdated: true,
                sensitiveReviewed: true, rationale: 'Task-scoped internal closeout evidence is required.' });
            rejectedStatuses.push(result.status);
            assert.equal(result.internal_closeout_evidence.internal_changelog_sha256, null);
        }
        assert.deepEqual(rejectedStatuses, ['FAILED', 'FAILED', 'FAILED', 'FAILED']);
        fs.writeFileSync(path.join(f.repoRoot, internalChangelog), '- [T-1]: exact task evidence.\n');
        const accepted = assessDocImpact({ preflightPath: f.preflightPath, taskId, repoRoot: f.repoRoot,
            decision: 'NO_DOC_UPDATES', behaviorChanged: true, internalChangelogUpdated: true,
            sensitiveReviewed: true, rationale: 'Task-scoped internal closeout evidence is required.' });
        assert.equal(accepted.status, 'PASSED');
    } finally { removeTempRepoWithRetry(f.repoRoot); }
});

test('optional task-scoped memory evidence excludes another task while preserving map-only compatibility', () => {
    const f = fixture([]);
    try {
        for (const text of ['T-10: another task.', '# Current module map without task IDs']) {
            fs.writeFileSync(path.join(f.repoRoot, memoryFile), text);
            const result = assessDocImpact({ preflightPath: f.preflightPath, taskId, repoRoot: f.repoRoot,
                decision: 'NO_DOC_UPDATES', projectMemoryUpdated: true, sensitiveReviewed: true,
                rationale: 'Memory update proof remains owned by project-memory-impact.' });
            assert.equal(result.status, 'PASSED');
            assert.deepEqual(result.internal_closeout_evidence.project_memory_files, []);
        }
    } finally { removeTempRepoWithRetry(f.repoRoot); }
});
