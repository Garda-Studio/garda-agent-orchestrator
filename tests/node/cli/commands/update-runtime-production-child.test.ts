import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeCacheModule(resolvedPath: string, exportsValue: Record<string, unknown>): NodeJS.Module {
    return {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        exports: exportsValue
    } as NodeJS.Module;
}

describe('production update runtime child', () => {
    it('binds the installed bundle and forwards the validated lifecycle contract', (context) => {
        const handoffPath = require.resolve('../../../../src/cli/commands/update-runtime-handoff');
        const updatePath = require.resolve('../../../../src/lifecycle/update');
        const originalHandoff = require.cache[handoffPath];
        const originalUpdate = require.cache[updatePath];
        const bundleRoot = path.resolve(path.dirname(handoffPath), '..', '..', '..', '..');
        let received: Record<string, unknown> | null = null;
        context.after(() => {
            if (originalHandoff) require.cache[handoffPath] = originalHandoff;
            else delete require.cache[handoffPath];
            if (originalUpdate) require.cache[updatePath] = originalUpdate;
            else delete require.cache[updatePath];
        });
        require.cache[updatePath] = makeCacheModule(updatePath, {
            runUpdate(options: Record<string, unknown>) {
                received = options;
                return { previousVersion: '1.0.0', updatedVersion: '1.1.0' };
            }
        });
        delete require.cache[handoffPath];

        const { runUpdateRuntimeHandoff } = require(handoffPath) as typeof import('../../../../src/cli/commands/update-runtime-handoff');
        const runnerOptions = {
            targetRoot: path.dirname(bundleRoot),
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
            noPrompt: true,
            skipVerify: true,
            skipManifestValidation: true,
            trustPolicy: 'enforced',
            trustOverrideUsed: false,
            trustOverrideSource: 'none',
            sourceType: 'npm',
            sourceReference: 'garda-agent-orchestrator@1.1.0',
            resolvedPackageIntegrity: 'sha512-test',
            lifecycleLockAlreadyHeld: true
        };
        const result = runUpdateRuntimeHandoff({ bundleRoot, runnerOptions, fallbackDryRun: false });
        assert.notEqual(received, null);
        const captured = received as unknown as Record<string, unknown>;
        assert.equal(result.updatedVersion, '1.1.0');
        assert.equal(captured.bundleRoot, bundleRoot);
        assert.equal(captured.lifecycleLockAlreadyHeld, true);
        assert.deepEqual(captured.trustContext, {
            policy: 'enforced',
            overrideUsed: false,
            overrideSource: 'none',
            sourceType: 'npm',
            sourceReference: 'garda-agent-orchestrator@1.1.0',
            gitCommitSha: null,
            requestedPackageSpec: null,
            exactPackageSpec: null,
            resolvedPackageVersion: null,
            resolvedPackageIntegrity: 'sha512-test',
            releaseProvenanceStatus: null,
            releaseProvenanceSummary: null,
            releaseProvenanceRecommendation: null
        });
        assert.equal(typeof captured.contractMigrationRunner, 'function');
        assert.equal(typeof captured.verifyRunner, 'function');
        assert.equal(typeof captured.manifestRunner, 'function');
        assert.throws(() => runUpdateRuntimeHandoff({
            bundleRoot: os.tmpdir(), runnerOptions, fallbackDryRun: false
        }), /unbound bundle/);
        assert.throws(() => runUpdateRuntimeHandoff({
            bundleRoot, runnerOptions: { ...runnerOptions, trustPolicy: 'unknown' }, fallbackDryRun: false
        }), /unbound bundle or source/);
    });

    it('runs the production entry in a child and returns a bounded error frame', () => {
        const handoffPath = require.resolve('../../../../src/cli/commands/update-runtime-handoff');
        const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-foreign-bundle-'));
        try {
            const child = spawnSync(process.execPath, [handoffPath], {
                input: JSON.stringify({ bundleRoot: foreignRoot, runnerOptions: { trustPolicy: 'enforced' } }),
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                windowsHide: true
            });
            assert.equal(child.status, 1);
            assert.match(JSON.parse(String(child.output[3])).error, /unbound bundle/);
        } finally {
            fs.rmSync(foreignRoot, { recursive: true, force: true });
        }
    });
});
