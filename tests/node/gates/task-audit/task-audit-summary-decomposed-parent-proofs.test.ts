import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';

const fs: typeof import('node:fs') = require('node:fs');
const modulePath = '../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs';
const roots: string[] = [];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type GitSource = { commitSha: string; treeSha: string; parentCommitSha: string | null };
function gitValidator(): (root: string, source: GitSource) => void {
    const validate = require(modulePath).validateNativeChildGitSource;
    assert.equal(typeof validate, 'function', 'bounded native Git source validator must exist');
    return validate;
}
function proofGit(root: string, args: string[], input?: string): string {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, input });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function gitFixture() {
    const f = fixture();
    proofGit(f.root, ['init']);
    proofGit(f.root, ['config', 'user.name', 'Proof Test']);
    proofGit(f.root, ['config', 'user.email', 'proof@example.invalid']);
    proofGit(f.root, ['add', 'proofs/record.json']);
    proofGit(f.root, ['commit', '-m', 'baseline']);
    const parentCommitSha = proofGit(f.root, ['rev-parse', 'HEAD']);
    proofGit(f.root, ['commit', '--allow-empty', '-m', 'accepted source']);
    const source = { commitSha: proofGit(f.root, ['rev-parse', 'HEAD']),
        treeSha: proofGit(f.root, ['rev-parse', 'HEAD^{tree}']), parentCommitSha };
    return { ...f, source };
}

describe('native child Git source provenance', () => {
    it('validates real root, accepted parent/tree and later ancestry with one raw object batch', () => {
        const validate = gitValidator(), f = gitFixture();
        validate(f.root, f.source);
        validate(f.root, { ...f.source, commitSha: f.source.parentCommitSha!, parentCommitSha: null });
        for (let i = 0; i < 4; i++) proofGit(f.root, ['commit', '--allow-empty', '-m', 'later']);
        const api = require('node:child_process'), original = api.execFileSync;
        let batches = 0, commands = 0;
        mock.method(api, 'execFileSync', (...args: unknown[]) => {
            if (args[0] === 'git') {
                commands++;
                if ((args[1] as string[]).includes('--batch')) batches++;
            }
            return Reflect.apply(original, api, args);
        });
        validate(f.root, f.source);
        assert.equal(batches, 1, 'commit and tree content use one batch');
        assert.ok(commands <= 7, `Git process count must stay bounded, observed ${commands}`);
    });

    it('rejects foreign root, wrong tree/parent and a commit outside the current lineage', () => {
        const validate = gitValidator(), f = gitFixture();
        assert.throws(() => validate(path.join(f.root, 'proofs'), f.source), /root/iu);
        assert.throws(() => validate(f.root, { ...f.source, treeSha: '0'.repeat(40) }));
        assert.throws(() => validate(f.root, { ...f.source, parentCommitSha: null }), /parent/iu);
        assert.throws(() => validate(f.root, { ...f.source, commitSha: '--help' }), /identity/iu);
        proofGit(f.root, ['checkout', '--orphan', 'unrelated']);
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'unrelated root']);
        assert.throws(() => validate(f.root, f.source));
    });

    it('rejects inherited Git repository overrides in isolated child environments', () => {
        gitValidator();
        const f = gitFixture();
        for (const [key, value] of [['GIT_DIR', path.join(f.root, '.git')], ['GIT_WORK_TREE', f.root],
            ['GIT_CONFIG_COUNT', '0'], ['GIT_OBJECT_DIRECTORY', path.join(f.root, '.git/objects')]]) {
            const script = `const a=require('node:assert/strict'); const m=require(process.argv[1]);
                a.throws(()=>m.validateNativeChildGitSource(process.argv[2],JSON.parse(process.argv[3])),/environment/iu);`;
            const result = spawnSync(process.execPath, ['-e', script, require.resolve(modulePath), f.root,
                JSON.stringify(f.source)], { encoding: 'utf8', timeout: 10000, env: { ...process.env, [key!]: value } });
            assert.equal(result.status, 0, `${key}: ${result.stderr}`);
        }
    });

    it('rejects a graft that makes an unrelated HEAD appear descended from accepted source', () => {
        const validate = gitValidator(), f = gitFixture();
        proofGit(f.root, ['checkout', '--orphan', 'unrelated']);
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'unrelated root']);
        fs.writeFileSync(path.join(f.root, '.git/info/grafts'),
            `${proofGit(f.root, ['rev-parse', 'HEAD'])} ${f.source.commitSha}\n`);
        assert.throws(() => validate(f.root, f.source), /graft|ancestry|parent/iu);
    });

    for (const type of ['commit', 'tree'] as const) it(`rejects replaced raw ${type} bytes and missing objects`, () => {
        const validate = gitValidator(), f = gitFixture();
        const sha = type === 'commit' ? f.source.commitSha : f.source.treeSha;
        const file = path.join(f.root, '.git/objects', sha.slice(0, 2), sha.slice(2));
        const original = fs.readFileSync(file), bytes = inflateSync(original);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        fs.chmodSync(file, 0o600);
        fs.writeFileSync(file, deflateSync(bytes));
        assert.throws(() => validate(f.root, f.source), /Git|object|identity/iu);
        fs.writeFileSync(file, original);
        fs.renameSync(file, file + '.held');
        assert.throws(() => validate(f.root, f.source));
        fs.renameSync(file + '.held', file);
        validate(f.root, f.source);
    });

    it('rejects incomplete or oversized raw batch frames', () => {
        const validate = gitValidator(), f = gitFixture();
        const api = require('node:child_process'), original = api.execFileSync;
        for (const output of [Buffer.from(`${f.source.commitSha} commit 8388609\n`),
            Buffer.from(`${f.source.commitSha} commit 5\nabc`)]) {
            const stub = mock.method(api, 'execFileSync', (...args: unknown[]) =>
                (args[1] as string[]).includes('--batch') ? output : Reflect.apply(original, api, args));
            assert.throws(() => validate(f.root, f.source), /bounded|object|frame/iu);
            stub.mock.restore();
        }
    });

    it('rejects an incomplete ancestry projection despite a successful ancestor probe', () => {
        const validate = gitValidator(), f = gitFixture();
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'later']);
        const api = require('node:child_process'), original = api.execFileSync;
        mock.method(api, 'execFileSync', (...args: unknown[]) =>
            (args[1] as string[]).includes('rev-list') ? '' : Reflect.apply(original, api, args));
        assert.throws(() => validate(f.root, f.source), /ancestry/iu);
    });

    it('rejects a late parent header that native Git does not treat as ancestry', () => {
        const validate = gitValidator(), f = gitFixture();
        const bytes = `tree ${f.source.treeSha}\nauthor Proof <proof@example.invalid> 1 +0000\n`
            + `committer Proof <proof@example.invalid> 1 +0000\nparent ${f.source.commitSha}\n\nlate parent\n`;
        const commitSha = proofGit(f.root, ['hash-object', '--literally', '-w', '-t', 'commit', '--stdin'], bytes);
        proofGit(f.root, ['update-ref', 'HEAD', commitSha]);
        assert.equal(proofGit(f.root, ['rev-list', '--parents', '-1', 'HEAD']), commitSha,
            'native Git must actually see a root rather than the late parent claim');
        assert.throws(() => validate(f.root, { ...f.source, commitSha, parentCommitSha: f.source.commitSha }), /parent|header/iu);
    });
});

function reader(): (repoRoot: string, artifactPath: string, expectedSha256: string) => Record<string, unknown> {
    let loaded: Record<string, unknown> = {};
    try { loaded = require(modulePath); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
    assert.equal(typeof loaded.readParentAuditProofRecord, 'function',
        'contained parent proof reader must exist before proof can be reconstructed');
    return loaded.readParentAuditProofRecord as ReturnType<typeof reader>;
}

function fixture(content = JSON.stringify({ task_id: 'T-PROOF-1', answer: 'Пример' })) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-parent-proof-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'proofs'));
    const file = path.join(root, 'proofs', 'record.json');
    const bytes = Buffer.from(content);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { root, file, bytes, sha256: digest(bytes) };
}

afterEach(() => {
    mock.restoreAll();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('contained parent-audit proof inputs', () => {
    it('reads the exact ordinary UTF-8 record without granting acceptance or changing its bytes', () => {
        const f = fixture();
        const result = reader()(f.root, f.file, f.sha256);
        assert.deepEqual(result, { task_id: 'T-PROOF-1', answer: 'Пример' });
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
        assert.equal('status' in result, false);
        assert.equal('local_commit_authentication' in result, false);
    });

    it('blocks missing proof, bad hash syntax and stale or forged bytes', () => {
        const f = fixture();
        const read = reader();
        assert.throws(() => read(f.root, f.file + '.missing', f.sha256));
        for (const hash of ['', 'public assertion', 'a'.repeat(63)]) {
            assert.throws(() => read(f.root, f.file, hash));
        }
        fs.writeFileSync(f.file, JSON.stringify({ task_id: 'T-FOREIGN' }));
        assert.throws(() => read(f.root, f.file, f.sha256));
    });

    it('blocks invalid JSON and non-record proof values even with their exact digest', () => {
        const read = reader();
        const malformed = fixture('{');
        assert.throws(() => read(malformed.root, malformed.file, malformed.sha256));
        for (const value of ['', 'null', '[]', '"claimed PASS"']) {
            const f = fixture(value);
            assert.throws(() => read(f.root, f.file, f.sha256));
        }
    });

    it('rejects an input above the fixed eight-MiB budget', () => {
        const read = reader(), f = fixture();
        const bytes = Buffer.from(JSON.stringify({ payload: 'a'.repeat(8 * 1024 * 1024) }));
        assert.equal(JSON.parse(bytes.toString('utf8')).payload.length, 8 * 1024 * 1024);
        fs.writeFileSync(f.file, bytes);
        assert.throws(() => read(f.root, f.file, digest(bytes)), /bounded ordinary file/u);
    });

    it('rejects malformed UTF-8 even when its raw byte digest matches', () => {
        const read = reader(), f = fixture();
        const bytes = Buffer.concat([Buffer.from('{"answer":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
        fs.writeFileSync(f.file, bytes);
        assert.throws(() => read(f.root, f.file, digest(bytes)));
    });

    it('rejects foreign traversal, outside-root inputs, symlink parents and linked files', () => {
        const read = reader(), f = fixture(), other = fixture();
        assert.throws(() => read(f.root, other.file, other.sha256));
        assert.throws(() => read(f.root, path.relative(f.root, other.file), other.sha256));
        const linked = path.join(f.root, 'proofs', 'linked.json');
        fs.linkSync(other.file, linked);
        assert.throws(() => read(f.root, linked, other.sha256));
        if (process.platform !== 'win32') {
            const parent = path.join(f.root, 'foreign');
            fs.symlinkSync(path.dirname(other.file), parent, 'dir');
            assert.throws(() => read(f.root, path.join(parent, 'record.json'), other.sha256));
        }
    });

    it('rejects stale identity from a same-byte ordinary replacement between binding and descriptor acquisition', () => {
        const read = reader(), f = fixture(), open = fs.openSync;
        let replaced = false;
        mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
            if (!replaced && String(args[0]) === f.file) {
                replaced = true;
                const next = f.file + '.replacement';
                fs.writeFileSync(next, f.bytes, { flag: 'wx' });
                fs.renameSync(next, f.file);
            }
            return open(...args);
        });
        assert.throws(() => read(f.root, f.file, f.sha256));
        assert.equal(replaced, true);
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    });

    it('rejects growth during the descriptor read and closes the proof descriptor', () => {
        const read = reader(), f = fixture();
        const open = fs.openSync, originalRead = fs.readSync, close = fs.closeSync;
        let descriptor = -1, grew = false, closed = false;
        mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
            const fd = open(...args);
            if (String(args[0]) === f.file && descriptor === -1) descriptor = fd;
            return fd;
        });
        mock.method(fs, 'readSync', (...args: unknown[]) => {
            const count = Reflect.apply(originalRead, fs, args) as number;
            if (args[0] === descriptor && !grew) {
                grew = true;
                fs.appendFileSync(f.file, ' ');
            }
            return count;
        });
        mock.method(fs, 'closeSync', (fd: number) => {
            if (fd === descriptor) closed = true;
            return close(fd);
        });
        assert.throws(() => read(f.root, f.file, f.sha256));
        assert.equal(grew, true);
        assert.equal(closed, true);
    });

    it('rejects final-file FIFO replacement without waiting for a writer', { skip: process.platform === 'win32' }, () => {
        reader();
        const f = fixture();
        const script = String.raw`
            const fs = require('node:fs'), assert = require('node:assert/strict');
            const { spawnSync } = require('node:child_process');
            const reader = require(process.argv[1]).readParentAuditProofRecord;
            const [root, file, hash] = process.argv.slice(2);
            const open = fs.openSync; let replaced = false;
            fs.openSync = (...args) => {
                if (!replaced && String(args[0]) === file) {
                    replaced = true; fs.renameSync(file, file + '.original');
                    const result = spawnSync('mkfifo', [file], { timeout: 1000 });
                    assert.equal(result.status, 0, 'isolated FIFO fixture must be created');
                }
                return open(...args);
            };
            assert.throws(() => reader(root, file, hash));
            assert.equal(replaced, true, 'the final file must actually be replaced before open');
            assert.equal(fs.lstatSync(file).isFIFO(), true);
            console.log('FIFO_REPLACEMENT_REJECTED');
        `;
        const result = spawnSync(process.execPath,
            ['-e', script, require.resolve(modulePath), f.root, f.file, f.sha256],
            { timeout: 3000, encoding: 'utf8' });
        assert.equal(result.error, undefined, 'proof acquisition must not hang on a writerless FIFO');
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /FIFO_REPLACEMENT_REJECTED/u);
        assert.deepEqual(fs.readFileSync(f.file + '.original'), f.bytes);
    });
});
