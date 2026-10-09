import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { parseCanonicalActiveTaskQueue } from '../../../src/core/task-md-table';
import { parseTaskQueueEntriesFromContent } from '../../../src/core/task-queue-read';
import { buildTaskContentWithExistingQueue } from '../../../src/materialization/content-builders-task-queue';
import { copyDirectoryRecursive } from '../../../src/materialization/init/init-filesystem';

const HEADER = '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |';
const SEPARATOR = '|---|---|---|---|---|---|---|---|---|';
const ACTIVE_ROW = '| T-100 | TODO | P2 | docs | Existing task | operator | 2026-10-08 | balanced | Required reviews: code, test. |';
const PROMOTED_ROW = '| T-200 | TODO | P2 | docs | Inspect candidate | operator | 2026-10-08 | balanced | Promoted from CAND-001 by explicit operator decision; required reviews: code, security, api, test. |';
const INBOX = [
    '## Task Candidates',
    '',
    '| Candidate | Source task | Observation | Evidence | Suggested scope | Severity | Operator decision |',
    '|---|---|---|---|---|---|---|',
    '| CAND-001 | T-100 | Missing explanation | docs/example.md:12 | T-200 is only a suggested task reference | low | pending |',
    ''
].join('\n');

function queue(rows = [ACTIVE_ROW]): string {
    return ['# TASK.md', '', '## Active Queue', HEADER, SEPARATOR, ...rows, ''].join('\n');
}

function instructionsFixture(context: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-candidate-contract-'));
    context.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    for (const [source, destination] of [
        ['template/docs/agent-rules', 'live/docs/agent-rules'],
        ['template/skills/orchestration', 'live/skills/orchestration']
    ]) {
        copyDirectoryRecursive(path.join(getRepoRoot(), source), path.join(root, destination), { destinationRoot: root });
    }
    return {
        workflow: fs.readFileSync(path.join(root, 'live/docs/agent-rules/80-task-workflow.md'), 'utf8'),
        orchestration: fs.readFileSync(path.join(root, 'live/skills/orchestration/SKILL.md'), 'utf8')
    };
}

test('rejects candidate references and lower example rows as executable queue entries', () => {
    const content = queue() + '\n' + INBOX + '\n## Candidate evidence example\n'
        + [HEADER, SEPARATOR, PROMOTED_ROW, ''].join('\n');
    const parsed = parseCanonicalActiveTaskQueue(content);
    assert.equal(parsed.found, true);
    assert.equal(parsed.unavailableReason, null);
    assert.deepEqual(parsed.rows.map(row => row.taskId), ['T-100']);
    const entries = parseTaskQueueEntriesFromContent(content);
    assert.deepEqual([...entries.keys()], ['T-100']);
    assert.equal(entries.has('CAND-001'), false);
    assert.equal(entries.has('T-200'), false);
    assert.equal(entries.get('T-100')?.status, 'TODO');
});

test('rejects promotion from candidate metadata without a new canonical TODO row', () => {
    const approvedCandidate = INBOX.replace('| pending |', '| explicitly promoted to T-200 by operator |');
    assert.deepEqual([...parseTaskQueueEntriesFromContent(queue() + '\n' + approvedCandidate).keys()], ['T-100']);
    const content = queue([ACTIVE_ROW, PROMOTED_ROW]) + '\n'
        + approvedCandidate;
    const entries = parseTaskQueueEntriesFromContent(content);
    assert.deepEqual([...entries.keys()], ['T-100', 'T-200']);
    assert.equal(entries.has('CAND-001'), false);
    const promoted = entries.get('T-200');
    assert.equal(promoted?.status, 'TODO');
    assert.equal(promoted?.profile, 'balanced');
    assert.match(promoted?.notes || '', /explicit operator decision/u);
    assert.match(promoted?.notes || '', /required reviews: code, security, api, test/u);
    assert.equal(entries.get('T-100')?.title, 'Existing task');
});

test('the TASK template supplies an empty non-executable inbox outside managed queue rows', () => {
    const template = fs.readFileSync(path.join(getRepoRoot(), 'template/TASK.md'), 'utf8');
    const rendered = buildTaskContentWithExistingQueue(template, '');
    assert.notEqual(rendered, null);
    assert.match(rendered || '', /^## Task Candidates$/mu);
    assert.ok((rendered || '').indexOf('## Task Candidates')
        > (rendered || '').indexOf('<!-- garda-agent-orchestrator:managed-end -->'));
    assert.match(rendered || '', /Source task \| Observation \| Evidence \| Suggested scope \| Severity \| Operator decision/u);
    assert.match(rendered || '', /explicit operator decision/u);
    assert.deepEqual([...parseTaskQueueEntriesFromContent(rendered || '').keys()], ['T-001']);
});

test('template refresh prevents clobbering operator queue and candidate bytes', () => {
    const template = fs.readFileSync(path.join(getRepoRoot(), 'template/TASK.md'), 'utf8');
    const existing = '<!-- garda-agent-orchestrator:managed-start -->\n' + queue()
        + '<!-- garda-agent-orchestrator:managed-end -->\n\n' + INBOX + '\nOperator-held note: preserve this.\n';
    const rendered = buildTaskContentWithExistingQueue(template, existing);
    assert.notEqual(rendered, null);
    assert.ok((rendered || '').endsWith('\n\n' + INBOX + '\nOperator-held note: preserve this.\n'));
    assert.equal((rendered || '').match(/^## Task Candidates$/gmu)?.length, 1);
    assert.deepEqual([...parseTaskQueueEntriesFromContent(rendered || '').keys()], ['T-100']);
    assert.equal(parseTaskQueueEntriesFromContent(rendered || '').get('T-100')?.profile, 'balanced');
});

test('rejects missing candidate boundaries in materialized guidance', context => {
    const { workflow, orchestration } = instructionsFixture(context);
    assert.match(workflow, /## Task Candidate Inbox/u);
    for (const field of ['source task', 'observation', 'evidence', 'suggested scope', 'severity', 'operator decision']) {
        assert.ok(workflow.includes(field), 'Missing capture field: ' + field);
    }
    assert.match(workflow, /deduplicate against both the Active Queue and existing candidates/u);
    assert.match(workflow, /Candidates never authorize execution or automatic promotion/u);
    assert.match(workflow, /explicit operator decision.*new canonical.*TODO/u);
    assert.match(workflow, /profile and required reviews/u);
    assert.match(workflow, /Mandatory findings.*fix_now.*cannot be demoted/u);
    assert.match(workflow, /optional additional-issues data.*not a prerequisite/u);
    assert.match(workflow, /CAND-001.*T-200/u);
    assert.match(orchestration, /80-task-workflow\.md.*Task Candidate Inbox/u);
    assert.match(orchestration, /non-blocking out-of-scope/u);
    assert.match(orchestration, /never promote or execute a candidate automatically/u);
    assert.match(orchestration, /normal native gates/u);
});
