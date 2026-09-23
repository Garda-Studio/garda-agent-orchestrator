import test, { beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

import type { BuildResult } from '../../../scripts/node-foundation/build';
import { isolateTestRunnerEnvironment, TEST_RUNNER_ENV_KEYS } from '../process-environment-fixtures';
import {
    addDurationReporterOptions,
    calibrateDurationWeights,
    createShardDurationCapture,
    formatDurationForecastAccuracy,
    SHARD_DURATION_OUTPUT_ENV
} from '../../../scripts/node-foundation/test-duration-telemetry';

beforeEach((context) => (context as TestContext).after(isolateTestRunnerEnvironment()));

const testModule = require('../../../scripts/node-foundation/test') as typeof import('../../../scripts/node-foundation/test');
const mutableBuildModule = require('../../../scripts/node-foundation/build') as typeof import('../../../scripts/node-foundation/build') & {
    buildNodeFoundation: () => BuildResult;
    buildPublishRuntime: () => BuildResult;
};
const mutableChildProcess = require('node:child_process') as typeof childProcess & {
    spawn: typeof childProcess.spawn;
    spawnSync: typeof childProcess.spawnSync;
};
const mutableOs = require('node:os') as typeof os & {
    availableParallelism: typeof os.availableParallelism;
};
const DEFAULT_SHARDED_NODE_TEST_CONCURRENCY = Math.max(1, Math.min(
    4,
    Math.floor(os.availableParallelism() / 2)
));
const DEFAULT_SHARDED_NODE_TEST_ARGS = [
    '--test',
    `--test-concurrency=${DEFAULT_SHARDED_NODE_TEST_CONCURRENCY}`
];
const EXPECTED_MAX_SHARD_ARG_CHARS = 24_000;
const EXPECTED_AUTO_SHARD_MAX_FILES = 32;

function createBuildResultFixture(extraTestCount = 0): { buildResult: BuildResult; cleanup: () => void; } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-tests-'));
    const buildRoot = path.join(repoRoot, '.node-build');
    fs.mkdirSync(path.join(buildRoot, 'tests', 'node', 'cli', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(buildRoot, 'tests', 'node', 'repo'), { recursive: true });

    const compiledGateTest = path.join(buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js');
    const compiledRepoTest = path.join(buildRoot, 'tests', 'node', 'repo', 'build-root-serialization.test.js');
    fs.writeFileSync(compiledGateTest, 'void 0;\n', 'utf8');
    fs.writeFileSync(compiledRepoTest, 'void 0;\n', 'utf8');

    const copiedFiles = [
        'tests/node/cli/commands/gates.test.js',
        'tests/node/repo/build-root-serialization.test.js'
    ];
    for (let index = 0; index < extraTestCount; index += 1) {
        const relativePath = `tests/node/repo/auto-shard-long-path-${String(index).padStart(4, '0')}-padding-padding-padding-padding.test.js`;
        const compiledPath = path.join(buildRoot, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
        fs.writeFileSync(compiledPath, 'void 0;\n', 'utf8');
        copiedFiles.push(relativePath);
    }

    return {
        buildResult: {
            repoRoot,
            buildRoot,
            copiedFiles,
            generatedCliPath: path.join(buildRoot, 'bin', 'garda.js'),
            manifestPath: path.join(buildRoot, 'node-foundation-manifest.json')
        },
        cleanup() {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    };
}

function addCompiledTestFile(buildResult: BuildResult, relativePath: string): string {
    const compiledPath = path.join(buildResult.buildRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
    fs.writeFileSync(compiledPath, 'void 0;\n', 'utf8');
    buildResult.copiedFiles.push(relativePath);
    return compiledPath;
}

function toNodeTestFileArg(buildResult: BuildResult, compiledPath: string): string {
    return path.relative(buildResult.repoRoot, compiledPath);
}

function createCompletingNodeTestChild(output = 'ok\n'): childProcess.ChildProcess {
    const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(events, { stdout, stderr });
    setImmediate(() => {
        stdout.end(output);
        stderr.end();
        events.emit('exit', 0);
        events.emit('close', 0);
    });
    return events;
}

test('isolated runner fixtures ignore hostile inherited controls and restore them after execution', async (context) => {
    const { buildResult, cleanup } = createBuildResultFixture();
    context.after(cleanup);
    const originalArgv = process.argv;
    context.after(() => { process.argv = originalArgv; });
    for (const key of TEST_RUNNER_ENV_KEYS) process.env[key] = `hostile ${key}`;
    const inherited = Object.fromEntries(TEST_RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
    const restore = isolateTestRunnerEnvironment();
    let observedArgs: string[] = [];
    context.mock.method(mutableBuildModule, 'buildNodeFoundation', () => buildResult);
    context.mock.method(mutableBuildModule, 'buildPublishRuntime', () => buildResult);
    context.mock.method(mutableChildProcess, 'spawn', (_command: string, args: readonly string[] = []) => {
        observedArgs = Array.from(args);
        return createCompletingNodeTestChild();
    });
    try {
        process.argv = ['node', 'scripts/node-foundation/test.js', 'tests/node/cli/commands/gates.test.ts'];
        assert.equal(await testModule.runNodeFoundationTests(), 0);
        assert.deepEqual(observedArgs, ['--test', toNodeTestFileArg(buildResult,
            path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js'))]);
    } finally {
        restore();
    }
    assert.deepEqual(Object.fromEntries(TEST_RUNNER_ENV_KEYS.map((key) => [key, process.env[key]])), inherited);
});

test('runNodeFoundationTests forwards test-name-pattern args before compiled test files', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    let observedCommand = '';
    let observedArgs: string[] = [];

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js', '--test-name-pattern', 'status sync'];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((command: string, args: readonly string[] = [], options?: childProcess.SpawnOptions) => {
            observedCommand = command;
            observedArgs = Array.from(args);
            void options;
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedCommand, process.execPath);
        assert.deepEqual(observedArgs, [
            '--test',
            '--test-name-pattern',
            'status sync',
            toNodeTestFileArg(
                buildResult,
                path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js')
            ),
            toNodeTestFileArg(
                buildResult,
                path.join(buildResult.buildRoot, 'tests', 'node', 'repo', 'build-root-serialization.test.js')
            )
        ]);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests narrows explicit source test targets to compiled outputs', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    let observedArgs: string[] = [];

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--test-name-pattern',
            'status sync',
            'tests/node/cli/commands/gates.test.ts'
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedArgs = Array.from(args);
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.deepEqual(observedArgs, [
            '--test',
            '--test-name-pattern',
            'status sync',
            toNodeTestFileArg(
                buildResult,
                path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js')
            )
        ]);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests fails fast when an explicit test target cannot be resolved', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js', 'tests/node/missing.test.ts'];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;

        await assert.rejects(
            () => testModule.runNodeFoundationTests(),
            /Unable to resolve targeted Node foundation test path: tests\/node\/missing\.test\.ts/
        );
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        cleanup();
    }
});

test('runNodeFoundationTests bounds aggregate inner concurrency across deterministic shards', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const observedShardArgs: string[][] = [];

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js'];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = '2';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            const events = new (require('node:events').EventEmitter)();
            const exitCode = observedShardArgs.length === 2 ? 7 : 0;
            setImmediate(() => {
                events.emit('exit', exitCode);
                events.emit('close', exitCode);
            });
            return events as childProcess.ChildProcess;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 7);
        assert.equal(observedShardArgs.length, 2);
        assert.deepEqual(observedShardArgs[0], [
            ...DEFAULT_SHARDED_NODE_TEST_ARGS,
            toNodeTestFileArg(
                buildResult,
                path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js')
            )
        ]);
        assert.deepEqual(observedShardArgs[1], [
            ...DEFAULT_SHARDED_NODE_TEST_ARGS,
            toNodeTestFileArg(
                buildResult,
                path.join(buildResult.buildRoot, 'tests', 'node', 'repo', 'build-root-serialization.test.js')
            )
        ]);
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests bounds inner concurrency when isolation expands requested shards', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    addCompiledTestFile(
        buildResult,
        'tests/node/gates/compile/full-suite-validation-cli-transaction.test.js'
    );
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalAvailableParallelism = mutableOs.availableParallelism;
    const observedShardArgs: string[][] = [];

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-shard-concurrency',
            '4'
        ];
        delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableOs.availableParallelism = () => 8;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;

        assert.equal(await testModule.runNodeFoundationTests(), 0);
        assert.equal(observedShardArgs.length, 3);
        assert.ok(observedShardArgs.every((args) => args.includes('--test-concurrency=2')));
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        mutableOs.availableParallelism = originalAvailableParallelism;
        cleanup();
    }
});

test('runNodeFoundationTests allocates inner concurrency from active shard workers', async (context) => {
    const { buildResult, cleanup } = createBuildResultFixture();
    context.after(cleanup);
    const originalArgv = process.argv;
    context.after(() => { process.argv = originalArgv; });
    process.argv = ['node', 'scripts/node-foundation/test.js', '--garda-shards', '2', '--garda-shard-concurrency', '4'];
    context.mock.method(mutableBuildModule, 'buildPublishRuntime', () => buildResult);
    context.mock.method(mutableBuildModule, 'buildNodeFoundation', () => buildResult);
    context.mock.method(mutableOs, 'availableParallelism', () => 8);
    const observedShardArgs: string[][] = [];
    context.mock.method(mutableChildProcess, 'spawn', (_: string, args: readonly string[] = []) => {
        observedShardArgs.push(Array.from(args));
        return createCompletingNodeTestChild();
    });

    assert.equal(await testModule.runNodeFoundationTests(), 0);
    assert.equal(observedShardArgs.length, 2);
    assert.ok(observedShardArgs.every((args) => args.includes('--test-concurrency=4')));
});

test('runNodeFoundationTests caps default outer workers on a single-core host', async (context) => {
    const { buildResult, cleanup } = createBuildResultFixture(2);
    context.after(cleanup);
    const originalArgv = process.argv;
    context.after(() => { process.argv = originalArgv; });
    process.argv = ['node', 'scripts/node-foundation/test.js', '--garda-shards', '4'];
    context.mock.method(mutableBuildModule, 'buildPublishRuntime', () => buildResult);
    context.mock.method(mutableBuildModule, 'buildNodeFoundation', () => buildResult);
    context.mock.method(mutableOs, 'availableParallelism', () => 1);
    let activeShards = 0;
    let maxActiveShards = 0;
    const observedShardArgs: string[][] = [];
    context.mock.method(mutableChildProcess, 'spawn', (_: string, args: readonly string[] = []) => {
        observedShardArgs.push(Array.from(args));
        activeShards += 1;
        maxActiveShards = Math.max(maxActiveShards, activeShards);
        const child = createCompletingNodeTestChild();
        child.once('close', () => { activeShards -= 1; });
        return child;
    });

    assert.equal(await testModule.runNodeFoundationTests(), 0);
    assert.equal(observedShardArgs.length, 4);
    assert.equal(maxActiveShards, 1);
    assert.ok(observedShardArgs.every((args) => args.includes('--test-concurrency=1')));
});

test('runNodeFoundationTests limits shard process concurrency from CLI option', async () => {
    const { buildResult, cleanup } = createBuildResultFixture(2);
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    let activeShards = 0;
    let maxActiveShards = 0;
    let spawnedShardCount = 0;
    const observedShardArgs: string[][] = [];

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '4',
            '--garda-shard-concurrency',
            '2'
        ];
        delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            spawnedShardCount += 1;
            activeShards += 1;
            maxActiveShards = Math.max(maxActiveShards, activeShards);
            observedShardArgs.push(Array.from(args));
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            setTimeout(() => {
                stdout.end(`ok ${spawnedShardCount}\n`);
                stderr.end();
                activeShards -= 1;
                events.emit('exit', 0);
                events.emit('close', 0);
            }, 10);
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(spawnedShardCount, 4);
        assert.equal(maxActiveShards, 2);
        assert.ok(observedShardArgs.every((args) => !args.includes('--garda-shard-concurrency')));
        assert.ok(observedShardArgs.every((args) => (
            args.includes(`--test-concurrency=${DEFAULT_SHARDED_NODE_TEST_CONCURRENCY}`)
        )));
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests preserves explicit node test concurrency for shards', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const observedShardArgs: string[][] = [];

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--test-concurrency',
            '3'
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedShardArgs.length, 2);
        assert.ok(observedShardArgs.every((args) => args.includes('--test-concurrency')));
        assert.ok(observedShardArgs.every((args) => args.includes('3')));
        assert.ok(observedShardArgs.every((args) => (
            !args.includes(`--test-concurrency=${DEFAULT_SHARDED_NODE_TEST_CONCURRENCY}`)
        )));
        assert.ok(observedShardArgs.every((args) => (
            args.filter((arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency=')).length === 1
        )));
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests runs contention-sensitive tests after parallel shards', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalAvailableParallelism = mutableOs.availableParallelism;
    const serialTestArgs = [
        'tests/node/core/subprocess.test.js',
        'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-1.test.js',
        'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-2.test.js',
        'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-3.test.js',
        'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-4.test.js',
        'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-5.test.js',
        'tests/node/cli/commands/gates/task-mode/gates-workflow-config-policy.test.js',
        'tests/node/cli/commands/profile.test.js',
        'tests/node/gate-runtime/task-events-locks.test.js',
        'tests/node/gates/next-step/next-step-review-failure-routing.test.js'
    ].map((relativePath) => toNodeTestFileArg(
        buildResult,
        addCompiledTestFile(buildResult, relativePath)
    ));
    const observedShardArgs: string[][] = [];
    let activeShards = 0;
    let maxActiveShards = 0;

    try {
        mutableOs.availableParallelism = () => 6;
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2'
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            const observedArgs = Array.from(args);
            observedShardArgs.push(observedArgs);
            activeShards += 1;
            maxActiveShards = Math.max(maxActiveShards, activeShards);
            const isSerialTest = serialTestArgs.some((testArg) => observedArgs.includes(testArg));
            if (isSerialTest) {
                assert.equal(activeShards, 1, 'serial test must not overlap active parallel shards');
            }
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            setTimeout(() => {
                stdout.end('ok\n');
                stderr.end();
                activeShards -= 1;
                events.emit('exit', 0);
                events.emit('close', 0);
            }, isSerialTest ? 1 : 20);
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedShardArgs.length, 2 + serialTestArgs.length);
        assert.equal(maxActiveShards, 2);
        assert.ok(observedShardArgs.slice(0, 2).every((args) => (
            serialTestArgs.every((testArg) => !args.includes(testArg))
        )));
        assert.ok(observedShardArgs.slice(0, 2).every((args) => args.includes('--test-concurrency=3')));
        assert.deepEqual(
            observedShardArgs.slice(2),
            serialTestArgs.map((testArg) => ['--test', '--test-concurrency=4', testArg])
        );
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        mutableOs.availableParallelism = originalAvailableParallelism;
        cleanup();
    }
});

test('runNodeFoundationTests isolates mutation-sensitive suites from grouped shard peers', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalAvailableParallelism = mutableOs.availableParallelism;
    const isolatedTestArgs = [
        'tests/node/cli/commands/gates/completion/gates-completion-rollback.test.js',
        'tests/node/cli/commands/gates/review-cycle/gates-review-cycle-restart.test.js',
        'tests/node/cli/commands/gates/review-reuse/gates-review-reuse-historical-rejections.test.js',
        'tests/node/cli/commands/gates/review-reuse/gates-review-reuse-upstream.test.js',
        'tests/node/cli/commands/task-events-human-format.test.js',
        'tests/node/gate-runtime/task-timeline-performance-acceptance.test.js'
    ].map((relativePath) => toNodeTestFileArg(
        buildResult,
        addCompiledTestFile(buildResult, relativePath)
    ));
    const observedShardArgs: string[][] = [];

    try {
        mutableOs.availableParallelism = () => 8;
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2'
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedShardArgs.length, 2 + isolatedTestArgs.length);
        for (const isolatedTestArg of isolatedTestArgs) {
            const isolatedShardArgs = observedShardArgs.filter((args) => args.includes(isolatedTestArg));
            assert.equal(isolatedShardArgs.length, 1);
            assert.deepEqual(isolatedShardArgs[0], ['--test', '--test-concurrency=2', isolatedTestArg]);
        }
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        mutableOs.availableParallelism = originalAvailableParallelism;
        cleanup();
    }
});

test('runNodeFoundationTests groups 60s tests and isolates tests at the 4m threshold', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalAvailableParallelism = mutableOs.availableParallelism;
    const originalConsoleLog = console.log;
    const durationFile = path.join(buildResult.repoRoot, 'duration-telemetry.json');
    const groupedTestPath = addCompiledTestFile(
        buildResult,
        'tests/node/repo/dynamic-moderate.test.js'
    );
    const groupedTestArg = toNodeTestFileArg(buildResult, groupedTestPath);
    const isolatedTestPath = addCompiledTestFile(
        buildResult,
        'tests/node/repo/dynamic-heavy.test.js'
    );
    const isolatedTestArg = toNodeTestFileArg(buildResult, isolatedTestPath);
    fs.writeFileSync(
        path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js'),
        `${'void 0;\n'.repeat(20_000)}\n`,
        'utf8'
    );
    const observedShardArgs: string[][] = [];
    const observedLogs: string[] = [];
    let activeShards = 0;
    let maxActiveShards = 0;

    fs.writeFileSync(durationFile, `${JSON.stringify({
        schema_version: 1,
        updated_at_utc: new Date(0).toISOString(),
        entries: {
            'tests/node/repo/dynamic-moderate.test.ts': {
                file: 'tests/node/repo/dynamic-moderate.test.ts',
                duration_ms: 60000,
                samples: 2,
                updated_at_utc: new Date(0).toISOString()
            },
            'tests/node/repo/dynamic-heavy.test.ts': {
                file: 'tests/node/repo/dynamic-heavy.test.ts',
                duration_ms: 240000,
                samples: 2,
                updated_at_utc: new Date(0).toISOString()
            }
        }
    }, null, 2)}\n`, 'utf8');

    try {
        mutableOs.availableParallelism = () => 8;
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-duration-file',
            durationFile
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        console.log = ((...args: unknown[]) => {
            observedLogs.push(args.map(String).join(' '));
        }) as typeof console.log;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            const observedArgs = Array.from(args);
            observedShardArgs.push(observedArgs);
            activeShards += 1;
            maxActiveShards = Math.max(maxActiveShards, activeShards);
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            setTimeout(() => {
                stdout.end('ok\n');
                stderr.end();
                activeShards -= 1;
                events.emit('exit', 0);
                events.emit('close', 0);
            }, observedArgs.includes(isolatedTestArg) ? 1 : 20);
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedShardArgs.length, 3);
        assert.equal(maxActiveShards, 3);
        const groupedShardArgs = observedShardArgs.filter((args) => args.includes(groupedTestArg));
        assert.equal(groupedShardArgs.length, 1);
        assert.ok(
            groupedShardArgs[0].length > DEFAULT_SHARDED_NODE_TEST_ARGS.length + 1,
            'known 60s test should retain a grouped shard peer'
        );
        const isolatedShardArgs = observedShardArgs.filter((args) => args.includes(isolatedTestArg));
        assert.deepEqual(isolatedShardArgs, [['--test', '--test-concurrency=2', isolatedTestArg]]);
        const comparisonLine = observedLogs.find((line) => line.startsWith('NODE_FOUNDATION_TEST_SHARD_COMPARISON '));
        assert.match(comparisonLine || '', /current_threshold_ms=240000/);
        assert.match(comparisonLine || '', /baseline_threshold_ms=60000/);
        assert.match(comparisonLine || '', /current_isolated_files=1/);
        assert.match(comparisonLine || '', /baseline_isolated_files=2/);
        assert.match(comparisonLine || '', /current_scheduled_shards=3/);
        assert.match(comparisonLine || '', /baseline_scheduled_shards=4/);
        assert.match(comparisonLine || '', /max_worker_processes=3/);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        console.log = originalConsoleLog;
        mutableOs.availableParallelism = originalAvailableParallelism;
        cleanup();
    }
});

test('runNodeFoundationTests diagnoses green node:test summaries with nonzero shard exits', async () => {
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalSpawnSync = mutableChildProcess.spawnSync;
    const originalConsoleError = console.error;
    const diagnostics: string[] = [];
    const isolationArgs: string[][] = [];
    let spawnedShardCount = 0;

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js'];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = '2';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        console.error = ((...args: unknown[]) => {
            diagnostics.push(args.map(String).join(' '));
        }) as typeof console.error;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = []) => {
            spawnedShardCount += 1;
            const shardNumber = spawnedShardCount;
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            setImmediate(() => {
                if (shardNumber === 1) {
                    stdout.end([
                        'ok 1 - apparent pass',
                        'ℹ tests 1',
                        'ℹ pass 1',
                        'ℹ fail 0',
                        'ℹ cancelled 0'
                    ].join('\n'));
                    stderr.end();
                    events.emit('exit', 1);
                    events.emit('close', 1);
                    return;
                }
                stdout.end('ok 1 - second shard\n');
                stderr.end();
                events.emit('exit', 0);
                events.emit('close', 0);
            });
            return events;
        }) as typeof childProcess.spawn;
        mutableChildProcess.spawnSync = ((_: string, args: readonly string[] = []) => {
            isolationArgs.push(Array.from(args));
            const status = String(args[args.length - 1]).endsWith('gates.test.js') ? 9 : 0;
            return {
                status,
                signal: null,
                stdout: status === 0 ? 'ok isolated\n' : 'not ok isolated\nℹ fail 0\nℹ cancelled 0\n',
                stderr: status === 0 ? '' : 'process exit leak\n'
            } as childProcess.SpawnSyncReturns<string>;
        }) as typeof childProcess.spawnSync;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 1);
        assert.ok(diagnostics.some((line) => line.includes('NODE_FOUNDATION_TEST_SHARD_GREEN_EXIT_MISMATCH 1/2 exit=1')));
        assert.ok(diagnostics.some((line) =>
            line.includes('NODE_FOUNDATION_TEST_SHARD_ISOLATION_FAIL 1/2 file=tests/node/cli/commands/gates.test.ts exit=9')
        ));
        assert.ok(isolationArgs.some((args) =>
            args.includes(path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js'))
        ));
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        mutableChildProcess.spawnSync = originalSpawnSync;
        console.error = originalConsoleError;
        cleanup();
    }
});

test('runNodeFoundationTests does not diagnose nonzero shard exits when the final node:test summary failed', async () => {
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalSpawnSync = mutableChildProcess.spawnSync;
    const originalConsoleError = console.error;
    const diagnostics: string[] = [];
    let isolationRuns = 0;
    let spawnedShardCount = 0;

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js'];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = '2';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        console.error = ((...args: unknown[]) => {
            diagnostics.push(args.map(String).join(' '));
        }) as typeof console.error;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = []) => {
            spawnedShardCount += 1;
            const shardNumber = spawnedShardCount;
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            setImmediate(() => {
                if (shardNumber === 1) {
                    stdout.end([
                        'ok 1 - nested runner pass',
                        'ℹ tests 1',
                        'ℹ pass 1',
                        'ℹ fail 0',
                        'ℹ cancelled 0',
                        '✖ failing tests:',
                        '✖ real test failure',
                        'ℹ tests 2',
                        'ℹ pass 1',
                        'ℹ fail 1',
                        'ℹ cancelled 0'
                    ].join('\n'));
                    stderr.end();
                    events.emit('exit', 1);
                    events.emit('close', 1);
                    return;
                }
                stdout.end('ok 1 - second shard\n');
                stderr.end();
                events.emit('exit', 0);
                events.emit('close', 0);
            });
            return events;
        }) as typeof childProcess.spawn;
        mutableChildProcess.spawnSync = ((_: string, _args: readonly string[] = []) => {
            isolationRuns += 1;
            return { status: 0, signal: null, stdout: '', stderr: '' } as childProcess.SpawnSyncReturns<string>;
        }) as typeof childProcess.spawnSync;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 1);
        assert.equal(isolationRuns, 0);
        assert.equal(diagnostics.some((line) => line.includes('NODE_FOUNDATION_TEST_SHARD_GREEN_EXIT_MISMATCH')), false);
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        mutableChildProcess.spawnSync = originalSpawnSync;
        console.error = originalConsoleError;
        cleanup();
    }
});

test('runNodeFoundationTests preserves a safe requested shard count and writes shard logs', async () => {
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const { buildResult, cleanup } = createBuildResultFixture(70);
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const observedShardArgs: string[][] = [];

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-shard-log-dir',
            path.join(buildResult.repoRoot, 'custom-shard-logs')
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            const shardNumber = observedShardArgs.length;
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            setImmediate(() => {
                events.emit('exit', 0);
                stdout.end(`stdout shard ${shardNumber}\n`);
                stderr.end(`stderr shard ${shardNumber}\n`);
                setImmediate(() => events.emit('close', 0));
            });
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedShardArgs.length, 2);
        assert.ok(observedShardArgs.every((args) => !args.includes('--garda-shards')));
        assert.ok(observedShardArgs.every((args) => !args.includes('--garda-shard-log-dir')));
        assert.ok(
            observedShardArgs.every((args) => args.filter((arg) => !arg.startsWith('--')).length > 32),
            'safe explicit shards should not be re-split by a fixed file-count cap'
        );
        const logDir = path.join(buildResult.repoRoot, 'custom-shard-logs');
        const logFiles = fs.readdirSync(logDir).sort();
        assert.deepEqual(logFiles, ['shard-01-of-02.log', 'shard-02-of-02.log']);
        assert.match(fs.readFileSync(path.join(logDir, logFiles[0]), 'utf8'), /stdout shard 1/);
        assert.match(fs.readFileSync(path.join(logDir, logFiles[1]), 'utf8'), /stderr shard 2/);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests starts the next shard when a worker slot opens', async () => {
    const { buildResult, cleanup } = createBuildResultFixture(2);
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    let spawnedShardCount = 0;
    let slowShardOpen = false;
    let thirdShardStartedBeforeSlowClosed = false;
    let closeSlowShard: (() => void) | null = null;

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '3',
            '--garda-shard-concurrency',
            '2'
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = []) => {
            spawnedShardCount += 1;
            const shardNumber = spawnedShardCount;
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            const closeShard = () => {
                stdout.end(`shard ${shardNumber}\n`);
                stderr.end();
                events.emit('exit', 0);
                events.emit('close', 0);
            };

            if (shardNumber === 2) {
                let slowShardClosed = false;
                slowShardOpen = true;
                closeSlowShard = () => {
                    if (slowShardClosed) {
                        return;
                    }
                    slowShardClosed = true;
                    slowShardOpen = false;
                    closeShard();
                };
                setTimeout(() => closeSlowShard?.(), 50);
                return events;
            }

            if (shardNumber === 3 && slowShardOpen) {
                thirdShardStartedBeforeSlowClosed = true;
                setImmediate(() => {
                    closeShard();
                    closeSlowShard?.();
                });
                return events;
            }

            setImmediate(closeShard);
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.ok(spawnedShardCount >= 3);
        assert.equal(thirdShardStartedBeforeSlowClosed, true);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests times out a hung shard and records cleanup diagnostics', async () => {
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardTimeoutEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
    const originalShardHeartbeatEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalProcessKill = process.kill;
    let hungShardKilled = false;
    let spawnedShardCount = 0;
    const observedProcessKill: Array<{ pid: number; signal: string | number | undefined; }> = [];
    const spawnedChildren = new Map<number, childProcess.ChildProcess & {
        stdout: import('node:stream').PassThrough;
        stderr: import('node:stream').PassThrough;
    }>();

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-shard-log-dir',
            path.join(buildResult.repoRoot, 'timeout-shard-logs')
        ];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = '20';
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = '0';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        (process.kill as unknown as typeof originalProcessKill) = ((pid: number, signal?: string | number) => {
            observedProcessKill.push({ pid, signal });
            if (pid < 0) {
                const child = spawnedChildren.get(Math.abs(pid));
                if (child) {
                    setImmediate(() => {
                        child.stdout.end();
                        child.stderr.end();
                        child.emit('exit', null);
                        child.emit('close', null);
                    });
                }
            }
            return true;
        }) as typeof process.kill;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = [], options?: childProcess.SpawnOptions) => {
            spawnedShardCount += 1;
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, {
                pid: 99 + spawnedShardCount,
                stdout,
                stderr,
                kill() {
                    hungShardKilled = true;
                    setImmediate(() => {
                        stdout.end();
                        stderr.end();
                        events.emit('exit', null);
                        events.emit('close', null);
                    });
                    return true;
                }
            });
            spawnedChildren.set(99 + spawnedShardCount, events as childProcess.ChildProcess & {
                stdout: import('node:stream').PassThrough;
                stderr: import('node:stream').PassThrough;
            });
            if (process.platform !== 'win32') {
                assert.equal(options?.detached, true);
            }
            if (hungShardKilled) {
                return events;
            }
            stdout.write('hung shard started\n');
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 1);
        if (process.platform === 'win32') {
            assert.equal(hungShardKilled, true);
        } else {
            assert.deepEqual(observedProcessKill.map((item) => item.pid), [-100, -101]);
            assert.ok(observedProcessKill.every((item) => item.signal === 'SIGKILL'));
        }
        const logDir = path.join(buildResult.repoRoot, 'timeout-shard-logs');
        const timeoutLog = fs.readFileSync(path.join(logDir, 'shard-01-of-02.log'), 'utf8');
        assert.match(timeoutLog, /hung shard started/);
        assert.match(timeoutLog, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT 1\/2/);
        assert.match(timeoutLog, /last_output_age_ms=\d+/);
        if (process.platform === 'win32') {
            assert.match(timeoutLog, /cleanup=child_kill_sigkill|cleanup=taskkill_tree/);
        } else {
            assert.match(timeoutLog, /cleanup=kill_process_group_sigkill/);
        }
    } finally {
        process.argv = originalArgv;
        if (originalShardTimeoutEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = originalShardTimeoutEnv;
        }
        if (originalShardHeartbeatEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = originalShardHeartbeatEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        process.kill = originalProcessKill;
        cleanup();
    }
});

test('runNodeFoundationTests times out a hung single-process run and records cleanup diagnostics', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardTimeoutEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
    const originalShardHeartbeatEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalProcessKill = process.kill;
    let childKillCalled = false;
    const observedArgs: string[][] = [];
    const observedProcessKill: Array<{ pid: number; signal: string | number | undefined; }> = [];
    let spawnedChild: childProcess.ChildProcess & {
        stdout: PassThrough;
        stderr: PassThrough;
    } | null = null;

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shard-log-dir',
            path.join(buildResult.repoRoot, 'single-timeout-logs'),
            'tests/node/cli/commands/gates.test.ts'
        ];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = '20';
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = '0';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        (process.kill as unknown as typeof originalProcessKill) = ((pid: number, signal?: string | number) => {
            observedProcessKill.push({ pid, signal });
            if (pid < 0 && spawnedChild) {
                setImmediate(() => {
                    spawnedChild?.stdout.end();
                    spawnedChild?.stderr.end();
                    spawnedChild?.emit('exit', null);
                    spawnedChild?.emit('close', null);
                });
            }
            return true;
        }) as typeof process.kill;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = [], options?: childProcess.SpawnOptions) => {
            observedArgs.push(Array.from(args));
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, {
                pid: 1234,
                stdout,
                stderr,
                kill() {
                    childKillCalled = true;
                    setImmediate(() => {
                        stdout.end();
                        stderr.end();
                        events.emit('exit', null);
                        events.emit('close', null);
                    });
                    return true;
                }
            });
            spawnedChild = events as childProcess.ChildProcess & {
                stdout: PassThrough;
                stderr: PassThrough;
            };
            if (process.platform !== 'win32') {
                assert.equal(options?.detached, true);
            }
            stdout.write('single process started\n');
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 1);
        assert.equal(observedArgs.length, 1);
        assert.deepEqual(observedArgs[0], [
            '--test',
            toNodeTestFileArg(
                buildResult,
                path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js')
            )
        ]);
        if (process.platform === 'win32') {
            assert.equal(childKillCalled, true);
        } else {
            assert.deepEqual(observedProcessKill.map((item) => item.pid), [-1234]);
            assert.ok(observedProcessKill.every((item) => item.signal === 'SIGKILL'));
        }
        const timeoutLog = fs.readFileSync(
            path.join(buildResult.repoRoot, 'single-timeout-logs', 'shard-01-of-01.log'),
            'utf8'
        );
        assert.match(timeoutLog, /single process started/);
        assert.match(timeoutLog, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT 1\/1/);
        assert.match(timeoutLog, /command="[^"]*node(?:\.exe)?"/i);
        assert.match(timeoutLog, /argv=\["--test"/);
        assert.match(timeoutLog, /gates\.test\.js/);
    } finally {
        process.argv = originalArgv;
        if (originalShardTimeoutEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = originalShardTimeoutEnv;
        }
        if (originalShardHeartbeatEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = originalShardHeartbeatEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        process.kill = originalProcessKill;
        cleanup();
    }
});

test('runNodeFoundationTests finishes timed out shards when cleanup never emits close', async () => {
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardTimeoutEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
    const originalShardHeartbeatEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalProcessKill = process.kill;

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-shard-log-dir',
            path.join(buildResult.repoRoot, 'cleanup-grace-shard-logs')
        ];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = '20';
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = '0';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        (process.kill as unknown as typeof originalProcessKill) = (() => true) as typeof process.kill;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = []) => {
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, {
                pid: 800,
                stdout,
                stderr,
                kill() {
                    return true;
                }
            });
            stdout.write('cleanup grace shard started\n');
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 1);
        const logDir = path.join(buildResult.repoRoot, 'cleanup-grace-shard-logs');
        const cleanupGraceLog = fs.readFileSync(path.join(logDir, 'shard-01-of-02.log'), 'utf8');
        assert.match(cleanupGraceLog, /cleanup grace shard started/);
        assert.match(cleanupGraceLog, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT 1\/2/);
        assert.match(cleanupGraceLog, /NODE_FOUNDATION_TEST_SHARD_CLEANUP_GRACE_EXPIRED 1\/2/);
    } finally {
        process.argv = originalArgv;
        if (originalShardTimeoutEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = originalShardTimeoutEnv;
        }
        if (originalShardHeartbeatEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = originalShardHeartbeatEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        process.kill = originalProcessKill;
        cleanup();
    }
});

test('runNodeFoundationTests does not time out a shard that keeps producing output', async () => {
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardTimeoutEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
    const originalShardHeartbeatEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalProcessKill = process.kill;
    let childKillCalled = false;
    const observedProcessKill: Array<{ pid: number; signal: string | number | undefined; }> = [];

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-shard-log-dir',
            path.join(buildResult.repoRoot, 'active-output-shard-logs')
        ];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = '80';
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = '0';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        (process.kill as unknown as typeof originalProcessKill) = ((pid: number, signal?: string | number) => {
            observedProcessKill.push({ pid, signal });
            return true;
        }) as typeof process.kill;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = [], options?: childProcess.SpawnOptions) => {
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, {
                pid: 700 + observedProcessKill.length,
                stdout,
                stderr,
                kill() {
                    childKillCalled = true;
                    return true;
                }
            });
            if (process.platform !== 'win32') {
                assert.equal(options?.detached, true);
            }
            setImmediate(() => stdout.write('active shard output 0\n'));
            setTimeout(() => stdout.write('active shard output 1\n'), 25);
            setTimeout(() => stdout.write('active shard output 2\n'), 55);
            setTimeout(() => stdout.write('active shard output 3\n'), 85);
            setTimeout(() => {
                stdout.end('active shard done\n');
                stderr.end();
                events.emit('exit', 0);
                events.emit('close', 0);
            }, 115);
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(childKillCalled, false);
        assert.deepEqual(observedProcessKill, []);
        const logDir = path.join(buildResult.repoRoot, 'active-output-shard-logs');
        const activeOutputLog = fs.readFileSync(path.join(logDir, 'shard-01-of-02.log'), 'utf8');
        assert.match(activeOutputLog, /active shard output 3/);
        assert.doesNotMatch(activeOutputLog, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT/);
    } finally {
        process.argv = originalArgv;
        if (originalShardTimeoutEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = originalShardTimeoutEnv;
        }
        if (originalShardHeartbeatEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = originalShardHeartbeatEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        process.kill = originalProcessKill;
        cleanup();
    }
});

test('runNodeFoundationTests writes shard heartbeat diagnostics to shard logs', async () => {
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardTimeoutEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
    const originalShardHeartbeatEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-shard-log-dir',
            path.join(buildResult.repoRoot, 'heartbeat-shard-logs')
        ];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = '0';
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = '5';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = []) => {
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            setTimeout(() => {
                stdout.end('heartbeat shard done\n');
                stderr.end();
                events.emit('exit', 0);
                events.emit('close', 0);
            }, 20);
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        const logDir = path.join(buildResult.repoRoot, 'heartbeat-shard-logs');
        const heartbeatLog = fs.readFileSync(path.join(logDir, 'shard-01-of-02.log'), 'utf8');
        assert.match(heartbeatLog, /NODE_FOUNDATION_TEST_SHARD_HEARTBEAT 1\/2/);
        assert.match(heartbeatLog, /heartbeat shard done/);
    } finally {
        process.argv = originalArgv;
        if (originalShardTimeoutEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = originalShardTimeoutEnv;
        }
        if (originalShardHeartbeatEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = originalShardHeartbeatEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests balances shards with duration telemetry before size fallback', async () => {
    const { buildResult, cleanup } = createBuildResultFixture(1);
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const observedShardArgs: string[][] = [];
    const durationFile = path.join(buildResult.repoRoot, 'duration-telemetry.json');
    const extraRelativePath = buildResult.copiedFiles[2].replace(/\.js$/i, '.ts');

    fs.writeFileSync(durationFile, `${JSON.stringify({
        schema_version: 1,
        updated_at_utc: new Date(0).toISOString(),
        entries: {
            'tests/node/cli/commands/gates.test.ts': {
                file: 'tests/node/cli/commands/gates.test.ts',
                duration_ms: 1000,
                samples: 2,
                updated_at_utc: new Date(0).toISOString()
            },
            'tests/node/repo/build-root-serialization.test.ts': {
                file: 'tests/node/repo/build-root-serialization.test.ts',
                duration_ms: 900,
                samples: 2,
                updated_at_utc: new Date(0).toISOString()
            },
            [extraRelativePath]: {
                file: extraRelativePath,
                duration_ms: 100,
                samples: 2,
                updated_at_utc: new Date(0).toISOString()
            }
        }
    }, null, 2)}\n`, 'utf8');

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-duration-file',
            durationFile
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            const events = new (require('node:events').EventEmitter)();
            setImmediate(() => {
                events.emit('exit', 0);
                events.emit('close', 0);
            });
            return events as childProcess.ChildProcess;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedShardArgs.length, 2);
        const observedShardFiles = observedShardArgs
            .map((args) => args
                .filter((arg) => !arg.startsWith('--'))
                .map((file) => path.relative(
                    buildResult.buildRoot,
                    path.resolve(buildResult.repoRoot, file)
                ).replace(/\\/g, '/'))
                .sort())
            .sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
        assert.deepEqual(observedShardFiles, [
            ['tests/node/cli/commands/gates.test.js'],
            [
                'tests/node/repo/auto-shard-long-path-0000-padding-padding-padding-padding.test.js',
                'tests/node/repo/build-root-serialization.test.js'
            ]
        ]);
        assert.ok(observedShardArgs.every((args) => !args.includes('--garda-duration-file')));
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests refreshes compact duration telemetry from successful single-file shards', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const durationFile = path.join(buildResult.repoRoot, 'duration-telemetry.json');

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-duration-file',
            durationFile
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = []) => {
            const events = new (require('node:events').EventEmitter)();
            setImmediate(() => {
                events.emit('exit', 0);
                events.emit('close', 0);
            });
            return events as childProcess.ChildProcess;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        const telemetry = JSON.parse(fs.readFileSync(durationFile, 'utf8')) as {
            entries: Record<string, { duration_ms: number; samples: number; }>;
        };
        assert.deepEqual(Object.keys(telemetry.entries).sort(), [
            'tests/node/cli/commands/gates.test.ts',
            'tests/node/repo/build-root-serialization.test.ts'
        ]);
        assert.ok(telemetry.entries['tests/node/cli/commands/gates.test.ts'].duration_ms > 0);
        assert.equal(telemetry.entries['tests/node/repo/build-root-serialization.test.ts'].samples, 1);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests preserves full-file duration telemetry during partial pattern runs', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalConsoleLog = console.log;
    const durationFile = path.join(buildResult.repoRoot, 'duration-telemetry.json');
    const initialTelemetry = {
        schema_version: 1,
        updated_at_utc: new Date(0).toISOString(),
        entries: {
            'tests/node/cli/commands/gates.test.ts': {
                file: 'tests/node/cli/commands/gates.test.ts',
                duration_ms: 5000,
                samples: 4,
                updated_at_utc: new Date(0).toISOString()
            }
        }
    };
    const observedLogs: string[] = [];
    let spawnCount = 0;

    try {
        delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        fs.writeFileSync(durationFile, `${JSON.stringify(initialTelemetry, null, 2)}\n`, 'utf8');
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, _args: readonly string[] = []) => {
            spawnCount += 1;
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;
        console.log = (...args: unknown[]) => {
            observedLogs.push(args.map(String).join(' '));
        };

        const partialRuns = [
            {
                args: ['--test-name-pattern', 'status sync', '--garda-shards', '2'],
                option: '--test-name-pattern',
                expectedSpawnCount: 2
            },
            {
                args: ['--test-name-pattern=status sync'],
                option: '--test-name-pattern',
                expectedSpawnCount: 1
            },
            {
                args: ['--test-skip-pattern', 'status sync', '--garda-shards', '2'],
                option: '--test-skip-pattern',
                expectedSpawnCount: 2
            },
            {
                args: ['--test-skip-pattern=status sync'],
                option: '--test-skip-pattern',
                expectedSpawnCount: 1
            },
            {
                args: ['--test-only'],
                option: '--test-only',
                expectedSpawnCount: 1
            },
            {
                args: ['--test-shard', '1/2', 'tests/node/cli/commands/gates.test.ts'],
                option: '--test-shard',
                expectedSpawnCount: 1
            },
            {
                args: ['--test-shard=1/2', 'tests/node/cli/commands/gates.test.ts'],
                option: '--test-shard',
                expectedSpawnCount: 1
            }
        ];
        for (const partialRun of partialRuns) {
            const spawnCountBeforeRun = spawnCount;
            process.argv = [
                'node',
                'scripts/node-foundation/test.js',
                ...partialRun.args,
                '--garda-duration-file',
                durationFile
            ];
            assert.equal(await testModule.runNodeFoundationTests(), 0);
            assert.equal(spawnCount - spawnCountBeforeRun, partialRun.expectedSpawnCount);
            assert.deepEqual(JSON.parse(fs.readFileSync(durationFile, 'utf8')), initialTelemetry);
            assert.ok(observedLogs.some((line) => (
                line.includes(
                    'NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATE_SKIPPED '
                    + `reason=partial_test_selection option=${partialRun.option}`
                )
            )));
        }

        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            'tests/node/cli/commands/gates.test.ts',
            '--garda-duration-file',
            durationFile
        ];
        const spawnCountBeforeFullFileRun = spawnCount;
        assert.equal(await testModule.runNodeFoundationTests(), 0);
        assert.equal(spawnCount - spawnCountBeforeFullFileRun, 1);
        const updatedTelemetry = JSON.parse(fs.readFileSync(durationFile, 'utf8')) as {
            entries: Record<string, { samples: number; }>;
        };
        assert.equal(updatedTelemetry.entries['tests/node/cli/commands/gates.test.ts'].samples, 5);
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        console.log = originalConsoleLog;
        cleanup();
    }
});

test('duration telemetry writer preserves concurrent single-file updates', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const durationFile = path.join(buildResult.repoRoot, 'duration-telemetry.json');
    const gateTest = path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js');
    const repoTest = path.join(buildResult.buildRoot, 'tests', 'node', 'repo', 'build-root-serialization.test.js');

    try {
        await Promise.all([
            testModule.recordTestDurationTelemetryForTest(durationFile, buildResult, gateTest, 120),
            testModule.recordTestDurationTelemetryForTest(durationFile, buildResult, repoTest, 240)
        ]);

        const telemetry = JSON.parse(fs.readFileSync(durationFile, 'utf8')) as {
            entries: Record<string, { duration_ms: number; samples: number; }>;
        };
        assert.deepEqual(Object.keys(telemetry.entries).sort(), [
            'tests/node/cli/commands/gates.test.ts',
            'tests/node/repo/build-root-serialization.test.ts'
        ]);
        assert.equal(telemetry.entries['tests/node/cli/commands/gates.test.ts'].duration_ms, 120);
        assert.equal(telemetry.entries['tests/node/repo/build-root-serialization.test.ts'].duration_ms, 240);
        assert.equal(telemetry.entries['tests/node/cli/commands/gates.test.ts'].samples, 1);
        assert.equal(fs.existsSync(`${durationFile}.lock`), false);
        assert.equal(
            fs.readdirSync(buildResult.repoRoot).some((fileName) => fileName.endsWith('.tmp')),
            false
        );
    } finally {
        cleanup();
    }
});

test('duration fallback calibrates size in milliseconds and resists an outlier', () => {
    const weights = calibrateDurationWeights([
        { durationMs: 100, fallbackSize: 10 },
        { durationMs: 200, fallbackSize: 20 },
        { durationMs: 10_000, fallbackSize: 10 },
        { durationMs: null, fallbackSize: 30 }
    ]);
    assert.equal(weights[3].weight, 300);
    assert.equal(weights[3].estimatedDurationMs, 300);
    const uncalibrated = calibrateDurationWeights([{ durationMs: null, fallbackSize: 30 }]);
    assert.equal(uncalibrated[0].weight, 30);
    assert.equal(uncalibrated[0].estimatedDurationMs, null);
});

test('forecast accuracy exposes the audited 6.42x underestimate and includes unknown work', () => {
    // TASK.md preserves the audited ratio; normalized times retain it without inventing original wall times.
    const fixture = { formerlyEstimatedMs: 1_000, observedMs: 6_420 };
    assert.match(formatDurationForecastAccuracy(fixture.formerlyEstimatedMs, fixture.observedMs),
        /estimated_wall_error_ms=5420 observed_to_estimated_ratio=6\.42$/);
    const calibrated = calibrateDurationWeights([
        { durationMs: 1_000, fallbackSize: 100 }, { durationMs: null, fallbackSize: 100 }
    ]);
    const estimatedMs = calibrated.reduce((sum, item) => sum + item.estimatedDurationMs!, 0);
    assert.equal(estimatedMs, 2_000);
    assert.match(formatDurationForecastAccuracy(estimatedMs, fixture.observedMs), /observed_to_estimated_ratio=3\.21$/);
    assert.match(formatDurationForecastAccuracy(0, fixture.observedMs), /observed_to_estimated_ratio=unavailable$/);
});

test('duration reporter options preserve version defaults, custom destinations and Windows file URLs', () => {
    const reporter = pathToFileURL(path.join(__dirname, 'path with spaces', 'reporter.js')).href;
    const options = ['--test-reporter', 'tap', '--test-reporter=dot',
        '--test-reporter-destination=stderr', '--test-reporter-destination', 'custom.txt'];
    assert.deepEqual(addDurationReporterOptions(options, reporter), [...options,
        `--test-reporter=${reporter}`, '--test-reporter-destination=stdout']);
    assert.deepEqual(addDurationReporterOptions(['--test-reporter=tap'], reporter), [
        '--test-reporter=tap', '--test-reporter-destination=stdout',
        `--test-reporter=${reporter}`, '--test-reporter-destination=stdout'
    ]);
    assert.deepEqual(addDurationReporterOptions(['--test-name-pattern', '--test-reporter=dot'], reporter, 24), [
        '--test-name-pattern', '--test-reporter=dot', '--test-reporter=spec',
        '--test-reporter-destination=stdout', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout'
    ]);
    const invalid = ['--test-reporter=tap', '--test-reporter=dot'];
    assert.deepEqual(addDurationReporterOptions(invalid, reporter), invalid);
    assert.ok(addDurationReporterOptions([], reporter, 22).includes('--test-reporter=tap'));
    assert.ok(addDurationReporterOptions([], reporter, 24).includes('--test-reporter=spec'));
});

test('duration captures accept only selected files and discard corrupt or oversized input', (context) => {
    const { buildResult, cleanup } = createBuildResultFixture();
    context.after(cleanup);
    const selected = path.join(buildResult.buildRoot, buildResult.copiedFiles[0]);
    const capture = createShardDurationCapture(buildResult.repoRoot, [selected])!;
    fs.writeFileSync(capture.destination, [
        { file: selected, durationMs: 100 }, { file: selected, durationMs: 200 },
        { file: path.join(buildResult.repoRoot, 'unselected.js'), durationMs: 300 },
        { file: selected, durationMs: -1 }
    ].map((record) => JSON.stringify(record)).join('\n'));
    assert.deepEqual(capture.finish(), [{ file: selected, durationMs: 200 }]);
    assert.equal(fs.existsSync(path.dirname(capture.destination)), false);
    for (const content of ['{bad-json', 'x'.repeat(4_097)]) {
        const invalid = createShardDurationCapture(buildResult.repoRoot, [selected])!;
        fs.writeFileSync(invalid.destination, content);
        assert.deepEqual(invalid.finish(), []);
        assert.equal(fs.existsSync(path.dirname(invalid.destination)), false);
    }
    assert.equal(createShardDurationCapture(path.join(buildResult.repoRoot, 'missing'), [selected]), null);
});

test('duration reporter consumes events after optional write failure and omits failed or cumulative summaries', async (context) => {
    const { buildResult, cleanup } = createBuildResultFixture();
    context.after(cleanup);
    const previous = process.env[SHARD_DURATION_OUTPUT_ENV];
    context.after(() => {
        if (previous === undefined) delete process.env[SHARD_DURATION_OUTPUT_ENV];
        else process.env[SHARD_DURATION_OUTPUT_ENV] = previous;
    });
    const reporter = require('../../../scripts/node-foundation/test-duration-reporter') as
        typeof import('../../../scripts/node-foundation/test-duration-reporter');
    const destination = path.join(buildResult.repoRoot, 'records.jsonl');
    const events = [
        { type: 'test:summary', data: { file: 'passed.js', duration_ms: 100, success: true } },
        { type: 'test:summary', data: { file: 'failed.js', duration_ms: 200, success: false } },
        { type: 'test:summary', data: { duration_ms: 300, success: true } },
        { type: 'test:summary', data: { file: 'invalid.js', duration_ms: Number.NaN, success: true } }
    ];
    let consumed = 0;
    async function* source() { for (const event of events) { consumed += 1; yield event; } }
    process.env[SHARD_DURATION_OUTPUT_ENV] = destination;
    for await (const output of reporter(source())) assert.fail(`Unexpected reporter output ${output}`);
    assert.deepEqual(fs.readFileSync(destination, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
        [{ file: 'passed.js', durationMs: 100 }]);
    process.env[SHARD_DURATION_OUTPUT_ENV] = buildResult.repoRoot;
    consumed = 0;
    for await (const output of reporter(source())) assert.fail(`Unexpected reporter output ${output}`);
    assert.equal(consumed, events.length);
});

test('real grouped execution learns both file durations with missing or corrupt telemetry and preserves selection', async (context) => {
    const { buildResult, cleanup } = createBuildResultFixture();
    context.after(cleanup);
    const originalArgv = process.argv;
    context.after(() => { process.argv = originalArgv; });
    context.mock.method(mutableBuildModule, 'buildNodeFoundation', () => buildResult);
    context.mock.method(mutableBuildModule, 'buildPublishRuntime', () => buildResult);
    const originalSpawn = mutableChildProcess.spawn;
    context.mock.method(mutableChildProcess, 'spawn', (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
        const environment = { ...options.env };
        delete environment.NODE_TEST_CONTEXT;
        return originalSpawn(command, args, { ...options, env: environment });
    });
    const lines: string[] = [];
    context.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    for (const relativePath of buildResult.copiedFiles) {
        fs.writeFileSync(path.join(buildResult.buildRoot, relativePath),
            "require('node:test')('selected file ran', async () => { await new Promise(r => setTimeout(r, 20)); });\n");
    }
    const telemetryPath = path.join(buildResult.repoRoot, 'telemetry.json');
    for (const corrupt of [false, true]) {
        if (corrupt) fs.writeFileSync(telemetryPath, '{bad-json');
        process.argv = ['node', 'scripts/node-foundation/test.js', '--garda-shards=1',
            '--garda-duration-file', telemetryPath];
        assert.equal(await testModule.runNodeFoundationTests(), 0);
        const telemetry = JSON.parse(fs.readFileSync(telemetryPath, 'utf8')) as {
            entries: Record<string, { duration_ms: number; samples: number; }>;
        };
        assert.deepEqual(Object.keys(telemetry.entries).sort(), buildResult.copiedFiles
            .map((file) => file.replace(/\.js$/, '.ts')).sort());
        assert.ok(Object.values(telemetry.entries).every((entry) => entry.duration_ms >= 10 && entry.samples === 1));
    }
    assert.ok(lines.some((line) => /files=2$/.test(line)));
});

test('partial shard forecasts include calibrated unknown work and compare the original forecast with actual time', async (context) => {
    const { buildResult, cleanup } = createBuildResultFixture();
    context.after(cleanup);
    const originalArgv = process.argv;
    context.after(() => { process.argv = originalArgv; });
    context.mock.method(mutableBuildModule, 'buildNodeFoundation', () => buildResult);
    context.mock.method(mutableBuildModule, 'buildPublishRuntime', () => buildResult);
    const lines: string[] = [];
    context.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    context.mock.method(mutableChildProcess, 'spawn', () => createCompletingNodeTestChild());
    const durationFile = path.join(buildResult.repoRoot, 'partial.json');
    fs.writeFileSync(durationFile, JSON.stringify({ entries: {
        'tests/node/cli/commands/gates.test.ts': {
            file: 'tests/node/cli/commands/gates.test.ts', duration_ms: 1_000, samples: 1, updated_at_utc: 'fixture'
        }
    } }));
    process.argv = ['node', 'scripts/node-foundation/test.js', '--garda-shards=2',
        '--garda-shard-concurrency=1', '--garda-duration-file', durationFile];
    assert.equal(await testModule.runNodeFoundationTests(), 0);
    const before = lines.find((line) => line.includes('source=pre_run_telemetry'))!;
    const observed = lines.find((line) => line.includes('source=observed_run'))!;
    assert.match(before, /current_estimated_wall_ms=2000 /);
    assert.match(before, /telemetry_known=1\/2 forecast=partial fallback=calibrated_size/);
    assert.match(observed, /current_estimated_wall_ms=2000 /);
    assert.match(observed, /observed_wall_ms=\d+ estimated_wall_error_ms=-?\d+ observed_to_estimated_ratio=/);
    assert.ok(lines.some((line) => /source=post_run_telemetry/.test(line) && /forecast=complete/.test(line)));
});

test('runNodeFoundationTests balances partition wrappers by their shared suite fallback weight', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const observedShardArgs: string[][] = [];

    try {
        const suitePath = addCompiledTestFile(
            buildResult,
            'tests/node/repo/partitioned-heavy-suite.js'
        );
        fs.writeFileSync(suitePath, `${'void 0;\n'.repeat(1_500)}`, 'utf8');
        const directHeavyPath = addCompiledTestFile(
            buildResult,
            'tests/node/repo/direct-heavy.test.js'
        );
        fs.writeFileSync(directHeavyPath, `${'void 0;\n'.repeat(1_000)}`, 'utf8');
        for (let index = 0; index < 6; index += 1) {
            const wrapperPath = addCompiledTestFile(
                buildResult,
                `tests/node/repo/partitioned-heavy-${index + 1}.test.js`
            );
            fs.writeFileSync(wrapperPath, "require('./partitioned-heavy-suite');\n", 'utf8');
        }
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-shard-concurrency',
            '2'
        ];
        delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;

        assert.equal(await testModule.runNodeFoundationTests(), 0);
        assert.equal(observedShardArgs.length, 2);
        const wrapperCounts = observedShardArgs.map((args) => (
            args.filter((arg) => arg.includes('partitioned-heavy-') && arg.endsWith('.test.js')).length
        ));
        assert.ok(
            wrapperCounts.every((count) => count > 0),
            `Expected partition wrappers in both shards, got ${wrapperCounts.join('/')}.`
        );
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests keeps full-sized requested shards command-line safe with repo-relative file args', async () => {
    const { buildResult, cleanup } = createBuildResultFixture(440);
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const observedShardArgs: string[][] = [];

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--garda-shards',
            '2',
            '--garda-shard-concurrency',
            '2'
        ];
        delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            const events = new (require('node:events').EventEmitter)();
            setImmediate(() => {
                events.emit('exit', 0);
                events.emit('close', 0);
            });
            return events as childProcess.ChildProcess;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedShardArgs.length, 2);
        assert.ok(observedShardArgs.every((args) => args[0] === '--test'));
        const observedFiles = observedShardArgs.flatMap((args) => args.filter((arg) => !arg.startsWith('--')));
        assert.equal(observedFiles.length, buildResult.copiedFiles.length);
        assert.equal(new Set(observedFiles).size, buildResult.copiedFiles.length);
        assert.ok(observedFiles.every((file) => !path.isAbsolute(file)));
        assert.ok(
            observedShardArgs.every((args) => (
                [process.execPath, ...args].reduce((total, arg) => total + arg.length + 3, 0)
                <= EXPECTED_MAX_SHARD_ARG_CHARS
            )),
            `Expected grouped shard commands to stay within ${EXPECTED_MAX_SHARD_ARG_CHARS} characters.`
        );
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests keeps skewed automatic shards within the file ceiling', async (context) => {
    const { buildResult, cleanup } = createBuildResultFixture(100);
    context.after(cleanup);
    const originalArgv = process.argv;
    context.after(() => { process.argv = originalArgv; });
    process.argv = ['node', 'scripts/node-foundation/test.js'];
    const durationFile = path.join(buildResult.repoRoot, 'duration-telemetry.json');
    const entries = Object.fromEntries(buildResult.copiedFiles.map((relativePath, index) => {
        const file = relativePath.replace(/\.js$/i, '.ts');
        return [file, {
            file,
            duration_ms: index < 3 ? 239_000 : 1,
            samples: 1,
            updated_at_utc: new Date(0).toISOString()
        }];
    }));
    fs.writeFileSync(durationFile, JSON.stringify({
        schema_version: 1,
        updated_at_utc: new Date(0).toISOString(),
        entries
    }));
    process.argv.push('--garda-duration-file', durationFile);
    context.mock.method(mutableBuildModule, 'buildPublishRuntime', () => buildResult);
    context.mock.method(mutableBuildModule, 'buildNodeFoundation', () => buildResult);
    const observedShardArgs: string[][] = [];
    context.mock.method(mutableChildProcess, 'spawn', (_: string, args: readonly string[] = []) => {
        observedShardArgs.push(Array.from(args));
        return createCompletingNodeTestChild();
    });

    assert.equal(await testModule.runNodeFoundationTests(), 0);
    const shardFileCounts = observedShardArgs.map((args) => args.filter((arg) => !arg.startsWith('--')).length);
    assert.ok(shardFileCounts.length >= Math.ceil(buildResult.copiedFiles.length / EXPECTED_AUTO_SHARD_MAX_FILES));
    assert.ok(shardFileCounts.every((count) => count <= EXPECTED_AUTO_SHARD_MAX_FILES));
    assert.equal(shardFileCounts.reduce((sum, count) => sum + count, 0), buildResult.copiedFiles.length);
});

test('runNodeFoundationTests auto-shards when repo-relative test args still exceed the Windows limit', async () => {
    const { buildResult, cleanup } = createBuildResultFixture(600);
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const originalAvailableParallelism = mutableOs.availableParallelism;
    const observedShardArgs: string[][] = [];
    let activeShards = 0;
    let maxActiveShards = 0;

    try {
        mutableOs.availableParallelism = () => 8;
        process.argv = ['node', 'scripts/node-foundation/test.js'];
        delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            activeShards += 1;
            maxActiveShards = Math.max(maxActiveShards, activeShards);
            const events = new (require('node:events').EventEmitter)() as childProcess.ChildProcess;
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            Object.assign(events, { stdout, stderr });
            setTimeout(() => {
                stdout.end('ok\n');
                stderr.end();
                activeShards -= 1;
                events.emit('exit', 0);
                events.emit('close', 0);
            }, 10);
            return events;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.ok(
            observedShardArgs.length > 2,
            `Expected oversized repo-relative argv to auto-shard, got ${observedShardArgs.length} shard(s).`
        );
        assert.equal(maxActiveShards, 4);
        assert.ok(observedShardArgs.every((args) => args[0] === '--test'));
        assert.ok(
            observedShardArgs.every((args) => (
                args.filter((arg) => !arg.startsWith('--')).length <= EXPECTED_AUTO_SHARD_MAX_FILES
            )),
            `Expected automatic shards to contain at most ${EXPECTED_AUTO_SHARD_MAX_FILES} files.`
        );
        assert.ok(
            observedShardArgs.every((args) => (
                [process.execPath, ...args].reduce((total, arg) => total + arg.length + 3, 0)
                <= EXPECTED_MAX_SHARD_ARG_CHARS
            )),
            `Expected grouped shard commands to stay within ${EXPECTED_MAX_SHARD_ARG_CHARS} characters.`
        );
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        mutableOs.availableParallelism = originalAvailableParallelism;
        cleanup();
    }
});

test('runNodeFoundationTests rejects an oversized shard plan before starting any process', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    addCompiledTestFile(buildResult, 'tests/node/bin/garda-delegation.test.js');
    const oversizedPatterns = [
        `${'\\'.repeat(10)}"`.repeat(1_800),
        ` ${'😀'.repeat(11_999)}`
    ];
    let spawnCount = 0;
    assert.ok(oversizedPatterns.every((pattern) => pattern.length < EXPECTED_MAX_SHARD_ARG_CHARS));

    try {
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, __: readonly string[] = []) => {
            spawnCount += 1;
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;

        for (const oversizedPattern of oversizedPatterns) {
            process.argv = [
                'node',
                'scripts/node-foundation/test.js',
                '--garda-shards',
                '2',
                '--test-name-pattern',
                oversizedPattern
            ];
            await assert.rejects(
                () => testModule.runNodeFoundationTests(),
                /Node test shard command line exceeds 24000 characters/
            );
        }
        assert.equal(spawnCount, 0);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests expands a directory fileTarget to all .test.js files under it', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    let observedArgs: string[] = [];

    try {
        // Pass the directory 'tests/node/cli/commands' as a fileTarget.
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            'tests/node/cli/commands'
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedArgs = Array.from(args);
            return createCompletingNodeTestChild();
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        // The directory target should have expanded to the gates.test.js file inside cli/commands.
        assert.ok(
            observedArgs.includes(toNodeTestFileArg(
                buildResult,
                path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js')
            )),
            `Expected expanded directory file in args, got: ${JSON.stringify(observedArgs)}`
        );
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});
