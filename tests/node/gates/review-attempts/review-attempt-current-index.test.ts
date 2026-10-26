import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createCurrentReviewAttemptArtifactIndex, createReviewAttemptArtifactIndex } from '../../../../src/gates/review-attempts/review-attempt-artifact-index';
import { EXACT_CURRENT_REVIEW_INDEX_MARKER, loadTaskIndex, rebuildIndex, resolveIndexPath, writeIndex,
    withTaskIndexReadSnapshot, type ReviewsIndex } from '../../../../src/gate-runtime/reviews-index';
import { withReviewArtifactTransactionLock } from '../../../../src/gate-runtime/review-artifacts';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';

const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-current-index-'));
    const reviewsRoot = path.join(root, 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const taskId = 'T-1';
    const bytes = JSON.stringify({ task_id: taskId, review_type: 'code', review_artifact_sha256: 'a'.repeat(64) });
    const digest = createHash('sha256').update(bytes).digest('hex');
    const fileName = `${taskId}-code-receipt-${digest}.json`;
    const filePath = path.join(reviewsRoot, fileName);
    fs.writeFileSync(filePath, bytes);
    return { root, reviewsRoot, taskId, bytes, digest, fileName, filePath };
}
function customPreflight(reviewTypeId: string): Record<string, unknown> {
    const catalog = normalizeReviewCatalog({ version: 1, custom_review_types: [{ id: reviewTypeId,
        display_label: 'Architecture review', enabled_by_default: false, skill_id: 'architecture-review',
        trigger: { mode: 'manual' }, coverage_category_ids: ['maintainability'],
        reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] } }] },
    { knownSkillIds: ['architecture-review'] });
    const capabilities = Object.fromEntries(catalog.review_types.map(definition => [definition.id, true])) as ReviewCapabilitiesConfigMap;
    const snapshot = buildEffectiveReviewSnapshot({ catalog,
        profilePolicy: resolveProfileReviewCatalogPolicy('balanced', { [reviewTypeId]: true }, capabilities, catalog),
        profileSnapshotSha256: 'a'.repeat(64), legacyRequiredReviews: { code: true }, scopeCategory: 'code',
        taskIntent: 'Architecture change', changedFiles: ['src/architecture.ts'], taskTriggers: {} });
    return { task_id: 'T-1', required_reviews: snapshot.required_reviews, effective_review_snapshot: snapshot };
}

test('current index uses native rebuilt membership without a full review-directory scan', () => {
    const value = fixture();
    try {
        const expected = createReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)
            .readJsonSnapshot(value.filePath, value.fileName, value.digest);
        assert.equal(expected.valid, true);
        const original = nativeFs.readdirSync;
        nativeFs.readdirSync = ((target: fs.PathLike, ...args: unknown[]) => {
            assert.notEqual(path.resolve(String(target)), path.resolve(value.reviewsRoot), 'No full review-directory scan is allowed.');
            return Reflect.apply(original, nativeFs, [target, ...args]);
        }) as typeof fs.readdirSync;
        try {
            assert.deepEqual(withInvocationReadObservation(() => createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)!
                .readJsonSnapshot(value.filePath, value.fileName, value.digest)), expected);
        } finally { nativeFs.readdirSync = original; }
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('valid self-consistent cache omission preserves the old rejection and vetoes the current fast path', () => {
    const value = fixture();
    try {
        const index = rebuildIndex(value.reviewsRoot);
        index.entries = index.entries.filter(entry => entry.fileName !== value.fileName);
        index.directoryUnindexedEntryCount = (index.directoryUnindexedEntryCount || 0) + 1;
        writeIndex(resolveIndexPath(value.reviewsRoot), index); // Recomputes digest and native self-write marker.
        assert.equal(loadTaskIndex(value.reviewsRoot, value.taskId).source, 'cache');
        assert.equal(createReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)
            .readJsonSnapshot(value.filePath, value.fileName, value.digest).valid, false);
        assert.equal(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId), null);
        // Unconditional direct lookup would change rejection to acceptance. It is forbidden.
        fs.writeFileSync(resolveIndexPath(value.reviewsRoot), EXACT_CURRENT_REVIEW_INDEX_MARKER);
        assert.equal(loadTaskIndex(value.reviewsRoot, value.taskId).source, 'rebuilt');
        const rebuilt = createReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)
            .readJsonSnapshot(value.filePath, value.fileName, value.digest);
        assert.equal(rebuilt.valid, true);
        assert.deepEqual(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)!
            .readJsonSnapshot(value.filePath, value.fileName, value.digest), rebuilt);
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('duplicate and corrupt derived caches retain native rebuild behavior; only exact marker enables direct reads', () => {
    const value = fixture();
    try {
        for (const corrupt of ['duplicate', 'hash'] as const) {
            const index: ReviewsIndex = rebuildIndex(value.reviewsRoot);
            if (corrupt === 'duplicate') {
                index.entries.push({ ...index.entries[0] });
                index.directoryEntryCount = index.entries.length;
                index.directoryUnindexedEntryCount = 0;
            }
            writeIndex(resolveIndexPath(value.reviewsRoot), index);
            if (corrupt === 'hash') {
                const invalid = JSON.parse(fs.readFileSync(resolveIndexPath(value.reviewsRoot), 'utf8')) as ReviewsIndex;
                invalid.entries_sha256 = '0'.repeat(64);
                fs.writeFileSync(resolveIndexPath(value.reviewsRoot), JSON.stringify(invalid));
            }
            assert.equal(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId), null);
            assert.equal(loadTaskIndex(value.reviewsRoot, value.taskId).source, 'rebuilt');
            assert.equal(createReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)
                .readJsonSnapshot(value.filePath, value.fileName, value.digest).valid, true);
        }
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('current reader keeps custom lane authority and overlapping task interpretation', () => {
    const value = fixture();
    try {
        const bytes = JSON.stringify({ task_id: value.taskId, review_type: 'architecture-code' });
        const digest = createHash('sha256').update(bytes).digest('hex');
        const name = `${value.taskId}-architecture-code-receipt-${digest}.json`;
        fs.writeFileSync(path.join(value.reviewsRoot, name), bytes);
        const read = () => createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)!
            .readJsonSnapshot(name, name, digest);
        assert.equal(read().valid, false, 'The task argument alone cannot authorize a custom lane.');
        fs.writeFileSync(path.join(value.reviewsRoot, `${value.taskId}-preflight.json`), JSON.stringify(customPreflight('architecture-code')));
        fs.writeFileSync(path.join(value.reviewsRoot, `${value.taskId}-architecture-preflight.json`),
            JSON.stringify({ task_id: `${value.taskId}-architecture`, required_reviews: { code: true } }));
        const expected = createReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId).readJsonSnapshot(name, name, digest);
        assert.equal(expected.valid, true);
        assert.deepEqual(read(), expected);
        assert.equal(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, `${value.taskId}-architecture`)!
            .readJsonSnapshot(name, name, digest).valid, false, 'Own task_id disambiguates overlapping interpretations.');
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(read().valid, true);
            fs.appendFileSync(path.join(value.reviewsRoot, `${value.taskId}-preflight.json`), ' ');
        }), /Invocation file observation changed/u);
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('current reader rejects wrong filename, missing/replaced bytes and a same-byte symlink', context => {
    const value = fixture();
    try {
        const reader = createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)!;
        assert.equal(reader.readJsonSnapshot(value.filePath, `../${value.fileName}`, value.digest).valid, false);
        assert.equal(reader.readJsonSnapshot(value.filePath, `T-2-code-receipt-${value.digest}.json`, value.digest).valid, false);
        assert.equal(reader.readJsonSnapshot(value.filePath, value.fileName, value.digest).valid, true);
        fs.writeFileSync(value.filePath, '{}');
        assert.equal(reader.readJsonSnapshot(value.filePath, value.fileName, value.digest).valid, false);
        fs.unlinkSync(value.filePath);
        assert.equal(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)!
            .readJsonSnapshot(value.filePath, value.fileName, value.digest).valid, false);
        const target = path.join(value.root, 'same-bytes.json');
        fs.writeFileSync(target, value.bytes);
        try { fs.symlinkSync(target, value.filePath, 'file'); }
        catch (error: unknown) {
            if (['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) {
                context.diagnostic('Native symlink creation unavailable; prior path cases still exercised.');
                return;
            }
            throw error;
        }
        assert.equal(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)!
            .readJsonSnapshot(value.filePath, value.fileName, value.digest).valid, false);
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('active transaction and loaded task-index snapshots require the native membership path', () => {
    const value = fixture();
    try {
        withReviewArtifactTransactionLock(value.reviewsRoot, () =>
            assert.equal(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId), null));
        withTaskIndexReadSnapshot(value.reviewsRoot, value.taskId, () => {
            loadTaskIndex(value.reviewsRoot, value.taskId);
            assert.equal(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId), null);
        });
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)!
                .readJsonSnapshot(value.filePath, value.fileName, value.digest).valid, true);
            writeIndex(resolveIndexPath(value.reviewsRoot), rebuildIndex(value.reviewsRoot));
        }), /Invocation file observation changed/u);
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('Windows case-insensitive aliases cannot synthesize exact stored catalog membership', { skip: process.platform !== 'win32' }, () => {
    const value = fixture();
    try {
        const actualName = value.fileName.replace('-code-', '-CODE-');
        fs.renameSync(value.filePath, path.join(value.reviewsRoot, actualName));
        assert.equal(fs.existsSync(value.filePath), true, 'The fixture must use a case-insensitive directory.');
        const native = createReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)
            .readJsonSnapshot(value.filePath, value.fileName, value.digest);
        assert.equal(native.valid, false);
        assert.deepEqual(createCurrentReviewAttemptArtifactIndex(value.reviewsRoot, value.taskId)!
            .readJsonSnapshot(value.filePath, value.fileName, value.digest), native);
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
