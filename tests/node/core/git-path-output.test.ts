import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseNameStatusZ, parseNumstatZ, parsePorcelainV1Z, splitNulRecords } from '../../../src/core/git-path-output';

describe('core/git-path-output', () => {
    it('splits empty, terminated and unterminated NUL output without trimming paths', () => {
        assert.deepEqual(splitNulRecords(''), []);
        assert.deepEqual(splitNulRecords('ascii.txt\0тест.txt\0'), ['ascii.txt', 'тест.txt']);
        assert.deepEqual(splitNulRecords(' leading space \0目录/文件.txt'), [' leading space ', '目录/文件.txt']);
        assert.deepEqual(splitNulRecords('a\0\0b\0'), ['a', '', 'b']);
        assert.deepEqual(splitNulRecords(Buffer.from('quote"name.txt\0')), ['quote"name.txt']);
    });

    it('parses text and binary numstat records while preserving tabs and quotes in paths', () => {
        assert.deepEqual(parseNumstatZ('2\t1\tтест.txt\0-\t-\t目录/文件.bin\0' + '1\t0\tquote"\tname.txt\0'), [
            { additions: 2, deletions: 1, path: 'тест.txt', previousPath: null },
            { additions: null, deletions: null, path: '目录/文件.bin', previousPath: null },
            { additions: 1, deletions: 0, path: 'quote"\tname.txt', previousPath: null }
        ]);
    });

    it('parses the separate source and destination records of a numstat rename or copy', () => {
        assert.deepEqual(parseNumstatZ('0\t0\t\0old/тест.txt\0new dir/文件.txt\0'), [
            { additions: 0, deletions: 0, path: 'new dir/文件.txt', previousPath: 'old/тест.txt' }
        ]);
        // Operator-approved ASCII exception: the legacy helper misread literal " => " as a rename.
        // Correct path parsing may change its formerly incorrect metrics and scope hash.
        assert.deepEqual(parseNumstatZ('1\t2\tliteral => name.txt\0'), [
            { additions: 1, deletions: 2, path: 'literal => name.txt', previousPath: null }
        ]);
    });

    it('rejects malformed numstat counters and incomplete rename endpoints', () => {
        for (const output of ['bad', 'x\t1\tfile\0', '1\tx\tfile\0', '1\t0\t\0old\0', '1\t0\t\0\0new\0']) {
            assert.throws(() => parseNumstatZ(output), /numstat/iu);
        }
    });

    it('parses staged, unstaged, untracked and ignored porcelain records', () => {
        assert.deepEqual(parsePorcelainV1Z(' M тест.txt\0A  dir with space/файл.txt\0?? новый.txt\0!! ignored.txt\0'), [
            { indexStatus: ' ', worktreeStatus: 'M', path: 'тест.txt', previousPath: null },
            { indexStatus: 'A', worktreeStatus: ' ', path: 'dir with space/файл.txt', previousPath: null },
            { indexStatus: '?', worktreeStatus: '?', path: 'новый.txt', previousPath: null },
            { indexStatus: '!', worktreeStatus: '!', path: 'ignored.txt', previousPath: null }
        ]);
    });

    it('consumes the source after the destination for porcelain renames and copies in either layer', () => {
        assert.deepEqual(parsePorcelainV1Z('RM new/文件.txt\0old/тест.txt\0 C copy.txt\0source.txt\0?? R100\0'), [
            { indexStatus: 'R', worktreeStatus: 'M', path: 'new/文件.txt', previousPath: 'old/тест.txt' },
            { indexStatus: ' ', worktreeStatus: 'C', path: 'copy.txt', previousPath: 'source.txt' },
            { indexStatus: '?', worktreeStatus: '?', path: 'R100', previousPath: null }
        ]);
    });

    it('preserves pathname whitespace, quotes and newlines in porcelain output', () => {
        const filePath = ' space\tquote"\nтест.txt ';
        assert.equal(parsePorcelainV1Z(` M ${filePath}\0`)[0].path, filePath);
    });

    it('rejects malformed porcelain headers and missing rename or copy sources', () => {
        for (const output of ['bad\0', ' M \0', 'R  new.txt\0', ' C new.txt\0\0']) {
            assert.throws(() => parsePorcelainV1Z(output), /porcelain/iu);
        }
    });

    it('parses name-status renames and copies without mistaking a pathname for a status', () => {
        assert.deepEqual(parseNameStatusZ('M\0R100\0R100\0old/тест.txt\0new/文件.txt\0C75\0source.txt\0copy.txt\0'), [
            { status: 'M', path: 'R100', previousPath: null },
            { status: 'R100', path: 'new/文件.txt', previousPath: 'old/тест.txt' },
            { status: 'C75', path: 'copy.txt', previousPath: 'source.txt' }
        ]);
        assert.throws(() => parseNameStatusZ('R100\0old\0'), /name-status/iu);
    });
});
