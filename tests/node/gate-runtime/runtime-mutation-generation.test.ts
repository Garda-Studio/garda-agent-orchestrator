import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    abortRuntimeMutationGeneration,
    beginRuntimeMutationGeneration,
    commitRuntimeMutationGeneration,
    readRuntimeMutationGeneration,
    RuntimeMutationGenerationError,
    withRuntimeMutationGeneration
} from '../../../src/gate-runtime/runtime-mutation-generation';
import {
    getReviewArtifactLockPath,
    writeReviewArtifactsWithRollback,
    writeReviewArtifactText
} from '../../../src/gate-runtime/review/review-artifacts';
import { resolveIndexLockPath } from '../../../src/gate-runtime/review/reviews-index';
import {
    appendTaskEvent,
    appendTaskEventAsync
} from '../../../src/gate-runtime/timeline/task-events';

const mutableTaskEventIoWrite = require('../../../src/gate-runtime/timeline/task-events-io-write') as {
    appendTaskEventLineSync: typeof import('../../../src/gate-runtime/timeline/task-events-io-write').appendTaskEventLineSync;
    appendTaskEventLineAsync: typeof import('../../../src/gate-runtime/timeline/task-events-io-write').appendTaskEventLineAsync;
};

const mutableFilesystem = require('../../../src/core/filesystem') as {
    writeFileAtomically: typeof import('../../../src/core/filesystem').writeFileAtomically;
};

function createTempRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function generationDirectory(root: string): string {
    return path.join(root, 'runtime', '.runtime-mutation-generation');
}

function generationHeadPath(root: string): string {
    return path.join(generationDirectory(root), 'head.json');
}

function generationAnchorPath(root: string): string {
    return path.join(root, 'runtime', '.runtime-mutation-generation.anchor.json');
}

function interruptJournalWrite(
    root: string,
    interruptionPoint: 'slot' | 'head' | 'anchor',
    callback: () => unknown
): void {
    const head = JSON.parse(fs.readFileSync(generationHeadPath(root), 'utf8')) as { transition_sequence: number };
    const nextSlot = (head.transition_sequence + 1) % 2 === 0 ? 'state-a.json' : 'state-b.json';
    const targetPath = interruptionPoint === 'slot'
        ? path.join(generationDirectory(root), nextSlot)
        : interruptionPoint === 'head' ? generationHeadPath(root) : generationAnchorPath(root);
    const originalWrite = mutableFilesystem.writeFileAtomically;
    let interrupted = false;
    mutableFilesystem.writeFileAtomically = (filePath, content, options) => {
        if (path.resolve(filePath) === targetPath) {
            interrupted = true;
            throw new Error(`injected journal ${interruptionPoint} failure`);
        }
        return originalWrite(filePath, content, options);
    };
    try {
        assert.throws(callback, /injected journal .* failure/);
        assert.equal(interrupted, true);
    } finally {
        mutableFilesystem.writeFileAtomically = originalWrite;
    }
}

function resolveGenerationModulePath(): string {
    return path.resolve(__dirname, '../../../src/gate-runtime/runtime-mutation-generation.js');
}

function runGenerationWorker(
    modulePath: string,
    root: string,
    startSignalPath: string,
    mutationCount: number
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const workerScript = [
            "const fs = require('node:fs');",
            "const { withRuntimeMutationGeneration } = require(process.argv[1]);",
            'const root = process.argv[2];',
            'const startSignalPath = process.argv[3];',
            'const mutationCount = Number.parseInt(process.argv[4], 10);',
            'const sleeper = new Int32Array(new SharedArrayBuffer(4));',
            'while (!fs.existsSync(startSignalPath)) { Atomics.wait(sleeper, 0, 0, 2); }',
            'for (let index = 0; index < mutationCount; index += 1) {',
            "  withRuntimeMutationGeneration(root, 'contention-test', () => undefined);",
            '}'
        ].join('\n');
        const child = spawn(process.execPath, [
            '--input-type=commonjs',
            '--eval',
            workerScript,
            modulePath,
            root,
            startSignalPath,
            String(mutationCount)
        ], {
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr || `generation worker exited with code ${code}`));
        });
    });
}

function leaveExitedMutationOwner(root: string, count = 1): void {
    const result = spawnSync(process.execPath, ['--eval', [
        "const fs = require('node:fs');",
        'const journal = require(process.argv[1]);',
        'const root = process.argv[2];',
        'for (let i = 0; i < Number(process.argv[3]); i++) journal.beginRuntimeMutationGeneration(root, "exited-owner");',
        'fs.writeFileSync(root + "/canonical.txt", "persisted before exit\\n");'
    ].join('\n'), resolveGenerationModulePath(), root, String(count)], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
}

function rewriteIntentOwner(root: string, rewrite: (intent: Record<string, unknown>) => void): void {
    const head = JSON.parse(fs.readFileSync(generationHeadPath(root), 'utf8')) as Record<string, unknown>;
    const statePath = path.join(generationDirectory(root), `state-${head.active_slot}.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const intents = state.active_mutations as Array<Record<string, unknown>>;
    assert.equal(intents.length, 1);
    rewrite(intents[0]);
    const rehash = (record: Record<string, unknown>, field: string) => {
        const { [field]: ignored, ...hashInput } = record;
        record[field] = createHash('sha256').update(JSON.stringify(hashInput), 'utf8').digest('hex');
    };
    rehash(state, 'state_sha256');
    head.state_sha256 = state.state_sha256;
    rehash(head, 'head_sha256');
    const anchor = JSON.parse(fs.readFileSync(generationAnchorPath(root), 'utf8')) as Record<string, unknown>;
    anchor.state_sha256 = state.state_sha256; anchor.head_sha256 = head.head_sha256;
    rehash(anchor, 'anchor_sha256');
    for (const [target, value] of [[statePath, state], [generationHeadPath(root), head], [generationAnchorPath(root), anchor]] as const) {
        fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    }
}

function assertLegacyMutationSlotsReadable(root: string): void {
    // The e240215 updater accepts exactly these intent keys in both journal slots.
    for (const slot of ['a', 'b']) {
        const state = JSON.parse(fs.readFileSync(path.join(generationDirectory(root), `state-${slot}.json`), 'utf8'));
        for (const intent of state.active_mutations) {
            assert.deepEqual(Object.keys(intent).sort(), ['mutation_id', 'mutation_kind', 'started_at_utc']);
        }
    }
}

test('legacy updater parent remains readable through nested new-runtime journal writes', () => {
    const root = createTempRoot('garda-runtime-legacy-update-');
    try {
        const parent = beginRuntimeMutationGeneration(root, 'lifecycle-bundle-update-apply');
        rewriteIntentOwner(root, (intent) => { delete intent.owner; });
        assertLegacyMutationSlotsReadable(root);

        const child = beginRuntimeMutationGeneration(root, 'lifecycle-update-report-write');
        assertLegacyMutationSlotsReadable(root);
        assert.throws(() => readRuntimeMutationGeneration(root), (error: unknown) =>
            error instanceof RuntimeMutationGenerationError && error.code === 'BUSY');
        commitRuntimeMutationGeneration(child);
        assertLegacyMutationSlotsReadable(root);
        assert.throws(() => readRuntimeMutationGeneration(root), (error: unknown) =>
            error instanceof RuntimeMutationGenerationError && error.code === 'BUSY');

        commitRuntimeMutationGeneration(parent);
        assertLegacyMutationSlotsReadable(root);
        assert.equal(readRuntimeMutationGeneration(root).generation, 2);

        const modern = beginRuntimeMutationGeneration(root, 'post-upgrade-write');
        const head = JSON.parse(fs.readFileSync(generationHeadPath(root), 'utf8'));
        const state = JSON.parse(fs.readFileSync(path.join(generationDirectory(root), `state-${head.active_slot}.json`), 'utf8'));
        assert.equal(state.active_mutations[0].mutation_id, modern.mutation_id);
        assert.equal(Object.hasOwn(state.active_mutations[0], 'owner'), true);
        commitRuntimeMutationGeneration(modern);
        assert.equal(readRuntimeMutationGeneration(root).generation, 3);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime mutation generation recovers an exited real owner only on locked write entry', { skip: process.platform !== 'linux' }, () => {
    const root = createTempRoot('garda-runtime-orphan-');
    try {
        leaveExitedMutationOwner(root);
        const beforeHead = fs.readFileSync(generationHeadPath(root));
        assert.throws(() => readRuntimeMutationGeneration(root), (error: unknown) =>
            error instanceof RuntimeMutationGenerationError && error.code === 'BUSY');
        assert.deepEqual(fs.readFileSync(generationHeadPath(root)), beforeHead, 'reader must stay read-only');
        let callbackCount = 0;
        withRuntimeMutationGeneration(root, 'next-writer', () => { callbackCount += 1; });
        assert.equal(callbackCount, 1);
        assert.equal(fs.readFileSync(path.join(root, 'canonical.txt'), 'utf8'), 'persisted before exit\n');
        assert.equal(readRuntimeMutationGeneration(root).generation, 2, 'recovery invalidates potentially changed canonical bytes');
        assert.equal(readRuntimeMutationGeneration(root).transition_sequence, 4);
        withRuntimeMutationGeneration(root, 'later-writer', () => undefined);
        assert.equal(readRuntimeMutationGeneration(root).generation, 3, 'orphan is settled exactly once');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime mutation generation preserves a live real owner until it settles', { skip: process.platform !== 'linux', timeout: 20_000 }, async () => {
    const root = createTempRoot('garda-runtime-live-owner-');
    const child = spawn(process.execPath, ['--eval', [
        'const journal = require(process.argv[1]);',
        'const ticket = journal.beginRuntimeMutationGeneration(process.argv[2], "live-owner");',
        'process.stdout.write("ready\\n");',
        'process.stdin.once("data", () => { journal.abortRuntimeMutationGeneration(ticket); process.stdin.destroy(); });'
    ].join('\n'), resolveGenerationModulePath(), root], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            child.stdout.once('data', () => resolve()); child.once('error', reject);
            child.once('exit', () => reject(new Error('owner exited before ready')));
        });
        withRuntimeMutationGeneration(root, 'concurrent-writer', () => undefined);
        assert.throws(() => readRuntimeMutationGeneration(root), (error: unknown) =>
            error instanceof RuntimeMutationGenerationError && error.code === 'BUSY');
        child.stdin.end('settle\n');
        assert.equal(await exited, 0);
        assert.equal(readRuntimeMutationGeneration(root).generation, 1);
        assert.equal(readRuntimeMutationGeneration(root).transition_sequence, 4);
    } finally {
        if (child.exitCode === null) child.kill();
        await exited;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

for (const ownerKind of ['legacy', 'null', 'foreign-host', 'foreign-boot', 'foreign-namespace', 'foreign-time', 'legacy-clock', 'null-clock'] as const) {
    test(`runtime mutation generation preserves ${ownerKind} ownership`, { skip: process.platform !== 'linux' }, () => {
        const root = createTempRoot('garda-runtime-preserved-owner-');
        try {
            const ticket = beginRuntimeMutationGeneration(root, 'preserved-owner');
            rewriteIntentOwner(root, (intent) => {
                if (ownerKind === 'legacy') delete intent.owner;
                else if (ownerKind === 'null') intent.owner = null;
                else {
                    const owner = intent.owner as Record<string, unknown>;
                    if (ownerKind === 'foreign-host') owner.hostname = 'another-host';
                    else if (ownerKind === 'foreign-boot') owner.boot_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
                    else if (ownerKind === 'foreign-namespace') owner.pid_namespace = 'pid:[999999999]';
                    else if (ownerKind === 'foreign-time') owner.time_namespace = 'time:[999999999]';
                    else if (ownerKind === 'legacy-clock') delete owner.time_namespace;
                    else owner.time_namespace = null;
                }
            });
            withRuntimeMutationGeneration(root, 'next-writer', () => undefined);
            assert.throws(() => readRuntimeMutationGeneration(root), (error: unknown) =>
                error instanceof RuntimeMutationGenerationError && error.code === 'BUSY');
            assert.equal(abortRuntimeMutationGeneration(ticket).generation, 1);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}

test('runtime mutation generation recognizes old generation even when its PID is now live', { skip: process.platform !== 'linux' || !fs.existsSync('/proc/self/ns/time') }, () => {
    const root = createTempRoot('garda-runtime-reused-pid-');
    try {
        beginRuntimeMutationGeneration(root, 'old-process-generation');
        rewriteIntentOwner(root, (intent) => {
            const owner = intent.owner as Record<string, unknown>;
            owner.start_time_ticks = `${owner.start_time_ticks}1`;
        });
        withRuntimeMutationGeneration(root, 'new-process-generation', () => undefined);
        assert.equal(readRuntimeMutationGeneration(root).generation, 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime mutation generation rejects malformed owner even with recomputed journal hashes', () => {
    const root = createTempRoot('garda-runtime-forged-owner-');
    try {
        beginRuntimeMutationGeneration(root, 'malformed-owner');
        rewriteIntentOwner(root, (intent) => { intent.owner = { pid: 123, hostname: 'unknown' }; });
        assert.throws(() => beginRuntimeMutationGeneration(root, 'later-writer'), (error: unknown) =>
            error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const interruptionPoint of ['slot', 'head', 'anchor'] as const) {
    test(`runtime mutation generation retries orphan recovery after ${interruptionPoint} publication failure`, { skip: process.platform !== 'linux' }, () => {
        const root = createTempRoot('garda-runtime-orphan-retry-');
        try {
            leaveExitedMutationOwner(root);
            let callbacks = 0;
            interruptJournalWrite(root, interruptionPoint, () => withRuntimeMutationGeneration(root, 'failed-entry', () => { callbacks += 1; }));
            assert.equal(callbacks, 0);
            withRuntimeMutationGeneration(root, 'recovered-entry', () => { callbacks += 1; });
            assert.equal(callbacks, 1);
            assert.equal(readRuntimeMutationGeneration(root).generation, 2);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}

test('runtime mutation generation serializes competing real recoverers and preserves every orphan settlement', { skip: process.platform !== 'linux' }, async () => {
    const root = createTempRoot('garda-runtime-orphan-contention-');
    try {
        leaveExitedMutationOwner(root, 3);
        const signalPath = path.join(root, 'start.signal');
        const workers = Array.from({ length: 2 }, () => runGenerationWorker(resolveGenerationModulePath(), root, signalPath, 1));
        fs.writeFileSync(signalPath, 'start\n');
        await Promise.all(workers);
        assert.equal(readRuntimeMutationGeneration(root).generation, 5);
        assert.equal(readRuntimeMutationGeneration(root).transition_sequence, 10);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime mutation generation rejects oversized owner-bearing state before publication', () => {
    const root = createTempRoot('garda-runtime-capacity-');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const before = readRuntimeMutationGeneration(root);
        assert.throws(() => beginRuntimeMutationGeneration(root, 'x'.repeat(1024 * 1024)), (error: unknown) =>
            error instanceof RuntimeMutationGenerationError && error.code === 'BUSY');
        assert.deepEqual(readRuntimeMutationGeneration(root), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime mutation generation fails closed when missing and while a mutation is active', () => {
    const root = createTempRoot('garda-runtime-generation-state-');
    try {
        assert.throws(
            () => readRuntimeMutationGeneration(root),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );

        const ticket = beginRuntimeMutationGeneration(root, 'test-write');
        assert.throws(
            () => readRuntimeMutationGeneration(root),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY'
        );
        const afterAbort = abortRuntimeMutationGeneration(ticket);
        assert.equal(afterAbort.generation, 0);
        assert.equal(readRuntimeMutationGeneration(root).generation, 0);

        const committedTicket = beginRuntimeMutationGeneration(root, 'test-write');
        const afterCommit = commitRuntimeMutationGeneration(committedTicket);
        assert.equal(afterCommit.generation, 1);
        assert.equal(readRuntimeMutationGeneration(root).generation, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failed runtime mutation callbacks do not advance generation', () => {
    const root = createTempRoot('garda-runtime-generation-failure-');
    try {
        assert.throws(
            () => withRuntimeMutationGeneration(root, 'failed-write', () => {
                throw new Error('injected write failure');
            }),
            /injected write failure/
        );
        const snapshot = readRuntimeMutationGeneration(root);
        assert.equal(snapshot.generation, 0);
        assert.equal(snapshot.transition_sequence, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime mutation generation recovers an interrupted BEGIN before head or anchor publication', () => {
    for (const interruptionPoint of ['before-head', 'before-anchor'] as const) {
        const root = createTempRoot(`garda-runtime-generation-${interruptionPoint}-`);
        try {
            withRuntimeMutationGeneration(root, 'seed', () => undefined);
            const committedHead = fs.readFileSync(generationHeadPath(root), 'utf8');
            const committedAnchor = fs.readFileSync(generationAnchorPath(root), 'utf8');

            beginRuntimeMutationGeneration(root, `interrupted-${interruptionPoint}`);
            if (interruptionPoint === 'before-head') {
                fs.writeFileSync(generationHeadPath(root), committedHead, 'utf8');
            }
            fs.writeFileSync(generationAnchorPath(root), committedAnchor, 'utf8');

            const recovered = readRuntimeMutationGeneration(root);
            assert.equal(recovered.generation, 1);
            assert.equal(recovered.transition_sequence, 2);

            withRuntimeMutationGeneration(root, 'after-recovery', () => undefined);
            const afterRecovery = readRuntimeMutationGeneration(root);
            assert.equal(afterRecovery.generation, 2);
            assert.equal(afterRecovery.transition_sequence, 4);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

for (const interruptionPoint of ['slot', 'head', 'anchor'] as const) {
    test(`runtime mutation generation retries BEGIN after a ${interruptionPoint} write failure`, () => {
        const root = createTempRoot(`garda-runtime-begin-${interruptionPoint}-`);
        try {
            withRuntimeMutationGeneration(root, 'seed', () => undefined);
            const before = readRuntimeMutationGeneration(root);
            interruptJournalWrite(root, interruptionPoint, () => beginRuntimeMutationGeneration(root, 'interrupted-begin'));
            assert.deepEqual(readRuntimeMutationGeneration(root), before);
            withRuntimeMutationGeneration(root, 'retry-begin', () => undefined);
            const recovered = readRuntimeMutationGeneration(root);
            assert.equal(recovered.generation, 2);
            assert.equal(recovered.transition_sequence, 4);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    for (const { transition, settle, expectedGeneration } of [
        { transition: 'COMMIT', settle: commitRuntimeMutationGeneration, expectedGeneration: 2 },
        { transition: 'ABORT', settle: abortRuntimeMutationGeneration, expectedGeneration: 1 }
    ] as const) {
        test(`runtime mutation generation retries ${transition} after a ${interruptionPoint} write failure`, () => {
            const root = createTempRoot(`garda-runtime-${transition.toLowerCase()}-${interruptionPoint}-`);
            try {
                withRuntimeMutationGeneration(root, 'seed', () => undefined);
                const ticket = beginRuntimeMutationGeneration(root, 'interrupted-settlement');
                interruptJournalWrite(root, interruptionPoint, () => settle(ticket));
                assert.throws(
                    () => readRuntimeMutationGeneration(root),
                    (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY'
                );
                const recovered = settle(ticket);
                assert.equal(recovered.generation, expectedGeneration);
                assert.equal(recovered.transition_sequence, 4);
                assert.deepEqual(readRuntimeMutationGeneration(root), recovered);
                assert.deepEqual(settle(ticket), recovered);
                assert.throws(
                    () => settle({ ...ticket, mutation_kind: 'different-kind' }),
                    (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
                );
                const opposite = transition === 'COMMIT' ? abortRuntimeMutationGeneration : commitRuntimeMutationGeneration;
                assert.throws(
                    () => opposite(ticket),
                    (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
                );
                assert.deepEqual(readRuntimeMutationGeneration(root), recovered);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }
}

test('runtime mutation generation recovers anchor failure followed by retry head failure', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
    try {
        for (const transition of ['BEGIN', 'COMMIT', 'ABORT'] as const) {
            const root = createTempRoot(`garda-runtime-mixed-${transition.toLowerCase()}-`);
            try {
                withRuntimeMutationGeneration(root, 'seed', () => undefined);
                const before = readRuntimeMutationGeneration(root);
                const ticket = transition === 'BEGIN' ? null : beginRuntimeMutationGeneration(root, 'pending');
                const retry = () => ticket === null
                    ? beginRuntimeMutationGeneration(root, 'retry-begin')
                    : transition === 'COMMIT' ? commitRuntimeMutationGeneration(ticket) : abortRuntimeMutationGeneration(ticket);
                interruptJournalWrite(root, 'anchor', retry);
                const firstHead = JSON.parse(fs.readFileSync(generationHeadPath(root), 'utf8')) as {
                    active_slot: 'a' | 'b'; state_sha256: string;
                };
                t.mock.timers.tick(1);
                interruptJournalWrite(root, 'head', retry);
                const replacement = JSON.parse(fs.readFileSync(
                    path.join(generationDirectory(root), `state-${firstHead.active_slot}.json`), 'utf8'
                )) as { state_sha256: string };
                assert.notEqual(replacement.state_sha256, firstHead.state_sha256);
                if (ticket === null) {
                    assert.deepEqual(readRuntimeMutationGeneration(root), before);
                    withRuntimeMutationGeneration(root, 'recovered-begin', () => undefined);
                } else {
                    assert.throws(
                        () => readRuntimeMutationGeneration(root),
                        (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY'
                    );
                    retry();
                }
                const recovered = readRuntimeMutationGeneration(root);
                assert.equal(recovered.generation, transition === 'ABORT' ? 1 : 2);
                assert.equal(recovered.transition_sequence, 4);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        }
    } finally {
        t.mock.timers.reset();
    }
});

test('runtime mutation generation rejects an anchored head naming a different state hash', () => {
    const root = createTempRoot('garda-runtime-inconsistent-anchored-head-');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const head = JSON.parse(fs.readFileSync(generationHeadPath(root), 'utf8')) as {
            state_sha256: string; head_sha256: string;
        };
        head.state_sha256 = '0'.repeat(64);
        const { head_sha256: ignoredHeadHash, ...headHashInput } = head;
        head.head_sha256 = createHash('sha256').update(JSON.stringify(headHashInput), 'utf8').digest('hex');
        const anchor = JSON.parse(fs.readFileSync(generationAnchorPath(root), 'utf8')) as {
            head_sha256: string; anchor_sha256: string;
        };
        anchor.head_sha256 = head.head_sha256;
        const { anchor_sha256: ignoredAnchorHash, ...anchorHashInput } = anchor;
        anchor.anchor_sha256 = createHash('sha256').update(JSON.stringify(anchorHashInput), 'utf8').digest('hex');
        fs.writeFileSync(generationHeadPath(root), JSON.stringify(head), 'utf8');
        fs.writeFileSync(generationAnchorPath(root), JSON.stringify(anchor), 'utf8');
        assert.throws(
            () => readRuntimeMutationGeneration(root),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
        assert.throws(
            () => beginRuntimeMutationGeneration(root, 'rejected'),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime mutation generation rejects an unpublished settlement with a valid hash and a foreign ticket', () => {
    const root = createTempRoot('garda-runtime-foreign-settlement-');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const ticket = beginRuntimeMutationGeneration(root, 'pending');
        interruptJournalWrite(root, 'head', () => commitRuntimeMutationGeneration(ticket));
        const statePath = path.join(generationDirectory(root), 'state-a.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
            transition: { mutation_id: string };
            state_sha256: string;
        };
        state.transition.mutation_id = 'foreign-mutation';
        const { state_sha256: ignoredHash, ...hashInput } = state;
        state.state_sha256 = createHash('sha256').update(JSON.stringify(hashInput), 'utf8').digest('hex');
        fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
        assert.throws(
            () => commitRuntimeMutationGeneration(ticket),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
        assert.throws(
            () => readRuntimeMutationGeneration(root),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime mutation generation rejects foreign, opposite and stale settlement retries', () => {
    const root = createTempRoot('garda-runtime-settlement-identity-');
    try {
        const ticket = beginRuntimeMutationGeneration(root, 'first');
        const committed = commitRuntimeMutationGeneration(ticket);
        assert.deepEqual(commitRuntimeMutationGeneration(ticket), committed);
        assert.throws(
            () => commitRuntimeMutationGeneration({ ...ticket, mutation_kind: 'foreign-kind' }),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
        assert.throws(
            () => abortRuntimeMutationGeneration(ticket),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
        withRuntimeMutationGeneration(root, 'later', () => undefined);
        const later = readRuntimeMutationGeneration(root);
        assert.throws(
            () => commitRuntimeMutationGeneration(ticket),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
        assert.deepEqual(readRuntimeMutationGeneration(root), later);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime mutation generation fails closed after all journal files are removed', () => {
    const root = createTempRoot('garda-runtime-generation-removed-');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        for (const fileName of fs.readdirSync(generationDirectory(root))) {
            fs.rmSync(path.join(generationDirectory(root), fileName));
        }

        assert.throws(
            () => readRuntimeMutationGeneration(root),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );
        assert.throws(
            () => beginRuntimeMutationGeneration(root, 'must-not-reinitialize'),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );
        assert.deepEqual(fs.readdirSync(generationDirectory(root)), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime mutation generation rejects corrupt, rolled-back, missing-anchor, and symlinked journal state', () => {
    const corruptRoot = createTempRoot('garda-runtime-generation-corrupt-');
    const rollbackRoot = createTempRoot('garda-runtime-generation-rollback-');
    const completeRollbackRoot = createTempRoot('garda-runtime-generation-complete-rollback-');
    const missingAnchorRoot = createTempRoot('garda-runtime-generation-missing-anchor-');
    const symlinkRoot = createTempRoot('garda-runtime-generation-symlink-');
    try {
        withRuntimeMutationGeneration(corruptRoot, 'seed', () => undefined);
        fs.writeFileSync(generationHeadPath(corruptRoot), '{invalid-json\n', 'utf8');
        assert.throws(
            () => readRuntimeMutationGeneration(corruptRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );

        const rollbackTicket = beginRuntimeMutationGeneration(rollbackRoot, 'seed');
        const previousHead = fs.readFileSync(generationHeadPath(rollbackRoot), 'utf8');
        commitRuntimeMutationGeneration(rollbackTicket);
        fs.writeFileSync(generationHeadPath(rollbackRoot), previousHead, 'utf8');
        assert.throws(
            () => readRuntimeMutationGeneration(rollbackRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );

        withRuntimeMutationGeneration(completeRollbackRoot, 'first-snapshot', () => undefined);
        const completeSnapshot = new Map(
            fs.readdirSync(generationDirectory(completeRollbackRoot)).map((fileName): [string, string] => [
                fileName,
                fs.readFileSync(path.join(generationDirectory(completeRollbackRoot), fileName), 'utf8')
            ])
        );
        withRuntimeMutationGeneration(completeRollbackRoot, 'newer-snapshot', () => undefined);
        for (const [fileName, content] of completeSnapshot) {
            fs.writeFileSync(path.join(generationDirectory(completeRollbackRoot), fileName), content, 'utf8');
        }
        assert.throws(
            () => readRuntimeMutationGeneration(completeRollbackRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );

        withRuntimeMutationGeneration(missingAnchorRoot, 'seed', () => undefined);
        fs.rmSync(generationAnchorPath(missingAnchorRoot));
        assert.throws(
            () => readRuntimeMutationGeneration(missingAnchorRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );

        withRuntimeMutationGeneration(symlinkRoot, 'seed', () => undefined);
        const journalDirectory = generationDirectory(symlinkRoot);
        const realJournalDirectory = `${journalDirectory}-target`;
        fs.renameSync(journalDirectory, realJournalDirectory);
        fs.symlinkSync(realJournalDirectory, journalDirectory, 'junction');
        assert.throws(
            () => readRuntimeMutationGeneration(symlinkRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
    } finally {
        fs.rmSync(corruptRoot, { recursive: true, force: true });
        fs.rmSync(rollbackRoot, { recursive: true, force: true });
        fs.rmSync(completeRollbackRoot, { recursive: true, force: true });
        fs.rmSync(missingAnchorRoot, { recursive: true, force: true });
        fs.rmSync(symlinkRoot, { recursive: true, force: true });
    }
});

test('runtime mutation generation preserves every concurrent process commit', async () => {
    const root = createTempRoot('garda-runtime-generation-contention-');
    const startSignalPath = path.join(root, 'start.signal');
    const workerCount = 4;
    const mutationsPerWorker = 6;
    try {
        const workers = Array.from({ length: workerCount }, () => runGenerationWorker(
            resolveGenerationModulePath(),
            root,
            startSignalPath,
            mutationsPerWorker
        ));
        fs.writeFileSync(startSignalPath, 'start\n', 'utf8');
        await Promise.all(workers);

        const snapshot = readRuntimeMutationGeneration(root);
        assert.equal(snapshot.generation, workerCount * mutationsPerWorker);
        assert.equal(snapshot.transition_sequence, workerCount * mutationsPerWorker * 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('task-event and nested review-artifact writers advance the shared generation', () => {
    const root = createTempRoot('garda-runtime-generation-writers-');
    try {
        const appendResult = appendTaskEvent(
            root,
            'T-GENERATION',
            'test',
            'PASS',
            'generation integration test',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(appendResult?.canonical_committed, true);
        assert.equal(readRuntimeMutationGeneration(root).generation, 1);

        const nestedReviewPath = path.join(root, 'runtime', 'reviews', 'nested', 'T-GENERATION-code.md');
        writeReviewArtifactText(nestedReviewPath, 'CODE REVIEW PASSED\n');
        assert.equal(readRuntimeMutationGeneration(root).generation, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('custom task-event roots advance the journal that owns the canonical event tree', async () => {
    const repoRoot = createTempRoot('garda-runtime-generation-custom-event-repo-');
    const eventOwnerRoot = createTempRoot('garda-runtime-generation-custom-event-owner-');
    const eventsRoot = path.join(eventOwnerRoot, 'runtime', 'task-events');
    try {
        const syncResult = appendTaskEvent(
            repoRoot,
            'T-GENERATION-CUSTOM-SYNC',
            'test',
            'PASS',
            'custom event-root sync integration test',
            null,
            { eventsRoot, passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(syncResult?.canonical_committed, true);
        assert.equal(readRuntimeMutationGeneration(eventOwnerRoot).generation, 1);
        assert.throws(
            () => readRuntimeMutationGeneration(repoRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );

        const asyncResult = await appendTaskEventAsync(
            repoRoot,
            'T-GENERATION-CUSTOM-ASYNC',
            'test',
            'PASS',
            'custom event-root async integration test',
            null,
            { eventsRoot, passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(asyncResult?.canonical_committed, true);
        assert.equal(readRuntimeMutationGeneration(eventOwnerRoot).generation, 2);
        assert.throws(
            () => readRuntimeMutationGeneration(repoRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(eventOwnerRoot, { recursive: true, force: true });
    }
});

test('async task-event writes commit once and abort cleanly after canonical append failure', async () => {
    const root = createTempRoot('garda-runtime-generation-async-events-');
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    try {
        const success = await appendTaskEventAsync(
            root,
            'T-GENERATION-ASYNC',
            'test',
            'PASS',
            'async generation integration test',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(success?.canonical_committed, true);
        const afterSuccess = readRuntimeMutationGeneration(root);
        assert.equal(afterSuccess.generation, 1);

        fs.mkdirSync(path.join(eventsRoot, 'T-GENERATION-ASYNC-FAIL.jsonl'));
        const failure = await appendTaskEventAsync(
            root,
            'T-GENERATION-ASYNC-FAIL',
            'test',
            'FAIL',
            'injected canonical append failure',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );

        assert.equal(failure?.canonical_committed, false);
        assert.equal(failure?.warnings.length, 1);
        assert.match(failure?.warnings[0] ?? '', /task-event append failed/i);
        const afterFailure = readRuntimeMutationGeneration(root);
        assert.equal(afterFailure.generation, afterSuccess.generation);
        assert.equal(afterFailure.transition_sequence, afterSuccess.transition_sequence + 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sync task-event writes abort cleanly after canonical append failure', () => {
    const root = createTempRoot('garda-runtime-generation-sync-events-');
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const before = readRuntimeMutationGeneration(root);
        fs.mkdirSync(path.join(eventsRoot, 'T-GENERATION-SYNC-FAIL.jsonl'), { recursive: true });

        const failure = appendTaskEvent(
            root,
            'T-GENERATION-SYNC-FAIL',
            'test',
            'FAIL',
            'injected synchronous canonical append failure',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );

        assert.equal(failure?.canonical_committed, false);
        assert.equal(failure?.warnings.length, 1);
        assert.match(failure?.warnings[0] ?? '', /task-event append failed/i);
        const after = readRuntimeMutationGeneration(root);
        assert.equal(after.generation, before.generation);
        assert.equal(after.transition_sequence, before.transition_sequence + 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('task-event writers commit generation after post-canonical processing failure', async () => {
    const root = createTempRoot('garda-runtime-generation-post-canonical-events-');
    const originalSync = mutableTaskEventIoWrite.appendTaskEventLineSync;
    const originalAsync = mutableTaskEventIoWrite.appendTaskEventLineAsync;
    try {
        mutableTaskEventIoWrite.appendTaskEventLineSync = (...args) => {
            originalSync(...args);
            throw new Error('injected sync post-canonical processing failure');
        };
        const syncResult = appendTaskEvent(
            root,
            'T-GENERATION-SYNC-POST-CANONICAL',
            'test',
            'PASS',
            'sync post-canonical generation integration test',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(syncResult?.canonical_committed, true);
        assert.equal(syncResult?.commit_status, 'committed_with_derived_index_failure');
        assert.match(syncResult?.derived_warnings[0] ?? '', /post-canonical processing failure/i);
        const afterSync = readRuntimeMutationGeneration(root);
        assert.equal(afterSync.generation, 1);

        mutableTaskEventIoWrite.appendTaskEventLineSync = originalSync;
        mutableTaskEventIoWrite.appendTaskEventLineAsync = async (...args) => {
            await originalAsync(...args);
            throw new Error('injected async post-canonical processing failure');
        };
        const asyncResult = await appendTaskEventAsync(
            root,
            'T-GENERATION-ASYNC-POST-CANONICAL',
            'test',
            'PASS',
            'async post-canonical generation integration test',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(asyncResult?.canonical_committed, true);
        assert.equal(asyncResult?.commit_status, 'committed_with_derived_index_failure');
        assert.match(asyncResult?.derived_warnings[0] ?? '', /post-canonical processing failure/i);
        const afterAsync = readRuntimeMutationGeneration(root);
        assert.equal(afterAsync.generation, afterSync.generation + 1);
    } finally {
        mutableTaskEventIoWrite.appendTaskEventLineSync = originalSync;
        mutableTaskEventIoWrite.appendTaskEventLineAsync = originalAsync;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a failed review-artifact write aborts without publishing a generation', () => {
    const root = createTempRoot('garda-runtime-generation-review-failure-');
    const reviewPath = path.join(root, 'runtime', 'reviews', 'T-FAILED-code.md');
    const lockPath = getReviewArtifactLockPath(reviewPath);
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const before = readRuntimeMutationGeneration(root);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }), 'utf8');

        assert.throws(
            () => writeReviewArtifactText(reviewPath, 'SHOULD NOT PERSIST\n', {
                lockTimeoutMs: 25,
                lockRetryMs: 2
            }),
            /file lock/
        );
        const after = readRuntimeMutationGeneration(root);
        assert.equal(after.generation, before.generation);
        assert.equal(fs.existsSync(reviewPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a required review-index failure restores the artifact and aborts its generation', () => {
    const root = createTempRoot('garda-runtime-generation-review-index-failure-');
    const reviewsDir = path.join(root, 'runtime', 'reviews');
    const reviewPath = path.join(reviewsDir, 'T-FAILED-INDEX-code.md');
    const indexLockPath = resolveIndexLockPath(reviewsDir);
    try {
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(reviewPath, 'ORIGINAL REVIEW\n', 'utf8');
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const before = readRuntimeMutationGeneration(root);
        fs.mkdirSync(indexLockPath, { recursive: true });
        fs.writeFileSync(path.join(indexLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }), 'utf8');

        assert.throws(
            () => writeReviewArtifactText(reviewPath, 'SHOULD ROLL BACK\n', {
                lockTimeoutMs: 25,
                lockRetryMs: 2,
                requireIndexUpdate: true
            }),
            /Review artifact index update failed/
        );
        const after = readRuntimeMutationGeneration(root);
        assert.equal(after.generation, before.generation);
        assert.equal(after.transition_sequence, before.transition_sequence + 2);
        assert.equal(fs.readFileSync(reviewPath, 'utf8'), 'ORIGINAL REVIEW\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('review-artifact transactions commit one generation and abort cleanly after rollback', async () => {
    const root = createTempRoot('garda-runtime-generation-review-transaction-');
    const reviewsDir = path.join(root, 'runtime', 'reviews');
    const existingPath = path.join(reviewsDir, 'T-TRANSACTION-code.md');
    const newPath = path.join(reviewsDir, 'T-TRANSACTION-test.md');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const beforeCommit = readRuntimeMutationGeneration(root);

        const callbackResult = await writeReviewArtifactsWithRollback([
            {
                artifactPath: existingPath,
                contentType: 'text',
                content: 'COMMITTED REVIEW\n'
            }
        ], async () => {
            assert.throws(
                () => readRuntimeMutationGeneration(root),
                (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY'
            );
            return 'committed';
        });
        assert.equal(callbackResult, 'committed');
        const afterCommit = readRuntimeMutationGeneration(root);
        assert.equal(afterCommit.generation, beforeCommit.generation + 1);
        assert.equal(fs.readFileSync(existingPath, 'utf8'), 'COMMITTED REVIEW\n');

        await assert.rejects(
            () => writeReviewArtifactsWithRollback([
                {
                    artifactPath: existingPath,
                    contentType: 'text',
                    content: 'ROLLED BACK REVIEW\n'
                },
                {
                    artifactPath: newPath,
                    contentType: 'text',
                    content: 'ROLLED BACK TEST REVIEW\n'
                }
            ], async () => {
                assert.throws(
                    () => readRuntimeMutationGeneration(root),
                    (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY'
                );
                throw new Error('injected transaction callback failure');
            }),
            /injected transaction callback failure/
        );
        const afterRollback = readRuntimeMutationGeneration(root);
        assert.equal(afterRollback.generation, afterCommit.generation);
        assert.equal(fs.readFileSync(existingPath, 'utf8'), 'COMMITTED REVIEW\n');
        assert.equal(fs.existsSync(newPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
