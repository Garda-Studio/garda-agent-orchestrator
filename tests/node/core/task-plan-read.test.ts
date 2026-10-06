import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import {
    TASK_PLAN_READ_MAX_BYTES, listTaskPlans, readTaskPlan, resolveCanonicalTaskPlanPath
} from '../../../src/core/task-plan-read';
import { serializeTaskPlan, validateTaskPlan } from '../../../src/schemas/task-plan';

function workspace(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-plan-read-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function plan(taskId: string, status = 'draft'): Record<string, unknown> {
    return {
        schema_version: 1, task_id: taskId, status, goal: 'Read the plan',
        scope_files: ['src/widget.ts'], risk_level: 'low',
        steps: [{ id: 'a', title: 'Read' }]
    };
}

function writePlan(root: string, taskId: string, text: string): string {
    const file = resolveCanonicalTaskPlanPath(root, taskId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
}

test('task-plan reader distinguishes missing, draft, approved and invalid without rewriting JSON', t => {
    const root = workspace(t);
    assert.equal(readTaskPlan(root, 'T-001').state, 'missing');
    assert.equal(fs.readdirSync(root).length, 0, 'Missing inspection must not create directories.');
    const original = JSON.stringify({ ...plan('T-001'), custom_metadata: { keep: true } }, null, 4) + '\r\n';
    const file = writePlan(root, 'T-001', original);
    const result = readTaskPlan(root, 'T-001');
    assert.equal(result.state, 'draft');
    assert.equal(result.content, original);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    writePlan(root, 'T-002', serializeTaskPlan(validateTaskPlan(plan('T-002', 'approved'))));
    assert.equal(readTaskPlan(root, 'T-002').state, 'ready');
    writePlan(root, 'T-003', '{ broken');
    const invalid = readTaskPlan(root, 'T-003');
    assert.equal(invalid.state, 'invalid');
    assert.equal(invalid.content, '{ broken');
    assert.equal(invalid.diagnostics.length, 1);
});

test('task-plan reader rejects foreign ids, stale digests, superseded plans and dependency cycles', t => {
    const root = workspace(t);
    writePlan(root, 'T-001', JSON.stringify(plan('T-OTHER')));
    assert.match(readTaskPlan(root, 'T-001').diagnostics[0], /does not match/);
    const stale = { ...plan('T-002', 'approved'), plan_sha256: '0'.repeat(64) };
    writePlan(root, 'T-002', JSON.stringify(stale));
    assert.match(readTaskPlan(root, 'T-002').diagnostics[0], /digest/);
    writePlan(root, 'T-003', JSON.stringify(plan('T-003', 'superseded')));
    assert.match(readTaskPlan(root, 'T-003').diagnostics[0], /superseded/);
    const cycle = { ...plan('T-004'), steps: [{ id: 'a', title: 'A', depends_on: ['a'] }] };
    writePlan(root, 'T-004', JSON.stringify(cycle));
    assert.match(readTaskPlan(root, 'T-004').diagnostics[0], /Step dependency cycle/);
    for (const taskId of ['../T-001', 'T-..', 'T-001/other', 'foreign']) {
        assert.throws(() => readTaskPlan(root, taskId));
    }
});

test('task-plan list selects literal leading Notes markers in TODO queue order and supports missing-only', t => {
    const root = workspace(t);
    const rows = [
        ['T-004', '🟦 TODO', '[plan] Missing'],
        ['T-001', 'TODO', '[plan] Draft'],
        ['T-002', 'TODO', '[plan] Ready'],
        ['T-003', 'TODO', '[plan] Invalid'],
        ['T-005', 'IN_PROGRESS', '[plan] Started'],
        ['T-006', 'DONE', '[plan] Done'],
        ['T-007', 'TODO', '`[plan]` quoted'],
        ['T-008', 'TODO', 'Explain [plan] here'],
        ['T-009', 'TODO', '[plan]suffix'],
        ['T-010', 'DECOMPOSED', '[plan] Parent']
    ];
    fs.writeFileSync(path.join(root, 'TASK.md'), [
        '# TASK.md', '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows.map(([id, status, notes]) => `| ${id} | ${status} | P2 | planning | Read | unassigned | 2026-09-30 | balanced | ${notes} |`)
    ].join('\n'));
    writePlan(root, 'T-001', JSON.stringify(plan('T-001')));
    writePlan(root, 'T-002', JSON.stringify(plan('T-002', 'approved')));
    writePlan(root, 'T-003', '{}');
    const list = listTaskPlans(root);
    assert.deepEqual(list.map(entry => [entry.task_id, entry.state]), [
        ['T-004', 'missing'], ['T-001', 'draft'], ['T-002', 'ready'], ['T-003', 'invalid']
    ]);
    assert.equal(list.some(entry => Object.hasOwn(entry, 'content')), false);
    assert.deepEqual(listTaskPlans(root, true).map(entry => entry.task_id), ['T-004']);
});

test('task-plan reads are bounded and reject non-regular or shared files', t => {
    const root = workspace(t);
    const oversized = writePlan(root, 'T-001', ' '.repeat(TASK_PLAN_READ_MAX_BYTES + 1));
    assert.equal(readTaskPlan(root, 'T-001').content, null);
    assert.match(readTaskPlan(root, 'T-001').diagnostics[0], /byte limit/);
    const directory = resolveCanonicalTaskPlanPath(root, 'T-002');
    fs.mkdirSync(directory);
    assert.match(readTaskPlan(root, 'T-002').diagnostics[0], /regular file/);
    fs.linkSync(oversized, resolveCanonicalTaskPlanPath(root, 'T-003'));
    assert.match(readTaskPlan(root, 'T-003').diagnostics[0], /unshared regular file/);
    fs.writeFileSync(path.join(root, 'TASK.md'), ' '.repeat(4 * TASK_PLAN_READ_MAX_BYTES + 1));
    assert.throws(() => listTaskPlans(root), /byte limit/);
});

test('task-plan inspection rejects a parent link that escapes the repository', t => {
    const root = workspace(t);
    const outside = workspace(t);
    fs.symlinkSync(outside, path.join(root, DEFAULT_BUNDLE_NAME), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readTaskPlan(root, 'T-001'), /inside repo root/);
});

test('task-plan reader rejects a file changed during the bounded read', t => {
    const root = workspace(t);
    const file = writePlan(root, 'T-001', JSON.stringify(plan('T-001')));
    const filesystem = require('node:fs') as typeof fs;
    const readSync = filesystem.readSync;
    let mutated = false;
    t.mock.method(filesystem, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        const count = readSync(fd, buffer, offset, length, position);
        if (!mutated && count > 0) {
            mutated = true;
            fs.appendFileSync(file, ' ');
        }
        return count;
    });
    const result = readTaskPlan(root, 'T-001');
    assert.equal(result.state, 'invalid');
    assert.equal(result.content, null);
    assert.match(result.diagnostics[0], /changed during reading/);
});
