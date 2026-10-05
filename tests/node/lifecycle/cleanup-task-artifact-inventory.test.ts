import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { runGc, runTaskRuntimePurge } from '../../../src/lifecycle/cleanup';
import { processCleanupCandidates } from '../../../src/lifecycle/cleanup/cleanup-removal';
import { applyStoragePolicy } from '../../../src/lifecycle/cleanup/cleanup-storage-policy';
import {
    collectRuntimeRetentionCandidates,
    collectTaskRuntimePurgeCandidates,
    collectTaskRuntimePurgeInventory
} from '../../../src/lifecycle/cleanup/cleanup-runtime-retention';
import { entriesForTask, rebuildIndex } from '../../../src/gate-runtime/reviews-index';
import { acquireFilesystemLock, appendTaskEvent, releaseFilesystemLock } from '../../../src/gate-runtime/task-events';
import { buildRuntimeRetentionPreview } from '../../../src/lifecycle/runtime-policy/runtime-retention-policy';
import { daysAgo, seedHealthyDoneTaskArtifacts, writeRuntimeRetentionPolicy, writeTaskQueue, writeTimelineSummary } from './cleanup-fixtures';

const SELECTED_TASK = 'T-991-1-F1';
const CHILD_TASK = 'T-991-1-F1-I1';
const HISTORICAL_ARTIFACTS = [
    'final-user-report.md',
    'coherent-cycle-restart.json',
    'review-cycle-restart.json',
    'quality-checklist.json',
    'quality-checklist-answers.json',
    'scoped-summary.json',
    'scoped-summary.md',
    'task-plan.json'
];

function writeFile(root: string, relativePath: string, content: string | Buffer): string {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function snapshotFiles(root: string): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile()) result[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            else throw new Error('Unexpected linked fixture path.');
        }
    };
    visit(root);
    return result;
}

describe('task-owned artifact inventory and purge', () => {
    let root: string;
    let bundle: string;
    let runtime: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-artifact-inventory-'));
        bundle = path.join(root, 'garda-agent-orchestrator');
        runtime = path.join(bundle, 'runtime');
        fs.mkdirSync(runtime, { recursive: true });
        fs.writeFileSync(path.join(bundle, 'VERSION'), '1.0.0\n');
    });

    afterEach(() => {
        const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(root));
        assert.ok(relative.startsWith('garda-task-artifact-inventory-') && !relative.includes(path.sep));
        fs.rmSync(root, { recursive: true, force: true });
    });

    function writeQueue(selectedStatus = 'DONE', parentStatus = 'DONE'): void {
        writeFile(root, 'TASK.md', [
            '# Tasks',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| T-991-1 | ${parentStatus} | P1 | test | Parent | test | 2026-10-02 | strict | |`,
            `| ${SELECTED_TASK} | ${selectedStatus} | P1 | test | Selected | test | 2026-10-02 | strict | |`,
            `| ${CHILD_TASK} | DONE | P1 | test | Child | test | 2026-10-02 | strict | |`,
            '| T-OTHER | DONE | P1 | test | Survivor | test | 2026-10-02 | strict | |',
            ''
        ].join('\n'));
    }

    function seedReviewArtifacts(taskId: string): string[] {
        return HISTORICAL_ARTIFACTS.map((suffix) => writeFile(runtime, `reviews/${taskId}-${suffix}`,
            suffix.endsWith('.json') ? JSON.stringify({ task_id: taskId }) : `# ${taskId} ${suffix}\n`));
    }

    it('indexes historical artifacts under the exact nested task rather than its parent', () => {
        seedReviewArtifacts(SELECTED_TASK);
        seedReviewArtifacts(CHILD_TASK);
        const index = rebuildIndex(path.join(runtime, 'reviews'));
        assert.deepEqual(entriesForTask(index, SELECTED_TASK).map((entry) => entry.artifactType).sort(), [...HISTORICAL_ARTIFACTS].sort());
        assert.equal(entriesForTask(index, CHILD_TASK).length, HISTORICAL_ARTIFACTS.length);
        assert.equal(entriesForTask(index, 'T-991').length, 0);
        assert.equal(entriesForTask(index, 'T-991-1').length, 0);
    });

    for (const retentionMode of ['none', 'summary', 'full'] as const) {
        it(`preserves ambiguous JSON ownership in confirmed GC ${retentionMode} mode`, () => {
            writeFile(root, 'TASK.md', [
                '# Tasks',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-OTHER | IN_PROGRESS | P1 | test | Active owner | test | 2026-10-02 | strict | |',
                '| T-GC-ART | DONE | P1 | test | Healthy filename owner | test | 2026-10-02 | strict | |',
                ''
            ].join('\n'));
            seedHealthyDoneTaskArtifacts({ bundleRoot: bundle, taskId: 'T-GC-ART', ageDays: 45 });
            const ambiguous = [
                writeFile(runtime, 'reviews/T-GC-ART-task-plan.json', JSON.stringify({ task_id: 'T-OTHER' })),
                writeFile(runtime, 'reviews/T-GC-ART-quality-checklist.json', '{invalid-json'),
                writeFile(runtime, 'reviews/T-GC-ART-quality-checklist-answers.json', JSON.stringify({ task_id: ['T-GC-ART'] })),
                writeFile(runtime, 'reviews/T-GC-ART-review-cycle-restart.json', JSON.stringify({ task_id: 'bad/id' })),
                writeFile(runtime, 'reviews/T-GC-ART-code-review-output.md', JSON.stringify({ task_id: 'T-OTHER' })),
                writeFile(runtime, 'reviews/T-GC-ART-security-review-output.md', '{invalid-json'),
                writeFile(runtime, 'reviews/T-GC-ART-test-review-output.md', JSON.stringify({ task_id: ['T-GC-ART'] }))
            ];
            const shared = writeFile(runtime, 'notes/shared.json', JSON.stringify({ task_id: 'T-GC-ART' }));
            const sharedArtifact = path.join(runtime, 'reviews/T-GC-ART-coherent-cycle-restart.json');
            fs.linkSync(shared, sharedArtifact);
            ambiguous.push(sharedArtifact);
            const sharedMarkdown = path.join(runtime, 'reviews/T-GC-ART-refactor-review-output.md');
            fs.linkSync(shared, sharedMarkdown);
            ambiguous.push(sharedMarkdown);
            const aged = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
            for (const file of ambiguous) fs.utimesSync(file, aged, aged);
            const before = ambiguous.map((file) => fs.readFileSync(file));
            const sharedBefore = fs.readFileSync(shared);
            const policy = { retentionMode, compressAfterDays: 1, compressionFormat: 'gzip' as const,
                preserveGateReceipts: false, gateReceiptSuffixes: [] };

            const gc = runGc({ targetRoot: root, bundleRoot: bundle, confirm: true,
                categories: ['reviews'], storagePolicy: policy,
                retentionPolicy: { maxAgeDays: 365, maxReviews: 1000 } });
            assert.equal(gc.result, 'SUCCESS');
            assert.equal(gc.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-GC-ART')?.eligible_now, true);
            assert.deepEqual(ambiguous.map((file) => fs.existsSync(file)), Array(9).fill(true));
            assert.deepEqual(ambiguous.map((file) => fs.readFileSync(file)), before);
            assert.deepEqual(ambiguous.map((file) => fs.existsSync(`${file}.gz`)), Array(9).fill(false));
            assert.deepEqual(fs.readFileSync(shared), sharedBefore);
            assert.equal(fs.statSync(shared).nlink, 3);
            assert.deepEqual(gc.storagePolicyResult?.removed, []);
            assert.deepEqual(gc.storagePolicyResult?.compressed, []);
            assert.deepEqual(gc.storagePolicyResult?.preserved.sort(), ambiguous.map((file) => path.basename(file)).sort());

            const matching = writeFile(runtime, 'reviews/T-GC-VALID-task-plan.json', JSON.stringify({ task_id: 'T-GC-VALID' }));
            const legacy = writeFile(runtime, 'reviews/T-GC-VALID-quality-checklist.json', '{}');
            const matchingMarkdown = writeFile(runtime, 'reviews/T-GC-VALID-code-review-output.md', JSON.stringify({ task_id: 'T-GC-VALID' }));
            const legacyMarkdown = writeFile(runtime, 'reviews/T-GC-VALID-security-review-output.md', '# Legacy review\n');
            const valid = [matching, legacy, matchingMarkdown, legacyMarkdown];
            for (const file of valid) fs.utimesSync(file, aged, aged);
            const stored = applyStoragePolicy(path.join(runtime, 'reviews'), policy, new Set(), runtime);
            assert.deepEqual(stored.preserved.sort(), ambiguous.map((file) => path.basename(file)).sort());
            assert.deepEqual([...stored.removed, ...stored.compressed].sort(), valid.map((file) => path.basename(file)).sort());
            assert.deepEqual(valid.map((file) => fs.existsSync(file)), Array(4).fill(false));
            assert.deepEqual(valid.map((file) => fs.existsSync(`${file}.gz`)), Array(4).fill(retentionMode === 'full'));
            assert.deepEqual(ambiguous.map((file) => fs.readFileSync(file)), before);
        });
    }

    it('preserves malformed, conflicting and shared JSON during forensic GC compression of problem tasks', () => {
        const taskId = 'T-GC-FORENSIC';
        writeTaskQueue(root, [
            { id: taskId, status: 'BLOCKED' },
            { id: 'T-OTHER', status: 'IN_PROGRESS' }
        ]);
        writeRuntimeRetentionPolicy(bundle, { preserveDetailedEvidence: false });
        const receipts = [
            writeFile(runtime, `reviews/${taskId}-task-mode.json`, JSON.stringify({ task_id: taskId })),
            writeFile(runtime, `reviews/${taskId}-preflight.json`, JSON.stringify({ task_id: taskId }))
        ];
        const ambiguous = [
            writeFile(runtime, `reviews/${taskId}-code-review-context.json`, JSON.stringify({ task_id: 'T-OTHER' })),
            writeFile(runtime, `reviews/${taskId}-security-review-context.json`, '{invalid-json'),
            writeFile(runtime, `reviews/${taskId}-test-review-context.json`, JSON.stringify({ task_id: [taskId] })),
            writeFile(runtime, `reviews/${taskId}-refactor-review-context.json`, JSON.stringify({ task_id: 'bad/id' })),
            writeFile(runtime, `reviews/${taskId}-code-review-output.md`, JSON.stringify({ task_id: 'T-OTHER' })),
            writeFile(runtime, `reviews/${taskId}-security-review-output.md`, '{invalid-json'),
            writeFile(runtime, `reviews/${taskId}-test-review-output.md`, JSON.stringify({ task_id: [taskId] }))
        ];
        const shared = writeFile(runtime, 'notes/shared-forensic.json', JSON.stringify({ task_id: taskId }));
        const sharedArtifact = path.join(runtime, `reviews/${taskId}-performance-review-context.json`);
        fs.linkSync(shared, sharedArtifact);
        ambiguous.push(sharedArtifact);
        const sharedMarkdown = path.join(runtime, `reviews/${taskId}-refactor-review-output.md`);
        fs.linkSync(shared, sharedMarkdown);
        ambiguous.push(sharedMarkdown);
        const valid = [
            writeFile(runtime, `reviews/${taskId}-api-review-context.json`, JSON.stringify({ task_id: taskId, context: 'owned' })),
            writeFile(runtime, `reviews/${taskId}-infra-review-context.json`, '{}'),
            writeFile(runtime, `reviews/${taskId}-api-review-output.md`, JSON.stringify({ task_id: taskId })),
            writeFile(runtime, `reviews/${taskId}-infra-review-output.md`, '# Legacy review\n')
        ];
        appendTaskEvent(bundle, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
        appendTaskEvent(bundle, taskId, 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
            previous_status: 'IN_PROGRESS', new_status: 'BLOCKED'
        }, { passThru: true });
        appendTaskEvent(bundle, taskId, 'TASK_BLOCKED', 'FAIL', 'Task blocked.', {}, { passThru: true });
        writeTimelineSummary(path.join(runtime, 'task-events'), taskId, {
            completenessStatus: 'INCOMPLETE', eventsFound: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'TASK_BLOCKED']
        });
        const past = daysAgo(45);
        for (const file of [...receipts, ...ambiguous, ...valid, path.join(runtime, 'task-events', `${taskId}.jsonl`)]) {
            fs.utimesSync(file, past, past);
        }
        const before = ambiguous.map((file) => fs.readFileSync(file));
        const validBefore = valid.map((file) => fs.readFileSync(file));
        const sharedBefore = fs.readFileSync(shared);

        const gc = runGc({ targetRoot: root, bundleRoot: bundle, confirm: true, categories: ['reviews'],
            retentionPolicy: { maxAgeDays: 365, maxReviews: 1000, maxTaskEvents: 1000 },
            storagePolicy: { retentionMode: 'none', compressAfterDays: 0, compressionFormat: 'gzip',
                preserveGateReceipts: false, gateReceiptSuffixes: [] } });
        assert.equal(gc.result, 'SUCCESS');
        assert.equal(gc.runtimeRetentionPreview?.tasks.find((task) => task.task_id === taskId)?.retention_tier, 'compressed_forensic_candidate');
        assert.equal(gc.runtimeRetentionPreview?.tasks.find((task) => task.task_id === taskId)?.eligible_now, true);
        assert.deepEqual(ambiguous.map((file) => fs.existsSync(file)), Array(9).fill(true));
        assert.deepEqual(ambiguous.map((file) => fs.readFileSync(file)), before);
        assert.deepEqual(ambiguous.map((file) => fs.existsSync(`${file}.gz`)), Array(9).fill(false));
        assert.deepEqual(ambiguous.map((file) => gc.storagePolicyResult?.preserved.includes(path.basename(file))), Array(9).fill(true));
        assert.deepEqual(fs.readFileSync(shared), sharedBefore);
        assert.equal(fs.statSync(shared).nlink, 3);
        assert.deepEqual(gc.storagePolicyResult?.removed, []);
        assert.deepEqual(gc.storagePolicyResult?.compressed.sort(), valid.map((file) => path.basename(file)).sort());
        assert.deepEqual(valid.map((file) => fs.existsSync(file)), Array(4).fill(false));
        assert.deepEqual(valid.map((file) => zlib.gunzipSync(fs.readFileSync(`${file}.gz`))), validBefore);
        assert.deepEqual(receipts.map((file) => fs.existsSync(file)), [true, true]);
    });

    it('preserves foreign and malformed JSON Markdown reports and immutable copies during purge', () => {
        writeTaskQueue(root, [{ id: SELECTED_TASK, status: 'DONE' }, { id: 'T-OTHER', status: 'IN_PROGRESS' }]);
        const foreign = JSON.stringify({ task_id: 'T-OTHER' });
        const ambiguous = [
            writeFile(runtime, `reviews/${SELECTED_TASK}-code-review-output.md`, foreign),
            writeFile(runtime, `reviews/${SELECTED_TASK}-security-review-output.md`, '{invalid-json'),
            writeFile(runtime, `reviews/${SELECTED_TASK}-test-review-output.md`, JSON.stringify({ task_id: [SELECTED_TASK] })),
            writeFile(runtime, `reviews/${SELECTED_TASK}-code-artifact-${'f'.repeat(64)}.md`, foreign),
            writeFile(runtime, `reviews/${SELECTED_TASK}-performance-review-output.md.gz`, zlib.gzipSync(foreign)),
            writeFile(runtime, `reviews/${SELECTED_TASK}-refactor-review-output.md.gz`, zlib.gzipSync('{invalid-json'))
        ];
        const shared = writeFile(root, 'user-owned/shared-review.json', JSON.stringify({ task_id: SELECTED_TASK }));
        const sharedArtifact = path.join(runtime, `reviews/${SELECTED_TASK}-dependency-review-output.md`);
        fs.linkSync(shared, sharedArtifact);
        ambiguous.push(sharedArtifact);
        const valid = [
            writeFile(runtime, `reviews/${SELECTED_TASK}-api-review-output.md`, JSON.stringify({ task_id: SELECTED_TASK })),
            writeFile(runtime, `reviews/${SELECTED_TASK}-infra-review-output.md`, '# Legacy review\n'),
            writeFile(runtime, `reviews/${SELECTED_TASK}-code.md.gz`, zlib.gzipSync(JSON.stringify({ task_id: SELECTED_TASK }))),
            writeFile(runtime, `reviews/${SELECTED_TASK}-security.md.gz`, zlib.gzipSync('# Legacy compressed review\n'))
        ];
        const before = ambiguous.map((file) => fs.readFileSync(file));
        const sharedBefore = fs.readFileSync(shared);
        assert.deepEqual(collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK).map((item) => item.path).sort(), [...valid].sort());
        const purged = runTaskRuntimePurge({ targetRoot: root, bundleRoot: bundle, taskId: SELECTED_TASK, confirm: true });
        assert.equal(purged.result, 'SUCCESS');
        assert.deepEqual(ambiguous.map((file) => fs.readFileSync(file)), before);
        assert.deepEqual(valid.map((file) => fs.existsSync(file)), Array(4).fill(false));
        assert.deepEqual(fs.readFileSync(shared), sharedBefore);
        assert.equal(fs.statSync(shared).nlink, 2);
    });

    it('preserves foreign hardlinked non-JSON review evidence in inventory and storage', () => {
        writeQueue();
        const shared = writeFile(root, 'user-owned/shared.diff', 'shared source diff\n');
        const artifact = path.join(runtime, `reviews/${SELECTED_TASK}-code-scoped.diff`);
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.linkSync(shared, artifact);
        const before = fs.readFileSync(shared);
        assert.deepEqual(collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK), []);
        const stored = applyStoragePolicy(path.join(runtime, 'reviews'), {
            retentionMode: 'none', compressAfterDays: 0, compressionFormat: 'gzip',
            preserveGateReceipts: false, gateReceiptSuffixes: []
        }, new Set(), runtime);
        assert.deepEqual(stored.removed, []);
        assert.deepEqual(stored.preserved, [path.basename(artifact)]);
        assert.deepEqual(fs.readFileSync(shared), before);
        assert.deepEqual(fs.readFileSync(artifact), before);
        assert.equal(fs.statSync(shared).nlink, 2);
    });

    it('preserves foreign existing gzip destinations including hardlinks during compression', () => {
        const sources = [
            writeFile(runtime, 'reviews/T-GZIP-REGULAR-task-plan.json', JSON.stringify({ task_id: 'T-GZIP-REGULAR' })),
            writeFile(runtime, 'reviews/T-GZIP-SHARED-task-plan.json', JSON.stringify({ task_id: 'T-GZIP-SHARED' }))
        ];
        const foreign = zlib.gzipSync(JSON.stringify({ task_id: 'T-OTHER' }));
        const destinations = sources.map((file) => `${file}.gz`);
        fs.writeFileSync(destinations[0], foreign);
        const shared = writeFile(root, 'user-owned/shared-review.json.gz', foreign);
        fs.linkSync(shared, destinations[1]);
        const sourceBefore = sources.map((file) => fs.readFileSync(file));
        const destinationBefore = destinations.map((file) => fs.readFileSync(file));
        const past = daysAgo(45);
        for (const file of sources) fs.utimesSync(file, past, past);
        const stored = applyStoragePolicy(path.join(runtime, 'reviews'), {
            retentionMode: 'full', compressAfterDays: 1, compressionFormat: 'gzip',
            preserveGateReceipts: false, gateReceiptSuffixes: []
        }, new Set(), runtime);
        assert.deepEqual(destinations.map((file) => fs.readFileSync(file)), destinationBefore);
        assert.deepEqual(sources.map((file) => fs.readFileSync(file)), sourceBefore);
        assert.deepEqual(stored.compressed, []);
        assert.deepEqual(stored.preserved.sort(), sources.map((file) => path.basename(file)).sort());
        assert.deepEqual(sources.map((file) => fs.existsSync(`${file}.gz.tmp`)), [false, false]);
        assert.deepEqual(fs.readFileSync(shared), foreign);
        assert.equal(fs.statSync(shared).nlink, 2);
    });

    it('preserves foreign compression staging files and hardlinked target bytes', () => {
        const sources = [
            writeFile(runtime, 'reviews/T-STAGING-REGULAR-task-plan.json', JSON.stringify({ task_id: 'T-STAGING-REGULAR' })),
            writeFile(runtime, 'reviews/T-STAGING-SHARED-task-plan.json', JSON.stringify({ task_id: 'T-STAGING-SHARED' }))
        ];
        const stages = sources.map((file) => `${file}.gz.tmp`);
        fs.writeFileSync(stages[0], 'foreign staging bytes\n');
        const shared = writeFile(root, 'user-owned/shared-staging.txt', 'user-owned bytes\n');
        fs.linkSync(shared, stages[1]);
        const sourceBefore = sources.map((file) => fs.readFileSync(file));
        const stageBefore = stages.map((file) => fs.readFileSync(file));
        const sharedBefore = fs.readFileSync(shared);
        const past = daysAgo(45);
        for (const file of sources) fs.utimesSync(file, past, past);
        const stored = applyStoragePolicy(path.join(runtime, 'reviews'), {
            retentionMode: 'full', compressAfterDays: 1, compressionFormat: 'gzip',
            preserveGateReceipts: false, gateReceiptSuffixes: []
        }, new Set(), runtime);
        assert.deepEqual(fs.readFileSync(shared), sharedBefore);
        assert.deepEqual(stages.map((file) => fs.readFileSync(file)), stageBefore);
        assert.deepEqual(sources.map((file) => fs.readFileSync(file)), sourceBefore);
        assert.deepEqual(stored.compressed, []);
        assert.deepEqual(stored.preserved.sort(), sources.map((file) => path.basename(file)).sort());
        assert.deepEqual(sources.map((file) => fs.existsSync(`${file}.gz`)), [false, false]);
        assert.equal(fs.statSync(shared).nlink, 2);
    });

    it('inventories compressed historical files, canonical JSON plans and immutable review copies', () => {
        const selected = seedReviewArtifacts(SELECTED_TASK);
        const compressed = writeFile(runtime, `reviews/${SELECTED_TASK}-final-user-report.md.gz`, zlib.gzipSync('report\n'));
        const immutable = writeFile(runtime, `reviews/${SELECTED_TASK}-code-artifact-${'a'.repeat(64)}.md`, '# Immutable review\n');
        const inventory = collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK);
        assert.deepEqual(inventory.map((item) => item.path).sort(), [...selected, compressed, immutable].sort());
        assert.ok(inventory.every((item) => item.taskId === SELECTED_TASK));
        assert.ok(inventory.every((item) => item.sizeBytes === fs.statSync(item.path).size));
    });

    it('preserves conflicting JSON ownership and unrelated shared review files', () => {
        const conflicting = writeFile(runtime, `reviews/${SELECTED_TASK}-task-plan.json`, JSON.stringify({ task_id: 'T-OTHER' }));
        const shared = writeFile(runtime, 'reviews/operator-summary.json', JSON.stringify({ task_id: SELECTED_TASK }));
        const survivor = writeFile(runtime, 'reviews/T-OTHER-quality-checklist.json', JSON.stringify({ task_id: 'T-OTHER' }));
        const inventory = collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK);
        assert.equal(inventory.some((item) => item.path === conflicting), false);
        assert.equal(inventory.some((item) => item.path === shared), false);
        assert.equal(inventory.some((item) => item.path === survivor), false);
    });

    it('preserves malformed, invalid and compressed conflicting identities while accepting legacy JSON', () => {
        writeFile(runtime, `reviews/${SELECTED_TASK}-task-plan.json`, '{invalid-json');
        writeFile(runtime, `reviews/${SELECTED_TASK}-quality-checklist.json`, JSON.stringify({ task_id: CHILD_TASK }));
        writeFile(runtime, `reviews/${SELECTED_TASK}-coherent-cycle-restart.json`, JSON.stringify({ task_id: '../T-OTHER' }));
        writeFile(runtime, `reviews/${SELECTED_TASK}-task-plan.json.gz`, zlib.gzipSync(JSON.stringify({ task_id: 'T-OTHER' })));
        writeFile(runtime, `reviews/${SELECTED_TASK}-scoped-summary.json.gz`, Buffer.from('invalid-gzip'));
        const legacy = writeFile(runtime, `reviews/${SELECTED_TASK}-review-cycle-restart.json`, JSON.stringify({ schema_version: 1 }));
        const compressed = writeFile(runtime, `reviews/${SELECTED_TASK}-quality-checklist.json.gz`, zlib.gzipSync(JSON.stringify({ task_id: SELECTED_TASK })));
        const inventory = collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK);
        assert.deepEqual(inventory.map((item) => item.path).sort(), [legacy, compressed].sort());
    });

    it('preserves invalid non-string declared task identities in plain and compressed JSON', () => {
        writeQueue();
        const invalidIdentities: unknown[] = [[SELECTED_TASK], [SELECTED_TASK, CHILD_TASK], null, true, 17, { task_id: SELECTED_TASK }];
        const jsonSuffixes = HISTORICAL_ARTIFACTS.filter((suffix) => suffix.endsWith('.json'));
        for (const [index, taskId] of invalidIdentities.entries()) {
            const content = JSON.stringify({ task_id: taskId });
            writeFile(runtime, `reviews/${SELECTED_TASK}-${jsonSuffixes[index]}`, content);
            writeFile(runtime, `reviews/${SELECTED_TASK}-${jsonSuffixes[index]}.gz`, zlib.gzipSync(content));
        }
        const before = snapshotFiles(path.join(runtime, 'reviews'));
        const queueBefore = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
        assert.deepEqual(collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK), []);
        const result = runTaskRuntimePurge({ targetRoot: root, bundleRoot: bundle, taskId: SELECTED_TASK, confirm: true });
        assert.equal(result.removed.length, 0);
        assert.deepEqual(snapshotFiles(path.join(runtime, 'reviews')), before);
        assert.equal(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), queueBefore);
    });

    it('rejects hardlinked JSON artifacts and symlinked compact task roots', () => {
        const shared = writeFile(root, 'shared/identity.json', JSON.stringify({ task_id: SELECTED_TASK }));
        const reviews = path.join(runtime, 'reviews');
        fs.mkdirSync(reviews, { recursive: true });
        fs.linkSync(shared, path.join(reviews, `${SELECTED_TASK}-task-plan.json`));
        const outside = writeFile(root, 'outside/stdout.log', 'unrelated output\n');
        fs.mkdirSync(path.join(runtime, 'compact'), { recursive: true });
        fs.symlinkSync(path.dirname(outside), path.join(runtime, 'compact', SELECTED_TASK), process.platform === 'win32' ? 'junction' : 'dir');
        const inventory = collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK);
        assert.deepEqual(inventory, []);
        writeQueue();
        const result = runTaskRuntimePurge({ targetRoot: root, bundleRoot: bundle, taskId: SELECTED_TASK, confirm: true });
        assert.equal(result.removed.length, 0);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'unrelated output\n');
        assert.equal(fs.readFileSync(shared, 'utf8'), JSON.stringify({ task_id: SELECTED_TASK }));
    });

    it('rejects symlinked compact task roots before following or recursively inspecting targets', (t) => {
        const outside = writeFile(root, 'outside/stdout.log', 'unrelated output\n');
        const linkedRoot = path.join(runtime, 'compact', SELECTED_TASK);
        fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
        fs.symlinkSync(path.dirname(outside), linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const nativeFs = require('node:fs') as typeof fs;
        const statSpy = t.mock.method(nativeFs, 'statSync');
        const readdirSpy = t.mock.method(nativeFs, 'readdirSync');
        assert.deepEqual(collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK), []);
        assert.equal(statSpy.mock.calls.some((call) => call.arguments[0] === linkedRoot), false);
        assert.equal(readdirSpy.mock.calls.some((call) => call.arguments[0] === linkedRoot || call.arguments[0] === path.dirname(outside)), false);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'unrelated output\n');
    });

    it('rejects linked compact namespaces before enumerating or sizing shared targets', (t) => {
        writeQueue();
        const shared = writeFile(runtime, `cache/${SELECTED_TASK}/stdout.log`, 'shared cache output\n');
        const compactRoot = path.join(runtime, 'compact');
        fs.symlinkSync(path.join(runtime, 'cache'), compactRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const nativeFs = require('node:fs') as typeof fs;
        const statSpy = t.mock.method(nativeFs, 'statSync');
        const readdirSpy = t.mock.method(nativeFs, 'readdirSync');
        assert.deepEqual(collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK), []);
        assert.equal(statSpy.mock.calls.some((call) => call.arguments[0] === path.join(compactRoot, SELECTED_TASK)), false);
        assert.equal(readdirSpy.mock.calls.some((call) => call.arguments[0] === compactRoot || call.arguments[0] === path.dirname(shared)), false);
        t.mock.restoreAll();
        const result = runTaskRuntimePurge({ targetRoot: root, bundleRoot: bundle, taskId: SELECTED_TASK, confirm: true });
        assert.equal(result.removed.length, 0);
        assert.equal(fs.readFileSync(shared, 'utf8'), 'shared cache output\n');
        assert.equal(fs.lstatSync(compactRoot).isSymbolicLink(), true);
    });

    it('blocks compact removal after its namespace is replaced by a link', () => {
        const original = writeFile(runtime, `compact/${SELECTED_TASK}/stdout.log`, 'owned output\n');
        const candidates = collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK);
        assert.equal(candidates.length, 1);
        fs.unlinkSync(original);
        fs.rmdirSync(path.dirname(original));
        const compactRoot = path.join(runtime, 'compact');
        fs.rmdirSync(compactRoot);
        const shared = writeFile(runtime, `cache/${SELECTED_TASK}/stdout.log`, 'shared cache output\n');
        fs.symlinkSync(path.join(runtime, 'cache'), compactRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const result = processCleanupCandidates(candidates, false, runtime);
        assert.deepEqual(result.removed, []);
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0].message, /compact.*(?:link|directory)/iu);
        assert.equal(fs.readFileSync(shared, 'utf8'), 'shared cache output\n');
        assert.equal(fs.lstatSync(compactRoot).isSymbolicLink(), true);
    });

    it('rejects oversized JSON ownership files before opening or parsing', (t) => {
        const oversized = writeFile(runtime, `reviews/${SELECTED_TASK}-task-plan.json`, '{}');
        fs.truncateSync(oversized, 64 * 1024 * 1024 + 1);
        const nativeFs = require('node:fs') as typeof fs;
        const openSpy = t.mock.method(nativeFs, 'openSync');
        assert.deepEqual(collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK), []);
        assert.equal(openSpy.mock.calls.some((call) => call.arguments[0] === oversized), false);
        assert.equal(fs.statSync(oversized).size, 64 * 1024 * 1024 + 1);
    });

    it('keeps exact child ownership when its parent is active and skips active task evidence', () => {
        seedReviewArtifacts(SELECTED_TASK);
        const parent = writeFile(runtime, 'reviews/T-991-1-quality-checklist.json', JSON.stringify({ task_id: 'T-991-1' }));
        const childInventory = collectTaskRuntimePurgeInventory(runtime, new Set(['T-991-1']));
        assert.equal(childInventory.some((item) => item.path === parent), false);
        assert.equal(childInventory.filter((item) => item.taskId === SELECTED_TASK).length, HISTORICAL_ARTIFACTS.length);
        assert.equal(collectTaskRuntimePurgeInventory(runtime, new Set([SELECTED_TASK])).some((item) => item.taskId === SELECTED_TASK), false);
    });

    it('includes semantic Markdown plans and compact output subtrees with exact task boundaries', () => {
        const plan = writeFile(runtime, 'plans/T-CLEANUP-ART.md', '# Optional guidance\n');
        writeFile(runtime, `compact/${SELECTED_TASK}/${'b'.repeat(32)}/stdout.log`, 'captured output\n');
        writeFile(runtime, `compact/${CHILD_TASK}/${'c'.repeat(32)}/stdout.log`, 'child output\n');
        const shared = writeFile(runtime, 'compact/operator-note.txt', 'shared\n');
        const inventory = collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK);
        assert.ok(inventory.some((item) => item.path === path.join(runtime, 'compact', SELECTED_TASK) && item.category === 'compact'));
        assert.ok(inventory.every((item) => item.taskId === SELECTED_TASK));
        assert.equal(inventory.some((item) => item.path === shared), false);
        assert.ok(collectTaskRuntimePurgeCandidates(runtime, 'T-CLEANUP-ART').some((item) => item.path === plan));
    });

    it('classifies compact-only task ownership, count and age in retention preview', () => {
        writeQueue();
        writeFile(runtime, `compact/${SELECTED_TASK}/${'b'.repeat(32)}/stdout.log`, 'captured output\n');
        const preview = buildRuntimeRetentionPreview(root, bundle, collectTaskRuntimePurgeCandidates(runtime, SELECTED_TASK));
        assert.equal(preview.task_count, 1);
        assert.equal(preview.tasks[0].task_id, SELECTED_TASK);
        assert.deepEqual(preview.tasks[0].candidate_categories, ['compact']);
        assert.equal(preview.tasks[0].candidate_count, 1);
        assert.equal(preview.tasks[0].age_days, 0);
    });

    it('preserves fresh compact output when healthy task evidence is stale', () => {
        writeQueue();
        const evidence = seedHealthyDoneTaskArtifacts({ bundleRoot: bundle, taskId: SELECTED_TASK, ageDays: 45 });
        const compact = writeFile(runtime, `compact/${SELECTED_TASK}/${'c'.repeat(32)}/stdout.log`, 'fresh output\n');
        const selection = collectRuntimeRetentionCandidates(root, bundle, new Set());
        const preview = buildRuntimeRetentionPreview(root, bundle, selection.previewCandidates).tasks.find((task) => task.task_id === SELECTED_TASK);
        assert.ok(preview);
        assert.equal(preview.health_state, 'healthy_done');
        assert.equal(preview.age_days, 0);
        assert.ok(preview.candidate_categories.includes('compact'));
        assert.equal(preview.eligible_now, false);
        assert.equal(selection.selectedTaskIds.has(SELECTED_TASK), false);
        assert.equal(selection.compactionCandidates.some((item) => item.taskId === SELECTED_TASK), false);
        assert.equal(fs.readFileSync(compact, 'utf8'), 'fresh output\n');
        assert.equal(fs.existsSync(evidence.timelinePath), true);
    });

    it('previews without changing bytes, then removes only the selected artifacts and compact cache', () => {
        writeQueue();
        const selected = seedReviewArtifacts(SELECTED_TASK);
        const survivors = seedReviewArtifacts(CHILD_TASK);
        const selectedCompact = path.join(runtime, 'compact', SELECTED_TASK);
        writeFile(runtime, `compact/${SELECTED_TASK}/${'d'.repeat(32)}/stdout.log`, 'selected captured output\n');
        const survivorCompact = writeFile(runtime, `compact/${CHILD_TASK}/${'e'.repeat(32)}/stdout.log`, 'surviving output\n');
        const memory = writeFile(bundle, 'live/docs/project-memory/decisions.md', 'Durable project knowledge\n');
        const before = snapshotFiles(root);
        const preview = runTaskRuntimePurge({ targetRoot: root, bundleRoot: bundle, taskId: SELECTED_TASK });
        assert.equal(preview.dryRun, true);
        assert.deepEqual(snapshotFiles(root), before);
        assert.ok(preview.skipped.some((item) => item.path === selectedCompact));
        const result = runTaskRuntimePurge({ targetRoot: root, bundleRoot: bundle, taskId: SELECTED_TASK, confirm: true });
        assert.equal(result.result, 'SUCCESS');
        assert.deepEqual(result.errors, []);
        for (const file of [...selected, selectedCompact]) assert.equal(fs.existsSync(file), false, file);
        for (const file of [...survivors, survivorCompact, memory]) {
            assert.equal(fs.existsSync(file), true, file);
            assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before[path.relative(root, file)]);
        }
        assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'TASK.md'))).digest('hex'), before['TASK.md']);
    });

    it('blocks active tasks before deleting their structured plans or compact output', () => {
        writeQueue('IN_PROGRESS');
        const selected = seedReviewArtifacts(SELECTED_TASK);
        const compact = writeFile(runtime, `compact/${SELECTED_TASK}/${'f'.repeat(32)}/stdout.log`, 'active output\n');
        const result = runTaskRuntimePurge({ targetRoot: root, bundleRoot: bundle, taskId: SELECTED_TASK, confirm: true });
        assert.equal(result.result, 'BLOCKED');
        assert.equal(result.activeTaskProtected, true);
        assert.equal(result.removed.length, 0);
        for (const file of [...selected, compact]) assert.equal(fs.existsSync(file), true, file);
    });

    it('blocks compact removal while an active writer owns the shared compact lock', () => {
        writeQueue();
        const compact = writeFile(runtime, `compact/${SELECTED_TASK}/${'a'.repeat(32)}/stdout.log`, 'writer output\n');
        const { handle } = acquireFilesystemLock(path.join(runtime, 'compact.lock'), { ownerLabel: 'compact-writer' });
        try {
            const result = runTaskRuntimePurge({ targetRoot: root, bundleRoot: bundle, taskId: SELECTED_TASK, confirm: true });
            assert.notEqual(result.result, 'SUCCESS');
            assert.ok(result.errors.some((error) => /compact|lock/iu.test(error.message)));
            assert.equal(fs.readFileSync(compact, 'utf8'), 'writer output\n');
        } finally {
            releaseFilesystemLock(handle);
        }
    });
});
