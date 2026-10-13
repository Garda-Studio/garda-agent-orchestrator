import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import fsNative from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { preserveDisputedLockDirectory } from '../../../src/gate-runtime/timeline/lock-recovery-preservation';
import { collectStaleLifecycleLock, collectStandardCandidates } from '../../../src/lifecycle/cleanup/cleanup-removal';
import { buildDefaultRetentionPolicy } from '../../../src/lifecycle/cleanup/cleanup-orchestration';

function fixture(t: TestContext) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-preserve-lock-')), project = path.join(parent, 'project'), runtime = path.join(project, 'garda-agent-orchestrator/runtime');
    const claimed = path.join(runtime, '.lifecycle-operation.lock.stale-disputed'), owner = path.join(claimed, 'owner.json');
    fs.mkdirSync(claimed, { recursive: true }); fs.writeFileSync(owner, 'disputed original bytes');
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    return { parent, project, runtime, claimed, owner };
}

function captureRetentionAssertion(capture: string) {
    const files = path.join(capture, 'files'), manifest = path.join(capture, 'manifest.json');
    const read = (file: string) => { const stat = fs.lstatSync(file, { bigint: true }); return [stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.uid, stat.gid, stat.isFile() ? fs.readFileSync(file) : null]; };
    const entries = [capture, files, ...fs.readdirSync(files).map(name => path.join(files, name)), ...(fs.existsSync(manifest) ? [manifest] : [])], snapshots = entries.map(read);
    return () => entries.forEach((file, index) => assert.deepEqual(read(file), snapshots[index], `Partial capture object retained: ${file}`));
}

test('rejects a symlink source without moving the claimed owner', t => {
    const { project, claimed, owner } = fixture(t);
    const alias = path.join(project, 'alias');
    fs.symlinkSync(claimed, alias, 'junction');
    assert.throws(() => preserveDisputedLockDirectory(project, alias), /symlink|junction/);
    assert.equal(fs.readFileSync(owner, 'utf8'), 'disputed original bytes');
});

test('rejects a replaced storage root without changing original bytes', { skip: typeof process.getuid !== 'function' }, t => {
    const { parent, project, claimed, owner } = fixture(t);
    fs.symlinkSync(project, path.join(parent, 'garda-recovery-preserved'), 'junction');
    assert.throws(() => preserveDisputedLockDirectory(project, claimed), /symlink|junction/);
    assert.equal(fs.readFileSync(owner, 'utf8'), 'disputed original bytes');
});

test('rejects a forged copy after manifest publication', { skip: typeof process.getuid !== 'function' }, t => {
    const { parent, project, claimed, owner } = fixture(t), write = fsNative.writeSync;
    let assertRetained: () => void = () => assert.fail('copy mutation was not injected');
    t.mock.method(fsNative, 'writeSync', ((descriptor: number, ...args: unknown[]) => {
        const count = (write as Function)(descriptor, ...args);
        if (String(args[0]).includes('DISPUTED_LOCK_COPY_NOT_RECOVERY_AUTHORITY')) {
            const storage = path.join(parent, 'garda-recovery-preserved/lock-claims'), capture = path.join(storage, fs.readdirSync(storage)[0]);
            fs.writeFileSync(path.join(capture, 'files/owner.json'), 'forged copied bytes'); assertRetained = captureRetentionAssertion(capture);
        }
        return count;
    }) as typeof fs.writeSync);
    assert.throws(() => preserveDisputedLockDirectory(project, claimed), /copy|bytes/); assertRetained();
    assert.equal(fs.readFileSync(owner, 'utf8'), 'disputed original bytes');
});

test('verified preservation retains original identity and stays outside cleanup candidates', { skip: typeof process.getuid !== 'function' }, t => {
    const { parent, project, runtime, claimed } = fixture(t);
    const original = fs.statSync(claimed, { bigint: true }), names = ['data.bin', 'empty', 'owner.json'];
    fs.writeFileSync(path.join(claimed, 'data.bin'), Buffer.from([0, 255, 10])); fs.writeFileSync(path.join(claimed, 'empty'), '');
    const members = names.map(name => ({ name, bytes: fs.readFileSync(path.join(claimed, name)), state: fs.statSync(path.join(claimed, name), { bigint: true }) }));
    const canonical = path.join(runtime, '.lifecycle-operation.lock');
    fs.mkdirSync(canonical); fs.writeFileSync(path.join(canonical, 'owner.json'), 'replacement owner');
    const result = preserveDisputedLockDirectory(project, claimed);
    assert.ok(result.capturePath.startsWith(path.join(parent, 'garda-recovery-preserved') + path.sep));
    assert.equal(fs.statSync(claimed, { bigint: true }).ino, original.ino);
    assert.equal(fs.readFileSync(path.join(canonical, 'owner.json'), 'utf8'), 'replacement owner');
    const manifest = JSON.parse(fs.readFileSync(path.join(result.capturePath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'DISPUTED_LOCK_COPY_NOT_RECOVERY_AUTHORITY');
    assert.equal(manifest.source.directory.ino, String(original.ino));
    assert.deepEqual(manifest.files.map((item: { name: string }) => item.name).sort(), names);
    assert.deepEqual(fs.readdirSync(path.join(result.capturePath, 'files')).sort(), names);
    for (const member of members) {
        const entry = manifest.files.find((item: { name: string }) => item.name === member.name), state = fs.statSync(path.join(claimed, member.name), { bigint: true });
        assert.ok(entry); assert.equal(entry.bytes, member.bytes.length); assert.equal(entry.sha256, crypto.createHash('sha256').update(member.bytes).digest('hex'));
        assert.deepEqual(fs.readFileSync(path.join(result.capturePath, 'files', member.name)), member.bytes); assert.deepEqual(fs.readFileSync(path.join(claimed, member.name)), member.bytes);
        assert.deepEqual([state.dev, state.ino, state.birthtimeNs], [member.state.dev, member.state.ino, member.state.birthtimeNs]);
    }
    const candidates = [...collectStaleLifecycleLock(runtime),
        ...collectStandardCandidates(runtime, buildDefaultRetentionPolicy(), new Date('2100-01-01'))];
    assert.ok(candidates.some(item => item.path === claimed));
    assert.ok(candidates.every(item => !result.capturePath.startsWith(item.path + path.sep)));
});

test('rejects replaced storage after owner checks without copying', { skip: typeof process.getuid !== 'function' }, t => {
    const { parent, project, claimed, owner } = fixture(t);
    const getuid = process.getuid!, namespace = path.join(parent, 'garda-recovery-preserved');
    let checks = 0;
    t.mock.method(process as NodeJS.Process & { getuid: () => number }, 'getuid', () => {
        if (++checks === 2) { fs.renameSync(namespace, namespace + '.original'); fs.mkdirSync(path.join(namespace, 'lock-claims'), { recursive: true, mode: 0o777 }); }
        return getuid();
    });
    assert.throws(() => preserveDisputedLockDirectory(project, claimed), /identity changed before mutation/);
    assert.equal(fs.readFileSync(owner, 'utf8'), 'disputed original bytes');
    assert.deepEqual(fs.readdirSync(path.join(namespace, 'lock-claims')), []);
});

for (const violation of ['hardlink', 'nested-directory', 'member-limit', 'byte-limit', 'cumulative-byte-limit', 'shared-namespace', 'shared-storage', 'foreign-namespace', 'foreign-storage', 'short-read', 'root-project', 'owner-identity-unavailable']) {
    test(`preservation rejects ${violation} without removing original bytes`, { skip: typeof process.getuid !== 'function' && /^(shared|foreign)-/.test(violation) }, t => {
        const { project, claimed, owner } = fixture(t);
        const incompleteRead = violation === 'short-read' ? t.mock.method(fsNative, 'readSync', () => 0) : null;
        if (violation === 'hardlink') fs.linkSync(owner, path.join(claimed, 'shared'));
        if (violation === 'nested-directory') fs.mkdirSync(path.join(claimed, 'nested'));
        if (violation === 'member-limit') for (let index = 0; index < 64; index++) fs.writeFileSync(path.join(claimed, `entry-${index}`), '');
        if (violation === 'byte-limit') fs.writeFileSync(path.join(claimed, 'oversized'), Buffer.alloc(1024 * 1024 + 1));
        if (violation === 'cumulative-byte-limit') for (const name of ['bulk-a', 'bulk-b']) fs.writeFileSync(path.join(claimed, name), Buffer.alloc(512 * 1024));
        if (/^(shared|foreign)-/.test(violation)) fs.mkdirSync(path.join(path.dirname(project), 'garda-recovery-preserved/lock-claims'), { recursive: true, mode: 0o700 });
        if (violation.startsWith('shared-')) fs.chmodSync(path.join(path.dirname(project), 'garda-recovery-preserved', violation === 'shared-storage' ? 'lock-claims' : ''), violation === 'shared-storage' ? 0o702 : 0o720);
        if (violation.startsWith('foreign-')) { const uid = process.getuid!(); let checks = 0; t.mock.method(process as NodeJS.Process & { getuid: () => number }, 'getuid', () => uid + Number(violation === 'foreign-namespace' || ++checks === 2)); }
        if (violation === 'root-project') t.mock.method(fsNative, 'mkdirSync', () => { throw new Error('unexpected storage creation'); });
        if (violation === 'owner-identity-unavailable' && typeof process.getuid === 'function') {
            const getuid = process.getuid; Object.defineProperty(process, 'getuid', { value: undefined });
            t.after(() => Object.defineProperty(process, 'getuid', { value: getuid }));
        }
        assert.throws(() => preserveDisputedLockDirectory(violation === 'root-project' ? path.parse(project).root : project, claimed), violation === 'root-project' ? /outside the project/ : /^(shared|foreign)-/.test(violation) ? /owner-managed/ : /preserv|ordinary|symlink|limit|linked|unsupported|EOF/i);
        incompleteRead?.mock.restore();
        assert.equal(fs.readFileSync(owner, 'utf8'), 'disputed original bytes');
        if (violation === 'owner-identity-unavailable') assert.ok(!fs.existsSync(path.join(path.dirname(project), 'garda-recovery-preserved')));
    });
}

for (const drift of ['source-bytes', 'source-identity', 'capture-parent', 'capture-bytes', 'post-manifest-source', 'post-manifest-copy', 'final-source', 'final-copy', 'final-manifest']) {
    test(`late ${drift} substitution never becomes a verified preservation`, { skip: typeof process.getuid !== 'function' }, t => {
        const { parent, project, claimed, owner } = fixture(t), originalClose = fsNative.closeSync, originalWrite = fsNative.writeSync;
        const last = path.join(claimed, 'zz-last'); fs.writeFileSync(last, 'last member');
        const lastIno = fs.statSync(last).ino;
        let sourceReads = 0, copyingDescriptor: number | undefined, capture = '', assertRetained: () => void = () => assert.fail('late mutation was not injected');
        const write = t.mock.method(fsNative, 'writeSync', ((descriptor: number, ...args: unknown[]) => {
            if (drift.startsWith('post-manifest') ? String(args[0]).includes('DISPUTED_LOCK_COPY_NOT_RECOVERY_AUTHORITY') : !drift.startsWith('final-')) copyingDescriptor = descriptor;
            return (originalWrite as Function)(descriptor, ...args);
        }) as typeof fs.writeSync);
        const close = t.mock.method(fsNative, 'closeSync', ((descriptor: number) => {
            const finalRead = drift.startsWith('final-') && fs.fstatSync(descriptor).ino === lastIno && ++sourceReads === 2;
            originalClose(descriptor);
            if (descriptor !== copyingDescriptor && !finalRead) return;
            write.mock.restore(); close.mock.restore();
            const storage = path.join(parent, 'garda-recovery-preserved/lock-claims');
            capture = path.join(storage, fs.readdirSync(storage)[0]);
            if (drift === 'source-bytes') fs.writeFileSync(owner, 'changed after copying');
            if (drift === 'source-identity') { fs.renameSync(claimed, claimed + '.original'); fs.mkdirSync(claimed); fs.writeFileSync(owner, 'replacement owner'); }
            if (drift === 'capture-parent') { fs.renameSync(capture, capture + '.original'); fs.mkdirSync(capture); fs.writeFileSync(path.join(capture, 'foreign'), 'new capture owner'); }
            if (drift === 'capture-bytes') fs.writeFileSync(path.join(capture, 'files/owner.json'), 'tampered copied bytes');
            if (['post-manifest-source', 'final-source'].includes(drift)) fs.writeFileSync(owner, 'late source mutation');
            if (['post-manifest-copy', 'final-copy'].includes(drift)) fs.writeFileSync(path.join(capture, 'files/owner.json'), 'late copy mutation');
            if (drift === 'final-manifest') fs.writeFileSync(path.join(capture, 'manifest.json'), 'late manifest mutation');
            assertRetained = captureRetentionAssertion(drift === 'capture-parent' ? capture + '.original' : capture);
        }) as typeof fs.closeSync);
        assert.throws(() => preserveDisputedLockDirectory(project, claimed), /preserv|identity|changed|copy/i);
        assert.ok(fs.existsSync(owner)); assertRetained();
        if (drift === 'source-identity') assert.equal(fs.readFileSync(owner, 'utf8'), 'replacement owner');
        if (drift === 'capture-parent') assert.equal(fs.readFileSync(path.join(capture, 'foreign'), 'utf8'), 'new capture owner');
    });
}
