import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { runLogTaskEventCommand } from '../../../../../../src/cli/commands/gate-flows/completion/completion-flow';
import { appendMandatoryTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { LIFECYCLE_EVENT_TYPES } from '../../../../../../src/gate-runtime/timeline/lifecycle-event-types';
import { readSplitRequiredLatchEvidence } from '../../../../../../src/gates/next-step/next-step-split-required-latch';
import * as artifacts from '../../../../../../src/cli/gate-cli/gates-artifacts';
import {
    createTempRepo, removeTempRepoWithRetry, getOrchestratorRoot,
    getReviewsRoot, readTaskTimelineEvents, runCliWithCapturedOutput
} from '../../gate-test-helpers';

const taskId = 'T-CONTROL-ADMISSION';

function fixture() {
    const repoRoot = createTempRepo();
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const eventsRoot = path.join(orchestratorRoot, 'runtime/task-events');
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-split-required.json`);
    fs.writeFileSync(artifactPath, JSON.stringify({ schema_version: 1, task_id: taskId,
        status: 'SPLIT_REQUIRED', guard_kind: 'scope_budget', materialization_phase: 'complete',
        status_sync: { outcome: 'updated', previous_status: 'IN_PROGRESS', next_status: 'SPLIT_REQUIRED' } }));
    const details = { guard_kind: 'scope_budget', artifact_path: artifactPath,
        artifact_sha256: createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex') };
    const controls = [
        { type: 'SPLIT_REQUIRED_LATCHED', details: { ...details, status: 'SPLIT_REQUIRED' } },
        { type: 'STATUS_CHANGED', details: { ...details, previous_status: 'IN_PROGRESS',
            new_status: 'SPLIT_REQUIRED', reason: 'auto_split_guard_latched' } }
    ];
    return { repoRoot, orchestratorRoot, eventsRoot, reviewsRoot, controls };
}

function eventBytes(eventsRoot: string): Array<Buffer | null> {
    return [`${taskId}.jsonl`, 'all-tasks.jsonl'].map(name => {
        const file = path.join(eventsRoot, name);
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
    });
}

test('generic caller rejects the entire lifecycle vocabulary and control namespaces before event writes', () => {
    const { repoRoot, eventsRoot } = fixture();
    try {
        const reserved = [...Object.values(LIFECYCLE_EVENT_TYPES), 'SPLIT_REQUIRED_LATCHED',
            'TASK_DONE', 'TASK_BLOCKED', 'CONTINUATION_APPROVED', 'WORKFLOW_CONFIG_FUTURE_GRANT',
            'QUALITY_CHECKLIST_FUTURE_RESULT', 'PROJECT_MEMORY_IMPACT_FUTURE_RESULT',
            'INTERMEDIATE_COMMAND_FUTURE_RESULT', 'TEST_FIRST_FUTURE_RESULT', 'SKILL_FUTURE_GRANT'];
        for (const eventType of reserved) {
            for (const name of [eventType, ` \t${eventType.toLowerCase()}\n`]) {
                assert.throws(() => runLogTaskEventCommand({ repoRoot, taskId, eventType: name,
                    outcome: 'PASS', actor: 'orchestrator', detailsJson: '{}' }), /reserved/u, name);
            }
        }
        assert.equal(fs.existsSync(eventsRoot), false);
        for (const eventType of ['', ' \t\n', undefined, null, 0, false, {}, ['USER_NOTE']]) {
            assert.throws(() => runLogTaskEventCommand({ repoRoot, taskId, eventType }), /non-empty string/u);
        }
        assert.equal(fs.existsSync(eventsRoot), false);
    } finally { removeTempRepoWithRetry(repoRoot); }
});

test('actual CLI rejects forged control events before the split latch consumer can accept', async () => {
    const f = fixture();
    try {
        for (const control of f.controls) {
            const result = await runCliWithCapturedOutput(['gate', 'log-task-event', '--task-id', taskId,
                '--event-type', control.type, '--outcome', 'BLOCKED', '--actor', 'orchestrator',
                '--details-json', JSON.stringify(control.details), '--repo-root', f.repoRoot]);
            assert.notEqual(result.exitCode, 0);
            assert.match(result.errors.join('\n'), /reserved/u);
        }
        assert.equal(fs.existsSync(f.eventsRoot), false);
        assert.equal(readSplitRequiredLatchEvidence({ ...f, taskId }).valid, false);

        for (const control of f.controls) {
            appendMandatoryTaskEvent(f.orchestratorRoot, taskId, control.type, 'BLOCKED',
                'Native producer regression fixture', control.details);
        }
        assert.equal(readSplitRequiredLatchEvidence({ ...f, taskId }).valid, true,
            'The same real consumer must still accept events from unchanged native producer APIs.');
        const before = eventBytes(f.eventsRoot);
        for (const control of f.controls) {
            assert.throws(() => runLogTaskEventCommand({ repoRoot: f.repoRoot, taskId,
                eventType: control.type, outcome: 'BLOCKED', detailsJson: JSON.stringify(control.details) }), /reserved/u);
        }
        assert.deepEqual(eventBytes(f.eventsRoot), before);
    } finally { removeTempRepoWithRetry(f.repoRoot); }
});

test('reject forged terminal events before cleanup and preserve existing event history', () => {
    const { repoRoot, eventsRoot } = fixture();
    let cleanupCalls = 0;
    try {
        runLogTaskEventCommand({ repoRoot, taskId, eventType: 'USER_NOTE', message: 'Existing note' });
        const before = eventBytes(eventsRoot);
        mock.method(artifacts, 'cleanupTerminalCompileLogs', () => { cleanupCalls++; throw new Error('cleanup reached'); });
        mock.method(artifacts, 'cleanupTerminalReviewTempOutputs', () => { cleanupCalls++; throw new Error('cleanup reached'); });
        for (const eventType of ['TASK_DONE', 'TASK_BLOCKED', ' task_done ']) {
            assert.throws(() => runLogTaskEventCommand({ repoRoot, taskId, eventType }), /reserved/u);
        }
        assert.equal(cleanupCalls, 0);
        assert.deepEqual(eventBytes(eventsRoot), before);
    } finally { mock.restoreAll(); removeTempRepoWithRetry(repoRoot); }
});

test('actual CLI retains ordinary informational spelling, outcomes and namespace substrings', async () => {
    const { repoRoot } = fixture();
    try {
        for (const eventType of ['MiXeD_user_note', 'USER_TASK_NOTE', 'DEBUG_STATUS_NOTE', 'MY_REVIEW_OBSERVATION']) {
            const result = await runCliWithCapturedOutput(['gate', 'log-task-event', '--task-id', taskId,
                '--event-type', eventType, '--outcome', 'INFO', '--actor', 'agent', '--repo-root', repoRoot]);
            assert.equal(result.exitCode, 0, result.errors.join('\n'));
            const event = readTaskTimelineEvents(repoRoot, taskId).at(-1);
            assert.equal(event?.event_type, eventType);
            assert.equal(event?.outcome, 'INFO');
            assert.equal(event?.actor, 'agent');
        }
    } finally { removeTempRepoWithRetry(repoRoot); }
});
