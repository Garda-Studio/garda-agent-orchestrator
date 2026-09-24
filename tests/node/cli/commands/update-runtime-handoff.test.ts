import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildUpdateLifecycleRunner, markRuntimeRestartRequired } from '../../../../src/cli/commands/shared-command-utils';
import { isPathInsideRoot } from '../../../../src/core/paths';
import { runCliRuntimeMain } from '../../../../src/cli/runtime-main';

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
    it('runs the fixed bundle entry in a fresh process on each invocation without mutating module cache', () => {
        const { targetRoot, bundleRoot, entryPath } = makeBundle();
        try {
            const unrelatedPath = path.join(bundleRoot, 'dist', 'src', 'unrelated.js');
            fs.writeFileSync(unrelatedPath, "module.exports = { stale: true };\n");
            require(unrelatedPath);
            const cached = require.cache[require.resolve(unrelatedPath)];
            writeHandoff(entryPath, 'v1');
            const run = buildUpdateLifecycleRunner(bundleRoot, false);
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
            const run = buildUpdateLifecycleRunner(bundleRoot, false);
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
            assert.throws(() => buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /contain|link|bundle/i);
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
            assert.throws(() => buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /contain|link|bundle/i);
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
            assert.throws(() => buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /handoff/i);
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
            const result = buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot));
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
            assert.equal(buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)).previousVersion, 'contained');
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
            assert.throws(() => buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /contained runtime/);
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
            assert.equal(buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)).previousVersion, 'contained-esm');
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
            assert.throws(() => buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /contained runtime/);
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
            assert.throws(() => buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)), /handoff|contained runtime/);
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
            assert.equal(buildUpdateLifecycleRunner(bundleRoot, false)(runnerOptions(targetRoot)).previousVersion, 'contained-worker');
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
