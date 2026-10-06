import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { runLogTaskEventCommand } from '../../../../../../src/cli/commands/gate-flows/completion/completion-flow';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { buildOrchestratorDefectCaptureSummary } from '../../../../../../src/gates/task-audit/task-audit-summary-orchestrator-defects';
import {
    createTempRepo, removeTempRepoWithRetry, getOrchestratorRoot,
    readTaskTimelineEvents, runCliWithCapturedOutput
} from '../../gate-test-helpers';

const taskId = 'T-ACK-ADMISSION';
const followUpId = 'T-ACK-F1';
const problemId = 'T-ACK-PROBLEM';
const eventType = 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED';
const details = {
    defect_id: 'ack-defect', summary: 'Defect admission regression',
    resolution: 'fixed_in_current_task', problem_record_id: problemId, follow_up_task_id: followUpId
};

function taskContent(includeFollowUp = true, includeLink = true): string {
    return ['# TASK.md', '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${taskId} | IN_PROGRESS | P1 | test | Current task | unassigned | 2026-10-06 | balanced | Fixture |`,
        ...(includeFollowUp ? [`| ${followUpId} | TODO | P2 | test | Follow-up | unassigned | 2026-10-06 | balanced | Fixture |`] : []),
        '', '## Orchestrator Problems',
        ...(includeLink ? [`- ${problemId}: tracked defect, follow-up ${followUpId}.`] : []), ''
    ].join('\n');
}

function fixture(): { repoRoot: string; eventsRoot: string; taskPath: string } {
    const repoRoot = createTempRepo();
    const taskPath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(taskPath, taskContent());
    const eventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime/task-events');
    fs.rmSync(eventsRoot, { recursive: true, force: true });
    return { repoRoot, eventsRoot, taskPath };
}

function acknowledge(repoRoot: string, candidate: unknown = details, type = eventType): void {
    assert.equal(runLogTaskEventCommand({ repoRoot, taskId, eventType: type, outcome: 'INFO',
        detailsJson: JSON.stringify(candidate) }).exitCode, 0);
}

function capture(repoRoot: string) {
    return buildOrchestratorDefectCaptureSummary({ repoRoot, taskId,
        events: readTaskTimelineEvents(repoRoot, taskId).map(event => ({ ...event })) });
}

function eventBytes(eventsRoot: string): Array<Buffer | null> {
    return [`${taskId}.jsonl`, 'all-tasks.jsonl'].map(name => {
        const filePath = path.join(eventsRoot, name);
        return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    });
}

test('rejects invalid acknowledgement before creating event files', () => {
    const { repoRoot, eventsRoot } = fixture();
    try {
        assert.throws(() => acknowledge(repoRoot, {}), /admission rejected:.*missing defect_id/);
        assert.equal(fs.existsSync(eventsRoot), false);
    } finally { removeTempRepoWithRetry(repoRoot); }
});

test('rejects invalid defect acknowledgements without changing existing logs', async t => {
    const { repoRoot, eventsRoot, taskPath } = fixture();
    try {
        runLogTaskEventCommand({ repoRoot, taskId, eventType: 'PROGRESS_NOTE', outcome: 'INFO', message: 'Existing history' });
        const before = eventBytes(eventsRoot);
        const originalTask = fs.readFileSync(taskPath);
        const cases: Array<[string, unknown, RegExp]> = [
            ['self-link', { ...details, follow_up_task_id: taskId }, /follow-up task must be distinct/],
            ['absent follow-up', { ...details, follow_up_task_id: undefined }, /valid follow_up_task_id/],
            ['invalid follow-up', { ...details, follow_up_task_id: 'invalid/path' }, /valid follow_up_task_id/],
            ['missing task row', { ...details, follow_up_task_id: 'T-ABSENT' }, /missing from TASK.md/],
            ['missing problem ID', { ...details, problem_record_id: undefined }, /valid problem_record_id/],
            ['invalid problem ID', { ...details, problem_record_id: 'invalid/path' }, /valid problem_record_id/],
            ['unlinked problem', { ...details, problem_record_id: 'T-ABSENT' }, /no linked record/],
            ['unsupported resolution', { ...details, resolution: 'ignored' }, /must declare resolution/],
            ['empty summary', { ...details, summary: ' ' }, /missing summary/],
            ['non-text defect ID', { ...details, defect_id: 42 }, /missing defect_id/],
            ['array details', [], /missing defect_id/],
            ['null details', null, /missing defect_id/]
        ];
        let rejections = 0;
        for (const [name, candidate, reason] of cases) await t.test(name, () => {
            assert.throws(() => acknowledge(repoRoot, candidate), reason);
            assert.deepEqual(eventBytes(eventsRoot), before);
            assert.deepEqual(fs.readFileSync(taskPath), originalTask);
            rejections += 1;
        });
        assert.equal(rejections, cases.length);
        fs.unlinkSync(taskPath);
        assert.throws(() => acknowledge(repoRoot), /TASK.md is missing/);
        assert.deepEqual(eventBytes(eventsRoot), before);
    } finally { removeTempRepoWithRetry(repoRoot); }
});

test('native CLI rejects self-link and accepts mixed-case valid acknowledgement', async () => {
    const { repoRoot, eventsRoot } = fixture();
    try {
        const argv = ['gate', 'log-task-event', '--task-id', taskId, '--event-type', eventType.toLowerCase(),
            '--outcome', 'INFO', '--repo-root', repoRoot, '--details-json'];
        const rejected = await runCliWithCapturedOutput([...argv, JSON.stringify({ ...details, follow_up_task_id: taskId })]);
        assert.notEqual(rejected.exitCode, 0);
        assert.match(rejected.errors.join('\n'), /follow-up task must be distinct/);
        assert.equal(fs.existsSync(eventsRoot), false);
        const accepted = await runCliWithCapturedOutput([...argv, JSON.stringify(details)]);
        assert.equal(accepted.exitCode, 0, accepted.errors.join('\n'));
        assert.equal(capture(repoRoot).status, 'CAPTURED');
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).at(-1)?.event_type, eventType.toLowerCase());
    } finally { removeTempRepoWithRetry(repoRoot); }
});

test('preserves invalid historical declarations while admitting valid superseding corrections', () => {
    const { repoRoot, eventsRoot } = fixture();
    try {
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, eventType, 'INFO', 'Historical self-link',
            { ...details, follow_up_task_id: taskId });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, eventType, 'INFO', 'Other historical defect',
            { ...details, defect_id: 'other-defect', follow_up_task_id: taskId });
        const before = eventBytes(eventsRoot);
        acknowledge(repoRoot);
        assert.equal(capture(repoRoot).records.find(record => record.defect_id === details.defect_id)?.status, 'CAPTURED');
        assert.equal(capture(repoRoot).status, 'INVALID', 'Final capture still checks the other unresolved defect.');
        acknowledge(repoRoot, { ...details, defect_id: 'other-defect', resolution: 'deferred_to_follow_up' });
        assert.equal(capture(repoRoot).status, 'CAPTURED');
        const after = eventBytes(eventsRoot);
        for (let index = 0; index < before.length; index += 1) {
            assert.ok(before[index]);
            assert.deepEqual(after[index]?.subarray(0, before[index]?.length), before[index]);
        }
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === eventType).length, 4);
    } finally { removeTempRepoWithRetry(repoRoot); }
});

test('rejects a defect acknowledgement assembled from inconsistent TASK snapshots', () => {
    const { repoRoot, eventsRoot, taskPath } = fixture();
    const originalRead = fs.readFileSync;
    let taskReads = 0;
    fs.writeFileSync(taskPath, taskContent(false, true));
    try {
        mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
            const result = originalRead(...args);
            if (String(args[0]) === taskPath) {
                taskReads += 1;
                fs.writeFileSync(taskPath, taskContent(true, false));
            }
            return result;
        });
        assert.throws(() => acknowledge(repoRoot), /missing from TASK.md/);
        assert.equal(taskReads, 1);
        assert.equal(fs.existsSync(eventsRoot), false);
    } finally { mock.restoreAll(); removeTempRepoWithRetry(repoRoot); }
});

test('final defect capture rejects later follow-up or problem record drift', () => {
    const { repoRoot, taskPath } = fixture();
    try {
        acknowledge(repoRoot);
        assert.equal(capture(repoRoot).status, 'CAPTURED');
        fs.writeFileSync(taskPath, taskContent(false, true));
        assert.equal(capture(repoRoot).status, 'INVALID');
        fs.writeFileSync(taskPath, taskContent(true, false));
        assert.equal(capture(repoRoot).status, 'INVALID');
    } finally { removeTempRepoWithRetry(repoRoot); }
});

test('reserved lifecycle events remain rejected and unrelated event logging remains available', () => {
    const { repoRoot, eventsRoot } = fixture();
    try {
        assert.throws(() => acknowledge(repoRoot, details, 'completion_gate_passed'), /reserved and cannot be emitted/);
        assert.equal(fs.existsSync(eventsRoot), false);
        const result = runLogTaskEventCommand({ repoRoot, taskId, eventType: 'PROGRESS_NOTE', outcome: 'INFO', detailsJson: '{}' });
        assert.equal(result.exitCode, 0);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).at(-1)?.event_type, 'PROGRESS_NOTE');
    } finally { removeTempRepoWithRetry(repoRoot); }
});
