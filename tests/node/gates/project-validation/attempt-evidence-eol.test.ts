import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../../../src/core/git-helpers';
import { classifiedContentFingerprint } from '../../../../src/gates/project-validation/attempt-evidence';
import { buildScopeContentFingerprint } from '../../../../src/gates/compile/compile-gate';

const git = require('../../../../src/core/git-helpers') as typeof import('../../../../src/core/git-helpers');

function fixture(autocrlf: string, attributes = '') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-staged-eol-'));
    runGit(root, ['init']);
    runGit(root, ['config', 'core.autocrlf', autocrlf]);
    runGit(root, ['config', 'core.safecrlf', 'false']);
    if (attributes) fs.writeFileSync(path.join(root, '.gitattributes'), attributes);
    return { root, write: (content: string | Buffer) => fs.writeFileSync(path.join(root, 'input.txt'), content),
        clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const [autocrlf, attributes] of [['true', ''], ['input', ''], ['false', '*.txt text eol=lf\n'], ['false', '*.txt text eol=crlf\n']])
    test(`T-404 accepts Git EOL conversion autocrlf=${autocrlf} attributes=${attributes.trim() || 'unspecified'}`, () => {
        const f = fixture(autocrlf, attributes);
        try {
            f.write('one\r\ntwo\r\n'); runGit(f.root, ['add', 'input.txt']);
            const expected = buildScopeContentFingerprint(f.root, 'git_staged_only', ['input.txt']);
            assert.equal(classifiedContentFingerprint(f.root, 'git_staged_only', ['input.txt']), expected);
            f.write('one\r\nchanged\r\n');
            assert.throws(() => classifiedContentFingerprint(f.root, 'git_staged_only', ['input.txt']), /differs from executable/);
        } finally { f.clean(); }
    });

for (const [autocrlf, attributes, bytes] of [
    ['false', '', 'one\r\ntwo\r\n'], ['true', '*.txt -text\n', 'one\r\ntwo\r\n'],
    ['true', '', 'one\0\r\ntwo\r\n'], ['true', '', 'one\rbare\r\ntwo\r\n']
]) test(`T-404 keeps exact bytes when Git does not convert ${autocrlf}/${attributes.trim()}/${JSON.stringify(bytes)}`, () => {
    const f = fixture(autocrlf, attributes);
    try {
        f.write(bytes); runGit(f.root, ['add', 'input.txt']);
        assert.ok(classifiedContentFingerprint(f.root, 'git_staged_only', ['input.txt']));
        f.write(bytes.replace(/\r\n/g, '\n'));
        assert.throws(() => classifiedContentFingerprint(f.root, 'git_staged_only', ['input.txt']), /differs from executable/);
    } finally { f.clean(); }
});

test('T-404 staged evidence never runs configured clean, smudge or textconv commands', () => {
    const f = fixture('true');
    try {
        f.write('one\r\ntwo\r\n'); runGit(f.root, ['add', 'input.txt']);
        fs.writeFileSync(path.join(f.root, '.gitattributes'), '*.txt text filter=tripwire diff=tripwire\n');
        fs.writeFileSync(path.join(f.root, 'tripwire.cjs'), 'require("node:fs").writeFileSync("filter-ran", "bad"); process.exit(1);');
        for (const key of ['filter.tripwire.clean', 'filter.tripwire.smudge', 'filter.tripwire.process', 'diff.tripwire.textconv'])
            runGit(f.root, ['config', key, 'node tripwire.cjs']);
        assert.ok(classifiedContentFingerprint(f.root, 'git_staged_only', ['input.txt']));
        assert.equal(fs.existsSync(path.join(f.root, 'filter-ran')), false);
    } finally { f.clean(); }
});

function stageTextFiles(root: string, count: number): string[] {
    const files = Array.from({ length: count }, (_, index) => `input-${index}-${'x'.repeat(90)}.txt`);
    for (const file of files) fs.writeFileSync(path.join(root, file), 'one\r\ntwo\r\n');
    runGit(root, ['add', '--', '.']);
    return files;
}

test('T-404 batches staged EOL metadata and reads autocrlf once per snapshot', (context) => {
    const f = fixture('true');
    try {
        const files = stageTextFiles(f.root, 12);
        const expected = buildScopeContentFingerprint(f.root, 'git_staged_only', files);
        const originalBinary = git.runGitBinary, originalText = git.runGit;
        let eolQueries = 0, configQueries = 0;
        context.mock.method(git, 'runGitBinary', (...args: Parameters<typeof originalBinary>) => {
            if (args[1].includes('--eol')) eolQueries++;
            return originalBinary(...args);
        });
        context.mock.method(git, 'runGit', (...args: Parameters<typeof originalText>) => {
            if (args[1][0] === 'config' && args[1].includes('--get')) configQueries++;
            return originalText(...args);
        });
        for (let inspection = 0; inspection < 2; inspection++) {
            eolQueries = 0; configQueries = 0;
            assert.equal(classifiedContentFingerprint(f.root, 'git_staged_only', files), expected);
            assert.equal(eolQueries, 1, 'One native metadata query must cover this complete scoped file set.');
            assert.equal(configQueries, 1, 'Read the repository-wide setting once per fresh inspection.');
        }
        runGit(f.root, ['config', 'core.autocrlf', 'false']);
        assert.throws(() => classifiedContentFingerprint(f.root, 'git_staged_only', files), /differs from executable/);
        for (const file of files) fs.writeFileSync(path.join(f.root, file), 'one\ntwo\n');
        eolQueries = 0; configQueries = 0;
        assert.equal(classifiedContentFingerprint(f.root, 'git_staged_only', files), expected);
        assert.equal(eolQueries, 0, 'Exact staged bytes must retain the metadata-free fast path.');
        assert.equal(configQueries, 0);
    } finally { f.clean(); }
});

test('T-404 staged EOL metadata uses bounded path batches for large scopes', (context) => {
    const f = fixture('true');
    try {
        const files = stageTextFiles(f.root, 100);
        const expected = buildScopeContentFingerprint(f.root, 'git_staged_only', files);
        const original = git.runGitBinary, batches: string[][] = [];
        context.mock.method(git, 'runGitBinary', (...args: Parameters<typeof original>) => {
            if (args[1].includes('--eol')) batches.push([...args[1]]);
            return original(...args);
        });
        assert.equal(classifiedContentFingerprint(f.root, 'git_staged_only', files), expected);
        assert.ok(batches.length > 1 && batches.length < files.length / 2, 'Batch work instead of launching per file.');
        assert.ok(batches.every(args => args.join(' ').length < 30_000), 'Retain headroom below Windows command-line limits.');
        const requested = batches.flatMap(args => args.slice(args.indexOf('--') + 1));
        assert.deepEqual(requested.sort(), files.map(file => `:(literal)${file}`).sort());
    } finally { f.clean(); }
});

for (const corruption of ['missing', 'duplicate', 'foreign'])
    test(`T-404 staged EOL metadata rejects ${corruption} records`, (context) => {
        const f = fixture('true');
        try {
            const files = stageTextFiles(f.root, 2);
            const original = git.runGitBinary;
            context.mock.method(git, 'runGitBinary', (...args: Parameters<typeof original>) => {
                const output = original(...args);
                if (!args[1].includes('--eol')) return output;
                if (corruption === 'missing') return Buffer.alloc(0);
                if (corruption === 'duplicate') return Buffer.concat([output, output]);
                return Buffer.from(output.toString('utf8').replace(files[0], 'outside-scope.txt'));
            });
            assert.throws(() => classifiedContentFingerprint(f.root, 'git_staged_only', files), /Cannot authenticate staged Git EOL metadata/);
        } finally { f.clean(); }
    });
