import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';
import {
    assessExplicitIgnoredRemediationTargets,
    resolveIgnoredRemediationCommandChangedFiles
} from '../../../../src/gates/review-remediation/ignored-remediation-targets';

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-ignore-batch-'));
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    fs.writeFileSync(path.join(root, '.gitignore'), '*.tmp\n');
    fs.writeFileSync(path.join(root, 'tracked.tmp'), 'tracked');
    execFileSync('git', ['-C', root, 'add', '-f', 'tracked.tmp']);
    return root;
}

it('batches candidate paths while preserving tracked-file and guarded-hash semantics', (context) => {
    const root = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ignored = ['with space.tmp', '-leading.tmp', ...Array.from({ length: 34 }, (_, i) => `file-${i}.tmp`)];
    if (process.platform !== 'win32') ignored.push('internal\nnewline.tmp');
    for (const file of [...ignored, 'visible.ts']) fs.writeFileSync(path.join(root, file), 'content');
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const original = childProcess.spawnSync;
    const calls: string[][] = [];
    context.mock.method(childProcess, 'spawnSync', (file: string, args: string[], options: unknown) => {
        if (file === 'git' && args.includes('check-ignore')) calls.push(args);
        return original(file, args, options as never);
    });
    const planned = [...ignored, ignored[0], 'tracked.tmp', 'visible.ts'];
    const params = { repoRoot: root, taskId: 'T-123', taskMode: { planned_changed_files: planned } };
    assert.deepEqual(resolveIgnoredRemediationCommandChangedFiles(params), [...ignored].sort());
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--stdin') && calls[0].includes('-z'));
    assert.ok(!calls[0].includes('--no-index'));
    const assessment = assessExplicitIgnoredRemediationTargets({
        ...params, currentChangedFiles: [],
        guardedTargets: [{ path: ignored[0], sha256: createHash('sha256').update('wrong').digest('hex') }]
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(assessment.allowedBoundaryFiles, [...ignored].sort());
    assert.ok(assessment.violations.some((value) => value.includes('hash mismatch')));
    calls.length = 0;
    assert.deepEqual(resolveIgnoredRemediationCommandChangedFiles({ repoRoot: root, taskId: 'T-123' }), []);
    assert.equal(calls.length, 0);
});

it('bounds batch size and reports Git failures without granting ignored-file authority', (context) => {
    const root = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const planned = Array.from({ length: 600 }, (_, i) => `file-${i}.tmp`);
    for (const file of planned) fs.writeFileSync(path.join(root, file), 'content');
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const original = childProcess.spawnSync;
    let calls = 0;
    let fail = false;
    context.mock.method(childProcess, 'spawnSync', (file: string, args: string[], options: unknown) => {
        if (file !== 'git' || !args.includes('check-ignore')) return original(file, args, options as never);
        calls++;
        return fail
            ? { status: 128, signal: null, stdout: '', stderr: 'injected git error', pid: 0, output: [] }
            : original(file, args, options as never);
    });
    const params = { repoRoot: root, taskId: 'T-123', taskMode: { planned_changed_files: planned } };
    assert.equal(resolveIgnoredRemediationCommandChangedFiles(params).length, planned.length);
    assert.ok(calls > 1 && calls < 10, `bounded batches expected, got ${calls}`);
    fail = true;
    assert.deepEqual(resolveIgnoredRemediationCommandChangedFiles(params), []);
    const assessment = assessExplicitIgnoredRemediationTargets({ ...params, currentChangedFiles: [] });
    assert.deepEqual(assessment.targets, []);
    assert.equal(assessment.violations.length, planned.length);
    assert.ok(assessment.violations.every((value) => value.includes('injected git error')));
});

it('rejects malformed batch output and subprocess timeout instead of trusting a partial match', (context) => {
    const root = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'candidate.tmp'), 'content');
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const original = childProcess.spawnSync;
    let response = { status: 0 as number | null, signal: null, stdout: 'outside.tmp\0', stderr: '', pid: 0, output: [] as string[], error: undefined as NodeJS.ErrnoException | undefined };
    context.mock.method(childProcess, 'spawnSync', (file: string, args: string[], options: unknown) => (
        file === 'git' && args.includes('check-ignore') ? response : original(file, args, options as never)
    ));
    const params = { repoRoot: root, taskId: 'T-123', currentChangedFiles: [], taskMode: { planned_changed_files: ['candidate.tmp'] } };
    for (const stdout of ['outside.tmp\0', 'candidate.tmp', 'candidate.tmp\0candidate.tmp\0']) {
        response = { ...response, stdout };
        assert.deepEqual(resolveIgnoredRemediationCommandChangedFiles(params), []);
        assert.equal(assessExplicitIgnoredRemediationTargets(params).violations.length, 1);
    }
    response = { ...response, status: null, stdout: 'candidate.tmp\0', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
    const assessment = assessExplicitIgnoredRemediationTargets(params);
    assert.deepEqual(assessment.targets, []);
    assert.equal(assessment.violations.length, 1);
    assert.match(assessment.violations[0], /timed out|timeout/u);
});
