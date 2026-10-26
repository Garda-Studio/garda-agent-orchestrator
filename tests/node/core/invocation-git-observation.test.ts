import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withInvocationGitReadObservation } from '../../../src/core/invocation-git-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { runGit } from '../../../src/core/git-helpers';
import { collectGitChangeClassificationSnapshot } from '../../../src/core/git-change-classification';
import { computeSnapshotFingerprint } from '../../../src/gates/workspace/workspace-snapshot-cache';

function fixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-git-observation-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    childProcess.execFileSync('git', ['init', '-q', root]);
    return root;
}
function observe<T>(callback: () => T): T {
    return withInvocationGitReadObservation(() => withInvocationReadObservation(callback));
}

test('Q2 merges repeated native and helper Git reads and validates the single result at exit', t => {
    const root = fixture(t);
    let result: NextStepMeasurement | undefined;
    const options = { encoding: 'utf8' as const };
    withNextStepMeasurement(() => observe(() => {
        for (let i = 0; i < 5; i++) {
            assert.equal(childProcess.execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], options).trim(), 'true');
            assert.equal(runGit(root, ['ls-files', '--others', '--exclude-standard']), '');
        }
    }), measurement => { result = measurement; });
    const counts = Object.entries(result!.work).filter(([key]) => key.startsWith('process:')).map(([, value]) => value);
    assert.deepEqual(counts, [2, 2], 'one initial read and one final validation for each command');
});

test('Q2 Git observations reject an untracked input appearing after the first read', t => {
    const root = fixture(t);
    assert.throws(() => observe(() => {
        assert.equal(runGit(root, ['ls-files', '--others', '--exclude-standard']), '');
        fs.writeFileSync(path.join(root, 'new.txt'), 'new');
        assert.equal(runGit(root, ['ls-files', '--others', '--exclude-standard']), '');
    }), /Invocation Git observation changed/u);
    assert.equal(observe(() => runGit(root, ['ls-files', '--others', '--exclude-standard'])), 'new.txt\n');
});

test('Q2 Git buffers are isolated and mutations are never memoized', t => {
    const root = fixture(t);
    observe(() => {
        const run = () => childProcess.execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']);
        const first = run(); first.fill(0);
        assert.equal(run().toString().trim(), 'true');
        childProcess.execFileSync('git', ['-C', root, 'config', 'q2.test', 'one']);
        childProcess.execFileSync('git', ['-C', root, 'config', 'q2.test', 'two']);
    });
    assert.equal(childProcess.execFileSync('git', ['-C', root, 'config', '--get', 'q2.test'], { encoding: 'utf8' }).trim(), 'two');
});

test('Q2 opaque Git process inputs keep native getter and serialization behavior', t => {
    const root = fixture(t);
    const run = (observed: boolean) => {
        let calls = 0, serializations = 0;
        const env = { ...process.env };
        Object.defineProperty(env, 'Q2_OPAQUE', { enumerable: true, get: () => String(++calls) });
        const options = { env, encoding: 'utf8' as const };
        Object.defineProperty(options, 'toJSON', { value: () => { serializations++; throw new Error('unexpected serialization'); } });
        const read = () => childProcess.execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], options);
        const output = observed ? observe(read) : read();
        return { calls, serializations, output };
    };
    assert.deepEqual(run(true), run(false));
});

test('Q2 final Git validation preserves unchanged command failures and restores the native boundary', t => {
    const root = fixture(t);
    const native = require('node:child_process') as typeof childProcess;
    const original = native.execFileSync;
    observe(() => {
        for (let i = 0; i < 2; i++) assert.throws(() => runGit(root, ['rev-parse', '--verify', 'HEAD']));
    });
    assert.equal(native.execFileSync, original);
    const failure = new Error('original failure');
    assert.throws(() => observe(() => { throw failure; }), error => error === failure);
    assert.equal(native.execFileSync, original);
});

test('Q2 native spawn results share work while preserving output aliases and separate consumer buffers', t => {
    const root = fixture(t);
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => observe(() => {
        const read = () => childProcess.spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']);
        const first = read();
        assert.equal(first.status, 0);
        assert.equal(first.stdout, first.output[1]);
        first.stdout.fill(0);
        for (let i = 0; i < 4; i++) {
            const current = read();
            assert.equal(current.stdout.toString().trim(), 'true');
            assert.equal(current.stdout, current.output[1]);
        }
    }), result => { measurement = result; });
    const counts = Object.entries(measurement!.work).filter(([key]) => key.startsWith('process:')).map(([, count]) => count);
    assert.deepEqual(counts, [2]);
});

test('Q2 cached Git failures cannot be mutated through a previous consumer error', t => {
    const root = fixture(t);
    observe(() => {
        const read = () => childProcess.execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let first: unknown;
        try { read(); } catch (error: unknown) { first = error; }
        assert.ok(first && typeof first === 'object' && 'status' in first);
        const status = first.status;
        first.status = 0;
        assert.throws(read, error => error !== first && typeof error === 'object' && error !== null && 'status' in error && error.status === status);
    });
});


test('Q2 production classification and workspace fingerprint reject an untracked path after their status read', t => {
    const root = fixture(t);
    const file = path.join(root, 'new.ts');
    for (const read of [
        () => collectGitChangeClassificationSnapshot(root),
        () => computeSnapshotFingerprint(root, 'git_auto', true, [])
    ]) {
        assert.throws(() => observe(() => {
            read();
            fs.writeFileSync(file, 'export const value = 1;');
        }), /Invocation Git observation changed/u);
        fs.unlinkSync(file);
    }
});

test('Q2 production Git global flags and query forms share their first result and final check', t => {
    const root = fixture(t);
    runGit(root, ['config', 'core.autocrlf', 'false']);
    const commands = [
        ['--no-pager', 'status', '--porcelain=v1', '-z'],
        ['--literal-pathspecs', 'ls-files', '--stage', '-z'],
        ['--no-replace-objects', 'rev-list', '--all'],
        ['config', '--null', '--get-regexp', '^core\\.(autocrlf|eol|safecrlf)$'],
        ['config', '--type=bool-or-str', '--get', 'core.autocrlf'],
        ['symbolic-ref', '--quiet', 'HEAD'],
        ['show-ref', '--verify', '--quiet', 'refs/heads/missing']
    ];
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => observe(() => {
        for (const args of commands) for (let i = 0; i < 5; i++) runGit(root, args, {
            allowFailure: true, allowedFailureExitCodes: [1]
        });
    }), result => { measurement = result; });
    const counts = Object.entries(measurement!.work).filter(([key]) => key.startsWith('process:')).map(([, count]) => count);
    assert.equal(counts.length, commands.length);
    assert.deepEqual(counts, commands.map(() => 2));
    assert.throws(() => observe(() => {
        assert.equal(runGit(root, ['--no-pager', 'status', '--porcelain=v1']).trim(), '');
        fs.writeFileSync(path.join(root, 'new.ts'), 'new');
        assert.equal(runGit(root, ['--no-pager', 'status', '--porcelain=v1']).trim(), '');
    }), /Invocation Git observation changed/u);
});

test('Q2 config and symbolic-ref write forms remain live', t => {
    const root = fixture(t);
    observe(() => {
        for (const value of ['one', 'two']) {
            runGit(root, ['config', 'q2.test', value]);
            runGit(root, ['symbolic-ref', 'HEAD', 'refs/heads/' + value]);
        }
    });
    assert.equal(runGit(root, ['config', '--get', 'q2.test']).trim(), 'two');
    assert.equal(runGit(root, ['symbolic-ref', '--quiet', 'HEAD']).trim(), 'refs/heads/two');
});
