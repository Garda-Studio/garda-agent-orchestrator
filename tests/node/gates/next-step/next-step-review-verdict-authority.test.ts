import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';

import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import { resolveExpectedReviewVerdicts } from '../../../../src/gates/required-reviews/required-reviews-check';
import { readReviewArtifactState } from '../../../../src/gates/next-step/next-step-review-artifact-readers';

const TASK_ID = 'T-100';
const CUSTOM_LANE = 'architecture-boundary';

function makeWorkspace(context: TestContext, laneId = CUSTOM_LANE, enabled = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-verdict-authority-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalog = normalizeReviewCatalog({
        version: 1,
        custom_review_types: [{
            id: laneId,
            display_label: 'Architecture boundary',
            enabled_by_default: false,
            skill_id: 'architecture-review',
            trigger: { mode: 'manual' },
            coverage_category_ids: ['maintainability'],
            reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
        }]
    }, { knownSkillIds: ['architecture-review'] });
    const capabilities = Object.fromEntries(catalog.review_types.map(lane => [lane.id, true])) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy('balanced', { code: true, [laneId]: enabled }, capabilities, catalog);
    const snapshot = buildEffectiveReviewSnapshot({
        catalog, profilePolicy, profileSnapshotSha256: 'a'.repeat(64),
        legacyRequiredReviews: { code: true }, scopeCategory: 'code',
        taskIntent: 'Read workspace review verdict authority',
        changedFiles: ['src/gates/next-step/next-step-review-artifact-readers.ts'], taskTriggers: {}
    });
    const reviewsRoot = path.join(root, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    const preflight: Record<string, unknown> = { task_id: TASK_ID, required_reviews: snapshot.required_reviews, effective_review_snapshot: snapshot };
    return { root, reviewsRoot, preflightPath, preflight };
}

function readState(workspace: ReturnType<typeof makeWorkspace>, reviewType = CUSTOM_LANE) {
    const bytes = JSON.stringify(workspace.preflight, null, 2) + '\n';
    fs.writeFileSync(workspace.preflightPath, bytes);
    return readReviewArtifactState(
        workspace.reviewsRoot, TASK_ID, reviewType, workspace.preflightPath,
        createHash('sha256').update(bytes).digest('hex'), workspace.preflight, workspace.root
    );
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalize(record[key])]));
}

function mutableSnapshot(workspace: ReturnType<typeof makeWorkspace>) {
    const snapshot = JSON.parse(JSON.stringify(workspace.preflight.effective_review_snapshot));
    workspace.preflight.effective_review_snapshot = snapshot;
    return snapshot;
}

function rehashSnapshot(snapshot: Record<string, unknown>): void {
    const { snapshot_sha256: ignored, ...body } = snapshot;
    void ignored;
    snapshot.snapshot_sha256 = createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

test('reader takes custom pass and fail tokens from its immutable workspace snapshot', context => {
    const workspace = makeWorkspace(context);
    const state = readState(workspace);
    assert.equal(state.passToken, 'ARCHITECTURE BOUNDARY REVIEW PASSED');
    assert.equal(state.failToken, 'ARCHITECTURE BOUNDARY REVIEW FAILED');
    assert.equal(state.ready, false);
    assert.deepEqual(state.violations, ['review context artifact is missing', 'review artifact is missing', 'review receipt is missing']);
});

test('reader remains workspace-local after mutable verdict contracts are resolved for another workspace', context => {
    const first = makeWorkspace(context);
    const second = makeWorkspace(context, 'runtime-boundary');
    resolveExpectedReviewVerdicts({ 'runtime-boundary': true });
    assert.equal(readState(first).passToken, 'ARCHITECTURE BOUNDARY REVIEW PASSED');
    assert.equal(readState(second, 'runtime-boundary').passToken, 'RUNTIME BOUNDARY REVIEW PASSED');
    resolveExpectedReviewVerdicts({ [CUSTOM_LANE]: true });
    assert.equal(readState(second, 'runtime-boundary').failToken, 'RUNTIME BOUNDARY REVIEW FAILED');
    assert.equal(readState(first).passToken, 'ARCHITECTURE BOUNDARY REVIEW PASSED');
    resolveExpectedReviewVerdicts({ code: true });
});

test('known custom tokens cannot substitute for missing review context or receipt', context => {
    const workspace = makeWorkspace(context);
    const artifactPath = path.join(workspace.reviewsRoot, `${TASK_ID}-${CUSTOM_LANE}.md`);
    fs.writeFileSync(artifactPath, 'ARCHITECTURE BOUNDARY REVIEW PASSED\n');
    const state = readState(workspace);
    assert.equal(state.verdictToken, 'ARCHITECTURE BOUNDARY REVIEW PASSED');
    assert.equal(state.ready, false);
    assert.equal(state.receiptContractCurrent, false);
    assert.ok(state.violations.includes('review context artifact is missing'));
    assert.ok(state.violations.includes('review receipt is missing'));
});

test('reader recognizes a custom failed artifact without losing missing-evidence blockers', context => {
    const workspace = makeWorkspace(context);
    fs.writeFileSync(path.join(workspace.reviewsRoot, `${TASK_ID}-${CUSTOM_LANE}.md`), 'ARCHITECTURE BOUNDARY REVIEW FAILED\n');
    const state = readState(workspace);
    assert.equal(state.failed, true);
    assert.equal(state.verdictToken, 'ARCHITECTURE BOUNDARY REVIEW FAILED');
    assert.equal(state.ready, false);
});

for (const [label, mutate, diagnostic] of [
    ['bad snapshot hash', (w: ReturnType<typeof makeWorkspace>) => { mutableSnapshot(w).snapshot_sha256 = 'b'.repeat(64); }, /snapshot hash mismatch/],
    ['null snapshot', (w: ReturnType<typeof makeWorkspace>) => { w.preflight.effective_review_snapshot = null; }, /snapshot must be a JSON object/],
    ['required-lane drift', (w: ReturnType<typeof makeWorkspace>) => { w.preflight.required_reviews = { ...(w.preflight.required_reviews as Record<string, boolean>), [CUSTOM_LANE]: false }; }, /does not match immutable lane selection/],
    ['noncanonical custom tokens', (w: ReturnType<typeof makeWorkspace>) => { const s = mutableSnapshot(w); s.lanes.find((lane: {id: string}) => lane.id === CUSTOM_LANE).definition.verdict_tokens.pass = 'FOREIGN REVIEW PASSED'; rehashSnapshot(s); }, /not the generated canonical tokens/]
] as const) {
    test(`reader fails closed for ${label} without falling back to global contracts`, context => {
        const workspace = makeWorkspace(context);
        mutate(workspace);
        const state = readState(workspace);
        assert.equal(state.passToken, '');
        assert.equal(state.failToken, '');
        assert.equal(state.ready, false);
        assert.ok(state.violations.some(violation => diagnostic.test(violation)), state.violations.join('\n'));
    });
}

test('reader rejects inactive and foreign custom lanes even when another workspace selects them', context => {
    const disabled = makeWorkspace(context, CUSTOM_LANE, false);
    const foreign = makeWorkspace(context, 'runtime-boundary');
    assert.equal(readState(disabled).passToken, '');
    assert.match(readState(disabled).violations.join('\n'), /inactive in the immutable/);
    assert.equal(readState(foreign).passToken, '');
    assert.match(readState(foreign).violations.join('\n'), /unknown to the effective review lane set|unknown to the immutable effective review snapshot/);
});

test('reader preserves legacy built-in tokens and rejects custom lanes without immutable authority', context => {
    const workspace = makeWorkspace(context);
    delete workspace.preflight.effective_review_snapshot;
    workspace.preflight.required_reviews = { code: true, security: true };
    assert.equal(readState(workspace, 'code').passToken, 'REVIEW PASSED');
    assert.equal(readState(workspace, 'code').failToken, 'CODE REVIEW FAILED');
    assert.equal(readState(workspace, 'security').passToken, 'SECURITY REVIEW PASSED');
    assert.equal(readState(workspace).passToken, '');
    assert.match(readState(workspace).violations.join('\n'), /unknown to the effective review lane set/);
});

test('invalid present snapshots cannot fall back to built-in compatibility', context => {
    const workspace = makeWorkspace(context);
    mutableSnapshot(workspace).snapshot_sha256 = 'b'.repeat(64);
    const state = readState(workspace, 'code');
    assert.equal(state.passToken, '');
    assert.equal(state.ready, false);
    assert.match(state.violations.join('\n'), /snapshot hash mismatch/);
});

test('legacy custom required flags cannot authorize a built-in or custom consumer', context => {
    const workspace = makeWorkspace(context);
    delete workspace.preflight.effective_review_snapshot;
    workspace.preflight.required_reviews = { code: true, [CUSTOM_LANE]: true };
    for (const reviewType of ['code', CUSTOM_LANE]) {
        const state = readState(workspace, reviewType);
        assert.equal(state.passToken, '');
        assert.equal(state.ready, false);
        assert.match(state.violations.join('\n'), /cannot authorize custom required review ids/);
    }
});
