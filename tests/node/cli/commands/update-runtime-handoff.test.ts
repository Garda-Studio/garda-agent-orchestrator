import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { buildUpdateLifecycleRunner, markRuntimeRestartRequired } from '../../../../src/cli/commands/shared-command-utils';
import { isPathInsideRoot } from '../../../../src/core/paths';
import { runCliRuntimeMain } from '../../../../src/cli/runtime-main';
import { getLifecycleOperationLockPath, withLifecycleOperationLock } from '../../../../src/lifecycle/lock/lifecycle-lock';
import { captureLifecycleLockHandoff } from '../../../../src/lifecycle/lock/lifecycle-lock-handoff';

function buildLockedLifecycleRunner(...args: Parameters<typeof buildUpdateLifecycleRunner>) {
    const run = buildUpdateLifecycleRunner(...args);
    return (options: Parameters<typeof run>[0]) => withLifecycleOperationLock(options.targetRoot, 'update', () => run(options));
}

function validateHandoffInChild(targetRoot: string, handoff: unknown, applyUpdate = false) {
    const source = [
        "const fs = require('node:fs');",
        "const request = JSON.parse(fs.readFileSync(0, 'utf8'));",
        'try {',
        applyUpdate
            ? `require(${JSON.stringify(require.resolve('../../../../src/lifecycle/update'))}).runUpdate({ targetRoot: request.targetRoot, bundleRoot: request.targetRoot + '/garda-agent-orchestrator', lifecycleLockHandoff: request.handoff });`
            : `require(${JSON.stringify(require.resolve('../../../../src/lifecycle/lock/lifecycle-lock-handoff'))}).assertLifecycleLockHandoff(request.targetRoot, request.handoff);`,
        "process.stdout.write('accepted');",
        "} catch (error) { process.stderr.write(error.message); process.exitCode = 1; }"
    ].join('\n');
    return spawnSync(process.execPath, ['-e', source], {
        input: JSON.stringify({ targetRoot, handoff }), encoding: 'utf8', windowsHide: true
    });
}

function makeBundle() {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-handoff-'));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const entryPath = path.join(bundleRoot, 'dist', 'src', 'cli', 'commands', 'update-runtime-handoff.js');
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    return { targetRoot, bundleRoot, entryPath };
}

function writeHandoff(entryPath: string, marker: string): void {
    fs.writeFileSync(entryPath, [
        "const fs = require('node:fs');",
        "const request = JSON.parse(fs.readFileSync(0, 'utf8'));",
        `fs.writeSync(3, JSON.stringify({ result: { previousVersion: ${JSON.stringify(marker)}, updatedVersion: request.runnerOptions.sourceReference } }));`
    ].join('\n'));
}

function writeWorkerHandoff(entryPath: string, workerPath: string, esm: boolean): void {
    const workerTarget = esm
        ? `new URL(${JSON.stringify(pathToFileURL(workerPath).href)})`
        : JSON.stringify(workerPath);
    fs.writeFileSync(entryPath, [
        "const fs = require('node:fs');",
        "const { Worker } = require('node:worker_threads');",
        `const worker = new Worker(${workerTarget}${esm ? ", { type: 'module' }" : ''});`,
        "worker.on('message', (value) => fs.writeSync(3, JSON.stringify({ result: { previousVersion: value } })));",
        "worker.on('error', (error) => { fs.writeSync(3, JSON.stringify({ error: error.message })); process.exitCode = 1; });"
    ].join('\n'));
}

function runnerOptions(targetRoot: string) {
    return {
        targetRoot,
        initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
        noPrompt: true,
        skipVerify: false,
        skipManifestValidation: false,
        trustPolicy: 'enforced',
        trustOverrideUsed: false,
        trustOverrideSource: 'none',
        sourceType: 'path',
        sourceReference: 'trusted-source'
    };
}

describe('updated bundle lifecycle handoff', () => {
    it('requires a real current-process update lock before spawning the bundle', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            writeHandoff(entryPath, 'must-not-run');
            assert.throws(() => buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /lock|owner|ENOENT/i);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('transports the exact parent lock generation even when the legacy boolean is absent', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            fs.writeFileSync(entryPath, [
                "const fs = require('node:fs');",
                "const request = JSON.parse(fs.readFileSync(0, 'utf8'));",
                "fs.writeSync(3, JSON.stringify({ result: { handoff: request.lifecycleLockHandoff, parent: process.ppid } }));"
            ].join('\n'));
            withLifecycleOperationLock(targetRoot, 'update', () => {
                const expected = captureLifecycleLockHandoff(targetRoot);
                const result = buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot));
                assert.equal(result.parent, process.pid);
                assert.deepEqual(result.handoff, expected);
            });
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('runs the fixed bundle entry in a fresh process on each invocation without mutating module cache', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const unrelatedPath = path.join(bundleRoot, 'dist', 'src', 'unrelated.js');
            fs.writeFileSync(unrelatedPath, "module.exports = { stale: true };\n");
            require(unrelatedPath);
            const cached = require.cache[require.resolve(unrelatedPath)];
            writeHandoff(entryPath, 'v1');
            const run = buildLockedLifecycleRunner(bundleRoot, false);
            assert.equal(run(runnerOptions(targetRoot)).previousVersion, 'v1');
            writeHandoff(entryPath, 'v2');
            assert.equal(run(runnerOptions(targetRoot)).previousVersion, 'v2');
            assert.equal(require.cache[require.resolve(unrelatedPath)], cached);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('fails closed when the fixed bundle entry is missing or reports failure', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const run = buildLockedLifecycleRunner(bundleRoot, false);
            assert.throws(() => run(runnerOptions(targetRoot)), /handoff|entry/i);
            fs.writeFileSync(entryPath, "require('node:fs').writeSync(3, JSON.stringify({ error: 'lifecycle failed' })); process.exit(1);\n");
            assert.throws(() => run(runnerOptions(targetRoot)), /lifecycle failed/);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects a bundle entry that resolves outside the bundle', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const outsidePath = path.join(targetRoot, 'outside.js');
            fs.writeFileSync(outsidePath, "require('node:fs').writeSync(3, '{}');\n");
            if (process.platform === 'win32') {
                const outsideCommands = path.join(targetRoot, 'outside-commands');
                fs.mkdirSync(outsideCommands);
                fs.copyFileSync(outsidePath, path.join(outsideCommands, path.basename(entryPath)));
                fs.rmdirSync(path.dirname(entryPath));
                fs.symlinkSync(outsideCommands, path.dirname(entryPath), 'junction');
            } else {
                fs.symlinkSync(outsidePath, entryPath, 'file');
            }
            assert.throws(() => buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /contain|link|bundle/i);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects a linked transitive module even when the fixed entry itself is contained', (context) => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            writeHandoff(entryPath, 'safe-entry');
            const outsideDir = path.join(targetRoot, 'outside');
            fs.mkdirSync(outsideDir);
            fs.writeFileSync(path.join(outsideDir, 'outside.js'), 'module.exports = {};\n');
            try {
                fs.symlinkSync(outsideDir, path.join(bundleRoot, 'dist', 'src', 'escaped'),
                    process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
                    context.skip('Windows junction creation is unavailable.');
                    return;
                }
                throw error;
            }
            assert.throws(() => buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /contain|link|bundle/i);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects a dependency resolved from an ancestor node_modules directory', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const dependencyPath = path.join(targetRoot, 'node_modules', 'outside-runtime');
            const markerPath = path.join(targetRoot, 'outside-loaded');
            fs.mkdirSync(dependencyPath, { recursive: true });
            fs.writeFileSync(path.join(dependencyPath, 'index.js'),
                `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'escaped'); module.exports = {};\n`);
            fs.writeFileSync(entryPath,
                "require('outside-runtime'); require('node:fs').writeSync(3, JSON.stringify({ result: { previousVersion: 'escaped' } }));\n");
            assert.throws(() => buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /handoff/i);
            assert.equal(fs.existsSync(markerPath), false);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('drops inherited Node injection settings before starting the updated bundle', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        const keys = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'GARDA_UPDATE_HANDOFF_INTERNAL_LOADER'];
        const previous = new Map(keys.map((key) => [key, process.env[key]]));
        try {
            const markerPath = path.join(targetRoot, 'injected-marker');
            const preloadPath = path.join(targetRoot, 'preload.js');
            fs.writeFileSync(preloadPath, `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'injected');\n`);
            fs.writeFileSync(entryPath, [
                "const fs = require('node:fs');",
                "fs.writeSync(3, JSON.stringify({ result: {",
                "    previousVersion: process.env.NODE_OPTIONS || null,",
                "    nodePath: process.env.NODE_PATH || null,",
                "    replModule: process.env.NODE_REPL_EXTERNAL_MODULE || null,",
                "    internalLoader: process.env.GARDA_UPDATE_HANDOFF_INTERNAL_LOADER || null",
                "} }));"
            ].join('\n'));
            process.env.NODE_OPTIONS = `--require=${preloadPath}`;
            process.env.NODE_PATH = targetRoot;
            process.env.NODE_REPL_EXTERNAL_MODULE = preloadPath;
            process.env.GARDA_UPDATE_HANDOFF_INTERNAL_LOADER = '1';
            const result = buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot));
            assert.equal(result.previousVersion, null);
            assert.equal(result.nodePath, null);
            assert.equal(result.replModule, null);
            assert.equal(result.internalLoader, null);
            assert.equal(fs.existsSync(markerPath), false);
        } finally {
            for (const key of keys) {
                const value = previous.get(key);
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('loads a relative dependency within the contained runtime', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            fs.writeFileSync(path.join(path.dirname(entryPath), 'inside.js'), "module.exports = 'contained';\n");
            fs.writeFileSync(entryPath, "require('node:fs').writeSync(3, JSON.stringify({ result: { previousVersion: require('./inside') } }));\n");
            assert.equal(buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)).previousVersion, 'contained');
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects a native ESM import outside the contained runtime', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const outsidePath = path.join(targetRoot, 'outside.mjs');
            fs.writeFileSync(outsidePath, "export default 'outside';\n");
            fs.writeFileSync(entryPath, [
                "const fs = require('node:fs');",
                `import(${JSON.stringify(pathToFileURL(outsidePath).href)})`,
                "    .then(() => fs.writeSync(3, JSON.stringify({ result: { previousVersion: 'escaped' } })))",
                "    .catch((error) => { fs.writeSync(3, JSON.stringify({ error: error.message })); process.exitCode = 1; });"
            ].join('\n'));
            assert.throws(() => buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /contained runtime/);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('loads a native ESM module inside the contained runtime', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            fs.writeFileSync(path.join(path.dirname(entryPath), 'inside.mjs'), "export default 'contained-esm';\n");
            fs.writeFileSync(entryPath, [
                "const fs = require('node:fs');",
                "import('./inside.mjs').then(({ default: value }) => fs.writeSync(3, JSON.stringify({ result: { previousVersion: value } })));"
            ].join('\n'));
            assert.equal(buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)).previousVersion, 'contained-esm');
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects a CommonJS worker entry outside the contained runtime', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const markerPath = path.join(targetRoot, 'escaped-marker');
            const workerPath = path.join(targetRoot, 'outside-worker.js');
            fs.writeFileSync(workerPath, `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'escaped');\n`);
            writeWorkerHandoff(entryPath, workerPath, false);
            assert.throws(() => buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /contained runtime/);
            assert.equal(fs.existsSync(markerPath), false);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects a native ESM worker entry outside the contained runtime', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const markerPath = path.join(targetRoot, 'escaped-marker');
            const workerPath = path.join(targetRoot, 'outside-worker.mjs');
            fs.writeFileSync(workerPath, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(markerPath)}, 'escaped');\n`);
            writeWorkerHandoff(entryPath, workerPath, true);
            assert.throws(() => buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /handoff|contained runtime/);
            assert.equal(fs.existsSync(markerPath), false);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('loads a worker entry within the contained runtime', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const workerPath = path.join(path.dirname(entryPath), 'inside-worker.js');
            fs.writeFileSync(workerPath, "require('node:worker_threads').parentPort.postMessage('contained-worker');\n");
            writeWorkerHandoff(entryPath, workerPath, false);
            assert.equal(buildLockedLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)).previousVersion, 'contained-worker');
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('treats Windows casing as equivalent while rejecting a sibling bundle path', () => {
        assert.equal(isPathInsideRoot('C:\\Workspace\\Bundle', 'c:\\workspace\\bundle\\dist\\src', 'win32'), true);
        assert.equal(isPathInsideRoot('C:\\Workspace\\Bundle', 'C:\\Workspace\\Bundle-evil\\entry.js', 'win32'), false);
    });

    it('requires a new host process before another CLI command after bundle replacement', async () => {
        markRuntimeRestartRequired();
        await assert.rejects(() => runCliRuntimeMain(['--version']), /Start a new Garda process/);
    });
});

describe('lifecycle lock handoff ownership', () => {
    it('rejects a stale owner from before the current parent process even when its PID is live', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        const markerPath = path.join(targetRoot, 'unexpected-child-start');
        try {
            writeHandoff(entryPath, 'must-not-run');
            fs.appendFileSync(entryPath, `\nfs.writeFileSync(${JSON.stringify(markerPath)}, 'started');\n`);
            assert.doesNotThrow(() => withLifecycleOperationLock(targetRoot, 'update', () => {
                const ownerPath = path.join(getLifecycleOperationLockPath(targetRoot), 'owner.json');
                const original = fs.readFileSync(ownerPath, 'utf8');
                const owner = JSON.parse(original);
                assert.equal(owner.pid, process.pid);
                assert.doesNotThrow(() => process.kill(owner.pid, 0));
                try {
                    fs.writeFileSync(ownerPath, JSON.stringify({
                        ...owner, acquired_at_utc: new Date(performance.timeOrigin - 60_000).toISOString()
                    }));
                    assert.throws(() => captureLifecycleLockHandoff(targetRoot), /predates the current parent process/);
                    assert.throws(() => buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)),
                        /predates the current parent process/);
                    assert.equal(fs.existsSync(markerPath), false);
                    assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'update-rollbacks')), false);
                } finally {
                    fs.writeFileSync(ownerPath, original);
                }
            }));
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects an owner that is no longer alive even when its metadata still matches', () => {
        const { targetRoot } = makeBundle();
        try {
            assert.doesNotThrow(() => withLifecycleOperationLock(targetRoot, 'update', () => {
                const originalKill = process.kill;
                const probe = mock.method(process, 'kill', (pid: number, signal?: string | number) => {
                    if (pid === process.pid && signal === 0) throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
                    return Reflect.apply(originalKill, process, [pid, signal]);
                });
                try {
                    assert.throws(() => captureLifecycleLockHandoff(targetRoot), /owner is no longer alive/);
                } finally {
                    probe.mock.restore();
                }
            }));
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('accepts only the actual child while the exact parent generation remains held', () => {
        const { targetRoot } = makeBundle();
        try {
            let captured: unknown;
            withLifecycleOperationLock(targetRoot, 'update', () => {
                captured = captureLifecycleLockHandoff(targetRoot);
                const child = validateHandoffInChild(targetRoot, captured);
                assert.equal(child.status, 0, child.stderr);
                assert.equal(child.stdout, 'accepted');
            });
            const replay = validateHandoffInChild(targetRoot, captured);
            assert.equal(replay.status, 1);
            assert.match(replay.stderr, /lock|owner|ENOENT/i);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects mutated ownership fields and malformed proof before creating rollback files', () => {
        const { targetRoot, bundleRoot } = makeBundle();
        try {
            assert.doesNotThrow(() => withLifecycleOperationLock(targetRoot, 'update', () => {
                const proof = captureLifecycleLockHandoff(targetRoot);
                const ownerPath = path.join(getLifecycleOperationLockPath(targetRoot), 'owner.json');
                const original = fs.readFileSync(ownerPath, 'utf8');
                const invalidFields = {
                    pid: process.ppid, hostname: 'foreign-host', target_root: path.dirname(targetRoot),
                    operation: 'rollback', lock_id: 'replaced-generation', acquired_at_utc: '2000-01-01T00:00:00.000Z'
                };
                try {
                    for (const [field, value] of Object.entries(invalidFields)) {
                        fs.writeFileSync(ownerPath, JSON.stringify({ ...JSON.parse(original), [field]: value }));
                        const child = validateHandoffInChild(targetRoot, proof, true);
                        assert.equal(child.status, 1, `${field}: ${child.stderr}`);
                        assert.match(child.stderr, /lock handoff/i, field);
                        assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'update-rollbacks')), false);
                    }
                } finally {
                    fs.writeFileSync(ownerPath, original);
                }
                for (const malformed of [null, {}, { ...proof, parentPid: process.ppid }, { ...proof, ownerIdentity: '' }]) {
                    const child = validateHandoffInChild(targetRoot, malformed);
                    assert.equal(child.status, 1, child.stderr);
                }
            }));
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects a replaced owner file with identical bytes and a hard-linked owner', () => {
        const { targetRoot } = makeBundle();
        try {
            assert.doesNotThrow(() => withLifecycleOperationLock(targetRoot, 'update', () => {
                const proof = captureLifecycleLockHandoff(targetRoot);
                const ownerPath = path.join(getLifecycleOperationLockPath(targetRoot), 'owner.json');
                const originalPath = path.join(targetRoot, 'original-owner.json');
                fs.renameSync(ownerPath, originalPath);
                try {
                    fs.copyFileSync(originalPath, ownerPath);
                    assert.equal(validateHandoffInChild(targetRoot, proof).status, 1);
                    fs.unlinkSync(ownerPath);
                    fs.linkSync(originalPath, ownerPath);
                    const child = validateHandoffInChild(targetRoot, proof);
                    assert.equal(child.status, 1);
                    assert.match(child.stderr, /hard.link/i);
                } finally {
                    fs.rmSync(ownerPath, { force: true });
                    fs.renameSync(originalPath, ownerPath);
                }
            }));
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects linked lock ancestry without following the replacement directory', () => {
        const { targetRoot } = makeBundle();
        try {
            assert.doesNotThrow(() => withLifecycleOperationLock(targetRoot, 'update', () => {
                const proof = captureLifecycleLockHandoff(targetRoot);
                const lockPath = getLifecycleOperationLockPath(targetRoot);
                const movedPath = path.join(targetRoot, 'moved-lock');
                fs.renameSync(lockPath, movedPath);
                try {
                    fs.symlinkSync(movedPath, lockPath, process.platform === 'win32' ? 'junction' : 'dir');
                    const child = validateHandoffInChild(targetRoot, proof);
                    assert.equal(child.status, 1);
                    assert.match(child.stderr, /symlink|junction/i);
                } finally {
                    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
                    fs.renameSync(movedPath, lockPath);
                }
            }));
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });
});
