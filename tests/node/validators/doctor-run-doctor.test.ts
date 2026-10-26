import { runGit } from '../../../src/core/git-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runDoctor,
    formatDoctorResult
} from '../../../src/validators/doctor';
import {
    writeProtectedControlPlaneManifest
} from '../../../src/gates/shared/helpers';
import { createDoctorWorkspace, seedStaleLock } from './doctor-workspace-builder';

function writeDoctorFixtureFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function seedMatchingSourceCheckoutParity(tmpDir: string, bundlePath: string) {
    writeDoctorFixtureFile(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'garda-agent-orchestrator', version: '1.0.0' }, null, 2)
    );
    writeDoctorFixtureFile(path.join(tmpDir, 'VERSION'), '1.0.0\n');
    writeDoctorFixtureFile(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n');
    writeDoctorFixtureFile(path.join(tmpDir, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
    writeDoctorFixtureFile(path.join(tmpDir, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'VERSION'), '1.0.0\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2));
    writeDoctorFixtureFile(path.join(bundlePath, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'template', 'AGENTS.md'), '# template\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'template', 'config', 'garda.config.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'runtime', 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude'
    }, null, 2));
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'review-capabilities.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'paths.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'token-economy.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'output-filters.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'skill-packs.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'optional-skill-selection-policy.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'isolation-mode.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'profiles.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'skills-index.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'skills-headlines.json'), '{}\n');
    writeDoctorFixtureFile(path.join(bundlePath, 'live', 'config', 'garda.config.json'), '{}\n');

    const now = new Date();
    fs.utimesSync(path.join(tmpDir, 'bin', 'garda.js'), now, now);
    fs.utimesSync(path.join(bundlePath, 'bin', 'garda.js'), now, now);
}


test('runDoctor throws for missing bundle', () => {
    const ws = createDoctorWorkspace({ skipManifest: true });
    // Remove the bundle dir entirely — only a bare tmpDir should exist
    fs.rmSync(ws.bundlePath, { recursive: true, force: true });
    try {
        assert.throws(
            () => runDoctor({
                targetRoot: ws.tmpDir,
                sourceOfTruth: 'Claude'
            }),
            /Deployed bundle not found/
        );
    } finally {
        ws.cleanup();
    }
});

test('runDoctor runs verify and manifest validation when bundle exists', () => {
    const ws = createDoctorWorkspace({ manifestContent: '- bin/garda.js\n- src/index.ts\n' });
    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(typeof result.passed, 'boolean');
        assert.ok(result.verifyResult);
        assert.ok(result.manifestResult);
        assert.equal(result.manifestResult.passed, true);
        assert.equal(result.manifestError, null);
    } finally {
        ws.cleanup();
    }
});

test('runDoctor reports manifest error for missing MANIFEST.md', () => {
    const ws = createDoctorWorkspace({ skipManifest: true });
    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.passed, false);
        assert.ok(result.manifestError !== null);
    } finally {
        ws.cleanup();
    }
});

test('runDoctor detects manifest duplicates', () => {
    const ws = createDoctorWorkspace({ manifestContent: '- file.txt\n- file.txt\n' });
    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.passed, false);
        assert.ok(result.manifestResult);
        assert.equal(result.manifestResult.passed, false);
        assert.equal(result.manifestResult.duplicates.length, 1);
    } finally {
        ws.cleanup();
    }
});


test('runDoctor reports stale task-event locks and supports dry-run cleanup output', () => {
    const ws = createDoctorWorkspace();
    const eventsRoot = path.join(ws.bundlePath, 'runtime', 'task-events');
    const staleLockPath = path.join(eventsRoot, '.T-005.lock');
    seedStaleLock(staleLockPath);

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude',
            cleanupStaleLocks: true,
            dryRun: true
        });
        assert.equal(result.passed, false);
        assert.equal(result.lockHealth.stale_count, 1);
        assert.ok(result.lockCleanup !== null);
        assert.deepEqual(result.lockCleanup!.removable_stale_locks, ['.T-005.lock']);
        assert.ok(fs.existsSync(staleLockPath), 'dry-run must not remove stale locks');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Task-Event Lock Cleanup'));
        assert.ok(output.includes('Mode: DRY_RUN'));
        assert.ok(output.includes('.T-005.lock: STALE'));
    } finally {
        ws.cleanup();
    }
});

test('runDoctor reports and cleans stale review-artifact locks', () => {
    const ws = createDoctorWorkspace();
    const reviewsRoot = path.join(ws.bundlePath, 'runtime', 'reviews');
    const staleLockPath = path.join(reviewsRoot, 'T-006-code.md.lock');
    seedStaleLock(staleLockPath, { ageMinutes: 31 });

    try {
        const dryRun = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude',
            cleanupStaleLocks: true,
            dryRun: true
        });
        assert.equal(dryRun.passed, false);
        assert.ok(dryRun.reviewLockHealth);
        assert.equal(dryRun.reviewLockHealth!.stale_count, 1);
        assert.ok(dryRun.reviewLockCleanup !== null);
        assert.deepEqual(dryRun.reviewLockCleanup!.removable_stale_locks, ['T-006-code.md.lock']);
        assert.ok(fs.existsSync(staleLockPath), 'dry-run must not remove stale review-artifact locks');

        const applied = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude',
            cleanupStaleLocks: true,
            dryRun: false
        });
        assert.ok(applied.reviewLockCleanup !== null);
        assert.deepEqual(applied.reviewLockCleanup!.removed_locks, ['T-006-code.md.lock']);
        assert.equal(fs.existsSync(staleLockPath), false, 'doctor cleanup should remove stale review-artifact lock');

        const output = formatDoctorResult(dryRun);
        assert.ok(output.includes('Review Artifact Lock Cleanup'));
        assert.ok(output.includes('Review Artifact Locks'));
        assert.ok(output.includes('T-006-code.md.lock: STALE'));
    } finally {
        ws.cleanup();
    }
});

test('runDoctor reports stale completion finalization locks without auto-cleanup', () => {
    const ws = createDoctorWorkspace();
    const reviewsRoot = path.join(ws.bundlePath, 'runtime', 'reviews');
    const staleLockPath = path.join(reviewsRoot, 'T-006-completion-gate.lock');
    seedStaleLock(staleLockPath, { ageMinutes: 31 });

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude',
            cleanupStaleLocks: true,
            dryRun: true
        });
        assert.equal(result.passed, false);
        assert.ok(result.completionFinalizationLockHealth);
        assert.equal(result.completionFinalizationLockHealth!.stale_count, 1);
        assert.equal(fs.existsSync(staleLockPath), true, 'doctor cleanup must not remove completion finalization locks');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Completion Finalization Locks'));
        assert.ok(output.includes('doctor --cleanup-stale-locks does not remove completion finalization locks automatically.'));
        assert.ok(output.includes('T-006-completion-gate.lock: STALE'));
    } finally {
        ws.cleanup();
    }
});

test('runDoctor reports the shared stale reviews-index lock in review-artifact diagnostics', () => {
    const ws = createDoctorWorkspace();
    const runtimeDir = path.join(ws.bundlePath, 'runtime');
    const staleLockPath = path.join(runtimeDir, '.reviews-index.lock');
    seedStaleLock(staleLockPath, { ageMinutes: 31 });

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.passed, false);
        assert.ok(result.reviewLockHealth);
        assert.ok(result.reviewLockHealth!.locks.some((lock: { lock_name: string; status: string }) => lock.lock_name === '.reviews-index.lock' && lock.status === 'STALE'));

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Review Artifact Locks'));
        assert.ok(output.includes('.reviews-index.lock: STALE'));
    } finally {
        ws.cleanup();
    }
});

test('runDoctor fails when forbidden reviewer scratch artifacts are left at the repository root', () => {
    const ws = createDoctorWorkspace();
    writeDoctorFixtureFile(path.join(ws.tmpDir, 'Review-Output.md'), '# Review output\n');

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.rootScratchArtifactEvidence.passed, false);
        assert.deepEqual(
            result.rootScratchArtifactEvidence.found.map((entry) => entry.name),
            ['Review-Output.md']
        );
        assert.deepEqual(
            result.rootScratchArtifactEvidence.found.map((entry) => entry.expected_name),
            ['review-output.md']
        );
        assert.equal(result.passed, false);

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Root Reviewer Scratch Artifacts'));
        assert.ok(output.includes('Review-Output.md'));
        assert.ok(output.includes('runtime/tmp/reviews/<task-id>/<review-type>/'));
    } finally {
        ws.cleanup();
    }
});


test('runDoctor includes provider compliance result when activeAgentFiles provided', () => {
    const ws = createDoctorWorkspace();
    const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
    const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';
    fs.mkdirSync(path.join(ws.tmpDir, '.agents', 'workflows'), { recursive: true });
    fs.writeFileSync(
        path.join(ws.tmpDir, '.agents', 'workflows', 'start-task.md'),
        [MANAGED_START, '# Start Task', 'Shared router.', MANAGED_END].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        path.join(ws.tmpDir, 'AGENTS.md'),
        [MANAGED_START, '# AGENTS.md', 'open `.agents/workflows/start-task.md`.', MANAGED_END].join('\n'),
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Codex',
            activeAgentFiles: ['AGENTS.md']
        });
        assert.ok(result.providerComplianceResult !== null);
        assert.equal(result.providerComplianceResult!.passed, true);
        assert.equal(result.providerComplianceResult!.routerExists, true);

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Provider Control Compliance'));
        assert.ok(output.includes('Status: PASSED'));
    } finally {
        ws.cleanup();
    }
});

test('runDoctor fails when active entrypoint has compliance drift', () => {
    const ws = createDoctorWorkspace();
    const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
    const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';
    fs.mkdirSync(path.join(ws.tmpDir, '.agents', 'workflows'), { recursive: true });
    fs.writeFileSync(
        path.join(ws.tmpDir, '.agents', 'workflows', 'start-task.md'),
        [MANAGED_START, '# Start Task', 'Shared router.', MANAGED_END].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        path.join(ws.tmpDir, 'CLAUDE.md'),
        [MANAGED_START, '# CLAUDE.md', 'No router ref.', MANAGED_END].join('\n'),
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude',
            activeAgentFiles: ['CLAUDE.md']
        });
        assert.ok(result.providerComplianceResult !== null);
        assert.equal(result.providerComplianceResult!.passed, false);
        assert.equal(result.passed, false);

        const output = formatDoctorResult(result);
        assert.ok(output.includes('DRIFT_DETECTED'));
    } finally {
        ws.cleanup();
    }
});


test('runDoctor detects nested bundle duplication in real workspace', () => {
    const ws = createDoctorWorkspace();
    const nestedBundlePath = path.join(ws.bundlePath, 'garda-agent-orchestrator', 'bin');
    fs.mkdirSync(nestedBundlePath, { recursive: true });
    fs.writeFileSync(path.join(nestedBundlePath, 'garda.js'), '#!/usr/bin/env node', 'utf8');

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.nestedBundleDuplication.duplicatesFound, true);
        assert.ok(result.nestedBundleDuplication.duplicatePaths.length > 0);
        assert.equal(result.passed, false, 'doctor overall verdict should fail when nested duplication is detected');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Nested Bundle Duplication'));
        assert.ok(output.includes('DUPLICATES_FOUND'));
    } finally {
        ws.cleanup();
    }
});


test('runDoctor surfaces protected-manifest MATCH when trusted manifest is current', () => {
    const ws = createDoctorWorkspace();
    writeProtectedControlPlaneManifest(ws.tmpDir);

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(result.protectedManifestEvidence !== null);
        assert.equal(result.protectedManifestEvidence!.status, 'MATCH');
        const output = formatDoctorResult(result);
        assert.ok(output.includes('Protected Control-Plane Manifest'));
        assert.ok(output.includes('Status: MATCH'));
    } finally {
        ws.cleanup();
    }
});

test('runDoctor surfaces protected-manifest DRIFT and fails overall', () => {
    const ws = createDoctorWorkspace();
    const distDir = path.join(ws.bundlePath, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.js'), 'console.log("hi");', 'utf8');

    const runtimeDir = path.join(ws.bundlePath, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
        path.join(runtimeDir, 'protected-control-plane-manifest.json'),
        JSON.stringify({
            schema_version: 1,
            event_source: 'refresh-protected-control-plane-manifest',
            timestamp_utc: new Date().toISOString(),
            workspace_root: ws.tmpDir.replace(/\\/g, '/'),
            orchestrator_root: ws.bundlePath.replace(/\\/g, '/'),
            protected_roots: ['garda-agent-orchestrator/dist'],
            protected_snapshot: {
                'garda-agent-orchestrator/dist/index.js': 'stale-hash-does-not-match'
            },
            is_source_checkout: false
        }, null, 2),
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(result.protectedManifestEvidence !== null);
        assert.equal(result.protectedManifestEvidence!.status, 'DRIFT');
        assert.ok(result.protectedManifestEvidence!.changed_files.length > 0);
        assert.equal(result.passed, false, 'doctor should fail on protected-manifest DRIFT');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Protected Control-Plane Manifest'));
        assert.ok(output.includes('Status: DRIFT'));
        assert.ok(output.includes('DriftCount:'));
        assert.ok(output.includes('Doctor: FAIL'));
    } finally {
        ws.cleanup();
    }
});

test('runDoctor classifies source-checkout protected-manifest DRIFT as informational', () => {
    const ws = createDoctorWorkspace();
    seedMatchingSourceCheckoutParity(ws.tmpDir, ws.bundlePath);
    writeProtectedControlPlaneManifest(ws.tmpDir);
    writeDoctorFixtureFile(path.join(ws.tmpDir, 'src', 'cli', 'doctor-helper.ts'), 'export const changed = true;\n');
    writeDoctorFixtureFile(path.join(ws.tmpDir, 'dist', 'src', 'index.js'), 'module.exports = { changed: true };\n');

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(result.protectedManifestEvidence !== null);
        assert.equal(result.protectedManifestEvidence!.status, 'DRIFT');
        assert.ok(result.protectedManifestAssessment !== null);
        assert.equal(result.protectedManifestAssessment!.code, 'INFO_SOURCE_CHECKOUT');
        assert.equal(result.protectedManifestAssessment!.blocks, false);

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Protected Control-Plane Manifest'));
        assert.ok(output.includes('Assessment: INFO_SOURCE_CHECKOUT'));
    } finally {
        ws.cleanup();
    }
});

test('runDoctor surfaces protected-manifest INVALID and fails overall', () => {
    const ws = createDoctorWorkspace();
    const runtimeDir = path.join(ws.bundlePath, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
        path.join(runtimeDir, 'protected-control-plane-manifest.json'),
        '{ malformed json',
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(result.protectedManifestEvidence !== null);
        assert.equal(result.protectedManifestEvidence!.status, 'INVALID');
        assert.equal(result.passed, false, 'doctor should fail on protected-manifest INVALID');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Status: INVALID'));
        assert.ok(output.includes('regenerate'));
    } finally {
        ws.cleanup();
    }
});


test('runDoctor fails when update sentinel is present', () => {
    const { writeUpdateSentinel } = require('../../../src/lifecycle/common');
    const ws = createDoctorWorkspace({ manifestContent: '- bin/garda.js\n' });
    fs.mkdirSync(path.join(ws.bundlePath, 'runtime'), { recursive: true });

    writeUpdateSentinel(ws.bundlePath, {
        startedAt: '2026-04-01T10:00:00.000Z',
        fromVersion: '2.3.0',
        toVersion: '2.4.0'
    });

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.passed, false);
        assert.equal(result.partialStateEvidence.passed, false);
        assert.ok(result.partialStateEvidence.update_sentinel !== null);

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Partial State'));
        assert.ok(output.includes('DETECTED'));
        assert.ok(output.includes('Interrupted update'));
    } finally {
        ws.cleanup();
    }
});


test('runDoctor includes all four new evidence fields', () => {
    const ws = createDoctorWorkspace({ manifestContent: '- bin/garda.js\n' });
    fs.mkdirSync(path.join(ws.bundlePath, 'runtime'), { recursive: true });

    try {
        const result = runDoctor({
            targetRoot: ws.tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(typeof result.runtimeMismatchEvidence === 'object');
        assert.ok(typeof result.runtimeMismatchEvidence.passed === 'boolean');
        assert.ok(typeof result.permissionEvidence === 'object');
        assert.ok(typeof result.permissionEvidence.passed === 'boolean');
        assert.ok(typeof result.partialStateEvidence === 'object');
        assert.ok(typeof result.partialStateEvidence.passed === 'boolean');
        assert.ok(typeof result.rollbackHealthEvidence === 'object');
        assert.ok(typeof result.rollbackHealthEvidence.passed === 'boolean');

        assert.equal(result.runtimeMismatchEvidence.passed, true);
        assert.equal(result.partialStateEvidence.passed, true);
    } finally {
        ws.cleanup();
    }
});


test('runDoctor includes profile health evidence when profiles.json exists', () => {
    const ws = createDoctorWorkspace({ manifestContent: '- bin/garda.js\n- package.json\n' });
    const configDir = path.join(ws.bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: { description: 'Default', depth: 2 },
            fast: { description: 'Fast', depth: 1 }
        },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = runDoctor({ targetRoot: ws.tmpDir, sourceOfTruth: 'Claude' });
        assert.ok(result.profileHealthEvidence !== null);
        assert.equal(result.profileHealthEvidence!.passed, true);
        assert.equal(result.profileHealthEvidence!.active_profile, 'balanced');
    } finally {
        ws.cleanup();
    }
});

test('runDoctor fails when profiles.json has dangling active_profile', () => {
    const ws = createDoctorWorkspace({ manifestContent: '- bin/garda.js\n- package.json\n' });
    const configDir = path.join(ws.bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'nonexistent',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = runDoctor({ targetRoot: ws.tmpDir, sourceOfTruth: 'Claude' });
        assert.ok(result.profileHealthEvidence !== null);
        assert.equal(result.profileHealthEvidence!.passed, false);
        assert.equal(result.passed, false, 'doctor should fail when profile config has violations');
    } finally {
        ws.cleanup();
    }
});


test('G1 doctor warns on tracked bundle and provides a disk-preserving untrack command', () => {
    const ws = createDoctorWorkspace();
    try {
        runGit(ws.tmpDir, ['init']);
        runGit(ws.tmpDir, ['add', '-f', 'garda-agent-orchestrator/']);
        const result = runDoctor({ targetRoot: ws.tmpDir, sourceOfTruth: 'Claude' });
        assert.match(formatDoctorResult(result), /Installed Garda bundle files are tracked/);
        const tracked = runGit(ws.tmpDir, ['ls-files', '-z']).split('\0').filter(Boolean)[0];
        const objectId = runGit(ws.tmpDir, ['rev-parse', `:${tracked}`]).trim();
        runGit(ws.tmpDir, ['rm', '-r', '--cached', '--', 'garda-agent-orchestrator/']);
        runGit(ws.tmpDir, ['update-index', '--add', '--cacheinfo', '100644', objectId,
            tracked.replace('garda-agent-orchestrator/', 'GARDA-AGENT-ORCHESTRATOR/')]);
        const aliasResult = formatDoctorResult(runDoctor({ targetRoot: ws.tmpDir, sourceOfTruth: 'Claude' }));
        assert.match(aliasResult, /Installed Garda bundle files are tracked/);
        assert.match(aliasResult, /git rm -r --cached -- ":\(top,icase\)garda-agent-orchestrator"/);

        fs.writeFileSync(path.join(ws.tmpDir, 'package.json'), '{"name":"garda-agent-orchestrator"}');
        assert.doesNotMatch(formatDoctorResult(runDoctor({ targetRoot: ws.tmpDir, sourceOfTruth: 'Claude' })), /Installed Garda bundle files are tracked/);
    } finally { fs.rmSync(ws.tmpDir, { recursive: true, force: true }); }
});
