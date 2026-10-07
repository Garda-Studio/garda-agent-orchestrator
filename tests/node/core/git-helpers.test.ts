import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runGit, runGitBinary, splitNulList } from '../../../src/core/git-helpers';

const tempRoots: string[] = [];

function makeRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-core-git-helpers-'));
    tempRoots.push(repoRoot);
    childProcess.execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
    runGit(repoRoot, ['config', 'user.email', 'tests@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'tracked\n', 'utf8');
    runGit(repoRoot, ['add', 'tracked.txt']);
    runGit(repoRoot, ['commit', '-m', 'seed']);
    return repoRoot;
}

describe('git helpers', () => {
    afterEach(() => {
        mock.restoreAll();
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('runs git text commands and rejects undeclared command failures', () => {
        const repoRoot = makeRepo();

        assert.match(runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']), /true/);
        assert.throws(() => runGit(repoRoot, ['not-a-real-command'], { allowFailure: true }));
        assert.throws(
            () => runGit(repoRoot, ['not-a-real-command']),
            /git not-a-real-command failed:/
        );
    });

    it('runs binary git commands and splits NUL-separated output like existing WIP helpers', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'untracked.txt'), 'new\n', 'utf8');

        const output = runGitBinary(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);

        assert.deepEqual(splitNulList(output), ['untracked.txt']);
        assert.deepEqual(splitNulList(' a\0\0 b \0'), ['a', 'b']);
        assert.throws(() => runGitBinary(repoRoot, ['not-a-real-command'], { allowFailure: true }));
        assert.throws(
            () => runGitBinary(repoRoot, ['not-a-real-command']),
            /git not-a-real-command failed:/
        );
    });

    it('preserves successful empty output and explicitly declared missing configuration', () => {
        const repoRoot = makeRepo();
        const missingConfig = ['config', '--get', 'garda.missing-test-option'];
        const expectedNegative = { allowFailure: true, allowedFailureExitCodes: [1] };
        const wrongNegative = { allowFailure: true, allowedFailureExitCodes: [128] };

        assert.equal(runGit(repoRoot, ['ls-files', '--others']), '');
        assert.equal(runGit(repoRoot, missingConfig, expectedNegative), '');
        assert.deepEqual(runGitBinary(repoRoot, missingConfig, expectedNegative), Buffer.alloc(0));
        assert.throws(() => runGit(repoRoot, missingConfig, wrongNegative));
        assert.throws(() => runGitBinary(repoRoot, missingConfig, wrongNegative));
    });

    it('rejects text output buffer exhaustion and preserves the process error', () => {
        const repoRoot = makeRepo();
        assert.throws(
            () => runGit(repoRoot, ['log', '-1', `--format=${'x'.repeat(512)}`], {
                allowFailure: true, maxBuffer: 16
            }),
            (error: unknown) => error instanceof Error
                && (error.cause as NodeJS.ErrnoException)?.code === 'ENOBUFS'
        );
    });

    it('rejects binary output buffer exhaustion and preserves the process error', () => {
        const repoRoot = makeRepo();
        assert.throws(
            () => runGitBinary(repoRoot, ['log', '-1', `--format=${'x'.repeat(512)}`], {
                allowFailure: true, maxBuffer: 16
            }),
            (error: unknown) => error instanceof Error
                && (error.cause as NodeJS.ErrnoException)?.code === 'ENOBUFS'
        );
    });

    it('rejects spawn errors despite a declared matching exit code', () => {
        const failure = Object.assign(new Error('spawn unavailable', {
            cause: Object.assign(new Error('inner exit'), { status: 1 })
        }), { code: 'ENOENT', status: 1 });
        mock.method(require('node:child_process'), 'execFileSync', () => { throw failure; });
        const options = { allowFailure: true, allowedFailureExitCodes: [1] };
        assert.throws(() => runGit('.', ['status'], options),
            (error: unknown) => error instanceof Error && error.cause === failure);
        assert.throws(() => runGitBinary('.', ['status'], options),
            (error: unknown) => error instanceof Error && error.cause === failure);
    });

    it('rejects signal termination despite a declared matching exit code', () => {
        const failure = Object.assign(new Error('terminated'), { signal: 'SIGTERM', status: 1 });
        mock.method(require('node:child_process'), 'execFileSync', () => { throw failure; });
        const options = { allowFailure: true, allowedFailureExitCodes: [1] };
        assert.throws(() => runGit('.', ['status'], options),
            (error: unknown) => error instanceof Error && error.cause === failure);
        assert.throws(() => runGitBinary('.', ['status'], options),
            (error: unknown) => error instanceof Error && error.cause === failure);
    });

    it('rejects timeout cancellation and preserves its cause', () => {
        const failure = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true, status: 1 });
        mock.method(require('node:child_process'), 'execFileSync', () => { throw failure; });
        const options = { allowFailure: true, allowedFailureExitCodes: [1] };
        assert.throws(() => runGit('.', ['status'], options),
            (error: unknown) => error instanceof Error && error.cause === failure);
        assert.throws(() => runGitBinary('.', ['status'], options),
            (error: unknown) => error instanceof Error && error.cause === failure);
    });
});
