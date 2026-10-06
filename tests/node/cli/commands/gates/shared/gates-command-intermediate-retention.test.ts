import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { runIntermediateCommandCommand } from '../../../../../../src/cli/commands/gates';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { readTaskOwnedFocusedIntermediateEvidence } from '../../../../../../src/gates/review/focused-intermediate-evidence';
import {
    createTempRepo, getOrchestratorRoot, readTaskTimelineEvents, runCliWithCapturedOutput,
    seedInitAnswers, seedTaskQueue
} from '../../gate-test-helpers';

const TASK_ID = 'T-164-1-RETENTION';
const TEST_PATH = 'tests/node/intermediate-retention.test.ts';
const COMMAND = `node scripts/node-foundation/build-scripts.cjs test.js ${TEST_PATH}`;

function hash(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture(exitCodes = [0, 0]) {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, TASK_ID);
    seedInitAnswers(repoRoot);
    const bundleRoot = getOrchestratorRoot(repoRoot);
    const reviewsRoot = path.join(bundleRoot, 'runtime/reviews');
    const eventsRoot = path.join(bundleRoot, 'runtime/task-events');
    const script = path.join(repoRoot, 'scripts/node-foundation/build-scripts.cjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests/node'), { recursive: true });
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, TEST_PATH), 'export {};\n');
    fs.writeFileSync(script, [
        "const fs = require('node:fs');",
        "const counter = 'attempt-count.txt';",
        'const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) : 0;',
        'fs.writeFileSync(counter, String(attempt + 1));',
        "console.log('attempt-' + attempt);",
        `process.exitCode = ${JSON.stringify(exitCodes)}[attempt] ?? 0;`,
        ''
    ].join('\n'));
    appendTaskEvent(bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Retention test fixture.', {});
    const run = (overrides: Record<string, unknown> = {}) => runIntermediateCommandCommand({
        repoRoot, taskId: TASK_ID, command: COMMAND, commandSource: 'targeted-test', ...overrides
    });
    const events = () => readTaskTimelineEvents(repoRoot, TASK_ID)
        .filter(event => event.event_type === 'INTERMEDIATE_COMMAND_RUN');
    const select = () => readTaskOwnedFocusedIntermediateEvidence({
        repoRoot, reviewsRoot, eventsRoot, taskId: TASK_ID, changedFiles: [TEST_PATH]
    });
    return { repoRoot, reviewsRoot, run, events, select };
}

function assertEventFiles(details: Record<string, unknown>): void {
    const artifactPath = String(details.artifact_path);
    const outputPath = String(details.output_artifact_path);
    assert.equal(hash(artifactPath), details.artifact_sha256);
    assert.equal(hash(outputPath), details.output_artifact_sha256);
    assert.equal(fs.statSync(outputPath).size, details.output_artifact_size_bytes);
    const record = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(record.output_artifact, outputPath);
    assert.equal(record.output_artifact_sha256, details.output_artifact_sha256);
    assert.equal(record.exit_code, details.exit_code);
}

function scheduleConcurrentParentCreation(t: TestContext, sharedParent: string, foreignParent?: string) {
    const nativeFs = require('node:fs') as typeof fs;
    const mkdirSync = nativeFs.mkdirSync;
    const race = { triggered: false };
    t.mock.method(nativeFs, 'mkdirSync', (directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
        if (path.resolve(String(directory)) === sharedParent && !race.triggered) {
            race.triggered = true;
            const createParent = foreignParent
                ? 'require("node:fs").symlinkSync(process.argv[2], process.argv[1], process.platform === "win32" ? "junction" : "dir")'
                : 'require("node:fs").mkdirSync(process.argv[1])';
            const creator = spawnSync(process.execPath, ['-e', createParent, sharedParent, ...(foreignParent ? [foreignParent] : [])], {
                encoding: 'utf8', timeout: 10_000
            });
            assert.equal(creator.status, 0, creator.stderr);
        }
        return mkdirSync(directory, options);
    });
    return race;
}

describe('intermediate command evidence retention', () => {
    for (const exitCodes of [[0, 0], [0, 7], [7, 0], [7, 7]]) {
        it(`retains both attempts and event hashes for repeated outcomes ${exitCodes.join(',')}`, async t => {
            const f = fixture(exitCodes);
            t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
            assert.equal((await f.run()).exitCode, exitCodes[0]);
            const first = f.events()[0].details as Record<string, unknown>;
            const firstArtifact = fs.readFileSync(String(first.artifact_path));
            const firstOutput = fs.readFileSync(String(first.output_artifact_path));
            assert.equal((await f.run()).exitCode, exitCodes[1]);
            const second = f.events()[1].details as Record<string, unknown>;
            assert.notEqual(first.artifact_path, second.artifact_path);
            assert.notEqual(first.output_artifact_path, second.output_artifact_path);
            assert.deepEqual(fs.readFileSync(String(first.artifact_path)), firstArtifact);
            assert.deepEqual(fs.readFileSync(String(first.output_artifact_path)), firstOutput);
            assertEventFiles(first);
            assertEventFiles(second);
            assert.equal(f.select().entries.length, exitCodes.filter(code => code === 0).length);
        });
    }

    for (const reusedPath of ['artifactPath', 'outputPath'] as const) {
        it(`rejects an explicit ${reusedPath} collision before executing or changing evidence`, async t => {
            const f = fixture();
            t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
            const artifactPath = path.join(f.reviewsRoot, 'explicit.json');
            const outputPath = path.join(f.reviewsRoot, 'explicit.log');
            assert.equal((await f.run({ artifactPath, outputPath })).exitCode, 0);
            const first = f.events()[0].details as Record<string, unknown>;
            const nextPaths = {
                artifactPath: path.join(f.reviewsRoot, 'next.json'),
                outputPath: path.join(f.reviewsRoot, 'next.log')
            };
            nextPaths[reusedPath] = reusedPath === 'artifactPath' ? artifactPath : outputPath;
            await assert.rejects(f.run(nextPaths), /already exists|collision/iu);
            assert.equal(fs.readFileSync(path.join(f.repoRoot, 'attempt-count.txt'), 'utf8'), '1');
            assert.equal(f.events().length, 1);
            assertEventFiles(first);
            assert.equal(fs.existsSync(nextPaths[reusedPath === 'artifactPath' ? 'outputPath' : 'artifactPath']), false);
        });
    }

    it('rejects a single path used for both artifacts before execution', async t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const shared = path.join(f.reviewsRoot, 'same.json');
        await assert.rejects(f.run({ artifactPath: shared, outputPath: shared }), /distinct|same path/iu);
        assert.equal(fs.existsSync(path.join(f.repoRoot, 'attempt-count.txt')), false);
        assert.equal(fs.existsSync(shared), false);
        assert.equal(f.events().length, 0);
    });

    it('preserves concurrent default attempts as independently bound evidence', async t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const results = await Promise.all([f.run(), f.run()]);
        assert.ok(results.every(result => result.exitCode === 0));
        const events = f.events();
        assert.equal(events.length, 2);
        const details = events.map(event => event.details as Record<string, unknown>);
        assert.notEqual(details[0].artifact_path, details[1].artifact_path);
        assert.notEqual(details[0].output_artifact_path, details[1].output_artifact_path);
        details.forEach(assertEventFiles);
        assert.equal(f.select().entries.length, 2);
    });

    it('tolerates a concurrent process creating the shared evidence parent', async t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const race = scheduleConcurrentParentCreation(t, path.join(f.reviewsRoot, 'intermediate-attempts'));
        assert.equal((await f.run()).exitCode, 0);
        assert.equal(race.triggered, true);
        assert.equal(f.events().length, 1);
        assertEventFiles(f.events()[0].details as Record<string, unknown>);
        assert.equal(f.select().entries.length, 1);
    });

    it('rejects a junction created by a concurrent process before evidence allocation', async t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const foreignRepoRoot = createTempRepo();
        t.after(() => fs.rmSync(foreignRepoRoot, { recursive: true, force: true }));
        const foreignParent = path.join(foreignRepoRoot, 'evidence');
        fs.mkdirSync(foreignParent);
        const race = scheduleConcurrentParentCreation(t, path.join(f.reviewsRoot, 'intermediate-attempts'), foreignParent);
        await assert.rejects(f.run(), /symlink|junction/iu);
        assert.equal(race.triggered, true);
        assert.equal(fs.existsSync(path.join(f.repoRoot, 'attempt-count.txt')), false);
        assert.equal(f.events().length, 0);
        assert.deepEqual(fs.readdirSync(foreignParent), []);
    });

    it('rejects foreign destinations before execution and removes only its own unused reservation', async t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const artifactPath = path.join(f.reviewsRoot, 'unused.json');
        const outputPath = path.join(f.repoRoot, '..', 'foreign.log');
        await assert.rejects(f.run({ artifactPath, outputPath }), /outside permitted root/iu);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(outputPath), false);
        assert.equal(fs.existsSync(path.join(f.repoRoot, 'attempt-count.txt')), false);
        assert.equal(f.events().length, 0);
    });

    it('rejects linked destinations without changing their original evidence', async t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        await f.run();
        const first = f.events()[0].details as Record<string, unknown>;
        const outputPath = path.join(f.reviewsRoot, 'linked.log');
        fs.linkSync(String(first.output_artifact_path), outputPath);
        await assert.rejects(f.run({ outputPath }), /hard-linked/iu);
        assertEventFiles(first);
        assert.equal(fs.readFileSync(path.join(f.repoRoot, 'attempt-count.txt'), 'utf8'), '1');
        assert.equal(f.events().length, 1);
        const linkedDirectory = path.join(f.repoRoot, 'linked-reviews');
        fs.symlinkSync(f.reviewsRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(f.run({ outputPath: path.join(linkedDirectory, 'new.log') }), /symlink|junction/iu);
        assertEventFiles(first);
        assert.equal(f.events().length, 1);
    });

    it('retains repeat attempts and reports explicit collisions through the native CLI', async t => {
        const f = fixture([0, 7]);
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const args = ['gate', 'run-intermediate-command', '--task-id', TASK_ID,
            '--command-source', 'targeted-test', '--command', COMMAND, '--repo-root', f.repoRoot];
        const firstResult = await runCliWithCapturedOutput(args);
        assert.equal(firstResult.exitCode, 0, firstResult.errors.join('\n'));
        const secondResult = await runCliWithCapturedOutput(args);
        assert.equal(secondResult.exitCode, 7);
        assert.match(secondResult.logs.join('\n'), /INTERMEDIATE_COMMAND_FAILED|attempt-1/iu);
        const details = f.events().map(event => event.details as Record<string, unknown>);
        assert.equal(details.length, 2);
        details.forEach(assertEventFiles);
        const collision = await runCliWithCapturedOutput([...args,
            '--artifact-path', String(details[0].artifact_path)]);
        assert.notEqual(collision.exitCode, 0);
        assert.match(collision.errors.join('\n'), /already exists/iu);
        assert.equal(fs.readFileSync(path.join(f.repoRoot, 'attempt-count.txt'), 'utf8'), '2');
        assert.equal(f.events().length, 2);
        details.forEach(assertEventFiles);
    });

    it('keeps genuine attempts selectable and rejects later log or JSON tampering', async t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        await f.run();
        await f.run();
        assert.equal(f.select().entries.length, 2);
        const details = f.events().map(event => event.details as Record<string, unknown>);
        fs.appendFileSync(String(details[0].output_artifact_path), 'tampered\n');
        assert.equal(f.select().entries.length, 1);
        fs.appendFileSync(String(details[1].artifact_path), ' ');
        const rejected = f.select();
        assert.equal(rejected.entries.length, 0);
        assert.equal(rejected.rejected_candidate_count, 2);
        assert.ok(rejected.warnings.some(warning => /hash-mismatched/iu.test(warning)));
    });
});
