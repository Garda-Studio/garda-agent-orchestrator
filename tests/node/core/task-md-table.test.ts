import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncTaskQueueStatusDetailed } from '../../../src/cli/commands/gate-flows/task/task-queue-sync';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    formatCanonicalTaskQueueStatusCell,
    formatTaskQueueStatusCell,
    readTaskQueueStatusToken
} from '../../../src/core/active-task-state';
import {
    formatActiveTaskQueueTable,
    assertCanonicalActiveTaskQueueIntegrity,
    parseCanonicalActiveTaskQueue,
    parseTaskMdTableRow,
    replaceTaskMdTableCell
} from '../../../src/core/task-md-table';
import { buildTaskQueueStatusContract } from '../../../src/core/task-queue-status-contract';

test('parseTaskMdTableRow keeps escaped pipes inside a single cell', () => {
    const row = '| T-001 | TODO | P1 | area | title | me | 2026-01-01 | default | note with escaped \\| pipe |';
    const cells = parseTaskMdTableRow(row);

    assert.equal(cells.length, 9);
    assert.equal(cells[0].trimmed, 'T-001');
    assert.equal(cells[1].trimmed, 'TODO');
    assert.equal(cells[8].trimmed, 'note with escaped \\| pipe');
});

test('replaceTaskMdTableCell updates one cell without disturbing escaped pipes elsewhere', () => {
    const row = '| T-001 | TODO | P1 | area | title | me | 2026-01-01 | default | note with escaped \\| pipe |';
    const updated = replaceTaskMdTableCell(row, 1, ' DONE ');

    assert.equal(updated, '| T-001 | DONE | P1 | area | title | me | 2026-01-01 | default | note with escaped \\| pipe |');
});

test('formatActiveTaskQueueTable reflows only the canonical upper Active Queue table', () => {
    const content = [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-1 | 🟦 TODO | P1 | area | Short | me | 2026-06-04 | balanced | keep escaped \\| pipe |',
        '| T-2222 | 🟨 IN_PROGRESS | P2 | longer-area | Much longer title | agent | 2026-06-04 | strict | keep row order |',
        '',
        '## Блок очереди',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| RU-1 | untouched | P1 | ru | lower table | me | 2026-06-04 | balanced | stays compact |'
    ].join('\n');

    const formatted = formatActiveTaskQueueTable(content);

    assert.match(formatted, /\| T-1\s+\| 🟦 TODO\s+\| P1\s+\| area\s+\| Short\s+\| me\s+\| 2026-06-04 \| balanced \| keep escaped \\\| pipe \|/);
    assert.match(formatted, /\| T-2222 \| 🟨 IN_PROGRESS \| P2\s+\| longer-area \| Much longer title \| agent \| 2026-06-04 \| strict\s+\| keep row order\s+\|/);
    assert.ok(formatted.includes('## Блок очереди\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |'));
});

test('formatActiveTaskQueueTable renders canonical markers for legacy and nested follow-up statuses', () => {
    const content = [
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-1011 | DONE | P3 | reports | Ordinary task | agent | 2026-08-28 | fast | ordinary |',
        '| T-1011-F1 | TODO | P3 | reports | Follow-up | agent | 2026-08-28 | fast | generated |',
        '| T-1011-F1-F1 | IN_PROGRESS | P3 | reports | Nested follow-up | agent | 2026-08-28 | fast | generated |',
        '| T-OTHER | 🟦 TODO | P3 | reports | Existing marker | agent | 2026-08-28 | fast | compatible |'
    ].join('\n');

    const parsed = parseCanonicalActiveTaskQueue(formatActiveTaskQueueTable(content));

    assert.deepEqual(parsed.rows.map((row) => row.status), [
        '🟩 DONE',
        '🟦 TODO',
        '🟨 IN_PROGRESS',
        '🟦 TODO'
    ]);
});

test('formatActiveTaskQueueTable leaves non-canonical tables unchanged', () => {
    const content = [
        '## Active Queue',
        '| ID | Status | Extra |',
        '|---|---|---|',
        '| T-001 | TODO | custom |'
    ].join('\n');

    assert.equal(formatActiveTaskQueueTable(content), content);
});

test('parseCanonicalActiveTaskQueue reads only the upper canonical 9-column Active Queue', () => {
    const content = [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-001 | 🟦TODO | P1 | area | Active title | me | 2026-01-01 | balanced | active notes |',
        '',
        '## User Summary (RU)',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-999 | 🟥 BLOCKED | P1 | lower | Lower title | me | 2026-01-01 | balanced | not a machine row |'
    ].join('\n');

    const parsed = parseCanonicalActiveTaskQueue(content);

    assert.equal(parsed.found, true);
    assert.deepEqual(parsed.rows.map((row) => row.taskId), ['T-001']);
    assert.equal(parsed.rows[0].status, '🟦TODO');
    assert.equal(parsed.rows[0].title, 'Active title');
});

test('parseCanonicalActiveTaskQueue falls back to the first canonical 9-column table when Active Queue heading is absent', () => {
    const content = [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-001 | TODO | P1 | area | Legacy fixture | me | 2026-01-01 | balanced | notes |',
        ''
    ].join('\n');

    const parsed = parseCanonicalActiveTaskQueue(content);

    assert.equal(parsed.found, true);
    assert.deepEqual(parsed.rows.map((row) => row.taskId), ['T-001']);
    assert.equal(parsed.rows[0].title, 'Legacy fixture');
});

test('parseCanonicalActiveTaskQueue does not fall back to lower human summary tables', () => {
    const content = [
        '# TASK.md',
        '',
        '## User Summary (RU)',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-999 | 🟥 BLOCKED | P1 | lower | Lower title | me | 2026-01-01 | balanced | not a machine row |'
    ].join('\n');

    const parsed = parseCanonicalActiveTaskQueue(content);

    assert.equal(parsed.found, false);
    assert.deepEqual(parsed.rows, []);
});

test('parseCanonicalActiveTaskQueue accepts legacy Assignee header as the owner column', () => {
    const content = [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| T-001 | TODO | P1 | area | Legacy assignee header | unassigned | 2026-01-01 | balanced | notes |'
    ].join('\n');

    const parsed = parseCanonicalActiveTaskQueue(content);

    assert.equal(parsed.found, true);
    assert.equal(parsed.rows[0].owner, 'unassigned');
    assert.equal(parsed.rows[0].title, 'Legacy assignee header');
});

test('readTaskQueueStatusToken accepts canonical status and emoji prefix variants', () => {
    assert.equal(readTaskQueueStatusToken('TODO'), 'TODO');
    assert.equal(readTaskQueueStatusToken('🟦 TODO'), 'TODO');
    assert.equal(readTaskQueueStatusToken('🟦TODO'), 'TODO');
    assert.equal(readTaskQueueStatusToken('🟨'), 'IN_PROGRESS');
    assert.equal(readTaskQueueStatusToken('🟫 SPLIT_REQUIRED'), 'SPLIT_REQUIRED');
    assert.equal(readTaskQueueStatusToken('🟪DECOMPOSED'), 'DECOMPOSED');
});

test('canonical task status formatting adds the marker to legacy status cells', () => {
    assert.equal(formatCanonicalTaskQueueStatusCell('TODO'), '🟦 TODO');
    assert.equal(formatCanonicalTaskQueueStatusCell('🟩DONE'), '🟩 DONE');
    assert.equal(formatCanonicalTaskQueueStatusCell('unknown'), 'unknown');
    assert.equal(formatTaskQueueStatusCell(' TODO ', 'DONE'), ' 🟩 DONE ');
});

test('buildTaskQueueStatusContract blocks agent-authored lifecycle status edits but allows non-status content', () => {
    const contract = buildTaskQueueStatusContract('T-323');

    assert.equal(contract.decision, 'block');
    assert.equal(contract.authority, 'gate_owned_status_sync');
    assert.deepEqual(contract.gate_owned_statuses, ['IN_PROGRESS', 'IN_REVIEW', 'SPLIT_REQUIRED', 'DONE']);
    assert.deepEqual(contract.agent_blocked_statuses, ['IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'SPLIT_REQUIRED']);
    assert.equal(contract.agent_may_edit_non_status_task_content, true);
    assert.equal(contract.operator_reset_command, 'gate task-reset --task-id "T-323" --reopen --dry-run --repo-root "."');
    assert.match(contract.reason, /instead of manually editing TASK\.md status cells/);
});

const T200_HEAD = '## Active Queue\n\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
const t200Row = (id: string, status: string) => `| ${id} | ${status} | P2 | a | t | o | 2026-01-01 | balanced | n |`;

test('trailing whitespace after the closing pipe keeps every queue row (T-200)', () => {
    const content = T200_HEAD + t200Row('T-1', 'TODO') + '   \n' + t200Row('T-2', 'TODO') + '\t\n';
    const queue = parseCanonicalActiveTaskQueue(content);
    assert.deepEqual(queue.rows.map(row => row.taskId), ['T-1', 'T-2']);
    assert.equal(queue.rows[0].rawLine, t200Row('T-1', 'TODO') + '   ');
    assert.deepEqual(queue.diagnostics, []);
    assert.equal(parseTaskMdTableRow('| a | b |  ').length, 2);
    assert.equal(parseTaskMdTableRow('| a | b | tail').length, 3);
});

test('duplicate IDs and malformed rows are reported with line numbers instead of silently disappearing (T-200)', () => {
    const content = T200_HEAD + t200Row('T-1', 'TODO') + '\n| T-2 | TODO | P2 |\n' + t200Row('T-1', 'DONE') + '\n';
    const queue = parseCanonicalActiveTaskQueue(content);
    assert.deepEqual(queue.rows.map(row => `${row.taskId}:${row.status}`), ['T-1:TODO', 'T-1:DONE']);
    assert.deepEqual(queue.diagnostics?.map(item => `${item.kind}@${item.lineIndex + 1}`), ['malformed_row@6', 'duplicate_id@7']);
    assert.throws(() => assertCanonicalActiveTaskQueueIntegrity(queue), /line 6 has 3 cells[\s\S]*line 7 repeats task ID T-1 from line 5/u);
    assert.doesNotThrow(() => assertCanonicalActiveTaskQueueIntegrity(parseCanonicalActiveTaskQueue(T200_HEAD + t200Row('T-3', 'TODO'))));
});


test('long Notes do not widen other TASK.md rows or separator', () => {
    const header = '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |';
    const short = '| T-2 | 🟦 TODO | P1 | app | Short | agent | 2026-10-25 | balanced | kept \\| pipe |';
    const content = ['## Active Queue', header, '|---|---|---|---|---|---|---|---|---|',
        `| T-1 | TODO | P1 | app | Long | agent | 2026-10-25 | balanced | ${'x'.repeat(8000)} |`, short].join('\n');
    const rows = formatActiveTaskQueueTable(content).split('\n').slice(1);
    assert.equal(rows[0], header);
    assert.ok(rows[1].length < 100, `separator length: ${rows[1].length}`);
    assert.equal(rows[3], short);
    assert.ok(rows[2].length < 8100, `long row length: ${rows[2].length}`);
    assert.equal(parseCanonicalActiveTaskQueue(rows.join('\n')).rows[0].notes.length, 8000);
});

for (const headed of [true, false]) test(`the next native status write compacts ${headed ? 'headed' : 'headingless'} padded legacy TASK.md without losing queue data`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compact-queue-'));
    try {
        const header = ['ID', 'Status', 'Priority', 'Area', 'Title', 'Owner', 'Updated', 'Profile', 'Notes'];
        const values = [
            ['T-1', 'TODO', 'P1', 'app', 'Long', 'agent', '2026-10-25', 'balanced', 'x'.repeat(8000)],
            ['T-2', 'TODO', 'P2', 'app', 'Short', 'agent', '2026-10-25', 'balanced', 'kept \\| pipe']
        ];
        const widths = header.map((value, i) => Math.max(value.length, ...values.map(row => row[i].length)));
        const padded = (row: string[]) => `| ${row.map((value, i) => value.padEnd(widths[i])).join(' | ')} |`;
        const legacy = ['# Queue', ...(headed ? ['## Active Queue'] : []), padded(header), `|${widths.map(width => '-'.repeat(width + 2)).join('|')}|`,
            ...values.map(padded), ''].join('\r\n');
        const before = parseCanonicalActiveTaskQueue(legacy);
        assertCanonicalActiveTaskQueueIntegrity(before);
        assert.equal(before.rows.length, 2);
        const file = path.join(root, 'TASK.md');
        fs.writeFileSync(file, legacy);
        const result = syncTaskQueueStatusDetailed(root, 'T-2', 'IN_PROGRESS');
        assert.equal(result.outcome, 'updated', result.error_message ?? 'status write failed');
        const compact = fs.readFileSync(file, 'utf8');
        const after = parseCanonicalActiveTaskQueue(compact);
        assertCanonicalActiveTaskQueueIntegrity(after);
        assert.deepEqual(after.rows.map(row => [row.taskId, row.title, row.notes]),
            before.rows.map(row => [row.taskId, row.title, row.notes]));
        assert.equal(readTaskQueueStatusToken(after.rows[1].status), 'IN_PROGRESS');
        assert.ok(compact.length < legacy.length / 2, `compact ${compact.length}, legacy ${legacy.length}`);
        assert.ok(compact.split('\r\n').find(line => line.startsWith('| T-2 '))!.length < 130);
        assert.ok(compact.endsWith('\r\n'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
