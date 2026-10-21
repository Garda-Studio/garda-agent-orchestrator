import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../../../src/core/git-helpers';
import { classifiedContentFingerprint } from '../../../../src/gates/project-validation/attempt-evidence';

for (const attributes of ['text=auto', 'text=auto eol=lf', 'crlf=input', 'text'])
    test(`T-404 matches actual Git add for ${attributes} and preserves non-UTF8 bytes`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-eol-boundary-'));
        try {
            runGit(root, ['init']); runGit(root, ['config', 'core.autocrlf', 'false']);
            fs.writeFileSync(path.join(root, '.gitattributes'), `*.txt ${attributes}\n`);
            const bytes = Buffer.from([255, 97, 13, 10, 98, 13, 10]);
            fs.writeFileSync(path.join(root, 'input.txt'), bytes);
            runGit(root, ['add', 'input.txt']);
            assert.ok(classifiedContentFingerprint(root, 'git_staged_only', ['input.txt']));
            fs.writeFileSync(path.join(root, 'input.txt'), Buffer.from([254, 97, 13, 10, 98, 13, 10]));
            assert.throws(() => classifiedContentFingerprint(root, 'git_staged_only', ['input.txt']), /differs from executable/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

test('T-404 auto conversion respects CRLF already in the index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-index-eol-'));
    try {
        runGit(root, ['init']); runGit(root, ['config', 'core.autocrlf', 'false']);
        fs.writeFileSync(path.join(root, 'input.txt'), 'one\r\ntwo\r\n');
        runGit(root, ['add', 'input.txt']);
        runGit(root, ['config', 'core.autocrlf', 'true']);
        assert.ok(classifiedContentFingerprint(root, 'git_staged_only', ['input.txt']));
        fs.writeFileSync(path.join(root, 'input.txt'), 'one\ntwo\n');
        assert.throws(() => classifiedContentFingerprint(root, 'git_staged_only', ['input.txt']), /differs from executable/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T-404 accepts case-insensitive autocrlf input without explicit text attributes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-input-case-'));
    try {
        runGit(root, ['init']); runGit(root, ['config', 'core.autocrlf', 'INPUT']);
        fs.writeFileSync(path.join(root, '.gitattributes'), 'input.txt !text !eol !crlf\n');
        fs.writeFileSync(path.join(root, 'input.txt'), 'one\r\ntwo\r\n');
        runGit(root, ['add', 'input.txt']);
        assert.equal(runGit(root, ['show', ':input.txt']), 'one\ntwo\n', 'Git itself converts this fixture');
        assert.ok(classifiedContentFingerprint(root, 'git_staged_only', ['input.txt']));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
