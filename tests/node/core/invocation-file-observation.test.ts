import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileSha256 } from '../../../src/core/file-hashing';
import { readInvocationFileContent } from '../../../src/core/invocation-file-observation';
import { readTaskTimelineFileSnapshot, withTaskTimelineReadSnapshot } from '../../../src/gate-runtime/timeline/task-timeline-read-snapshot';
import { readReviewArtifactFileSnapshot, withReviewArtifactReadSnapshot } from '../../../src/gate-runtime/review/review-artifacts';
import { fileSha256 as runtimeFileSha256 } from '../../../src/gate-runtime/hash';
import { readObservedValidationFile } from '../../../src/core/project-validation-identity';
import { statFileIdentitySync } from '../../../src/core/file-stat';
import { getSafeWorktreePathState } from '../../../src/gates/workspace/worktree-path-state';
import {
    assertInvocationDependenciesCurrent, createInvocationReadMemoKey, memoizeInvocationRead, withInvocationReadObservation,
    withStrictInvocationReadObservation
} from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';

function fixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-scope-observation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function replaceFile(file: string, content: string): void {
    const replacement = file + '.replacement';
    fs.writeFileSync(replacement, content);
    fs.renameSync(replacement, file);
}

function measured(action: () => void): NextStepMeasurement {
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(action), value => { measurement = value; });
    return measurement!;
}

function counts(measurement: NextStepMeasurement, prefix: string): number[] {
    return Object.entries(measurement.work).filter(([key]) => key.startsWith(prefix)).map(([, count]) => count);
}

test('scope paths and all hash entrypoints share exactly 64 observations at one and five lanes', t => {
    const root = fixture(t);
    const files = Array.from({ length: 64 }, (_, index) => 'source-' + index + '.txt');
    for (const relative of files) fs.writeFileSync(path.join(root, relative), 'content for ' + relative);
    for (const lanes of [1, 5]) {
        const measurement = measured(() => {
            for (let lane = 0; lane < lanes; lane += 1) {
                for (const relative of files) {
                    const file = path.join(root, relative), state = getSafeWorktreePathState(root, relative);
                    assert.equal(state.status, 'file');
                    assert.equal(fileSha256(file), state.sha256);
                    assert.equal(runtimeFileSha256(file), state.sha256);
                    assert.equal(readObservedValidationFile(root, relative).identity.sha256, state.sha256);
                }
            }
        });
        assert.deepEqual(counts(measurement, 'scope_path_state:'), Array<number>(64).fill(1));
        assert.deepEqual(counts(measurement, 'file_hash:'), Array<number>(64).fill(1));
    }
});

test('retains option-specific projections without duplicate content hashes', t => {
    const root = fixture(t), file = path.join(root, 'source.txt');
    fs.mkdirSync(path.join(root, 'other'));
    fs.writeFileSync(file, 'observed content');
    const combinations = [
        { includeContentHashes: false }, {}, { repoRealPath: path.join(root, 'other') },
        { repoRealPath: fs.realpathSync(root), distinguishAccessErrors: true }
    ];
    const expected = combinations.map(options => getSafeWorktreePathState(root, 'source.txt', options));
    const invalid = 'invalid' + String.fromCharCode(0) + 'path';
    const invalidExpected = [false, true].map(distinguishAccessErrors => getSafeWorktreePathState(root, invalid, { distinguishAccessErrors }));
    const measurement = measured(() => {
        for (const [index, options] of combinations.entries()) assert.deepEqual(getSafeWorktreePathState(root, 'source.txt', options), expected[index]);
        for (const [index, distinguishAccessErrors] of [false, true].entries()) {
            assert.deepEqual(getSafeWorktreePathState(root, invalid, { distinguishAccessErrors }), invalidExpected[index]);
        }
    });
    assert.deepEqual(counts(measurement, 'file_hash:'), [1]);
});

test('checks every supplied expectedStat against retained authentic metadata', t => {
    const root = fixture(t), file = path.join(root, 'source.txt'), other = path.join(root, 'other.txt');
    fs.writeFileSync(file, 'same content'); fs.writeFileSync(other, 'same content');
    const original = fs.statSync(file), complete = statFileIdentitySync(file), digest = fileSha256(file);
    const changed = Object.assign(Object.create(Object.getPrototypeOf(original)), original, { mtimeMs: original.mtimeMs + 1 });
    const measurement = measured(() => {
        assert.equal(fileSha256(file, changed), null);
        assert.equal(fileSha256(file, original), digest);
        assert.equal(fileSha256(file, complete), digest);
        assert.equal(fileSha256(file, fs.statSync(other)), null);
        assert.equal(fileSha256(file, changed), null);
        assert.equal(fileSha256(file, original), digest);
    });
    assert.deepEqual(counts(measurement, 'file_hash:'), [1]);
});

test('retains the first bytes between consumers and rejects same-byte path replacement at final validation', t => {
    const root = fixture(t), file = path.join(root, 'source.txt');
    for (const replacement of ['original', 'modified']) {
        fs.writeFileSync(file, 'original');
        const expectedStat = fs.statSync(file);
        assert.throws(() => withInvocationReadObservation(() => {
            const first = getSafeWorktreePathState(root, 'source.txt');
            replaceFile(file, replacement);
            assert.deepEqual(getSafeWorktreePathState(root, 'source.txt'), first);
            assert.equal(fileSha256(file, expectedStat), first.sha256);
            assert.equal(runtimeFileSha256(file), first.sha256);
            assert.equal(fileSha256(file, fs.statSync(file)), null);
        }), /Invocation file observation changed/);
    }
});

test('observes changed files afresh on the next invocation without cross-call metadata caching', t => {
    const root = fixture(t), file = path.join(root, 'source.txt');
    fs.writeFileSync(file, 'original');
    const originalStat = fs.statSync(file);
    const first = withInvocationReadObservation(() => getSafeWorktreePathState(root, 'source.txt'));
    replaceFile(file, 'changed before invocation');
    const second = withInvocationReadObservation(() => {
        assert.equal(fileSha256(file, originalStat), null);
        return getSafeWorktreePathState(root, 'source.txt');
    });
    assert.notEqual(first.sha256, second.sha256);
    assert.equal(second.sha256, fileSha256(file));
});

test('retains absence for later consumers and rejects a path created during the invocation', t => {
    const root = fixture(t), file = path.join(root, 'absent.txt');
    assert.throws(() => withInvocationReadObservation(() => {
        assert.deepEqual(getSafeWorktreePathState(root, 'absent.txt'), { status: 'missing' });
        assert.equal(fileSha256(file), null);
        fs.writeFileSync(file, 'appeared');
        assert.deepEqual(getSafeWorktreePathState(root, 'absent.txt'), { status: 'missing' });
        assert.equal(runtimeFileSha256(file), null);
    }), /Invocation file observation changed/);
});

test('rejects a replaced repository root even when its source bytes are unchanged', t => {
    const container = fixture(t), root = path.join(container, 'repo'), moved = path.join(container, 'moved');
    fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'source.txt'), 'unchanged');
    assert.throws(() => withInvocationReadObservation(() => {
        const first = getSafeWorktreePathState(root, 'source.txt');
        fs.renameSync(root, moved); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'source.txt'), 'unchanged');
        assert.deepEqual(getSafeWorktreePathState(root, 'source.txt'), first);
    }), /Invocation file observation changed/);
});

test('preserves junction containment and detects an ancestor replaced by an escaping junction', t => {
    const container = fixture(t), root = path.join(container, 'repo'), outside = path.join(container, 'outside');
    fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(path.join(root, 'inside'));
    fs.writeFileSync(path.join(root, 'inside', 'source.txt'), 'inside');
    fs.writeFileSync(path.join(outside, 'source.txt'), 'outside');
    try { fs.symlinkSync(outside, path.join(root, 'escape'), 'junction'); }
    catch { t.skip('Directory junction creation is unavailable'); return; }
    assert.equal(withInvocationReadObservation(() => getSafeWorktreePathState(root, 'escape/source.txt')).status, 'outside_repo');
    assert.throws(() => withInvocationReadObservation(() => {
        const first = getSafeWorktreePathState(root, 'inside/source.txt');
        fs.renameSync(path.join(root, 'inside'), path.join(root, 'moved'));
        fs.symlinkSync(outside, path.join(root, 'inside'), 'junction');
        assert.deepEqual(getSafeWorktreePathState(root, 'inside/source.txt'), first);
    }), /Invocation file observation changed/);
});

test('shares symlink target content while retaining the link alias and its containment', t => {
    const container = fixture(t), root = path.join(container, 'repo'), outside = path.join(container, 'outside.txt');
    fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'target.txt'), 'inside'); fs.writeFileSync(outside, 'outside');
    const link = path.join(root, 'link.txt');
    try { fs.symlinkSync('target.txt', link, 'file'); }
    catch { t.skip('File symlink creation is unavailable'); return; }
    const measurement = measured(() => {
        const target = getSafeWorktreePathState(root, 'target.txt');
        const linked = getSafeWorktreePathState(root, 'link.txt');
        assert.equal(linked.target_sha256, target.sha256);
        assert.equal(fileSha256(link), target.sha256);
    });
    assert.deepEqual(counts(measurement, 'file_hash:'), [1]);
    assert.throws(() => withInvocationReadObservation(() => {
        const first = getSafeWorktreePathState(root, 'link.txt');
        fs.unlinkSync(link); fs.symlinkSync(outside, link, 'file');
        assert.deepEqual(getSafeWorktreePathState(root, 'link.txt'), first);
    }), /Invocation file observation changed/);
    const outsideMeasurement = measured(() => assert.deepEqual(getSafeWorktreePathState(root, 'link.txt'), { status: 'outside_repo' }));
    assert.deepEqual(counts(outsideMeasurement, 'file_hash:'), []);
});

test('retains validation bounds and strict path rules after another hash consumer populated the observation', t => {
    const root = fixture(t), file = path.join(root, 'source.txt');
    fs.writeFileSync(file, 'validation bytes');
    const measurement = measured(() => {
        assert.throws(() => readObservedValidationFile(root, 'source.txt', 1), /byte bound/);
        const digest = runtimeFileSha256(file);
        assert.throws(() => readObservedValidationFile(root, 'source.txt', 1), /byte bound/);
        const first = readObservedValidationFile(root, 'source.txt');
        assert.equal(first.identity.sha256, digest);
        first.bytes.fill(0); first.identity.sha256 = 'caller mutation';
        const second = readObservedValidationFile(root, 'source.txt');
        assert.equal(second.bytes.toString(), 'validation bytes');
        assert.equal(second.identity.sha256, digest);
        assert.throws(() => readObservedValidationFile(path.join(root, 'other'), '../source.txt'), /validation|relative/i);
    });
    assert.deepEqual(counts(measurement, 'file_hash:'), [1]);
    const link = path.join(root, 'hard-link.txt');
    fs.linkSync(file, link);
    withInvocationReadObservation(() => {
        assert.ok(fileSha256(link));
        assert.throws(() => readObservedValidationFile(root, 'hard-link.txt'), /hard-linked/);
    });
});

test('Windows case aliases share one canonical content hash', t => {
    if (process.platform !== 'win32') { t.skip('Windows path case alias'); return; }
    const root = fixture(t), file = path.join(root, 'Source.txt'); fs.writeFileSync(file, 'case alias');
    const measurement = measured(() => assert.equal(fileSha256(file), runtimeFileSha256(file.toUpperCase())));
    assert.deepEqual(counts(measurement, 'file_hash:'), [1]);
});

test('memo keys preserve typed ownership, first errors and invocation lifetime without rebaseline', () => {
    const first = createInvocationReadMemoKey<string>('same'), second = createInvocationReadMemoKey<number>('same');
    const failureKey = createInvocationReadMemoKey<string>('failed');
    const failure = new Error('Original memo failure');
    let builds = 0;
    for (let invocation = 0; invocation < 2; invocation += 1) {
        withInvocationReadObservation(() => {
            assert.equal(memoizeInvocationRead(first, 'key', () => { builds += 1; return 'original'; }).value, 'original');
            assert.equal(memoizeInvocationRead(first, 'key', () => 'replacement').value, 'original');
            assert.equal(memoizeInvocationRead(second, 'key', () => 42).value, 42);
            assert.throws(() => memoizeInvocationRead(failureKey, 'key', () => { throw failure; }), error => error === failure);
            assert.throws(() => memoizeInvocationRead(failureKey, 'key', () => 'replacement'), error => error === failure);
            assertInvocationDependenciesCurrent();
        });
    }
    assert.equal(builds, 2);
});


test('strict read phase rehashes actual bytes even when path metadata stays unchanged', t => {
    const root = fixture(t), file = path.join(root, 'source.txt');
    fs.writeFileSync(file, 'original bytes');
    const native = require('node:fs') as typeof fs, open = native.openSync, read = native.readSync, close = native.closeSync;
    const descriptors = new Set<number>();
    let returnChangedBytes = false, changedRead = false;
    t.mock.method(native, 'openSync', ((...args: unknown[]) => {
        const descriptor = Reflect.apply(open, native, args) as number;
        if (typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(file)) descriptors.add(descriptor);
        return descriptor;
    }) as typeof fs.openSync);
    t.mock.method(native, 'closeSync', ((descriptor: number) => {
        descriptors.delete(descriptor); return close(descriptor);
    }) as typeof fs.closeSync);
    t.mock.method(native, 'readSync', ((...args: unknown[]) => {
        const count = Reflect.apply(read, native, args) as number, buffer = args[1];
        if (returnChangedBytes && descriptors.has(args[0] as number) && count > 0 && Buffer.isBuffer(buffer)) {
            buffer[Number(args[2]) || 0] ^= 1; changedRead = true;
        }
        return count;
    }) as typeof fs.readSync);
    assert.throws(() => withStrictInvocationReadObservation(() => {
        assert.ok(readInvocationFileContent(file));
        returnChangedBytes = true;
    }), /Invocation file bytes changed/u);
    assert.equal(changedRead, true, 'the final check must read bytes again');
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(file, 'utf8'), 'original bytes');
});


for (const kind of ['timeline', 'review'] as const) test(`strict ${kind} snapshot rechecks bytes when metadata is unchanged`, t => {
    const root = fixture(t), file = path.join(root, kind === 'timeline' ? 'T-STRICT-1.jsonl' : 'review.json');
    fs.writeFileSync(file, kind === 'timeline' ? '{"event_type":"EXAMPLE"}\n' : '{"status":"PASS"}\n');
    const native = require('node:fs') as typeof fs, open = native.openSync, read = native.readSync, close = native.closeSync;
    const descriptors = new Set<number>(); let changed = false, changedRead = false;
    t.mock.method(native, 'openSync', ((...args: unknown[]) => {
        const descriptor = Reflect.apply(open, native, args) as number;
        if (typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(file)) descriptors.add(descriptor);
        return descriptor;
    }) as typeof fs.openSync);
    t.mock.method(native, 'closeSync', ((descriptor: number) => {
        descriptors.delete(descriptor); return close(descriptor);
    }) as typeof fs.closeSync);
    t.mock.method(native, 'readSync', ((...args: unknown[]) => {
        const count = Reflect.apply(read, native, args) as number, buffer = args[1];
        if (changed && descriptors.has(args[0] as number) && count > 0 && Buffer.isBuffer(buffer)) {
            buffer[Number(args[2]) || 0] ^= 1; changedRead = true;
        }
        return count;
    }) as typeof fs.readSync);
    assert.throws(() => withStrictInvocationReadObservation(() => kind === 'timeline'
        ? withTaskTimelineReadSnapshot(root, 'T-STRICT-1', () => {
            assert.equal(readTaskTimelineFileSnapshot(file).valid, true); changed = true;
        })
        : withReviewArtifactReadSnapshot(root, () => {
            assert.equal(readReviewArtifactFileSnapshot(file).valid, true); changed = true;
        })), /changed|unavailable|invalidated/iu);
    assert.equal(changedRead, true, 'the final check must read bytes again');
});
