import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startLocalUiServer } from '../../../src/reports/ui';
import {
    formatReviewFollowUpTaskClosurePolicyMetadata,
    resolveReviewFollowUpTaskClosurePolicy,
    type ReviewFollowUpTaskClosurePolicyTaskContext
} from '../../../src/core/review-follow-up-task-closure-policy';
import {
    processUiTaskClosurePolicyRequest,
    TASK_CLOSURE_POLICY_ACTION_ID,
    TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE,
    type UiTaskClosurePolicyRequest
} from '../../../src/reports/ui/actions/task-closure-policy-actions';

const TASK_ID = 'T-100-F1';
const PARENT_TASK_ID = 'T-100';
const FINGERPRINT = 'a'.repeat(64);
const PARENT_NOTES = `Review follow-up tasks materialized: \`${TASK_ID}\`; artifact `
    + `\`garda-agent-orchestrator/runtime/reviews/${PARENT_TASK_ID}-review-findings-follow-up-tasks.json\`.`;

function makeRepo(options: {
    status?: string;
    notes?: string;
    taskId?: string;
} = {}): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-closure-action-'));
    const taskId = options.taskId || TASK_ID;
    const notes = options.notes ?? [
        'Child of `T-100`.',
        'keep=this-text.',
        `review_follow_up_fingerprint=${FINGERPRINT}.`,
        formatReviewFollowUpTaskClosurePolicyMetadata({
            skip_low_findings: false,
            forbid_child_tasks: false
        })
    ].join(' ');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${PARENT_TASK_ID} | IN_PROGRESS | P1 | core | Parent | codex | 2026-08-26 | strict | ${PARENT_NOTES} |`,
        `| ${taskId} | ${options.status || 'IN_PROGRESS'} | P1 | core | Close findings | codex | 2026-08-26 | strict | ${notes} |`,
        ''
    ].join('\n'), 'utf8');
    return repoRoot;
}

function resolvePolicy(notes: string): ReturnType<typeof resolveReviewFollowUpTaskClosurePolicy> {
    const context: ReviewFollowUpTaskClosurePolicyTaskContext = {
        taskId: TASK_ID,
        taskRows: [
            { taskId: PARENT_TASK_ID, notes: PARENT_NOTES },
            { taskId: TASK_ID, notes }
        ]
    };
    return resolveReviewFollowUpTaskClosurePolicy(notes, context);
}

function request(
    repoRoot: string,
    payload: UiTaskClosurePolicyRequest
): ReturnType<typeof processUiTaskClosurePolicyRequest> {
    return processUiTaskClosurePolicyRequest(repoRoot, TASK_ID, payload);
}

function previewPayload(skipLowFindings: boolean, forbidChildTasks: boolean): UiTaskClosurePolicyRequest {
    return {
        action_id: TASK_CLOSURE_POLICY_ACTION_ID,
        mode: 'preview',
        skip_low_findings: skipLowFindings,
        forbid_child_tasks: forbidChildTasks
    };
}

test('task closure policy action round-trips both controls independently and survives a stateless reload', () => {
    const repoRoot = makeRepo();
    try {
        for (const skipLowFindings of [false, true]) {
            for (const forbidChildTasks of [false, true]) {
                const preview = request(repoRoot, previewPayload(skipLowFindings, forbidChildTasks));
                assert.equal(preview.status, 'previewed');
                assert.equal(preview.http_status, 200);
                assert.match(preview.expected_notes_sha256 || '', /^[a-f0-9]{64}$/u);

                const executed = request(repoRoot, {
                    ...previewPayload(skipLowFindings, forbidChildTasks),
                    mode: 'execute',
                    confirmation: TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE,
                    expected_notes_sha256: preview.expected_notes_sha256
                });
                assert.equal(executed.status, 'executed');
                assert.equal(executed.http_status, 200);
                assert.equal(executed.current_policy?.skip_low_findings, skipLowFindings);
                assert.equal(executed.current_policy?.forbid_child_tasks, forbidChildTasks);

                const reloadedNotes = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')
                    .split(/\r?\n/u)
                    .find((line) => line.includes(`| ${TASK_ID} |`))
                    ?.split('|')[9]
                    ?.trim() || '';
                const reloadedPolicy = resolvePolicy(reloadedNotes);
                assert.equal(reloadedPolicy.skip_low_findings, skipLowFindings);
                assert.equal(reloadedPolicy.forbid_child_tasks, forbidChildTasks);
                assert.match(reloadedNotes, /keep=this-text/u);
                assert.equal((reloadedNotes.match(/review_follow_up_task_closure_policy=/gu) || []).length, 1);
            }
        }

        const auditLines = fs.readFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'ui-actions', 'audit.jsonl'),
            'utf8'
        ).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(auditLines.length, 8);
        assert.ok(auditLines.every((entry) => entry.task_id === TASK_ID));
        assert.ok(auditLines.some((entry) => entry.status === 'executed' && entry.after_notes_sha256));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('task closure policy execute rejects stale preview without changing TASK.md', () => {
    const repoRoot = makeRepo();
    try {
        const preview = request(repoRoot, previewPayload(true, true));
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace('keep=this-text.', 'keep=this-text. concurrent=change.'),
            'utf8'
        );
        const beforeExecute = fs.readFileSync(taskPath, 'utf8');
        const currentNotes = beforeExecute
            .split(/\r?\n/u)
            .find((line) => line.includes(`| ${TASK_ID} |`))
            ?.split('|')[9]
            ?.trim() || '';
        const currentNotesSha256 = resolvePolicy(currentNotes).source_notes_sha256;

        const result = request(repoRoot, {
            ...previewPayload(true, true),
            mode: 'execute',
            confirmation: TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE,
            expected_notes_sha256: preview.expected_notes_sha256
        });

        assert.equal(result.status, 'conflict');
        assert.equal(result.http_status, 409);
        assert.match(result.unavailable_reason || '', /changed after preview/iu);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), beforeExecute);
        assert.equal(result.expected_notes_sha256, currentNotesSha256);

        const staleAuditRecords = fs.readFileSync(result.audit_path, 'utf8')
            .trim()
            .split(/\r?\n/u)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const staleAudit = staleAuditRecords.at(-1);
        assert.equal(staleAudit?.status, 'conflict');
        assert.equal(staleAudit?.before_notes_sha256, currentNotesSha256);
        assert.notEqual(staleAudit?.before_notes_sha256, preview.expected_notes_sha256);

        const freshPreview = request(repoRoot, previewPayload(true, true));
        const lockPath = `${taskPath}.garda-status-sync.lock`;
        fs.writeFileSync(lockPath, 'held by concurrent task queue update', 'utf8');
        const lockedResult = request(repoRoot, {
            ...previewPayload(true, true),
            mode: 'execute',
            confirmation: TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE,
            expected_notes_sha256: freshPreview.expected_notes_sha256
        });
        assert.equal(lockedResult.status, 'conflict');
        assert.equal(lockedResult.http_status, 409);
        assert.match(lockedResult.unavailable_reason || '', /status-sync lock/iu);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), beforeExecute);
        fs.unlinkSync(lockPath);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('task closure policy execute rolls back TASK.md when required audit persistence fails', () => {
    const repoRoot = makeRepo();
    try {
        const preview = request(repoRoot, previewPayload(true, true));
        const taskPath = path.join(repoRoot, 'TASK.md');
        const beforeExecute = fs.readFileSync(taskPath, 'utf8');
        fs.rmSync(preview.audit_path, { force: true });
        fs.mkdirSync(preview.audit_path);

        assert.throws(
            () => request(repoRoot, {
                ...previewPayload(true, true),
                mode: 'execute',
                confirmation: TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE,
                expected_notes_sha256: preview.expected_notes_sha256
            }),
            (error: unknown) => {
                const code = error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : '';
                return ['EACCES', 'EISDIR', 'EPERM'].includes(code);
            }
        );
        assert.equal(fs.readFileSync(taskPath, 'utf8'), beforeExecute);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('task closure policy request parsing rejects non-exact payloads without persistence', () => {
    const repoRoot = makeRepo();
    try {
        const taskPath = path.join(repoRoot, 'TASK.md');
        const original = fs.readFileSync(taskPath, 'utf8');
        const invalidPayloads: UiTaskClosurePolicyRequest[] = [
            { ...previewPayload(true, true), mode: 'invalid' },
            { ...previewPayload(true, true), skip_low_findings: 'true' },
            { ...previewPayload(true, true), unexpected: true } as UiTaskClosurePolicyRequest
        ];

        for (const payload of invalidPayloads) {
            const result = request(repoRoot, payload);
            assert.equal(result.status, 'failed');
            assert.equal(result.http_status, 400);
        }
        assert.equal(fs.readFileSync(taskPath, 'utf8'), original);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('task closure policy action is unavailable for ordinary, malformed, and completed tasks', () => {
    const fixtures = [
        { status: 'IN_PROGRESS', notes: 'ordinary task notes', reason: /only to review-generated/iu },
        {
            status: 'IN_PROGRESS',
            notes: `review_follow_up_fingerprint=${FINGERPRINT}. `
                + 'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":"yes","forbid_child_tasks":true}`.',
            reason: /must be boolean|invalid/iu
        },
        { status: 'DONE', reason: /cannot be changed retroactively/iu }
    ];

    for (const fixture of fixtures) {
        const repoRoot = makeRepo(fixture);
        try {
            const result = request(repoRoot, previewPayload(true, true));
            assert.equal(result.status, 'unavailable');
            assert.equal(result.http_status, 409);
            assert.match(result.unavailable_reason || '', fixture.reason);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    }
});

test('task closure policy action rejects marker metadata forged on an ordinary task', () => {
    const ordinaryTaskId = 'T-ORDINARY';
    const repoRoot = makeRepo({
        taskId: ordinaryTaskId,
        notes: [
            'Child of `T-100`.',
            `review_follow_up_fingerprint=${FINGERPRINT}.`,
            formatReviewFollowUpTaskClosurePolicyMetadata({
                skip_low_findings: true,
                forbid_child_tasks: true
            })
        ].join(' ')
    });
    try {
        const taskPath = path.join(repoRoot, 'TASK.md');
        const original = fs.readFileSync(taskPath, 'utf8');
        const result = processUiTaskClosurePolicyRequest(
            repoRoot,
            ordinaryTaskId,
            previewPayload(false, false)
        );

        assert.equal(result.status, 'unavailable');
        assert.equal(result.http_status, 409);
        assert.match(result.unavailable_reason || '', /canonical parent materialization/iu);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), original);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('local UI task action route enforces the guarded preview and execute contract', async () => {
    const repoRoot = makeRepo();
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true });
    try {
        const html = await (await fetch(server.url)).text();
        const actionToken = html.match(/const actionToken = "([^"]+)";/u)?.[1];
        assert.ok(actionToken);
        const headers = {
            'content-type': 'application/json',
            origin: server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const previewResponse = await fetch(`${server.url}api/tasks/${TASK_ID}/actions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(previewPayload(true, false))
        });
        const preview = await previewResponse.json() as ReturnType<typeof processUiTaskClosurePolicyRequest>;
        assert.equal(previewResponse.status, 200);
        assert.equal(preview.status, 'previewed');

        const executeResponse = await fetch(`${server.url}api/tasks/${TASK_ID}/actions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                ...previewPayload(true, false),
                mode: 'execute',
                confirmation: TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE,
                expected_notes_sha256: preview.expected_notes_sha256
            })
        });
        const executed = await executeResponse.json() as ReturnType<typeof processUiTaskClosurePolicyRequest>;
        assert.equal(executeResponse.status, 200);
        assert.equal(executed.status, 'executed');
        assert.equal(executed.current_policy?.skip_low_findings, true);
        assert.equal(executed.current_policy?.forbid_child_tasks, false);

        const rejectedResponse = await fetch(`${server.url}api/tasks/${TASK_ID}/actions`, {
            method: 'POST',
            headers: { ...headers, origin: 'http://example.invalid' },
            body: JSON.stringify(previewPayload(false, false))
        });
        assert.equal(rejectedResponse.status, 403);
        assert.deepEqual(await rejectedResponse.json(), {
            error: 'Request rejected by local UI boundary.',
            code: 'action_boundary_rejected'
        });
    } finally {
        await server.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
