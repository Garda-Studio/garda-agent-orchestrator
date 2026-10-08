import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    prepareSandbox,
    resolveSandboxRoot,
    resolveIsolatedOrchestratorRoot,
    resolveGateExecutionPath,
    isControlPlanePath,
    validateSandbox,
    compareSandboxToLive,
    ISOLATION_SANDBOX_DIR
} from '../../../../src/gates/isolation/isolation-sandbox';
import {
    type IsolationModeConfig
} from '../../../../src/gates/isolation/isolation-mode';
import {
    getClassificationConfig,
    getReviewCapabilities
} from '../../../../src/gates/preflight/classify-change';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-sandbox-test-'));
}

function canWriteFile(filePath: string): boolean {
    const original = fs.readFileSync(filePath);
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, 'r+');
        // Write the same bytes so capability checks do not create content drift.
        assert.equal(fs.writeSync(fd, original, 0, original.length, 0), original.length);
        return true;
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
            return false;
        }
        throw err;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function canWriteReadonlyFixture(root: string): boolean {
    const probePath = path.join(root, 'readonly-capability-probe.txt');
    fs.writeFileSync(probePath, 'readonly capability probe\n');
    fs.chmodSync(probePath, 0o444);
    return canWriteFile(probePath);
}

function setupMinimalWorkspace(root: string): void {
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'template', 'config'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '2.4.2\n');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator', version: '2.4.2' }));
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\nconsole.log("ok");\n');
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\nconsole.log("ok");\n');
    fs.writeFileSync(path.join(bundleRoot, 'dist', 'index.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules', '00-core.md'), '# Core Rules\n');
    fs.writeFileSync(path.join(bundleRoot, 'template', 'config', 'paths.json'), '{}');

    fs.writeFileSync(path.join(root, 'MANIFEST.md'), '# Manifest\n');
    fs.writeFileSync(path.join(root, 'VERSION'), '2.4.2\n');
}

function writeIsolationConfig(root: string, config: Partial<IsolationModeConfig>): void {
    const configPath = path.join(root, 'garda-agent-orchestrator', 'live', 'config', 'isolation-mode.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function cleanupTempDir(dir: string): void {
    // Clear read-only flags before deletion
    const walk = (currentDir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch { return; }
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                try { fs.chmodSync(fullPath, 0o666); } catch { /* best-effort */ }
            }
        }
    };
    walk(dir);
    fs.rmSync(dir, { recursive: true, force: true });
}

describe('gates/isolation-sandbox', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = createTempDir();
        setupMinimalWorkspace(tempDir);
    });

    afterEach(() => {
        cleanupTempDir(tempDir);
    });

    describe('resolveSandboxRoot', () => {
        it('returns a path under runtime/.isolation-sandbox', () => {
            const result = resolveSandboxRoot(tempDir);
            assert.ok(result.includes('runtime'));
            assert.ok(result.includes(ISOLATION_SANDBOX_DIR));
        });
    });

    describe('prepareSandbox', () => {
        it('creates sandbox directory with control-plane files', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const result = prepareSandbox(tempDir);

            assert.ok(result.file_count > 0, 'Expected files to be copied');
            assert.ok(fs.existsSync(result.sandbox_root), 'Sandbox root should exist');
            assert.ok(fs.existsSync(result.sandbox_manifest_path), 'Sandbox manifest should exist');
        });

        it('copies bin, dist, and live directories into sandbox', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            const result = prepareSandbox(tempDir);

            const sandboxBin = path.join(result.sandbox_root, 'bin', 'garda.js');
            const sandboxDist = path.join(result.sandbox_root, 'dist', 'index.js');
            const sandboxRule = path.join(result.sandbox_root, 'live', 'docs', 'agent-rules', '00-core.md');

            assert.ok(fs.existsSync(sandboxBin), 'bin/garda.js should be in sandbox');
            assert.ok(fs.existsSync(sandboxDist), 'dist/index.js should be in sandbox');
            assert.ok(fs.existsSync(sandboxRule), 'live/docs/agent-rules/00-core.md should be in sandbox');
        });

        it('applies read-only attributes and reflects actual write capability', () => {
            const expectedWritable = canWriteReadonlyFixture(tempDir);
            writeIsolationConfig(tempDir, { enabled: true });
            const result = prepareSandbox(tempDir);
            assert.equal(result.read_only_applied, true);

            const sandboxBin = path.join(result.sandbox_root, 'bin', 'garda.js');
            // Same-user attributes are advisory, especially for privileged users.
            assert.equal(canWriteFile(sandboxBin), expectedWritable);
        });

        it('does not copy node_modules or runtime into sandbox', () => {
            // Create a node_modules dir in the bundle
            const nmPath = path.join(tempDir, 'garda-agent-orchestrator', 'node_modules');
            fs.mkdirSync(nmPath, { recursive: true });
            fs.writeFileSync(path.join(nmPath, 'dummy.js'), 'x');

            writeIsolationConfig(tempDir, { enabled: true });
            const result = prepareSandbox(tempDir);

            const sandboxNm = path.join(result.sandbox_root, 'node_modules');
            assert.ok(!fs.existsSync(sandboxNm), 'node_modules should NOT be in sandbox');
        });

        it('overwrites previous sandbox on re-prepare', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            const first = prepareSandbox(tempDir);
            const firstCount = first.file_count;

            // Add a new file to the bundle
            const newFile = path.join(tempDir, 'garda-agent-orchestrator', 'bin', 'extra.js');
            // Must clear read-only on the sandbox first to allow cleanup
            fs.writeFileSync(newFile, 'new file');

            const second = prepareSandbox(tempDir);
            assert.ok(second.file_count >= firstCount, 'Re-prepare should include new files');
            assert.ok(fs.existsSync(path.join(second.sandbox_root, 'bin', 'extra.js')), 'New file should be in sandbox');
        });

        it('retries transient cleanup failures when refreshing an existing sandbox', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            prepareSandbox(tempDir);

            const realFs = require('node:fs');
            const originalRmSync = realFs.rmSync;
            let attempts = 0;
            try {
                realFs.rmSync = function (targetPath: string, ...args: unknown[]) {
                    if (targetPath.includes(ISOLATION_SANDBOX_DIR) && attempts === 0) {
                        attempts++;
                        const error = new Error('EPERM: simulated transient sandbox cleanup contention') as NodeJS.ErrnoException;
                        error.code = 'EPERM';
                        throw error;
                    }
                    attempts++;
                    return originalRmSync.call(realFs, targetPath, ...args);
                };

                const result = prepareSandbox(tempDir);

                assert.ok(fs.existsSync(result.sandbox_root));
                assert.ok(attempts >= 2, 'Expected retry after transient cleanup failure');
            } finally {
                realFs.rmSync = originalRmSync;
            }
        });

        it('fails closed for unrecoverable cleanup failures when refreshing an existing sandbox', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            prepareSandbox(tempDir);

            const realFs = require('node:fs');
            const originalRmSync = realFs.rmSync;
            try {
                realFs.rmSync = function (targetPath: string, ...args: unknown[]) {
                    if (targetPath.includes(ISOLATION_SANDBOX_DIR)) {
                        const error = new Error('EINVAL: simulated unrecoverable sandbox cleanup failure') as NodeJS.ErrnoException;
                        error.code = 'EINVAL';
                        throw error;
                    }
                    return originalRmSync.call(realFs, targetPath, ...args);
                };

                assert.throws(
                    () => prepareSandbox(tempDir),
                    /simulated unrecoverable sandbox cleanup failure/
                );
            } finally {
                realFs.rmSync = originalRmSync;
            }
        });

        it('writes valid sandbox manifest', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            const result = prepareSandbox(tempDir);

            const manifest = JSON.parse(fs.readFileSync(result.sandbox_manifest_path, 'utf8'));
            assert.equal(manifest.schema_version, 1);
            assert.equal(manifest.event_source, 'prepare-isolation-sandbox');
            assert.ok(manifest.timestamp_utc, 'Manifest should have a timestamp');
            assert.ok(typeof manifest.snapshot === 'object', 'Manifest should have a snapshot');
            assert.ok(manifest.file_count > 0, 'Manifest should record file count');
            assert.equal(manifest.read_only_applied, true);
        });
    });

    describe('validateSandbox', () => {
        it('returns exists=false when no sandbox', () => {
            const result = validateSandbox(tempDir);
            assert.equal(result.exists, false);
            assert.equal(result.manifest_valid, false);
        });

        it('returns exists=true after prepare', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            prepareSandbox(tempDir);
            const result = validateSandbox(tempDir);
            assert.equal(result.exists, true);
            assert.equal(result.manifest_valid, true);
            assert.ok(result.file_count > 0);
            assert.equal(result.drift_files.length, 0, 'No drift expected immediately after prepare');
        });

        it('detects sandbox drift when file is modified', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            const prepResult = prepareSandbox(tempDir);

            // Tamper with a sandbox file
            const targetFile = path.join(prepResult.sandbox_root, 'MANIFEST.md');
            fs.chmodSync(targetFile, 0o666); // remove read-only
            fs.writeFileSync(targetFile, '# Tampered\n');

            const result = validateSandbox(tempDir);
            assert.ok(result.drift_files.length > 0, 'Expected drift after tampering');
        });

        it('reports read-only intact according to actual write capability', () => {
            const expectedReadOnly = !canWriteReadonlyFixture(tempDir);
            writeIsolationConfig(tempDir, { enabled: true });
            prepareSandbox(tempDir);
            const result = validateSandbox(tempDir);
            assert.equal(result.read_only_intact, expectedReadOnly);
        });

        it('detects writable sandbox files without content drift', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            const prepResult = prepareSandbox(tempDir);
            const targetFile = path.join(prepResult.sandbox_root, 'MANIFEST.md');
            fs.chmodSync(targetFile, 0o666);
            assert.equal(canWriteFile(targetFile), true);

            const result = validateSandbox(tempDir);
            assert.equal(result.drift_files.length, 0);
            assert.equal(result.read_only_intact, false);
        });
    });

    describe('resolveIsolatedOrchestratorRoot', () => {
        it('returns live root when isolation is disabled', () => {
            const result = resolveIsolatedOrchestratorRoot(tempDir);
            assert.equal(result.using_sandbox, false);
            assert.equal(result.sandbox_root, null);
            assert.ok(result.reason.includes('disabled'));
        });

        it('returns live root when sandbox does not exist', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            const result = resolveIsolatedOrchestratorRoot(tempDir);
            assert.equal(result.using_sandbox, false);
            assert.ok(result.reason.includes('does not exist'));
        });

        it('returns sandbox root when isolation is enabled and sandbox is valid', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            prepareSandbox(tempDir);
            const result = resolveIsolatedOrchestratorRoot(tempDir);
            assert.equal(result.using_sandbox, true);
            assert.ok(result.sandbox_root !== null);
            assert.ok(result.resolved_root.includes(ISOLATION_SANDBOX_DIR));
        });

        it('falls back to live root when sandbox has drifted in STRICT mode', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const prepResult = prepareSandbox(tempDir);

            // Tamper with sandbox
            const targetFile = path.join(prepResult.sandbox_root, 'MANIFEST.md');
            fs.chmodSync(targetFile, 0o666);
            fs.writeFileSync(targetFile, '# Tampered\n');

            const result = resolveIsolatedOrchestratorRoot(tempDir);
            assert.equal(result.using_sandbox, false);
            assert.ok(result.reason.includes('drifted'));
        });

        it('still uses sandbox with drifted files in LOG_ONLY mode', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'LOG_ONLY' });
            const prepResult = prepareSandbox(tempDir);

            // Tamper with sandbox
            const targetFile = path.join(prepResult.sandbox_root, 'MANIFEST.md');
            fs.chmodSync(targetFile, 0o666);
            fs.writeFileSync(targetFile, '# Tampered\n');

            const result = resolveIsolatedOrchestratorRoot(tempDir);
            assert.equal(result.using_sandbox, true, 'LOG_ONLY should still use sandbox even with drift');
        });
    });

    describe('compareSandboxToLive', () => {
        it('returns match=true immediately after prepare', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            prepareSandbox(tempDir);
            const result = compareSandboxToLive(tempDir);
            assert.equal(result.match, true, 'Sandbox should match live immediately after prepare');
            assert.equal(result.live_only.length, 0);
            assert.equal(result.sandbox_only.length, 0);
            assert.equal(result.content_differs.length, 0);
        });

        it('detects content differences when live is modified', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            prepareSandbox(tempDir);

            // Modify a live file after sandbox was created
            const liveFile = path.join(tempDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
            fs.writeFileSync(liveFile, '#!/usr/bin/env node\nconsole.log("modified");\n');

            const result = compareSandboxToLive(tempDir);
            assert.equal(result.match, false, 'Sandbox should not match after live modification');
            assert.ok(
                result.content_differs.length > 0 || result.live_only.length > 0,
                'Expected content difference or live-only files'
            );
        });

        it('returns match=false when no sandbox exists', () => {
            const result = compareSandboxToLive(tempDir);
            assert.equal(result.match, false);
        });
    });

    describe('end-to-end isolation execution path', () => {
        it('full lifecycle: prepare → resolve → validate → compare', () => {
            const expectedReadOnly = !canWriteReadonlyFixture(tempDir);
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });

            // 1. Prepare sandbox
            const prepResult = prepareSandbox(tempDir);
            assert.ok(prepResult.file_count > 0, 'Sandbox should have files');
            assert.ok(prepResult.read_only_applied, 'Read-only should be applied');

            // 2. Resolve should use sandbox
            const resolution = resolveIsolatedOrchestratorRoot(tempDir);
            assert.equal(resolution.using_sandbox, true);
            assert.ok(resolution.resolved_root.includes(ISOLATION_SANDBOX_DIR));

            // 3. Validate should show clean state
            const validation = validateSandbox(tempDir);
            assert.equal(validation.exists, true);
            assert.equal(validation.manifest_valid, true);
            assert.equal(validation.drift_files.length, 0);
            assert.equal(validation.read_only_intact, expectedReadOnly);

            // 4. Compare should match
            const comparison = compareSandboxToLive(tempDir);
            assert.equal(comparison.match, true);

            // 5. Verify the sandbox contains real content from the bundle
            const sandboxRuleFile = path.join(prepResult.sandbox_root, 'live', 'docs', 'agent-rules', '00-core.md');
            assert.ok(fs.existsSync(sandboxRuleFile), 'Sandbox should contain rule files');
            const content = fs.readFileSync(sandboxRuleFile, 'utf8');
            assert.ok(content.includes('Core Rules'), 'Sandbox rule file should have real content');
        });

        it('sandbox isolation separates task worktree from control plane', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const prepResult = prepareSandbox(tempDir);

            // Verify task work directory (tempDir) is separate from sandbox
            const sandboxRoot = prepResult.sandbox_root;
            const bundleRoot = path.join(tempDir, 'garda-agent-orchestrator');

            assert.notEqual(
                path.resolve(sandboxRoot),
                path.resolve(bundleRoot),
                'Sandbox root must be distinct from live bundle root'
            );

            // Verify the sandbox is nested under runtime (not alongside it)
            assert.ok(
                sandboxRoot.includes('runtime'),
                'Sandbox should be under runtime directory'
            );

            // Resolve paths using sandbox
            const resolution = resolveIsolatedOrchestratorRoot(tempDir);
            assert.notEqual(
                resolution.resolved_root,
                bundleRoot,
                'Resolved root should point to sandbox, not live bundle'
            );
        });
    });

    describe('resolveGateExecutionPath', () => {
        it('resolves control-plane paths to sandbox when isolation is enabled', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            prepareSandbox(tempDir);

            const rulesPath = resolveGateExecutionPath(tempDir, 'live/docs/agent-rules/00-core.md');
            assert.ok(rulesPath.includes(ISOLATION_SANDBOX_DIR), 'Rule file path should be inside sandbox');
            assert.ok(fs.existsSync(rulesPath), 'Sandbox rule file should exist');

            const content = fs.readFileSync(rulesPath, 'utf8');
            assert.ok(content.includes('Core Rules'), 'Sandbox rule file content should be correct');
        });

        it('resolves config paths to sandbox when isolation is enabled', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            // Add a config file to the bundle for testing
            const pathsConfigPath = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
            fs.writeFileSync(pathsConfigPath, JSON.stringify({ metrics_path: 'runtime/metrics.jsonl' }));
            prepareSandbox(tempDir);

            const resolvedPathsConfig = resolveGateExecutionPath(tempDir, 'live/config/paths.json');
            assert.ok(resolvedPathsConfig.includes(ISOLATION_SANDBOX_DIR), 'Config path should be inside sandbox');
            assert.ok(fs.existsSync(resolvedPathsConfig), 'Sandbox config file should exist');
        });

        it('resolves output-filters config to sandbox when isolation is enabled', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const filtersConfig = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'output-filters.json');
            fs.writeFileSync(filtersConfig, JSON.stringify({ profiles: {} }));
            prepareSandbox(tempDir);

            const resolved = resolveGateExecutionPath(tempDir, 'live/config/output-filters.json');
            assert.ok(resolved.includes(ISOLATION_SANDBOX_DIR), 'Output filters path should be inside sandbox');
        });

        it('resolves bin/ paths to sandbox when isolation is enabled', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            prepareSandbox(tempDir);

            const resolved = resolveGateExecutionPath(tempDir, 'bin/garda.js');
            assert.ok(resolved.includes(ISOLATION_SANDBOX_DIR), 'bin/ path should be inside sandbox');
            assert.ok(fs.existsSync(resolved), 'Sandbox bin file should exist');
        });

        it('keeps runtime paths live even when sandbox is active', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            prepareSandbox(tempDir);

            const reviewsPath = resolveGateExecutionPath(tempDir, 'runtime/reviews/T-1011-preflight.json');
            assert.ok(!reviewsPath.includes(ISOLATION_SANDBOX_DIR), 'Runtime review path should NOT be inside sandbox');

            const metricsPath = resolveGateExecutionPath(tempDir, 'runtime/metrics.jsonl');
            assert.ok(!metricsPath.includes(ISOLATION_SANDBOX_DIR), 'Metrics path should NOT be inside sandbox');

            const taskEventsPath = resolveGateExecutionPath(tempDir, 'runtime/task-events/T-1011.jsonl');
            assert.ok(!taskEventsPath.includes(ISOLATION_SANDBOX_DIR), 'Task events path should NOT be inside sandbox');
        });

        it('keeps isolation-mode.json live to avoid circular resolution', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            prepareSandbox(tempDir);

            const isolationConfigPath = resolveGateExecutionPath(tempDir, 'live/config/isolation-mode.json');
            assert.ok(
                !isolationConfigPath.includes(ISOLATION_SANDBOX_DIR),
                'Isolation config itself should NOT route through sandbox'
            );
        });

        it('returns live paths when isolation is disabled', () => {
            const rulesPath = resolveGateExecutionPath(tempDir, 'live/docs/agent-rules/00-core.md');
            assert.ok(!rulesPath.includes(ISOLATION_SANDBOX_DIR), 'Should use live path when isolation is disabled');
            assert.ok(fs.existsSync(rulesPath), 'Live rule file should exist');
        });

        it('resolves control-plane paths through a nested deployed legacy bundle in a source checkout', () => {
            fs.rmSync(path.join(tempDir, 'garda-agent-orchestrator'), { recursive: true, force: true });
            fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator', version: '2.4.2' }), 'utf8');

            const legacyBundleRoot = path.join(tempDir, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(legacyBundleRoot, 'live', 'docs', 'agent-rules'), { recursive: true });
            fs.mkdirSync(path.join(legacyBundleRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(legacyBundleRoot, 'runtime'), { recursive: true });
            fs.mkdirSync(path.join(legacyBundleRoot, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(legacyBundleRoot, 'MANIFEST.md'), '# Manifest\n');
            fs.writeFileSync(path.join(legacyBundleRoot, 'VERSION'), '2.4.2\n');
            fs.writeFileSync(path.join(legacyBundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator', version: '2.4.2' }));
            fs.writeFileSync(path.join(legacyBundleRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
            fs.writeFileSync(path.join(legacyBundleRoot, 'live', 'docs', 'agent-rules', '00-core.md'), '# Core Rules\n');

            const rulesPath = resolveGateExecutionPath(tempDir, 'live/docs/agent-rules/00-core.md');
            assert.equal(
                rulesPath,
                path.join(legacyBundleRoot, 'live', 'docs', 'agent-rules', '00-core.md')
            );
        });

        it('accepts pre-computed resolution to avoid repeated I/O', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            prepareSandbox(tempDir);

            const resolution = resolveIsolatedOrchestratorRoot(tempDir);
            assert.equal(resolution.using_sandbox, true);

            const path1 = resolveGateExecutionPath(tempDir, 'live/docs/agent-rules/00-core.md', resolution);
            const path2 = resolveGateExecutionPath(tempDir, 'live/config/paths.json', resolution);
            const path3 = resolveGateExecutionPath(tempDir, 'runtime/metrics.jsonl', resolution);

            assert.ok(path1.includes(ISOLATION_SANDBOX_DIR), 'Rule path should use sandbox');
            assert.ok(path2.includes(ISOLATION_SANDBOX_DIR), 'Config path should use sandbox');
            assert.ok(!path3.includes(ISOLATION_SANDBOX_DIR), 'Runtime path should stay live');
        });
    });

    describe('isControlPlanePath', () => {
        it('classifies live/ paths as control plane', () => {
            assert.equal(isControlPlanePath('live/docs/agent-rules/00-core.md'), true);
            assert.equal(isControlPlanePath('live/config/paths.json'), true);
            assert.equal(isControlPlanePath('live/config/review-capabilities.json'), true);
            assert.equal(isControlPlanePath('live/config/output-filters.json'), true);
            assert.equal(isControlPlanePath('live/config/token-economy.json'), true);
            assert.equal(isControlPlanePath('live/skills/code-review/SKILL.md'), true);
        });

        it('classifies bin/ and dist/ paths as control plane', () => {
            assert.equal(isControlPlanePath('bin/garda.js'), true);
            assert.equal(isControlPlanePath('dist/index.js'), true);
        });

        it('classifies template/ paths as control plane', () => {
            assert.equal(isControlPlanePath('template/config/paths.json'), true);
        });

        it('classifies bundle root files as control plane', () => {
            assert.equal(isControlPlanePath('MANIFEST.md'), true);
            assert.equal(isControlPlanePath('VERSION'), true);
            assert.equal(isControlPlanePath('package.json'), true);
        });

        it('classifies runtime/ paths as mutable (not control plane)', () => {
            assert.equal(isControlPlanePath('runtime/reviews/T-1011-preflight.json'), false);
            assert.equal(isControlPlanePath('runtime/metrics.jsonl'), false);
            assert.equal(isControlPlanePath('runtime/task-events/T-1011.jsonl'), false);
            assert.equal(isControlPlanePath('runtime/init-answers.json'), false);
        });

        it('excludes isolation-mode.json from sandbox routing', () => {
            assert.equal(isControlPlanePath('live/config/isolation-mode.json'), false);
        });
    });

    describe('sandbox-backed gate execution flow', () => {
        it('classify-change reads config from sandbox when isolation is enabled', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            // Write a real paths.json with custom config
            const pathsConfig = {
                runtime_roots: ['src/', 'app/'],
                fast_path_roots: ['frontend/']
            };
            fs.writeFileSync(
                path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'paths.json'),
                JSON.stringify(pathsConfig)
            );
            // Write review-capabilities
            fs.writeFileSync(
                path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json'),
                JSON.stringify({ code: true, db: true, security: true, refactor: true })
            );
            prepareSandbox(tempDir);

            // Now tamper with the LIVE config to prove the gate reads from sandbox
            fs.writeFileSync(
                path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'paths.json'),
                JSON.stringify({ runtime_roots: ['tampered/'] })
            );

            const config = getClassificationConfig(tempDir);
            // The sandbox config should have the original value, not 'tampered/'
            const runtimeRootsJoined = config.runtime_roots.join(',');
            assert.ok(
                runtimeRootsJoined.includes('src/') || runtimeRootsJoined.includes('app/'),
                `Expected sandbox config runtime_roots to contain original values. Got: ${runtimeRootsJoined}`
            );
            assert.ok(
                !runtimeRootsJoined.includes('tampered/'),
                'Config should NOT contain tampered value when reading from sandbox'
            );
        });

        it('classify-change reads review-capabilities from sandbox when isolation is enabled', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            fs.writeFileSync(
                path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json'),
                JSON.stringify({ code: true, db: true, security: true, refactor: true, api: true })
            );
            prepareSandbox(tempDir);

            // Tamper live
            fs.writeFileSync(
                path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json'),
                JSON.stringify({ code: false, db: false, security: false, refactor: false, api: false })
            );

            const capabilities = getReviewCapabilities(tempDir);
            assert.equal(capabilities.api, true, 'Should read api=true from sandbox, not false from tampered live');
        });

        it('rule file resolution routes through sandbox when isolation is enabled', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            // Add required rule files
            const rulesDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
            fs.writeFileSync(path.join(rulesDir, '40-commands.md'), '# Commands\n### Compile Gate (Mandatory)\n```\nnpm run build\n```\n');
            fs.writeFileSync(path.join(rulesDir, '80-task-workflow.md'), '# Task Workflow\n');
            fs.writeFileSync(path.join(rulesDir, '90-skill-catalog.md'), '# Skill Catalog\n');
            prepareSandbox(tempDir);

            // Tamper live rule file
            fs.writeFileSync(path.join(rulesDir, '00-core.md'), '# TAMPERED Core Rules\n');

            // resolveGateExecutionPath should point to sandbox
            const sandboxedPath = resolveGateExecutionPath(tempDir, 'live/docs/agent-rules/00-core.md');
            assert.ok(sandboxedPath.includes(ISOLATION_SANDBOX_DIR));
            const sandboxContent = fs.readFileSync(sandboxedPath, 'utf8');
            assert.ok(sandboxContent.includes('Core Rules'), 'Sandbox should have original content');
            assert.ok(!sandboxContent.includes('TAMPERED'), 'Sandbox should NOT have tampered content');
        });

        it('compile-gate commands path resolves through sandbox', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const rulesDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
            fs.writeFileSync(path.join(rulesDir, '40-commands.md'), '# Commands\n### Compile Gate (Mandatory)\n```\nnpm run build\n```\n');
            prepareSandbox(tempDir);

            const resolved = resolveGateExecutionPath(tempDir, 'live/docs/agent-rules/40-commands.md');
            assert.ok(resolved.includes(ISOLATION_SANDBOX_DIR), 'Compile commands should resolve from sandbox');
            assert.ok(fs.existsSync(resolved), 'Commands file should exist in sandbox');

            // Read and verify content is from sandbox
            const content = fs.readFileSync(resolved, 'utf8');
            assert.ok(content.includes('npm run build'), 'Sandbox commands file should have original compile commands');
        });

        it('live mutations do not affect sandbox-backed gate reads', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            fs.writeFileSync(
                path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'output-filters.json'),
                JSON.stringify({ profiles: { test_success: { max_matches: 5 } } })
            );
            prepareSandbox(tempDir);

            // Tamper live
            fs.writeFileSync(
                path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'output-filters.json'),
                JSON.stringify({ profiles: { test_success: { max_matches: 999 } } })
            );

            const resolvedPath = resolveGateExecutionPath(tempDir, 'live/config/output-filters.json');
            const content = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
            assert.equal(
                content.profiles.test_success.max_matches, 5,
                'Should read original value from sandbox, not tampered live value'
            );
        });
    });
});
