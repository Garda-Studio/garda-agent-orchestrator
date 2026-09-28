import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fsModule from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { writeReviewArtifactText } from '../../../src/gate-runtime/review-artifacts';
import { withRuntimeMutationGeneration } from '../../../src/gate-runtime/runtime-mutation-generation';
import { buildRuntimeRetentionPreview } from '../../../src/lifecycle/runtime-policy/runtime-retention-policy';
import { buildReportDataContract } from '../../../src/reports/report-data-contract';
import { renderTaskRow } from '../../../src/reports/static-html/tasks-tab';
import {
    buildCanonicalCatalogProjection,
    CanonicalCatalogInputError,
    canonicalFirstCatalogWrite,
    flushScheduledDerivedSqliteCatalogReconciliation,
    inspectDerivedCatalogHealth,
    openDerivedSqliteCatalog,
    probeSqliteCatalogCapability,
    queryPerformanceQualifiedTaskActivitySummaries,
    reconcileDerivedSqliteCatalog,
    rebuildDerivedSqliteCatalog,
    repairDerivedSqliteCatalog,
    resolveDerivedSqliteCatalogPath,
    SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES,
    SQLITE_CATALOG_APPLICATION_ID
} from '../../../src/runtime/sqlite-catalog';
import { SQLITE_CATALOG_MIGRATIONS } from '../../../src/runtime/sqlite-catalog/sqlite-catalog-migration';

const TASK_ID = 'T-2000-1';
const SECOND_TASK_ID = 'T-2000-2';
const SQLITE_CATALOG_CAPABILITY = probeSqliteCatalogCapability();
const sqliteCatalogTest = SQLITE_CATALOG_CAPABILITY.available ? test : test.skip;
const childProcessModule = require('node:child_process') as typeof import('node:child_process');
const originalSpawnSync = childProcessModule.spawnSync;

sqliteCatalogTest('catalog ingestion reconstructs missing devices and rejects a different-device source descriptor', () => {
    const workspaceRoot = createWorkspace('gao-catalog-device-');
    const target = path.join(workspaceRoot, 'TASK.md');
    const catalog = openDerivedSqliteCatalog(workspaceRoot);
    assert.ok(catalog.status === 'available');
    const mutableFs = fsModule as { -readonly [Key in keyof typeof fsModule]: typeof fsModule[Key] };
    const originalLstat = mutableFs.lstatSync;
    const originalOpen = mutableFs.openSync;
    const originalFstat = mutableFs.fstatSync;
    const originalClose = mutableFs.closeSync;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let firstTargetFd: number | undefined;
    const liveTargetFds = new Set<number>();
    let substitute = false;
    mutableFs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
        const stat = Reflect.apply(originalLstat, mutableFs, args);
        return stat ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
            { dev: typeof stat.dev === 'bigint' ? 0n : 0 }) : stat;
    }) as typeof fs.lstatSync;
    mutableFs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        const fd = Reflect.apply(originalOpen, mutableFs, args);
        if (String(args[0]) === target) {
            liveTargetFds.add(fd);
            if (firstTargetFd === undefined) firstTargetFd = fd;
        }
        return fd;
    }) as typeof fs.openSync;
    mutableFs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
        const stat = Reflect.apply(originalFstat, mutableFs, args);
        return substitute && args[0] === firstTargetFd && liveTargetFds.has(args[0])
            ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
                { dev: typeof stat.dev === 'bigint' ? stat.dev + 1n : stat.dev + 1 }) : stat;
    }) as typeof fs.fstatSync;
    mutableFs.closeSync = (fd: number) => {
        liveTargetFds.delete(fd);
        originalClose(fd);
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
        assert.ok(buildCanonicalCatalogProjection(workspaceRoot).sourceFingerprints.some(source => source.sourcePath === 'TASK.md'));
        firstTargetFd = undefined;
        substitute = true;
        assert.throws(() => buildCanonicalCatalogProjection(workspaceRoot), CanonicalCatalogInputError);
    } finally {
        mutableFs.lstatSync = originalLstat;
        mutableFs.openSync = originalOpen;
        mutableFs.fstatSync = originalFstat;
        mutableFs.closeSync = originalClose;
        Object.defineProperty(process, 'platform', platform);
        catalog.catalog.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test.before(() => {
    if (process.platform !== 'win32') return;
    childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
        if (command.toLowerCase() !== 'icacls.exe') {
            return originalSpawnSync(command, args, options as never);
        }
        const inspectedPath = String(args[0] || 'fixture');
        const stdout = `${inspectedPath} BUILTIN\\Users:(I)(RX)\r\n`;
        return {
            pid: 0,
            output: [null, stdout, ''],
            stdout,
            stderr: '',
            status: 0,
            signal: null,
            error: undefined
        };
    }) as typeof originalSpawnSync;
});

test.after(() => {
    childProcessModule.spawnSync = originalSpawnSync;
});

function createWorkspace(prefix: string): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(workspaceRoot, 'MANIFEST.md'), '# Test bundle\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'VERSION'), '1.2.0-test\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'TASK.md'), [
        '# Tasks',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | 🟨 IN_PROGRESS | P1 | runtime/catalog | Reconcile catalog | agent | 2026-08-03 | balanced | Canonical first. |`,
        ''
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(workspaceRoot, 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'runtime', 'task-ledger'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'runtime', 'reviews'), { recursive: true });
    appendTaskEvent(
        workspaceRoot,
        TASK_ID,
        'TASK_MODE_ENTERED',
        'PASS',
        'Task mode entered.',
        {},
        { passThru: true, lowNoiseRuntimeWrites: true }
    );
    fs.writeFileSync(path.join(workspaceRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`), JSON.stringify({
        schema_version: 1,
        event_source: 'task-history-ledger',
        task_id: TASK_ID,
        generated_utc: '2026-08-03T12:00:00.000Z',
        audit_status: 'PASS',
        verification: { status: 'VERIFIED', issues: [] },
        lifecycle: {
            queue_status: 'IN_PROGRESS',
            health_state: 'healthy',
            retention_tier: 'active_evidence',
            integrity_status: 'PASS',
            point_in_time_status: 'STABLE',
            blocker_count: 0
        },
        timing: {
            first_event_utc: '2026-08-03T11:00:00.000Z',
            last_event_utc: '2026-08-03T12:00:00.000Z'
        },
        scope: { changed_files_count: 1, changed_lines_total: 5 }
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'runtime', 'metrics.jsonl'), [
        JSON.stringify({
            timestamp_utc: '2026-08-03T12:00:00.000Z',
            metric_type: 'navigator_duration',
            value: 2.4,
            unit: 'seconds',
            task_id: TASK_ID,
            metadata: { command: 'next-step' }
        }),
        ''
    ].join('\n'), 'utf8');
    return workspaceRoot;
}

function removeWorkspace(workspaceRoot: string): void {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

function readCanonicalLifecycleRange(
    workspaceRoot: string,
    taskId: string
): { count: number; firstUtc: string; lastUtc: string } {
    const eventLines = fs.readFileSync(
        path.join(workspaceRoot, 'runtime', 'task-events', `${taskId}.jsonl`),
        'utf8'
    ).split(/\r?\n/u).filter((line) => line.trim().length > 0);
    const timestamps = eventLines.map((line) => {
        const event = JSON.parse(line) as { task_id?: unknown; timestamp_utc?: unknown };
        assert.equal(event.task_id, taskId);
        assert.equal(typeof event.timestamp_utc, 'string');
        return event.timestamp_utc as string;
    }).sort();
    assert.ok(timestamps.length > 0);
    return {
        count: timestamps.length,
        firstUtc: timestamps[0],
        lastUtc: timestamps[timestamps.length - 1]
    };
}

function appendReviewFixture(options: {
    workspaceRoot: string;
    taskId: string;
    reviewType: string;
    attemptId: string;
    reviewerIdentity: string;
}): { artifactPath: string; artifactSha256: string } {
    const artifactPath = path.join(
        options.workspaceRoot,
        'runtime',
        'reviews',
        `${options.taskId}-${options.reviewType}-${options.attemptId}.md`
    );
    const artifactContent = `# ${options.reviewType} review\n\nNo findings for ${options.taskId}.\n`;
    const artifactSha256 = createHash('sha256').update(artifactContent).digest('hex');
    fs.writeFileSync(artifactPath, artifactContent, 'utf8');
    const sharedDetails = {
        review_type: options.reviewType,
        reviewer_launch_attempt_id: options.attemptId,
        reviewer_identity: options.reviewerIdentity,
        reviewer_execution_mode: 'delegated_subagent'
    };
    appendTaskEvent(options.workspaceRoot, options.taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'Prepared.', {
        ...sharedDetails
    }, { passThru: true, lowNoiseRuntimeWrites: true });
    appendTaskEvent(options.workspaceRoot, options.taskId, 'REVIEWER_DELEGATION_STARTED', 'INFO', 'Started.', {
        ...sharedDetails
    }, { passThru: true, lowNoiseRuntimeWrites: true });
    appendTaskEvent(options.workspaceRoot, options.taskId, 'REVIEW_RECORDED', 'PASS', 'Recorded.', {
        ...sharedDetails,
        trust_level: 'INDEPENDENT_AUDITED',
        review_artifact_path: artifactPath,
        review_artifact_sha256: artifactSha256
    }, { passThru: true, lowNoiseRuntimeWrites: true });
    return { artifactPath, artifactSha256 };
}

function createBulkFallbackWorkspace(prefix: string): {
    workspaceRoot: string;
    sourcePaths: Record<'task_queue' | 'task_events' | 'review_artifact' | 'task_ledger' | 'metrics', string>;
} {
    const workspaceRoot = createWorkspace(prefix);
    const review = appendReviewFixture({
        workspaceRoot,
        taskId: TASK_ID,
        reviewType: 'code',
        attemptId: 'attempt-fallback-code-1',
        reviewerIdentity: 'agent:fallback-reviewer'
    });
    const eventsRoot = path.join(workspaceRoot, 'runtime', 'task-events');
    for (let index = 1; index <= SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES; index += 1) {
        fs.writeFileSync(
            path.join(eventsRoot, `T-28${String(index).padStart(3, '0')}-1.jsonl`),
            '',
            'utf8'
        );
    }
    const projectionTimestamp = new Date(Date.now() + 60_000).toISOString();
    assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot, {
        clock: () => projectionTimestamp
    }).status, 'applied');
    return {
        workspaceRoot,
        sourcePaths: {
            task_queue: path.join(workspaceRoot, 'TASK.md'),
            task_events: path.join(eventsRoot, `${TASK_ID}.jsonl`),
            review_artifact: review.artifactPath,
            task_ledger: path.join(workspaceRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`),
            metrics: path.join(workspaceRoot, 'runtime', 'metrics.jsonl')
        }
    };
}

function waitForChildOutput(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for child output '${expected}': ${stderr || stdout}`));
        }, 5_000);
        const cleanup = (): void => {
            clearTimeout(timeout);
            child.stdout?.off('data', onStdout);
            child.stderr?.off('data', onStderr);
            child.off('exit', onExit);
        };
        const onStdout = (chunk: Buffer | string): void => {
            stdout += chunk.toString();
            if (stdout.includes(expected)) {
                cleanup();
                resolve();
            }
        };
        const onStderr = (chunk: Buffer | string): void => {
            stderr += chunk.toString();
        };
        const onExit = (code: number | null): void => {
            cleanup();
            reject(new Error(`Child exited with ${code ?? 'signal'} before '${expected}': ${stderr || stdout}`));
        };
        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.once('exit', onExit);
    });
}

test('canonical scanner normalizes task, event, ledger, retention, and metric records with stable parity', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-scan-');
    try {
        const reviewArtifactPath = path.join(
            workspaceRoot,
            'runtime',
            'reviews',
            `${TASK_ID}-code.md`
        );
        const reviewArtifactContent = '# Review\n\nNo findings.\n';
        const reviewArtifactSha256 = createHash('sha256').update(reviewArtifactContent).digest('hex');
        fs.writeFileSync(reviewArtifactPath, reviewArtifactContent, 'utf8');
        const attemptId = 'attempt-code-1';
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'Prepared.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent'
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEWER_DELEGATION_STARTED', 'INFO', 'Started.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent'
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', 'Recorded.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent',
            trust_level: 'INDEPENDENT_AUDITED',
            review_artifact_path: reviewArtifactPath,
            review_artifact_sha256: reviewArtifactSha256
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        const first = buildCanonicalCatalogProjection(workspaceRoot, {
            clock: () => '2026-08-03T12:30:00.000Z'
        });
        const second = buildCanonicalCatalogProjection(workspaceRoot, {
            clock: () => '2026-08-03T12:31:00.000Z'
        });

        assert.equal(first.projection.tasks.length, 1);
        assert.equal(first.projection.lifecycleEvents.length, 4);
        assert.equal(first.projection.reviewAttempts.length, 1);
        assert.equal(first.projection.reviewReceipts.length, 1);
        assert.equal(first.projection.artifacts.length, 1);
        assert.equal(first.projection.taskLedgers.length, 1);
        assert.equal(first.projection.retentionStates.length, 1);
        assert.equal(first.projection.metricSamples.length, 1);
        assert.equal(first.projection.snapshotSha256, second.projection.snapshotSha256);
        assert.deepEqual(first.sourcePaths, [
            'TASK.md',
            `runtime/task-events/${TASK_ID}.jsonl`,
            `runtime/task-ledger/${TASK_ID}.json`,
            'runtime/metrics.jsonl',
            `runtime/reviews/${TASK_ID}-code.md`
        ]);
        fs.writeFileSync(reviewArtifactPath, '# Review\n\nTampered.\n', 'utf8');
        assert.throws(
            () => buildCanonicalCatalogProjection(workspaceRoot),
            (error: unknown) => (
                error instanceof CanonicalCatalogInputError
                && /does not match event-declared SHA-256/iu.test(error.message)
            )
        );
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('performance-qualified query uses SQLite and fails closed to files after canonical drift', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-current-query-');
    try {
        const taskQueuePath = path.join(workspaceRoot, 'TASK.md');
        const taskQueueContent = fs.readFileSync(taskQueuePath, 'utf8').trimEnd();
        fs.writeFileSync(taskQueuePath, [
            taskQueueContent,
            `| ${SECOND_TASK_ID} | 🟦 TODO | P2 | runtime/catalog | Query catalog | agent | 2026-08-03 | balanced | Canonical first. |`,
            ''
        ].join('\n'), 'utf8');
        appendTaskEvent(
            workspaceRoot,
            SECOND_TASK_ID,
            'TASK_MODE_ENTERED',
            'PASS',
            'Second task entered.',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        const reviewArtifactPath = path.join(workspaceRoot, 'runtime', 'reviews', `${TASK_ID}-code.md`);
        const reviewArtifactContent = '# Code review\n\nNo findings.\n';
        fs.writeFileSync(reviewArtifactPath, reviewArtifactContent, 'utf8');
        const reviewArtifactSha256 = createHash('sha256').update(reviewArtifactContent).digest('hex');
        const attemptId = 'attempt-current-query-code-1';
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'Prepared.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:query-reviewer',
            reviewer_execution_mode: 'delegated_subagent'
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEWER_DELEGATION_STARTED', 'INFO', 'Started.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:query-reviewer',
            reviewer_execution_mode: 'delegated_subagent'
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', 'Recorded.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:query-reviewer',
            reviewer_execution_mode: 'delegated_subagent',
            trust_level: 'INDEPENDENT_AUDITED',
            review_artifact_path: reviewArtifactPath,
            review_artifact_sha256: reviewArtifactSha256
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendReviewFixture({
            workspaceRoot,
            taskId: SECOND_TASK_ID,
            reviewType: 'test',
            attemptId: 'attempt-zeta-test-2',
            reviewerIdentity: 'agent:second-test-reviewer'
        });
        appendReviewFixture({
            workspaceRoot,
            taskId: SECOND_TASK_ID,
            reviewType: 'api',
            attemptId: 'attempt-alpha-api-1',
            reviewerIdentity: 'agent:second-api-reviewer'
        });
        const firstLedgerPath = path.join(workspaceRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`);
        const secondLedger = JSON.parse(fs.readFileSync(firstLedgerPath, 'utf8')) as Record<string, unknown>;
        secondLedger.task_id = SECOND_TASK_ID;
        secondLedger.generated_utc = '2026-08-03T12:05:00.000Z';
        secondLedger.audit_status = 'WARN';
        secondLedger.lifecycle = {
            ...(secondLedger.lifecycle as Record<string, unknown>),
            queue_status: 'DONE',
            health_state: 'blocked',
            retention_tier: 'compressed_forensic_candidate',
            blocker_count: 2
        };
        secondLedger.scope = { changed_files_count: 3, changed_lines_total: 21 };
        fs.writeFileSync(
            path.join(workspaceRoot, 'runtime', 'task-ledger', `${SECOND_TASK_ID}.json`),
            `${JSON.stringify(secondLedger, null, 2)}\n`,
            'utf8'
        );
        fs.appendFileSync(path.join(workspaceRoot, 'runtime', 'metrics.jsonl'), [
            JSON.stringify({
                timestamp_utc: '2026-08-03T12:02:00.000Z',
                metric_type: 'review_duration',
                value: 4.5,
                unit: 'seconds',
                task_id: SECOND_TASK_ID,
                metadata: { review_type: 'api' }
            }),
            JSON.stringify({
                timestamp_utc: '2026-08-03T12:01:00.000Z',
                metric_type: 'navigator_duration',
                value: 1.1,
                unit: 'seconds',
                task_id: SECOND_TASK_ID,
                metadata: { command: 'next-step' }
            }),
            ''
        ].join('\n'), 'utf8');

        const projectionTimestamp = new Date(Date.now() + 60_000).toISOString();
        const projectionClock = () => projectionTimestamp;
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot, { clock: projectionClock }).status, 'applied');

        const smallWorkload = queryPerformanceQualifiedTaskActivitySummaries(workspaceRoot);
        assert.equal(smallWorkload.source, 'files');
        if (smallWorkload.source === 'files') {
            assert.equal(smallWorkload.reason, 'not_performance_qualified');
        }

        const eventsRoot = path.join(workspaceRoot, 'runtime', 'task-events');
        fs.writeFileSync(path.join(eventsRoot, 'all-tasks.jsonl'), '', 'utf8');
        assert.equal(fs.existsSync(path.join(eventsRoot, 'all-tasks.jsonl')), true);
        const belowThresholdSyntheticFileCount = SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES - 3;
        for (let index = 1; index <= belowThresholdSyntheticFileCount; index += 1) {
            fs.writeFileSync(
                path.join(eventsRoot, `T-29${String(index).padStart(3, '0')}-1.jsonl`),
                '',
                'utf8'
            );
        }
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const belowThresholdWorkload = queryPerformanceQualifiedTaskActivitySummaries(workspaceRoot);
        assert.equal(belowThresholdWorkload.source, 'files');
        if (belowThresholdWorkload.source === 'files') {
            assert.equal(belowThresholdWorkload.reason, 'not_performance_qualified');
        }

        fs.writeFileSync(
            path.join(eventsRoot, `T-29${String(belowThresholdSyntheticFileCount + 1).padStart(3, '0')}-1.jsonl`),
            '',
            'utf8'
        );
        const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
        for (const candidatePath of [catalogPath, `${catalogPath}-wal`, `${catalogPath}-shm`]) {
            fs.rmSync(candidatePath, { force: true });
        }
        const missingCatalogWorkload = queryPerformanceQualifiedTaskActivitySummaries(workspaceRoot);
        assert.equal(missingCatalogWorkload.source, 'files');
        if (missingCatalogWorkload.source === 'files') {
            assert.equal(missingCatalogWorkload.reason, 'catalog_unavailable');
        }
        const missingCatalogReport = buildReportDataContract({
            repoRoot: workspaceRoot,
            generatedAtUtc: '2026-08-03T12:15:00.000Z',
            maxDetailedTasks: 0
        });
        assert.deepEqual(
            missingCatalogReport.tasks_tab.rows.map((row) => row.activity_summary),
            [null, null]
        );
        assert.match(
            renderTaskRow(missingCatalogReport.tasks_tab.rows[0], 0),
            /<td>skipped<\/td><td>skipped<\/td>/u
        );

        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const bulkWorkload = queryPerformanceQualifiedTaskActivitySummaries(workspaceRoot);
        if (bulkWorkload.source !== 'sqlite') assert.fail(bulkWorkload.diagnostic);
        const firstTaskEvents = readCanonicalLifecycleRange(workspaceRoot, TASK_ID);
        const secondTaskEvents = readCanonicalLifecycleRange(workspaceRoot, SECOND_TASK_ID);
        assert.equal(firstTaskEvents.count, 4);
        assert.equal(secondTaskEvents.count, 7);
        const expectedActivitySummaries = [{
            taskId: TASK_ID,
            queuePosition: 0,
            status: '🟨 IN_PROGRESS',
            lifecycleEventCount: firstTaskEvents.count,
            firstLifecycleEventUtc: firstTaskEvents.firstUtc,
            lastLifecycleEventUtc: firstTaskEvents.lastUtc,
            reviewAttemptCount: 1,
            reviewReceiptCount: 1,
            artifactCount: 1,
            metricSampleCount: 1,
            auditStatus: 'PASS',
            verificationStatus: 'VERIFIED',
            healthState: 'healthy',
            retentionState: 'active',
            retentionTier: 'active_evidence'
        }, {
            taskId: SECOND_TASK_ID,
            queuePosition: 1,
            status: '🟦 TODO',
            lifecycleEventCount: secondTaskEvents.count,
            firstLifecycleEventUtc: secondTaskEvents.firstUtc,
            lastLifecycleEventUtc: secondTaskEvents.lastUtc,
            reviewAttemptCount: 2,
            reviewReceiptCount: 2,
            artifactCount: 2,
            metricSampleCount: 2,
            auditStatus: 'WARN',
            verificationStatus: 'VERIFIED',
            healthState: 'blocked',
            retentionState: 'retained',
            retentionTier: 'compressed_forensic_candidate'
        }];
        assert.deepEqual(bulkWorkload.value, expectedActivitySummaries);

        const sqliteReport = buildReportDataContract({
            repoRoot: workspaceRoot,
            generatedAtUtc: '2026-08-03T12:30:00.000Z',
            maxDetailedTasks: 0
        });
        assert.deepEqual(sqliteReport.tasks_tab.rows.map((row) => ({
            taskId: row.task_id,
            detailStatus: row.detail.detail_status
        })), [{ taskId: TASK_ID, detailStatus: 'skipped' }, {
            taskId: SECOND_TASK_ID,
            detailStatus: 'skipped'
        }]);
        assert.deepEqual(
            sqliteReport.tasks_tab.rows.map((row) => row.activity_summary),
            expectedActivitySummaries.map((summary) => ({
                lifecycle_event_count: summary.lifecycleEventCount,
                first_lifecycle_event_utc: summary.firstLifecycleEventUtc,
                last_lifecycle_event_utc: summary.lastLifecycleEventUtc,
                review_attempt_count: summary.reviewAttemptCount,
                review_receipt_count: summary.reviewReceiptCount,
                artifact_count: summary.artifactCount,
                metric_sample_count: summary.metricSampleCount,
                verification_status: summary.verificationStatus,
                health_state: summary.healthState,
                retention_state: summary.retentionState,
                retention_tier: summary.retentionTier
            }))
        );
        assert.match(renderTaskRow(sqliteReport.tasks_tab.rows[0], 0), /<td>4<\/td><td>skipped<\/td>/u);

        const retentionCandidates = fs.readdirSync(eventsRoot, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name !== 'all-tasks.jsonl' && entry.name.endsWith('.jsonl'))
            .map((entry) => ({
                path: path.join(eventsRoot, entry.name),
                category: 'task-events'
        }));
        assert.equal(SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES, 1_000);
        assert.equal(retentionCandidates.length, SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES);
        // Make the derived status observably different so the preview result proves
        // that small candidate sets never enter the aggregate query while the
        // threshold-sized preview does.
        const probeDatabase = new DatabaseSync(catalogPath);
        try {
            probeDatabase.prepare('UPDATE task_queue_rows SET status = ? WHERE task_id = ?')
                .run('DONE', TASK_ID);
        } finally {
            probeDatabase.close();
        }

        let retentionAggregateCallCount = 0;
        const retentionAggregateSources: string[] = [];
        const observedRetentionAggregateQuery: typeof queryPerformanceQualifiedTaskActivitySummaries = (repoRoot) => {
            retentionAggregateCallCount += 1;
            const result = queryPerformanceQualifiedTaskActivitySummaries(repoRoot);
            retentionAggregateSources.push(result.source);
            return result;
        };
        const retentionOptions = { queryTaskActivitySummaries: observedRetentionAggregateQuery };
        const emptyRetentionPreview = buildRuntimeRetentionPreview(
            workspaceRoot,
            workspaceRoot,
            [],
            retentionOptions
        );
        assert.equal(emptyRetentionPreview.task_count, 0);
        assert.equal(retentionAggregateCallCount, 0);
        const smallRetentionPreview = buildRuntimeRetentionPreview(
            workspaceRoot,
            workspaceRoot,
            [{ path: path.join(eventsRoot, `${TASK_ID}.jsonl`), category: 'task-events' }],
            retentionOptions
        );
        assert.equal(smallRetentionPreview.tasks[0]?.queue_status, 'IN_PROGRESS');
        assert.equal(retentionAggregateCallCount, 0);
        const belowThresholdRetentionPreview = buildRuntimeRetentionPreview(
            workspaceRoot,
            workspaceRoot,
            retentionCandidates.slice(0, SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES - 1),
            retentionOptions
        );
        assert.equal(
            belowThresholdRetentionPreview.task_count,
            SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES - 1
        );
        assert.equal(retentionAggregateCallCount, 0);
        const largeRetentionPreview = buildRuntimeRetentionPreview(
            workspaceRoot,
            workspaceRoot,
            retentionCandidates,
            retentionOptions
        );
        assert.equal(retentionAggregateCallCount, 1);
        assert.deepEqual(retentionAggregateSources, ['sqlite']);
        assert.equal(
            largeRetentionPreview.tasks.find((task) => task.task_id === TASK_ID)?.queue_status,
            'DONE'
        );

        const restoreDatabase = new DatabaseSync(catalogPath);
        try {
            restoreDatabase.prepare('UPDATE task_queue_rows SET status = ? WHERE task_id = ?')
                .run('🟨 IN_PROGRESS', TASK_ID);
        } finally {
            restoreDatabase.close();
        }

        const projectedReviewArtifactStat = fs.statSync(reviewArtifactPath);
        fs.appendFileSync(reviewArtifactPath, '\nTampered after projection.\n', 'utf8');
        fs.utimesSync(
            reviewArtifactPath,
            projectedReviewArtifactStat.atime,
            new Date(projectedReviewArtifactStat.mtimeMs - 60_000)
        );
        const driftedBulkWorkload = queryPerformanceQualifiedTaskActivitySummaries(workspaceRoot);
        assert.equal(driftedBulkWorkload.source, 'files');
        if (driftedBulkWorkload.source === 'files') {
            assert.equal(driftedBulkWorkload.reason, 'source_changed');
        }
        const driftedReport = buildReportDataContract({
            repoRoot: workspaceRoot,
            generatedAtUtc: '2026-08-03T12:45:00.000Z',
            maxDetailedTasks: 0
        });
        assert.deepEqual(
            driftedReport.tasks_tab.rows.map((row) => row.activity_summary),
            [null, null]
        );
        assert.match(
            renderTaskRow(driftedReport.tasks_tab.rows[0], 0),
            /<td>skipped<\/td><td>skipped<\/td>/u
        );
        const driftedRetentionPreview = buildRuntimeRetentionPreview(
            workspaceRoot,
            workspaceRoot,
            retentionCandidates,
            retentionOptions
        );
        assert.equal(retentionAggregateCallCount, 2);
        assert.deepEqual(retentionAggregateSources, ['sqlite', 'files']);
        assert.equal(
            driftedRetentionPreview.tasks.find((task) => task.task_id === TASK_ID)?.queue_status,
            'IN_PROGRESS'
        );

    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('performance-qualified query isolates changed and deleted fallback by canonical source kind', () => {
    const sourceKinds = ['task_queue', 'task_events', 'review_artifact', 'task_ledger', 'metrics'] as const;

    for (const mode of ['changed', 'deleted'] as const) {
        for (const sourceKind of sourceKinds) {
            const fixture = createBulkFallbackWorkspace(
                `garda-sqlite-current-query-${sourceKind}-${mode}-`
            );
            try {
                const sourcePath = fixture.sourcePaths[sourceKind];
                if (mode === 'changed') {
                    const projectedStat = fs.statSync(sourcePath);
                    fs.appendFileSync(sourcePath, '\n', 'utf8');
                    fs.utimesSync(
                        sourcePath,
                        projectedStat.atime,
                        new Date(projectedStat.mtimeMs - 60_000)
                    );
                } else {
                    fs.rmSync(sourcePath);
                }

                const performanceResult = queryPerformanceQualifiedTaskActivitySummaries(fixture.workspaceRoot);
                assert.equal(
                    performanceResult.source,
                    'files',
                    `${sourceKind} ${mode} aggregate query should fail closed`
                );
                if (performanceResult.source === 'files') {
                    if (mode === 'changed') {
                        assert.equal(performanceResult.reason, 'source_changed');
                    } else {
                        assert.match(performanceResult.reason, /^source_(?:missing|changed)$/u);
                    }
                }

                const report = buildReportDataContract({
                    repoRoot: fixture.workspaceRoot,
                    generatedAtUtc: '2026-08-03T13:00:00.000Z',
                    maxDetailedTasks: 0
                });
                if (sourceKind === 'task_queue' && mode === 'deleted') {
                    assert.deepEqual(report.tasks_tab.rows, []);
                } else {
                    assert.equal(report.tasks_tab.rows[0]?.activity_summary, null);
                    assert.match(
                        renderTaskRow(report.tasks_tab.rows[0], 0),
                        /<td>skipped<\/td><td>skipped<\/td>/u
                    );
                }
            } finally {
                removeWorkspace(fixture.workspaceRoot);
            }
        }
    }
});

sqliteCatalogTest('performance-qualified query treats review artifacts as task-event-owned canonical sources', () => {
    const fixture = createBulkFallbackWorkspace('garda-sqlite-current-query-new-artifact-');
    try {
        const artifactPath = path.join(fixture.workspaceRoot, 'runtime', 'reviews', `${TASK_ID}-new-code.md`);
        const artifactContent = '# New review artifact\n';
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');

        const unreferencedArtifact = queryPerformanceQualifiedTaskActivitySummaries(fixture.workspaceRoot);
        if (unreferencedArtifact.source !== 'sqlite') assert.fail(unreferencedArtifact.diagnostic);

        appendTaskEvent(
            fixture.workspaceRoot,
            TASK_ID,
            'REVIEW_RECORDED',
            'PASS',
            'Recorded a new review artifact.',
            {
                review_type: 'code',
                review_artifact_path: artifactPath,
                review_artifact_sha256: createHash('sha256').update(artifactContent).digest('hex')
            }
        );

        const referencedArtifact = queryPerformanceQualifiedTaskActivitySummaries(fixture.workspaceRoot);
        assert.equal(referencedArtifact.source, 'files');
        if (referencedArtifact.source === 'files') {
            assert.match(referencedArtifact.reason, /^(?:generation_mismatch|source_changed)$/u);
        }
    } finally {
        removeWorkspace(fixture.workspaceRoot);
    }
});

sqliteCatalogTest('performance-qualified query discards a result when canonical generation advances during the query', () => {
    const fixture = createBulkFallbackWorkspace('garda-sqlite-current-query-generation-race-');
    const eventPath = fixture.sourcePaths.task_events;
    const originalReadFileSync = fsModule.readFileSync;
    let generationAdvanced = false;
    try {
        fsModule.readFileSync = (function patchedReadFileSync(...args: Parameters<typeof fsModule.readFileSync>) {
            const value = originalReadFileSync.apply(fsModule, args);
            if (!generationAdvanced && path.resolve(String(args[0])) === eventPath) {
                generationAdvanced = true;
                withRuntimeMutationGeneration(fixture.workspaceRoot, 'test-query-generation-race', () => undefined);
            }
            return value;
        }) as typeof fsModule.readFileSync;

        const result = queryPerformanceQualifiedTaskActivitySummaries(fixture.workspaceRoot);
        assert.equal(generationAdvanced, true);
        assert.equal(result.source, 'files');
        if (result.source === 'files') {
            assert.match(result.reason, /^(?:generation_mismatch|source_changed)$/u);
        }
    } finally {
        fsModule.readFileSync = originalReadFileSync;
        removeWorkspace(fixture.workspaceRoot);
    }
});

sqliteCatalogTest('performance-qualified query discards a result when a source changes during the query', () => {
    const fixture = createBulkFallbackWorkspace('garda-sqlite-current-query-source-race-');
    const eventPath = fixture.sourcePaths.task_events;
    const originalReadFileSync = fsModule.readFileSync;
    let sourceChanged = false;
    try {
        const projectedEventStat = fs.statSync(eventPath);
        fsModule.readFileSync = (function patchedReadFileSync(...args: Parameters<typeof fsModule.readFileSync>) {
            const value = originalReadFileSync.apply(fsModule, args);
            if (!sourceChanged && path.resolve(String(args[0])) === eventPath) {
                sourceChanged = true;
                fs.appendFileSync(eventPath, '\n', 'utf8');
                fs.utimesSync(eventPath, projectedEventStat.atime, new Date(projectedEventStat.mtimeMs - 60_000));
            }
            return value;
        }) as typeof fsModule.readFileSync;

        const result = queryPerformanceQualifiedTaskActivitySummaries(fixture.workspaceRoot);
        assert.equal(sourceChanged, true);
        assert.equal(result.source, 'files');
        if (result.source === 'files') assert.equal(result.reason, 'source_changed');
    } finally {
        fsModule.readFileSync = originalReadFileSync;
        removeWorkspace(fixture.workspaceRoot);
    }
});

sqliteCatalogTest('performance-qualified query rejects a post-projection symlink source before reading its target', () => {
    const fixture = createBulkFallbackWorkspace('garda-sqlite-current-query-source-link-');
    const eventPath = fixture.sourcePaths.task_events;
    const mutableFsModule = fsModule as {
        lstatSync: typeof fsModule.lstatSync;
        readFileSync: typeof fsModule.readFileSync;
    };
    const originalLstatSync = fsModule.lstatSync;
    const originalReadFileSync = fsModule.readFileSync;
    let linkedSourceObserved = false;
    let linkedTargetRead = false;
    try {
        mutableFsModule.lstatSync = (function patchedLstatSync(...args: Parameters<typeof fsModule.lstatSync>) {
            const stat = originalLstatSync.apply(fsModule, args);
            if (path.resolve(String(args[0])) === eventPath) {
                linkedSourceObserved = true;
                return {
                    ...stat,
                    isFile: () => false,
                    isSymbolicLink: () => true
                } as fs.Stats;
            }
            return stat;
        }) as typeof fsModule.lstatSync;
        fsModule.readFileSync = (function patchedReadFileSync(...args: Parameters<typeof fsModule.readFileSync>) {
            if (path.resolve(String(args[0])) === eventPath) linkedTargetRead = true;
            return originalReadFileSync.apply(fsModule, args);
        }) as typeof fsModule.readFileSync;

        const result = queryPerformanceQualifiedTaskActivitySummaries(fixture.workspaceRoot);
        assert.equal(linkedSourceObserved, true);
        assert.equal(linkedTargetRead, false);
        assert.equal(result.source, 'files');
        if (result.source === 'files') assert.equal(result.reason, 'source_changed');
    } finally {
        mutableFsModule.lstatSync = originalLstatSync;
        fsModule.readFileSync = originalReadFileSync;
        removeWorkspace(fixture.workspaceRoot);
    }
});

test('canonical scanner rejects an oversized review artifact before materializing it', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-artifact-budget-');
    try {
        const artifactPath = path.join(workspaceRoot, 'runtime', 'reviews', `${TASK_ID}-oversized.md`);
        fs.writeFileSync(artifactPath, '');
        fs.truncateSync(artifactPath, (8 * 1024 * 1024) + 1);
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', 'Recorded oversized artifact.', {
            review_type: 'code',
            review_artifact_path: artifactPath,
            review_artifact_sha256: '0'.repeat(64)
        }, { passThru: true, lowNoiseRuntimeWrites: true });

        assert.throws(
            () => buildCanonicalCatalogProjection(workspaceRoot),
            (error: unknown) => (
                error instanceof CanonicalCatalogInputError
                && /bounded artifact read limit/iu.test(error.message)
            )
        );
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('canonical scanner rejects task-event streams without an integrity chain', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-legacy-events-');
    try {
        fs.writeFileSync(
            path.join(workspaceRoot, 'runtime', 'task-events', `${TASK_ID}.jsonl`),
            `${JSON.stringify({
                task_id: TASK_ID,
                event_type: 'LEGACY_EVENT',
                outcome: 'INFO',
                summary: 'Unprotected legacy event.'
            })}\n`,
            'utf8'
        );
        assert.throws(
            () => buildCanonicalCatalogProjection(workspaceRoot),
            (error: unknown) => (
                error instanceof CanonicalCatalogInputError
                && /integrity status is LEGACY_ONLY/iu.test(error.message)
            )
        );
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('canonical scanner rejects cross-stream artifact ownership collisions', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-artifact-owner-collision-');
    try {
        const artifactPath = path.join(workspaceRoot, 'runtime', 'reviews', 'shared-code.md');
        const artifactContent = '# Shared review\n';
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');
        const artifactSha256 = createHash('sha256').update(artifactContent).digest('hex');
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', 'Primary owner.', {
            review_type: 'code',
            reviewer_launch_attempt_id: 'attempt-primary-owner',
            review_artifact_path: artifactPath,
            review_artifact_sha256: artifactSha256
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, 'T-2000-2', 'REVIEW_RECORDED', 'PASS', 'Conflicting owner.', {
            review_type: 'code',
            reviewer_launch_attempt_id: 'attempt-conflicting-owner',
            review_artifact_path: artifactPath,
            review_artifact_sha256: artifactSha256
        }, { passThru: true, lowNoiseRuntimeWrites: true });

        assert.throws(
            () => buildCanonicalCatalogProjection(workspaceRoot),
            (error: unknown) => (
                error instanceof CanonicalCatalogInputError
                && /conflicting canonical ownership or integrity declarations/iu.test(error.message)
            )
        );
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('incremental reconciliation is a no-op when current and advances after one canonical append', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-incremental-');
    try {
        const first = reconcileDerivedSqliteCatalog(workspaceRoot, {
            clock: () => '2026-08-03T12:30:00.000Z'
        });
        assert.equal(first.status, 'applied');
        const beforeDatabase = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot), { readOnly: true });
        const beforeSources = beforeDatabase.prepare(`
            SELECT source_path, observed_at_utc FROM canonical_sources
        `).all() as Array<{ source_path: string; observed_at_utc: string }>;
        beforeDatabase.close();
        const beforeObserved = new Map(beforeSources.map((row) => [row.source_path, row.observed_at_utc]));

        const unchanged = reconcileDerivedSqliteCatalog(workspaceRoot, {
            clock: () => '2026-08-03T12:31:00.000Z'
        });
        assert.equal(unchanged.status, 'current');
        assert.equal(unchanged.generation, first.generation);

        appendTaskEvent(
            workspaceRoot,
            TASK_ID,
            'COMPILE_GATE_PASSED',
            'PASS',
            'Compile passed.',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        const changed = reconcileDerivedSqliteCatalog(workspaceRoot, {
            clock: () => '2026-08-03T12:32:00.000Z'
        });
        assert.equal(changed.status, 'applied');
        assert.equal(changed.generation, Number(first.generation) + 1);
        assert.deepEqual(changed.changedSources, [
            `runtime/task-events/${TASK_ID}.jsonl`,
            'runtime-generation'
        ]);
        const afterDatabase = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot), { readOnly: true });
        const afterSources = afterDatabase.prepare(`
            SELECT source_path, observed_at_utc FROM canonical_sources
        `).all() as Array<{ source_path: string; observed_at_utc: string }>;
        afterDatabase.close();
        const afterObserved = new Map(afterSources.map((row) => [row.source_path, row.observed_at_utc]));
        assert.equal(afterObserved.get('runtime/metrics.jsonl'), beforeObserved.get('runtime/metrics.jsonl'));
        assert.equal(afterObserved.get(`runtime/task-events/${TASK_ID}.jsonl`), '2026-08-03T12:32:00.000Z');

        const health = inspectDerivedCatalogHealth(workspaceRoot);
        assert.equal(health.status, 'healthy');
        assert.equal(health.parity, true);
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('zero-row canonical sources persist and converge in health and reconciliation', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-zero-row-source-');
    try {
        fs.writeFileSync(path.join(workspaceRoot, 'runtime', 'metrics.jsonl'), '', 'utf8');

        const first = reconcileDerivedSqliteCatalog(workspaceRoot, {
            clock: () => '2026-08-03T12:30:00.000Z'
        });
        assert.equal(first.status, 'applied');

        const database = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot), { readOnly: true });
        const source = database.prepare(`
            SELECT source_kind, source_path, content_sha256
            FROM canonical_sources
            WHERE source_path = ?
        `).get('runtime/metrics.jsonl') as Record<string, unknown> | undefined;
        database.close();
        assert.equal(source?.source_kind, 'metrics');
        assert.equal(source?.source_path, 'runtime/metrics.jsonl');
        assert.equal(source?.content_sha256, createHash('sha256').update('').digest('hex'));

        const health = inspectDerivedCatalogHealth(workspaceRoot);
        assert.equal(health.status, 'healthy');
        assert.equal(health.parity, true);
        assert.deepEqual(health.changedSources, []);

        const unchanged = reconcileDerivedSqliteCatalog(workspaceRoot, {
            clock: () => '2026-08-03T12:31:00.000Z'
        });
        assert.equal(unchanged.status, 'current');
        assert.deepEqual(unchanged.changedSources, []);
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('incremental event reconciliation refreshes attempts together with unchanged pinned artifacts', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-artifact-dependency-');
    try {
        const artifactPath = path.join(workspaceRoot, 'runtime', 'reviews', `${TASK_ID}-code.md`);
        const artifactContent = '# Review\n\nStable artifact.\n';
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');
        const artifactSha256 = createHash('sha256').update(artifactContent).digest('hex');
        const attemptId = 'attempt-artifact-dependency';
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'Prepared.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent'
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEWER_DELEGATION_STARTED', 'INFO', 'Started.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent'
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', 'Recorded.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent',
            trust_level: 'INDEPENDENT_AUDITED',
            review_artifact_path: artifactPath,
            review_artifact_sha256: artifactSha256
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');

        appendTaskEvent(
            workspaceRoot,
            TASK_ID,
            'DOC_IMPACT_RECORDED',
            'PASS',
            'Event source changed while the review artifact stayed immutable.',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        const refreshed = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(refreshed.status, 'applied');
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
        const database = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot), { readOnly: true });
        const artifactCount = database.prepare('SELECT count(*) AS count FROM artifacts').get() as { count: number };
        const attemptCount = database.prepare('SELECT count(*) AS count FROM review_attempts').get() as { count: number };
        database.close();
        assert.equal(Number(artifactCount.count), 1);
        assert.equal(Number(attemptCount.count), 1);
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('runtime generation invalidates an otherwise unchanged snapshot without opening SQLite in the writer', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-generation-');
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        const before = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(before.status, 'available');
        if (before.status !== 'available') return;
        const storedGeneration = before.catalog.inspect().canonicalGeneration;
        before.catalog.close();

        writeReviewArtifactText(
            path.join(workspaceRoot, 'runtime', 'reviews', 'unreferenced-note.md'),
            '# Unreferenced note\n',
            { lowNoiseRuntimeWrites: true }
        );

        const drift = inspectDerivedCatalogHealth(workspaceRoot);
        assert.equal(drift.status, 'drifted');
        assert.deepEqual(drift.changedSources, ['runtime-generation']);
        assert.equal(drift.canonicalSnapshotSha256, drift.catalogSnapshotSha256);
        assert.equal(drift.canonicalGeneration, storedGeneration);

        const refreshed = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(refreshed.status, 'applied');
        assert.deepEqual(refreshed.changedSources, ['runtime-generation']);
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('canonical scan rejects a mutation that commits between generation checkpoints', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-generation-race-');
    try {
        assert.throws(() => buildCanonicalCatalogProjection(workspaceRoot, {
            clock: () => {
                appendTaskEvent(
                    workspaceRoot,
                    TASK_ID,
                    'DOC_IMPACT_RECORDED',
                    'PASS',
                    'Mutation during scan.',
                    {},
                    { passThru: true, lowNoiseRuntimeWrites: true }
                );
                return '2026-08-03T12:33:00.000Z';
            }
        }), /canonical sources changed while the catalog snapshot was being built/u);
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('canonical scanner rejects a junctioned source directory outside the workspace', (context) => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-junction-');
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sqlite-reconcile-outside-'));
    const eventsDirectory = path.join(workspaceRoot, 'runtime', 'task-events');
    const outsideEventsDirectory = path.join(outsideRoot, 'task-events');
    try {
        fs.renameSync(eventsDirectory, outsideEventsDirectory);
        try {
            fs.symlinkSync(
                outsideEventsDirectory,
                eventsDirectory,
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES') {
                context.skip(`filesystem junctions unavailable: ${code}`);
                return;
            }
            throw error;
        }

        assert.throws(
            () => buildCanonicalCatalogProjection(workspaceRoot),
            /canonical source directory must be a real non-symlink directory|escapes the workspace/u
        );
    } finally {
        removeWorkspace(workspaceRoot);
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('canonical scanner rejects a matching symlinked source file instead of omitting it', (context) => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-file-symlink-');
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sqlite-reconcile-file-outside-'));
    const eventFile = path.join(workspaceRoot, 'runtime', 'task-events', `${TASK_ID}.jsonl`);
    const outsideEventFile = path.join(outsideRoot, `${TASK_ID}.jsonl`);
    try {
        if (process.platform === 'win32') {
            fs.rmSync(eventFile);
            fs.mkdirSync(outsideEventFile);
        } else {
            fs.renameSync(eventFile, outsideEventFile);
        }
        try {
            fs.symlinkSync(
                outsideEventFile,
                eventFile,
                process.platform === 'win32' ? 'junction' : 'file'
            );
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES') {
                context.skip(`filesystem symlinks unavailable: ${code}`);
                return;
            }
            throw error;
        }

        assert.throws(
            () => buildCanonicalCatalogProjection(workspaceRoot),
            (error: unknown) => (
                error instanceof CanonicalCatalogInputError
                && /canonical source must be a regular non-symlink file/u.test(error.message)
            )
        );
    } finally {
        removeWorkspace(workspaceRoot);
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

sqliteCatalogTest('malformed canonical input fails closed without mutating the last healthy projection', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-malformed-');
    try {
        const applied = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(applied.status, 'applied');
        fs.appendFileSync(
            path.join(workspaceRoot, 'runtime', 'task-events', `${TASK_ID}.jsonl`),
            '{broken json\n',
            'utf8'
        );

        const failed = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(failed.status, 'canonical_invalid');
        assert.match(failed.diagnostic, /invalid JSON/u);

        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status === 'available') {
            assert.equal(opened.catalog.inspect().generation, applied.generation);
            opened.catalog.close();
        }
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('health inspection does not migrate an older catalog or write coordination artifacts', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-read-only-health-');
    const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    const migrationV1 = SQLITE_CATALOG_MIGRATIONS[0];
    const database = new DatabaseSync(catalogPath);
    try {
        database.exec(`PRAGMA application_id = ${SQLITE_CATALOG_APPLICATION_ID};`);
        database.exec(migrationV1.sql);
        database.prepare(`
            INSERT INTO schema_migrations (version, name, checksum, applied_at_utc, app_version)
            VALUES (?, ?, ?, ?, ?)
        `).run(1, migrationV1.name, migrationV1.checksum, '2026-08-03T10:00:00.000Z', '1.1.0-test');
        database.exec('PRAGMA user_version = 1;');
    } finally {
        database.close();
    }
    const beforeBytes = fs.readFileSync(catalogPath);
    const beforeEntries = fs.readdirSync(path.dirname(catalogPath)).sort();
    try {
        const health = inspectDerivedCatalogHealth(workspaceRoot);
        assert.equal(health.status, 'unavailable');
        assert.match(health.diagnostic, /requires writable migration/iu);
        assert.deepEqual(fs.readFileSync(catalogPath), beforeBytes);
        assert.deepEqual(fs.readdirSync(path.dirname(catalogPath)).sort(), beforeEntries);

        const unchanged = new DatabaseSync(catalogPath, { readOnly: true });
        try {
            const version = unchanged.prepare('PRAGMA user_version').get() as Record<string, unknown>;
            assert.equal(Number(Object.values(version)[0]), 1);
            const columns = unchanged.prepare('PRAGMA table_info("catalog_state")').all()
                .map((row) => String((row as Record<string, unknown>).name || ''));
            assert.equal(columns.includes('canonical_generation'), false);
        } finally {
            unchanged.close();
        }
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('health detects drift and repair stays preview-first until apply is explicit', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-repair-');
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        const taskPath = path.join(workspaceRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace('🟨 IN_PROGRESS', '🟩 DONE'),
            'utf8'
        );

        const drift = inspectDerivedCatalogHealth(workspaceRoot);
        assert.equal(drift.status, 'drifted');
        assert.deepEqual(drift.changedSources, ['TASK.md']);

        const preview = repairDerivedSqliteCatalog(workspaceRoot);
        assert.equal(preview.status, 'dry_run');
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'drifted');

        const repair = repairDerivedSqliteCatalog(workspaceRoot, { apply: true });
        assert.equal(repair.status, 'repaired');
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('parity validation detects catalog-row tampering even when the snapshot hash is unchanged', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-parity-');
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const database = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot));
        database.prepare('UPDATE task_queue_rows SET title = ? WHERE task_id = ?')
            .run('tampered title', TASK_ID);
        database.close();

        const health = inspectDerivedCatalogHealth(workspaceRoot);
        assert.equal(health.status, 'drifted');
        assert.equal(health.parity, false);
        assert.ok(health.changedSources.includes('sqlite:task_queue_rows'));
        assert.equal(repairDerivedSqliteCatalog(workspaceRoot, { apply: true }).status, 'repaired');
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('projection contention defers without blocking canonical reads or writes', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-busy-');
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status !== 'available') return;

        appendTaskEvent(
            workspaceRoot,
            TASK_ID,
            'DOC_IMPACT_RECORDED',
            'PASS',
            'Docs checked.',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        const deferred = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(deferred.status, 'deferred');
        assert.equal(deferred.canonicalReadable, true);
        opened.catalog.close();
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('confirmed repair quarantines a corrupt catalog and rebuilds from canonical files', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-corrupt-');
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
        fs.writeFileSync(catalogPath, Buffer.from('not a sqlite database', 'utf8'));

        const health = inspectDerivedCatalogHealth(workspaceRoot);
        assert.equal(health.status, 'corrupt');
        assert.equal(health.canonicalReadable, true);

        const repaired = repairDerivedSqliteCatalog(workspaceRoot, { apply: true });
        assert.equal(repaired.status, 'repaired');
        assert.ok(repaired.quarantinePath);
        assert.equal(fs.existsSync(String(repaired.quarantinePath)), true);
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('canonical-first wrapper preserves a successful canonical write when projection refresh fails', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-canonical-first-');
    try {
        const markerPath = path.join(workspaceRoot, 'canonical.txt');
        const result = canonicalFirstCatalogWrite(
            () => {
                fs.writeFileSync(markerPath, 'committed\n', 'utf8');
                return 'canonical-result';
            },
            () => {
                throw new Error('projection unavailable');
            }
        );

        assert.equal(result.canonicalResult, 'canonical-result');
        assert.equal(result.projectionStatus, 'deferred');
        assert.match(result.diagnostic || '', /projection unavailable/u);
        assert.equal(fs.readFileSync(markerPath, 'utf8'), 'committed\n');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('production canonical mutation commits reconcile an existing catalog without weakening canonical durability', async () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-production-write-');
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        assert.equal(initial.counts?.tasks, 1);

        const heldCatalog = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(heldCatalog.status, 'available');
        if (heldCatalog.status !== 'available') return;

        const taskPath = path.join(workspaceRoot, 'TASK.md');
        withRuntimeMutationGeneration(workspaceRoot, 'test-task-queue-write', () => {
            const current = fs.readFileSync(taskPath, 'utf8');
            fs.writeFileSync(
                taskPath,
                current.replace(
                    /\n$/u,
                    `\n| T-2000-2 | TODO | P2 | runtime/catalog | Follow-up task | agent | 2026-08-04 | balanced | Reconcile automatically. |\n`
                ),
                'utf8'
            );
        });
        const deferred = await flushScheduledDerivedSqliteCatalogReconciliation(workspaceRoot);
        assert.equal(deferred?.status, 'deferred');
        assert.match(fs.readFileSync(taskPath, 'utf8'), /T-2000-2/u);
        heldCatalog.catalog.close();

        withRuntimeMutationGeneration(workspaceRoot, 'test-task-queue-follow-up-write', () => {
            fs.appendFileSync(taskPath, '\n', 'utf8');
        });
        const applied = await flushScheduledDerivedSqliteCatalogReconciliation(workspaceRoot);
        assert.equal(applied?.status, 'applied');
        assert.equal(applied?.counts?.tasks, 2);
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('production scheduling defers before canonical scanning once the catalog exceeds its bounded envelope', async () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-production-bound-');
    try {
        const metricsPath = path.join(workspaceRoot, 'runtime', 'metrics.jsonl');
        const metrics = Array.from({ length: 5_100 }, (_, index) => JSON.stringify({
            timestamp_utc: new Date(Date.UTC(2026, 7, 3, 12, 0, 0, index)).toISOString(),
            metric_type: 'automatic_reconciliation_bound',
            value: index,
            unit: 'count',
            task_id: TASK_ID,
            metadata: {}
        })).join('\n') + '\n';
        fs.writeFileSync(metricsPath, metrics, 'utf8');
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');

        const taskPath = path.join(workspaceRoot, 'TASK.md');
        withRuntimeMutationGeneration(workspaceRoot, 'test-bounded-production-write', () => {
            fs.writeFileSync(metricsPath, '{malformed-json', 'utf8');
            fs.appendFileSync(taskPath, '\n', 'utf8');
        });
        const deferred = await flushScheduledDerivedSqliteCatalogReconciliation(workspaceRoot);
        assert.equal(deferred?.status, 'deferred');
        assert.equal(deferred?.canonicalReadable, false);
        assert.match(deferred?.diagnostic || '', /skipped before canonical scanning.*bounded automatic limit/iu);
        assert.doesNotMatch(deferred?.diagnostic || '', /invalid json/iu);
        assert.equal(fs.readFileSync(metricsPath, 'utf8'), '{malformed-json');

        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status === 'available') {
            assert.equal(opened.catalog.inspect().generation, initial.generation);
            opened.catalog.close();
        }
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('production scheduling defers before reading a large referenced review artifact', async () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-production-artifact-bound-');
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');

        const artifactPath = path.join(
            workspaceRoot,
            'runtime',
            'reviews',
            `${TASK_ID}-performance-review-output.md`
        );
        const artifactContent = 'x'.repeat((512 * 1024) + 1);
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');
        const artifactSha256 = createHash('sha256').update(artifactContent).digest('hex');
        appendTaskEvent(
            workspaceRoot,
            TASK_ID,
            'REVIEW_RECORDED',
            'PASS',
            'Performance review recorded.',
            {
                review_type: 'performance',
                review_attempt_id: 'performance-1',
                review_output_path: path.relative(workspaceRoot, artifactPath).replace(/\\/gu, '/'),
                review_output_sha256: artifactSha256
            },
            { passThru: true, lowNoiseRuntimeWrites: true }
        );

        const metricsPath = path.join(workspaceRoot, 'runtime', 'metrics.jsonl');
        fs.writeFileSync(metricsPath, '{malformed-json', 'utf8');
        const deferred = await flushScheduledDerivedSqliteCatalogReconciliation(workspaceRoot);
        assert.equal(deferred?.status, 'deferred');
        assert.equal(deferred?.canonicalReadable, false);
        assert.match(deferred?.diagnostic || '', /canonical workload.*bounded automatic limit/iu);
        assert.doesNotMatch(deferred?.diagnostic || '', /invalid json/iu);
        assert.equal(fs.readFileSync(artifactPath, 'utf8').length, artifactContent.length);

        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status === 'available') {
            assert.equal(opened.catalog.inspect().generation, initial.generation);
            opened.catalog.close();
        }
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('production scheduling defers before canonical scanning while a peer owns a read-only connection', async () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-production-peer-read-only-');
    let peer: ReturnType<typeof spawn> | null = null;
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const modulePath = require.resolve('../../../src/runtime/sqlite-catalog/sqlite-catalog');
        const peerScript = [
            "const { openDerivedSqliteCatalogReadOnly } = require(process.argv[1]);",
            'const opened = openDerivedSqliteCatalogReadOnly(process.argv[2]);',
            "if (opened.status !== 'available') { process.stderr.write(opened.diagnostic); process.exit(2); }",
            "process.stdout.write('READY\\n');",
            "process.stdin.once('data', () => {",
            '  opened.catalog.close();',
            '  process.exit(0);',
            '});',
            'setTimeout(() => {}, 60_000);'
        ].join('\n');
        peer = spawn(process.execPath, ['--eval', peerScript, modulePath, workspaceRoot], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        await waitForChildOutput(peer, 'READY');

        const metricsPath = path.join(workspaceRoot, 'runtime', 'metrics.jsonl');
        withRuntimeMutationGeneration(workspaceRoot, 'test-peer-production-write', () => {
            fs.writeFileSync(metricsPath, '{malformed-json', 'utf8');
        });
        const deferred = await flushScheduledDerivedSqliteCatalogReconciliation(workspaceRoot);
        assert.equal(deferred?.status, 'deferred');
        assert.equal(deferred?.canonicalReadable, false);
        assert.match(deferred?.diagnostic || '', /live SQLite catalog connection lease/iu);
        assert.doesNotMatch(deferred?.diagnostic || '', /invalid json/iu);

        const exitPromise = once(peer, 'exit');
        peer.stdin?.end('close\n');
        const [exitCode] = await exitPromise;
        assert.equal(exitCode, 0);
        peer = null;
    } finally {
        peer?.kill();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild rejects a staging catalog that fails the full integrity check', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-integrity-');
    const originalPrepare = DatabaseSync.prototype.prepare;
    let preparePatched = false;
    let integrityCheckObserved = false;
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        DatabaseSync.prototype.prepare = function (
            this: DatabaseSync,
            sql: string
        ): ReturnType<DatabaseSync['prepare']> {
            if (sql.trim().toLowerCase() === 'pragma integrity_check') {
                integrityCheckObserved = true;
                return {
                    all: () => [{ integrity_check: 'simulated corruption' }]
                } as unknown as ReturnType<DatabaseSync['prepare']>;
            }
            return originalPrepare.call(this, sql);
        };
        preparePatched = true;

        const rebuild = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(integrityCheckObserved, true);
        assert.equal(rebuild.status, 'deferred');
        assert.match(rebuild.diagnostic, /integrity_check did not return exactly one ok result/iu);
    } finally {
        if (preparePatched) DatabaseSync.prototype.prepare = originalPrepare;
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild leaves the live catalog untouched when its WAL checkpoint cannot be proven', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-live-checkpoint-');
    const originalPrepare = DatabaseSync.prototype.prepare;
    let preparePatched = false;
    let checkpointCount = 0;
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        DatabaseSync.prototype.prepare = function (
            this: DatabaseSync,
            sql: string
        ): ReturnType<DatabaseSync['prepare']> {
            if (sql.trim().toLowerCase() === 'pragma wal_checkpoint(truncate)') {
                checkpointCount += 1;
                if (checkpointCount === 2) {
                    return {
                        get: () => ({ busy: 1, log: 1, checkpointed: 0 })
                    } as unknown as ReturnType<DatabaseSync['prepare']>;
                }
            }
            return originalPrepare.call(this, sql);
        };
        preparePatched = true;

        const rebuild = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(checkpointCount, 2);
        assert.equal(rebuild.status, 'deferred');
        assert.match(rebuild.diagnostic, /live WAL checkpoint did not prove/iu);
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status === 'available') {
            assert.equal(opened.catalog.inspect().generation, initial.generation);
            opened.catalog.close();
        }
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        if (preparePatched) DatabaseSync.prototype.prepare = originalPrepare;
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild keeps the live main in place until atomic staged replacement', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-atomic-replace-');
    const originalRenameSync = fsModule.renameSync;
    let renamePatched = false;
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
        let liveMainMoved = false;
        let promotionAttempted = false;
        fsModule.renameSync = ((oldPath, newPath) => {
            if (typeof oldPath === 'string' && path.resolve(oldPath) === path.resolve(catalogPath)) {
                liveMainMoved = true;
            }
            if (
                typeof oldPath === 'string'
                && typeof newPath === 'string'
                && path.resolve(newPath) === path.resolve(catalogPath)
                && path.resolve(oldPath) !== path.resolve(catalogPath)
            ) {
                promotionAttempted = true;
                throw new Error('simulated atomic replacement failure');
            }
            originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        renamePatched = true;

        const rebuild = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(promotionAttempted, true);
        assert.equal(liveMainMoved, false);
        assert.equal(rebuild.status, 'deferred');
        assert.match(rebuild.diagnostic, /simulated atomic replacement failure/iu);
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status === 'available') {
            assert.equal(opened.catalog.inspect().generation, initial.generation);
            opened.catalog.close();
        }
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        if (renamePatched) fsModule.renameSync = originalRenameSync;
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild rejects a catalog-directory link before staging writes', (context) => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-linked-catalog-');
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sqlite-rebuild-outside-'));
    const catalogDirectory = path.join(workspaceRoot, 'runtime', 'catalog');
    try {
        try {
            fs.symlinkSync(
                outsideRoot,
                catalogDirectory,
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        } catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException)?.code || '');
            if (code === 'EPERM' || code === 'EACCES') {
                context.skip(`filesystem links unavailable: ${code}`);
                return;
            }
            throw error;
        }

        const rebuilt = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(rebuilt.status, 'unavailable');
        assert.match(rebuilt.diagnostic, /escapes root through a filesystem link/iu);
        assert.deepEqual(fs.readdirSync(outsideRoot), []);
    } finally {
        fs.rmSync(catalogDirectory, { recursive: true, force: true });
        removeWorkspace(workspaceRoot);
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

sqliteCatalogTest('explicit rebuild rejects a linked backup directory without writing outside the catalog', (context) => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-backup-link-');
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sqlite-reconcile-backup-outside-'));
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const catalogDirectory = path.dirname(resolveDerivedSqliteCatalogPath(workspaceRoot));
        const backupsRoot = path.join(catalogDirectory, 'backups');
        try {
            fs.symlinkSync(outsideRoot, backupsRoot, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES') {
                context.skip(`filesystem junctions unavailable: ${code}`);
                return;
            }
            throw error;
        }

        const rebuild = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(rebuild.status, 'deferred');
        assert.match(rebuild.diagnostic, /recovery directory.*non-symlink|escapes the catalog/iu);
        assert.deepEqual(fs.readdirSync(outsideRoot), []);
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

sqliteCatalogTest('confirmed repair rejects a linked quarantine directory without moving the corrupt catalog', (context) => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-quarantine-link-');
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sqlite-reconcile-quarantine-outside-'));
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
        fs.writeFileSync(catalogPath, Buffer.from('not a sqlite database', 'utf8'));
        const quarantineRoot = path.join(path.dirname(catalogPath), 'quarantine');
        try {
            fs.symlinkSync(outsideRoot, quarantineRoot, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES') {
                context.skip(`filesystem junctions unavailable: ${code}`);
                return;
            }
            throw error;
        }

        const repair = repairDerivedSqliteCatalog(workspaceRoot, { apply: true });
        assert.equal(repair.status, 'deferred');
        assert.match(repair.diagnostic, /recovery directory.*non-symlink|escapes the catalog/iu);
        assert.deepEqual(fs.readdirSync(outsideRoot), []);
        assert.equal(fs.existsSync(catalogPath), true);
    } finally {
        removeWorkspace(workspaceRoot);
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

sqliteCatalogTest('explicit rebuild validates staged parity before replacing the live catalog', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-pre-promotion-parity-');
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalRenameSync = fsModule.renameSync;
    let preparePatched = false;
    let renamePatched = false;
    let stagingParityTampered = false;
    let promotionAttempted = false;
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
        DatabaseSync.prototype.prepare = function (
            this: DatabaseSync,
            sql: string
        ): ReturnType<DatabaseSync['prepare']> {
            const normalizedSql = sql.replace(/\s+/gu, ' ').trim().toLowerCase();
            if (
                !stagingParityTampered
                && normalizedSql.startsWith('select task_id, status, priority')
                && normalizedSql.endsWith('from task_queue_rows')
            ) {
                stagingParityTampered = true;
                return {
                    all: () => []
                } as unknown as ReturnType<DatabaseSync['prepare']>;
            }
            return originalPrepare.call(this, sql);
        };
        preparePatched = true;
        fsModule.renameSync = ((oldPath, newPath) => {
            if (
                typeof oldPath === 'string'
                && typeof newPath === 'string'
                && path.resolve(newPath) === path.resolve(catalogPath)
                && path.resolve(oldPath) !== path.resolve(catalogPath)
            ) {
                promotionAttempted = true;
            }
            originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        renamePatched = true;

        const rebuild = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(stagingParityTampered, true);
        assert.equal(promotionAttempted, false);
        assert.equal(rebuild.status, 'deferred');
        assert.match(rebuild.diagnostic, /staging catalog parity failed.*task_queue_rows/iu);
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status === 'available') {
            assert.equal(opened.catalog.inspect().generation, initial.generation);
            opened.catalog.close();
        }
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        if (renamePatched) fsModule.renameSync = originalRenameSync;
        if (preparePatched) DatabaseSync.prototype.prepare = originalPrepare;
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('interrupted explicit rebuild preserves the prior live catalog for fallback and repair', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-crash-');
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        appendTaskEvent(
            workspaceRoot,
            TASK_ID,
            'FULL_SUITE_VALIDATION_PASSED',
            'PASS',
            'Full suite passed.',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        let interrupted = false;
        const rebuild = rebuildDerivedSqliteCatalog(workspaceRoot, {
            batchSize: 1,
            onProgress: () => {
                if (!interrupted) {
                    interrupted = true;
                    throw new Error('simulated process interruption');
                }
            }
        });
        assert.equal(rebuild.status, 'deferred');
        assert.equal(rebuild.canonicalReadable, true);
        const health = inspectDerivedCatalogHealth(workspaceRoot);
        assert.equal(health.status, 'drifted');
        assert.equal(health.generation, initial.generation);
        assert.equal(repairDerivedSqliteCatalog(workspaceRoot, { apply: true }).status, 'repaired');
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild defers while this process owns the live catalog connection', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-rebuild-open-');
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status !== 'available') return;
        try {
            const deferred = rebuildDerivedSqliteCatalog(workspaceRoot);
            assert.equal(deferred.status, 'deferred');
            assert.match(deferred.diagnostic, /safely closed|already owns/u);
        } finally {
            opened.catalog.close();
        }
        assert.equal(rebuildDerivedSqliteCatalog(workspaceRoot).status, 'rebuilt');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild defers while a peer process owns the live catalog connection', async () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-rebuild-peer-open-');
    let peer: ReturnType<typeof spawn> | null = null;
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const modulePath = require.resolve('../../../src/runtime/sqlite-catalog');
        const peerScript = [
            "const { openDerivedSqliteCatalog } = require(process.argv[1]);",
            'const opened = openDerivedSqliteCatalog(process.argv[2]);',
            "if (opened.status !== 'available') { process.stderr.write(opened.diagnostic); process.exit(2); }",
            "process.stdout.write('READY\\n');",
            "process.stdin.once('data', () => {",
            '  try {',
            '    opened.catalog.close();',
            "    process.stdout.write('CLOSED\\n');",
            '    process.exit(0);',
            '  } catch (error) {',
            '    process.stderr.write(String(error));',
            '    process.exit(3);',
            '  }',
            '});',
            'setTimeout(() => {}, 60_000);'
        ].join('\n');
        peer = spawn(process.execPath, ['--eval', peerScript, modulePath, workspaceRoot], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        await waitForChildOutput(peer, 'READY');

        const deferred = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(deferred.status, 'deferred');
        assert.match(deferred.diagnostic, /live SQLite catalog connection lease/iu);

        const exitPromise = once(peer, 'exit');
        peer.stdin?.end('close\n');
        const [exitCode] = await exitPromise;
        assert.equal(exitCode, 0);
        peer = null;
        assert.equal(rebuildDerivedSqliteCatalog(workspaceRoot).status, 'rebuilt');
    } finally {
        peer?.kill();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild defers while a peer process owns a read-only catalog connection', async () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-rebuild-peer-read-only-');
    let peer: ReturnType<typeof spawn> | null = null;
    try {
        assert.equal(reconcileDerivedSqliteCatalog(workspaceRoot).status, 'applied');
        const modulePath = require.resolve('../../../src/runtime/sqlite-catalog/sqlite-catalog');
        const peerScript = [
            "const { openDerivedSqliteCatalogReadOnly } = require(process.argv[1]);",
            'const opened = openDerivedSqliteCatalogReadOnly(process.argv[2]);',
            "if (opened.status !== 'available') { process.stderr.write(opened.diagnostic); process.exit(2); }",
            "process.stdout.write('READY\\n');",
            "process.stdin.once('data', () => {",
            '  try {',
            '    opened.catalog.close();',
            "    process.stdout.write('CLOSED\\n');",
            '    process.exit(0);',
            '  } catch (error) {',
            '    process.stderr.write(String(error));',
            '    process.exit(3);',
            '  }',
            '});',
            'setTimeout(() => {}, 60_000);'
        ].join('\n');
        peer = spawn(process.execPath, ['--eval', peerScript, modulePath, workspaceRoot], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        await waitForChildOutput(peer, 'READY');

        const deferred = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(deferred.status, 'deferred');
        assert.match(deferred.diagnostic, /live SQLite catalog connection lease/iu);

        const exitPromise = once(peer, 'exit');
        peer.stdin?.end('close\n');
        const [exitCode] = await exitPromise;
        assert.equal(exitCode, 0);
        peer = null;
        assert.equal(rebuildDerivedSqliteCatalog(workspaceRoot).status, 'rebuilt');
    } finally {
        peer?.kill();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild rolls back when canonical data changes in the promotion window', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-promotion-race-');
    const originalRenameSync = fsModule.renameSync;
    let renamePatched = false;
    try {
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
        let mutationInjected = false;
        fsModule.renameSync = ((oldPath, newPath) => {
            if (
                !mutationInjected
                && typeof oldPath === 'string'
                && typeof newPath === 'string'
                && path.resolve(newPath) === path.resolve(catalogPath)
                && path.resolve(oldPath) !== path.resolve(catalogPath)
            ) {
                mutationInjected = true;
                appendTaskEvent(
                    workspaceRoot,
                    TASK_ID,
                    'DOC_IMPACT_RECORDED',
                    'PASS',
                    'Mutation in catalog promotion window.',
                    {},
                    { passThru: true, lowNoiseRuntimeWrites: true }
                );
            }
            originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        renamePatched = true;

        const rebuild = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(mutationInjected, true);
        assert.equal(rebuild.status, 'deferred');
        assert.match(rebuild.diagnostic, /canonical sources changed during catalog promotion/iu);

        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status === 'available') {
            assert.equal(opened.catalog.inspect().generation, initial.generation);
            opened.catalog.close();
        }
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'drifted');
    } finally {
        if (renamePatched) fsModule.renameSync = originalRenameSync;
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild rolls back when a pinned review artifact changes in the promotion window', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-artifact-promotion-race-');
    const originalRenameSync = fsModule.renameSync;
    let renamePatched = false;
    try {
        const artifactPath = path.join(workspaceRoot, 'runtime', 'reviews', `${TASK_ID}-code.md`);
        const artifactContent = '# Review\n\nPinned findings.\n';
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');
        const artifactSha256 = createHash('sha256').update(artifactContent).digest('hex');
        const attemptId = 'attempt-promotion-race';
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'Prepared.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent'
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEWER_DELEGATION_STARTED', 'INFO', 'Started.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent'
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        appendTaskEvent(workspaceRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', 'Recorded.', {
            review_type: 'code',
            reviewer_launch_attempt_id: attemptId,
            reviewer_identity: 'agent:reviewer',
            reviewer_execution_mode: 'delegated_subagent',
            trust_level: 'INDEPENDENT_AUDITED',
            review_artifact_path: artifactPath,
            review_artifact_sha256: artifactSha256
        }, { passThru: true, lowNoiseRuntimeWrites: true });
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');
        const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
        let mutationInjected = false;
        fsModule.renameSync = ((oldPath, newPath) => {
            if (
                !mutationInjected
                && typeof oldPath === 'string'
                && typeof newPath === 'string'
                && path.resolve(newPath) === path.resolve(catalogPath)
                && path.resolve(oldPath) !== path.resolve(catalogPath)
            ) {
                mutationInjected = true;
                fs.writeFileSync(artifactPath, '# Review\n\nChanged during promotion.\n', 'utf8');
            }
            originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        renamePatched = true;

        const rebuild = rebuildDerivedSqliteCatalog(workspaceRoot);
        assert.equal(mutationInjected, true);
        assert.equal(rebuild.status, 'deferred');
        assert.match(rebuild.diagnostic, /artifact.*does not match event-declared SHA-256/iu);
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'available');
        if (opened.status === 'available') {
            assert.equal(opened.catalog.inspect().generation, initial.generation);
            opened.catalog.close();
        }
    } finally {
        if (renamePatched) fsModule.renameSync = originalRenameSync;
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('incremental reconciliation bounds combined deleted and inserted rows', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-combined-limit-');
    try {
        const metricsPath = path.join(workspaceRoot, 'runtime', 'metrics.jsonl');
        const writeMetrics = (offset: number): void => {
            const metrics = Array.from({ length: 5_100 }, (_, index) => JSON.stringify({
                timestamp_utc: new Date(Date.UTC(2026, 7, 3, 12, 0, 0, index)).toISOString(),
                metric_type: 'bounded_replacement_sample',
                value: offset + index,
                unit: 'count',
                task_id: TASK_ID,
                metadata: {}
            })).join('\n') + '\n';
            fs.writeFileSync(metricsPath, metrics, 'utf8');
        };
        writeMetrics(0);
        const initial = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(initial.status, 'applied');

        writeMetrics(10_000);
        const bounded = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(bounded.status, 'rebuild_required');
        assert.equal(bounded.generation, initial.generation);
        assert.match(bounded.diagnostic, /synchronous transaction limit/iu);
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'drifted');

        assert.equal(rebuildDerivedSqliteCatalog(workspaceRoot).status, 'rebuilt');
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild accepts a projection larger than the interactive transaction limit', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-large-');
    try {
        const metricsPath = path.join(workspaceRoot, 'runtime', 'metrics.jsonl');
        const metrics = Array.from({ length: 10_050 }, (_, index) => JSON.stringify({
            timestamp_utc: new Date(Date.UTC(2026, 7, 3, 12, 0, 0, index)).toISOString(),
            metric_type: 'stress_sample',
            value: index,
            unit: 'count',
            task_id: TASK_ID,
            metadata: {}
        })).join('\n') + '\n';
        fs.writeFileSync(metricsPath, metrics, 'utf8');

        const incremental = reconcileDerivedSqliteCatalog(workspaceRoot);
        assert.equal(incremental.status, 'rebuild_required');
        const progress: number[] = [];
        const rebuilt = rebuildDerivedSqliteCatalog(workspaceRoot, {
            onProgress: (event) => progress.push(event.completedRows)
        });
        assert.equal(rebuilt.status, 'rebuilt');
        assert.equal(rebuilt.counts?.metricSamples, 10_050);
        assert.ok(progress.length > 1);
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('explicit rebuild bounds metric-label fan-out by inserted rows', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-reconcile-label-batches-');
    try {
        const metricsPath = path.join(workspaceRoot, 'runtime', 'metrics.jsonl');
        fs.writeFileSync(metricsPath, JSON.stringify({
            timestamp_utc: '2026-08-03T12:00:00.000Z',
            metric_type: 'label_fan_out',
            value: 1,
            unit: 'count',
            task_id: TASK_ID,
            metadata: { alpha: '1', beta: '2', delta: '4', epsilon: '5', gamma: '3' }
        }) + '\n', 'utf8');

        const progress: Array<{ phase: string; completedRows: number }> = [];
        const rebuilt = rebuildDerivedSqliteCatalog(workspaceRoot, {
            batchSize: 2,
            onProgress: (event) => progress.push({ phase: event.phase, completedRows: event.completedRows })
        });

        assert.equal(rebuilt.status, 'rebuilt');
        assert.equal(rebuilt.counts?.metricSamples, 1);
        assert.equal(rebuilt.counts?.metricLabels, 5);
        assert.equal(progress.filter((event) => event.phase === 'metric_labels').length, 3);
        for (let index = 1; index < progress.length; index += 1) {
            assert.ok(progress[index].completedRows - progress[index - 1].completedRows <= 2);
        }
        assert.equal(inspectDerivedCatalogHealth(workspaceRoot).status, 'healthy');
    } finally {
        removeWorkspace(workspaceRoot);
    }
});
