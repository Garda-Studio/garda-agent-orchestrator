import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectUpdateAnnouncements } from '../../../src/lifecycle/update-announcements';
import { buildUpdateReportLines, buildUpdateResult } from '../../../src/lifecycle/update-reporting';

function makeTempBundleRoot(): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-announcements-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    return bundleRoot;
}

function cleanupBundleRoot(bundleRoot: string): void {
    fs.rmSync(path.dirname(bundleRoot), { recursive: true, force: true });
}

test('collectUpdateAnnouncements returns unseen registry messages and release notes across crossed versions', () => {
    const bundleRoot = makeTempBundleRoot();
    try {
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'update-messages.json'),
            JSON.stringify({
                messages: [
                    {
                        version: '1.0.1',
                        title: 'Minor registry note',
                        body: ['Refresh local review caches after update.']
                    },
                    {
                        version: '1.1.0-rc.1',
                        title: 'Major registry note',
                        body: ['Re-check new workflow affordances.']
                    }
                ]
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(bundleRoot, 'CHANGELOG.md'),
            [
                '# Changelog',
                '',
                '## Unreleased',
                '- pending',
                '',
                '## v1.1.0-rc.1',
                '- added versioned notes',
                '',
                '## 1.0.1',
                '- fixed update rendering',
                '',
                '## 1.0.0',
                '- initial release'
            ].join('\n'),
            'utf8'
        );

        const result = collectUpdateAnnouncements(bundleRoot, '1.0.0', '1.1.0-rc.1');
        assert.deepEqual(result.updateMessages.map((entry) => entry.version), ['1.0.1', '1.1.0-rc.1']);
        assert.deepEqual(result.releaseNotes.map((entry) => entry.version), ['1.0.1', '1.1.0-rc.1']);
        assert.equal(result.updateMessages[1]?.title, 'Major registry note');
        assert.deepEqual(result.releaseNotes[0]?.lines, ['- fixed update rendering']);
        assert.deepEqual(result.releaseNotes[1]?.lines, ['- added versioned notes']);
    } finally {
        cleanupBundleRoot(bundleRoot);
    }
});

test('release 1.1.0 registry announces project memory refresh', () => {
    const repoRoot = process.cwd();
    const bundleRoot = makeTempBundleRoot();
    const liveConfigDir = path.join(bundleRoot, 'live', 'config');
    try {
        fs.copyFileSync(
            path.join(repoRoot, 'template', 'config', 'update-messages.json'),
            path.join(liveConfigDir, 'update-messages.json')
        );
        fs.writeFileSync(
            path.join(bundleRoot, 'CHANGELOG.md'),
            [
                '# Changelog',
                '',
                '## 1.1.0',
                '- release note'
            ].join('\n'),
            'utf8'
        );

        const result = collectUpdateAnnouncements(bundleRoot, '1.0.0', '1.1.0');
        const message = result.updateMessages.find((entry) => entry.version === '1.1.0');
        assert.equal(message?.title, 'Project memory refresh');
        assert.ok(message?.body.some((line) => line.includes('project-memory refresh prompt')));
        assert.ok(message?.body.some((line) => line.includes('full-suite validation placement to after_compile_before_reviews')));
    } finally {
        cleanupBundleRoot(bundleRoot);
    }
});

test('release 1.3.0 registry announces review actions and F-task policy checks', () => {
    const repoRoot = process.cwd();
    const bundleRoot = makeTempBundleRoot();
    const liveConfigDir = path.join(bundleRoot, 'live', 'config');
    try {
        fs.copyFileSync(
            path.join(repoRoot, 'template', 'config', 'update-messages.json'),
            path.join(liveConfigDir, 'update-messages.json')
        );
        fs.writeFileSync(
            path.join(bundleRoot, 'CHANGELOG.md'),
            ['# Changelog', '', '## 1.3.0', '- release note'].join('\n'),
            'utf8'
        );

        const result = collectUpdateAnnouncements(bundleRoot, '1.2.0', '1.3.0');
        const message = result.updateMessages.find((entry) => entry.version === '1.3.0');
        assert.equal(message?.title, 'Review finding actions, F-task policies, and faster navigation');
        assert.ok(message?.body.some((line) => line.includes('fix_now')));
        assert.ok(message?.body.some((line) => line.includes('grouped_by_parent')));
        assert.ok(message?.body.some((line) => line.includes('per_finding')));
        assert.ok(message?.body.some((line) => line.includes('garda ui --actions')));
        assert.ok(message?.body.some((line) => line.includes('garda profile current')));
        assert.equal(message?.body.some((line) => line.includes('run garda doctor')), false);
    } finally {
        cleanupBundleRoot(bundleRoot);
    }
});

test('release 1.4.2 registry announces review catalog validation and optional migration', () => {
    const repoRoot = process.cwd();
    const bundleRoot = makeTempBundleRoot();
    const liveConfigDir = path.join(bundleRoot, 'live', 'config');
    try {
        fs.copyFileSync(
            path.join(repoRoot, 'template', 'config', 'update-messages.json'),
            path.join(liveConfigDir, 'update-messages.json')
        );
        fs.writeFileSync(
            path.join(bundleRoot, 'CHANGELOG.md'),
            ['# Changelog', '', '## 1.4.2', '- release note'].join('\n'),
            'utf8'
        );

        const result = collectUpdateAnnouncements(bundleRoot, '1.3.0', '1.4.2');
        const message = result.updateMessages.find((entry) => entry.version === '1.4.2');
        assert.equal(message?.title, 'Extensible reviews and safer remediation');
        assert.ok(message?.body.some((line) => line.includes('garda review-catalog validate')));
        assert.ok(message?.body.some((line) => line.includes('without a mandatory migration')));
        assert.ok(message?.body.some((line) => line.includes('garda review-catalog migrate')));
        assert.ok(message?.body.some((line) => line.includes('read-only')));
    } finally {
        cleanupBundleRoot(bundleRoot);
    }
});

test('buildUpdateResult and buildUpdateReportLines include announcement payload', () => {
    const announcements = {
        updateMessages: [
            {
                version: '1.1.0',
                title: 'Major registry note',
                body: ['Re-check new workflow affordances.']
            }
        ],
        releaseNotes: [
            {
                version: '1.1.0',
                lines: ['- added versioned notes']
            }
        ],
        warnings: []
    };

    const result = buildUpdateResult({
        normalizedTarget: '/tmp/workspace',
        sources: {
            initAnswersResolvedPath: 'garda-agent-orchestrator/runtime/init-answers.json',
            assistantLanguage: 'English',
            assistantBrevity: 'concise',
            sourceOfTruth: 'Claude',
            previousVersion: '1.0.0',
            previousVersionSource: 'VERSION',
            bundleVersion: '1.0.0'
        } as any,
        trustContext: {
            policy: 'explicit',
            overrideUsed: true,
            overrideSource: 'cli',
            sourceType: 'path',
            sourceReference: 'fixture'
        },
        rollbackSnapshotRelativePath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-1',
        rollbackRecordsRelativePath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-1/rollback-records.json',
        rollbackSnapshotCreated: true,
        rollbackRecordCount: 1,
        stageResult: {
            updatedVersion: '1.1.0',
            installStatus: 'SUCCESS',
            materializationStatus: 'SUCCESS',
            contractMigrationStatus: 'NOT_NEEDED',
            contractMigrationCount: 0,
            contractMigrationFiles: [],
            verifyStatus: 'SUCCESS',
            manifestStatus: 'SUCCESS',
            invariantStatus: 'SUCCESS',
            rollbackStatus: 'NOT_TRIGGERED'
        } as any,
        dryRun: false,
        updateReportRelativePath: 'garda-agent-orchestrator/runtime/update-reports/update-1.md',
        announcements
    });

    assert.equal(Array.isArray(result.updateMessages), true);
    assert.equal(Array.isArray(result.releaseNotes), true);
    assert.equal((result.updateMessages as Array<{ title: string }>)[0]?.title, 'Major registry note');

    const reportLines = buildUpdateReportLines({
        normalizedTarget: '/tmp/workspace',
        initAnswersResolvedPath: 'garda-agent-orchestrator/runtime/init-answers.json',
        rollbackSnapshotRelativePath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-1',
        rollbackRecordsRelativePath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-1/rollback-records.json',
        rollbackRecordCount: 1,
        rollbackStatus: 'NOT_TRIGGERED',
        trustContext: {
            policy: 'explicit',
            overrideUsed: true,
            overrideSource: 'cli',
            sourceType: 'path',
            sourceReference: 'fixture'
        },
        previousVersion: '1.0.0',
        previousVersionSource: 'VERSION',
        bundleVersion: '1.0.0',
        stageResult: {
            updatedVersion: '1.1.0',
            installStatus: 'SUCCESS',
            materializationStatus: 'SUCCESS',
            contractMigrationStatus: 'NOT_NEEDED',
            contractMigrationCount: 0,
            contractMigrationFiles: [],
            verifyStatus: 'SUCCESS',
            manifestStatus: 'SUCCESS',
            invariantStatus: 'SUCCESS',
            rollbackStatus: 'NOT_TRIGGERED'
        } as any,
        announcements
    });

    assert.equal(reportLines.includes('## UpdateMessages'), true);
    assert.equal(reportLines.includes('## ReleaseNotes'), true);
    assert.equal(reportLines.includes('### 1.1.0 - Major registry note'), true);
    assert.equal(reportLines.includes('- added versioned notes'), true);
});
