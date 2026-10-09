import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cleanup from '../../../src/lifecycle/cleanup';
import { TaskErasureReadSnapshot } from '../../../src/lifecycle/cleanup/task-erasure-selection';
import { createWip, event, treeSnapshot, writeQueue } from './cleanup-wip-fixtures';

interface ErasurePreview {
    status: 'READY' | 'BLOCKED'; task_ids: string[]; file_count: number; total_bytes: number;
    ownership_digest: string; mutation_authorized: false; full_erasure_complete: false;
    blockers: Array<{ code: string; detail: string; task_id: string | null }>;
    items: Array<{ path: string; task_id: string; bytes: number; sha256: string }>;
    references: Array<{ from_task_id: string; to_task_id: string; kind: string }>;
    shared_operations: string[]; domain: { excluded_local_domains: string[] };
}
const api = cleanup as typeof cleanup & Partial<{
    previewTaskErasure: (options: { targetRoot: string; taskIds: readonly string[] }) => ErasurePreview;
}>;

it('previews one exact child without mutation or claiming full erasure authority', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-erasure-preview-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const queue = ['# Tasks', '', '## Active Queue', '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-901 | DONE | P1 | test | Parent | test | 2026-10-09 | balanced | |',
        '| T-901-1 | DONE | P1 | test | Selected | test | 2026-10-09 | balanced | |', ''].join('\n');
    fs.writeFileSync(path.join(root, 'TASK.md'), queue);
    const reviews = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
    fs.mkdirSync(reviews, { recursive: true });
    const payload = '# T-901-1 report\n';
    fs.writeFileSync(path.join(reviews, 'T-901-1-final-user-report.md'), payload);
    assert.equal(typeof api.previewTaskErasure, 'function', 'exact task-erasure preview backend must be exported');
    const result = api.previewTaskErasure!({ targetRoot: root, taskIds: ['T-901-1'] });
    assert.equal(result.status, 'READY');
    assert.deepEqual(result.task_ids, ['T-901-1']);
    assert.equal(result.file_count, 1);
    assert.equal(result.total_bytes, Buffer.byteLength(payload));
    assert.equal(result.mutation_authorized, false);
    assert.equal(result.full_erasure_complete, false);
    assert.ok(result.domain.excluded_local_domains.includes('internal-recovery-copies'));
    assert.equal(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), queue);
    assert.equal(fs.readFileSync(path.join(reviews, 'T-901-1-final-user-report.md'), 'utf8'), payload);
});

function fixture(t: TestContext, rows = [{ taskId: 'T-901', status: 'DONE', notes: '' }]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-erasure-preview-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeQueue(root, rows);
    return root;
}

function artifact(root: string, relative: string, content = 'selected bytes'): string {
    const file = path.join(root, 'garda-agent-orchestrator/runtime', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function preview(root: string, taskIds: readonly string[] = ['T-901']) {
    return cleanup.previewTaskErasure({ targetRoot: root, taskIds });
}

it('rejects duplicate, invalid, whitespace, case aliases and sparse selections without writes', t => {
    const root = fixture(t), before = treeSnapshot(root);
    const sparse = Array<string>(1);
    const results = [preview(root, []), preview(root, ['T-901', 'T-901']), preview(root, ['../T-901']),
        preview(root, [' T-901']), preview(root, ['T-901', 'T-901'.toLowerCase()]), preview(root, sparse)];
    assert.ok(results.every(result => result.status === 'BLOCKED' && !result.inventory_complete));
    assert.equal(treeSnapshot(root), before);
});

it('blocks unknown and case-ambiguous canonical queue identities', t => {
    const root = fixture(t);
    const unknown = preview(root, ['T-902']);
    writeQueue(root, [{ taskId: 'T-A1', status: 'DONE' }, { taskId: 'T-a1', status: 'DONE' }]);
    const duplicate = preview(root, ['T-A1']);
    assert.ok(unknown.blockers.some(blocker => blocker.code === 'UNKNOWN_TASK' && blocker.task_id === 'T-902'));
    assert.equal(duplicate.status, 'BLOCKED');
});

it('blocks interrupted canonical rows instead of treating malformed survivors as absent', t => {
    const root = fixture(t);
    fs.appendFileSync(path.join(root, 'TASK.md'), '| T-902 | BROKEN |\n');
    const before = treeSnapshot(root), result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.some(blocker => blocker.code === 'OWNERSHIP_UNAVAILABLE'));
    assert.equal(treeSnapshot(root), before);
});

it('does not implicitly select child or similar IDs when previewing a parent', t => {
    const root = fixture(t, [{ taskId: 'T-901', status: 'DONE', notes: '' },
        { taskId: 'T-901-1', status: 'DONE', notes: '' }, { taskId: 'T-9010', status: 'DONE', notes: '' }]);
    const parent = artifact(root, 'reviews/T-901-final-user-report.md', 'parent');
    artifact(root, 'reviews/T-901-1-final-user-report.md', 'child');
    artifact(root, 'reviews/T-9010-final-user-report.md', 'similar');
    const result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(result.task_ids, ['T-901']);
    assert.deepEqual(result.items.map(item => item.path), [path.relative(root, parent).split(path.sep).join('/')]);
    assert.ok(result.references.some(reference => reference.from_task_id === 'T-901-1' && reference.kind === 'child-group'));
    assert.ok(!result.references.some(reference => reference.from_task_id === 'T-9010'));
});

it('previews an exact parent-child group deterministically regardless of selection order', t => {
    const root = fixture(t, [{ taskId: 'T-901', status: 'DONE', notes: 'Child tasks: T-901-1.' },
        { taskId: 'T-901-1', status: 'TODO', notes: 'Parent task: T-901.' }]);
    artifact(root, 'reviews/T-901-final-user-report.md', 'parent');
    artifact(root, 'plans/T-901-1.md', 'child');
    const before = treeSnapshot(root), a = preview(root, ['T-901', 'T-901-1']), b = preview(root, ['T-901-1', 'T-901']);
    assert.equal(a.status, 'READY', JSON.stringify(a.blockers));
    assert.equal(a.file_count, 2);
    assert.equal(a.ownership_digest, b.ownership_digest);
    assert.deepEqual(a.references, []);
    assert.equal(treeSnapshot(root), before);
});

it('blocks surviving dependency and group references while preserving unrelated queue text', t => {
    const root = fixture(t, [{ taskId: 'T-901', status: 'DONE', notes: '' },
        { taskId: 'T-902', status: 'TODO', notes: 'Depends on T-901; grouped follow-up reuses T-901.' }]);
    const before = treeSnapshot(root), result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(result.references, [{ from_task_id: 'T-902', to_task_id: 'T-901', kind: 'queue-reference' }]);
    assert.ok(result.blockers.some(blocker => blocker.code === 'SURVIVING_REFERENCE' && blocker.detail.includes('T-902')));
    assert.equal(treeSnapshot(root), before);
});

it('reports mixed selection activity blockers by exact ID and never authorizes removal', t => {
    const root = fixture(t, [{ taskId: 'T-901', status: 'DONE', notes: '' },
        { taskId: 'T-902', status: 'IN_PROGRESS', notes: '' }, { taskId: 'T-903', status: 'IN_REVIEW', notes: '' }]);
    const result = preview(root, ['T-901', 'T-902', 'T-903']);
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(result.blockers.filter(blocker => blocker.code === 'ACTIVE_TASK').map(blocker => blocker.task_id), ['T-902', 'T-903']);
    assert.equal(result.mutation_authorized, false);
    assert.equal(result.full_erasure_complete, false);
});

it('blocks authenticated stale runtime activity despite a DONE queue status', t => {
    const root = fixture(t);
    event(root, 'T-901', 'TASK_MODE_ENTERED', {});
    const timeline = path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-901.jsonl');
    fs.utimesSync(timeline, new Date(0), new Date(0));
    const before = treeSnapshot(root), result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.some(blocker => blocker.code === 'ACTIVE_TASK' && blocker.task_id === 'T-901'));
    assert.equal(treeSnapshot(root), before);
});

it('blocks unauthenticated completion records instead of trusting forged terminal runtime state', t => {
    const root = fixture(t);
    artifact(root, 'task-events/T-901.jsonl', JSON.stringify({ task_id: 'T-901', event_type: 'COMPLETION_GATE_PASSED' }) + '\n');
    const before = treeSnapshot(root), result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.some(blocker => blocker.code === 'OWNERSHIP_UNAVAILABLE'));
    assert.equal(treeSnapshot(root), before);
});

it('blocks authenticated stale restarts after terminal events until a later terminal event', t => {
    const outcomes: Array<{ restart: string; terminal: string; blocked: boolean; completed: string }> = [];
    for (const restart of ['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED', 'STATUS_CHANGED']) {
        for (const terminal of ['STATUS_CHANGED', 'COMPLETION_GATE_PASSED']) {
            const root = fixture(t);
            event(root, 'T-901', terminal, terminal === 'STATUS_CHANGED' ? { old_status: 'IN_PROGRESS', new_status: 'DONE' } : {});
            event(root, 'T-901', restart, restart === 'STATUS_CHANGED' ? { old_status: 'DONE', new_status: 'IN_PROGRESS' } : {});
            const timeline = path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-901.jsonl');
            fs.utimesSync(timeline, new Date(0), new Date(0));
            const before = treeSnapshot(root), restarted = preview(root);
            assert.equal(treeSnapshot(root), before);
            event(root, 'T-901', terminal, terminal === 'STATUS_CHANGED' ? { old_status: 'IN_PROGRESS', new_status: 'DONE' } : {});
            if (restart === 'STATUS_CHANGED' && terminal === 'COMPLETION_GATE_PASSED') {
                event(root, 'T-901', 'STATUS_CHANGED', { old_status: 'IN_PROGRESS', new_status: 'DONE' });
            }
            fs.utimesSync(timeline, new Date(0), new Date(0));
            const after = treeSnapshot(root), completed = preview(root);
            assert.equal(treeSnapshot(root), after);
            outcomes.push({ restart, terminal, blocked: restarted.status === 'BLOCKED' && !restarted.inventory_complete
                && restarted.blockers.some(blocker => blocker.code === 'ACTIVE_TASK' && blocker.task_id === 'T-901'), completed: completed.status });
        }
    }
    assert.ok(outcomes.every(outcome => outcome.blocked), JSON.stringify(outcomes));
    assert.ok(outcomes.every(outcome => outcome.completed === 'READY'), JSON.stringify(outcomes));
});

it('binds queue statuses, artifact bytes and namespace membership into the ownership digest', t => {
    const root = fixture(t);
    const file = artifact(root, 'reviews/T-901-final-user-report.md', 'first');
    const first = preview(root);
    fs.writeFileSync(file, 'second');
    const bytes = preview(root);
    writeQueue(root, [{ taskId: 'T-901', status: 'TODO' }]);
    const status = preview(root);
    artifact(root, 'plans/T-901.md', 'new member');
    const member = preview(root);
    assert.ok([first, bytes, status, member].every(result => result.status === 'READY'));
    assert.equal(new Set([first, bytes, status, member].map(result => result.ownership_digest)).size, 4);
});

it('rejects queue content drift before completing a read snapshot', t => {
    const root = fixture(t), snapshot = new TaskErasureReadSnapshot(root);
    snapshot.read(path.join(root, 'TASK.md'));
    writeQueue(root, [{ taskId: 'T-901', status: 'IN_PROGRESS' }]);
    assert.throws(() => snapshot.assertCurrent(), /changed/u);
});

it('rejects namespace addition and same-byte physical replacement before completing a read snapshot', t => {
    const root = fixture(t), file = artifact(root, 'reviews/T-901-final-user-report.md');
    const snapshot = new TaskErasureReadSnapshot(root);
    snapshot.captureTree(path.dirname(file));
    fs.renameSync(file, `${file}.saved`);
    fs.copyFileSync(`${file}.saved`, file);
    assert.throws(() => snapshot.assertCurrent(), /identity changed|namespace changed|ownership changed/u);
});

it('blocks selected symlinks without traversing or modifying their outside payload', t => {
    const root = fixture(t), outside = fixture(t);
    const file = artifact(root, 'reviews/T-901-final-user-report.md');
    const payload = path.join(outside, 'outside.md');
    fs.writeFileSync(payload, 'outside protected');
    fs.unlinkSync(file);
    fs.symlinkSync(payload, file);
    const result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(fs.readFileSync(payload, 'utf8'), 'outside protected');
});

it('blocks hard-linked selected artifacts instead of counting them as unshared ownership', t => {
    const root = fixture(t), file = artifact(root, 'reviews/T-901-final-user-report.md');
    fs.linkSync(file, path.join(root, 'shared.md'));
    const before = treeSnapshot(root), result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.some(blocker => blocker.detail.includes('hard-linked')));
    assert.equal(treeSnapshot(root), before);
});

it('blocks unreadable namespaces instead of returning an empty complete inventory', t => {
    const root = fixture(t), file = artifact(root, 'reviews/T-901-final-user-report.md');
    const original = fs.opendirSync;
    t.mock.method(fs, 'opendirSync', (...args: Parameters<typeof fs.opendirSync>) => {
        const [candidate] = args;
        if (String(candidate) === path.dirname(file)) throw Object.assign(new Error('Preview fixture permission denial'), { code: 'EACCES' });
        return original(...args);
    });
    const result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.some(blocker => blocker.detail.includes('permission denial')));
});

it('blocks case-aliased files and empty unknown selected directories instead of silently omitting them', t => {
    const root = fixture(t);
    artifact(root, 'reviews/t-901-final-user-report.md');
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-901-unknown.json'));
    const before = treeSnapshot(root), result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.some(blocker => blocker.code === 'UNRESOLVED_ARTIFACT' && blocker.detail.includes('t-901-final-user-report')));
    assert.ok(result.blockers.some(blocker => blocker.code === 'UNRESOLVED_ARTIFACT' && blocker.detail.includes('T-901-unknown.json')));
    assert.equal(treeSnapshot(root), before);
});

it('blocks unknown selected artifact formats and inconsistent embedded review ownership', t => {
    const root = fixture(t);
    artifact(root, 'plans/T-901-task-plan.json', '{"task_id":"T-901"}');
    artifact(root, 'reviews/T-901-preflight.json', '{"task_id":"T-902"}');
    const before = treeSnapshot(root), result = preview(root);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.some(blocker => blocker.code === 'UNRESOLVED_ARTIFACT'));
    assert.equal(result.file_count, 0);
    assert.equal(treeSnapshot(root), before);
});

it('previews shared operations while preserving source, settings, durable knowledge and unrelated evidence', t => {
    const root = fixture(t);
    artifact(root, 'reviews/T-901-final-user-report.md');
    artifact(root, 'reviews/T-902-final-user-report.md', 'other task');
    artifact(root, 'reviews/reviews-index.json', '{"entries":[]}');
    artifact(root, 'task-events/all-tasks.jsonl', '{"task_id":"T-901"}\n{"task_id":"T-902"}\n');
    artifact(root, 'metrics.jsonl', '{"task_id":"T-901"}\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/owned.ts'), 'source');
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator/live/docs/project-memory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'garda-agent-orchestrator/live/docs/project-memory/README.md'), 'durable knowledge');
    fs.writeFileSync(path.join(root, 'garda-agent-orchestrator/live/settings.json'), 'settings');
    const before = treeSnapshot(root), result = preview(root);
    assert.equal(result.status, 'READY', JSON.stringify(result.blockers));
    assert.equal(result.file_count, 1);
    assert.ok(result.shared_operations.includes('invalidate-reviews-index'));
    assert.ok(result.shared_operations.includes('prune-selected-shared-runtime-records'));
    assert.deepEqual(result.composition.required_domains, ['internal-recovery-copies']);
    assert.equal(treeSnapshot(root), before);
});

it('includes authenticated retired WIP without performing its separate removal operation', t => {
    const root = fixture(t, [{ taskId: 'T-CLEAN-1', status: 'DONE', notes: '' }]);
    const wip = createWip(root);
    event(root, 'T-CLEAN-1', 'STATUS_CHANGED', { old_status: 'IN_PROGRESS', new_status: 'DONE' });
    const before = treeSnapshot(root), result = preview(root, ['T-CLEAN-1']);
    assert.equal(result.status, 'READY', JSON.stringify(result.blockers));
    assert.equal(result.wip?.packages[0].classification, 'retired-orphan');
    assert.ok(result.file_count >= result.wip!.file_count);
    assert.ok(fs.existsSync(wip.manifestPath));
    assert.equal(treeSnapshot(root), before);
});

it('blocks WIP required by a surviving unfinished task and preserves all package bytes', t => {
    const root = fixture(t, [{ taskId: 'T-CLEAN-1', status: 'DONE', notes: '' }]);
    const wip = createWip(root, { retired: false });
    writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, { taskId: 'T-SURVIVE', status: 'TODO', notes: '' }]);
    event(root, 'T-SURVIVE', 'SPLIT_REQUIRED_WIP_CAPTURED', { manifest_path: wip.manifestPath });
    const before = treeSnapshot(root), result = preview(root, ['T-CLEAN-1']);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.some(blocker => blocker.code === 'REFERENCED_WIP' || blocker.code === 'WIP_OWNERSHIP'));
    assert.equal(treeSnapshot(root), before);
});
