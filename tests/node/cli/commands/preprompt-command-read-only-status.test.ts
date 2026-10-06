import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { withRuntimeMutationGeneration } from '../../../../src/gate-runtime/runtime-mutation-generation';
import { getStatusSnapshot } from '../../../../src/validators/status';
import { collectRuntimeToxinScanWithCache } from '../../../../src/runtime/toxin-snapshot-cache';
import { createTempRepo, seedTaskQueue, seedInitAnswers, runCliWithCapturedOutput } from './gate-test-helpers';

const TASK_ID = 'T-137';
const CACHE_NAMES = ['.toxin-snapshot-cache.json', '.toxin-snapshot-cache.anchor.json'];

function seedCanonicalGeneration(repoRoot: string): void {
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const fixtureFile = path.join(bundleRoot, 'runtime/reviews/diagnostic-fixture.log');
    fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
    withRuntimeMutationGeneration(bundleRoot, 'diagnostic-fixture', () => fs.appendFileSync(fixtureFile, 'Runtime changed\n'));
    assert.ok(fs.existsSync(path.join(repoRoot, 'garda-agent-orchestrator/runtime/.runtime-mutation-generation.anchor.json')));
}

function fixture(t: TestContext): string {
    const repoRoot = createTempRepo(t);
    seedTaskQueue(repoRoot, TASK_ID);
    seedInitAnswers(repoRoot, 'Codex');
    seedCanonicalGeneration(repoRoot);
    return repoRoot;
}

function cachePaths(repoRoot: string): string[] {
    return CACHE_NAMES.map(name => path.join(repoRoot, 'garda-agent-orchestrator/runtime', name));
}

function fileSnapshot(repoRoot: string): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else result[path.relative(repoRoot, file)] = `${fs.statSync(file).mtimeMs}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
        }
    };
    visit(repoRoot);
    return result;
}

test('preprompt task JSON preserves files when the metrics cache is missing', async t => {
    const repoRoot = fixture(t);
    assert.deepEqual(cachePaths(repoRoot).map(file => fs.existsSync(file)), [false, false]);
    const before = fileSnapshot(repoRoot);
    const result = await runCliWithCapturedOutput(['preprompt', 'task', '--task-id', TASK_ID, '--json'], { cwd: repoRoot });
    assert.equal(result.exitCode, 0, result.errors.join('\n'));
    const brief = JSON.parse(result.logs.join('\n'));
    assert.equal(brief.schema_version, 3);
    assert.equal(brief.task.id, TASK_ID);
    assert.equal(typeof brief.workspace.status_compact, 'string');
    assert.deepEqual(fileSnapshot(repoRoot), before);
});

test('preprompt task text preserves files when the metrics cache is stale', async t => {
    const repoRoot = fixture(t);
    assert.ok(getStatusSnapshot(repoRoot).toxinMetricsSummary);
    assert.deepEqual(cachePaths(repoRoot).map(file => fs.existsSync(file)), [true, true]);
    seedCanonicalGeneration(repoRoot);
    const before = fileSnapshot(repoRoot);
    const result = await runCliWithCapturedOutput(['preprompt', 'task', '--task-id', TASK_ID], { cwd: repoRoot });
    assert.equal(result.exitCode, 0, result.errors.join('\n'));
    assert.match(result.logs.join('\n'), /T-137/);
    assert.deepEqual(fileSnapshot(repoRoot), before);
});

test('ordinary status snapshots still populate and refresh their metrics cache', t => {
    const repoRoot = fixture(t);
    assert.ok(getStatusSnapshot(repoRoot).toxinMetricsSummary);
    assert.deepEqual(cachePaths(repoRoot).map(file => fs.existsSync(file)), [true, true]);
    const before = cachePaths(repoRoot).map(file => fs.readFileSync(file, 'utf8'));
    seedCanonicalGeneration(repoRoot);
    assert.ok(getStatusSnapshot(repoRoot).toxinMetricsSummary);
    assert.notDeepEqual(cachePaths(repoRoot).map(file => fs.readFileSync(file, 'utf8')), before);
});

test('read-only diagnostics reuse a valid metrics cache without a fresh runtime scan', async t => {
    const repoRoot = fixture(t);
    assert.ok(getStatusSnapshot(repoRoot).toxinMetricsSummary);
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const before = fileSnapshot(repoRoot);
    const scan = collectRuntimeToxinScanWithCache({
        orchestratorRoot: bundleRoot,
        runtimeRoot: path.join(bundleRoot, 'runtime'),
        cleanupMaxAgeDays: 30,
        nowMs: Date.now(),
        cacheEnabled: true,
        readOnly: true,
        collectFresh: () => assert.fail('A valid metrics cache must be reused')
    });
    assert.ok(scan.runtimeTotalBytes > 0);
    const result = await runCliWithCapturedOutput(['preprompt', 'task', '--task-id', TASK_ID, '--json'], { cwd: repoRoot });
    assert.equal(result.exitCode, 0, result.errors.join('\n'));
    assert.deepEqual(fileSnapshot(repoRoot), before);
});
