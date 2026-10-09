import {
    describe,
    it,
    beforeEach,
    afterEach,
    assert,
    fs,
    path,
    runCleanup,
    runGc,
    buildDefaultRetentionPolicy,
    processCleanupCandidates,
    appendTaskEvent,
    makeTmpDir,
    setupRuntimeDir,
    createDirectoryLink,
    createTimestampDir,
    daysAgo,
    createTaskEventFile,
    writeTaskTimeline,
    writeTimelineSummary,
    createReviewArtifacts,
    seedHealthyDoneTaskArtifacts,
    writeRuntimeRetentionPolicy,
    writeTaskQueue
} from './cleanup-fixtures';
import { mock } from 'node:test';
import { buildRuntimeRetentionPreview } from '../../../src/lifecycle/runtime-policy/runtime-retention-policy';

describe('buildDefaultRetentionPolicy', () => {
    it('returns sensible defaults', () => {
        const policy = buildDefaultRetentionPolicy();
        assert.equal(policy.maxAgeDays, 30);
        assert.equal(policy.maxBackups, 10);
        assert.equal(policy.maxTaskEvents, 50);
        assert.equal(policy.maxAggregateLines, 10000);
        assert.equal(policy.maxReviews, 100);
        assert.equal(policy.maxWorkingPlans, 100);
        assert.equal(policy.maxUpdateReports, 10);
        assert.equal(policy.maxUpdateRollbacks, 10);
        assert.equal(policy.maxBundleBackups, 10);
        assert.equal(policy.maxMetricsLines, 2000);
    });
});

describe('runCleanup', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-cleanup-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        // VERSION file required by validateTargetRoot
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        runtimeDir = setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup
        }
    });

    it('returns SUCCESS when runtime is empty', () => {
        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false
        });
        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.removed.length, 0);
        assert.equal(result.totalFreedBytes, 0);
    });

    it('returns SUCCESS when runtime dirs do not exist', () => {
        // Remove runtime entirely
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.mkdirSync(runtimeDir, { recursive: true });
        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false
        });
        assert.equal(result.result, 'SUCCESS');
    });

    function fractionalCompactArtifact(taskId: string, mtimeMs: number): string {
        writeTaskQueue(tmpDir, [{ id: taskId, status: 'DONE' }]);
        seedHealthyDoneTaskArtifacts({ bundleRoot, taskId, ageDays: 45 });
        writeRuntimeRetentionPolicy(bundleRoot);
        const configPath = path.join(bundleRoot, 'live', 'config', 'runtime-retention.json');
        const policy = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        policy.healthy_done.compact_after_days = 0;
        policy.healthy_done.require_ledger = false;
        fs.writeFileSync(configPath, JSON.stringify(policy));
        const artifact = path.join(runtimeDir, 'compact', taskId);
        fs.mkdirSync(artifact, { recursive: true });
        fs.writeFileSync(path.join(artifact, 'stdout.log'), 'fresh disposable output');
        fs.utimesSync(artifact, mtimeMs / 1000, mtimeMs / 1000);
        return artifact;
    }

    it('reports zero age for a fresh sub-millisecond filesystem timestamp', t => {
        t.after(() => mock.restoreAll());
        const observedMs = Date.parse('2026-10-07T12:00:00.000Z');
        const artifact = fractionalCompactArtifact('T-PRECISION-1', observedMs + 0.75);
        const actualMtime = fs.statSync(artifact).mtimeMs;
        assert.ok(actualMtime > observedMs && actualMtime < observedMs + 1);
        mock.method(Date, 'now', () => observedMs);
        const preview = buildRuntimeRetentionPreview(tmpDir, bundleRoot, [{ path: artifact, category: 'compact' }]);
        assert.equal(preview.tasks[0].age_days, 0);
        assert.equal(preview.tasks[0].latest_artifact_mtime_ms, observedMs);
        assert.equal(fs.readFileSync(path.join(artifact, 'stdout.log'), 'utf8'), 'fresh disposable output');
    });

    it('rejects premature retention of future artifacts at a zero-day threshold', t => {
        t.after(() => mock.restoreAll());
        const observedMs = Date.parse('2026-10-07T12:00:00.000Z');
        const artifact = fractionalCompactArtifact('T-PRECISION-2', observedMs + 1.75);
        mock.method(Date, 'now', () => observedMs);
        const preview = buildRuntimeRetentionPreview(tmpDir, bundleRoot, [{ path: artifact, category: 'compact' }]);
        assert.equal(preview.tasks[0].health_state, 'healthy_done');
        assert.equal(preview.tasks[0].threshold_days, 0);
        assert.equal(preview.tasks[0].age_days, -1);
        assert.equal(preview.tasks[0].eligible_now, false);
        assert.equal(fs.existsSync(artifact), true);
    });

    it('keeps day-boundary ages consistent with the published whole-millisecond timestamp', t => {
        t.after(() => mock.restoreAll());
        const observedMs = Date.parse('2026-10-07T12:00:00.000Z');
        const artifact = fractionalCompactArtifact('T-PRECISION-3', observedMs - 86_400_000 + 0.75);
        mock.method(Date, 'now', () => observedMs);
        const preview = buildRuntimeRetentionPreview(tmpDir, bundleRoot, [{ path: artifact, category: 'compact' }]);
        assert.equal(preview.tasks[0].latest_artifact_mtime_ms, observedMs - 86_400_000);
        assert.equal(preview.tasks[0].age_days, 1);
        assert.equal(fs.existsSync(artifact), true);
    });

    it('preserves active task review and task-event artifacts resolved from TASK.md', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const activeReviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const compactableDone = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-002',
            ageDays: 45
        });
        const lowercaseActiveReviewPath = path.join(reviewsDir, 't-001-preflight.json');
        fs.writeFileSync(lowercaseActiveReviewPath, JSON.stringify({ task_id: 't-001' }), 'utf8');
        const activeEventPath = createTaskEventFile(eventsDir, 'T-001');
        const activeCachePath = path.join(eventsDir, 'T-001.completeness.json');
        fs.writeFileSync(activeCachePath, '{}', 'utf8');

        const past = daysAgo(45);
        for (const entryPath of [
            ...activeReviewPaths,
            lowercaseActiveReviewPath,
            activeEventPath,
            activeCachePath,
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 100, maxTaskEvents: 100 }
        });

        assert.ok(result.removed.some((item) => item.path.endsWith('T-002.jsonl')));
        assert.ok(result.removed.some((item) => item.path.endsWith('T-002-task-mode.json')));
        assert.ok(result.removed.some((item) => item.path.endsWith('T-002-final-closeout.json')));
        assert.equal(fs.existsSync(activeEventPath), true, 'active task timeline should be preserved');
        assert.equal(fs.existsSync(activeCachePath), true, 'active task completeness cache should be preserved');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'active task review artifacts should be preserved');
        assert.equal(fs.existsSync(lowercaseActiveReviewPath), true, 'active task lowercase review artifacts should be preserved');
        assert.equal(fs.existsSync(compactableDone.timelinePath), false, 'eligible DONE task timeline should be compacted');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-002-task-mode.json')), false, 'inactive task review artifacts should be removed');
    });

    it('keeps latest runtime-retention tasks by artifact mtime instead of lexical task id order', () => {
        const newestLexicalFirst = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-010',
            ageDays: 45
        });
        const oldestLexicalLast = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-090',
            ageDays: 60
        });

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            runtimeRetentionSelection: {
                keepLatestTasks: 1
            }
        });

        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.runtimeRetentionPreview?.task_count, 1);
        assert.ok(result.removed.some((item) => item.taskId === 'T-090'));
        assert.equal(fs.existsSync(oldestLexicalLast.timelinePath), false,
            'oldest task should be compacted even when its task id sorts after the protected task');
        assert.equal(fs.existsSync(newestLexicalFirst.timelinePath), true,
            'newest task should be retained by mtime, not selected because it sorts first lexically');
    });

    it('does not apply daily age policy to manual keep-latest-only selection', () => {
        writeRuntimeRetentionPolicy(bundleRoot, {
            dailyEligibleOlderThanDays: 60,
            dailyKeepLatestTasks: 0
        });
        writeTaskQueue(tmpDir, [
            { id: 'T-120', status: '🟩 DONE', title: 'Newest young task' },
            { id: 'T-130', status: '🟩 DONE', title: 'Older young task' }
        ]);
        const newestTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-120',
            ageDays: 35
        });
        const olderYoungTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-130',
            ageDays: 40
        });

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            runtimeRetentionSelection: {
                keepLatestTasks: 1
            }
        });

        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.runtimeRetentionPreview?.task_count, 1);
        assert.ok(result.removed.some((item) => item.taskId === 'T-130'),
            'manual count-only selection should compact the older non-latest task even when it is younger than daily age policy');
        assert.equal(fs.existsSync(olderYoungTask.timelinePath), false);
        assert.equal(fs.existsSync(newestTask.timelinePath), true);
    });

    it('filters manual runtime-retention cleanup by task artifact age before previewing work', () => {
        const youngTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-020',
            ageDays: 10
        });
        const oldTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-030',
            ageDays: 45
        });

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            runtimeRetentionSelection: {
                eligibleOlderThanDays: 30
            }
        });

        assert.equal(result.result, 'SUCCESS');
        assert.deepEqual(result.runtimeRetentionPreview?.tasks.map((task) => task.task_id), ['T-030']);
        assert.equal(fs.existsSync(oldTask.timelinePath), false);
        assert.equal(fs.existsSync(youngTask.timelinePath), true,
            'young task artifacts must remain outside the retention preview and deletion set');
    });

    it('applies runtime-retention task limit after eligibility classification', () => {
        const ineligibleOldTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-010',
            ageDays: 60
        });
        const eligibleOldTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-020',
            ageDays: 45
        });
        fs.rmSync(ineligibleOldTask.ledgerPath, { force: true });

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            runtimeRetentionTaskLimit: 1,
            runtimeRetentionSelection: {
                eligibleOlderThanDays: 30
            }
        });

        assert.equal(result.result, 'SUCCESS');
        assert.deepEqual(
            result.runtimeRetentionPreview?.tasks.map((task) => `${task.task_id}:${task.eligible_now}`),
            ['T-010:false', 'T-020:true']
        );
        assert.equal(fs.existsSync(ineligibleOldTask.timelinePath), true,
            'ineligible task must not consume the runtime retention task limit');
        assert.equal(fs.existsSync(eligibleOldTask.timelinePath), false,
            'eligible task should still be selected after ineligible preview tasks are classified');
    });

    it('uses non-ledger artifact age for runtime-retention age selection', () => {
        const oldTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-040',
            ageDays: 45
        });
        const recent = daysAgo(1);
        fs.utimesSync(oldTask.ledgerPath, recent, recent);

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            runtimeRetentionSelection: {
                eligibleOlderThanDays: 30
            }
        });

        const previewTask = result.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-040');
        assert.equal(previewTask?.eligible_now, true);
        assert.equal(fs.existsSync(oldTask.timelinePath), false,
            'recent verified ledger mtime must not hide old heavy task artifacts from age-based cleanup');
    });

    it('previews and removes inactive Markdown working plans while preserving active task plans', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' },
            { id: 'T-003', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const plansDir = path.join(runtimeDir, 'plans');
        fs.mkdirSync(plansDir, { recursive: true });
        const activePlanPath = path.join(plansDir, 'T-001.md');
        const nonTaskPlanPath = path.join(plansDir, 'scratch.md');
        const taskNamedDirectoryPath = path.join(plansDir, 'T-004.md');
        fs.writeFileSync(activePlanPath, '# active plan\n', 'utf8');
        fs.writeFileSync(nonTaskPlanPath, '# user scratch\n', 'utf8');
        fs.mkdirSync(taskNamedDirectoryPath);
        const inactiveTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-002',
            includePlan: true,
            ageDays: 45
        });
        const secondInactiveTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-003',
            includePlan: true,
            ageDays: 45
        });
        const past = daysAgo(45);
        for (const entryPath of [activePlanPath, nonTaskPlanPath, taskNamedDirectoryPath]) {
            fs.utimesSync(entryPath, past, past);
        }

        const dryRun = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: true,
            retentionPolicy: { maxAgeDays: 30, maxWorkingPlans: 100 }
        });
        assert.ok(dryRun.skipped.some((item) => item.category === 'plans' && item.path.endsWith('T-002.md')));
        assert.ok(!dryRun.skipped.some((item) => item.path.endsWith('T-001.md')));
        assert.equal(fs.existsSync(inactiveTask.planPath!), true, 'dry run must not remove working plans');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxWorkingPlans: 100 }
        });
        assert.ok(result.removed.some((item) => item.category === 'plans' && item.path.endsWith('T-002.md')));
        assert.equal(fs.existsSync(activePlanPath), true, 'active task working plan should be preserved');
        assert.equal(fs.existsSync(inactiveTask.planPath!), false, 'inactive aged working plan should be removed');
        assert.equal(fs.existsSync(secondInactiveTask.planPath!), false, 'inactive aged working plan should be removed');
        assert.equal(fs.existsSync(nonTaskPlanPath), true, 'non-task Markdown scratch file should be preserved');
        assert.equal(fs.existsSync(taskNamedDirectoryPath), true, 'task-named directories are not working-plan files');
    });

    it('fails closed for task artifacts when TASK.md cannot be read', () => {
        const taskMdPath = path.join(tmpDir, 'TASK.md');
        fs.mkdirSync(taskMdPath, { recursive: true });

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });

        const reviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const eventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'TASK_MODE_ENTERED' }
        ]);
        const backupPath = createTimestampDir(backupsDir, daysAgo(45));

        const past = daysAgo(45);
        for (const entryPath of [...reviewPaths, eventPath]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxBackups: 0, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'review artifacts should be preserved when TASK.md is unreadable');
        assert.equal(fs.existsSync(eventPath), true, 'task-event artifacts should be preserved when TASK.md is unreadable');
        assert.equal(fs.existsSync(backupPath), false, 'non-task artifacts may still be cleaned');
        assert.ok(result.removed.some((item) => item.path === backupPath), 'cleanup should still remove ordinary retention candidates');
    });

    it('fails closed for task artifacts when TASK.md is missing', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });

        const reviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const eventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'TASK_MODE_ENTERED' }
        ]);
        const backupPath = createTimestampDir(backupsDir, daysAgo(45));

        const past = daysAgo(45);
        for (const entryPath of [...reviewPaths, eventPath]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxBackups: 0, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'review artifacts should be preserved when TASK.md is missing');
        assert.equal(fs.existsSync(eventPath), true, 'task-event artifacts should be preserved when TASK.md is missing');
        assert.equal(fs.existsSync(backupPath), false, 'non-task artifacts may still be cleaned');
        assert.ok(result.removed.some((item) => item.path === backupPath), 'cleanup should still remove ordinary retention candidates');
    });

    it('merges runtime activity with TASK.md so stale queue snapshots do not prune live artifacts', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟩 DONE', title: 'Stale queue entry' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const activeReviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const compactableDone = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-002',
            ageDays: 45
        });
        const activeEventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'TODO', new_status: 'IN_PROGRESS' } }
        ]);

        const past = daysAgo(45);
        for (const entryPath of [
            ...activeReviewPaths,
            activeEventPath
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'runtime-active task review artifacts should survive stale TASK.md state');
        assert.equal(fs.existsSync(activeEventPath), true, 'runtime-active task timeline should survive stale TASK.md state');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-002-task-mode.json')), false, 'terminal runtime task review artifacts should still be eligible for cleanup');
        assert.equal(fs.existsSync(compactableDone.timelinePath), false, 'terminal runtime task timeline should still be eligible for cleanup');
        assert.ok(result.removed.some((item) => item.path.endsWith('T-002-task-mode.json')));
    });

    it('builds a runtime retention preview for eligible cleanup candidates', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        const plansDir = path.join(runtimeDir, 'plans');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(plansDir, { recursive: true });

        createReviewArtifacts(reviewsDir, 'T-001');
        fs.writeFileSync(path.join(plansDir, 'T-001.md'), '# active\n', 'utf8');
        seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-002',
            includePlan: true,
            ageDays: 45
        });
        writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'TODO', new_status: 'IN_PROGRESS' } }
        ]);
        writeTimelineSummary(eventsDir, 'T-001', {
            completenessStatus: 'INCOMPLETE',
            eventsMissing: ['COMPLETION_GATE_PASSED']
        });

        const past = daysAgo(45);
        for (const entryPath of [
            path.join(reviewsDir, 'T-001-task-mode.json'),
            path.join(eventsDir, 'T-001.jsonl'),
            path.join(plansDir, 'T-001.md')
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: true,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 100, maxTaskEvents: 100 }
        });

        assert.ok(result.runtimeRetentionPreview);
        assert.equal(result.runtimeRetentionPreview!.task_count, 1);
        const activeTask = result.runtimeRetentionPreview!.tasks.find((task) => task.task_id === 'T-001');
        const doneTask = result.runtimeRetentionPreview!.tasks.find((task) => task.task_id === 'T-002');
        assert.ok(doneTask);
        assert.equal(activeTask, undefined);
        assert.equal(doneTask!.health_state, 'healthy_done');
        assert.equal(doneTask!.retention_tier, 'compact_ledger_candidate');
        assert.equal(doneTask!.ledger_status, 'VERIFIED');
        assert.equal(doneTask!.eligible_now, true);
    });

    it('builds a runtime retention preview for eligible gc candidates', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        const plansDir = path.join(runtimeDir, 'plans');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(plansDir, { recursive: true });

        createReviewArtifacts(reviewsDir, 'T-001');
        fs.writeFileSync(path.join(plansDir, 'T-001.md'), '# active plan\n', 'utf8');
        seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-002',
            includePlan: true,
            ageDays: 45
        });
        appendTaskEvent(bundleRoot, 'T-001', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-001', 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
            previous_status: 'TODO',
            new_status: 'IN_PROGRESS'
        }, { passThru: true });
        writeTimelineSummary(eventsDir, 'T-001', {
            completenessStatus: 'INCOMPLETE',
            eventsMissing: ['COMPLETION_GATE_PASSED']
        });

        const past = daysAgo(45);
        for (const entryPath of [
            path.join(reviewsDir, 'T-001-task-mode.json'),
            path.join(eventsDir, 'T-001.jsonl'),
            path.join(plansDir, 'T-001.md')
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 100, maxTaskEvents: 100 }
        });

        assert.ok(result.runtimeRetentionPreview);
        assert.equal(result.runtimeRetentionPreview!.task_count, 1);
        const activeTask = result.runtimeRetentionPreview!.tasks.find((task) => task.task_id === 'T-001');
        const doneTask = result.runtimeRetentionPreview!.tasks.find((task) => task.task_id === 'T-002');
        assert.ok(doneTask);
        assert.equal(activeTask, undefined);
        assert.equal(doneTask!.health_state, 'healthy_done');
        assert.equal(doneTask!.retention_tier, 'compact_ledger_candidate');
        assert.equal(doneTask!.ledger_status, 'VERIFIED');
        assert.equal(doneTask!.eligible_now, true);
    });

    it('preserves a fresh lifecycle restart after an older terminal status', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟩 DONE', title: 'Recovered task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        createReviewArtifacts(reviewsDir, 'T-001');
        const compactableDone = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-002',
            ageDays: 45
        });
        const restartedEventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } },
            { event_type: 'TASK_MODE_ENTERED' }
        ]);

        const past = daysAgo(45);
        for (const entryPath of [
            restartedEventPath
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'fresh lifecycle restart should preserve recovered task artifacts');
        assert.equal(fs.existsSync(restartedEventPath), true, 'fresh lifecycle restart should preserve recovered task timeline');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-002-task-mode.json')), false, 'older terminal task should still be eligible for cleanup');
        assert.equal(fs.existsSync(compactableDone.timelinePath), false, 'older terminal task timeline should still be eligible for cleanup');
        assert.ok(result.removed.some((item) => item.path.endsWith('T-002-task-mode.json')));
    });

    it('does not let stale active TASK.md rows block compaction for verified healthy DONE tasks', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Stale active row' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const compactableDone = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-001',
            ageDays: 45
        });

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), false, 'verified healthy DONE evidence should override stale active TASK.md rows');
        assert.equal(fs.existsSync(compactableDone.timelinePath), false, 'verified healthy DONE timeline should still compact');
        assert.ok(result.removed.some((item) => item.path.endsWith('T-001-task-mode.json')));
    });

    it('prunes aggregate log when over maxAggregateLines', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.ok(result.aggregateRetention, 'aggregateRetention should be present');
        assert.equal(result.aggregateRetention!.pruned, true);
        assert.equal(result.aggregateRetention!.lines_before, 25);
        assert.equal(result.aggregateRetention!.lines_after, 10);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 10);
        assert.equal(JSON.parse(remaining[0]).seq, 15);
    });

    it('prunes aggregate log without deleting lines for active tasks', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' }
        ]);

        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i, task_id: i < 5 ? 'T-001' : 'T-900' })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.ok(result.aggregateRetention, 'aggregate pruning should still run');
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim())
            .map((line) => JSON.parse(line) as { seq: number; task_id: string });
        assert.ok(remaining.some((entry) => entry.task_id === 'T-001' && entry.seq === 0), 'active task lines should be preserved');
        assert.equal(remaining.filter((entry) => entry.task_id === 'T-001').length, 5, 'all active-task lines should survive pruning');
        assert.equal(remaining.length, 10, 'pruning should still trim unrelated aggregate lines');
    });

    it('does not prune aggregate log in dry-run mode', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: true,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.equal(result.aggregateRetention, undefined);
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 25);
    });

    it('prunes metrics log when over maxMetricsLines', () => {
        const metricsPath = path.join(runtimeDir, 'metrics.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxMetricsLines: 10 }
        });

        assert.ok(result.metricsRetention, 'metricsRetention should be present');
        assert.equal(result.metricsRetention!.pruned, true);
        assert.equal(result.metricsRetention!.lines_before, 25);
        assert.equal(result.metricsRetention!.lines_after, 10);

        const remaining = fs.readFileSync(metricsPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 10);
        assert.equal(JSON.parse(remaining[0]).seq, 15);
    });

    it('does not prune metrics log in dry-run mode', () => {
        const metricsPath = path.join(runtimeDir, 'metrics.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: true,
            retentionPolicy: { maxMetricsLines: 10 }
        });

        assert.equal(result.metricsRetention, undefined);
        const remaining = fs.readFileSync(metricsPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 25);
    });

    it('rejects cleanup candidates that escape runtime root through directory links', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        const outsideDir = path.join(tmpDir, 'outside-runtime');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });
        const outsideFile = path.join(outsideDir, 'keep.txt');
        fs.writeFileSync(outsideFile, 'keep', 'utf8');

        const linkedCandidate = path.join(reviewsDir, 'linked-outside');
        createDirectoryLink(outsideDir, linkedCandidate);

        const result = processCleanupCandidates([
            {
                path: linkedCandidate,
                category: 'reviews',
                reason: 'test-linked-runtime-root-escape',
                sizeBytes: 4
            }
        ], false, runtimeDir);

        assert.equal(result.removed.length, 0);
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0].message, /symlink|junction|outside permitted root|escapes permitted root/);
        assert.equal(fs.existsSync(linkedCandidate), true, 'link should remain untouched');
        assert.equal(fs.existsSync(outsideFile), true, 'outside target should remain untouched');
    });

});
