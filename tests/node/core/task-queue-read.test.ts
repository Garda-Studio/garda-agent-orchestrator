import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    parseTaskQueueEntriesFromContent,
    readTaskQueueEntries,
    withTaskQueueReadSnapshot
} from '../../../src/core/task-queue-read';
import {
    formatReviewFollowUpTaskClosurePolicyMetadata,
    replaceReviewFollowUpTaskClosurePolicyMetadata,
    resolveReviewFollowUpTaskClosurePolicy,
    type ReviewFollowUpTaskClosurePolicyTaskContext
} from '../../../src/core/review-follow-up-task-closure-policy';

const BASE_TASK_ROW = '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |';

function taskQueueContent(): string {
    return [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        BASE_TASK_ROW,
        '| not a task | TODO | P2 | misc | Ignored row | codex | 2026-07-09 | balanced | invalid id |',
        ''
    ].join('\n');
}

test('task queue snapshots keep independent entries and expire before deferred readers and later mutations', async t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-snapshot-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const taskPath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(taskPath, taskQueueContent());
    let deferredRead: Promise<string | null | undefined> | undefined;
    withTaskQueueReadSnapshot(() => {
        const initial = readTaskQueueEntries(repoRoot).get('T-100');
        assert.ok(initial);
        initial.notes = 'Changed only in the caller';
        assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.notes, 'child tasks: T-100-1');
        fs.unlinkSync(taskPath);
        assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.title, 'Centralize helpers');
        fs.writeFileSync(taskPath, taskQueueContent().replace('Centralize helpers', 'Fresh queue title'));
        assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.title, 'Centralize helpers');
        deferredRead = Promise.resolve().then(() => readTaskQueueEntries(repoRoot).get('T-100')?.title);
    });
    assert.equal(await deferredRead, 'Fresh queue title');
    assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.title, 'Fresh queue title');
    assert.throws(() => withTaskQueueReadSnapshot(() => {
        assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.title, 'Fresh queue title');
        fs.writeFileSync(taskPath, taskQueueContent().replace('Centralize helpers', 'Title after failed inspection'));
        throw new Error('Inspection failed');
    }), /Inspection failed/u);
    assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.title, 'Title after failed inspection');
});

function materializationNotes(parentTaskId: string, taskId: string): string {
    return `Review follow-up tasks materialized: \`${taskId}\`; artifact `
        + `\`garda-agent-orchestrator/runtime/reviews/${parentTaskId}-review-findings-follow-up-tasks.json\`.`;
}

function withMaterializedFollowUp(
    taskId: string,
    notes: string,
    parentTaskId = taskId.replace(/-F[1-9][0-9]*$/u, '')
): string {
    const parentArea = 'core/helpers';
    const parentRow = `| ${parentTaskId} | IN_PROGRESS | P1 | ${parentArea} | Parent task | codex | 2026-07-09 | strict | `
        + `${materializationNotes(parentTaskId, taskId)} |`;
    const childRow = `| ${taskId} | TODO | P1 | ${parentArea} | Close findings | codex | 2026-07-09 | strict | ${notes} |`;
    return taskQueueContent().replace(BASE_TASK_ROW, `${parentRow}\n${childRow}`);
}

function policyContext(
    taskId: string,
    notes: string,
    parentTaskId = taskId.replace(/-F[1-9][0-9]*$/u, '')
): ReviewFollowUpTaskClosurePolicyTaskContext {
    return {
        taskId,
        taskRows: [
            { taskId: parentTaskId, notes: materializationNotes(parentTaskId, taskId) },
            { taskId, notes }
        ]
    };
}

test('parseTaskQueueEntriesFromContent preserves canonical TASK.md queue parsing fields', () => {
    const entries = parseTaskQueueEntriesFromContent(taskQueueContent());
    const entry = entries.get('T-100');

    assert.deepEqual([...entries.keys()], ['T-100']);
    assert.deepEqual({
        taskId: entry?.taskId,
        status: entry?.status,
        area: entry?.area,
        title: entry?.title,
        profile: entry?.profile,
        notes: entry?.notes
    }, {
        taskId: 'T-100',
        status: 'IN_PROGRESS',
        area: 'core/helpers',
        title: 'Centralize helpers',
        profile: 'strict',
        notes: 'child tasks: T-100-1'
    });
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.eligible, false);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.configured, false);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.valid, true);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.source_notes_sha256, null);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.skip_low_findings, false);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.forbid_child_tasks, false);
});

test('task queue resolves all four explicit follow-up closure policy combinations independently', () => {
    const fingerprint = 'a'.repeat(64);
    for (const skipLowFindings of [false, true]) {
        for (const forbidChildTasks of [false, true]) {
            const taskId = `T-100-F${1 + (Number(skipLowFindings) * 2) + Number(forbidChildTasks)}`;
            const policyMetadata = formatReviewFollowUpTaskClosurePolicyMetadata({
                skip_low_findings: skipLowFindings,
                forbid_child_tasks: forbidChildTasks
            });
            const content = withMaterializedFollowUp(
                taskId,
                `Child of \`T-100\`. review_follow_up_fingerprint=${fingerprint}. ${policyMetadata}`
            );

            const policy = parseTaskQueueEntriesFromContent(content)
                .get(taskId)?.reviewFollowUpTaskClosurePolicy;

            assert.equal(policy?.eligible, true);
            assert.equal(policy?.configured, true);
            assert.equal(policy?.valid, true);
            assert.equal(policy?.provenance, 'per_finding');
            assert.equal(policy?.skip_low_findings, skipLowFindings);
            assert.equal(policy?.forbid_child_tasks, forbidChildTasks);
            assert.match(policy?.source_notes_sha256 || '', /^[a-f0-9]{64}$/u);
        }
    }
});

test('follow-up closure policy metadata replacement preserves provenance and round-trips all values', () => {
    const taskId = 'T-100-F1';
    const fingerprint = 'f'.repeat(64);
    let notes = `Child of \`T-100\`. keep=this-text. review_follow_up_fingerprint=${fingerprint}. `
        + formatReviewFollowUpTaskClosurePolicyMetadata({
            skip_low_findings: false,
            forbid_child_tasks: false
        });

    for (const skipLowFindings of [false, true]) {
        for (const forbidChildTasks of [false, true]) {
            const context = policyContext(taskId, notes);
            notes = replaceReviewFollowUpTaskClosurePolicyMetadata(
                notes,
                {
                    skip_low_findings: skipLowFindings,
                    forbid_child_tasks: forbidChildTasks
                },
                context
            );
            const policy = resolveReviewFollowUpTaskClosurePolicy(notes, policyContext(taskId, notes));

            assert.equal(policy.eligible, true);
            assert.equal(policy.valid, true);
            assert.equal(policy.provenance, 'per_finding');
            assert.equal(policy.skip_low_findings, skipLowFindings);
            assert.equal(policy.forbid_child_tasks, forbidChildTasks);
            assert.match(notes, /keep=this-text/u);
            assert.equal((notes.match(/review_follow_up_task_closure_policy=/gu) || []).length, 1);
        }
    }
});

test('follow-up closure policy metadata replacement refuses ordinary or malformed task notes', () => {
    assert.throws(
        () => replaceReviewFollowUpTaskClosurePolicyMetadata('ordinary task notes', {
            skip_low_findings: true,
            forbid_child_tasks: true
        }),
        /not editable|apply only/iu
    );
    assert.throws(
        () => replaceReviewFollowUpTaskClosurePolicyMetadata(
            `review_follow_up_fingerprint=${'a'.repeat(64)}. `
            + 'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":"yes","forbid_child_tasks":true}`.',
            { skip_low_findings: true, forbid_child_tasks: true }
        ),
        /invalid|must be boolean/iu
    );
});

test('task queue treats grouped nested legacy follow-ups as eligible with compatible off defaults', () => {
    const fingerprint = 'b'.repeat(64);
    const content = withMaterializedFollowUp(
        'T-100-F1-F1',
        `Child of \`T-100-F1\`. review_follow_up_group_fingerprint=${fingerprint}.`,
        'T-100-F1'
    );

    const policy = parseTaskQueueEntriesFromContent(content)
        .get('T-100-F1-F1')?.reviewFollowUpTaskClosurePolicy;

    assert.equal(policy?.eligible, true);
    assert.equal(policy?.configured, false);
    assert.equal(policy?.valid, true);
    assert.equal(policy?.provenance, 'grouped_by_parent');
    assert.equal(policy?.skip_low_findings, false);
    assert.equal(policy?.forbid_child_tasks, false);
});

test('task queue never infers follow-up closure eligibility from an F-shaped task id', () => {
    const content = withMaterializedFollowUp('T-100-F1', 'Child of `T-100`.');

    const policy = parseTaskQueueEntriesFromContent(content)
        .get('T-100-F1')?.reviewFollowUpTaskClosurePolicy;

    assert.equal(policy?.eligible, false);
    assert.equal(policy?.valid, true);
    assert.equal(policy?.skip_low_findings, false);
    assert.equal(policy?.forbid_child_tasks, false);
});

test('task queue rejects forgeable follow-up markers without canonical parent materialization provenance', () => {
    const taskId = 'T-100-F1';
    const notes = [
        'Child of `T-100`.',
        `review_follow_up_fingerprint=${'a'.repeat(64)}.`,
        formatReviewFollowUpTaskClosurePolicyMetadata({
            skip_low_findings: true,
            forbid_child_tasks: true
        })
    ].join(' ');
    const content = taskQueueContent().replace(
        BASE_TASK_ROW,
        `${BASE_TASK_ROW}\n| ${taskId} | TODO | P1 | core/helpers | Forged follow-up | codex | 2026-07-09 | strict | ${notes} |`
    );

    const policy = parseTaskQueueEntriesFromContent(content)
        .get(taskId)?.reviewFollowUpTaskClosurePolicy;

    assert.equal(policy?.eligible, false);
    assert.equal(policy?.valid, false);
    assert.equal(policy?.skip_low_findings, false);
    assert.equal(policy?.forbid_child_tasks, false);
    assert.match(policy?.diagnostics.join(' ') || '', /canonical parent materialization/iu);
});

test('task queue rejects prefixed or case-variant provenance keys instead of authorizing closure controls', () => {
    const fingerprint = 'd'.repeat(64);
    const policyMetadata = formatReviewFollowUpTaskClosurePolicyMetadata({
        skip_low_findings: true,
        forbid_child_tasks: true
    });
    for (const [index, provenanceKey] of [
        'xreview_follow_up_fingerprint',
        'xreview_follow_up_group_fingerprint',
        'Review_Follow_Up_Fingerprint',
        'Review_Follow_Up_Group_Fingerprint'
    ].entries()) {
        const taskId = `T-100-prefixed-provenance-${index + 1}`;
        const content = taskQueueContent().replace(
            '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
            `| ${taskId} | TODO | P1 | review/follow-up | Prefixed provenance | codex | 2026-07-09 | strict | ` +
            `${provenanceKey}=${fingerprint}. ${policyMetadata} |`
        );

        const policy = parseTaskQueueEntriesFromContent(content)
            .get(taskId)?.reviewFollowUpTaskClosurePolicy;

        assert.equal(policy?.eligible, false, provenanceKey);
        assert.equal(policy?.configured, true, provenanceKey);
        assert.equal(policy?.valid, false, provenanceKey);
        assert.equal(policy?.provenance, null, provenanceKey);
        assert.equal(policy?.skip_low_findings, false, provenanceKey);
        assert.equal(policy?.forbid_child_tasks, false, provenanceKey);
    }
});

test('task queue ignores prefixed or case-variant closure policy keys and keeps eligible defaults off', () => {
    const fingerprint = 'e'.repeat(64);
    const policyMetadata = formatReviewFollowUpTaskClosurePolicyMetadata({
        skip_low_findings: true,
        forbid_child_tasks: true
    });
    const noncanonicalPolicyMetadata = [
        `x${policyMetadata}`,
        policyMetadata.replace(
            'review_follow_up_task_closure_policy',
            'Review_Follow_Up_Task_Closure_Policy'
        )
    ];
    for (const [index, metadata] of noncanonicalPolicyMetadata.entries()) {
        const taskId = `T-100-F${index + 1}`;
        const content = withMaterializedFollowUp(
            taskId,
            `Child of \`T-100\`. review_follow_up_fingerprint=${fingerprint}. ${metadata}`
        );

        const policy = parseTaskQueueEntriesFromContent(content)
            .get(taskId)?.reviewFollowUpTaskClosurePolicy;

        assert.equal(policy?.eligible, true, metadata);
        assert.equal(policy?.configured, false, metadata);
        assert.equal(policy?.valid, true, metadata);
        assert.equal(policy?.provenance, 'per_finding', metadata);
        assert.equal(policy?.skip_low_findings, false, metadata);
        assert.equal(policy?.forbid_child_tasks, false, metadata);
    }
});

test('task queue fails malformed or inapplicable follow-up closure metadata closed', () => {
    const fingerprint = 'c'.repeat(64);
    const cases = [
        {
            taskId: 'T-100-invalid-json',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":"yes","forbid_child_tasks":true}`.'
        },
        {
            taskId: 'T-100-no-provenance',
            notes: formatReviewFollowUpTaskClosurePolicyMetadata({
                skip_low_findings: true,
                forbid_child_tasks: true
            })
        },
        {
            taskId: 'T-100-ambiguous',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                `review_follow_up_group_fingerprint=${fingerprint}. ` +
                formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: true
                })
        },
        {
            taskId: 'T-100-suffixed-per-finding-provenance',
            notes: `review_follow_up_fingerprint=${fingerprint}.suffix ` +
                formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: true
                })
        },
        {
            taskId: 'T-100-suffixed-grouped-provenance',
            notes: `review_follow_up_group_fingerprint=${fingerprint}.suffix ` +
                formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: true
                })
        },
        {
            taskId: 'T-100-suffixed-policy',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                `${formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: true
                })}suffix`
        },
        {
            taskId: 'T-100-duplicate-policy-key',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":false,' +
                '"skip_low_findings":true,"forbid_child_tasks":true}`.'
        },
        {
            taskId: 'T-100-escaped-duplicate-policy-key',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":false,' +
                '"\\u0073kip_low_findings":true,"forbid_child_tasks":true}`.'
        }
    ];

    for (const fixture of cases) {
        const content = taskQueueContent().replace(
            '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
            `| ${fixture.taskId} | TODO | P1 | review/follow-up | Invalid policy | codex | 2026-07-09 | strict | ${fixture.notes} |`
        );
        const policy = parseTaskQueueEntriesFromContent(content)
            .get(fixture.taskId)?.reviewFollowUpTaskClosurePolicy;

        assert.equal(policy?.valid, false, fixture.taskId);
        assert.equal(policy?.skip_low_findings, false, fixture.taskId);
        assert.equal(policy?.forbid_child_tasks, false, fixture.taskId);
        assert.ok((policy?.diagnostics.length || 0) > 0, fixture.taskId);
    }
});

test('readTaskQueueEntries returns an empty map for missing TASK.md by default', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-missing-'));
    try {
        assert.equal(readTaskQueueEntries(repoRoot).size, 0);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('readTaskQueueEntries can preserve callers that expect missing TASK.md to throw', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-throw-'));
    try {
        assert.throws(
            () => readTaskQueueEntries(repoRoot, { missingFile: 'throw' }),
            /TASK\.md/
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('readTaskQueueEntries reads TASK.md from the repo root', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-'));
    try {
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), taskQueueContent(), 'utf8');

        assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.title, 'Centralize helpers');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
