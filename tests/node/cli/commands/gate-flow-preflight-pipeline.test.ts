import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    GATE_FLOW_PREFLIGHT_PIPELINE_MIGRATION_CHECKLIST,
    GATE_FLOW_PREFLIGHT_PIPELINE_STAGES,
    runGateFlowPreflightPipeline,
    runGateFlowPreflightPipelineSync,
    type GateFlowPreflightPipeline,
    type GateFlowSynchronousPreflightPipelineExtension,
    type GateFlowSynchronousPreflightPipeline
} from '../../../../src/cli/commands/gate-flows/support/gate-flow-preflight-pipeline';
import {
    runReviewFlowPreflightPipeline
} from '../../../../src/cli/commands/gate-flows/review/review-flow-preflight-pipeline';
import {
    runFullSuiteValidationPreflightPipeline
} from '../../../../src/cli/commands/gate-flows/full-suite/full-suite-validation-preflight-pipeline';
import {
    runRecoveryFlowPreflightPipeline
} from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-preflight-pipeline';
import {
    runCompileGateCommand,
    runFullSuiteValidationCommand,
    runRequiredReviewsCheckCommand
} from '../../../../src/cli/commands/gates';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import {
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeBudgetOutputFilters,
    writeCompilePassEvidence,
    writePreflight
} from './gate-test-helpers';

interface TestInput {
    rawTaskId: string;
}

interface TestParsed {
    taskId: string;
}

interface TestTaskModeEvidence {
    status: 'PASS';
}

interface TestPreflight {
    mode: 'FULL_PATH';
}

interface TestTimelineReadiness {
    ready: boolean;
}

type TestPipeline = GateFlowPreflightPipeline<
    TestInput,
    TestParsed,
    TestTaskModeEvidence,
    TestPreflight,
    TestTimelineReadiness,
    string
>;

type TestSynchronousPipeline = GateFlowSynchronousPreflightPipeline<
    TestInput,
    TestParsed,
    TestTaskModeEvidence,
    TestPreflight,
    TestTimelineReadiness,
    string
>;

type TestSynchronousExtension = GateFlowSynchronousPreflightPipelineExtension<
    TestInput,
    TestParsed,
    TestTaskModeEvidence,
    TestPreflight,
    TestTimelineReadiness
>;

function createTestPipeline(events: string[]): TestPipeline {
    return {
        parse(input) {
            events.push('parse');
            return { taskId: input.rawTaskId.trim() };
        },
        loadTaskModeEvidence(context) {
            events.push('task-mode');
            assert.equal(context.parsed.taskId, 'T-932-1');
            return { status: 'PASS' };
        },
        loadPreflight(context) {
            events.push('preflight');
            assert.equal(context.taskModeEvidence.status, 'PASS');
            return { mode: 'FULL_PATH' };
        },
        evaluateTimelineReadiness(context) {
            events.push('timeline');
            assert.equal(context.preflight.mode, 'FULL_PATH');
            return { ready: true };
        },
        emit(context) {
            events.push('emit');
            assert.equal(context.timelineReadiness.ready, true);
            return `${context.parsed.taskId}:${context.preflight.mode}`;
        }
    };
}

function createSynchronousTestPipeline(events: string[]): TestSynchronousPipeline {
    return {
        parse(input) {
            events.push('parse');
            return { taskId: input.rawTaskId.trim() };
        },
        loadTaskModeEvidence(context) {
            events.push('task-mode');
            assert.ok(context.parsed.taskId);
            return { status: 'PASS' };
        },
        loadPreflight(context) {
            events.push('preflight');
            assert.equal(context.taskModeEvidence.status, 'PASS');
            return { mode: 'FULL_PATH' };
        },
        evaluateTimelineReadiness(context) {
            events.push('timeline');
            assert.equal(context.preflight.mode, 'FULL_PATH');
            return { ready: true };
        },
        emit(context) {
            events.push('emit');
            assert.equal(context.timelineReadiness.ready, true);
            return `${context.parsed.taskId}:${context.preflight.mode}`;
        }
    };
}

function assertSynchronousPipelineRejectsPromiseCallbacks(
    pipeline: TestSynchronousPipeline
): void {
    // @ts-expect-error Synchronous pipelines must reject Promise-returning callbacks.
    pipeline.parse = async (input) => ({ taskId: input.rawTaskId.trim() });
    // @ts-expect-error Synchronous pipelines must reject Promise-returning callbacks.
    pipeline.loadTaskModeEvidence = async () => ({ status: 'PASS' });
    // @ts-expect-error Synchronous pipelines must reject Promise-returning callbacks.
    pipeline.loadPreflight = async () => ({ mode: 'FULL_PATH' });
    // @ts-expect-error Synchronous pipelines must reject Promise-returning callbacks.
    pipeline.evaluateTimelineReadiness = async () => ({ ready: true });
    // @ts-expect-error Synchronous pipelines must reject Promise-returning callbacks.
    pipeline.emit = async () => 'T-932-3-F1:FULL_PATH';
}

void assertSynchronousPipelineRejectsPromiseCallbacks;

function assertPretypedSynchronousExtensionRejectsPromiseHooks(
    extension: TestSynchronousExtension
): void {
    // @ts-expect-error Pre-typed synchronous extensions must reject asynchronous hooks.
    extension.afterParse = async () => {};
    // @ts-expect-error Pre-typed synchronous extensions must reject asynchronous hooks.
    extension.afterTaskModeEvidence = async () => {};
    // @ts-expect-error Pre-typed synchronous extensions must reject asynchronous hooks.
    extension.afterPreflight = async () => {};
    // @ts-expect-error Pre-typed synchronous extensions must reject asynchronous hooks.
    extension.afterTimelineReadiness = async () => {};
    // @ts-expect-error Pre-typed synchronous extensions must reject asynchronous hooks.
    extension.beforeEmit = async () => {};
}

void assertPretypedSynchronousExtensionRejectsPromiseHooks;

function assertSynchronousCallRejectsInferredPromiseCallbacks(): void {
    const input = { rawTaskId: 'T-932-3-F1' };
    const coreCallbacks = createSynchronousTestPipeline([]);

    // @ts-expect-error Inline inference must not admit Promise-returning core callbacks.
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        parse: async (value: TestInput) => ({ taskId: value.rawTaskId.trim() })
    });
    // @ts-expect-error Inline inference must not admit Promise-returning core callbacks.
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        loadTaskModeEvidence: async () => ({ status: 'PASS' as const })
    });
    // @ts-expect-error Inline inference must not admit Promise-returning core callbacks.
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        loadPreflight: async () => ({ mode: 'FULL_PATH' as const })
    });
    // @ts-expect-error Inline inference must not admit Promise-returning core callbacks.
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        evaluateTimelineReadiness: async () => ({ ready: true })
    });
    // @ts-expect-error Inline inference must not admit Promise-returning core callbacks.
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        emit: async () => 'T-932-3-F1:FULL_PATH'
    });
}

void assertSynchronousCallRejectsInferredPromiseCallbacks;

function assertSynchronousCallRejectsInferredPromiseExtensionHooks(): void {
    const input = { rawTaskId: 'T-932-3-F1' };
    const coreCallbacks = {
        parse: (value: TestInput) => ({ taskId: value.rawTaskId.trim() }),
        loadTaskModeEvidence: () => ({ status: 'PASS' as const }),
        loadPreflight: () => ({ mode: 'FULL_PATH' as const }),
        evaluateTimelineReadiness: () => ({ ready: true }),
        emit: () => 'T-932-3-F1:FULL_PATH'
    };

    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        extensions: [{
            // @ts-expect-error Inline inference must reject an asynchronous afterParse hook.
            async afterParse() {}
        }]
    });
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        extensions: [{
            // @ts-expect-error Inline inference must reject an asynchronous afterTaskModeEvidence hook.
            async afterTaskModeEvidence() {}
        }]
    });
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        extensions: [{
            // @ts-expect-error Inline inference must reject an asynchronous afterPreflight hook.
            async afterPreflight() {}
        }]
    });
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        extensions: [{
            // @ts-expect-error Inline inference must reject an asynchronous afterTimelineReadiness hook.
            async afterTimelineReadiness() {}
        }]
    });
    runGateFlowPreflightPipelineSync(input, {
        ...coreCallbacks,
        extensions: [{
            // @ts-expect-error Inline inference must reject an asynchronous beforeEmit hook.
            async beforeEmit() {}
        }]
    });
}

void assertSynchronousCallRejectsInferredPromiseExtensionHooks;

function normalizeCompileOutputContract(outputLines: string[]): string[] {
    return outputLines.map((line) => line
        .replace(/duration_ms=\d+/u, 'duration_ms=<duration>')
        .replace(/sha256=[a-f0-9]{64}/u, 'sha256=<sha256>')
        .replace(/chars=\d+/u, 'chars=<chars>'));
}

function isUnavailableWindowsJunctionError(error: unknown): boolean {
    if (process.platform !== 'win32' || !error || typeof error !== 'object') {
        return false;
    }
    const code = String((error as NodeJS.ErrnoException).code || '').trim().toUpperCase();
    return new Set(['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM']).has(code);
}

describe('gate-flow preflight pipeline', () => {
    it('publishes the canonical stage order', () => {
        assert.deepEqual(GATE_FLOW_PREFLIGHT_PIPELINE_STAGES, [
            'parse',
            'task-mode-evidence',
            'preflight',
            'timeline-readiness',
            'emit'
        ]);
    });

    it('tracks the compile pilot and remaining flow migrations', () => {
        assert.deepEqual(GATE_FLOW_PREFLIGHT_PIPELINE_MIGRATION_CHECKLIST, {
            compile: 'pilot-migrated',
            review: 'migrated',
            'full-suite': 'migrated',
            recovery: 'migrated'
        });
    });

    it('runs the canonical parse to emit sequence', async () => {
        const events: string[] = [];

        const output = await runGateFlowPreflightPipeline(
            { rawTaskId: ' T-932-1 ' },
            createTestPipeline(events)
        );

        assert.equal(output, 'T-932-1:FULL_PATH');
        assert.deepEqual(events, ['parse', 'task-mode', 'preflight', 'timeline', 'emit']);
    });

    it('awaits asynchronous core callbacks before advancing', async () => {
        const events: string[] = [];
        const pipeline = createTestPipeline(events);
        pipeline.loadTaskModeEvidence = async (context) => {
            events.push('task-mode:start');
            await Promise.resolve();
            events.push('task-mode:resolved');
            assert.equal(context.parsed.taskId, 'T-932-1');
            return { status: 'PASS' };
        };

        const output = await runGateFlowPreflightPipeline(
            { rawTaskId: 'T-932-1' },
            pipeline
        );

        assert.equal(output, 'T-932-1:FULL_PATH');
        assert.deepEqual(events, [
            'parse',
            'task-mode:start',
            'task-mode:resolved',
            'preflight',
            'timeline',
            'emit'
        ]);
    });

    it('runs extension hooks in registration order with accumulated context', async () => {
        const events: string[] = [];
        const pipeline = createTestPipeline(events);
        const statefulExtension = {
            events,
            afterParse(context: { parsed: TestParsed }) {
                this.events.push(`extension-a:parse:${context.parsed.taskId}`);
            },
            afterTaskModeEvidence(context: { taskModeEvidence: TestTaskModeEvidence }) {
                this.events.push(`extension-a:task-mode:${context.taskModeEvidence.status}`);
            },
            afterPreflight(context: { preflight: TestPreflight }) {
                this.events.push(`extension-a:preflight:${context.preflight.mode}`);
            },
            afterTimelineReadiness(context: { timelineReadiness: TestTimelineReadiness }) {
                this.events.push(`extension-a:timeline:${context.timelineReadiness.ready}`);
            },
            beforeEmit(context: { parsed: TestParsed }) {
                this.events.push(`extension-a:emit:${context.parsed.taskId}`);
            }
        };
        pipeline.extensions = [
            statefulExtension,
            {
                async afterParse(context) {
                    await Promise.resolve();
                    events.push(`extension-b:parse:${context.parsed.taskId}`);
                }
            }
        ];

        await runGateFlowPreflightPipeline({ rawTaskId: 'T-932-1' }, pipeline);

        assert.deepEqual(events, [
            'parse',
            'extension-a:parse:T-932-1',
            'extension-b:parse:T-932-1',
            'task-mode',
            'extension-a:task-mode:PASS',
            'preflight',
            'extension-a:preflight:FULL_PATH',
            'timeline',
            'extension-a:timeline:true',
            'extension-a:emit:T-932-1',
            'emit'
        ]);
    });

    it('stops before downstream stages when a core step fails', async () => {
        const events: string[] = [];
        const pipeline = createTestPipeline(events);
        pipeline.extensions = [
            {
                afterPreflight() {
                    events.push('extension:preflight');
                },
                afterTimelineReadiness() {
                    events.push('extension:timeline');
                },
                beforeEmit() {
                    events.push('extension:emit');
                }
            }
        ];
        pipeline.loadPreflight = () => {
            events.push('preflight');
            throw new Error('preflight rejected');
        };

        await assert.rejects(
            runGateFlowPreflightPipeline({ rawTaskId: 'T-932-1' }, pipeline),
            /preflight rejected/
        );
        assert.deepEqual(events, ['parse', 'task-mode', 'preflight']);
    });

    it('stops the pipeline and remaining hooks when an extension rejects', async () => {
        const events: string[] = [];
        const pipeline = createTestPipeline(events);
        pipeline.extensions = [
            {
                async afterTaskModeEvidence() {
                    events.push('extension-a:task-mode:start');
                    await Promise.resolve();
                    events.push('extension-a:task-mode:rejected');
                    throw new Error('extension rejected');
                }
            },
            {
                afterTaskModeEvidence() {
                    events.push('extension-b:task-mode');
                },
                afterPreflight() {
                    events.push('extension-b:preflight');
                }
            }
        ];

        await assert.rejects(
            runGateFlowPreflightPipeline({ rawTaskId: 'T-932-1' }, pipeline),
            /extension rejected/
        );
        assert.deepEqual(events, [
            'parse',
            'task-mode',
            'extension-a:task-mode:start',
            'extension-a:task-mode:rejected'
        ]);
    });

    it('supports synchronous flows without changing the canonical stage order', () => {
        const events: string[] = [];
        const output = runGateFlowPreflightPipelineSync(
            { rawTaskId: ' T-932-3 ' },
            createSynchronousTestPipeline(events)
        );

        assert.equal(output, 'T-932-3:FULL_PATH');
        assert.deepEqual(events, ['parse', 'task-mode', 'preflight', 'timeline', 'emit']);
    });

    it('runs synchronous extension hooks in registration order with accumulated context', () => {
        const events: string[] = [];
        const pipeline = createSynchronousTestPipeline(events);
        const statefulExtension = {
            events,
            afterParse(context: { parsed: TestParsed }): void {
                this.events.push(`extension-a:parse:${context.parsed.taskId}`);
            },
            afterTaskModeEvidence(context: { taskModeEvidence: TestTaskModeEvidence }): void {
                this.events.push(`extension-a:task-mode:${context.taskModeEvidence.status}`);
            },
            afterPreflight(context: { preflight: TestPreflight }): void {
                this.events.push(`extension-a:preflight:${context.preflight.mode}`);
            },
            afterTimelineReadiness(context: { timelineReadiness: TestTimelineReadiness }): void {
                this.events.push(`extension-a:timeline:${context.timelineReadiness.ready}`);
            },
            beforeEmit(context: { parsed: TestParsed }): void {
                this.events.push(`extension-a:emit:${context.parsed.taskId}`);
            }
        };
        pipeline.extensions = [
            statefulExtension,
            {
                afterParse(context) {
                    events.push(`extension-b:parse:${context.parsed.taskId}`);
                },
                beforeEmit(context) {
                    events.push(`extension-b:emit:${context.preflight.mode}`);
                }
            }
        ];
        const output = runGateFlowPreflightPipelineSync(
            { rawTaskId: ' T-932-3-F1 ' },
            pipeline
        );

        assert.equal(output, 'T-932-3-F1:FULL_PATH');
        assert.deepEqual(events, [
            'parse',
            'extension-a:parse:T-932-3-F1',
            'extension-b:parse:T-932-3-F1',
            'task-mode',
            'extension-a:task-mode:PASS',
            'preflight',
            'extension-a:preflight:FULL_PATH',
            'timeline',
            'extension-a:timeline:true',
            'extension-a:emit:T-932-3-F1',
            'extension-b:emit:FULL_PATH',
            'emit'
        ]);
    });

    it('rejects Promise-returning synchronous extension hooks before downstream stages', () => {
        const events: string[] = [];
        const pipeline = createSynchronousTestPipeline(events);
        const promiseReturningExtension = {
            async afterTaskModeEvidence() {
                events.push('extension:promise');
            }
        };
        pipeline.extensions = [
            promiseReturningExtension as unknown as TestSynchronousExtension
        ];

        assert.throws(
            () => runGateFlowPreflightPipelineSync(
                { rawTaskId: 'T-932-3-F1' },
                pipeline
            ),
            /extension hook returned a Promise-like value/
        );
        assert.deepEqual(events, ['parse', 'task-mode', 'extension:promise']);
    });

    const returnStructuralThenable = () => ({ then() {} });
    const coreThenableCases: Array<{
        name: string;
        configure: (pipeline: TestSynchronousPipeline) => void;
        expectedError: RegExp;
        expectedEvents: string[];
    }> = [
        {
            name: 'parse',
            configure(pipeline) {
                pipeline.parse =
                    returnStructuralThenable as unknown as TestSynchronousPipeline['parse'];
            },
            expectedError: /parse callback returned a Promise-like value/,
            expectedEvents: []
        },
        {
            name: 'task-mode evidence',
            configure(pipeline) {
                pipeline.loadTaskModeEvidence =
                    returnStructuralThenable as unknown as
                    TestSynchronousPipeline['loadTaskModeEvidence'];
            },
            expectedError: /task-mode callback returned a Promise-like value/,
            expectedEvents: ['parse']
        },
        {
            name: 'preflight',
            configure(pipeline) {
                pipeline.loadPreflight =
                    returnStructuralThenable as unknown as TestSynchronousPipeline['loadPreflight'];
            },
            expectedError: /preflight callback returned a Promise-like value/,
            expectedEvents: ['parse', 'task-mode']
        },
        {
            name: 'timeline readiness',
            configure(pipeline) {
                pipeline.evaluateTimelineReadiness =
                    returnStructuralThenable as unknown as
                    TestSynchronousPipeline['evaluateTimelineReadiness'];
            },
            expectedError: /timeline-readiness callback returned a Promise-like value/,
            expectedEvents: ['parse', 'task-mode', 'preflight']
        },
        {
            name: 'emit',
            configure(pipeline) {
                pipeline.emit =
                    returnStructuralThenable as unknown as TestSynchronousPipeline['emit'];
            },
            expectedError: /emit callback returned a Promise-like value/,
            expectedEvents: ['parse', 'task-mode', 'preflight', 'timeline']
        }
    ];

    for (const coreThenableCase of coreThenableCases) {
        it(`fails closed when ${coreThenableCase.name} returns a structural thenable`, () => {
            const events: string[] = [];
            const pipeline = createSynchronousTestPipeline(events);
            coreThenableCase.configure(pipeline);

            assert.throws(
                () => runGateFlowPreflightPipelineSync(
                    { rawTaskId: 'T-932-3-F1' },
                    pipeline
                ),
                coreThenableCase.expectedError
            );
            assert.deepEqual(events, coreThenableCase.expectedEvents);
        });
    }

    it('fails closed when a synchronous callback returns a callable thenable', () => {
        const events: string[] = [];
        const pipeline = createSynchronousTestPipeline(events);
        const callableThenable = Object.assign(
            () => undefined,
            { then() {} }
        );
        pipeline.parse =
            (() => callableThenable) as unknown as TestSynchronousPipeline['parse'];

        assert.throws(
            () => runGateFlowPreflightPipelineSync(
                { rawTaskId: 'T-932-3-F1-F1' },
                pipeline
            ),
            /parse callback returned a Promise-like value/
        );
        assert.deepEqual(events, []);
    });

    it('accepts null as a valid synchronous callback result', () => {
        const events: string[] = [];
        const pipeline: GateFlowSynchronousPreflightPipeline<
            TestInput,
            TestParsed,
            TestTaskModeEvidence,
            TestPreflight,
            TestTimelineReadiness,
            null
        > = {
            ...createSynchronousTestPipeline(events),
            emit(context) {
                events.push('emit');
                assert.equal(context.timelineReadiness.ready, true);
                return null;
            }
        };

        const output = runGateFlowPreflightPipelineSync(
            { rawTaskId: 'T-932-3-F1-F1' },
            pipeline
        );

        assert.equal(output, null);
        assert.deepEqual(events, ['parse', 'task-mode', 'preflight', 'timeline', 'emit']);
    });

    it('observes a rejected Promise before reporting a synchronous contract violation', async () => {
        const events: string[] = [];
        const pipeline = createSynchronousTestPipeline(events);
        const rejection = new Error('async parse rejection');
        const matchingUnhandledRejections: unknown[] = [];
        const recordUnhandledRejection = (reason: unknown): void => {
            if (reason === rejection) {
                matchingUnhandledRejections.push(reason);
            }
        };
        const promiseReturningParse = () => Promise.reject(rejection);
        pipeline.parse = promiseReturningParse as unknown as TestSynchronousPipeline['parse'];
        process.on('unhandledRejection', recordUnhandledRejection);

        try {
            assert.throws(
                () => runGateFlowPreflightPipelineSync(
                    { rawTaskId: 'T-932-3-F1' },
                    pipeline
                ),
                /parse callback returned a Promise-like value/
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.deepEqual(matchingUnhandledRejections, []);
        } finally {
            process.off('unhandledRejection', recordUnhandledRejection);
        }
    });

    it('stops synchronous downstream stages when a core step throws', () => {
        const events: string[] = [];
        const pipeline = createSynchronousTestPipeline(events);
        pipeline.loadPreflight = () => {
            events.push('preflight:rejected');
            throw new Error('synchronous preflight rejected');
        };
        pipeline.extensions = [{
            afterPreflight() {
                events.push('extension:preflight');
            },
            afterTimelineReadiness() {
                events.push('extension:timeline');
            }
        }];

        assert.throws(
            () => runGateFlowPreflightPipelineSync(
                { rawTaskId: 'T-932-3-F1' },
                pipeline
            ),
            /synchronous preflight rejected/
        );
        assert.deepEqual(events, ['parse', 'task-mode', 'preflight:rejected']);
    });

    it('prevents synchronous hooks and downstream stages when an extension fails', () => {
        const events: string[] = [];
        const pipeline = createSynchronousTestPipeline(events);
        pipeline.extensions = [
            {
                afterTaskModeEvidence() {
                    events.push('extension-a:task-mode:rejected');
                    throw new Error('synchronous extension rejected');
                }
            },
            {
                afterTaskModeEvidence() {
                    events.push('extension-b:task-mode');
                },
                afterPreflight() {
                    events.push('extension-b:preflight');
                }
            }
        ];

        assert.throws(
            () => runGateFlowPreflightPipelineSync(
                { rawTaskId: 'T-932-3-F1' },
                pipeline
            ),
            /synchronous extension rejected/
        );
        assert.deepEqual(events, [
            'parse',
            'task-mode',
            'extension-a:task-mode:rejected'
        ]);
    });
});

describe('compile gate shared preflight pipeline pilot', () => {
    it('preserves compile success output and task-bound evidence wiring', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-2-compile-pilot';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
            const commandsPath = path.join(repoRoot, 'commands.md');
            fs.writeFileSync(commandsPath, [
                '### Compile Gate (Mandatory)',
                '```bash',
                'node -e "console.log(\'build ok\')"',
                '```'
            ].join('\n'), 'utf8');
            initializeGitRepo(repoRoot);
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'app.ts'),
                'const a = 3;\nconst b = 2;\nconst c = 1;\nconsole.log(a + b);\n',
                'utf8'
            );
            const preflightPath = writePreflight(repoRoot, taskId, {
                metrics: { changed_lines_total: 3 }
            });

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Exercise the compile shared preflight pipeline pilot'
            }).exitCode, 0);
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

            const result = await runCompileGateCommand({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                outputFiltersPath,
                emitMetrics: false
            });
            const evidence = JSON.parse(fs.readFileSync(
                path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`),
                'utf8'
            )) as {
                preflight_path: string;
                task_mode: { task_id: string };
                rule_pack: { stage: string };
                post_preflight_sequence: { timeline_path: string };
            };

            assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
            assert.deepEqual(normalizeCompileOutputContract(result.outputLines), [
                'COMPILE_GATE_PASSED',
                'CompileSummary: PASSED | duration_ms=<duration> | exit_code=0 | errors=0 | warnings=0',
                'CompileOutputRetention: retained=false reason=SUCCESS_LOG_OMITTED '
                    + 'sha256=<sha256> lines=11 chars=<chars>'
            ]);
            assert.equal(evidence.preflight_path, path.resolve(preflightPath).replace(/\\/g, '/'));
            assert.equal(evidence.task_mode.task_id, taskId);
            assert.equal(evidence.rule_pack.stage, 'POST_PREFLIGHT');
            assert.equal(
                evidence.post_preflight_sequence.timeline_path,
                path.join(
                    getOrchestratorRoot(repoRoot),
                    'runtime',
                    'task-events',
                    `${taskId}.jsonl`
                ).replace(/\\/g, '/')
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves missing shell-smoke failure and recovery output', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-2-compile-pilot-missing-shell-smoke';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
            const commandsPath = path.join(repoRoot, 'commands.md');
            fs.writeFileSync(commandsPath, [
                '### Compile Gate (Mandatory)',
                '```bash',
                'node -e "console.log(\'build must not run\')"',
                '```'
            ].join('\n'), 'utf8');
            initializeGitRepo(repoRoot);
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'app.ts'),
                'const a = 3;\nconst b = 2;\nconst c = 1;\nconsole.log(a + b);\n',
                'utf8'
            );
            const preflightPath = writePreflight(repoRoot, taskId);

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject compile pilot without shell-smoke evidence'
            }).exitCode, 0);
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

            const result = await runCompileGateCommand({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                outputFiltersPath,
                emitMetrics: false
            });
            const timelinePath = path.join(
                getOrchestratorRoot(repoRoot),
                'runtime',
                'task-events',
                `${taskId}.jsonl`
            ).replace(/\\/g, '/');
            const compileOutputPath = path.join(
                getReviewsRoot(repoRoot),
                `${taskId}-compile-output.log`
            ).replace(/\\/g, '/');
            const failureReason = `Task timeline '${timelinePath}' is missing `
                + 'SHELL_SMOKE_PREFLIGHT_RECORDED. Run shell-smoke-preflight before compile gate. '
                + `NextStep: run node garda-agent-orchestrator/bin/garda.js next-step "${taskId}" `
                + '--repo-root "." and follow its single recommended command before retrying compile-gate.';

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.deepEqual(normalizeCompileOutputContract(result.outputLines), [
                'COMPILE_GATE_FAILED',
                'CompileSummary: FAILED | duration_ms=<duration> | exit_code=3 | errors=0 | warnings=0',
                `CompileOutputPath: ${compileOutputPath}`,
                'CompileOutputRetention: retained=true reason=FULL_OUTPUT_RETAINED '
                    + 'sha256=null lines=0 chars=<chars>',
                `Reason: ${failureReason}`
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});

describe('review and full-suite shared preflight pipeline migration', () => {
    it('preserves task-bound preflight, task-mode, rule-pack, and timeline evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-3-review-full-suite-migration';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId);

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Exercise review and full-suite preflight adapters'
            }).exitCode, 0);
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);

            const review = runReviewFlowPreflightPipeline({
                repoRoot,
                orchestratorRoot: getOrchestratorRoot(repoRoot),
                taskId,
                preflightPath
            });
            const fullSuite = runFullSuiteValidationPreflightPipeline({
                repoRoot,
                taskId,
                preflightPath
            });
            const normalizedPreflightPath = path.resolve(preflightPath).replace(/\\/g, '/');
            const normalizedTimelinePath = path.join(
                getOrchestratorRoot(repoRoot),
                'runtime',
                'task-events',
                `${taskId}.jsonl`
            ).replace(/\\/g, '/');

            assert.equal(review.validatedPreflight.resolved_task_id, taskId);
            assert.equal(review.taskModeEvidence.task_id, taskId);
            assert.equal(review.rulePackEvidence.stage, 'POST_PREFLIGHT');
            assert.equal(review.timelineReadiness?.timelinePath, normalizedTimelinePath);
            assert.deepEqual(review.timelineReadiness?.violations, []);

            assert.equal(fullSuite.preflight.task_id, taskId);
            assert.equal(fullSuite.taskModeEvidence.task_id, taskId);
            assert.equal(fullSuite.timelinePath, normalizedTimelinePath);
            assert.equal(fullSuite.cycleBinding.preflight_path, normalizedPreflightPath);
            assert.ok(fullSuite.cycleBinding.preflight_sha256);
            assert.ok(fullSuite.cycleBinding.compile_gate_timestamp);
            assert.equal(fullSuite.timelineReadiness.compileEvidenceCurrent, true);
            assert.deepEqual(fullSuite.timelineReadiness.violations, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('reports full-suite readiness violations before a current compile pass', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-3-full-suite-missing-compile';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId);

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject full-suite preflight without compile evidence'
            }).exitCode, 0);

            const fullSuite = runFullSuiteValidationPreflightPipeline({
                repoRoot,
                taskId,
                preflightPath
            });
            assert.match(
                fullSuite.timelineReadiness.violations.join(' '),
                /missing COMPILE_GATE_PASSED\. Run compile-gate before full-suite validation\./
            );
            assert.equal(fullSuite.timelineReadiness.compileEvidenceCurrent, false);
            assert.equal(fullSuite.cycleBinding.compile_gate_timestamp, null);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks executable full-suite validation when lifecycle compile evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-3-full-suite-command-missing-compile';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const workflowConfigPath = path.join(
                getOrchestratorRoot(repoRoot),
                'live',
                'config',
                'workflow-config.json'
            );
            const workflowConfig = JSON.parse(
                fs.readFileSync(workflowConfigPath, 'utf8')
            ) as Record<string, unknown>;
            fs.writeFileSync(path.join(repoRoot, 'full-suite-fixture.cjs'), 'process.exit(0);\n', 'utf8');
            workflowConfig.full_suite_validation = {
                ...(workflowConfig.full_suite_validation as Record<string, unknown>),
                enabled: true,
                command: 'node full-suite-fixture.cjs'
            };
            fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');
            initializeGitRepo(repoRoot);
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'app.ts'),
                'const a = 3;\nconst b = 2;\nconsole.log(a + b);\n',
                'utf8'
            );
            const preflightPath = writePreflight(repoRoot, taskId);

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Block executable full-suite without compile evidence'
            }).exitCode, 0);

            const result = await runFullSuiteValidationCommand({
                repoRoot,
                taskId,
                preflightPath
            });
            const artifactPath = path.join(
                getReviewsRoot(repoRoot),
                `${taskId}-full-suite-validation.json`
            );
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
                status: string;
                cycle_binding: { compile_gate_timestamp: string | null };
                violations: string[];
            };

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.outputText, /Full-suite validation requires current compile evidence\./);
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.cycle_binding.compile_gate_timestamp, null);
            assert.match(
                artifact.violations.join(' '),
                /missing COMPILE_GATE_PASSED\. Run compile-gate before full-suite validation\./
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not rebind cached full-suite success when lifecycle compile evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-3-full-suite-cache-missing-compile';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const workflowConfigPath = path.join(
                getOrchestratorRoot(repoRoot),
                'live',
                'config',
                'workflow-config.json'
            );
            const workflowConfig = JSON.parse(
                fs.readFileSync(workflowConfigPath, 'utf8')
            ) as Record<string, unknown>;
            fs.writeFileSync(path.join(repoRoot, 'full-suite-fixture.cjs'), 'process.exit(0);\n', 'utf8');
            const command = 'node full-suite-fixture.cjs';
            workflowConfig.full_suite_validation = {
                ...(workflowConfig.full_suite_validation as Record<string, unknown>),
                enabled: true,
                command
            };
            fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');
            initializeGitRepo(repoRoot);
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'app.ts'),
                'const a = 3;\nconst b = 2;\nconsole.log(a + b);\n',
                'utf8'
            );
            const preflightPath = writePreflight(repoRoot, taskId);

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject cached full-suite success without compile evidence'
            }).exitCode, 0);

            const artifactPath = path.join(
                getReviewsRoot(repoRoot),
                `${taskId}-full-suite-validation.json`
            );
            fs.writeFileSync(artifactPath, JSON.stringify({
                status: 'PASSED',
                enabled: true,
                command,
                placement: 'after_compile_before_reviews',
                exit_code: 0,
                timed_out: false,
                violations: [],
                warnings: [],
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: path.resolve(preflightPath).replace(/\\/g, '/'),
                    preflight_sha256: 'a'.repeat(64),
                    compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                    scope_binding: null
                }
            }), 'utf8');

            const result = await runFullSuiteValidationCommand({
                repoRoot,
                taskId,
                preflightPath
            });
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
                status: string;
                cycle_binding: { compile_gate_timestamp: string | null };
                violations: string[];
            };

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.outputText, /Full-suite validation requires current compile evidence\./);
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.cycle_binding.compile_gate_timestamp, null);
            assert.match(
                artifact.violations.join(' '),
                /missing COMPILE_GATE_PASSED\. Run compile-gate before full-suite validation\./
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('reports stale full-suite compile evidence without binding it to the current preflight', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-3-full-suite-stale-compile';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId);

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject stale full-suite compile evidence'
            }).exitCode, 0);
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);

            const currentPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            currentPreflight.compile_binding_test = 'changed-after-compile';
            fs.writeFileSync(preflightPath, JSON.stringify(currentPreflight), 'utf8');

            const fullSuite = runFullSuiteValidationPreflightPipeline({
                repoRoot,
                taskId,
                preflightPath
            });
            assert.match(
                fullSuite.timelineReadiness.violations.join(' '),
                /Compile gate evidence preflight hash does not match the current preflight/
            );
            assert.equal(fullSuite.timelineReadiness.compileEvidenceCurrent, false);
            assert.equal(fullSuite.cycleBinding.compile_gate_timestamp, null);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('maps a review preflight realpath escape to the legacy gate failure surface', (t) => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-3-review-preflight-link-escape';
        const outsideRoot = `${repoRoot}-outside`;
        try {
            fs.mkdirSync(outsideRoot, { recursive: true });
            const outsidePreflightPath = path.join(outsideRoot, 'preflight.json');
            fs.writeFileSync(outsidePreflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const linkedDirectory = path.join(repoRoot, 'linked-review-preflight');
            try {
                fs.symlinkSync(
                    outsideRoot,
                    linkedDirectory,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
            } catch (error: unknown) {
                if (isUnavailableWindowsJunctionError(error)) {
                    t.skip(`Junction creation unavailable: ${String(error)}`);
                    return;
                }
                throw error;
            }
            const escapedPreflightPath = path.join(linkedDirectory, 'preflight.json');

            assert.throws(
                () => runReviewFlowPreflightPipeline({
                    repoRoot,
                    orchestratorRoot: getOrchestratorRoot(repoRoot),
                    taskId,
                    preflightPath: escapedPreflightPath
                }),
                /Review preflight path escapes the repository root\./
            );
            const result = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath: escapedPreflightPath
            });
            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.deepEqual(result.outputLines, [
                'REVIEW_GATE_FAILED',
                'Violations:',
                `- PreflightPath must resolve inside repo root without symlink or junction escape: ${
                    path.resolve(escapedPreflightPath).replace(/\\/g, '/')
                }`
            ]);
        } finally {
            fs.rmSync(outsideRoot, { recursive: true, force: true });
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a full-suite preflight whose real path escapes through a repository link', (t) => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-3-full-suite-preflight-link-escape';
        const outsideRoot = `${repoRoot}-outside`;
        try {
            fs.mkdirSync(outsideRoot, { recursive: true });
            const outsidePreflightPath = path.join(outsideRoot, 'preflight.json');
            fs.writeFileSync(outsidePreflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const linkedDirectory = path.join(repoRoot, 'linked-preflight');
            try {
                fs.symlinkSync(
                    outsideRoot,
                    linkedDirectory,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
            } catch (error: unknown) {
                if (isUnavailableWindowsJunctionError(error)) {
                    t.skip(`Junction creation unavailable: ${String(error)}`);
                    return;
                }
                throw error;
            }

            assert.throws(
                () => runFullSuiteValidationPreflightPipeline({
                    repoRoot,
                    taskId,
                    preflightPath: path.join(linkedDirectory, 'preflight.json')
                }),
                /Preflight path must resolve inside the repository root:/
            );
        } finally {
            fs.rmSync(outsideRoot, { recursive: true, force: true });
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});

describe('recovery shared preflight pipeline migration', () => {
    it('preserves task-bound recovery evidence and preflight paths', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-4-recovery-migration';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId);

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Exercise recovery shared preflight adapter'
            }).exitCode, 0);

            const recovery = runRecoveryFlowPreflightPipeline({
                repoRoot,
                taskId,
                preflightPath
            });
            const normalizedPreflightPath = path.resolve(preflightPath).replace(/\\/g, '/');
            const normalizedTimelinePath = path.join(
                getOrchestratorRoot(repoRoot),
                'runtime',
                'task-events',
                `${taskId}.jsonl`
            ).replace(/\\/g, '/');

            assert.equal(recovery.resolvedTaskId, taskId);
            assert.equal(recovery.previousTaskMode.task_id, taskId);
            assert.equal(recovery.previousPreflight.preflight.task_id, taskId);
            assert.equal(recovery.resolvedPreflightPath.replace(/\\/g, '/'), normalizedPreflightPath);
            assert.equal(
                recovery.timelineReadiness.timelinePath.replace(/\\/g, '/'),
                normalizedTimelinePath
            );
            assert.deepEqual(recovery.timelineReadiness.violations, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects recovery preflight paths outside the repository root', (t) => {
        const repoRoot = createTempRepo();
        const outsideRoot = fs.mkdtempSync(path.join(path.dirname(repoRoot), 'garda-recovery-preflight-outside-'));
        const taskId = 'T-932-4-recovery-preflight-outside';
        const outsidePreflightPath = path.join(outsideRoot, `${taskId}-preflight.json`);
        t.after(() => {
            fs.rmSync(outsideRoot, { recursive: true, force: true });
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(outsidePreflightPath, JSON.stringify({
            task_id: taskId,
            changed_files: ['src/app.ts']
        }, null, 2), 'utf8');
        assert.equal(runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject recovery preflight outside repository root'
        }).exitCode, 0);

        assert.throws(
            () => runRecoveryFlowPreflightPipeline({
                repoRoot,
                taskId,
                preflightPath: outsidePreflightPath
            }),
            /PreflightPath must resolve inside repo root without symlink or junction escape/
        );
    });

    it('fails closed when recovery timeline readiness reports invalid JSON', (t) => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-4-recovery-invalid-timeline';
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        assert.equal(runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject recovery when timeline readiness is invalid'
        }).exitCode, 0);
        fs.appendFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`),
            '{invalid-json}\n',
            'utf8'
        );

        assert.throws(
            () => runRecoveryFlowPreflightPipeline({
                repoRoot,
                taskId,
                preflightPath
            }),
            /Task timeline contains invalid JSON line:/
        );
    });
});
