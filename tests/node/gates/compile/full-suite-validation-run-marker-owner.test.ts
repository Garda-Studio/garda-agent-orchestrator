import { afterEach, beforeEach, mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateTestRunnerEnvironment } from '../../process-environment-fixtures';
import { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
import { getCurrentWorkflowConfigFileHashes } from '../../../../src/gates/workflow-config/workflow-config-work';
import { runCliWithCapturedOutput, writeCompilePassEvidence } from '../../cli/commands/gate-test-helpers';
import {
    clearFullSuiteValidationRunMarker as clear,
    updateFullSuiteValidationRunMarkerChildProcess as update,
    writeFullSuiteValidationRunMarker as write,
    resolveFullSuiteValidationRunMarkerPath as markerPath
} from '../../../../src/gates/full-suite/full-suite-validation-run-marker';

const roots: string[] = [];
const REJECTED = /run.marker.*(owner|occupied|changed)|EEXIST/iu;
beforeEach((context) => (context as TestContext).after(isolateTestRunnerEnvironment()));
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-run-marker-owner-'));
    roots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews'), { recursive: true });
    const taskId = 'T-OWNER', file = markerPath(repoRoot, taskId);
    const cycleBinding = { task_id: taskId, preflight_path: path.join(repoRoot, 'preflight.json'),
        preflight_sha256: 'a'.repeat(64), compile_gate_timestamp: null, scope_binding: null };
    const options = { repoRoot, taskId, command: 'fixture command', cwd: repoRoot, timeoutMs: 1000, cycleBinding };
    const child = { pid: process.pid, command: 'fixture child', args: ['one', 'two'], shell: false };
    return { repoRoot, taskId, file, options, child,
        update: (owner: unknown) => Reflect.apply(update, undefined, [repoRoot, taskId, child, owner]),
        clear: (owner: unknown) => Reflect.apply(clear, undefined, [repoRoot, taskId, owner]) };
}

test('foreign competing process is rejected without overwriting a live run marker', () => {
    const value = fixture(), owner = write(value.options), original = fs.readFileSync(value.file, 'utf8');
    try {
        const result = spawnSync(process.execPath, ['-e', `
            const api=require(process.argv[1]), options=JSON.parse(process.argv[2]);
            try { api.writeFullSuiteValidationRunMarker(options); process.exitCode=42; }
            catch(error) { if(!/run.marker.*occupied|EEXIST/i.test(error.message)) throw error; }
        `, require.resolve('../../../../src/gates/full-suite/full-suite-validation-run-marker'),
        JSON.stringify(value.options)], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(value.file, 'utf8'), original);
    } finally { value.clear(owner); }
});

test('stale and malformed records remain occupied until explicit recovery', () => {
    const value = fixture(); fs.mkdirSync(path.dirname(value.file), { recursive: true });
    const records = ['{broken', '{"gate_pid":2147483647}', '{}'], retained: string[] = [];
    for (const content of records) {
        fs.writeFileSync(value.file, content);
        assert.throws(() => write(value.options), REJECTED);
        retained.push(fs.readFileSync(value.file, 'utf8'));
    }
    assert.deepEqual(retained, records);
});

test('forged or missing owner handles are rejected; issued owner updates and clears its marker', () => {
    const value = fixture(), owner = write(value.options);
    try {
        for (const foreign of [undefined, JSON.parse(JSON.stringify(owner))]) {
            const original = fs.readFileSync(value.file, 'utf8');
            assert.throws(() => value.update(foreign), REJECTED);
            assert.throws(() => value.clear(foreign), REJECTED);
            assert.equal(fs.readFileSync(value.file, 'utf8'), original);
        }
        value.update(owner);
        const current = JSON.parse(fs.readFileSync(value.file, 'utf8'));
        assert.deepEqual([current.child_pid, current.child_command, current.child_args, current.child_shell],
            [value.child.pid, value.child.command, value.child.args, value.child.shell]);
    } finally { value.clear(owner); }
    assert.equal(fs.existsSync(value.file), false);
});

test('stale owner cannot mutate or clear a later run marker', () => {
    const value = fixture(), old = write(value.options); value.clear(old);
    const current = write(value.options), original = fs.readFileSync(value.file, 'utf8');
    try {
        assert.throws(() => value.update(old), REJECTED);
        assert.throws(() => value.clear(old), REJECTED);
        assert.equal(fs.readFileSync(value.file, 'utf8'), original);
    } finally { value.clear(current); }
});

test('replay of pre-update bytes cannot authorize the current issued owner', () => {
    const value = fixture(), owner = write(value.options), original = fs.readFileSync(value.file, 'utf8');
    value.update(owner); fs.writeFileSync(value.file, original);
    assert.throws(() => value.update(owner), REJECTED);
    assert.throws(() => value.clear(owner), REJECTED);
    assert.equal(fs.readFileSync(value.file, 'utf8'), original);
});

test('replaced marker objects, content and parents reject mutation and remain intact', () => {
    const expected: string[] = [], retained: string[] = [];
    for (const drift of ['same-bytes-object', 'content', 'parent']) {
        const value = fixture(), owner = write(value.options), original = fs.readFileSync(value.file, 'utf8');
        if (drift === 'same-bytes-object') fs.renameSync(value.file, value.file + '.original');
        if (drift === 'parent') {
            fs.renameSync(path.dirname(value.file), path.dirname(value.file) + '.original');
            fs.mkdirSync(path.dirname(value.file));
        }
        const replacement = drift === 'content' ? original.replace('fixture command', 'foreign command') : original;
        fs.writeFileSync(value.file, replacement);
        assert.throws(() => value.update(owner), REJECTED);
        assert.throws(() => value.clear(owner), REJECTED);
        retained.push(fs.readFileSync(value.file, 'utf8')); expected.push(replacement);
    }
    assert.deepEqual(retained, expected);
});

test('atomic child update leaves complete original JSON on publication failure and can retry', () => {
    const value = fixture(), owner = write(value.options), original = fs.readFileSync(value.file, 'utf8');
    const nativeFs: typeof fs = require('node:fs'), originalRename = nativeFs.renameSync;
    let publicationSeen = false;
    const renameMock = mock.method(nativeFs, 'renameSync', (...args: unknown[]) => {
        if (String(args[1]) === value.file) {
            publicationSeen = true;
            assert.equal(fs.readFileSync(value.file, 'utf8'), original);
            assert.equal(JSON.parse(fs.readFileSync(String(args[0]), 'utf8')).child_pid, value.child.pid);
            throw Object.assign(new Error('Injected publication failure'), { code: 'EIO' });
        }
        return Reflect.apply(originalRename, nativeFs, args);
    });
    try { assert.throws(() => value.update(owner), /publication failure/u); }
    finally { renameMock.mock.restore(); }
    try {
        assert.equal(publicationSeen, true);
        assert.equal(fs.readFileSync(value.file, 'utf8'), original);
        value.update(owner);
        assert.equal(JSON.parse(fs.readFileSync(value.file, 'utf8')).child_pid, value.child.pid);
        assert.deepEqual(fs.readdirSync(path.dirname(value.file)), [path.basename(value.file)]);
    } finally { value.clear(owner); }
});

test('marker publication and parent replacement never retain marker descriptors between operations', () => {
    const value = fixture(), nativeFs: typeof fs = require('node:fs');
    const held = new Map<number, string>();
    const originalOpen = nativeFs.openSync, originalClose = nativeFs.closeSync, originalRename = nativeFs.renameSync;
    const openMock = mock.method(nativeFs, 'openSync', (...args: unknown[]) => {
        const fd = Reflect.apply(originalOpen, nativeFs, args), file = String(args[0]);
        if (file === value.file || file.startsWith(`${value.file}.owner-`)) held.set(fd, file);
        return fd;
    });
    const closeMock = mock.method(nativeFs, 'closeSync', (fd: number) => {
        originalClose(fd); held.delete(fd);
    });
    // A descriptor-lifetime fault injection, not a Windows acceptance claim.
    const renameMock = mock.method(nativeFs, 'renameSync', (...args: unknown[]) => {
        if ((String(args[1]) === value.file || String(args[0]) === path.dirname(value.file)) && held.size) {
            throw Object.assign(new Error('EPERM: marker descriptor remains open during rename'), { code: 'EPERM' });
        }
        return Reflect.apply(originalRename, nativeFs, args);
    });
    let owner: ReturnType<typeof write> | undefined;
    try {
        owner = write(value.options);
        value.update(owner);
        assert.equal(held.size, 0, 'No persistent marker descriptor after an update');
        const content = fs.readFileSync(value.file, 'utf8'), originalParent = path.dirname(value.file) + '.original';
        fs.renameSync(path.dirname(value.file), originalParent);
        fs.mkdirSync(path.dirname(value.file)); fs.writeFileSync(value.file, content);
        assert.throws(() => value.update(owner), REJECTED);
        assert.throws(() => value.clear(owner), REJECTED);
        assert.equal(fs.readFileSync(value.file, 'utf8'), content);
        assert.equal(fs.readFileSync(path.join(originalParent, path.basename(value.file)), 'utf8'), content);
        assert.equal(held.size, 0, 'Rejected parent replacement closes every probe descriptor');
        owner = undefined;
    } finally {
        if (owner) value.clear(owner);
        renameMock.mock.restore(); closeMock.mock.restore(); openMock.mock.restore();
    }
    assert.equal(held.size, 0);
});

test('generation and content drift while closing a read probe rejects mutation and preserves replacement', () => {
    const nativeFs: typeof fs = require('node:fs'), originalOpen = nativeFs.openSync, originalClose = nativeFs.closeSync;
    const expected: string[] = [], preserved: string[] = [];
    for (const drift of ['generation', 'content']) {
        const value = fixture(), owner = write(value.options), content = fs.readFileSync(value.file, 'utf8');
        const replacement = drift === 'content' ? content.replace('fixture command', 'foreign command') : content;
        let probe: number | undefined, replaced = false;
        const openMock = mock.method(nativeFs, 'openSync', (...args: unknown[]) => {
            const fd = Reflect.apply(originalOpen, nativeFs, args);
            if (String(args[0]) === value.file && typeof args[1] === 'number') probe = fd;
            return fd;
        });
        const closeMock = mock.method(nativeFs, 'closeSync', (fd: number) => {
            originalClose(fd);
            if (fd !== probe || replaced) return;
            replaced = true;
            if (drift === 'generation') fs.renameSync(value.file, value.file + '.original');
            fs.writeFileSync(value.file, replacement);
        });
        try { assert.throws(() => value.update(owner), REJECTED); }
        finally { closeMock.mock.restore(); openMock.mock.restore(); }
        assert.equal(replaced, true, 'The read descriptor was genuinely closed before mutation');
        assert.equal(fs.readFileSync(value.file, 'utf8'), replacement);
        assert.throws(() => value.clear(owner), REJECTED);
        assert.equal(fs.readFileSync(value.file, 'utf8'), replacement);
        expected.push(replacement); preserved.push(fs.readFileSync(value.file, 'utf8'));
    }
    assert.deepEqual(preserved, expected);
});

test('failed initial publication preserves a substituted object and does not issue an owner', () => {
    const value = fixture(), nativeFs: typeof fs = require('node:fs');
    const originalOpen = nativeFs.openSync, originalWrite = nativeFs.writeFileSync;
    let held: number | undefined;
    const openMock = mock.method(nativeFs, 'openSync', (...args: unknown[]) => {
        const fd = Reflect.apply(originalOpen, nativeFs, args);
        if (String(args[0]) === value.file && String(args[1]).startsWith('wx')) held = fd;
        return fd;
    });
    const writeMock = mock.method(nativeFs, 'writeFileSync', (...args: unknown[]) => {
        if (held !== undefined && args[0] === held) {
            fs.renameSync(value.file, value.file + '.original'); originalWrite(value.file, 'replacement');
            throw new Error('Injected initial publication failure');
        }
        return Reflect.apply(originalWrite, nativeFs, args);
    });
    try {
        assert.throws(() => write(value.options), /initial publication failure/u);
        assert.equal(fs.readFileSync(value.file, 'utf8'), 'replacement');
    } finally { writeMock.mock.restore(); openMock.mock.restore(); }
});

test('symlink and hardlink marker destinations and unknown held-file reads are rejected without mutation', () => {
    const value = fixture(), target = path.join(value.repoRoot, 'foreign');
    fs.mkdirSync(path.dirname(value.file), { recursive: true }); fs.writeFileSync(target, 'foreign');
    for (const link of ['symlink', 'hardlink']) {
        if (link === 'symlink') fs.symlinkSync(target, value.file); else fs.linkSync(target, value.file);
        assert.throws(() => write(value.options), /symlink|hard.linked|occupied/iu);
        assert.equal(fs.readFileSync(target, 'utf8'), 'foreign'); fs.unlinkSync(value.file);
    }
    const owner = write(value.options), original = fs.readFileSync(value.file, 'utf8');
    const nativeFs: typeof fs = require('node:fs');
    const readMock = mock.method(nativeFs, 'readSync', () => { throw new Error('Injected held-file EIO'); });
    try { assert.throws(() => value.update(owner), /held-file EIO/u); }
    finally { readMock.mock.restore(); }
    assert.equal(fs.readFileSync(value.file, 'utf8'), original); value.clear(owner);
});

test('failed CLI admission preserves another run and never starts the command', async () => {
    const value = fixture(), reviews = path.dirname(value.file);
    const configDir = path.join(value.repoRoot, 'garda-agent-orchestrator/live/config');
    fs.mkdirSync(configDir, { recursive: true }); fs.mkdirSync(reviews, { recursive: true });
    const script = path.join(value.repoRoot, 'command.js'), ran = path.join(value.repoRoot, 'ran');
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(ran)},'ran');`);
    fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({ full_suite_validation: {
        enabled: true, command: `"${process.execPath}" "${script}"`, timeout_ms: 30000,
        placement: 'after_compile_before_reviews'
    } }));
    const preflightPath = path.join(reviews, `${value.taskId}-preflight.json`);
    fs.writeFileSync(preflightPath, JSON.stringify({ task_id: value.taskId, changed_files: ['src/changed.ts'] }));
    fs.writeFileSync(path.join(reviews, `${value.taskId}-task-mode.json`), JSON.stringify(buildTaskModeArtifact({
        taskId: value.taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, effectiveDepth: 2,
        taskSummary: 'Isolated marker admission fixture', startBanner: 'Garda captures my mind', provider: 'Codex',
        canonicalSourceOfTruth: 'Codex', executionProviderSource: 'explicit_provider', runtimeIdentityStatus: 'resolved',
        workflowConfigFileHashes: getCurrentWorkflowConfigFileHashes(value.repoRoot)
    })));
    writeCompilePassEvidence(value.repoRoot, value.taskId, preflightPath);
    const owner = write(value.options), original = fs.readFileSync(value.file, 'utf8');
    try {
        const result = await runCliWithCapturedOutput(['gate', 'full-suite-validation', '--task-id', value.taskId,
            '--preflight-path', preflightPath, '--repo-root', value.repoRoot], { cwd: process.cwd() });
        assert.notEqual(result.exitCode, 0);
        assert.match(result.errors.concat(result.logs).join('\n'), /run.marker.*occupied/iu);
        assert.equal(fs.readFileSync(value.file, 'utf8'), original); assert.equal(fs.existsSync(ran), false);
    } finally { value.clear(owner); }
});
