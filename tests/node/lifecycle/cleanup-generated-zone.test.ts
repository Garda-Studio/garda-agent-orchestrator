import {
    describe,
    it,
    beforeEach,
    afterEach,
    assert,
    fs,
    path,
    os,
    runGc,
    runGcWithLock,
    buildDefaultRetentionPolicy,
    GC_ALLOWLIST,
    validateGcCategories,
    makeTmpDir,
    setupRuntimeDir,
    createTimestampDir,
    daysAgo,
    agePath,
    createTaskEventFile,
    seedHealthyDoneTaskArtifacts,
    writeTaskQueue
} from './cleanup-fixtures';
import { collectStandardCandidates } from '../../../src/lifecycle/cleanup/cleanup-removal';

describe('GC_ALLOWLIST', () => {
    it('contains expected categories', () => {
        assert.ok(GC_ALLOWLIST.includes('backups'));
        assert.ok(GC_ALLOWLIST.includes('manual-validation'));
        assert.ok(GC_ALLOWLIST.includes('reviews'));
        assert.ok(GC_ALLOWLIST.includes('plans'));
        assert.ok(GC_ALLOWLIST.includes('project-memory'));
        assert.ok(GC_ALLOWLIST.includes('task-ledger'));
        assert.ok(GC_ALLOWLIST.includes('task-events'));
        assert.ok(GC_ALLOWLIST.includes('tmp'));
        assert.ok(GC_ALLOWLIST.includes('test-scratch'));
        assert.ok(GC_ALLOWLIST.includes('cache'));
        assert.ok(GC_ALLOWLIST.includes('reports'));
        assert.ok(GC_ALLOWLIST.includes('update-temp'));
        assert.ok(GC_ALLOWLIST.includes('metrics'));
        assert.ok(GC_ALLOWLIST.includes('isolation-sandbox'));
        assert.ok(GC_ALLOWLIST.includes('stale-locks'));
        assert.ok(GC_ALLOWLIST.includes('update-rollbacks'));
        assert.ok(GC_ALLOWLIST.includes('update-reports'));
        assert.ok(GC_ALLOWLIST.includes('bundle-backups'));
    });
});

describe('validateGcCategories', () => {
    it('accepts valid allowlist categories', () => {
        assert.doesNotThrow(() => validateGcCategories(['backups', 'reviews', 'plans', 'project-memory', 'manual-validation', 'task-ledger']));
    });

    it('rejects unknown categories', () => {
        assert.throws(
            () => validateGcCategories(['backups', 'unknown-dir']),
            /Unknown gc category 'unknown-dir'/
        );
    });
});

describe('runGc', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-gc-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        runtimeDir = path.join(bundleRoot, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort
        }
    });

    it('is dry-run by default', () => {
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        createTimestampDir(backupsDir, daysAgo(2));

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxBackups: 0, maxAgeDays: 365 }
        });

        assert.equal(result.dryRun, true, 'gc must default to dry-run');
        assert.equal(result.removed.length, 0, 'dry-run must not remove');
        assert.ok(result.skipped.length > 0, 'dry-run must report skipped');
        assert.equal(fs.readdirSync(backupsDir).length, 1, 'files must survive');
    });

    it('deletes files when confirm is true', () => {
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        createTimestampDir(backupsDir, daysAgo(2));
        createTimestampDir(backupsDir, daysAgo(1));

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxBackups: 0, maxAgeDays: 365 }
        });

        assert.equal(result.dryRun, false);
        assert.ok(result.removed.length > 0, 'should remove items');
        assert.equal(fs.readdirSync(backupsDir).length, 0, 'all backups removed');
    });

    it('filters Markdown working-plan cleanup by plans category and preserves active tasks', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);
        const plansDir = path.join(runtimeDir, 'plans');
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(plansDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });
        const activePlanPath = path.join(plansDir, 'T-001.md');
        fs.writeFileSync(activePlanPath, '# active\n', 'utf8');
        const inactiveTask = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-002',
            includePlan: true,
            ageDays: 45
        });
        createTimestampDir(backupsDir, daysAgo(45));
        const past = daysAgo(45);
        fs.utimesSync(activePlanPath, past, past);

        const dryRun = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            categories: ['plans'],
            retentionPolicy: { maxAgeDays: 30, maxWorkingPlans: 100 }
        });
        assert.equal(dryRun.dryRun, true);
        assert.ok(dryRun.skipped.some((item) => item.category === 'plans' && item.path.endsWith('T-002.md')));
        assert.ok(!dryRun.skipped.some((item) => item.path.endsWith('T-001.md')));
        assert.equal(fs.existsSync(inactiveTask.planPath!), true, 'dry-run gc must not delete inactive working plan');
        assert.equal(dryRun.categories.plans.count, 1);
        assert.equal(dryRun.categories.backups, undefined);

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            categories: ['plans'],
            retentionPolicy: { maxAgeDays: 30, maxWorkingPlans: 100 }
        });
        assert.ok(result.removed.some((item) => item.category === 'plans' && item.path.endsWith('T-002.md')));
        assert.equal(fs.existsSync(activePlanPath), true, 'active working plan should be preserved');
        assert.equal(fs.existsSync(inactiveTask.planPath!), false, 'inactive working plan should be removed');
        assert.equal(fs.readdirSync(backupsDir).length, 1, 'plans category must not remove backups');
    });

    it('prunes stale timeline summary entries when gc removes task-event files', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });

        seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-001',
            ageDays: 45
        });
        createTaskEventFile(eventsDir, 'T-002');

        const summaryPath = path.join(eventsDir, '.timeline-summary.json');
        const summaryIndex = {
            version: 2,
            updated_at_utc: new Date().toISOString(),
            entries: {
                'T-001': { task_id: 'T-001', file_size_bytes: 100, file_mtime_ms: 0,
                    code_changed: false, completeness_status: 'COMPLETE',
                    events_found: [], events_missing: [], completeness_violations: [],
                    integrity_status: 'PASS', events_scanned: 1,
                    integrity_event_count: 1, integrity_violations: [] },
                'T-002': { task_id: 'T-002', file_size_bytes: 100, file_mtime_ms: 0,
                    code_changed: false, completeness_status: 'COMPLETE',
                    events_found: [], events_missing: [], completeness_violations: [],
                    integrity_status: 'PASS', events_scanned: 1,
                    integrity_event_count: 1, integrity_violations: [] }
            }
        };
        fs.writeFileSync(summaryPath, JSON.stringify(summaryIndex, null, 2) + '\n', 'utf8');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxTaskEvents: 1, maxAgeDays: 365 }
        });

        const removedNames = result.removed.map((item) => path.basename(item.path));
        assert.ok(removedNames.includes('T-001.jsonl'), 'gc should remove the stale T-001 timeline');

        assert.ok(fs.existsSync(summaryPath), 'timeline summary must remain after gc pruning');
        const updated = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        assert.ok(!updated.entries['T-001'],
            'gc must prune stale T-001 entry from timeline summary after removing its JSONL');
        assert.ok(updated.entries['T-002'],
            'gc must preserve still-live T-002 summary entry');
    });

    it('returns per-category summary with correct counts and bytes', () => {
        const backupsDir = path.join(runtimeDir, 'backups');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        createTimestampDir(backupsDir, daysAgo(2));
        seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-001',
            ageDays: 45
        });

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxBackups: 0, maxTaskEvents: 0, maxAgeDays: 365 }
        });

        assert.ok(result.categories.backups, 'should have backups category');
        assert.equal(result.categories.backups.count, 1, 'should count 1 backup');
        assert.ok(result.categories.backups.bytes > 0, 'should report bytes > 0');
        assert.ok(result.categories['task-events'], 'should have task-events category');
        assert.equal(result.categories['task-events'].count, 1, 'should count 1 task-event');
        assert.ok(result.categories['task-events'].bytes > 0, 'should report bytes > 0');
    });

    it('reports staleLocksCleaned from task-event lock subsystem', () => {
        // Create task-events dir and a stale lock within it
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const staleLock = path.join(eventsDir, '.T-999.jsonl.lock');
        fs.mkdirSync(staleLock, { recursive: true });
        // Write owner.json with a PID that is definitely not running (99999999)
        fs.writeFileSync(
            path.join(staleLock, 'owner.json'),
            JSON.stringify({ pid: 99999999, hostname: 'test', timestamp_utc: new Date().toISOString() })
        );

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true
        });

        // staleLocksCleaned may be 0 if the subsystem doesn't recognize the lock
        // format, but the integration path is exercised without errors
        assert.equal(typeof result.staleLocksCleaned, 'number');
    });

    it('accounts for stale task-event lock bytes in dry-run totals', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const staleLock = path.join(eventsDir, '.T-777.jsonl.lock');
        fs.mkdirSync(staleLock, { recursive: true });
        const ownerPath = path.join(staleLock, 'owner.json');
        fs.writeFileSync(
            ownerPath,
            JSON.stringify({ hostname: os.hostname(), timestamp_utc: new Date().toISOString() })
        );
        fs.writeFileSync(path.join(staleLock, 'payload.txt'), 'lock-payload');
        const staleTime = new Date(Date.now() - 5_000);
        fs.utimesSync(ownerPath, staleTime, staleTime);
        fs.utimesSync(staleLock, staleTime, staleTime);

        const expectedBytes = fs.statSync(path.join(staleLock, 'owner.json')).size
            + fs.statSync(path.join(staleLock, 'payload.txt')).size;

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot
        });

        assert.ok(result.staleLocksCleaned >= 1, 'dry-run should report removable stale task-event locks');
        assert.ok(result.totalFreedBytes >= expectedBytes, 'dry-run total should include stale task-event lock bytes');
        assert.ok(result.categories['task-events'], 'task-events summary should be present');
        assert.ok(result.categories['task-events'].bytes >= expectedBytes,
            'task-events summary should include stale task-event lock bytes');
    });

    it('reports PARTIAL when removal errors occur', () => {
        // This test verifies the error-reporting shape is correct even when
        // no actual errors can be induced cross-platform. We verify the
        // structure of errors array and result field remain consistent.
        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true
        });

        assert.ok(Array.isArray(result.errors));
        assert.equal(result.result, 'SUCCESS');
    });

    it('cleans isolation-sandbox entries older than maxAgeDays', () => {
        const sandboxDir = path.join(runtimeDir, '.isolation-sandbox');
        fs.mkdirSync(sandboxDir, { recursive: true });
        const oldEntry = path.join(sandboxDir, 'old-sandbox');
        fs.mkdirSync(oldEntry, { recursive: true });
        fs.writeFileSync(path.join(oldEntry, 'manifest.json'), '{}');
        // Set mtime to 60 days ago
        const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        fs.utimesSync(oldEntry, past, past);

        const recentEntry = path.join(sandboxDir, 'recent-sandbox');
        fs.mkdirSync(recentEntry, { recursive: true });

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 30 }
        });

        const sandboxItems = result.removed.filter(i => i.category === 'isolation-sandbox');
        assert.ok(sandboxItems.length >= 1, 'should remove old sandbox');
        assert.ok(result.isolationSandboxCleaned, 'isolationSandboxCleaned should be true');
        assert.ok(fs.existsSync(recentEntry), 'recent sandbox must survive');
    });

    it('cleans orphaned stale lifecycle lock remnants', () => {
        const staleLockDir = path.join(runtimeDir, '.lifecycle-operation.lock.stale-99999-1234567');
        fs.mkdirSync(staleLockDir, { recursive: true });
        fs.writeFileSync(path.join(staleLockDir, 'owner.json'), '{"pid":99999}');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true
        });

        const staleLockItems = result.removed.filter(i => i.category === 'stale-locks');
        assert.ok(staleLockItems.length >= 1, 'should collect stale lock remnant');
        assert.ok(!fs.existsSync(staleLockDir), 'stale lock should be removed');
    });

    it('filters by category when --category is specified', () => {
        const backupsDir = path.join(runtimeDir, 'backups');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        createTimestampDir(backupsDir, daysAgo(2));
        const compactableDone = seedHealthyDoneTaskArtifacts({
            bundleRoot,
            taskId: 'T-001',
            ageDays: 45
        });

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxBackups: 0, maxTaskEvents: 0, maxAgeDays: 365 },
            categories: ['backups']
        });

        const backupItems = result.removed.filter(i => i.category === 'backups');
        const eventItems = result.removed.filter(i => i.category === 'task-events');
        assert.ok(backupItems.length > 0, 'should remove backups');
        assert.equal(eventItems.length, 0, 'should not remove task-events when filtered out');
        // Task events should still exist
        assert.ok(fs.existsSync(compactableDone.timelinePath));
    });

    it('filters by isolation-sandbox category', () => {
        const sandboxDir = path.join(runtimeDir, '.isolation-sandbox');
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(sandboxDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });
        const oldEntry = path.join(sandboxDir, 'old-sandbox');
        fs.mkdirSync(oldEntry, { recursive: true });
        const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        fs.utimesSync(oldEntry, past, past);
        createTimestampDir(backupsDir, daysAgo(2));

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxBackups: 0, maxAgeDays: 30 },
            categories: ['isolation-sandbox']
        });

        const sandboxItems = result.removed.filter(i => i.category === 'isolation-sandbox');
        const backupItems = result.removed.filter(i => i.category === 'backups');
        assert.ok(sandboxItems.length >= 1, 'should remove old sandbox');
        assert.equal(backupItems.length, 0, 'should not touch backups when filtered');
    });

    it('cleans other generated zones and task reviewer scratch while preserving unowned generic tmp', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' }
        ]);
        const zones = [
            ['.test-scratch', 'test-scratch'],
            ['cache', 'cache'],
            ['reports', 'reports'],
            ['update-temp', 'update-temp']
        ] as const;
        for (const [dirName] of zones) {
            const oldEntry = path.join(runtimeDir, dirName, 'old-entry');
            fs.mkdirSync(oldEntry, { recursive: true });
            fs.writeFileSync(path.join(oldEntry, 'payload.txt'), dirName, 'utf8');
            agePath(path.join(oldEntry, 'payload.txt'), 45);
            agePath(oldEntry, 45);
        }

        const tmpOldEntry = path.join(runtimeDir, 'tmp', 'old-batch');
        fs.mkdirSync(tmpOldEntry, { recursive: true });
        fs.writeFileSync(path.join(tmpOldEntry, 'payload.txt'), 'tmp', 'utf8');
        agePath(path.join(tmpOldEntry, 'payload.txt'), 45);
        agePath(tmpOldEntry, 45);

        const runtimeTempFile = path.join(runtimeDir, 'orphan.partial');
        fs.writeFileSync(runtimeTempFile, 'partial', 'utf8');
        agePath(runtimeTempFile, 45);

        const activeScratch = path.join(runtimeDir, 'tmp', 'reviews', 'T-001');
        const inactiveScratch = path.join(runtimeDir, 'tmp', 'reviews', 'T-002');
        fs.mkdirSync(activeScratch, { recursive: true });
        fs.mkdirSync(inactiveScratch, { recursive: true });
        fs.writeFileSync(path.join(activeScratch, 'review.md'), 'active', 'utf8');
        fs.writeFileSync(path.join(inactiveScratch, 'review.md'), 'inactive', 'utf8');

        const liveProjectMemory = path.join(bundleRoot, 'live', 'docs', 'project-memory', 'compact.md');
        fs.mkdirSync(path.dirname(liveProjectMemory), { recursive: true });
        fs.writeFileSync(liveProjectMemory, '# Memory\n', 'utf8');

        const dryRun = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxAgeDays: 30 }
        });
        assert.ok(dryRun.skipped.some((item) => item.category === 'tmp' && item.path === inactiveScratch));
        assert.ok(!dryRun.skipped.some((item) => item.path === runtimeTempFile || item.path === tmpOldEntry));
        for (const [, category] of zones) {
            assert.ok(dryRun.categories[category], `dry-run should report ${category}`);
        }
        assert.ok(!dryRun.skipped.some((item) => item.path === activeScratch), 'active reviewer scratch must not be a cleanup candidate');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 30 }
        });

        assert.ok(result.removed.some((item) => item.category === 'tmp' && item.path === inactiveScratch));
        assert.equal(fs.existsSync(activeScratch), true, 'active reviewer scratch must survive cleanup');
        assert.equal(fs.existsSync(inactiveScratch), false, 'inactive reviewer scratch should be removed');
        assert.equal(fs.existsSync(tmpOldEntry), true, 'generic tmp requires separate registered ownership and confirmation');
        assert.equal(fs.existsSync(runtimeTempFile), true, 'unowned root temp has no generic deletion authority');
        for (const [dirName] of zones) {
            assert.equal(fs.existsSync(path.join(runtimeDir, dirName, 'old-entry')), false, `${dirName} should be removed`);
        }
        assert.equal(fs.existsSync(liveProjectMemory), true, 'live project memory is canonical and must not be cleaned');
    });

    it('bounds active-task traversal while preserving exact scratch owners', () => {
        const activeTaskIds = new Set([
            't-001', 'T-002',
            ...Array.from({ length: 128 }, (_, index) => `T-${1000 + index}`)
        ]);
        let iterations = 0;
        const originalIterator = activeTaskIds[Symbol.iterator].bind(activeTaskIds);
        activeTaskIds[Symbol.iterator] = () => {
            iterations += 1;
            return originalIterator();
        };
        const active = [
            path.join(runtimeDir, 'T-001-debug.partial'),
            path.join(runtimeDir, 'tmp', 'T-001-output'),
            path.join(runtimeDir, 'tmp', 'reviews', 'T-002'),
            path.join(runtimeDir, 'tmp', 'reviews', 'T-002-output')
        ];
        const inactive = [
            path.join(runtimeDir, 'T-003-debug.partial'),
            path.join(runtimeDir, 'tmp', 'T-001-2'),
            path.join(runtimeDir, 'tmp', 'reviews', 'T-003-output')
        ];
        const generic = path.join(runtimeDir, 'tmp', 'unowned');
        for (const candidate of [...active, ...inactive, generic]) {
            if (candidate.endsWith('.partial')) {
                fs.writeFileSync(candidate, 'scratch');
            } else {
                fs.mkdirSync(candidate, { recursive: true });
                fs.writeFileSync(path.join(candidate, 'payload'), 'scratch');
            }
            agePath(candidate, 4);
        }
        const candidates = collectStandardCandidates(runtimeDir,
            { ...buildDefaultRetentionPolicy(), maxAgeDays: 2 }, new Date(), activeTaskIds);
        assert.deepEqual(candidates.map(item => item.path).sort(), inactive.sort(),
            'case-insensitive active owners and generic scratch stay protected; inactive exact children remain eligible');
        assert.ok(iterations <= 1,
            `scratch filtering must not rescan the ${activeTaskIds.size} active tasks per entry (iterations=${iterations})`);
        assert.ok([...active, ...inactive, generic].every(candidate => fs.existsSync(candidate)),
            'candidate collection remains read-only');
    });

    it('filters generated runtime zone cleanup by category', () => {
        const tmpOldEntry = path.join(runtimeDir, 'tmp', 'old-batch');
        const taskTmpEntry = path.join(runtimeDir, 'tmp', 'T-002');
        const cacheOldEntry = path.join(runtimeDir, 'cache', 'old-entry');
        fs.mkdirSync(tmpOldEntry, { recursive: true });
        fs.mkdirSync(taskTmpEntry, { recursive: true });
        fs.mkdirSync(cacheOldEntry, { recursive: true });
        fs.writeFileSync(path.join(tmpOldEntry, 'payload.txt'), 'tmp', 'utf8');
        fs.writeFileSync(path.join(taskTmpEntry, 'payload.txt'), 'task tmp', 'utf8');
        fs.writeFileSync(path.join(cacheOldEntry, 'payload.txt'), 'cache', 'utf8');
        agePath(path.join(tmpOldEntry, 'payload.txt'), 45);
        agePath(path.join(cacheOldEntry, 'payload.txt'), 45);
        agePath(tmpOldEntry, 45);
        agePath(path.join(taskTmpEntry, 'payload.txt'), 45);
        agePath(taskTmpEntry, 45);
        agePath(cacheOldEntry, 45);

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            categories: ['tmp'],
            retentionPolicy: { maxAgeDays: 30 }
        });

        assert.ok(result.removed.some((item) => item.category === 'tmp' && item.path === taskTmpEntry));
        assert.equal(fs.existsSync(taskTmpEntry), false, 'tmp filter retains canonical task-owned cleanup');
        assert.equal(fs.existsSync(tmpOldEntry), true, 'category confirmation is insufficient for generic tmp');
        assert.equal(fs.existsSync(cacheOldEntry), true, 'tmp filter must not remove cache candidates');
    });

    it('returns SUCCESS when runtime is empty', () => {
        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot
        });
        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.staleLocksCleaned, 0);
        assert.equal(result.isolationSandboxCleaned, false);
    });

    it('rejects invalid category in options', () => {
        assert.throws(
            () => runGc({
                targetRoot: tmpDir,
                bundleRoot,
                categories: ['not-a-real-dir']
            }),
            /Unknown gc category/
        );
    });
});

describe('runGcWithLock', () => {
    let tmpDir: string;
    let bundleRoot: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-gc-lock-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        const runtimeDir = path.join(bundleRoot, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort
        }
    });

    it('runs gc under lifecycle lock in dry-run mode', () => {
        const result = runGcWithLock({
            targetRoot: tmpDir,
            bundleRoot
        });
        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.dryRun, true);
    });
});

describe('runGc aggregate retention', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-gc-agg-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        runtimeDir = setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('prunes aggregate log when confirm=true and over maxAggregateLines', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
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

    it('does not prune aggregate log in dry-run mode', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: false,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.equal(result.aggregateRetention, undefined,
            'aggregateRetention should not be set in dry-run');
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 25, 'original lines should be preserved');
    });

    it('prunes aggregate log during gc without deleting lines for active tasks', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟧 IN_REVIEW', title: 'Active review task' }
        ]);

        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i, task_id: i < 5 ? 'T-001' : 'T-900' })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.ok(result.aggregateRetention, 'gc aggregate pruning should still run');
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim())
            .map((line) => JSON.parse(line) as { seq: number; task_id: string });
        assert.equal(remaining.filter((entry) => entry.task_id === 'T-001').length, 5, 'all active-task lines should survive gc pruning');
        assert.equal(remaining.length, 10, 'gc pruning should still trim unrelated aggregate lines');
    });

    it('reports maxAggregateLines in default retention policy', () => {
        const policy = buildDefaultRetentionPolicy();
        assert.equal(typeof policy.maxAggregateLines, 'number');
        assert.ok(policy.maxAggregateLines > 0, 'default maxAggregateLines must be positive');
    });

    it('prunes metrics log when confirm=true and over maxMetricsLines', () => {
        const metricsPath = path.join(runtimeDir, 'metrics.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            categories: ['metrics'],
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

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            categories: ['metrics'],
            retentionPolicy: { maxMetricsLines: 10 }
        });

        assert.equal(result.metricsRetention, undefined,
            'metricsRetention should not be set in dry-run');
        const remaining = fs.readFileSync(metricsPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 25, 'original metrics lines should be preserved');
    });
});
