import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getRuntimeCandidates,
    loadCliMainModule,
    resolveDelegatedLauncherTrustEvidence,
    resolveDelegatedLauncherTarget
} from '../../../src/bin/garda';

const ROUTER_TEMP_CLEANUP_MAX_RETRIES = 10;
const ROUTER_TEMP_CLEANUP_RETRY_DELAY_MS = 100;
const ROUTER_CHILD_DRAIN_TIMEOUT_MS = 1_000;

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createGardaPackageRoot(
    rootPath: string,
    version = '2.4.0',
    options?: { sourceCheckout?: boolean; deployedBundle?: boolean }
): void {
    writeFile(path.join(rootPath, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version
    }, null, 2));
    writeFile(path.join(rootPath, 'VERSION'), `${version}\n`);
    writeFile(path.join(rootPath, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
    if (options?.sourceCheckout) {
        writeFile(path.join(rootPath, 'src', 'bin', 'garda.ts'), 'export {};\n');
        writeFile(path.join(rootPath, 'scripts', 'node-foundation', 'build-scripts.cjs'), 'module.exports = {};\n');
        writeFile(path.join(rootPath, 'tests', 'node', 'placeholder.test.ts'), '');
    }
    if (options?.deployedBundle) {
        writeFile(path.join(rootPath, 'MANIFEST.md'), '- bin/garda.js\n');
        writeFile(path.join(rootPath, 'live', 'version.json'), `{"version":${JSON.stringify(version)}}\n`);
        writeFile(path.join(rootPath, 'live', 'docs', 'agent-rules', '00-core.md'), '# Core Rules\n');
        writeFile(path.join(rootPath, 'live', 'config', 'profiles.json'), '{}\n');
        writeFile(path.join(rootPath, 'live', 'config', 'review-capabilities.json'), '{}\n');
    }
}

function writeUiLanguagePack(runtimeRoot: string, languageId: string, text: Record<string, string>): void {
    writeFile(path.join(runtimeRoot, 'reports', 'ui', 'lang-packs', `garda-ui-${languageId}.json`), JSON.stringify({
        language: {
            id: languageId,
            label: languageId.toUpperCase(),
            nativeLabel: languageId.toUpperCase()
        },
        LOCAL_UI_TEXT: text
    }, null, 2) + '\n');
}

function writeHealthyRuntimeCandidate(runtimeRoot: string, runtimeId = 'runtime'): void {
    writeFile(path.join(runtimeRoot, 'index.js'), 'module.exports = {};\n');
    writeFile(
        path.join(runtimeRoot, 'cli', 'main.js'),
        [
            `exports.runtimeId = ${JSON.stringify(runtimeId)};`,
            'exports.runCliMainWithHandling = async function () {};'
        ].join('\n') + '\n'
    );
    writeFile(path.join(runtimeRoot, 'cli', 'runtime-main.js'), 'module.exports = {};\n');
    writeFile(path.join(runtimeRoot, 'cli', 'commands', 'command-dispatch.js'), 'module.exports = {};\n');
    writeFile(path.join(runtimeRoot, 'cli', 'commands', 'cli-help-output.js'), 'module.exports = {};\n');
    writeFile(path.join(runtimeRoot, 'reports', 'ui', 'ui-i18n.js'), 'module.exports = {};\n');
    writeFile(path.join(runtimeRoot, 'reports', 'ui', 'ui-language-pack-loader.js'), 'module.exports = {};\n');
    const text = {
        appTitle: 'Garda UI',
        tasksTab: 'Tasks'
    };
    writeUiLanguagePack(runtimeRoot, 'de', text);
    writeUiLanguagePack(runtimeRoot, 'ru', text);
}

function waitForChildExit(child: childProcess.ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        if (child.exitCode === 0) {
            return Promise.resolve();
        }
        const status = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        return Promise.reject(new Error(`child exited with ${status}`));
    }

    return new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            const status = signal ? `signal ${signal}` : `code ${code}`;
            reject(new Error(stderr || `child exited with ${status}`));
        });
    });
}

async function drainKilledChild(child: childProcess.ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    const drained = new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = (): void => {
            clearTimeout(timer);
            child.off('error', onError);
            child.off('exit', onExit);
        };
        const onError = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const onExit = (): void => {
            cleanup();
            resolve();
        };
        timer = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for router lock diagnostic child process to exit after kill'));
        }, ROUTER_CHILD_DRAIN_TIMEOUT_MS);
        child.once('error', onError);
        child.once('exit', onExit);
    });
    child.kill();
    await drained;
}

function cleanupRouterTempRoot(tempRoot: string): void {
    fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: ROUTER_TEMP_CLEANUP_MAX_RETRIES,
        retryDelay: ROUTER_TEMP_CLEANUP_RETRY_DELAY_MS
    });
}

test('global launcher delegates to source checkout in current workspace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-source-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        createGardaPackageRoot(sourceRoot, '2.4.0', { sourceCheckout: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            sourceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(sourceRoot, 'bin', 'garda.js'));
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher stops after delegated CLI completes', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-delegated-once-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');
        writeFile(
            path.join(bundleRoot, 'bin', 'garda.js'),
            "#!/usr/bin/env node\nprocess.stdout.write('delegated-only\\n');\n"
        );
        const compiledLauncherPath = path.resolve(__dirname, '../../../src/bin/garda.js');
        fs.copyFileSync(compiledLauncherPath, path.join(globalPackageRoot, 'bin', 'garda.js'));
        fs.cpSync(
            path.join(path.dirname(compiledLauncherPath), 'garda'),
            path.join(globalPackageRoot, 'bin', 'garda'),
            { recursive: true }
        );

        const result = childProcess.spawnSync(
            process.execPath,
            [path.join(globalPackageRoot, 'bin', 'garda.js'), 'status'],
            {
                cwd: workspaceRoot,
                encoding: 'utf8',
                timeout: 30_000
            }
        );

        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'delegated-only\n');
        assert.equal(result.stderr, '');
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher delegates to deployed bundle when workspace contains managed bundle', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(bundleRoot, 'bin', 'garda.js'));
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher ignores default-named deployed bundles outside the workspace boundary', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-boundary-'));
    try {
        const projectsRoot = path.join(tempRoot, 'Projects');
        const workspaceRoot = path.join(projectsRoot, 'Startpage for site');
        const externalGardaRoot = path.join(projectsRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        createGardaPackageRoot(externalGardaRoot, '9.9.9', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '1.0.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, null);

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );
        assert.equal(evidence.current_runtime.package_version, '1.0.0');
        assert.equal(evidence.delegated_runtime, null);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher ignores default-named source checkouts outside the workspace boundary', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-boundary-source-'));
    try {
        const projectsRoot = path.join(tempRoot, 'Projects');
        const workspaceRoot = path.join(projectsRoot, 'Startpage for site');
        const externalSourceRoot = path.join(projectsRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        createGardaPackageRoot(externalSourceRoot, '9.9.9', { sourceCheckout: true });
        createGardaPackageRoot(globalPackageRoot, '1.0.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, null);

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );
        assert.equal(evidence.current_runtime.package_version, '1.0.0');
        assert.equal(evidence.delegated_runtime, null);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher delegates to preferred deployed bundle when fallback candidates also exist', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-preferred-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const preferredBundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const fallbackBundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(preferredBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(fallbackBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(preferredBundleRoot, 'bin', 'garda.js'));
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher ignores GARDA_BUNDLE_NAME and uses the fixed deployed bundle', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-env-bundle-'));
    const previousBundleName = process.env.GARDA_BUNDLE_NAME;
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const preferredBundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const customBundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(preferredBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(customBundleRoot, '2.5.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');
        process.env.GARDA_BUNDLE_NAME = 'custom-bundle';

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(preferredBundleRoot, 'bin', 'garda.js'));
    } finally {
        if (previousBundleName === undefined) {
            delete process.env.GARDA_BUNDLE_NAME;
        } else {
            process.env.GARDA_BUNDLE_NAME = previousBundleName;
        }
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher does not infer non-default deployed bundle directories', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-custom-bundle-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');
        const diagnostics: string[] = [];
        const originalConsoleError = console.error;
        console.error = (message?: unknown, ...optionalParams: unknown[]): void => {
            diagnostics.push([message, ...optionalParams].map(String).join(' '));
        };

        try {
            const delegatedCli = resolveDelegatedLauncherTarget(
                ['status'],
                workspaceRoot,
                path.join(globalPackageRoot, 'bin', 'garda.js'),
                globalPackageRoot
            );

            assert.equal(delegatedCli, null);
        } finally {
            console.error = originalConsoleError;
        }
        assert.deepEqual(diagnostics, []);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher ignores ambiguous custom deployed bundle candidates', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-ambiguous-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const alphaBundleRoot = path.join(workspaceRoot, 'alpha-bundle');
        const betaBundleRoot = path.join(workspaceRoot, 'beta-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(alphaBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(betaBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, null);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher does not delegate when cwd is inside a non-default deployed bundle', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-custom-cwd-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const customBundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(customBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            customBundleRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, null);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('global launcher respects explicit --target-root when cwd is outside the workspace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-target-root-'));
    try {
        const callerRoot = path.join(tempRoot, 'caller');
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(callerRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status', '--target-root', workspaceRoot],
            callerRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(bundleRoot, 'bin', 'garda.js'));
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('local source launcher does not delegate to itself', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-local-source-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        createGardaPackageRoot(sourceRoot, '2.4.0', { sourceCheckout: true });

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            sourceRoot,
            path.join(sourceRoot, 'bin', 'garda.js'),
            sourceRoot
        );

        assert.equal(delegatedCli, null);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('local deployed bundle launcher does not redirect to source checkout', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-local-bundle-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        const bundleRoot = path.join(sourceRoot, 'garda-agent-orchestrator');
        createGardaPackageRoot(sourceRoot, '2.4.0', { sourceCheckout: true });
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            sourceRoot,
            path.join(bundleRoot, 'bin', 'garda.js'),
            bundleRoot
        );

        assert.equal(delegatedCli, null);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('getRuntimeCandidates prefers dist runtime over .node-build when both exist', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-order-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeFile(path.join(tempRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');

        const candidates = getRuntimeCandidates(tempRoot);
        assert.deepEqual(candidates, [
            path.join(tempRoot, 'dist', 'src'),
            path.join(tempRoot, '.node-build', 'src')
        ]);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('getRuntimeCandidates falls back to .node-build when dist runtime is absent', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-fallback-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');

        const candidates = getRuntimeCandidates(tempRoot);
        assert.deepEqual(candidates, [
            path.join(tempRoot, '.node-build', 'src')
        ]);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('getRuntimeCandidates excludes .node-build for deployed bundle roots', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-deployed-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { deployedBundle: true });
        writeFile(path.join(tempRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');

        const candidates = getRuntimeCandidates(tempRoot);
        assert.deepEqual(candidates, [
            path.join(tempRoot, 'dist', 'src')
        ]);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('getRuntimeCandidates does not use .node-build-only deployed bundle roots', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-deployed-node-build-only-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { deployedBundle: true });
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');

        const candidates = getRuntimeCandidates(tempRoot);
        assert.deepEqual(candidates, []);
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule fails corrupt deployed dist instead of falling back to .node-build', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-corrupt-deployed-dist-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { deployedBundle: true });
        writeFile(path.join(tempRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
        writeFile(
            path.join(tempRoot, 'dist', 'src', 'cli', 'main.js'),
            'require("./definitely-missing-runtime-module");\n'
        );
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');
        writeFile(
            path.join(tempRoot, '.node-build', 'src', 'cli', 'main.js'),
            'exports.runCliMainWithHandling = async function () {};\n'
        );

        assert.throws(
            () => loadCliMainModule(tempRoot),
            /definitely-missing-runtime-module/
        );
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule propagates source-checkout application errors instead of falling back', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-source-application-error-'));
    try {
        const distSourceRoot = path.join(tempRoot, 'dist', 'src');
        const nodeBuildSourceRoot = path.join(tempRoot, '.node-build', 'src');
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeHealthyRuntimeCandidate(distSourceRoot, 'dist');
        writeFile(
            path.join(distSourceRoot, 'cli', 'main.js'),
            'throw new Error("source runtime application failure");\n'
        );
        writeHealthyRuntimeCandidate(nodeBuildSourceRoot, 'node-build');

        assert.throws(
            () => loadCliMainModule(tempRoot),
            /source runtime application failure/
        );
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule skips source-checkout dist with missing runtime entrypoint and uses healthy fallback', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-entry-fallback-'));
    try {
        const distSourceRoot = path.join(tempRoot, 'dist', 'src');
        const nodeBuildSourceRoot = path.join(tempRoot, '.node-build', 'src');
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeFile(path.join(distSourceRoot, 'index.js'), 'module.exports = {};\n');
        writeHealthyRuntimeCandidate(nodeBuildSourceRoot, 'node-build');

        const module = loadCliMainModule(tempRoot) as typeof loadCliMainModule extends (...args: never[]) => infer R
            ? R & { runtimeId?: string }
            : never;
        assert.equal(module.runtimeId, 'node-build');
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule skips source-checkout runtime with missing UI language packs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-langpacks-missing-'));
    try {
        const distSourceRoot = path.join(tempRoot, 'dist', 'src');
        const nodeBuildSourceRoot = path.join(tempRoot, '.node-build', 'src');
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeHealthyRuntimeCandidate(distSourceRoot, 'dist');
        fs.rmSync(path.join(distSourceRoot, 'reports', 'ui', 'lang-packs'), { recursive: true, force: true });
        writeHealthyRuntimeCandidate(nodeBuildSourceRoot, 'node-build');

        const module = loadCliMainModule(tempRoot) as ReturnType<typeof loadCliMainModule> & { runtimeId?: string };
        assert.equal(module.runtimeId, 'node-build');
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule skips source-checkout runtime with inconsistent UI language packs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-langpacks-inconsistent-'));
    try {
        const distSourceRoot = path.join(tempRoot, 'dist', 'src');
        const nodeBuildSourceRoot = path.join(tempRoot, '.node-build', 'src');
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeHealthyRuntimeCandidate(distSourceRoot, 'dist');
        writeUiLanguagePack(distSourceRoot, 'ru', {
            appTitle: 'Garda UI'
        });
        writeHealthyRuntimeCandidate(nodeBuildSourceRoot, 'node-build');

        const module = loadCliMainModule(tempRoot) as ReturnType<typeof loadCliMainModule> & { runtimeId?: string };
        assert.equal(module.runtimeId, 'node-build');
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule skips source-checkout candidate with manifest-listed missing files', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-manifest-missing-'));
    try {
        const distSourceRoot = path.join(tempRoot, 'dist', 'src');
        const nodeBuildSourceRoot = path.join(tempRoot, '.node-build', 'src');
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeHealthyRuntimeCandidate(distSourceRoot, 'dist');
        writeFile(path.join(tempRoot, 'dist', 'publish-runtime-manifest.json'), JSON.stringify({
            files: [
                'src/index.js',
                'src/cli/main.js',
                'src/cli/runtime-main.js',
                'src/cli/missing-runtime-module.js'
            ]
        }, null, 2) + '\n');
        writeHealthyRuntimeCandidate(nodeBuildSourceRoot, 'node-build');

        const module = loadCliMainModule(tempRoot) as ReturnType<typeof loadCliMainModule> & { runtimeId?: string };
        assert.equal(module.runtimeId, 'node-build');
    } finally {
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule prints bounded source-checkout remediation when runtime is completely missing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-missing-remediation-'));
    const originalExit = process.exit;
    const originalConsoleError = console.error;
    let exitCode: number | string | null | undefined;
    const diagnostics: string[] = [];

    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        process.exit = ((code?: number | string | null | undefined): never => {
            exitCode = code;
            throw new Error('process.exit intercepted');
        }) as typeof process.exit;
        console.error = (message?: unknown, ...optionalParams: unknown[]): void => {
            diagnostics.push([message, ...optionalParams].map(String).join(' '));
        };

        assert.throws(
            () => loadCliMainModule(tempRoot),
            /process\.exit intercepted/
        );

        const output = diagnostics.join('\n');
        assert.equal(exitCode, 1);
        assert.match(output, /runtime bootstrap failed/i);
        assert.match(output, /npm run build/);
        assert.doesNotMatch(output, /\n\s+at /);
    } finally {
        process.exit = originalExit;
        console.error = originalConsoleError;
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule waits for source checkout dist build lock before loading runtime', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-dist-lock-'));
    const previousTimeout = process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS;
    const distSourceRoot = path.join(tempRoot, 'dist', 'src');
    const distLockPath = path.join(tempRoot, 'dist.lock');
    let child: childProcess.ChildProcess | null = null;

    try {
        process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS = '5000';
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeHealthyRuntimeCandidate(distSourceRoot, 'dist');
        writeFile(path.join(distSourceRoot, 'cli', 'main.js'), 'module.exports = require("./late-module");\n');
        fs.mkdirSync(distLockPath, { recursive: true });

        const workerScript = [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            'const distSourceRoot = process.argv[1];',
            'const lockPath = process.argv[2];',
            'setTimeout(() => {',
            "  fs.mkdirSync(path.join(distSourceRoot, 'cli'), { recursive: true });",
            "  fs.writeFileSync(path.join(distSourceRoot, 'cli', 'late-module.js'), 'exports.runCliMainWithHandling = async function () {};\\n', 'utf8');",
            '  fs.rmSync(lockPath, { recursive: true, force: true });',
            '}, 150);'
        ].join('\n');
        child = childProcess.spawn(process.execPath, ['--eval', workerScript, distSourceRoot, distLockPath], {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true
        });

        const module = loadCliMainModule(tempRoot);
        assert.equal(typeof module.runCliMainWithHandling, 'function');
        await waitForChildExit(child);
    } finally {
        if (previousTimeout === undefined) {
            delete process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS;
        } else {
            process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS = previousTimeout;
        }
        await drainKilledChild(child);
        cleanupRouterTempRoot(tempRoot);
    }
});

test('loadCliMainModule enforces one runtime lock timeout budget per candidate', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-lock-timeout-'));
    const previousTimeout = process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS;
    const distSourceRoot = path.join(tempRoot, 'dist', 'src');
    const nodeBuildSourceRoot = path.join(tempRoot, '.node-build', 'src');
    const nodeBuildLockPath = path.join(tempRoot, '.node-build.lock');

    try {
        process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS = '120';
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeHealthyRuntimeCandidate(distSourceRoot, 'dist');
        writeFile(
            path.join(distSourceRoot, 'cli', 'main.js'),
            'require("./missing-during-refresh");\n'
        );
        writeHealthyRuntimeCandidate(nodeBuildSourceRoot, 'node-build');
        fs.mkdirSync(nodeBuildLockPath, { recursive: true });

        const startedAt = Date.now();
        assert.throws(
            () => loadCliMainModule(tempRoot),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Timed out waiting for Garda Agent Orchestrator runtime build lock to clear/);
                assert.match(error.message, /\.node-build\.lock/);
                return true;
            }
        );
        const elapsedMs = Date.now() - startedAt;
        assert.ok(elapsedMs >= 180, `fallback candidate should receive its own timeout budget, got ${elapsedMs}ms`);
        assert.ok(elapsedMs < 1_000, `lock timeout should use bounded per-candidate budgets, got ${elapsedMs}ms`);
    } finally {
        if (previousTimeout === undefined) {
            delete process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS;
        } else {
            process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS = previousTimeout;
        }
        cleanupRouterTempRoot(tempRoot);
    }
});
