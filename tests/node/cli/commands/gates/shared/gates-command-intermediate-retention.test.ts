import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { runIntermediateCommandCommand } from '../../../../../../src/cli/commands/gates';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { readTaskOwnedFocusedIntermediateEvidence } from '../../../../../../src/gates/review/focused-intermediate-evidence';
import { authenticateLocalCommitWorkflowAudit, resolveLocalCommitAvailability } from '../../../../../../src/core/auth/local-commit-availability';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { handleSet } from '../../../../../../src/cli/commands/workflow/workflow-command-set';
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

function gitCompositionFixture(t: TestContext, action = '', exitCode = 0) {
    const f = fixture([exitCode]);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    fs.appendFileSync(path.join(f.repoRoot, 'scripts/node-foundation/build-scripts.cjs'), action);
    fs.writeFileSync(path.join(f.repoRoot, '.gitignore'), 'garda-agent-orchestrator/\nTASK.md\nattempt-count.txt\n');
    const config = path.join(getOrchestratorRoot(f.repoRoot), 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, '{}\n');
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'Composition fixture']]) {
        const result = spawnSync('git', ['-c', 'user.name=C2 fixture', '-c', 'user.email=fixture@example.test', ...args], {
            cwd: f.repoRoot, encoding: 'utf8', timeout: 10_000
        });
        assert.equal(result.status, 0, result.stderr);
    }
    return f;
}

function readSourceComposition(f: ReturnType<typeof fixture>) {
    const details = f.events()[0].details as Record<string, unknown>;
    assertEventFiles(details);
    const record = JSON.parse(fs.readFileSync(String(details.artifact_path), 'utf8')) as {
        source_composition?: {
            schema_version?: unknown; status?: unknown;
            before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
        };
    };
    assert.ok(record.source_composition, 'The native attempt must bind its actual source observation.');
    assert.equal(details.source_composition_sha256,
        createHash('sha256').update(JSON.stringify(record.source_composition)).digest('hex'));
    return record.source_composition;
}

function readIntermediateRecord(f: ReturnType<typeof fixture>, index = 0): Record<string, unknown> {
    const details = f.events()[index].details as Record<string, unknown>;
    assertEventFiles(details);
    return JSON.parse(fs.readFileSync(String(details.artifact_path), 'utf8'));
}

function nativeCompositionGrant(f: ReturnType<typeof fixture>, enabled = true): void {
    const config = path.join(getOrchestratorRoot(f.repoRoot), 'live/config/workflow-config.json');
    if (!JSON.parse(fs.readFileSync(config, 'utf8')).local_commit) {
        fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig()) + '\n');
    }
    handleSet({ targetRoot: f.repoRoot, localCommitEnabled: String(enabled), json: true,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
    assert.equal(resolveLocalCommitAvailability(f.repoRoot).enabled, enabled);
}

describe('native source-composition record authentication', () => {
    it('authenticates a new actual stable command/task/output/source record under its native grant', async t => {
        const f = gitCompositionFixture(t);
        nativeCompositionGrant(f);
        const before = Date.now();
        assert.equal((await f.run()).exitCode, 0);
        const record = readIntermediateRecord(f);
        assert.ok(record.local_commit_authentication, 'A successful qualified record must have native authentication.');
        assert.deepEqual(authenticateLocalCommitWorkflowAudit(f.repoRoot, record, false).local_commit_authentication,
            record.local_commit_authentication);
        assert.equal(record.event_source, 'native-intermediate-command');
        assert.ok(Date.parse(String(record.generated_utc)) >= before);
        for (const change of [{ task_id: 'T-OTHER' }, { command: 'node -e "process.exit(0)"' },
            { output_artifact_sha256: '0'.repeat(64) }, { source_composition: {} }]) {
            assert.notDeepEqual(authenticateLocalCommitWorkflowAudit(f.repoRoot, { ...record, ...change }, false)
                .local_commit_authentication, record.local_commit_authentication);
        }
        assert.equal(f.events()[0].outcome, 'PASSED');
    });

    it('prevents retrospective authentication while retaining unsigned earlier bytes', async t => {
        const f = gitCompositionFixture(t);
        assert.equal((await f.run()).exitCode, 0);
        const oldPath = String((f.events()[0].details as Record<string, unknown>).artifact_path);
        const oldBytes = fs.readFileSync(oldPath);
        assert.equal(readIntermediateRecord(f).local_commit_authentication, undefined);
        nativeCompositionGrant(f);
        assert.equal((await f.run()).exitCode, 0);
        assert.ok(readIntermediateRecord(f, 1).local_commit_authentication);
        assert.deepEqual(fs.readFileSync(oldPath), oldBytes);
    });

    it('rejects renewed native authority during actual execution despite identical configuration bytes', async t => {
        const setter = require.resolve('../../../../../../src/cli/commands/workflow/workflow-command-set');
        const f = gitCompositionFixture(t, [
            `const setter = require(${JSON.stringify(setter)});`,
            "setter.handleSet({ targetRoot: process.cwd(), localCommitEnabled: 'true', json: true,",
            "operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });", ''
        ].join('\n'));
        nativeCompositionGrant(f);
        const config = path.join(getOrchestratorRoot(f.repoRoot), 'live/config/workflow-config.json');
        const before = fs.readFileSync(config);
        const challenge = { event_source: 'fixture-native-authority-continuity' };
        const authority = authenticateLocalCommitWorkflowAudit(f.repoRoot, challenge, false).local_commit_authentication;
        assert.equal((await f.run()).exitCode, 0);
        const record = readIntermediateRecord(f);
        assert.deepEqual(fs.readFileSync(config), before);
        assert.notDeepEqual(authenticateLocalCommitWorkflowAudit(f.repoRoot, challenge, false).local_commit_authentication, authority);
        assert.equal((record.source_composition as Record<string, unknown>).status, 'STABLE_CLEAN');
        assert.equal(record.local_commit_authentication, undefined);
        assert.equal(f.events()[0].outcome, 'PASSED');
    });

    it('rejects native authority renewal at the final signing boundary', async t => {
        const f = gitCompositionFixture(t);
        nativeCompositionGrant(f);
        const authentication = require('../../../../../../src/core/auth/local-commit-availability') as typeof import('../../../../../../src/core/auth/local-commit-availability');
        const original = authentication.authenticateLocalCommitWorkflowAudit;
        t.mock.method(authentication, 'authenticateLocalCommitWorkflowAudit', (root: string, record: Record<string, unknown>, rotate: boolean) => {
            if (record.event_source === 'native-intermediate-command') nativeCompositionGrant(f);
            return original(root, record, rotate);
        });
        assert.equal((await f.run()).exitCode, 0);
        assert.equal(readIntermediateRecord(f).local_commit_authentication, undefined);
        assert.equal(f.events()[0].outcome, 'PASSED');
    });

    for (const kind of ['missing', 'unaudited', 'disabled'] as const) {
        it(`withholds composition authority under a ${kind} native grant without changing execution success`, async t => {
            const f = gitCompositionFixture(t);
            if (kind === 'disabled') { nativeCompositionGrant(f); nativeCompositionGrant(f, false); }
            if (kind === 'unaudited') {
                const config = buildDefaultWorkflowConfig(); config.local_commit.enabled = true;
                fs.writeFileSync(path.join(getOrchestratorRoot(f.repoRoot), 'live/config/workflow-config.json'),
                    JSON.stringify(config) + '\n');
            }
            assert.equal((await f.run()).exitCode, 0);
            assert.equal(readIntermediateRecord(f).local_commit_authentication, undefined);
            assert.equal(f.events()[0].outcome, 'PASSED');
        });
    }

    it('does not authenticate failed or changed-source validation beside a genuine ON grant', async t => {
        for (const [action, exitCode] of [['', 7], ['require("node:fs").appendFileSync("TASK.md", "\\n");\n', 0]] as const) {
            const f = gitCompositionFixture(t, action, exitCode);
            nativeCompositionGrant(f);
            assert.equal((await f.run()).exitCode, exitCode);
            assert.equal(readIntermediateRecord(f).local_commit_authentication, undefined);
        }
    });

    for (const stopped of ['timedOut', 'cancelled'] as const) {
        it(`withholds successful proof for ${stopped} execution even if its subprocess reports exit zero`, async t => {
            const f = gitCompositionFixture(t);
            nativeCompositionGrant(f);
            const runner = require('../../../../../../src/cli/gate-cli/gates-subprocess') as typeof import('../../../../../../src/cli/gate-cli/gates-subprocess');
            t.mock.method(runner, 'executeCommandAsync', async () => ({
                exitCode: 0, outputLines: ['Stopped synthetic subprocess boundary.'], timedOut: stopped === 'timedOut', cancelled: stopped === 'cancelled'
            }));
            assert.equal((await f.run()).exitCode, 0);
            assert.equal(readIntermediateRecord(f).local_commit_authentication, undefined);
        });
    }

    it('rejects real tracked WIP as native composition proof despite valid authority', async t => {
        const f = gitCompositionFixture(t);
        nativeCompositionGrant(f);
        fs.appendFileSync(path.join(f.repoRoot, TEST_PATH), '// real source WIP\n');
        assert.equal((await f.run()).exitCode, 0);
        assert.equal(readIntermediateRecord(f).local_commit_authentication, undefined);
    });

    it('preserves actual execution when optional native composition authentication fails', async t => {
        const f = gitCompositionFixture(t);
        nativeCompositionGrant(f);
        const authentication = require('../../../../../../src/core/auth/local-commit-availability') as typeof import('../../../../../../src/core/auth/local-commit-availability');
        t.mock.method(authentication, 'authenticateLocalCommitWorkflowAudit', () => { throw new Error('Native composition signer unavailable.'); });
        assert.equal((await f.run()).exitCode, 0);
        const record = readIntermediateRecord(f);
        assert.equal(record.local_commit_authentication, undefined);
        assert.equal(record.source_authentication_error, 'Native composition signer unavailable.');
        assert.equal(f.events()[0].outcome, 'PASSED');
    });

    it('rejects replay under a foreign workspace or a subsequently renewed native grant', async t => {
        const f = gitCompositionFixture(t), foreign = gitCompositionFixture(t);
        nativeCompositionGrant(f); nativeCompositionGrant(foreign);
        assert.equal((await f.run()).exitCode, 0);
        const record = readIntermediateRecord(f);
        assert.ok(record.local_commit_authentication);
        assert.notDeepEqual(authenticateLocalCommitWorkflowAudit(foreign.repoRoot, record, false).local_commit_authentication,
            record.local_commit_authentication);
        nativeCompositionGrant(f, false); nativeCompositionGrant(f);
        assert.notDeepEqual(authenticateLocalCommitWorkflowAudit(f.repoRoot, record, false).local_commit_authentication,
            record.local_commit_authentication);
    });
});

describe('intermediate source-composition binding', () => {
    it('binds a real stable clean Git checkout and ordinary audited inputs', async t => {
        const f = gitCompositionFixture(t);
        assert.equal((await f.run()).exitCode, 0);
        const proof = readSourceComposition(f);
        assert.equal(proof.schema_version, 1);
        assert.equal(proof.status, 'STABLE_CLEAN');
        assert.deepEqual(proof.before, proof.after);
        assert.ok(proof.before);
        const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.repoRoot, encoding: 'utf8' });
        assert.equal(head.status, 0, head.stderr);
        assert.equal(proof.before.source_head_sha, head.stdout.trim());
        assert.equal(proof.before.repo_root, fs.realpathSync.native(f.repoRoot));
        assert.equal(proof.before.task_queue_sha256, hash(path.join(f.repoRoot, 'TASK.md')));
        assert.equal(proof.before.workflow_config_sha256,
            hash(path.join(getOrchestratorRoot(f.repoRoot), 'live/config/workflow-config.json')));
    });

    for (const kind of ['tracked', 'untracked'] as const) {
        it(`keeps ${kind} source WIP ineligible without changing command success`, async t => {
            const f = gitCompositionFixture(t);
            fs.writeFileSync(path.join(f.repoRoot, kind === 'tracked' ? TEST_PATH : 'untracked-source.ts'), 'changed\n');
            assert.equal((await f.run()).exitCode, 0);
            assert.equal(readSourceComposition(f).status, 'CHANGED_OR_DIRTY');
            assert.equal(f.events()[0].outcome, 'PASSED');
        });
    }

    it('rejects stale source proof after actual HEAD advance during the command', async t => {
        const f = gitCompositionFixture(t, 'require("node:child_process").execFileSync("git", ["-c", "user.name=C2 fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "Actual later commit"]);\n');
        assert.equal((await f.run()).exitCode, 0);
        const proof = readSourceComposition(f);
        assert.equal(proof.status, 'CHANGED_OR_DIRTY');
        assert.notDeepEqual(proof.before, proof.after);
        assert.equal(f.events()[0].outcome, 'PASSED');
    });

    it('rejects stale source proof after actual ignored audited input change during the command', async t => {
        const f = gitCompositionFixture(t, 'require("node:fs").appendFileSync("TASK.md", "\\n");\n');
        assert.equal((await f.run()).exitCode, 0);
        const proof = readSourceComposition(f);
        assert.equal(proof.status, 'CHANGED_OR_DIRTY');
        assert.notDeepEqual(proof.before, proof.after);
        assert.equal(f.events()[0].outcome, 'PASSED');
    });

    it('does not convert a failed validation into PASS beside a stable checkout', async t => {
        const f = gitCompositionFixture(t, '', 7);
        assert.equal((await f.run()).exitCode, 7);
        assert.equal(readSourceComposition(f).status, 'STABLE_CLEAN');
        assert.equal(f.events()[0].outcome, 'FAILED');
    });

    it('rejects missing composition proof while preserving nongit command behavior', async t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        assert.equal((await f.run()).exitCode, 0);
        assert.equal(readSourceComposition(f).status, 'UNAVAILABLE');
        assert.equal(f.events()[0].outcome, 'PASSED');
    });

    it('withholds a foreign enclosing Git identity from a nested command workspace', async t => {
        const f = gitCompositionFixture(t);
        const nested = path.join(f.repoRoot, 'nested-workspace');
        fs.mkdirSync(nested);
        seedTaskQueue(nested, TASK_ID);
        seedInitAnswers(nested);
        for (const file of ['scripts/node-foundation/build-scripts.cjs', TEST_PATH]) {
            fs.mkdirSync(path.dirname(path.join(nested, file)), { recursive: true });
            fs.copyFileSync(path.join(f.repoRoot, file), path.join(nested, file));
        }
        appendTaskEvent(getOrchestratorRoot(nested), TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Nested fixture.', {});
        assert.equal((await f.run({ repoRoot: nested })).exitCode, 0);
        const inner = { ...f, repoRoot: nested, events: () => readTaskTimelineEvents(nested, TASK_ID)
            .filter(event => event.event_type === 'INTERMEDIATE_COMMAND_RUN') };
        assert.equal(readSourceComposition(inner).status, 'UNAVAILABLE');
    });

    it('rejects a shared audited input instead of issuing a clean source observation', async t => {
        const f = gitCompositionFixture(t);
        const config = path.join(getOrchestratorRoot(f.repoRoot), 'live/config/workflow-config.json');
        fs.linkSync(config, path.join(f.repoRoot, 'linked-control-input.json'));
        assert.equal((await f.run()).exitCode, 0);
        assert.equal(readSourceComposition(f).status, 'UNAVAILABLE');
    });

    it('rejects forged composition bytes after native publication', async t => {
        const f = gitCompositionFixture(t);
        assert.equal((await f.run()).exitCode, 0);
        const details = f.events()[0].details as Record<string, unknown>;
        const artifact = String(details.artifact_path);
        const record = JSON.parse(fs.readFileSync(artifact, 'utf8')) as Record<string, unknown>;
        assert.equal(f.select().entries.length, 1);
        record.source_composition = { status: 'STABLE_CLEAN', before: { source_head_sha: 'forged' } };
        fs.writeFileSync(artifact, JSON.stringify(record) + '\n');
        assert.equal(f.select().entries.length, 0);
    });
});

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
