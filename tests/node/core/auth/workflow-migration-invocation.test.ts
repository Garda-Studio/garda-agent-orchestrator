import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { authenticateWorkflowMigration, isAuthenticatedWorkflowMigration } from '../../../../src/core/auth/local-commit-availability';
import { withInvocationReadObservation, registerInvocationDependency } from '../../../../src/core/invocation-read-observation';
import { observedInvocationValue, readInvocationPathObservation } from '../../../../src/core/invocation-file-observation';

function workspaceIdentityDigest(repoRoot: string, gitDirectory: string, identity: fs.BigIntStats): string {
    const normalize = (input: string): string => {
        const resolved = path.resolve(input).replace(/\\/gu, '/');
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return createHash('sha256').update(JSON.stringify([
        normalize(fs.realpathSync.native(repoRoot)), normalize(fs.realpathSync.native(gitDirectory)),
        String(identity.dev), String(identity.ino), String(identity.birthtimeNs)
    ])).digest('hex');
}

function assertNativeAuthenticationIdentity(repoRoot: string, gitDirectory: string,
    record: ReturnType<typeof authenticateWorkflowMigration>): void {
    const raw = fs.statSync(fs.realpathSync.native(repoRoot), { bigint: true });
    const expected = workspaceIdentityDigest(repoRoot, gitDirectory, raw);
    assert.equal(record.workflow_migration_authentication.workspace_identity_sha256, expected);
    withInvocationReadObservation(() => {
        const completed = observedInvocationValue(readInvocationPathObservation(repoRoot)!.targetIdentity);
        const completedDigest = workspaceIdentityDigest(repoRoot, gitDirectory, completed);
        if (raw.dev !== completed.dev || raw.ino !== completed.ino || raw.birthtimeNs !== completed.birthtimeNs) {
            assert.notEqual(expected, completedDigest,
                'Descriptor-completed identity must not substitute the native signed protocol fields.');
        }
        assert.equal(isAuthenticatedWorkflowMigration(repoRoot, record), true);
        assert.equal(isAuthenticatedWorkflowMigration(repoRoot, record), true);
    });
}

test('Q3 migration authentication preserves native stat identity in an ordinary Git workspace', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q3-migration-native-'));
    try {
        execFileSync('git', ['init', '--quiet', repoRoot]);
        const record = authenticateWorkflowMigration(repoRoot, {
            event_source: 'workflow-config-set', command: 'lifecycle configuration migration',
            mutation_source: 'lifecycle', migration_version: 1, permissions_preserved: true
        });
        assertNativeAuthenticationIdentity(repoRoot, path.join(repoRoot, '.git'), record);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('Q3 migration authentication retains the exact linked-worktree Git pointer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q3-migration-pointer-'));
    try {
        const repoRoot = path.join(root, 'worktree'), gitDirectory = path.join(root, 'git-metadata');
        fs.mkdirSync(repoRoot);
        execFileSync('git', ['init', '--quiet', '--separate-git-dir', gitDirectory, repoRoot]);
        const record = authenticateWorkflowMigration(repoRoot, {
            event_source: 'workflow-config-set', command: 'lifecycle configuration migration',
            mutation_source: 'lifecycle', migration_version: 1, permissions_preserved: true
        });
        assert.equal(isAuthenticatedWorkflowMigration(repoRoot, record), true);
        assertNativeAuthenticationIdentity(repoRoot, gitDirectory, record);
        const pointerPath = path.join(repoRoot, '.git'), original = fs.readFileSync(pointerPath);
        assert.throws(() => withInvocationReadObservation(() => {
            // Native parsing trims this whitespace: the proof result alone cannot detect the change.
            registerInvocationDependency({}, () => fs.appendFileSync(pointerPath, '\n'));
            assert.equal(isAuthenticatedWorkflowMigration(repoRoot, record), true);
        }), /Invocation file observation changed/u);
        fs.writeFileSync(pointerPath, original, { flag: 'r+' });
        fs.truncateSync(pointerPath, original.length);
        assert.equal(isAuthenticatedWorkflowMigration(repoRoot, record), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('Q3 native zero-device protocol identity is not replaced by descriptor-completed identity', {
    skip: process.platform !== 'win32'
}, () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q3-native-zero-'));
    const native = require('node:fs') as { statSync: typeof fs.statSync };
    const original = native.statSync;
    try {
        execFileSync('git', ['init', '--quiet', repoRoot]);
        const canonicalRoot = fs.realpathSync.native(repoRoot).toLowerCase();
        native.statSync = ((target: fs.PathLike, options?: fs.StatOptions) => {
            const stat = Reflect.apply(original, native, [target, options]) as fs.Stats | fs.BigIntStats;
            if (options?.bigint === true && path.resolve(String(target)).toLowerCase() === canonicalRoot)
                Object.defineProperty(stat, 'dev', { value: 0n, writable: true, enumerable: true, configurable: true });
            return stat;
        }) as typeof original;
        const record = authenticateWorkflowMigration(repoRoot, {
            event_source: 'workflow-config-set', command: 'lifecycle configuration migration',
            mutation_source: 'lifecycle', migration_version: 1, permissions_preserved: true
        });
        withInvocationReadObservation(() => {
            assert.notEqual(observedInvocationValue(readInvocationPathObservation(repoRoot)!.targetIdentity).dev, 0n);
            assert.equal(isAuthenticatedWorkflowMigration(repoRoot, record), true);
            assert.equal(isAuthenticatedWorkflowMigration(repoRoot, record), true);
        });
    } finally { native.statSync = original; fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
