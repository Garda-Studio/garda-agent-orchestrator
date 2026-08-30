import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../../src/gate-runtime/task-events';

import {
    rebuildIndex,
    loadIndex,
    loadTaskIndex,
    withTaskIndexReadSnapshot,
    writeIndex,
    resolveIndexPath,
    resolveIndexLockPath,
    isIndexStale,
    upsertEntry,
    removeEntries,
    invalidateIndex,
    entriesForTask,
    entriesByArtifactSuffix,
    taskIds,
    groupByTask,
    type ReviewsIndex
} from '../../../src/gate-runtime/reviews-index';
import { normalizeReviewCatalog } from '../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../src/core/review-capabilities';
import { buildEffectiveReviewSnapshot } from '../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../src/policy/profile-review-catalog-policy';

function makeTmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createReviewsDir(root: string): string {
    const reviewsDir = path.join(root, 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    return reviewsDir;
}

function writeArtifact(reviewsDir: string, fileName: string, content: string = '{}'): string {
    const filePath = path.join(reviewsDir, fileName);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

function buildCustomReviewSnapshot(reviewTypeId: string) {
    const catalog = normalizeReviewCatalog({
        version: 1,
        custom_review_types: [{
            id: reviewTypeId,
            display_label: 'Architecture review',
            enabled_by_default: false,
            skill_id: 'architecture-review',
            trigger: { mode: 'manual' },
            coverage_category_ids: ['maintainability'],
            reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
        }]
    }, { knownSkillIds: ['architecture-review'] });
    const capabilities = Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        { [reviewTypeId]: true },
        capabilities,
        catalog
    );
    return buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: 'a'.repeat(64),
        legacyRequiredReviews: { code: true },
        scopeCategory: 'code',
        taskIntent: 'Change architecture boundary',
        changedFiles: ['src/architecture.ts'],
        taskTriggers: {}
    });
}

function getBuiltReviewsIndexModulePath(): string {
    return path.join(process.cwd(), '.node-build', 'src', 'gate-runtime', 'reviews-index.js');
}

function spawnUpsertWorker(reviewsDir: string, fileName: string): ReturnType<typeof spawn> {
    return spawn(process.execPath, [
        '-e',
        'const { upsertEntry } = require(process.env.REVIEWS_INDEX_MODULE_PATH); upsertEntry(process.env.REVIEWS_DIR, process.env.REVIEWS_FILE_NAME);'
    ], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            REVIEWS_INDEX_MODULE_PATH: getBuiltReviewsIndexModulePath(),
            REVIEWS_DIR: reviewsDir,
            REVIEWS_FILE_NAME: fileName
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string; }> {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
    });
    if (child.exitCode !== null) {
        return { code: child.exitCode, stdout, stderr };
    }
    return await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('reviews-index', () => {
    let tmpDir: string;
    let reviewsDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('reviews-index-test-');
        reviewsDir = createReviewsDir(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('rebuildIndex', () => {
        it('returns empty entries for empty directory', () => {
            const index = rebuildIndex(reviewsDir);
            assert.equal(index.version, 4);
            assert.equal(index.entries.length, 0);
            assert.ok(index.directoryMtimeMs > 0);
            assert.ok(index.generatedAtMs > 0);
        });

        it('indexes artifacts matching T-xxx- pattern', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json', '{"task_id":"T-001"}');
            writeArtifact(reviewsDir, 'T-001-preflight.json', '{"task_id":"T-001"}');
            writeArtifact(reviewsDir, 'T-002-handshake.json', '{"task_id":"T-002"}');

            const index = rebuildIndex(reviewsDir);
            assert.equal(index.entries.length, 3);

            const taskModeEntry = index.entries.find(e => e.fileName === 'T-001-task-mode.json');
            assert.ok(taskModeEntry);
            assert.equal(taskModeEntry.taskId, 'T-001');
            assert.equal(taskModeEntry.artifactType, 'task-mode.json');
            assert.ok(taskModeEntry.mtimeMs > 0);
            assert.ok(taskModeEntry.sizeBytes > 0);
        });

        it('indexes only snapshot-authorized custom review artifacts with hyphenated ids', () => {
            const snapshot = buildCustomReviewSnapshot('architecture-boundary');
            writeArtifact(reviewsDir, 'T-729-4C-preflight.json', JSON.stringify({
                task_id: 'T-729-4C',
                required_reviews: snapshot.required_reviews,
                effective_review_snapshot: snapshot
            }));
            writeArtifact(reviewsDir, 'T-729-4C-architecture-boundary-review-context.json');
            const generatedLaneArtifacts = [
                'T-729-4C-architecture-boundary-review-context.md',
                'T-729-4C-architecture-boundary-role-prompt.md',
                'T-729-4C-architecture-boundary-prompt-template.md',
                'T-729-4C-architecture-boundary-output-template.md',
                'T-729-4C-architecture-boundary-evidence-manifest.json',
                'T-729-4C-architecture-boundary-findings-validation.json',
                'T-729-4C-architecture-boundary-findings-disposition.json',
                'T-729-4C-architecture-boundary-findings-follow-ups.json',
                'T-729-4C-architecture-boundary-remediation-baseline.json'
            ];
            for (const fileName of generatedLaneArtifacts) {
                writeArtifact(reviewsDir, fileName);
            }
            writeArtifact(
                reviewsDir,
                `T-729-4C-architecture-boundary-artifact-${'b'.repeat(64)}.md`,
                '# Review\n'
            );
            writeArtifact(reviewsDir, 'T-729-4C-rogue-lane-review-context.json');

            const index = rebuildIndex(reviewsDir);

            assert.equal(
                index.entries.find((entry) => entry.fileName.endsWith('architecture-boundary-review-context.json'))?.taskId,
                'T-729-4C'
            );
            assert.equal(
                index.entries.find((entry) => entry.fileName.includes('architecture-boundary-artifact-'))?.taskId,
                'T-729-4C'
            );
            for (const fileName of generatedLaneArtifacts) {
                assert.equal(
                    index.entries.find((entry) => entry.fileName === fileName)?.taskId,
                    'T-729-4C'
                );
            }
            assert.equal(
                index.entries.some((entry) => entry.fileName.includes('rogue-lane')),
                false
            );
        });

        it('omits an unbound artifact whose name has multiple authorized task interpretations', () => {
            const foreignSnapshot = buildCustomReviewSnapshot('architecture-code');
            writeArtifact(reviewsDir, 'T-1-preflight.json', JSON.stringify({
                task_id: 'T-1',
                required_reviews: foreignSnapshot.required_reviews,
                effective_review_snapshot: foreignSnapshot
            }));
            writeArtifact(reviewsDir, 'T-1-architecture-preflight.json', JSON.stringify({
                task_id: 'T-1-architecture',
                required_reviews: { code: true }
            }));
            writeArtifact(reviewsDir, 'T-1-architecture-code.md', '# Built-in code review\n');

            const index = rebuildIndex(reviewsDir);

            assert.equal(
                index.entries.some((candidate) => candidate.fileName === 'T-1-architecture-code.md'),
                false
            );
        });

        it('does not infer ownership for an unbound legacy/custom collision', () => {
            const customSnapshot = buildCustomReviewSnapshot('architecture-code');
            writeArtifact(reviewsDir, 'T-1-preflight.json', JSON.stringify({
                task_id: 'T-1',
                required_reviews: customSnapshot.required_reviews,
                effective_review_snapshot: customSnapshot
            }));
            writeArtifact(reviewsDir, 'T-1-architecture-code.md', '# Legacy built-in code review\n');

            const index = rebuildIndex(reviewsDir);

            assert.equal(
                index.entries.some((candidate) => candidate.fileName === 'T-1-architecture-code.md'),
                false
            );
        });

        it('uses an artifact task binding to disambiguate an overlapping custom lane', () => {
            const customSnapshot = buildCustomReviewSnapshot('architecture-code');
            writeArtifact(reviewsDir, 'T-1-preflight.json', JSON.stringify({
                task_id: 'T-1',
                required_reviews: customSnapshot.required_reviews,
                effective_review_snapshot: customSnapshot
            }));
            writeArtifact(
                reviewsDir,
                'T-1-architecture-code.md',
                JSON.stringify({ task_id: 'T-1', review_type: 'architecture-code' })
            );

            const entry = rebuildIndex(reviewsDir).entries.find(
                (candidate) => candidate.fileName === 'T-1-architecture-code.md'
            );

            assert.ok(entry);
            assert.equal(entry.taskId, 'T-1');
            assert.equal(entry.artifactType, 'architecture-code.md');
        });

        it('uses the task-bound review context to own overlapping generated Markdown artifacts', () => {
            const customSnapshot = buildCustomReviewSnapshot('architecture-code');
            writeArtifact(reviewsDir, 'T-1-preflight.json', JSON.stringify({
                task_id: 'T-1',
                required_reviews: customSnapshot.required_reviews,
                effective_review_snapshot: customSnapshot
            }));
            writeArtifact(reviewsDir, 'T-1-architecture-preflight.json', JSON.stringify({
                task_id: 'T-1-architecture',
                required_reviews: { code: true }
            }));
            writeArtifact(
                reviewsDir,
                'T-1-architecture-code-review-context.json',
                JSON.stringify({ task_id: 'T-1', review_type: 'architecture-code' })
            );
            const generatedMarkdownArtifacts = [
                'T-1-architecture-code-review-context.md',
                'T-1-architecture-code-role-prompt.md',
                'T-1-architecture-code-prompt-template.md',
                'T-1-architecture-code-output-template.md'
            ];
            for (const fileName of generatedMarkdownArtifacts) {
                writeArtifact(reviewsDir, fileName, '# Generated handoff\n');
            }

            const index = rebuildIndex(reviewsDir);

            for (const fileName of generatedMarkdownArtifacts) {
                const entry = index.entries.find((candidate) => candidate.fileName === fileName);
                assert.ok(entry);
                assert.equal(entry.taskId, 'T-1');
                assert.equal(entry.artifactType, fileName.slice('T-1-'.length));
            }
        });

        it('does not follow review artifact links outside the reviews root', (t) => {
            const customSnapshot = buildCustomReviewSnapshot('architecture-code');
            writeArtifact(reviewsDir, 'T-1-preflight.json', JSON.stringify({
                task_id: 'T-1',
                required_reviews: customSnapshot.required_reviews,
                effective_review_snapshot: customSnapshot
            }));
            const outsideArtifactPath = path.join(tmpDir, 'outside-review.json');
            fs.writeFileSync(outsideArtifactPath, JSON.stringify({
                task_id: 'T-1',
                review_type: 'architecture-code'
            }));
            const linkedArtifactName = 'T-1-architecture-code.md';
            try {
                fs.symlinkSync(outsideArtifactPath, path.join(reviewsDir, linkedArtifactName), 'file');
            } catch (error: unknown) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
                    t.skip(`filesystem links unavailable: ${code}`);
                    return;
                }
                throw error;
            }

            const index = rebuildIndex(reviewsDir);

            assert.equal(index.entries.some((entry) => entry.fileName === linkedArtifactName), false);
        });

        it('uses a receipt task binding for an overlapping hashed custom lane', () => {
            const customSnapshot = buildCustomReviewSnapshot('architecture-code');
            const sha256 = 'd'.repeat(64);
            writeArtifact(reviewsDir, 'T-1-preflight.json', JSON.stringify({
                task_id: 'T-1',
                required_reviews: customSnapshot.required_reviews,
                effective_review_snapshot: customSnapshot
            }));
            writeArtifact(reviewsDir, 'T-1-architecture-preflight.json', JSON.stringify({
                task_id: 'T-1-architecture',
                required_reviews: { code: true }
            }));
            const fileName = `T-1-architecture-code-receipt-${sha256}.json`;
            writeArtifact(reviewsDir, fileName, JSON.stringify({
                task_id: 'T-1',
                review_type: 'architecture-code'
            }));

            const entry = rebuildIndex(reviewsDir).entries.find(
                (candidate) => candidate.fileName === fileName
            );

            assert.ok(entry);
            assert.equal(entry.taskId, 'T-1');
            assert.equal(entry.artifactType, `architecture-code-receipt-${sha256}.json`);
        });

        it('indexes compressed hashed custom evidence but rejects malformed extension separators', () => {
            const customSnapshot = buildCustomReviewSnapshot('architecture-boundary');
            const sha256 = 'e'.repeat(64);
            writeArtifact(reviewsDir, 'T-1-preflight.json', JSON.stringify({
                task_id: 'T-1',
                required_reviews: customSnapshot.required_reviews,
                effective_review_snapshot: customSnapshot
            }));
            const compressedFileName = `T-1-architecture-boundary-receipt-${sha256}.json.gz`;
            fs.writeFileSync(
                path.join(reviewsDir, compressedFileName),
                zlib.gzipSync(JSON.stringify({
                    task_id: 'T-1',
                    review_type: 'architecture-boundary'
                }))
            );
            const malformedFileName = `T-1-architecture-boundary-receipt-${sha256}xjson`;
            writeArtifact(reviewsDir, malformedFileName, JSON.stringify({
                task_id: 'T-1',
                review_type: 'architecture-boundary'
            }));

            const index = rebuildIndex(reviewsDir);

            assert.ok(index.entries.some((entry) => entry.fileName === compressedFileName));
            assert.equal(index.entries.some((entry) => entry.fileName === malformedFileName), false);
        });

        it('keeps custom lane authority and task bindings after retention gzip compression', () => {
            const customSnapshot = buildCustomReviewSnapshot('architecture-code');
            fs.writeFileSync(
                path.join(reviewsDir, 'T-1-preflight.json.gz'),
                zlib.gzipSync(JSON.stringify({
                    task_id: 'T-1',
                    required_reviews: customSnapshot.required_reviews,
                    effective_review_snapshot: customSnapshot
                }))
            );
            fs.writeFileSync(
                path.join(reviewsDir, 'T-1-architecture-code.md.gz'),
                zlib.gzipSync(JSON.stringify({ task_id: 'T-1', review_type: 'architecture-code' }))
            );

            const index = rebuildIndex(reviewsDir);
            const customEntry = index.entries.find(
                (candidate) => candidate.fileName === 'T-1-architecture-code.md.gz'
            );

            assert.ok(customEntry);
            assert.equal(customEntry.taskId, 'T-1');
            assert.equal(customEntry.artifactType, 'architecture-code.md.gz');
        });

        it('does not auto-discover unknown artifacts when no snapshot authorizes them', () => {
            writeArtifact(reviewsDir, 'T-123-rogue-review.json', '{"task_id":"T-123"}');

            const index = rebuildIndex(reviewsDir);

            assert.equal(index.entries.some((entry) => entry.fileName === 'T-123-rogue-review.json'), false);
        });

        it('indexes review-remediation-cycle artifacts for multi-segment task ids', () => {
            writeArtifact(
                reviewsDir,
                'T-903b-restart-review-cycle-expanded-source-review-remediation-cycle.json',
                '{"task_id":"T-903b-restart-review-cycle-expanded-source","status":"BLOCKED"}'
            );

            const index = rebuildIndex(reviewsDir);
            const entry = index.entries.find((candidate) => (
                candidate.fileName === 'T-903b-restart-review-cycle-expanded-source-review-remediation-cycle.json'
            ));
            assert.ok(entry);
            assert.equal(entry.taskId, 'T-903b-restart-review-cycle-expanded-source');
            assert.equal(entry.artifactType, 'review-remediation-cycle.json');
        });

        it('indexes immutable review evidence for multi-segment alphanumeric task ids', () => {
            const sha256 = 'a'.repeat(64);
            writeArtifact(reviewsDir, `T-AUDIT-1-code-receipt-${sha256}.json`, '{"task_id":"T-AUDIT-1"}');
            writeArtifact(reviewsDir, `T-AUDIT-1-code-artifact-${sha256}.md`, '# Review');
            writeArtifact(reviewsDir, `T-AUDIT-1-code-findings-validation-${sha256}.json`, '{}');

            const index = rebuildIndex(reviewsDir);
            const immutableEntries = entriesForTask(index, 'T-AUDIT-1');

            assert.deepEqual(
                immutableEntries.map((entry) => entry.artifactType).sort(),
                [
                    `code-artifact-${sha256}.md`,
                    `code-findings-validation-${sha256}.json`,
                    `code-receipt-${sha256}.json`
                ]
            );
        });

        it('skips non-artifact files', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'some-random-file.json');
            writeArtifact(reviewsDir, 'not-task-prefixed.log');

            const index = rebuildIndex(reviewsDir);
            assert.equal(index.entries.length, 1);
            assert.equal(index.entries[0].fileName, 'T-001-task-mode.json');
        });

        it('skips directories inside reviews', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            fs.mkdirSync(path.join(reviewsDir, 'T-002-somedir'), { recursive: true });

            const index = rebuildIndex(reviewsDir);
            assert.equal(index.entries.length, 1);
        });

        it('returns empty for non-existent directory', () => {
            const nonExistent = path.join(tmpDir, 'does-not-exist');
            const index = rebuildIndex(nonExistent);
            assert.equal(index.entries.length, 0);
        });
    });

    describe('writeIndex and resolveIndexPath', () => {
        it('writes index atomically and can be read back', () => {
            const index: ReviewsIndex = {
                version: 4,
                directoryMtimeMs: 12345,
                generatedAtMs: Date.now(),
                entries: [{
                    fileName: 'T-001-task-mode.json',
                    taskId: 'T-001',
                    artifactType: 'task-mode.json',
                    mtimeMs: 1000,
                    sizeBytes: 50
                }]
            };

            const indexPath = resolveIndexPath(reviewsDir);
            writeIndex(indexPath, index);

            assert.ok(fs.existsSync(indexPath));
            const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            assert.equal(raw.version, 4);
            assert.equal(raw.entries.length, 1);
            assert.equal(raw.entries[0].fileName, 'T-001-task-mode.json');
            assert.match(raw.entries_sha256, /^[0-9a-f]{64}$/u);
        });

        it('cleans up temp file on write failure', () => {
            const badPath = path.join(tmpDir, 'non-existent-deep', 'sub', 'sub2', 'index.json');
            // mkdirSync recursive in writeIndex should handle this
            const index: ReviewsIndex = {
                version: 4,
                directoryMtimeMs: 0,
                generatedAtMs: Date.now(),
                entries: []
            };

            writeIndex(badPath, index);
            assert.ok(fs.existsSync(badPath));
        });

        it('preserves the previous index when final rename fails', () => {
            const indexPath = resolveIndexPath(reviewsDir);
            const previousIndex: ReviewsIndex = {
                version: 4,
                directoryMtimeMs: 1,
                directoryCtimeMs: 1,
                directoryEntryCount: 0,
                generatedAtMs: Date.now(),
                entries: []
            };
            const nextIndex: ReviewsIndex = {
                version: 4,
                directoryMtimeMs: 2,
                directoryCtimeMs: 2,
                directoryEntryCount: 1,
                generatedAtMs: Date.now(),
                entries: [{
                    fileName: 'T-002-preflight.json',
                    taskId: 'T-002',
                    artifactType: 'preflight.json',
                    mtimeMs: 100,
                    sizeBytes: 10
                }]
            };
            const previousContent = JSON.stringify(previousIndex, null, 2) + '\n';
            fs.writeFileSync(indexPath, previousContent, 'utf8');

            const realFs = require('node:fs');
            const originalRenameSync = realFs.renameSync;
            try {
                realFs.renameSync = function (...args: any[]) {
                    if (args[1] === indexPath) {
                        throw new Error('simulated index rename failure');
                    }
                    return originalRenameSync.apply(realFs, args);
                };

                assert.throws(
                    () => writeIndex(indexPath, nextIndex),
                    /simulated index rename failure/
                );
            } finally {
                realFs.renameSync = originalRenameSync;
            }

            assert.equal(fs.readFileSync(indexPath, 'utf8'), previousContent);
            assert.deepStrictEqual(
                fs.readdirSync(reviewsDir).filter((entry) => entry.includes('.tmp-')),
                []
            );
        });
    });

    describe('isIndexStale', () => {
        it('returns true when no index exists', () => {
            const indexPath = resolveIndexPath(reviewsDir);
            assert.equal(isIndexStale(indexPath, reviewsDir), true);
        });

        it('returns false for fresh index with matching directory mtime', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            loadIndex(reviewsDir);

            const indexPath = resolveIndexPath(reviewsDir);
            assert.equal(isIndexStale(indexPath, reviewsDir), false);
        });

        it('returns true when directory mtime changed', () => {
            loadIndex(reviewsDir);
            const indexPath = resolveIndexPath(reviewsDir);

            // Add a new file to change directory mtime
            writeArtifact(reviewsDir, 'T-099-task-mode.json');

            assert.equal(isIndexStale(indexPath, reviewsDir), true);
        });

        it('returns true when index exceeds max staleness', () => {
            const { index } = loadIndex(reviewsDir);
            const indexPath = resolveIndexPath(reviewsDir);

            // Make index appear very old
            const staleIndex: ReviewsIndex = {
                ...index,
                generatedAtMs: Date.now() - 200_000
            };
            writeIndex(indexPath, staleIndex);

            assert.equal(isIndexStale(indexPath, reviewsDir, 60_000), true);
        });
    });

    describe('loadIndex', () => {
        it('rebuilds when no index exists', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 1);

            // Should have persisted the index
            assert.ok(fs.existsSync(resolveIndexPath(reviewsDir)));
        });

        it('uses cache on second call when directory unchanged', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'cache');
            assert.equal(second.index.entries.length, 1);
        });

        it('rebuilds a structurally valid cache containing unauthorized ownership', () => {
            writeArtifact(reviewsDir, 'T-123-preflight.json', '{"task_id":"T-123","required_reviews":{"code":true}}');
            writeArtifact(reviewsDir, 'T-123-rogue-review.json', '{"task_id":"T-123"}');
            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');
            assert.equal(first.index.directoryUnindexedEntryCount, 1);

            const indexPath = resolveIndexPath(reviewsDir);
            const forged = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            const roguePath = path.join(reviewsDir, 'T-123-rogue-review.json');
            const rogueStat = fs.statSync(roguePath);
            forged.entries.push({
                fileName: 'T-123-rogue-review.json',
                taskId: 'T-123',
                artifactType: 'rogue-review.json',
                mtimeMs: rogueStat.mtimeMs,
                sizeBytes: rogueStat.size
            });
            forged.directoryUnindexedEntryCount = 0;
            fs.writeFileSync(indexPath, JSON.stringify(forged), 'utf8');

            const second = loadIndex(reviewsDir);

            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.some((entry) => entry.fileName === 'T-123-rogue-review.json'), false);
        });

        it('uses cache without revalidating or rescanning artifacts on cache hit', () => {
            for (let i = 0; i < 25; i++) {
                writeArtifact(reviewsDir, `T-${String(i).padStart(3, '0')}-task-mode.json`);
            }
            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');

            const realFs = require('node:fs');
            const originalStatSync = realFs.statSync;
            const originalLstatSync = realFs.lstatSync;
            const originalRealpathSync = realFs.realpathSync;
            const originalReaddirSync = realFs.readdirSync;
            let artifactValidationCount = 0;
            let reviewsDirectoryReadCount = 0;
            const isReviewArtifactPath = (candidate: unknown): boolean => {
                const targetPath = typeof candidate === 'string'
                    ? path.resolve(candidate)
                    : '';
                return path.dirname(targetPath) === path.resolve(reviewsDir)
                    && path.basename(targetPath) !== 'reviews-index.json';
            };
            try {
                realFs.statSync = function (...args: any[]) {
                    if (isReviewArtifactPath(args[0])) {
                        artifactValidationCount += 1;
                    }
                    return originalStatSync.apply(realFs, args);
                };
                realFs.lstatSync = function (...args: any[]) {
                    if (isReviewArtifactPath(args[0])) {
                        artifactValidationCount += 1;
                    }
                    return originalLstatSync.apply(realFs, args);
                };
                realFs.realpathSync = function (...args: any[]) {
                    if (isReviewArtifactPath(args[0])) {
                        artifactValidationCount += 1;
                    }
                    return originalRealpathSync.apply(realFs, args);
                };
                realFs.readdirSync = function (...args: any[]) {
                    if (path.resolve(String(args[0])) === path.resolve(reviewsDir)) {
                        reviewsDirectoryReadCount += 1;
                    }
                    return originalReaddirSync.apply(realFs, args);
                };

                const second = loadIndex(reviewsDir);
                assert.equal(second.source, 'cache');
            } finally {
                realFs.statSync = originalStatSync;
                realFs.lstatSync = originalLstatSync;
                realFs.realpathSync = originalRealpathSync;
                realFs.readdirSync = originalReaddirSync;
            }

            assert.equal(artifactValidationCount, 0);
            assert.equal(reviewsDirectoryReadCount, 0);
        });

        it('loads one task without authorizing unrelated historical artifacts', () => {
            writeArtifact(reviewsDir, 'T-ACTIVE-preflight.json', JSON.stringify({
                task_id: 'T-ACTIVE',
                required_reviews: { code: true }
            }));
            writeArtifact(reviewsDir, 'T-ACTIVE-handshake.json', JSON.stringify({
                task_id: 'T-ACTIVE',
                status: 'PASSED'
            }));
            for (let index = 0; index < 100; index++) {
                const taskId = `T-HISTORICAL-${index}`;
                writeArtifact(reviewsDir, `${taskId}-preflight.json`, JSON.stringify({
                    task_id: taskId,
                    required_reviews: { code: true }
                }));
                writeArtifact(reviewsDir, `${taskId}-handshake.json`, JSON.stringify({
                    task_id: taskId,
                    status: 'PASSED'
                }));
            }
            loadIndex(reviewsDir);

            const realFs = require('node:fs');
            const originalLstatSync = realFs.lstatSync;
            const originalRealpathSync = realFs.realpathSync;
            let unrelatedAuthorizationCount = 0;
            const isUnrelatedArtifactPath = (candidate: unknown): boolean => (
                typeof candidate === 'string'
                && path.dirname(path.resolve(candidate)) === path.resolve(reviewsDir)
                && path.basename(candidate).startsWith('T-HISTORICAL-')
            );
            try {
                realFs.lstatSync = function (...args: any[]) {
                    if (isUnrelatedArtifactPath(args[0])) unrelatedAuthorizationCount += 1;
                    return originalLstatSync.apply(realFs, args);
                };
                realFs.realpathSync = function (...args: any[]) {
                    if (isUnrelatedArtifactPath(args[0])) unrelatedAuthorizationCount += 1;
                    return originalRealpathSync.apply(realFs, args);
                };

                const result = loadTaskIndex(reviewsDir, 'T-ACTIVE');
                assert.deepEqual(
                    result.index.entries.map((entry) => entry.fileName).sort(),
                    ['T-ACTIVE-handshake.json', 'T-ACTIVE-preflight.json']
                );
            } finally {
                realFs.lstatSync = originalLstatSync;
                realFs.realpathSync = originalRealpathSync;
            }

            assert.equal(unrelatedAuthorizationCount, 0);
        });

        it('reuses one validated task index only inside an invocation snapshot', () => {
            writeArtifact(reviewsDir, 'T-ACTIVE-task-mode.json', JSON.stringify({
                task_id: 'T-ACTIVE'
            }));
            loadIndex(reviewsDir);

            const realFs = require('node:fs');
            const originalReadFileSync = realFs.readFileSync;
            const indexPath = resolveIndexPath(reviewsDir);
            let indexReadCount = 0;
            realFs.readFileSync = function (...args: any[]) {
                if (path.resolve(String(args[0])) === path.resolve(indexPath)) {
                    indexReadCount += 1;
                }
                return originalReadFileSync.apply(realFs, args);
            };
            try {
                withTaskIndexReadSnapshot(reviewsDir, 'T-ACTIVE', () => {
                    const first = loadTaskIndex(reviewsDir, 'T-ACTIVE');
                    assert.equal(first.index.entries.length, 1);
                    first.index.entries.splice(0);
                    assert.equal(loadTaskIndex(reviewsDir, 'T-ACTIVE').index.entries.length, 1);
                    assert.equal(loadTaskIndex(reviewsDir, 'T-ACTIVE').index.entries.length, 1);
                });
                assert.equal(indexReadCount, 1);

                assert.equal(loadTaskIndex(reviewsDir, 'T-ACTIVE').index.entries.length, 1);
                assert.equal(indexReadCount, 2);
            } finally {
                realFs.readFileSync = originalReadFileSync;
            }
        });

        it('keeps overlapping parent and child artifact ownership fail-closed in a task view', () => {
            const parentSnapshot = buildCustomReviewSnapshot('architecture-code');
            writeArtifact(reviewsDir, 'T-1-preflight.json', JSON.stringify({
                task_id: 'T-1',
                required_reviews: parentSnapshot.required_reviews,
                effective_review_snapshot: parentSnapshot
            }));
            writeArtifact(reviewsDir, 'T-1-architecture-preflight.json', JSON.stringify({
                task_id: 'T-1-architecture',
                required_reviews: { code: true }
            }));
            writeArtifact(reviewsDir, 'T-1-architecture-code.md', '# Ambiguous ownership\n');

            const result = loadTaskIndex(reviewsDir, 'T-1');

            assert.equal(
                result.index.entries.some((entry) => entry.fileName === 'T-1-architecture-code.md'),
                false
            );
            assert.ok(result.index.entries.every((entry) => entry.taskId === 'T-1'));
        });

        it('rebuilds when forceRebuild is true', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');

            const second = loadIndex(reviewsDir, { forceRebuild: true });
            assert.equal(second.source, 'rebuilt');
        });

        it('rebuilds when directory changed between loads', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');
            assert.equal(first.index.entries.length, 1);

            writeArtifact(reviewsDir, 'T-002-preflight.json');

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 2);
        });

        it('rebuilds when an existing artifact is atomically replaced without changing entry count', async () => {
            const artifactPath = writeArtifact(reviewsDir, 'T-001-handshake.json', 'old');
            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');
            assert.equal(first.index.entries.length, 1);
            const firstEntry = first.index.entries[0];

            await delay(5);
            const replacementPath = path.join(reviewsDir, '.T-001-handshake.json.tmp-test');
            fs.writeFileSync(replacementPath, 'new', 'utf8');
            fs.renameSync(replacementPath, artifactPath);

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 1);
            assert.equal(second.index.entries[0].fileName, 'T-001-handshake.json');
            assert.notEqual(second.index.entries[0].mtimeMs, firstEntry.mtimeMs);
        });

        it('rebuilds when artifact replacement shares a millisecond bucket with the index marker', () => {
            const artifactPath = writeArtifact(reviewsDir, 'T-001-handshake.json', 'old');
            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');
            assert.equal(first.index.entries.length, 1);
            assert.equal(first.index.entries[0].sizeBytes, 3);

            const replacementPath = path.join(reviewsDir, '.T-001-handshake.json.tmp-test');
            fs.writeFileSync(replacementPath, 'new-content', 'utf8');
            fs.renameSync(replacementPath, artifactPath);

            const replacementDirMtimeMs = fs.statSync(reviewsDir).mtimeMs;
            const markerBucketMs = Math.max(
                Math.trunc(replacementDirMtimeMs),
                Math.trunc(first.index.directoryMtimeMs) + 1
            );
            const simulatedDirMtimeSeconds = (markerBucketMs + 0.75) / 1000;
            fs.utimesSync(reviewsDir, simulatedDirMtimeSeconds, simulatedDirMtimeSeconds);
            fs.utimesSync(resolveIndexPath(reviewsDir), markerBucketMs / 1000, markerBucketMs / 1000);

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 1);
            assert.equal(second.index.entries[0].fileName, 'T-001-handshake.json');
            assert.equal(second.index.entries[0].sizeBytes, 'new-content'.length);
        });

        it('does not count index file itself as an artifact', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const result = loadIndex(reviewsDir);

            const indexEntry = result.index.entries.find(
                e => e.fileName === 'reviews-index.json'
            );
            assert.equal(indexEntry, undefined);
        });
    });

    describe('upsertEntry', () => {
        it('adds new entry to existing index', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json', '{"task_id":"T-001"}');
            loadIndex(reviewsDir);

            writeArtifact(reviewsDir, 'T-002-preflight.json', '{"task_id":"T-002"}');
            upsertEntry(reviewsDir, 'T-002-preflight.json');

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 2);
            assert.ok(index.entries.some(e => e.fileName === 'T-002-preflight.json'));
            assert.equal(isIndexStale(indexPath, reviewsDir), false);
            assert.equal(loadIndex(reviewsDir).source, 'cache');
        });

        it('updates existing entry', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json', '{"v":1}');
            loadIndex(reviewsDir);

            // Overwrite with larger content
            writeArtifact(reviewsDir, 'T-001-task-mode.json', '{"v":2,"extra":"data"}');
            upsertEntry(reviewsDir, 'T-001-task-mode.json');

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 1);
            assert.equal(index.entries[0].fileName, 'T-001-task-mode.json');
            assert.equal(isIndexStale(indexPath, reviewsDir), false);
            assert.equal(loadIndex(reviewsDir).source, 'cache');
        });

        it('triggers rebuild when no index exists', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-preflight.json');

            upsertEntry(reviewsDir, 'T-001-task-mode.json');

            const indexPath = resolveIndexPath(reviewsDir);
            assert.ok(fs.existsSync(indexPath));
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            // Rebuild should capture all files, not just the upserted one
            assert.equal(index.entries.length, 2);
        });

        it('ignores non-artifact filenames', () => {
            writeArtifact(reviewsDir, 'random-file.json');
            loadIndex(reviewsDir);

            upsertEntry(reviewsDir, 'random-file.json');

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 0);
        });

        it('keeps the index fresh after the index lock is released', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            upsertEntry(reviewsDir, 'T-001-task-mode.json');

            const indexPath = resolveIndexPath(reviewsDir);
            assert.equal(isIndexStale(indexPath, reviewsDir), false);

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'cache');
            assert.equal(second.index.entries.length, 1);
        });

        it('serializes parallel writers through a dedicated index lock', { concurrency: false }, async () => {
            const builtModulePath = getBuiltReviewsIndexModulePath();
            assert.equal(fs.existsSync(builtModulePath), true, `Built module missing: ${builtModulePath}`);

            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-preflight.json');

            const lockPath = resolveIndexLockPath(reviewsDir);
            const { handle } = acquireFilesystemLock(lockPath, { timeoutMs: 2_000, retryMs: 10 });
            let lockReleased = false;
            const firstWorker = spawnUpsertWorker(reviewsDir, 'T-001-task-mode.json');
            const secondWorker = spawnUpsertWorker(reviewsDir, 'T-002-preflight.json');
            try {
                await delay(150);
                assert.equal(firstWorker.exitCode, null, 'first worker should wait on the index lock');
                assert.equal(secondWorker.exitCode, null, 'second worker should wait on the index lock');

                releaseFilesystemLock(handle);
                lockReleased = true;

                const [firstExit, secondExit] = await Promise.all([
                    waitForChildExit(firstWorker),
                    waitForChildExit(secondWorker)
                ]);
                assert.equal(firstExit.code, 0, firstExit.stderr || firstExit.stdout);
                assert.equal(secondExit.code, 0, secondExit.stderr || secondExit.stdout);

                const persistedIndex = JSON.parse(fs.readFileSync(resolveIndexPath(reviewsDir), 'utf8')) as ReviewsIndex;
                assert.ok(persistedIndex.entries.some((entry) => entry.fileName === 'T-001-task-mode.json'));
                assert.ok(persistedIndex.entries.some((entry) => entry.fileName === 'T-002-preflight.json'));
            } finally {
                if (!lockReleased) {
                    releaseFilesystemLock(handle);
                }
                if (firstWorker.exitCode === null) {
                    firstWorker.kill();
                }
                if (secondWorker.exitCode === null) {
                    secondWorker.kill();
                }
            }
        });
    });

    describe('removeEntries', () => {
        it('removes specified entries from index', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-001-preflight.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');
            loadIndex(reviewsDir);

            removeEntries(reviewsDir, ['T-001-task-mode.json', 'T-001-preflight.json']);

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 1);
            assert.equal(index.entries[0].fileName, 'T-002-task-mode.json');
        });

        it('keeps the index fresh after removing deleted artifact entries', () => {
            const firstPath = writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const secondPath = writeArtifact(reviewsDir, 'T-001-preflight.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');
            loadIndex(reviewsDir);

            fs.rmSync(firstPath, { force: true });
            fs.rmSync(secondPath, { force: true });
            removeEntries(reviewsDir, ['T-001-task-mode.json', 'T-001-preflight.json']);

            const indexPath = resolveIndexPath(reviewsDir);
            assert.equal(isIndexStale(indexPath, reviewsDir), false);
            const loaded = loadIndex(reviewsDir);
            assert.equal(loaded.source, 'cache');
            assert.equal(loaded.index.entries.length, 1);
            assert.equal(loaded.index.entries[0].fileName, 'T-002-task-mode.json');
        });

        it('is a no-op when no matching entries exist', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            loadIndex(reviewsDir);

            const indexPath = resolveIndexPath(reviewsDir);
            const before = fs.readFileSync(indexPath, 'utf8');

            removeEntries(reviewsDir, ['T-999-nonexistent.json']);

            const after = fs.readFileSync(indexPath, 'utf8');
            // Index file should not have been rewritten
            assert.equal(before, after);
        });

        it('is a no-op when no index exists', () => {
            // Should not throw
            removeEntries(reviewsDir, ['T-001-task-mode.json']);
        });

        it('handles empty filename array', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            loadIndex(reviewsDir);
            removeEntries(reviewsDir, []);

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 1);
        });
    });

    describe('invalidateIndex', () => {
        it('deletes the index file', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            loadIndex(reviewsDir);

            const indexPath = resolveIndexPath(reviewsDir);
            assert.ok(fs.existsSync(indexPath));

            invalidateIndex(reviewsDir);
            assert.equal(fs.existsSync(indexPath), false);
        });

        it('is a no-op when no index exists', () => {
            invalidateIndex(reviewsDir);
            // Should not throw
        });
    });

    describe('query helpers', () => {
        let index: ReviewsIndex;

        beforeEach(() => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-001-preflight.json');
            writeArtifact(reviewsDir, 'T-001-handshake.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-handshake.json');
            writeArtifact(reviewsDir, 'T-003-compile-gate.json');

            index = loadIndex(reviewsDir).index;
        });

        it('entriesForTask returns entries for one task', () => {
            const t001 = entriesForTask(index, 'T-001');
            assert.equal(t001.length, 3);
            assert.ok(t001.every(e => e.taskId === 'T-001'));

            const t002 = entriesForTask(index, 'T-002');
            assert.equal(t002.length, 2);

            const t999 = entriesForTask(index, 'T-999');
            assert.equal(t999.length, 0);
        });

        it('entriesByArtifactSuffix finds matching entries', () => {
            const handshakes = entriesByArtifactSuffix(index, 'handshake.json');
            assert.equal(handshakes.length, 2);

            const taskModes = entriesByArtifactSuffix(index, 'task-mode.json');
            assert.equal(taskModes.length, 2);

            const compileGates = entriesByArtifactSuffix(index, 'compile-gate.json');
            assert.equal(compileGates.length, 1);

            const nonExistent = entriesByArtifactSuffix(index, 'security-review.md');
            assert.equal(nonExistent.length, 0);
        });

        it('taskIds returns unique task IDs', () => {
            const ids = taskIds(index);
            assert.equal(ids.length, 3);
            assert.ok(ids.includes('T-001'));
            assert.ok(ids.includes('T-002'));
            assert.ok(ids.includes('T-003'));
        });

        it('groupByTask groups correctly', () => {
            const groups = groupByTask(index);
            assert.equal(groups.size, 3);
            assert.equal(groups.get('T-001')?.length, 3);
            assert.equal(groups.get('T-002')?.length, 2);
            assert.equal(groups.get('T-003')?.length, 1);
        });
    });

    describe('retention-aware index refresh', () => {
        it('index reflects state after cleanup invalidation', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.index.entries.length, 2);

            // Simulate cleanup deleting an artifact and invalidating the index
            // (the real cleanup integration calls invalidateIndex after removing files)
            fs.unlinkSync(path.join(reviewsDir, 'T-001-task-mode.json'));
            invalidateIndex(reviewsDir);

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 1);
            assert.equal(second.index.entries[0].taskId, 'T-002');
        });

        it('forceRebuild picks up external changes', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.index.entries.length, 2);

            // External deletion without index notification
            fs.unlinkSync(path.join(reviewsDir, 'T-001-task-mode.json'));

            const second = loadIndex(reviewsDir, { forceRebuild: true });
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 1);
            assert.equal(second.index.entries[0].taskId, 'T-002');
        });

        it('invalidation forces rebuild on next load', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            loadIndex(reviewsDir);
            invalidateIndex(reviewsDir);

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 1);
        });
    });

    describe('edge cases', () => {
        it('handles corrupt index file gracefully', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const indexPath = resolveIndexPath(reviewsDir);
            fs.writeFileSync(indexPath, 'not valid json!!!', 'utf8');

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 1);
        });

        it('handles index with wrong version', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const indexPath = resolveIndexPath(reviewsDir);
            fs.writeFileSync(indexPath, JSON.stringify({
                version: 99,
                directoryMtimeMs: 0,
                generatedAtMs: Date.now(),
                entries: []
            }), 'utf8');

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 1);
        });

        it('rebuilds indexes whose generated timestamp is missing or cannot expire', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const indexPath = resolveIndexPath(reviewsDir);
            const validIndex = rebuildIndex(reviewsDir);
            writeIndex(indexPath, {
                ...validIndex,
                generatedAtMs: Date.now() + 60_000
            });
            assert.equal(loadIndex(reviewsDir).source, 'rebuilt');

            const invalidGeneratedAtValues: Array<number | undefined> = [undefined, -1, 1.5];

            for (const generatedAtMs of invalidGeneratedAtValues) {
                writeIndex(indexPath, {
                    ...validIndex,
                    generatedAtMs
                } as ReviewsIndex);

                const result = loadIndex(reviewsDir);
                assert.equal(result.source, 'rebuilt');
                assert.equal(result.index.entries.length, 1);
            }
        });

        it('handles compressed artifact files (.gz) not being indexed', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-001-preflight.json.gz', 'compressed data');

            const index = rebuildIndex(reviewsDir);
            // .gz files have T-001- prefix but their artifactType includes .gz
            // They should still be indexed since they match the pattern
            const gzEntry = index.entries.find(e => e.fileName === 'T-001-preflight.json.gz');
            assert.ok(gzEntry);
            assert.equal(gzEntry.artifactType, 'preflight.json.gz');
        });

        it('handles many tasks efficiently', () => {
            for (let i = 1; i <= 200; i++) {
                const taskId = `T-${String(i).padStart(3, '0')}`;
                writeArtifact(reviewsDir, `${taskId}-task-mode.json`, `{"task_id":"${taskId}"}`);
                writeArtifact(reviewsDir, `${taskId}-preflight.json`, `{"task_id":"${taskId}"}`);
            }

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 400);

            const ids = taskIds(result.index);
            assert.equal(ids.length, 200);

            // Second load from cache
            const cached = loadIndex(reviewsDir);
            assert.equal(cached.source, 'cache');
            assert.equal(cached.index.entries.length, 400);
        });

        it('upsert to empty directory without prior artifacts', () => {
            const emptyReviewsDir = path.join(tmpDir, 'empty-reviews');
            fs.mkdirSync(emptyReviewsDir, { recursive: true });
            writeArtifact(emptyReviewsDir, 'T-001-task-mode.json');

            upsertEntry(emptyReviewsDir, 'T-001-task-mode.json');

            const indexPath = resolveIndexPath(emptyReviewsDir);
            assert.ok(fs.existsSync(indexPath));
        });
    });
});
