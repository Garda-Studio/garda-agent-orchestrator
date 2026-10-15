const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [moduleRoot, fixtureRoot, domain, role, withCompetitor] = process.argv.slice(2);
const lockDomain = domain.split('-')[0];
if (!['timeline', 'timeline-async', 'lifecycle', 'lifecycle-async'].includes(domain) || !['restorer', 'publisher'].includes(role)) {
    throw new Error('Invalid isolated restoration worker role');
}
const native = require(path.join(moduleRoot, lockDomain === 'timeline'
    ? 'gate-runtime/timeline/task-events-locking-acquire.js'
    : 'lifecycle/lock/lifecycle-lock.js'));
const canonical = lockDomain === 'timeline' ? path.join(fixtureRoot, 'timeline.lock') : native.getLifecycleOperationLockPath(fixtureRoot);
const ownerPath = path.join(canonical, 'owner.json');
const original = {
    exists: fs.existsSync, rename: fs.renameSync, write: fs.writeFileSync,
    read: fs.readFileSync, stat: fs.statSync
};
const pause = new Int32Array(new SharedArrayBuffer(4));
const identity = name => {
    const stat = original.stat(name, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
        birthtimeNs: String(stat.birthtimeNs), uid: String(stat.uid), gid: String(stat.gid) };
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const send = event => fs.writeSync(1, JSON.stringify({ ...event, pid: process.pid }) + '\n');
const wait = name => {
    const deadline = Date.now() + 15000;
    while (!original.exists(path.join(fixtureRoot, name))) {
        if (Date.now() >= deadline) throw new Error('Native fixture barrier timed out: ' + name);
        Atomics.wait(pause, 0, 0, 5);
    }
};
const options = { heartbeatIntervalMs: 0, ...(withCompetitor === 'yes' ? { projectRoot: fixtureRoot } : {}) };

async function withNativeOwner(callback) {
    if (lockDomain === 'lifecycle') return domain.endsWith('-async')
        ? native.withLifecycleOperationLockAsync(fixtureRoot, role, async () => callback(), options)
        : native.withLifecycleOperationLock(fixtureRoot, role, callback, options);
    const { handle } = await (domain.endsWith('-async') ? native.acquireFilesystemLockAsync(canonical, options) : native.acquireFilesystemLock(canonical, options));
    try { return await callback(); } finally { native.releaseFilesystemLock(handle); }
}

(async function run() {
if (role === 'publisher') {
    fs.writeFileSync = function pauseNativePublication(name, ...args) {
        if (path.resolve(String(name)) === path.resolve(ownerPath)) {
            const metadata = JSON.parse(String(args[0]));
            send({ kind: 'admitted', identity: identity(canonical), empty: fs.readdirSync(canonical).length === 0, ownerPid: metadata.pid });
            wait('publish-owner');
        }
        return original.write(name, ...args);
    };
    await withNativeOwner(() => {
        const metadata = JSON.parse(original.read(ownerPath, 'utf8'));
        send({ kind: 'published', identity: identity(canonical), ownerPid: metadata.pid, ownerLockId: metadata.lock_id });
        wait('finish-publisher');
    });
    send({ kind: 'cleaned', canonicalExists: original.exists(canonical) });
} else {
    let claimed = null;
    let claimedIdentity = null;
    let claimedHash = null;
    fs.renameSync = function triggerMismatchedClaim(source, destination) {
        const result = original.rename(source, destination);
        const releasePrefix = canonical + (lockDomain === 'timeline' ? '.releasing-' : '.releasing.');
        if (path.resolve(String(source)) === path.resolve(canonical) && path.resolve(String(destination)).startsWith(path.resolve(releasePrefix))) {
            claimed = String(destination);
            const claimedOwnerPath = path.join(claimed, 'owner.json');
            const metadata = JSON.parse(original.read(claimedOwnerPath, 'utf8'));
            // This controlled mismatch selects the genuine native restoration branch.
            // The competing directory is separately created by a live native acquirer.
            metadata.lock_id = 'fixture-mismatch-' + metadata.lock_id;
            original.write(claimedOwnerPath, JSON.stringify(metadata) + '\n', 'utf8');
            claimedIdentity = identity(claimed);
            claimedHash = hash(original.read(claimedOwnerPath));
            if (withCompetitor === 'yes') {
                send({ kind: 'window', claimed, claimedIdentity, claimedHash, canonicalWasAbsent: !original.exists(canonical) });
                wait('replacement-admitted');
            }
        }
        return result;
    };
    let failure = null;
    try { await withNativeOwner(() => {}); } catch (error) { failure = String(error.message); }
    let queueReusable = null;
    if (domain === 'lifecycle-async' && withCompetitor === 'no') {
        fs.renameSync = original.rename;
        try { await withNativeOwner(() => {}); queueReusable = true; } catch { queueReusable = false; }
    }
    const storage = path.join(path.dirname(fixtureRoot), 'garda-recovery-preserved', 'lock-claims');
    const captures = original.exists(storage) ? fs.readdirSync(storage) : [];
    const capture = captures.length === 1 ? path.join(storage, captures[0]) : null;
    const manifest = capture ? JSON.parse(original.read(path.join(capture, 'manifest.json'), 'utf8')) : null;
    const canonicalExists = original.exists(canonical);
    const claimedExists = claimed !== null && original.exists(claimed);
    send({
        kind: 'restored', failure, claimed, claimedIdentity, claimedHash, queueReusable,
        copyHash: capture ? hash(original.read(path.join(capture, 'files', 'owner.json'))) : null,
        copySourceIdentity: manifest?.source.directory, copyKind: manifest?.kind,
        canonicalIdentity: canonicalExists ? identity(canonical) : null,
        claimedIdentityAfter: claimedExists ? identity(claimed) : null,
        claimedHashAfter: claimedExists ? hash(original.read(path.join(claimed, 'owner.json'))) : null
    });
    wait('finish-restorer');
}
})().catch(error => { console.error(error); process.exitCode = 1; });
