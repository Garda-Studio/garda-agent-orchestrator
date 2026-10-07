import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildScopedDiffMetadata,
    convertToGitPathspecs,
    parseUnifiedDiff,
    extractFilePathFromDiffLine,
    filterHunksInBlock,
    reassembleDiff,
    filterDiffByHunks,
    ScopedDiffOptions,
    DiffFileBlock
} from '../../../src/gate-runtime/scoped-diff';


test('buildScopedDiffMetadata returns scoped diff when matches exist', () => {
    const result = buildScopedDiffMetadata({
        reviewType: 'security',
        changedFiles: ['src/auth.py', 'README.md', 'src/db.py'],
        triggerRegexes: ['src/.*\\.py$'],
        scopedDiffText: 'diff --git a/src/auth.py\n+line\n',
        fullDiffText: 'full diff text\n'
    });

    assert.equal(result.review_type, 'security');
    assert.equal(result.matched_files_count, 2);
    assert.deepEqual(result.matched_files, ['src/auth.py', 'src/db.py']);
    assert.equal(result.fallback_to_full_diff, false);
    assert.ok(((result as Record<string, unknown>).output_diff_text as string).includes('src/auth.py'));
});

test('buildScopedDiffMetadata falls back to full diff when no matches', () => {
    const result = buildScopedDiffMetadata({
        reviewType: 'db',
        changedFiles: ['README.md'],
        triggerRegexes: ['src/.*\\.py$'],
        scopedDiffText: '',
        fullDiffText: 'full diff\n'
    });

    assert.equal(result.matched_files_count, 0);
    assert.equal(result.fallback_to_full_diff, true);
    assert.equal((result as Record<string, unknown>).output_diff_text as string, 'full diff\n');
});

test('buildScopedDiffMetadata falls back when scoped diff empty', () => {
    const result = buildScopedDiffMetadata({
        reviewType: 'security',
        changedFiles: ['src/auth.py'],
        triggerRegexes: ['src/.*\\.py$'],
        scopedDiffText: '',
        fullDiffText: 'full diff\n'
    });

    assert.equal(result.matched_files_count, 1);
    assert.equal(result.fallback_to_full_diff, true);
});

test('buildScopedDiffMetadata throws for missing reviewType', () => {
    assert.throws(
        () => buildScopedDiffMetadata({ triggerRegexes: ['test'] } as unknown as ScopedDiffOptions),
        /reviewType is required/
    );
});

test('buildScopedDiffMetadata throws for empty triggerRegexes', () => {
    assert.throws(
        () => buildScopedDiffMetadata({ reviewType: 'db', triggerRegexes: [] }),
        /No trigger regexes/
    );
});

test('buildScopedDiffMetadata deduplicates and sorts changed files', () => {
    const result = buildScopedDiffMetadata({
        reviewType: 'security',
        changedFiles: ['src/b.py', 'src/a.py', 'src/b.py'],
        triggerRegexes: ['src/.*\\.py$'],
        scopedDiffText: 'diff text\n',
        fullDiffText: 'full diff\n'
    });

    assert.deepEqual(result.matched_files, ['src/a.py', 'src/b.py']);
});

test('buildScopedDiffMetadata normalizes backslashes in paths', () => {
    const result = buildScopedDiffMetadata({
        reviewType: 'db',
        changedFiles: ['src\\db\\models.py'],
        triggerRegexes: ['src/db/'],
        scopedDiffText: 'diff\n',
        fullDiffText: 'full\n'
    });

    assert.deepEqual(result.matched_files, ['src/db/models.py']);
});

test('buildScopedDiffMetadata counts lines correctly', () => {
    const result = buildScopedDiffMetadata({
        reviewType: 'security',
        changedFiles: ['src/auth.py'],
        triggerRegexes: ['src/'],
        scopedDiffText: 'line1\nline2\nline3\n',
        fullDiffText: 'full\n'
    });

    assert.equal(result.scoped_diff_line_count, 4);
    assert.equal(result.output_diff_line_count, 4);
});


test('convertToGitPathspecs returns empty for empty input', () => {
    assert.deepEqual(convertToGitPathspecs([], '/repo', '/repo'), []);
    assert.deepEqual(convertToGitPathspecs(null as unknown as string[], '/repo', '/repo'), []);
});

test('convertToGitPathspecs passes through when roots match', () => {
    assert.deepEqual(
        convertToGitPathspecs(['src/a.ts', 'lib/b.ts'], '/repo', '/repo'),
        ['src/a.ts', 'lib/b.ts']
    );
});

test('convertToGitPathspecs strips git root prefix', () => {
    const result = convertToGitPathspecs(
        ['garda-agent-orchestrator/src/a.ts', 'src/b.ts'],
        '/workspace',
        '/workspace/garda-agent-orchestrator'
    );
    assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('convertToGitPathspecs normalizes backslashes', () => {
    const result = convertToGitPathspecs(
        ['garda-agent-orchestrator\\src\\a.ts'],
        '/workspace',
        '/workspace/garda-agent-orchestrator'
    );
    assert.deepEqual(result, ['src/a.ts']);
});


test('parseUnifiedDiff returns empty for empty input', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
    assert.deepEqual(parseUnifiedDiff('  \n  '), []);
});

test('parseUnifiedDiff parses single file with single hunk', () => {
    const diff = [
        'diff --git a/src/auth.ts b/src/auth.ts',
        'index abc1234..def5678 100644',
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -10,6 +10,7 @@ export class Auth {',
        '     existing line',
        '+    new auth line',
        '     another line'
    ].join('\n');

    const blocks = parseUnifiedDiff(diff);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].filePath, 'src/auth.ts');
    assert.equal(blocks[0].headerLines.length, 4);
    assert.equal(blocks[0].hunks.length, 1);
    assert.equal(blocks[0].hunks[0].header, '@@ -10,6 +10,7 @@ export class Auth {');
    assert.equal(blocks[0].hunks[0].lines.length, 3);
});

test('parseUnifiedDiff parses multiple hunks in one file', () => {
    const diff = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -5,3 +5,4 @@ function a() {',
        '     line a',
        '+    new a',
        '@@ -20,3 +21,4 @@ function b() {',
        '     line b',
        '+    new b'
    ].join('\n');

    const blocks = parseUnifiedDiff(diff);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].hunks.length, 2);
    assert.equal(blocks[0].hunks[0].header, '@@ -5,3 +5,4 @@ function a() {');
    assert.equal(blocks[0].hunks[1].header, '@@ -20,3 +21,4 @@ function b() {');
});

test('parseUnifiedDiff parses multiple files', () => {
    const diff = [
        'diff --git a/src/auth.ts b/src/auth.ts',
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -1,3 +1,4 @@',
        '+auth change',
        'diff --git a/src/db.ts b/src/db.ts',
        '--- a/src/db.ts',
        '+++ b/src/db.ts',
        '@@ -1,3 +1,4 @@',
        '+db change'
    ].join('\n');

    const blocks = parseUnifiedDiff(diff);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].filePath, 'src/auth.ts');
    assert.equal(blocks[1].filePath, 'src/db.ts');
});

test('parseUnifiedDiff normalizes CRLF input without retaining stray carriage returns', () => {
    const diff = [
        'diff --git a/src/auth.ts b/src/auth.ts',
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -10,6 +10,7 @@ export class Auth {',
        '     existing line',
        '+    new auth line',
        '     another line'
    ].join('\r\n');

    const blocks = parseUnifiedDiff(diff);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].filePath, 'src/auth.ts');
    assert.equal(blocks[0].headerLines.length, 3);
    assert.equal(blocks[0].headerLines.some((line) => line.includes('\r')), false);
    assert.equal(blocks[0].hunks[0].header, '@@ -10,6 +10,7 @@ export class Auth {');
    assert.equal(blocks[0].hunks[0].lines.some((line) => line.includes('\r')), false);
});


function makeGitDiffRepo(t: TestContext) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-scoped-diff-'));
    t.after(() => {
        const resolved = fs.realpathSync(repoRoot);
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('garda-scoped-diff-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const git = (...args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    git('init');
    git('config', 'user.name', 'Garda Tests');
    git('config', 'user.email', 'tests@example.com');
    git('config', 'core.autocrlf', 'false');
    const write = (name: string, content: string) => {
        const target = path.join(repoRoot, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
    };
    return { repoRoot, git, write };
}

for (const quotePath of ['true', 'false']) {
    for (const staged of [false, true]) {
        const layer = staged ? 'staged' : 'unstaged';
        test('real Git ' + layer + ' quoted paths remain in scoped diff with quotepath=' + quotePath, (t) => {
            const { git, write } = makeGitDiffRepo(t);
            const names = ['src/plain space.ts', 'src/literal b/space.ts', 'src/ café.ts', 'src/日本.ts'];
            if (process.platform !== 'win32') {
                names.push('src/quote"name.ts', 'src/back\\slash.ts', 'src/tab\tname.ts',
                    'src/line\nname.ts', 'src/carriage\rname.ts', 'src/trailing.ts ');
            }
            for (const name of names) write(name, 'before\n');
            git('add', '--', '.');
            git('commit', '-m', 'seed');
            git('config', 'core.quotepath', quotePath);
            for (const name of names) write(name, 'after\n');
            if (staged) git('add', '--', '.');
            const diff = git('diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv');
            assert.deepEqual(parseUnifiedDiff(diff).map(block => block.filePath).sort(), [...names].sort());
            const filtered = filterDiffByHunks(diff, ['^src/']);
            assert.equal(filtered.includedFileBlocks, names.length);
            assert.deepEqual(parseUnifiedDiff(filtered.filteredDiffText).map(block => block.filePath).sort(), [...names].sort());
        });

        test('real Git ' + layer + ' rename destination is exact with quotepath=' + quotePath, (t) => {
            const { repoRoot, git, write } = makeGitDiffRepo(t);
            const oldName = 'src/old b/日本.ts';
            const newName = 'src/new b/café.ts';
            write(oldName, 'unchanged\n');
            write('src/plain b/old.ts', 'plain\n');
            git('add', '--', '.');
            git('commit', '-m', 'seed');
            git('config', 'core.quotepath', quotePath);
            for (const [from, to] of [[oldName, newName], ['src/plain b/old.ts', 'src/new b/plain.ts']]) {
                fs.mkdirSync(path.dirname(path.join(repoRoot, to)), { recursive: true });
                fs.renameSync(path.join(repoRoot, from), path.join(repoRoot, to));
                if (!staged) git('add', '-N', '--', to);
            }
            if (staged) git('add', '-A');
            const diff = git('diff', ...(staged ? ['--cached'] : []), '--find-renames',
                '--no-ext-diff', '--no-textconv');
            assert.match(diff, /rename to /);
            assert.deepEqual(parseUnifiedDiff(diff).map(block => block.filePath).sort(),
                [newName, 'src/new b/plain.ts'].sort());
            const filtered = filterDiffByHunks(diff, ['^src/new b/']);
            assert.equal(filtered.includedFileBlocks, 2);
            assert.match(filtered.filteredDiffText, /rename to /);
        });
    }
}

test('extractFilePathFromDiffLine decodes Git octal UTF-8 and mixed quoted rename endpoints', () => {
    assert.equal(extractFilePathFromDiffLine('diff --git "a/src/\\346\\227\\245\\346\\234\\254.ts" "b/src/\\346\\227\\245\\346\\234\\254.ts"'), 'src/日本.ts');
    assert.equal(extractFilePathFromDiffLine('diff --git "a/old\\ttab.ts" b/new name.ts'), 'new name.ts');
    assert.equal(extractFilePathFromDiffLine('diff --git a/old name.ts "b/new\\"quote.ts"'), 'new"quote.ts');
    assert.equal(extractFilePathFromDiffLine('diff --git "a/back\\\\slash.ts" "b/back\\\\slash.ts"'), 'back\\slash.ts');
});

test('parseUnifiedDiff rejects undecodable Git paths instead of silently filtering their blocks away', () => {
    assert.throws(() => filterDiffByHunks('diff --git "a/bad\\q.ts" "b/bad\\q.ts"', ['^src/']), /decodable Git path/);
    assert.throws(() => filterDiffByHunks('diff --git "a/bad\\377.ts" "b/bad\\377.ts"', ['^src/']), /decodable Git path/);
    assert.throws(() => filterDiffByHunks('diff --git "a/bad\\000.ts" "b/bad\\000.ts"', ['^src/']), /decodable Git path/);
});

test('extractFilePathFromDiffLine extracts b-side path', () => {
    assert.equal(extractFilePathFromDiffLine('diff --git a/src/auth.ts b/src/auth.ts'), 'src/auth.ts');
    assert.equal(extractFilePathFromDiffLine('diff --git a/old/name.ts b/new/name.ts'), 'new/name.ts');
});

test('extractFilePathFromDiffLine returns empty for non-matching lines', () => {
    assert.equal(extractFilePathFromDiffLine('not a diff line'), '');
    assert.equal(extractFilePathFromDiffLine(''), '');
});

test('extractFilePathFromDiffLine handles paths with space b/ in name', () => {
    assert.equal(
        extractFilePathFromDiffLine('diff --git a/src/x b/file.ts b/src/x b/file.ts'),
        'src/x b/file.ts'
    );
});

test('extractFilePathFromDiffLine handles renames via lastIndexOf fallback', () => {
    assert.equal(
        extractFilePathFromDiffLine('diff --git a/old/name.ts b/new/name.ts'),
        'new/name.ts'
    );
});


test('filterHunksInBlock keeps hunks whose changed lines match triggers', () => {
    const block: DiffFileBlock = {
        filePath: 'src/utils.ts',
        headerLines: ['diff --git a/src/utils.ts b/src/utils.ts', '--- a/src/utils.ts', '+++ b/src/utils.ts'],
        hunks: [
            { header: '@@ -1,3 +1,4 @@', lines: [' context', '+import { authToken } from "./auth"', ' more context'] },
            { header: '@@ -20,3 +21,4 @@', lines: [' context', '+const x = 42;', ' more context'] }
        ]
    };
    const result = filterHunksInBlock(block, {
        triggerRegexes: ['auth|security'],
        reviewType: 'security'
    });
    assert.equal(result.matchedHunkCount, 1);
    assert.equal(result.totalHunkCount, 2);
    assert.equal(result.block.hunks.length, 1);
    assert.ok(result.block.hunks[0].lines.some(l => l.includes('authToken')));
});

test('filterHunksInBlock keeps all hunks when file path matches', () => {
    const block: DiffFileBlock = {
        filePath: 'src/auth/login.ts',
        headerLines: ['diff --git a/src/auth/login.ts b/src/auth/login.ts'],
        hunks: [
            { header: '@@ -1,3 +1,4 @@', lines: ['+no keyword here'] },
            { header: '@@ -10,3 +11,4 @@', lines: ['+also no keyword'] }
        ]
    };
    const result = filterHunksInBlock(block, {
        triggerRegexes: ['(^|/)auth(/|\\.|$)'],
        reviewType: 'security'
    });
    assert.equal(result.filePathMatched, true);
    assert.equal(result.matchedHunkCount, 2);
    assert.equal(result.block.hunks.length, 2);
});

test('filterHunksInBlock returns empty hunks when nothing matches', () => {
    const block: DiffFileBlock = {
        filePath: 'docs/README.md',
        headerLines: ['diff --git a/docs/README.md b/docs/README.md'],
        hunks: [
            { header: '@@ -1,3 +1,4 @@', lines: ['+just documentation'] }
        ]
    };
    const result = filterHunksInBlock(block, {
        triggerRegexes: ['auth|security'],
        reviewType: 'security'
    });
    assert.equal(result.matchedHunkCount, 0);
    assert.equal(result.block.hunks.length, 0);
    assert.equal(result.filePathMatched, false);
});

test('filterHunksInBlock matches on deletion lines', () => {
    const block: DiffFileBlock = {
        filePath: 'src/utils.ts',
        headerLines: ['diff --git a/src/utils.ts b/src/utils.ts'],
        hunks: [
            { header: '@@ -1,4 +1,3 @@', lines: ['-import { dbQuery } from "./db"', ' remaining'] }
        ]
    };
    const result = filterHunksInBlock(block, {
        triggerRegexes: ['db|database|migration'],
        reviewType: 'db'
    });
    assert.equal(result.matchedHunkCount, 1);
    assert.equal(result.block.hunks.length, 1);
});


test('reassembleDiff reconstructs diff text from blocks', () => {
    const blocks: DiffFileBlock[] = [{
        filePath: 'src/auth.ts',
        headerLines: ['diff --git a/src/auth.ts b/src/auth.ts', '--- a/src/auth.ts', '+++ b/src/auth.ts'],
        hunks: [
            { header: '@@ -1,3 +1,4 @@', lines: [' context', '+new line'] }
        ]
    }];
    const text = reassembleDiff(blocks);
    assert.ok(text.includes('diff --git a/src/auth.ts b/src/auth.ts'));
    assert.ok(text.includes('@@ -1,3 +1,4 @@'));
    assert.ok(text.includes('+new line'));
    assert.ok(text.endsWith('\n'));
});

test('reassembleDiff returns empty for blocks with no hunks', () => {
    const blocks: DiffFileBlock[] = [{
        filePath: 'empty.ts',
        headerLines: ['diff --git a/empty.ts b/empty.ts'],
        hunks: []
    }];
    assert.equal(reassembleDiff(blocks), '');
});


test('filterDiffByHunks filters irrelevant hunks from multi-hunk diff', () => {
    const diff = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -5,3 +5,4 @@ function login() {',
        ' context',
        '+validateToken(jwt);',
        ' more context',
        '@@ -30,3 +31,4 @@ function render() {',
        ' context',
        '+console.log("hello");',
        ' more context'
    ].join('\n');

    const result = filterDiffByHunks(diff, ['(auth|token|jwt|security)'], { reviewType: 'security' });
    assert.equal(result.totalHunks, 2);
    assert.equal(result.includedHunks, 1);
    assert.equal(result.hunkLevelFiltered, true);
    assert.ok(result.filteredDiffText.includes('validateToken'));
    assert.ok(!result.filteredDiffText.includes('console.log'));
});

test('filterDiffByHunks keeps all hunks when all match', () => {
    const diff = [
        'diff --git a/src/auth.ts b/src/auth.ts',
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -1,3 +1,4 @@',
        '+import jwt from "jsonwebtoken"',
        '@@ -10,3 +11,4 @@',
        '+export const authMiddleware = () => {}'
    ].join('\n');

    const result = filterDiffByHunks(diff, ['(auth|jwt)'], { reviewType: 'security' });
    assert.equal(result.totalHunks, 2);
    assert.equal(result.includedHunks, 2);
    assert.equal(result.hunkLevelFiltered, false);
});

test('filterDiffByHunks returns empty for empty diff', () => {
    const result = filterDiffByHunks('', ['auth'], { reviewType: 'security' });
    assert.equal(result.filteredDiffText, '');
    assert.equal(result.totalFileBlocks, 0);
    assert.equal(result.hunkLevelFiltered, false);
});

test('filterDiffByHunks handles multi-file diff with selective filtering', () => {
    const diff = [
        'diff --git a/src/auth/login.ts b/src/auth/login.ts',
        '--- a/src/auth/login.ts',
        '+++ b/src/auth/login.ts',
        '@@ -1,3 +1,4 @@',
        '+irrelevant change',
        'diff --git a/src/utils.ts b/src/utils.ts',
        '--- a/src/utils.ts',
        '+++ b/src/utils.ts',
        '@@ -1,3 +1,4 @@',
        '+format date string',
        '@@ -20,3 +21,4 @@',
        '+verifyToken(jwt);'
    ].join('\n');

    const result = filterDiffByHunks(diff, ['(^|/)auth(/|\\.|$)', 'token|jwt'], { reviewType: 'security' });
    assert.equal(result.totalFileBlocks, 2);
    assert.equal(result.includedFileBlocks, 2);
    // auth/login.ts included because file path matches
    assert.ok(result.filteredDiffText.includes('auth/login.ts'));
    // utils.ts included because hunk content matches
    assert.ok(result.filteredDiffText.includes('verifyToken'));
});

test('filterDiffByHunks excludes file blocks where neither path nor hunks match', () => {
    const diff = [
        'diff --git a/docs/README.md b/docs/README.md',
        '--- a/docs/README.md',
        '+++ b/docs/README.md',
        '@@ -1,3 +1,4 @@',
        '+Updated documentation'
    ].join('\n');

    const result = filterDiffByHunks(diff, ['auth|security'], { reviewType: 'security' });
    assert.equal(result.totalFileBlocks, 1);
    assert.equal(result.includedFileBlocks, 0);
    assert.equal(result.filteredDiffText, '');
});

test('filterDiffByHunks matches on hunk header function context', () => {
    const diff = [
        'diff --git a/src/service.ts b/src/service.ts',
        '--- a/src/service.ts',
        '+++ b/src/service.ts',
        '@@ -50,3 +50,4 @@ function authenticateUser() {',
        ' context',
        '+return true;',
        ' more context'
    ].join('\n');

    const result = filterDiffByHunks(diff, ['authenticate'], { reviewType: 'security' });
    assert.equal(result.includedHunks, 1);
    assert.ok(result.filteredDiffText.includes('authenticateUser'));
});

test('filterDiffByHunks matches CRLF diff content with anchored trigger regexes', () => {
    const diff = [
        'diff --git a/src/auth.ts b/src/auth.ts',
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -1,3 +1,4 @@',
        '+verifyToken(jwt);'
    ].join('\r\n');

    const result = filterDiffByHunks(diff, ['verifyToken\\(jwt\\);$'], { reviewType: 'security' });
    assert.equal(result.totalFileBlocks, 1);
    assert.equal(result.includedFileBlocks, 1);
    assert.equal(result.includedHunks, 1);
    assert.ok(result.filteredDiffText.includes('+verifyToken(jwt);'));
    assert.equal(result.filteredDiffText.includes('\r'), false);
});

test('filterHunksInBlock includes binary/mode-only block when file path matches', () => {
    const block: DiffFileBlock = {
        filePath: 'src/auth/cert.pem',
        headerLines: [
            'diff --git a/src/auth/cert.pem b/src/auth/cert.pem',
            'Binary files a/src/auth/cert.pem and b/src/auth/cert.pem differ'
        ],
        hunks: []
    };
    const result = filterHunksInBlock(block, {
        triggerRegexes: ['(^|/)auth(/|\\.|$)'],
        reviewType: 'security'
    });
    assert.equal(result.filePathMatched, true);
    assert.equal(result.totalHunkCount, 0);
    assert.equal(result.matchedHunkCount, 0);
});

test('filterHunksInBlock excludes binary/mode-only block when file path does not match', () => {
    const block: DiffFileBlock = {
        filePath: 'assets/logo.png',
        headerLines: [
            'diff --git a/assets/logo.png b/assets/logo.png',
            'Binary files a/assets/logo.png and b/assets/logo.png differ'
        ],
        hunks: []
    };
    const result = filterHunksInBlock(block, {
        triggerRegexes: ['(^|/)auth(/|\\.|$)'],
        reviewType: 'security'
    });
    assert.equal(result.filePathMatched, false);
    assert.equal(result.totalHunkCount, 0);
});

test('reassembleDiff includes header-only blocks with multi-line headers', () => {
    const blocks: DiffFileBlock[] = [{
        filePath: 'src/auth/cert.pem',
        headerLines: [
            'diff --git a/src/auth/cert.pem b/src/auth/cert.pem',
            'Binary files a/src/auth/cert.pem and b/src/auth/cert.pem differ'
        ],
        hunks: []
    }];
    const text = reassembleDiff(blocks);
    assert.ok(text.includes('src/auth/cert.pem'));
    assert.ok(text.includes('Binary files'));
});

test('filterDiffByHunks includes binary blocks with path matches', () => {
    const diff = [
        'diff --git a/src/auth/cert.pem b/src/auth/cert.pem',
        'Binary files a/src/auth/cert.pem and b/src/auth/cert.pem differ',
        'diff --git a/src/utils.ts b/src/utils.ts',
        '--- a/src/utils.ts',
        '+++ b/src/utils.ts',
        '@@ -1,3 +1,4 @@',
        '+console.log("hello");'
    ].join('\n');

    const result = filterDiffByHunks(diff, ['(^|/)auth(/|\\.|$)'], { reviewType: 'security' });
    assert.equal(result.includedFileBlocks, 1);
    assert.ok(result.filteredDiffText.includes('cert.pem'));
    assert.ok(!result.filteredDiffText.includes('utils.ts'));
});

test('filterDiffByHunks produces empty output when nothing matches', () => {
    const diff = [
        'diff --git a/src/utils.ts b/src/utils.ts',
        '--- a/src/utils.ts',
        '+++ b/src/utils.ts',
        '@@ -1,3 +1,4 @@',
        '+console.log("hello");'
    ].join('\n');

    const result = filterDiffByHunks(diff, ['auth|security'], { reviewType: 'security' });
    assert.equal(result.filteredDiffText, '');
    assert.equal(result.includedFileBlocks, 0);
    assert.equal(result.hunkLevelFiltered, true);
});

test('filterHunksInBlock keeps all hunks when file path matches even if only some hunks match content', () => {
    const block: DiffFileBlock = {
        filePath: 'src/auth/service.ts',
        headerLines: ['diff --git a/src/auth/service.ts b/src/auth/service.ts', '--- a/src/auth/service.ts', '+++ b/src/auth/service.ts'],
        hunks: [
            { header: '@@ -1,3 +1,4 @@', lines: ['+import { token } from "./jwt"'] },
            { header: '@@ -20,3 +21,4 @@', lines: ['+console.log("debug")'] }
        ]
    };
    const result = filterHunksInBlock(block, {
        triggerRegexes: ['(^|/)auth(/|\\.|$)', 'token|jwt'],
        reviewType: 'security'
    });
    assert.equal(result.filePathMatched, true);
    assert.equal(result.matchedHunkCount, 2);
    assert.equal(result.block.hunks.length, 2);
});

test('filterDiffByHunks sets hunkLevelFiltered when binary blocks are excluded', () => {
    const diff = [
        'diff --git a/src/auth/cert.pem b/src/auth/cert.pem',
        'Binary files a/src/auth/cert.pem and b/src/auth/cert.pem differ',
        'diff --git a/assets/logo.png b/assets/logo.png',
        'Binary files a/assets/logo.png and b/assets/logo.png differ'
    ].join('\n');

    const result = filterDiffByHunks(diff, ['(^|/)auth(/|\\.|$)'], { reviewType: 'security' });
    assert.equal(result.totalFileBlocks, 2);
    assert.equal(result.includedFileBlocks, 1);
    assert.equal(result.hunkLevelFiltered, true);
    assert.ok(result.filteredDiffText.includes('cert.pem'));
    assert.ok(!result.filteredDiffText.includes('logo.png'));
});
