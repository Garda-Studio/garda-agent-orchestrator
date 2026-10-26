/** Storage tests. Uses native append, integrity, Git, authentication and transactions.
 * Source facts are unit inputs; real record/reuse/A8 ownership stays in the Q1 integration tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendMandatoryTaskEvent, inspectTaskEventFile, readTaskEventAppendState } from '../../../../src/gate-runtime/task-events';
import { joinOrchestratorPath } from '../../../../src/core/orchestrator-paths';
import { normalizeReviewCycleGuardConfig } from '../../../../src/core/review-cycle-guard';
import { closedReviewPaths, publishClosedReviewHistory, readClosedReviewHistory, CLOSED_REVIEW_PUBLICATION_EVENT,
    type VerifiedClosedReviewQuery, type ClosedReviewPublication, type PublishClosedReviewInput } from '../../../../src/gates/review-attempts/review-closed-cycle-storage';
import { makeClosedReviewBinding } from '../../../../src/gates/review-attempts/review-closed-cycle-gate-hooks';
import { closedReviewDigest, resolveClosedReviewAuthentication, encodeClosedReviewEnvelope, decodeClosedReviewEnvelope } from '../../../../src/gates/review-attempts/review-closed-cycle-auth';
import type { ValidatedReviewOutcome } from '../../../../src/gates/review-attempts/review-closed-cycle-summary';

function fixture(t: { after(fn: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-closed-summary-'));
    execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const taskId = 'T-closed-unit', bundle = joinOrchestratorPath(root, '');
    const timeline = path.join(bundle, 'runtime/task-events', taskId + '.jsonl');
    const facts = new Map<string, ValidatedReviewOutcome>();
    let bootstraps = 0;
    const config = normalizeReviewCycleGuardConfig({ max_failed_non_test_reviews: 3 });
    function query(): VerifiedClosedReviewQuery {
        const events: Array<Record<string, unknown>> = [];
        const inspection = inspectTaskEventFile(timeline, taskId, { onIntegrityEvent: event => events.push(event as Record<string, unknown>) });
        assert.ok(['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status));
        assert.deepEqual(inspection.violations, []);
        let source: VerifiedClosedReviewQuery['source'] | null = null;
        let sourceEventType: VerifiedClosedReviewQuery['sourceEventType'] = 'PREFLIGHT_CLASSIFIED';
        let latestReview: VerifiedClosedReviewQuery['latestReview'] = null, previousReview: VerifiedClosedReviewQuery['previousReview'] = null;
        let latestPublication: ClosedReviewPublication | null = null;
        const relevantHashes: string[] = [];
        events.forEach((event, lineOrdinal) => {
            const sha256 = String((event.integrity as Record<string, unknown>).event_sha256);
            if (event.event_type === CLOSED_REVIEW_PUBLICATION_EVENT) {
                latestPublication = { eventSha256: sha256, lineOrdinal, actor: 'orchestrator', outcome: 'PASS', taskId,
                    details: JSON.parse(JSON.stringify(event.details)) as ClosedReviewPublication['details'] };
                return;
            }
            if (!['REVIEW_RECORDED', 'PREFLIGHT_CLASSIFIED', 'REVIEW_CYCLE_RESTARTED'].includes(String(event.event_type))) return;
            source = { sha256, lineOrdinal }; sourceEventType = event.event_type as VerifiedClosedReviewQuery['sourceEventType'];
            relevantHashes.push(sha256);
            if (event.event_type === 'REVIEW_RECORDED') { previousReview = latestReview; latestReview = source; }
        });
        assert.ok(source);
        return { timelineValid: true, taskId, source, sourceEventType, latestReview, previousReview, latestPublication,
            semanticQuerySha256: closedReviewDigest(JSON.stringify(relevantHashes)), appendState: readTaskEventAppendState(timeline, taskId) };
    }
    function append(type: 'PREFLIGHT_CLASSIFIED' | 'REVIEW_RECORDED' | 'REVIEW_CYCLE_RESTARTED', failed = false, identity = 'agent:one') {
        const admitted = appendMandatoryTaskEvent(bundle, taskId, type, type === 'PREFLIGHT_CLASSIFIED' ? 'INFO' : 'PASS', 'Unit source', {}, { actor: 'orchestrator' });
        if (type === 'REVIEW_RECORDED') {
            const head = query();
            facts.set(admitted.integrity!.event_sha256!, { reviewType: 'code', reviewerIdentity: identity, reviewContextSha256: 'c'.repeat(64),
                eventSha256: head.source.sha256, lineOrdinal: head.source.lineOrdinal, failed, passed: !failed, reused: false,
                scopeHash: 'a'.repeat(64), cadenceFailed: failed, latestFailedDisplay: { review_type: 'code', event_type: type,
                    outcome: 'PASS', verdict_token: failed ? 'CODE REVIEW FAILED' : 'CODE REVIEW PASSED', reviewer_identity: identity,
                    review_artifact_path: 'unused-unit-report.md', summary: null, sequence: head.source.lineOrdinal, timestamp_utc: null } });
        }
    }
    function input(): PublishClosedReviewInput {
        const current = query(), auth = resolveClosedReviewAuthentication(root, true);
        const binding = makeClosedReviewBinding({ taskId, repoRealpath: auth.repoRealpath, gitDirectoryRealpath: auth.gitDirectoryRealpath,
            producerBundleSha256: 'b'.repeat(64), producerPolicySha256: 'd'.repeat(64), taskModeBytes: Buffer.from('mode'),
            preflightBytes: Buffer.from('preflight'), config, fingerprints: null,
            restartEventSha256: current.sourceEventType === 'REVIEW_CYCLE_RESTARTED' ? current.source.sha256 : null, query: current });
        return { repoRoot: root, binding, query: current, config, fingerprints: null,
            validateSource: () => current.sourceEventType === 'REVIEW_RECORDED' ? facts.get(current.source.sha256)! : null,
            bootstrap: () => { bootstraps++; return [...facts.values()]; }, assertInputsCurrent: () => {} };
    }
    const read = () => { const current = input(); return readClosedReviewHistory({ ...current, validateCurrentReferences: () => true }); };
    append('PREFLIGHT_CLASSIFIED');
    return { root, taskId, bundle, timeline, append, query, input, read, bootstraps: () => bootstraps };
}

test('native publication incrementally reduces admitted failure, duplicate pass, and restart', t => {
    const f = fixture(t);
    publishClosedReviewHistory(f.input());
    assert.equal(f.bootstraps(), 1);
    f.append('REVIEW_RECORDED', true); publishClosedReviewHistory(f.input());
    f.append('REVIEW_RECORDED', false); publishClosedReviewHistory(f.input());
    f.append('REVIEW_CYCLE_RESTARTED'); publishClosedReviewHistory(f.input());
    assert.equal(f.bootstraps(), 1);
    const result = f.read()!;
    assert.equal(result.evaluation.total_non_test_review_count, 1);
    assert.equal(result.evaluation.failed_non_test_review_count, 1);
    assert.equal(result.evaluation.should_block, false);
    const before = fs.readFileSync(f.timeline);
    assert.equal(publishClosedReviewHistory(f.input()), null);
    assert.deepEqual(fs.readFileSync(f.timeline), before, 'same source/query publication is idempotent');
});

test('navigation never needs cumulative-state bytes and still checks current references', t => {
    const f = fixture(t); f.append('REVIEW_RECORDED', true); publishClosedReviewHistory(f.input());
    const paths = closedReviewPaths(f.root, f.taskId);
    fs.unlinkSync(paths.state);
    assert.equal(f.read()!.evaluation.failed_non_test_review_count, 1);
    const current = f.input();
    assert.equal(readClosedReviewHistory({ ...current, validateCurrentReferences: () => false }), null);
    const changed = { ...current, binding: { ...current.binding, normalized_guard_config_sha256: 'f'.repeat(64) } };
    assert.equal(readClosedReviewHistory({ ...changed, validateCurrentReferences: () => true }), null);
});

test('unsigned forgery cannot become authority by changing the unkeyed publication hash', t => {
    const f = fixture(t); f.append('REVIEW_RECORDED', true); publishClosedReviewHistory(f.input());
    const paths = closedReviewPaths(f.root, f.taskId), current = f.input();
    const envelope = JSON.parse(fs.readFileSync(paths.navigation, 'utf8')) as { payload: string };
    const payload = JSON.parse(envelope.payload);
    payload.result.evaluation.failed_non_test_review_count = 0;
    envelope.payload = JSON.stringify(payload);
    const forged = Buffer.from(JSON.stringify(envelope)); fs.writeFileSync(paths.navigation, forged);
    current.query.latestPublication!.details.navigation_sha256 = closedReviewDigest(forged);
    assert.equal(readClosedReviewHistory({ ...current, validateCurrentReferences: () => true }), null);
});

test('producer-only bootstrap repairs malformed state; read path does not bootstrap', t => {
    const f = fixture(t); f.append('REVIEW_RECORDED', true); publishClosedReviewHistory(f.input());
    fs.writeFileSync(closedReviewPaths(f.root, f.taskId).state, '{malformed');
    assert.ok(f.read()); assert.equal(f.bootstraps(), 1);
    f.append('REVIEW_RECORDED', false, 'agent:two'); publishClosedReviewHistory(f.input());
    assert.equal(f.bootstraps(), 2);
    assert.equal(f.read()!.evaluation.total_non_test_review_count, 2);
});

test('post-write native EPERM preserves both old artifacts and the original error object', t => {
    const f = fixture(t); publishClosedReviewHistory(f.input());
    const paths = closedReviewPaths(f.root, f.taskId), state = fs.readFileSync(paths.state), navigation = fs.readFileSync(paths.navigation);
    f.append('REVIEW_RECORDED', true);
    const current = f.input(), native = Object.assign(new Error('unit native denial'), { code: 'EPERM' });
    let checks = 0;
    current.assertInputsCurrent = () => { if (++checks === 2) throw native; };
    assert.throws(() => publishClosedReviewHistory(current), error => error === native);
    assert.deepEqual(fs.readFileSync(paths.state), state); assert.deepEqual(fs.readFileSync(paths.navigation), navigation);
    assert.equal(f.read(), null, 'old publication cannot cover new source');
    publishClosedReviewHistory(f.input()); assert.equal(f.read()!.evaluation.failed_non_test_review_count, 1);
});

test('replayed old projection and a concurrently appended canonical source fail closed', t => {
    const f = fixture(t); publishClosedReviewHistory(f.input());
    const old = fs.readFileSync(closedReviewPaths(f.root, f.taskId).navigation);
    f.append('REVIEW_RECORDED', true); publishClosedReviewHistory(f.input());
    fs.writeFileSync(closedReviewPaths(f.root, f.taskId).navigation, old);
    assert.equal(f.read(), null);
    const stale = f.input(); f.append('REVIEW_CYCLE_RESTARTED');
    assert.throws(() => publishClosedReviewHistory(stale));
    assert.equal(f.read(), null);
});

test('HMAC is worktree-bound and domain-separated for cadence and guard navigation', t => {
    const one = fixture(t), two = fixture(t);
    const auth = resolveClosedReviewAuthentication(one.root, true), foreign = resolveClosedReviewAuthentication(two.root, true);
    const bytes = encodeClosedReviewEnvelope(auth, 'cadence', { task_id: one.taskId, cadence_failed: true });
    assert.deepEqual(decodeClosedReviewEnvelope(auth, 'cadence', bytes), { task_id: one.taskId, cadence_failed: true });
    assert.throws(() => decodeClosedReviewEnvelope(auth, 'navigation', bytes));
    assert.throws(() => decodeClosedReviewEnvelope(foreign, 'cadence', bytes));
});
