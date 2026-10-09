import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    getUpdateSentinelPath,
    getUninstallSentinelPath,
    readUpdateSentinel,
    readUninstallSentinel,
    writeUpdateSentinel,
    writeUninstallSentinel,
    removeUpdateSentinel,
    removeUninstallSentinel
} from '../../../src/lifecycle/common';
import { runUpdate } from '../../../src/lifecycle/update';
import { runUninstall } from '../../../src/lifecycle/uninstall';
import { checkPartialState } from '../../../src/validators/doctor';

const roots: string[] = [];
const UNKNOWN_STATE = /lifecycle.*state.*unknown|unknown.*sentinel/i;

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sentinel-state-'));
    roots.push(root);
    const bundle = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    return { root, bundle };
}

const domains = [
    {
        name: 'update',
        invalidMetadata: ['{"phase":false}', '{"plannedSyncItems":"src"}', '{"plannedSyncItems":[1]}'],
        sentinelPath: (fixture: ReturnType<typeof createFixture>) => getUpdateSentinelPath(fixture.bundle),
        read: (fixture: ReturnType<typeof createFixture>) => readUpdateSentinel(fixture.bundle),
        write: (fixture: ReturnType<typeof createFixture>) => writeUpdateSentinel(fixture.bundle, { phase: 'lifecycle' }),
        remove: (fixture: ReturnType<typeof createFixture>) => removeUpdateSentinel(fixture.bundle)
    },
    {
        name: 'uninstall',
        invalidMetadata: ['{"operation":0}', '{"skipBackups":"true"}', '{"keepTaskFile":[]}'],
        sentinelPath: (fixture: ReturnType<typeof createFixture>) => getUninstallSentinelPath(fixture.root),
        read: (fixture: ReturnType<typeof createFixture>) => readUninstallSentinel(fixture.root),
        write: (fixture: ReturnType<typeof createFixture>) => writeUninstallSentinel(fixture.root, { operation: 'uninstall' }),
        remove: (fixture: ReturnType<typeof createFixture>) => removeUninstallSentinel(fixture.root)
    }
];

for (const domain of domains) {
    test(`${domain.name} distinguishes missing state from valid object metadata`, () => {
        const fixture = createFixture();
        assert.equal(domain.read(fixture), null);
        domain.remove(fixture);
        domain.write(fixture);
        assert.ok(domain.read(fixture));
        fs.writeFileSync(domain.sentinelPath(fixture), '{}');
        assert.deepEqual(domain.read(fixture), {});
        domain.write(fixture);
        domain.remove(fixture);
        assert.equal(domain.read(fixture), null);
    });

    for (const content of ['{broken json', 'null', '[]', 'false', '0', '"text"', '{"startedAt":42}', ...domain.invalidMetadata]) {
        test(`${domain.name} rejects corrupt/non-object ${content} without changing sentinel bytes`, () => {
            const fixture = createFixture();
            const sentinelPath = domain.sentinelPath(fixture);
            fs.writeFileSync(sentinelPath, content);
            assert.throws(() => domain.read(fixture), UNKNOWN_STATE);
            assert.equal(fs.readFileSync(sentinelPath, 'utf8'), content);
        });
    }

    test(`${domain.name} writer cannot replace unknown existing state`, () => {
        const fixture = createFixture();
        const sentinelPath = domain.sentinelPath(fixture);
        const original = '{partial unknown state';
        fs.writeFileSync(sentinelPath, original);
        assert.throws(() => domain.write(fixture), UNKNOWN_STATE);
        assert.equal(fs.readFileSync(sentinelPath, 'utf8'), original);
    });

    test(`${domain.name} removal cannot erase unknown existing state`, () => {
        const fixture = createFixture();
        const sentinelPath = domain.sentinelPath(fixture);
        fs.writeFileSync(sentinelPath, 'null');
        assert.throws(() => domain.remove(fixture), UNKNOWN_STATE);
        assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'null');
    });

    test(`${domain.name} non-file directory sentinel remains unknown and retained`, () => {
        const fixture = createFixture();
        const sentinelPath = domain.sentinelPath(fixture);
        fs.mkdirSync(sentinelPath);
        assert.throws(() => domain.read(fixture), /unknown|file|directory|regular/i);
        assert.ok(fs.lstatSync(sentinelPath).isDirectory());
        const diagnostics = checkPartialState(fixture.root);
        assert.equal(diagnostics.passed, false);
        assert.ok(diagnostics.violations.length > 0);
    });
}

test('regular sentinel read errors reject mutation and report unknown diagnostics', () => {
    const fixture = createFixture();
    const markers = domains.map(domain => domain.sentinelPath(fixture));
    for (const marker of markers) fs.writeFileSync(marker, '{}');
    assert.equal(fs.lstatSync(markers[0]).isFile(), true);
    const nativeFs: typeof fs = require('node:fs');
    const originalRead = nativeFs.readFileSync;
    const readMock = mock.method(nativeFs, 'readFileSync', (...args: unknown[]) => {
        if (markers.includes(String(args[0]))) {
            throw Object.assign(new Error('Injected regular-file read failure'), { code: 'EIO' });
        }
        return Reflect.apply(originalRead, nativeFs, args);
    });
    try {
        assert.throws(() => readUpdateSentinel(fixture.bundle), UNKNOWN_STATE);
        assert.throws(() => readUninstallSentinel(fixture.root), UNKNOWN_STATE);
        for (const domain of domains) {
            assert.throws(() => domain.write(fixture), UNKNOWN_STATE);
            assert.throws(() => domain.remove(fixture), UNKNOWN_STATE);
        }
        const result = checkPartialState(fixture.root);
        assert.equal(result.passed, false);
        assert.equal(result.update_sentinel_state, 'unknown');
        assert.equal(result.uninstall_sentinel_state, 'unknown');
        assert.equal(result.violations.length, 2);
    } finally {
        readMock.mock.restore();
    }
    for (const marker of markers) assert.equal(fs.readFileSync(marker, 'utf8'), '{}');
});

test('unreadable regular sentinel files reject mutation with real permission errors', {
    skip: process.platform === 'win32' || process.getuid?.() === 0
        ? 'POSIX non-root permission enforcement is required for this filesystem fixture' : false
}, () => {
    const fixture = createFixture();
    const markers = domains.map(domain => domain.sentinelPath(fixture));
    for (const marker of markers) fs.writeFileSync(marker, '{}');
    const modes = markers.map(marker => fs.statSync(marker).mode & 0o777);
    try {
        for (const marker of markers) fs.chmodSync(marker, 0o000);
        assert.equal(fs.lstatSync(markers[0]).isFile(), true);
        assert.throws(() => fs.readFileSync(markers[0]), { code: 'EACCES' });
        assert.throws(() => readUpdateSentinel(fixture.bundle), UNKNOWN_STATE);
        assert.throws(() => readUninstallSentinel(fixture.root), UNKNOWN_STATE);
        for (const domain of domains) {
            assert.throws(() => domain.write(fixture), UNKNOWN_STATE);
            assert.throws(() => domain.remove(fixture), UNKNOWN_STATE);
        }
        const result = checkPartialState(fixture.root);
        assert.equal(result.passed, false);
        assert.equal(result.update_sentinel_state, 'unknown');
        assert.equal(result.uninstall_sentinel_state, 'unknown');
        assert.equal(result.violations.length, 2);
    } finally {
        markers.forEach((marker, index) => fs.chmodSync(marker, modes[index]));
    }
    for (const marker of markers) assert.equal(fs.readFileSync(marker, 'utf8'), '{}');
});

test('doctor diagnoses both unknown sentinels without presenting a healthy missing state', () => {
    const fixture = createFixture();
    const updatePath = getUpdateSentinelPath(fixture.bundle);
    const uninstallPath = getUninstallSentinelPath(fixture.root);
    fs.writeFileSync(updatePath, '{broken update');
    fs.writeFileSync(uninstallPath, 'null');
    const result = checkPartialState(fixture.root);
    assert.equal(result.passed, false);
    assert.equal(result.violations.length, 2);
    assert.ok(result.violations.every(message => UNKNOWN_STATE.test(message)));
    const evidence = result as unknown as Record<string, unknown>;
    assert.equal(evidence.update_sentinel_state, 'unknown');
    assert.equal(evidence.uninstall_sentinel_state, 'unknown');
    assert.equal(fs.readFileSync(updatePath, 'utf8'), '{broken update');
    assert.equal(fs.readFileSync(uninstallPath, 'utf8'), 'null');
});

test('unknown sentinel diagnostics do not echo corrupt file contents', () => {
    const fixture = createFixture();
    const content = '{"dummy_sensitive_payload":"sentinel-test-value"';
    fs.writeFileSync(getUpdateSentinelPath(fixture.bundle), content);
    assert.throws(() => readUpdateSentinel(fixture.bundle), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, UNKNOWN_STATE);
        assert.doesNotMatch(error.message, /sentinel-test-value|dummy_sensitive_payload/);
        return true;
    });
    const diagnostics = checkPartialState(fixture.root);
    assert.equal(diagnostics.passed, false);
    assert.doesNotMatch(diagnostics.violations.join('\n'), /sentinel-test-value|dummy_sensitive_payload/);
});

test('direct update consumer rejects unknown sentinel before any install or target mutation', () => {
    const fixture = createFixture();
    const sentinelPath = getUpdateSentinelPath(fixture.bundle);
    fs.writeFileSync(sentinelPath, '{interrupted update');
    const targetPath = path.join(fixture.root, 'retained-user-file.txt');
    fs.writeFileSync(targetPath, 'original user bytes');
    let installed = false;
    assert.throws(() => runUpdate({
        targetRoot: fixture.root,
        bundleRoot: fixture.bundle,
        installRunner: () => { installed = true; }
    }), UNKNOWN_STATE);
    assert.equal(installed, false);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), '{interrupted update');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'original user bytes');
});

test('direct uninstall consumer rejects unknown sentinel and preserves the target', () => {
    const fixture = createFixture();
    const sentinelPath = getUninstallSentinelPath(fixture.root);
    fs.writeFileSync(sentinelPath, 'null');
    const targetPath = path.join(fixture.root, 'TASK.md');
    fs.writeFileSync(targetPath, 'original task input');
    assert.throws(() => runUninstall({
        targetRoot: fixture.root,
        bundleRoot: fixture.bundle,
        keepTaskFile: false
    }), UNKNOWN_STATE);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'null');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'original task input');
});
