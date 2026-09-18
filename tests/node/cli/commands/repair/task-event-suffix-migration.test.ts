import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    applyTaskEventSuffixMigration,
    previewTaskEventSuffixMigration
} from '../../../../../src/cli/commands/repair/task-event-suffix-migration';
import { buildEventIntegrityHash } from '../../../../../src/gate-runtime/timeline/task-events-helpers';
import { inspectTaskEventFile } from '../../../../../src/gate-runtime/timeline/task-events-integrity';
import { MAX_TASK_TIMELINE_SNAPSHOT_BYTES } from '../../../../../src/gate-runtime/timeline/task-timeline-read-snapshot';

interface MigrationFixture {
    root: string;
    bundleRoot: string;
    eventsRoot: string;
    timelinePath: string;
    cleanup(): void;
}

function makeFixture(taskId = 'T-MIGRATE'): MigrationFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-event-migration-'));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    fs.mkdirSync(eventsRoot, { recursive: true });
    return {
        root,
        bundleRoot,
        eventsRoot,
        timelinePath,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

function buildTimelineEvents(
    taskId: string,
    schemaVersions: Array<number | null>
): Array<Record<string, unknown>> {
    let previousHash: string | null = null;
    return schemaVersions.map((schemaVersion, index) => {
        const event: Record<string, unknown> = {
            schema_version: schemaVersion ?? 0,
            timestamp_utc: `2026-08-31T00:00:0${index}.000Z`,
            task_id: taskId,
            event_type: `event-${index + 1}`,
            outcome: index % 2 === 0 ? 'PASS' : 'INFO',
            actor: 'migration-fixture',
            message: `literal\\path\\event-${index + 1}`,
            details: {
                ordinal: index + 1,
                nested: { preserved: true }
            }
        };
        if (schemaVersion !== null) {
            const integrity: Record<string, unknown> = {
                schema_version: schemaVersion,
                task_sequence: index + 1,
                prev_event_sha256: previousHash,
                preserved_integrity_metadata: `meta-${index + 1}`
            };
            event.integrity = integrity;
            previousHash = buildEventIntegrityHash(event);
            integrity.event_sha256 = previousHash;
        }
        return event;
    });
}

function serializeTimeline(events: Array<Record<string, unknown>>): Buffer {
    return Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

function writeTimeline(fixture: MigrationFixture, events: Array<Record<string, unknown>>): Buffer {
    const content = serializeTimeline(events);
    fs.writeFileSync(fixture.timelinePath, content, { mode: 0o600 });
    return content;
}

function readEvents(timelinePath: string): Array<Record<string, unknown>> {
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function withoutIntegrity(event: Record<string, unknown>): Record<string, unknown> {
    const { integrity: _integrity, ...rest } = event;
    return rest;
}

test('preview is read-only, apply migrates the authenticated terminal legacy suffix, and rejects stale replay', () => {
    const fixture = makeFixture();
    try {
        const originalEvents = buildTimelineEvents('T-MIGRATE', [1, 2, 1, 1]);
        const originalContent = writeTimeline(fixture, originalEvents);
        const originalIdentity = fs.statSync(fixture.timelinePath);

        const preview = previewTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE');

        assert.equal(preview.status, 'READY');
        assert.equal(preview.dry_run, true);
        assert.equal(preview.anchor_line, 2);
        assert.equal(preview.suffix_start_line, 3);
        assert.equal(preview.suffix_event_count, 2);
        assert.match(preview.plan_sha256 || '', /^[0-9a-f]{64}$/u);
        assert.deepEqual(fs.readFileSync(fixture.timelinePath), originalContent);

        const applied = applyTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE', {
            expectedPlanSha256: preview.plan_sha256 || ''
        });

        assert.equal(applied.status, 'APPLIED');
        assert.equal(applied.dry_run, false);
        assert.equal(applied.integrity_status, 'PASS');
        assert.ok(applied.backup_path);
        assert.ok(applied.backup_manifest_path);
        assert.deepEqual(fs.readFileSync(applied.backup_path as string), originalContent);
        assert.equal(fs.lstatSync(applied.backup_path as string).nlink, 1);
        assert.equal(fs.existsSync(applied.backup_manifest_path as string), true);

        const migratedEvents = readEvents(fixture.timelinePath);
        assert.deepEqual(migratedEvents.map(withoutIntegrity), originalEvents.map(withoutIntegrity));
        assert.deepEqual(
            migratedEvents.map((event) => (event.integrity as Record<string, unknown>).schema_version),
            [1, 2, 2, 2]
        );
        assert.deepEqual(
            migratedEvents.map((event) => (event.integrity as Record<string, unknown>).task_sequence),
            [1, 2, 3, 4]
        );
        assert.deepEqual(
            migratedEvents.map((event) => (
                event.integrity as Record<string, unknown>
            ).preserved_integrity_metadata),
            ['meta-1', 'meta-2', 'meta-3', 'meta-4']
        );
        assert.equal(inspectTaskEventFile(fixture.timelinePath, 'T-MIGRATE').status, 'PASS');
        assert.notEqual(fs.statSync(fixture.timelinePath).ino, originalIdentity.ino);

        const repeated = applyTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE', {
            expectedPlanSha256: preview.plan_sha256 || ''
        });
        assert.equal(repeated.status, 'ALREADY_CURRENT');
        assert.equal(repeated.changed, false);
        assert.equal(repeated.plan_sha256, preview.plan_sha256);
        assert.equal(repeated.migrated_sha256, applied.migrated_sha256);

        assert.throws(() => applyTaskEventSuffixMigration(
            fixture.root,
            fixture.bundleRoot,
            'T-MIGRATE',
            { expectedPlanSha256: '0'.repeat(64) }
        ), /no verified receipt/u);
    } finally {
        fixture.cleanup();
    }
});

test('apply preserves CRLF line endings while migrating the legacy suffix', () => {
    const fixture = makeFixture();
    try {
        const events = buildTimelineEvents('T-MIGRATE', [1, 2, 1, 1]);
        const originalContent = Buffer.from(
            serializeTimeline(events).toString('utf8').replaceAll('\n', '\r\n'),
            'utf8'
        );
        fs.writeFileSync(fixture.timelinePath, originalContent, { mode: 0o600 });
        const preview = previewTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE');

        const applied = applyTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE', {
            expectedPlanSha256: preview.plan_sha256 || ''
        });

        const migratedContent = fs.readFileSync(fixture.timelinePath);
        const migratedText = migratedContent.toString('utf8');
        assert.equal(applied.status, 'APPLIED');
        assert.equal(migratedText.split('\r\n').length - 1, events.length);
        assert.equal(migratedText.replaceAll('\r\n', '').includes('\n'), false);
        assert.deepEqual(
            migratedText.split('\r\n').slice(0, 2),
            originalContent.toString('utf8').split('\r\n').slice(0, 2)
        );
        assert.equal(inspectTaskEventFile(fixture.timelinePath, 'T-MIGRATE').status, 'PASS');
    } finally {
        fixture.cleanup();
    }
});

test('preview rejects invalid UTF-8 timeline bytes without mutation', () => {
    const fixture = makeFixture();
    try {
        const original = Buffer.from([0x7B, 0x22, 0xFF, 0x22, 0x7D, 0x0A]);
        fs.writeFileSync(fixture.timelinePath, original, { mode: 0o600 });

        const preview = previewTaskEventSuffixMigration(
            fixture.root,
            fixture.bundleRoot,
            'T-MIGRATE'
        );

        assert.equal(preview.status, 'REJECTED');
        assert.equal(preview.reason_code, 'invalid_utf8');
        assert.deepEqual(fs.readFileSync(fixture.timelinePath), original);
    } finally {
        fixture.cleanup();
    }
});

test('preview rejects invalid, unanchored, mixed, replayed, foreign, and already-current histories without mutation', () => {
    const cases: Array<{
        name: string;
        events: Array<Record<string, unknown>>;
        status: 'REJECTED' | 'ALREADY_CURRENT';
        reasonCode: string;
    }> = [];

    cases.push({
        name: 'unanchored',
        events: buildTimelineEvents('T-MIGRATE', [1, 1]),
        status: 'REJECTED',
        reasonCode: 'unanchored_legacy_timeline'
    });
    cases.push({
        name: 'mixed',
        events: buildTimelineEvents('T-MIGRATE', [1, 2, 1, 2]),
        status: 'REJECTED',
        reasonCode: 'mixed_legacy_suffix'
    });
    cases.push({
        name: 'already-current',
        events: buildTimelineEvents('T-MIGRATE', [1, 2, 2]),
        status: 'ALREADY_CURRENT',
        reasonCode: 'already_current'
    });

    const invalidHashEvents = buildTimelineEvents('T-MIGRATE', [1, 2, 1]);
    invalidHashEvents[2].message = 'tampered-after-hashing';
    cases.push({
        name: 'invalid-hash',
        events: invalidHashEvents,
        status: 'REJECTED',
        reasonCode: 'invalid_event_hash'
    });

    const replayedEvents = buildTimelineEvents('T-MIGRATE', [1, 2, 1]);
    replayedEvents.push(JSON.parse(JSON.stringify(replayedEvents[2])) as Record<string, unknown>);
    cases.push({
        name: 'replayed',
        events: replayedEvents,
        status: 'REJECTED',
        reasonCode: 'replayed_event'
    });

    const foreignEvents = buildTimelineEvents('T-MIGRATE', [1, 2, 1]);
    foreignEvents[2].task_id = 'T-FOREIGN';
    cases.push({
        name: 'foreign',
        events: foreignEvents,
        status: 'REJECTED',
        reasonCode: 'foreign_task'
    });

    const unverifiedSuffix = buildTimelineEvents('T-MIGRATE', [1, 2, null]);
    cases.push({
        name: 'unverified-suffix',
        events: unverifiedSuffix,
        status: 'REJECTED',
        reasonCode: 'mixed_unverified_suffix'
    });

    for (const candidate of cases) {
        const fixture = makeFixture();
        try {
            const original = writeTimeline(fixture, candidate.events);
            const preview = previewTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE');
            assert.equal(preview.status, candidate.status, candidate.name);
            assert.equal(preview.reason_code, candidate.reasonCode, candidate.name);
            assert.deepEqual(fs.readFileSync(fixture.timelinePath), original, candidate.name);
        } finally {
            fixture.cleanup();
        }
    }
});

test('preview rejects a symlinked timeline directory without touching its evidence', () => {
    const symlinkFixture = makeFixture();
    try {
        const externalEventsRoot = path.join(symlinkFixture.root, 'external-events');
        const externalPath = path.join(externalEventsRoot, 'T-MIGRATE.jsonl');
        const externalContent = serializeTimeline(buildTimelineEvents('T-MIGRATE', [1, 2, 1]));
        fs.mkdirSync(externalEventsRoot);
        fs.writeFileSync(externalPath, externalContent);
        fs.rmSync(symlinkFixture.eventsRoot, { recursive: true });
        fs.symlinkSync(
            externalEventsRoot,
            symlinkFixture.eventsRoot,
            process.platform === 'win32' ? 'junction' : 'dir'
        );
        const externalLockPath = path.join(externalEventsRoot, '.T-MIGRATE.lock');
        const externalOwnerPath = path.join(externalLockPath, 'owner.json');
        const externalOwner = JSON.stringify({
            lock_id: 'external-sentinel',
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString(),
            heartbeat_at_utc: new Date().toISOString(),
            command: 'external sentinel'
        });
        fs.mkdirSync(externalLockPath);
        fs.writeFileSync(externalOwnerPath, externalOwner);
        const preview = previewTaskEventSuffixMigration(
            symlinkFixture.root,
            symlinkFixture.bundleRoot,
            'T-MIGRATE'
        );
        assert.equal(preview.status, 'REJECTED');
        assert.equal(preview.reason_code, 'timeline_unsafe_or_changed');
        assert.throws(() => applyTaskEventSuffixMigration(
            symlinkFixture.root,
            symlinkFixture.bundleRoot,
            'T-MIGRATE',
            { expectedPlanSha256: '0'.repeat(64) }
        ), /not eligible.*timeline_unsafe_or_changed/u);
        assert.deepEqual(fs.readFileSync(externalPath), externalContent);
        assert.equal(fs.readFileSync(externalOwnerPath, 'utf8'), externalOwner);
        assert.equal(
            fs.existsSync(path.join(symlinkFixture.root, '.garda-task-event-suffix-migration-T-MIGRATE.lock')),
            false
        );
    } finally {
        symlinkFixture.cleanup();
    }

});

test('apply rolls back authenticated source bytes after a post-replacement failure', () => {
    const fixture = makeFixture();
    try {
        const original = writeTimeline(fixture, buildTimelineEvents('T-MIGRATE', [1, 2, 1, 1]));
        const preview = previewTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE');

        assert.throws(() => applyTaskEventSuffixMigration(
            fixture.root,
            fixture.bundleRoot,
            'T-MIGRATE',
            {
                expectedPlanSha256: preview.plan_sha256 || '',
                afterReplace: () => {
                    throw new Error('forced post-replacement validation failure');
                }
            }
        ), /failed and was rolled back.*forced post-replacement validation failure/u);
        assert.deepEqual(fs.readFileSync(fixture.timelinePath), original);
    } finally {
        fixture.cleanup();
    }
});

test('preview rejects an oversized timeline without touching its evidence', () => {
    const oversizedFixture = makeFixture();
    try {
        fs.writeFileSync(oversizedFixture.timelinePath, '');
        fs.truncateSync(oversizedFixture.timelinePath, MAX_TASK_TIMELINE_SNAPSHOT_BYTES + 1);
        const sizeBefore = fs.statSync(oversizedFixture.timelinePath).size;
        const preview = previewTaskEventSuffixMigration(
            oversizedFixture.root,
            oversizedFixture.bundleRoot,
            'T-MIGRATE'
        );
        assert.equal(preview.status, 'REJECTED');
        assert.equal(preview.reason_code, 'timeline_oversized');
        assert.equal(fs.statSync(oversizedFixture.timelinePath).size, sizeBefore);
    } finally {
        oversizedFixture.cleanup();
    }
});

test('apply rejects a concurrent content change while preserving the newer timeline', () => {
    const fixture = makeFixture();
    try {
        writeTimeline(fixture, buildTimelineEvents('T-MIGRATE', [1, 2, 1, 1]));
        const preview = previewTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE');
        const concurrentContent = serializeTimeline(buildTimelineEvents('T-MIGRATE', [1, 2, 1, 1, 1]));

        assert.throws(() => applyTaskEventSuffixMigration(
            fixture.root,
            fixture.bundleRoot,
            'T-MIGRATE',
            {
                expectedPlanSha256: preview.plan_sha256 || '',
                beforeReplace: () => fs.writeFileSync(fixture.timelinePath, concurrentContent)
            }
        ), /identity changed before replacement/u);
        assert.deepEqual(fs.readFileSync(fixture.timelinePath), concurrentContent);
    } finally {
        fixture.cleanup();
    }
});

test('apply rejects a concurrent identity replacement while preserving its bytes', () => {
    const fixture = makeFixture();
    try {
        const original = writeTimeline(fixture, buildTimelineEvents('T-MIGRATE', [1, 2, 1, 1]));
        const preview = previewTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, 'T-MIGRATE');

        assert.throws(() => applyTaskEventSuffixMigration(
            fixture.root,
            fixture.bundleRoot,
            'T-MIGRATE',
            {
                expectedPlanSha256: preview.plan_sha256 || '',
                beforeReplace: () => {
                    const replacementPath = `${fixture.timelinePath}.concurrent`;
                    fs.writeFileSync(replacementPath, original);
                    fs.renameSync(replacementPath, fixture.timelinePath);
                }
            }
        ), /identity changed before replacement/u);
        assert.deepEqual(fs.readFileSync(fixture.timelinePath), original);
    } finally {
        fixture.cleanup();
    }
});

test('preview rejects non-canonical task ids before resolving a filesystem path', () => {
    const fixture = makeFixture();
    try {
        assert.throws(
            () => previewTaskEventSuffixMigration(fixture.root, fixture.bundleRoot, '../escape'),
            /semantic pattern/u
        );
    } finally {
        fixture.cleanup();
    }
});
