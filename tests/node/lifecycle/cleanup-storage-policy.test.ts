import {
    describe,
    it,
    beforeEach,
    afterEach,
    assert,
    fs,
    path,
    zlib,
    runCleanup,
    runGc,
    loadStoragePolicy,
    isGateReceipt,
    compressFileGzip,
    applyStoragePolicy,
    appendTaskEvent,
    makeTmpDir,
    setupRuntimeDir,
    createDirectoryLink,
    daysAgo,
    createTaskEventFile,
    writeTimelineSummary,
    createReviewArtifacts,
    seedHealthyDoneTaskArtifacts,
    writeTaskQueue,
    writeRuntimeRetentionPolicy,
    type ReviewArtifactStoragePolicy
} from './cleanup-fixtures';

describe('loadStoragePolicy', () => {
    let tmpDir: string;
    let bundleRoot: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-storage-policy-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('returns default policy when config file is missing', () => {
        const policy = loadStoragePolicy(bundleRoot);
        assert.equal(policy.retentionMode, 'full');
        assert.equal(policy.compressAfterDays, 7);
        assert.equal(policy.compressionFormat, 'gzip');
        assert.equal(policy.preserveGateReceipts, true);
        assert.ok(policy.gateReceiptSuffixes.length > 0);
    });

    it('loads custom retention_mode from config', () => {
        const configPath = path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 1,
            retention_mode: 'summary',
            compress_after_days: 14,
            compression_format: 'gzip',
            preserve_gate_receipts: false,
            gate_receipt_suffixes: ['-task-mode.json']
        }));
        const policy = loadStoragePolicy(bundleRoot);
        assert.equal(policy.retentionMode, 'summary');
        assert.equal(policy.compressAfterDays, 14);
        assert.equal(policy.preserveGateReceipts, false);
        assert.deepEqual(policy.gateReceiptSuffixes, ['-task-mode.json']);
    });

    it('falls back to defaults on invalid JSON', () => {
        const configPath = path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
        fs.writeFileSync(configPath, 'not-json');
        const policy = loadStoragePolicy(bundleRoot);
        assert.equal(policy.retentionMode, 'full');
    });

    it('falls back to full on invalid retention_mode', () => {
        const configPath = path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 1,
            retention_mode: 'invalid',
            compress_after_days: 7,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        }));
        const policy = loadStoragePolicy(bundleRoot);
        assert.equal(policy.retentionMode, 'full');
    });
});

describe('isGateReceipt', () => {
    it('identifies gate receipt files by suffix', () => {
        const suffixes = ['-task-mode.json', '-preflight.json', '-compile-gate.json'];
        assert.equal(isGateReceipt('T-058-task-mode.json', suffixes), true);
        assert.equal(isGateReceipt('T-058-preflight.json', suffixes), true);
        assert.equal(isGateReceipt('T-058-code-review-context.json', suffixes), false);
        assert.equal(isGateReceipt('T-058-scoped.diff', suffixes), false);
    });
});

describe('compressFileGzip', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-compress-');
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('compresses a file and removes the original', () => {
        const filePath = path.join(tmpDir, 'test.json');
        fs.writeFileSync(filePath, '{"data": "test content for compression"}');
        const gzPath = compressFileGzip(filePath);
        assert.equal(gzPath, `${filePath}.gz`);
        assert.ok(fs.existsSync(gzPath), 'compressed file should exist');
        assert.ok(!fs.existsSync(filePath), 'original should be removed');
        assert.ok(fs.statSync(gzPath).size > 0, 'compressed file should have content');
    });
});

describe('applyStoragePolicy', () => {
    let tmpDir: string;
    let reviewsDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-storage-apply-');
        reviewsDir = path.join(tmpDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function createArtifact(name: string, ageDays?: number): string {
        const filePath = path.join(reviewsDir, name);
        fs.writeFileSync(filePath, JSON.stringify({ artifact: name }));
        if (ageDays !== undefined && ageDays > 0) {
            const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
            fs.utimesSync(filePath, past, past);
        }
        return filePath;
    }

    it('mode none removes non-receipt artifacts but preserves gate receipts', () => {
        createArtifact('T-001-task-mode.json');
        createArtifact('T-001-preflight.json');
        createArtifact('T-001-code-review-context.json');
        createArtifact('T-001-scoped.diff');

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'none',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json', '-preflight.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.ok(result.preserved.includes('T-001-task-mode.json'));
        assert.ok(result.preserved.includes('T-001-preflight.json'));
        assert.ok(result.removed.includes('T-001-code-review-context.json'));
        assert.ok(result.removed.includes('T-001-scoped.diff'), '.diff artifacts should be removed in none mode');
    });

    it('mode none with preserve_gate_receipts=false removes everything', () => {
        createArtifact('T-002-task-mode.json');
        createArtifact('T-002-code-review-context.json');

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'none',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: false,
            gateReceiptSuffixes: ['-task-mode.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.ok(result.removed.includes('T-002-task-mode.json'));
        assert.ok(result.removed.includes('T-002-code-review-context.json'));
        assert.equal(result.preserved.length, 0);
    });

    it('mode summary keeps only gate receipts', () => {
        createArtifact('T-003-task-mode.json');
        createArtifact('T-003-compile-gate.json');
        createArtifact('T-003-code-review-context.json');
        createArtifact('T-003-code-review.md');
        createArtifact('T-003-code-scoped.diff');

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'summary',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json', '-compile-gate.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.ok(result.preserved.includes('T-003-task-mode.json'));
        assert.ok(result.preserved.includes('T-003-compile-gate.json'));
        assert.ok(result.removed.includes('T-003-code-review-context.json'));
        assert.ok(result.removed.includes('T-003-code-review.md'));
        assert.ok(result.removed.includes('T-003-code-scoped.diff'), '.diff artifacts should be removed in summary mode');
    });

    it('mode full compresses old artifacts', () => {
        createArtifact('T-004-task-mode.json', 10);
        createArtifact('T-004-code-review-context.json', 10);
        createArtifact('T-004-recent.json', 0);

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'full',
            compressAfterDays: 7,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.ok(result.compressed.includes('T-004-task-mode.json'));
        assert.ok(result.compressed.includes('T-004-code-review-context.json'));
        assert.ok(result.preserved.includes('T-004-recent.json'));
        assert.ok(fs.existsSync(path.join(reviewsDir, 'T-004-task-mode.json.gz')));
    });

    it('does not apply destructive storage policy through a linked reviews directory outside runtime root', () => {
        const runtimeRoot = path.join(tmpDir, 'runtime-root');
        const linkedReviewsDir = path.join(runtimeRoot, 'reviews');
        const outsideReviewsDir = path.join(tmpDir, 'outside-reviews');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        fs.mkdirSync(outsideReviewsDir, { recursive: true });
        const outsideArtifact = path.join(outsideReviewsDir, 'T-004-code-review-context.json');
        fs.writeFileSync(outsideArtifact, JSON.stringify({ task_id: 'T-004' }), 'utf8');
        createDirectoryLink(outsideReviewsDir, linkedReviewsDir);

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'none',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: false,
            gateReceiptSuffixes: []
        };

        const result = applyStoragePolicy(linkedReviewsDir, policy, new Set(), runtimeRoot);
        assert.equal(result.removed.length, 0);
        assert.equal(result.compressed.length, 0);
        assert.equal(fs.existsSync(outsideArtifact), true, 'outside review artifact should remain untouched');
    });

    it('mode full with compression disabled preserves all', () => {
        createArtifact('T-005-task-mode.json', 10);

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'full',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.equal(result.compressed.length, 0);
        assert.ok(result.preserved.includes('T-005-task-mode.json'));
    });

    it('never touches artifacts for active tasks', () => {
        createArtifact('T-006-task-mode.json');
        createArtifact('T-006-code-review-context.json');
        createArtifact('t-006-preflight.json');

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'none',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: false,
            gateReceiptSuffixes: []
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set(['T-006']));
        assert.equal(result.removed.length, 0);
        assert.ok(result.preserved.includes('T-006-task-mode.json'));
        assert.ok(result.preserved.includes('T-006-code-review-context.json'));
        assert.ok(result.preserved.includes('t-006-preflight.json'));
    });

    it('returns empty result for non-existent directory', () => {
        const result = applyStoragePolicy(
            path.join(tmpDir, 'nonexistent'),
            { retentionMode: 'none', compressAfterDays: 0, compressionFormat: 'gzip', preserveGateReceipts: true, gateReceiptSuffixes: ['-task-mode.json'] },
            new Set()
        );
        assert.equal(result.compressed.length, 0);
        assert.equal(result.removed.length, 0);
        assert.equal(result.preserved.length, 0);
    });

    it('records retentionMode in result', () => {
        const result = applyStoragePolicy(reviewsDir, {
            retentionMode: 'summary',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        }, new Set());
        assert.equal(result.retentionMode, 'summary');
    });
});

describe('runGc with storage policy', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-gc-storage-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        runtimeDir = path.join(bundleRoot, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('applies storage policy when confirm=true', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'T-099-task-mode.json'), '{}');
        fs.writeFileSync(path.join(reviewsDir, 'T-099-code-review-context.json'), '{}');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            storagePolicy: {
                retentionMode: 'summary',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: true,
                gateReceiptSuffixes: ['-task-mode.json']
            },
            retentionPolicy: { maxReviews: 1000, maxAgeDays: 365 }
        });

        assert.ok(result.storagePolicyResult);
        assert.equal(result.storagePolicyResult.retentionMode, 'summary');
        assert.equal(Array.isArray(result.storagePolicyResult.removed), true);
        assert.equal(Array.isArray(result.storagePolicyResult.preserved), true);
    });

    it('does not apply storage policy in dry-run mode', () => {
        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: false
        });

        assert.equal(result.storagePolicyResult, undefined);
    });

    it('preserves active task artifacts resolved from TASK.md during gc candidate collection and storage policy', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟧 IN_REVIEW', title: 'Active review task' },
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
        const activeEventPath = createTaskEventFile(eventsDir, 'T-001');

        const past = daysAgo(45);
        for (const entryPath of [
            ...activeReviewPaths,
            activeEventPath
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 0, maxTaskEvents: 0 },
            storagePolicy: {
                retentionMode: 'none',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: false,
                gateReceiptSuffixes: []
            }
        });

        assert.ok(result.storagePolicyResult, 'storage policy should run in confirm mode');
        assert.ok(result.storagePolicyResult!.preserved.includes('T-001-task-mode.json'));
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'active review artifact should survive gc');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-002-task-mode.json')), false, 'inactive review artifact should be removed');
        assert.equal(fs.existsSync(activeEventPath), true, 'active task timeline should survive gc');
        assert.equal(fs.existsSync(compactableDone.timelinePath), false, 'inactive task timeline should be removed by gc');
    });

    it('compresses heavy forensic artifacts for eligible problem tasks without deleting recovery evidence', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-700', status: '🟥 BLOCKED', title: 'Blocked task' }
        ]);
        writeRuntimeRetentionPolicy(bundleRoot, { preserveDetailedEvidence: false });

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const taskModePath = path.join(reviewsDir, 'T-700-task-mode.json');
        const preflightPath = path.join(reviewsDir, 'T-700-preflight.json');
        const compileLogPath = path.join(reviewsDir, 'T-700-compile-output.log');
        const reviewContextPath = path.join(reviewsDir, 'T-700-code-review-context.json');
        const scopedDiffPath = path.join(reviewsDir, 'T-700-code-scoped.diff');
        const verdictPath = path.join(reviewsDir, 'T-700-code.md');
        fs.writeFileSync(taskModePath, JSON.stringify({ task_id: 'T-700' }), 'utf8');
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: 'T-700' }), 'utf8');
        fs.writeFileSync(compileLogPath, 'large compile failure output\n', 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({ task_id: 'T-700', context: 'large' }), 'utf8');
        fs.writeFileSync(scopedDiffPath, 'diff --git a/file b/file\n', 'utf8');
        fs.writeFileSync(verdictPath, '# Review verdict\n', 'utf8');
        appendTaskEvent(bundleRoot, 'T-700', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-700', 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
            previous_status: 'IN_PROGRESS',
            new_status: 'BLOCKED'
        }, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-700', 'TASK_BLOCKED', 'FAIL', 'Task blocked.', {}, { passThru: true });
        writeTimelineSummary(eventsDir, 'T-700', {
            completenessStatus: 'INCOMPLETE',
            eventsFound: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'TASK_BLOCKED']
        });

        const timelinePath = path.join(eventsDir, 'T-700.jsonl');
        const past = daysAgo(45);
        for (const artifactPath of [
            taskModePath,
            preflightPath,
            compileLogPath,
            reviewContextPath,
            scopedDiffPath,
            verdictPath,
            timelinePath
        ]) {
            fs.utimesSync(artifactPath, past, past);
        }

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 365, maxReviews: 1000, maxTaskEvents: 1000 },
            storagePolicy: {
                retentionMode: 'none',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: false,
                gateReceiptSuffixes: []
            }
        });

        assert.equal(result.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-700')?.retention_tier, 'compressed_forensic_candidate');
        assert.equal(result.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-700')?.eligible_now, true);
        assert.ok(result.storagePolicyResult?.compressed.includes('T-700-compile-output.log'));
        assert.ok(result.storagePolicyResult?.compressed.includes('T-700-code-review-context.json'));
        assert.ok(result.storagePolicyResult?.compressed.includes('T-700-code-scoped.diff'));
        assert.equal(fs.existsSync(compileLogPath), false);
        assert.equal(fs.existsSync(`${compileLogPath}.gz`), true);
        assert.equal(zlib.gunzipSync(fs.readFileSync(`${compileLogPath}.gz`)).toString('utf8'), 'large compile failure output\n');
        assert.equal(fs.existsSync(taskModePath), true, 'gate evidence remains readable');
        assert.equal(fs.existsSync(preflightPath), true, 'preflight remains readable');
        assert.equal(fs.existsSync(verdictPath), true, 'review verdict remains readable');
        assert.equal(fs.existsSync(timelinePath), true, 'timeline remains authoritative for diagnostics');
        assert.equal(result.storagePolicyResult?.removed.some((entry) => entry.startsWith('T-700-')), false);
    });

    it('bounds forensic compression to selected problem tasks', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-710', status: '🟥 BLOCKED', title: 'Blocked task' },
            { id: 'T-711', status: '🟥 BLOCKED', title: 'Blocked task' }
        ]);
        writeRuntimeRetentionPolicy(bundleRoot, { preserveDetailedEvidence: false });

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const seedBlockedProblemTask = (taskId: string): string => {
            const compileLogPath = path.join(reviewsDir, `${taskId}-compile-output.log`);
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-task-mode.json`), JSON.stringify({ task_id: taskId }), 'utf8');
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-preflight.json`), JSON.stringify({ task_id: taskId }), 'utf8');
            fs.writeFileSync(compileLogPath, `${taskId} failure output\n`, 'utf8');
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-code-review-context.json`), JSON.stringify({ task_id: taskId }), 'utf8');
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-code-scoped.diff`), 'diff --git a/file b/file\n', 'utf8');
            appendTaskEvent(bundleRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
            appendTaskEvent(bundleRoot, taskId, 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
                previous_status: 'IN_PROGRESS',
                new_status: 'BLOCKED'
            }, { passThru: true });
            appendTaskEvent(bundleRoot, taskId, 'TASK_BLOCKED', 'FAIL', 'Task blocked.', {}, { passThru: true });
            writeTimelineSummary(eventsDir, taskId, {
                completenessStatus: 'INCOMPLETE',
                eventsFound: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'TASK_BLOCKED']
            });
            return compileLogPath;
        };

        const selectedCompileLogPath = seedBlockedProblemTask('T-710');
        const unselectedCompileLogPath = seedBlockedProblemTask('T-711');
        const past = daysAgo(45);
        for (const artifactPath of [
            ...fs.readdirSync(reviewsDir).map((entry) => path.join(reviewsDir, entry)),
            path.join(eventsDir, 'T-710.jsonl'),
            path.join(eventsDir, 'T-711.jsonl')
        ]) {
            fs.utimesSync(artifactPath, past, past);
        }

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            runtimeRetentionTaskLimit: 1,
            retentionPolicy: { maxAgeDays: 365, maxReviews: 1000, maxTaskEvents: 1000 },
            storagePolicy: {
                retentionMode: 'none',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: false,
                gateReceiptSuffixes: []
            }
        });

        assert.equal(result.runtimeRetentionPreview?.task_count, 2);
        assert.deepEqual(
            result.runtimeRetentionPreview?.tasks.map((task) => `${task.task_id}:${task.eligible_now}`),
            ['T-710:true', 'T-711:true']
        );
        assert.ok(result.storagePolicyResult?.compressed.includes('T-710-compile-output.log'));
        assert.equal(fs.existsSync(selectedCompileLogPath), false);
        assert.equal(fs.existsSync(`${selectedCompileLogPath}.gz`), true);
        assert.equal(
            result.storagePolicyResult?.compressed.some((entry) => entry.startsWith('T-711-')),
            false,
            'forensic compression must not mutate problem tasks outside runtimeRetentionTaskLimit'
        );
        assert.equal(fs.existsSync(unselectedCompileLogPath), true);
        assert.equal(fs.existsSync(`${unselectedCompileLogPath}.gz`), false);
    });

    it('preserves heavy forensic artifacts for problem tasks when detailed evidence is protected', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-701', status: '🟥 BLOCKED', title: 'Blocked task' }
        ]);
        writeRuntimeRetentionPolicy(bundleRoot, { preserveDetailedEvidence: true });

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const taskModePath = path.join(reviewsDir, 'T-701-task-mode.json');
        const preflightPath = path.join(reviewsDir, 'T-701-preflight.json');
        const compileLogPath = path.join(reviewsDir, 'T-701-compile-output.log');
        const reviewContextPath = path.join(reviewsDir, 'T-701-code-review-context.json');
        const scopedDiffPath = path.join(reviewsDir, 'T-701-code-scoped.diff');
        const verdictPath = path.join(reviewsDir, 'T-701-code.md');
        fs.writeFileSync(taskModePath, JSON.stringify({ task_id: 'T-701' }), 'utf8');
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: 'T-701' }), 'utf8');
        fs.writeFileSync(compileLogPath, 'large compile failure output\n', 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({ task_id: 'T-701', context: 'large' }), 'utf8');
        fs.writeFileSync(scopedDiffPath, 'diff --git a/file b/file\n', 'utf8');
        fs.writeFileSync(verdictPath, '# Review verdict\n', 'utf8');
        appendTaskEvent(bundleRoot, 'T-701', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-701', 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
            previous_status: 'IN_PROGRESS',
            new_status: 'BLOCKED'
        }, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-701', 'TASK_BLOCKED', 'FAIL', 'Task blocked.', {}, { passThru: true });
        writeTimelineSummary(eventsDir, 'T-701', {
            completenessStatus: 'INCOMPLETE',
            eventsFound: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'TASK_BLOCKED']
        });

        const timelinePath = path.join(eventsDir, 'T-701.jsonl');
        const past = daysAgo(45);
        for (const artifactPath of [taskModePath, preflightPath, compileLogPath, reviewContextPath, scopedDiffPath, verdictPath, timelinePath]) {
            fs.utimesSync(artifactPath, past, past);
        }

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 365, maxReviews: 1000, maxTaskEvents: 1000 },
            storagePolicy: {
                retentionMode: 'none',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: false,
                gateReceiptSuffixes: []
            }
        });

        const preview = result.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-701');
        assert.equal(preview?.retention_tier, 'compressed_forensic_candidate');
        assert.equal(preview?.eligible_now, false);
        assert.equal(result.storagePolicyResult?.compressed.some((entry) => entry.startsWith('T-701-')), false);
        assert.equal(fs.existsSync(compileLogPath), true);
        assert.equal(fs.existsSync(`${compileLogPath}.gz`), false);
        assert.equal(fs.existsSync(reviewContextPath), true);
        assert.equal(fs.existsSync(scopedDiffPath), true);
    });

    it('preserves heavy forensic artifacts for problem tasks by default when detailed evidence policy is omitted', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-702', status: '🟥 BLOCKED', title: 'Blocked task' }
        ]);
        writeRuntimeRetentionPolicy(bundleRoot, { omitPreserveDetailedEvidence: true });

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const compileLogPath = path.join(reviewsDir, 'T-702-compile-output.log');
        const reviewContextPath = path.join(reviewsDir, 'T-702-code-review-context.json');
        const scopedDiffPath = path.join(reviewsDir, 'T-702-code-scoped.diff');
        fs.writeFileSync(path.join(reviewsDir, 'T-702-task-mode.json'), JSON.stringify({ task_id: 'T-702' }), 'utf8');
        fs.writeFileSync(path.join(reviewsDir, 'T-702-preflight.json'), JSON.stringify({ task_id: 'T-702' }), 'utf8');
        fs.writeFileSync(compileLogPath, 'large compile failure output\n', 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({ task_id: 'T-702', context: 'large' }), 'utf8');
        fs.writeFileSync(scopedDiffPath, 'diff --git a/file b/file\n', 'utf8');
        appendTaskEvent(bundleRoot, 'T-702', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-702', 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
            previous_status: 'IN_PROGRESS',
            new_status: 'BLOCKED'
        }, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-702', 'TASK_BLOCKED', 'FAIL', 'Task blocked.', {}, { passThru: true });
        writeTimelineSummary(eventsDir, 'T-702', {
            completenessStatus: 'INCOMPLETE',
            eventsFound: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'TASK_BLOCKED']
        });

        const timelinePath = path.join(eventsDir, 'T-702.jsonl');
        const past = daysAgo(45);
        for (const artifactPath of [
            path.join(reviewsDir, 'T-702-task-mode.json'),
            path.join(reviewsDir, 'T-702-preflight.json'),
            compileLogPath,
            reviewContextPath,
            scopedDiffPath,
            timelinePath
        ]) {
            fs.utimesSync(artifactPath, past, past);
        }

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 365, maxReviews: 1000, maxTaskEvents: 1000 },
            storagePolicy: {
                retentionMode: 'none',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: false,
                gateReceiptSuffixes: []
            }
        });

        const preview = result.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-702');
        assert.equal(preview?.retention_tier, 'compressed_forensic_candidate');
        assert.equal(preview?.eligible_now, false);
        assert.equal(result.storagePolicyResult?.compressed.some((entry) => entry.startsWith('T-702-')), false);
        assert.equal(fs.existsSync(compileLogPath), true);
        assert.equal(fs.existsSync(`${compileLogPath}.gz`), false);
        assert.equal(fs.existsSync(reviewContextPath), true);
        assert.equal(fs.existsSync(scopedDiffPath), true);
    });

    it('bounds review artifact storage policy mutations to selected healthy DONE tasks', () => {
        seedHealthyDoneTaskArtifacts({ bundleRoot, taskId: 'T-800', ageDays: 45 });
        seedHealthyDoneTaskArtifacts({ bundleRoot, taskId: 'T-801', ageDays: 45 });

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            runtimeRetentionTaskLimit: 1,
            retentionPolicy: { maxAgeDays: 365, maxReviews: 1000, maxTaskEvents: 1000 },
            storagePolicy: {
                retentionMode: 'none',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: false,
                gateReceiptSuffixes: []
            }
        });

        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.runtimeRetentionPreview?.task_count, 2);
        assert.deepEqual(
            result.runtimeRetentionPreview?.tasks.map((task) => `${task.task_id}:${task.eligible_now}`),
            ['T-800:true', 'T-801:true']
        );
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-800-task-mode.json')), false);
        assert.equal(
            fs.existsSync(path.join(reviewsDir, 'T-801-task-mode.json')),
            true,
            'bounded maintenance must protect eligible healthy DONE tasks outside the selected limit'
        );
        assert.equal(
            result.storagePolicyResult?.removed.some((entry) => entry.startsWith('T-801-')),
            false,
            'storage policy must not mutate review artifacts outside runtimeRetentionTaskLimit'
        );
    });

    it('does not recompress already compressed forensic artifacts', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-701', status: '🟥 BLOCKED', title: 'Blocked task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const compressedLogPath = path.join(reviewsDir, 'T-701-full-suite-output.log.gz');
        fs.writeFileSync(compressedLogPath, zlib.gzipSync('prior failure output\n'));
        appendTaskEvent(bundleRoot, 'T-701', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-701', 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
            previous_status: 'IN_PROGRESS',
            new_status: 'BLOCKED'
        }, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-701', 'TASK_BLOCKED', 'FAIL', 'Task blocked.', {}, { passThru: true });
        writeTimelineSummary(eventsDir, 'T-701', {
            completenessStatus: 'INCOMPLETE',
            eventsFound: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'TASK_BLOCKED']
        });

        const past = daysAgo(45);
        fs.utimesSync(compressedLogPath, past, past);
        fs.utimesSync(path.join(eventsDir, 'T-701.jsonl'), past, past);

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 365, maxReviews: 1000, maxTaskEvents: 1000 },
            storagePolicy: {
                retentionMode: 'none',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: false,
                gateReceiptSuffixes: []
            }
        });

        assert.equal(fs.existsSync(compressedLogPath), true);
        assert.equal(fs.existsSync(`${compressedLogPath}.gz`), false);
        assert.equal(result.storagePolicyResult?.compressed.includes('T-701-full-suite-output.log'), false);
    });
});

describe('cleanup invalidates reviews index', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-cleanup-index-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        runtimeDir = setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('applyStoragePolicy invalidates reviews index when artifacts are removed', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'T-001-task-mode.json'), '{}');
        fs.writeFileSync(path.join(reviewsDir, 'T-001-code-review-context.json'), '{}');

        // Create an index file to verify it gets invalidated
        const indexPath = path.join(reviewsDir, 'reviews-index.json');
        fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: [] }));

        const result = applyStoragePolicy(reviewsDir, {
            retentionMode: 'summary',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        }, new Set());

        assert.ok(result.removed.includes('T-001-code-review-context.json'));
        assert.equal(fs.existsSync(indexPath), false, 'Reviews index should be invalidated after removal');
    });

    it('applyStoragePolicy does not invalidate index when no changes made', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'T-001-task-mode.json'), '{}');

        const indexPath = path.join(reviewsDir, 'reviews-index.json');
        fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: [] }));

        applyStoragePolicy(reviewsDir, {
            retentionMode: 'full',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        }, new Set());

        assert.ok(fs.existsSync(indexPath), 'Reviews index should not be touched when no changes');
    });

    it('runCleanup invalidates reviews index when review artifacts are removed', () => {
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.4.4\n');
        const reviewsDir = path.join(runtimeDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        for (let i = 1; i <= 5; i++) {
            seedHealthyDoneTaskArtifacts({
                bundleRoot,
                taskId: `T-${String(i).padStart(3, '0')}`,
                ageDays: 45
            });
        }

        // Create index file
        const indexPath = path.join(reviewsDir, 'reviews-index.json');
        fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: [] }));

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxReviews: 2 }
        });

        assert.ok(result.removed.some(item => item.category === 'reviews'));
        assert.equal(fs.existsSync(indexPath), false, 'Reviews index should be invalidated after cleanup');
    });
});
