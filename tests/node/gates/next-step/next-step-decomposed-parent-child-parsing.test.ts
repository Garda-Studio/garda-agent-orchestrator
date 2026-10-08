import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import {
    extractExplicitLinkedChildTaskIds,
    formatDecomposedTaskProvenanceNote,
    readDecomposedTaskProvenance
} from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';

const TASK_ID = 'T-NEXT-1';

describe('exact task identities in child links', () => {
    it('keeps T-9 distinct from T-90 and F1 distinct from F10', () => {
        const ids = ['T-9', 'T-90', 'T-PARENT-F1', 'T-PARENT-F10'];
        assert.deepEqual(extractExplicitLinkedChildTaskIds('Child tasks: `T-90`, `T-PARENT-F10`.', ids),
            ['T-90', 'T-PARENT-F10']);
    });

    it('keeps direct review follow-ups separate from numeric and nested infrastructure children', () => {
        const ids = ['T-PARENT-F1', 'T-PARENT-F10', 'T-PARENT-Future', 'T-PARENT-1', 'T-PARENT-F1-I1'];
        const mentions = ids.map(id => `\`${id}\``).join(', ');
        assert.deepEqual(extractExplicitLinkedChildTaskIds(`Review follow-up tasks materialized: ${mentions}; artifact \`result.json\`.`,
            ids, 'T-PARENT'), ['T-PARENT-F1', 'T-PARENT-F10']);
        assert.deepEqual(extractExplicitLinkedChildTaskIds('Child tasks: `T-PARENT-1`, `T-PARENT-F1-I1`.', ids, 'T-PARENT'),
            ['T-PARENT-1', 'T-PARENT-F1-I1']);
    });
});


let tempRoots: string[] = [];


function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'template', 'docs', 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | ux/test | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |`,
        ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
        SourceOfTruth: 'Codex'
    });
    for (const ruleFile of [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]) {
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', ruleFile),
            `# ${ruleFile}\n`,
            'utf8'
        );
    }
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.full_suite_validation.command = 'npm test';
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
    fs.writeFileSync(
        path.join(repoRoot, 'template', 'docs', 'prompts', 'review-cycle-auto-split.md'),
        [
            '# Review Cycle Auto-Split Prompt for {{TASK_ID}}',
            '',
            'GuardReason: {{GUARD_REASON}}',
            'Counts: total_non_test_reviews={{TOTAL_NON_TEST_REVIEWS}}; failed_non_test_reviews={{FAILED_NON_TEST_REVIEWS}}; excluded_review_types={{EXCLUDED_REVIEW_TYPES}}',
            'LatestFailedReview: {{LATEST_FAILED_REVIEW}}',
            'SuggestedChildTaskIds: {{SUGGESTED_CHILD_TASK_IDS}}',
            'SuggestedReviewerFollowUpTaskId: {{SUGGESTED_FOLLOWUP_TASK_ID}}',
            '',
            '## Instructions',
            '1. Treat the parent as SPLIT_REQUIRED, create linked parent-derived suffix task IDs, then rerun next-step so the gate moves it to DECOMPOSED.',
            '2. Allocate child ids from {{SUGGESTED_CHILD_TASK_IDS}}.',
            '',
            '## Constraints',
            '- Do not mark the parent DONE merely because child tasks were created.',
            '- Do not hand-edit the parent status to bypass SPLIT_REQUIRED.',
            '- Reviewer follow-ups use {{SUGGESTED_FOLLOWUP_TASK_ID}} style ids.',
            ''
        ].join('\n'),
        'utf8'
    );
    return repoRoot;
}



function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}








































afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step decomposed parent child parsing', () => {
    it('does not mark decomposed parents DONE when an explicit range child is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-601 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Split into child tasks `T-602` through `T-603`. |',
            '| T-602 | 🟩 DONE | P1 | workflow | Existing child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-601', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('Explicit child task link(s) could not be found'));
        assert.ok(result.reason.includes('T-603'));
        assert.ok(taskMd.includes('| T-601 | 🟪 DECOMPOSED |'));
    });

    it('does not mark decomposed parents DONE when a backticked explicit child is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-604 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Split into child tasks `T-CUSTOM-CHILD` and `T-605`. |',
            '| T-605 | 🟩 DONE | P1 | workflow | Existing child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-604', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('Explicit child task link(s) could not be found'));
        assert.ok(result.reason.includes('T-CUSTOM-CHILD'));
        assert.ok(taskMd.includes('| T-604 | 🟪 DECOMPOSED |'));
    });

    it('does not mark decomposed parents DONE when a plain conventional child ID is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-700 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Split into child tasks T-701 and T-702. |',
            '| T-701 | 🟩 DONE | P1 | workflow | Existing child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-700', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('Explicit child task link(s) could not be found'));
        assert.ok(result.reason.includes('T-702'));
        assert.ok(taskMd.includes('| T-700 | 🟪 DECOMPOSED |'));
    });

    it('stops explicit child parsing before then-continue note text', () => {
        const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
            'Split into child tasks T-711, then continue with T-712 as unrelated operator guidance.',
            ['T-711', 'T-712']
        );

        assert.deepEqual(linkedChildTaskIds, ['T-711']);
    });

    it('parses plain comma-separated suffixed child task IDs in explicit child lists', () => {
        const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
            'Child tasks: T-091-1, T-091-2.',
            ['T-091-1', 'T-091-2']
        );

        assert.deepEqual(linkedChildTaskIds, ['T-091-1', 'T-091-2']);
    });

    it('records structured manual provenance with a compact child range', () => {
        const notes = formatDecomposedTaskProvenanceNote({
            source: 'manual-operator',
            childTaskIds: ['T-957-1', 'T-957-2'],
            recordedOn: '2026-07-24'
        });

        assert.equal(
            notes,
            'Decomposition source: manual-operator (2026-07-24); child range `T-957-1` through `T-957-2`; execute sequentially.'
        );
        assert.deepEqual(readDecomposedTaskProvenance(notes), {
            source: 'manual-operator',
            evidence: 'structured-note'
        });
        assert.deepEqual(
            extractExplicitLinkedChildTaskIds(notes, ['T-957-1', 'T-957-2'], 'T-957'),
            ['T-957-1', 'T-957-2']
        );
    });

    it('preserves mixed-width numeric child IDs as an explicit list', () => {
        const childTaskIds = ['T-970-1', 'T-970-02'];
        const notes = formatDecomposedTaskProvenanceNote({
            source: 'manual-agent',
            childTaskIds
        });

        assert.match(notes, /child tasks: `T-970-1`, `T-970-02`/u);
        assert.doesNotMatch(notes, /child range/u);
        assert.deepEqual(
            extractExplicitLinkedChildTaskIds(notes, childTaskIds, 'T-970'),
            childTaskIds
        );
    });

    it('preserves large child sets as an explicit list instead of an unparseable range', () => {
        const childTaskIds = Array.from({ length: 102 }, (_, index) => `T-971-${index + 1}`);
        const notes = formatDecomposedTaskProvenanceNote({
            source: 'manual-operator',
            childTaskIds
        });

        assert.doesNotMatch(notes, /child range/u);
        assert.deepEqual(
            extractExplicitLinkedChildTaskIds(notes, childTaskIds, 'T-971'),
            childTaskIds
        );
    });

    it('round-trips contiguous numeric child IDs above Number.MAX_SAFE_INTEGER', () => {
        const childTaskIds = ['T-971-9007199254740992', 'T-971-9007199254740993'];
        const notes = formatDecomposedTaskProvenanceNote({
            source: 'manual-agent',
            childTaskIds
        });

        assert.match(notes, /child range/u);
        assert.deepEqual(
            extractExplicitLinkedChildTaskIds(notes, childTaskIds, 'T-971'),
            childTaskIds
        );
    });

    it('fails closed when any provenance child ID is invalid', () => {
        assert.throws(
            () => formatDecomposedTaskProvenanceNote({
                source: 'manual-agent',
                childTaskIds: ['T-972-1', 'not a task id', 'T-972-3']
            }),
            /index 1.*not a task id/u
        );
    });

    it('fails closed when provenance contains fewer than two distinct child IDs', () => {
        assert.throws(
            () => formatDecomposedTaskProvenanceNote({
                source: 'manual-agent',
                childTaskIds: ['T-972-1']
            }),
            /At least two distinct canonical child task ids/u
        );
        assert.throws(
            () => formatDecomposedTaskProvenanceNote({
                source: 'manual-agent',
                childTaskIds: ['T-972-1', 'T-972-1']
            }),
            /At least two distinct canonical child task ids/u
        );
    });

    it('fails closed for unsupported provenance sources and invalid dates', () => {
        assert.throws(
            () => formatDecomposedTaskProvenanceNote({
                source: 'manual-agent-extra' as never,
                childTaskIds: ['T-973-1', 'T-973-2']
            }),
            /Unsupported decomposition provenance source/u
        );
        assert.throws(
            () => formatDecomposedTaskProvenanceNote({
                source: 'manual-agent',
                childTaskIds: ['T-973-1', 'T-973-2'],
                recordedOn: '2026-02-30'
            }),
            /recordedOn must use a valid YYYY-MM-DD date/u
        );
    });

    it('rejects structured provenance with impossible or malformed dates when reading notes', () => {
        for (const recordedOn of ['2026-02-30', '2026/02/28', '']) {
            assert.deepEqual(
                readDecomposedTaskProvenance(
                    `Decomposition source: manual-agent (${recordedOn}); child tasks: \`T-973-1\`, \`T-973-2\`.`
                ),
                {
                    source: 'unrecorded',
                    evidence: 'none'
                }
            );
        }
        assert.deepEqual(
            readDecomposedTaskProvenance(
                'Decomposition source: manual-agent (2026-02-30); manual agent decomposition; '
                + 'child tasks: `T-973-1`, `T-973-2`.'
            ),
            {
                source: 'unrecorded',
                evidence: 'none'
            }
        );
    });

    it('rejects structured provenance source tokens with unsupported suffixes', () => {
        assert.deepEqual(
            readDecomposedTaskProvenance(
                'Decomposition source: manual-agent-extra; child range `T-958-1` through `T-958-2`.'
            ),
            {
                source: 'unrecorded',
                evidence: 'none'
            }
        );
        assert.deepEqual(
            readDecomposedTaskProvenance(
                'Decomposition source: manual-agent.extra; child range `T-958-1` through `T-958-2`.'
            ),
            {
                source: 'unrecorded',
                evidence: 'none'
            }
        );
    });

    it('parses the legacy manual operator child-range convention', () => {
        const notes =
            'Manual operator-requested decomposition (2026-07-24): child range T-957-1 through T-957-2; execute sequentially.';

        assert.deepEqual(readDecomposedTaskProvenance(notes), {
            source: 'manual-operator',
            evidence: 'legacy-manual-note'
        });
        assert.deepEqual(
            extractExplicitLinkedChildTaskIds(notes, ['T-957-1', 'T-957-2'], 'T-957'),
            ['T-957-1', 'T-957-2']
        );
    });

    it('ignores task IDs in unrelated note segments after explicit child links', () => {
        const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
            'Split into child tasks `T-721`. Security review artifact `T-722` and source note T-723 are unrelated.',
            ['T-721', 'T-722', 'T-723']
        );

        assert.deepEqual(linkedChildTaskIds, ['T-721']);
    });

    it('routes a manually decomposed parent to the next unfinished child without gate-owned decomposition artifacts', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-957 | 🟪 DECOMPOSED | P1 | release | Parent | gpt-5.5 | 2026-07-24 | balanced | Manual operator-requested decomposition (2026-07-24): child range T-957-1 through T-957-2; execute sequentially. |',
            '| T-957-1 | 🟩 DONE | P1 | release | First child | gpt-5.5 | 2026-07-24 | balanced | Child of `T-957`. |',
            '| T-957-2 | 🟦 TODO | P1 | release | Second child | gpt-5.5 | 2026-07-24 | balanced | Child of `T-957`. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-957', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-957-2"'));
        assert.match(result.reason, /manual operator decomposition provenance/iu);
        assert.match(result.reason, /gate-owned decomposition artifacts are not required/iu);
    });

    it('does not treat structured single-child provenance as a valid decomposition', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-958 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-07-24 | balanced | Decomposition source: manual-agent; child tasks: `T-958-1`; execute sequentially. |',
            '| T-958-1 | 🟩 DONE | P1 | workflow | Child | gpt-5.5 | 2026-07-24 | balanced | Child of `T-958`. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-958', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.equal(result.commands.length, 0);
        assert.ok(taskMd.includes('| T-958 | 🟪 DECOMPOSED |'));
        assert.match(result.reason, /manual agent decomposition provenance/iu);
    });

    it('does not route an unfinished child from structured single-child provenance', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-958 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-07-24 | balanced | Decomposition source: manual-agent; child tasks: `T-958-1`; execute sequentially. |',
            '| T-958-1 | 🟦 TODO | P1 | workflow | Child | gpt-5.5 | 2026-07-24 | balanced | Child of `T-958`. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-958', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.equal(result.commands.length, 0);
    });

    it('does not route malformed structured provenance even when legacy wording is present', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-958 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-07-24 | balanced | Decomposition source: manual-agent (2026-02-30); manual agent decomposition; child tasks: `T-958-1`, `T-958-2`. |',
            '| T-958-1 | 🟦 TODO | P1 | workflow | First child | gpt-5.5 | 2026-07-24 | balanced | Child of `T-958`. |',
            '| T-958-2 | 🟦 TODO | P1 | workflow | Second child | gpt-5.5 | 2026-07-24 | balanced | Child of `T-958`. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-958', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.equal(result.commands.length, 0);
        assert.doesNotMatch(result.reason, /gate-owned decomposition artifacts are not required/iu);
    });

    it('does not infer manual children when provenance lacks an explicit child list or range', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-959 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-07-24 | balanced | Decomposition source: manual-agent. |',
            '| T-959-1 | 🟦 TODO | P1 | workflow | Unlinked candidate | gpt-5.5 | 2026-07-24 | balanced | Child of `T-959`. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-959', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.equal(result.commands.length, 0);
        assert.match(result.reason, /Do not execute the parent directly/iu);
        assert.match(result.reason, /do not infer candidates from unrelated task IDs/iu);
        assert.equal(result.reason.includes('T-959-1'), false);
    });

    it('closes a manually decomposed parent after every explicit child is done without decomposition artifacts', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-960 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-07-24 | balanced | Decomposition source: manual-operator; child range `T-960-1` through `T-960-2`; execute sequentially. |',
            '| T-960-1 | 🟩 DONE | P1 | workflow | First child | gpt-5.5 | 2026-07-24 | balanced | Child of `T-960`. |',
            '| T-960-2 | 🟩 DONE | P1 | workflow | Second child | gpt-5.5 | 2026-07-24 | balanced | Child of `T-960`. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-960', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DONE');
        assert.match(result.reason, /manual operator decomposition provenance/iu);
        assert.ok(taskMd.includes('| T-960 | 🟩 DONE |'));
        assert.equal(
            fs.existsSync(path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'reviews',
                'T-960-strict-decomposition-decision.json'
            )),
            false
        );
    });

    it('routes decomposed parent tasks to nonnumeric child task IDs', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-520 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-NEXT-1`; continue there. |',
            '| T-NEXT-1 | 🟦 TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-520', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-NEXT-1"'));
    });

    it('routes suffixed child task IDs without partially matching their parent prefix', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-500 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-500-1`. |',
            '| T-500-1 | 🟦 TODO | P1 | workflow | Suffixed child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-500', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-500-1"'));
        assert.equal(result.reason.includes('could not be found'), false);
    });

    it('does not mark a decomposed parent DONE while a plain suffixed comma child remains unfinished', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-091 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: T-091-1, T-091-2. |',
            '| T-091-1 | 🟩 DONE | P1 | workflow | First child | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-091-2 | 🟦 TODO | P1 | workflow | Second child | gpt-5.4 | 2026-05-05 | strict | Still open. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-091', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-091-2"'));
        assert.ok(taskMd.includes('| T-091 | 🟪 DECOMPOSED |'));
    });

    it('does not mark decomposed parents DONE when a plain suffixed comma child row is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-091 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: T-091-1, T-091-2. |',
            '| T-091-1 | 🟩 DONE | P1 | workflow | First child | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-091', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('Explicit child task link(s) could not be found'));
        assert.ok(result.reason.includes('T-091-2'));
        assert.ok(taskMd.includes('| T-091 | 🟪 DECOMPOSED |'));
    });

    it('routes decomposed parents to exact-case semantic child task IDs', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-530 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-CLI-ART` and `T-next-1`; continue with the first unfinished child. |',
            '| T-CLI-ART | 🟩 DONE | P1 | workflow | First child | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-next-1 | 🟦 TODO | P1 | workflow | Mixed-case child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-530', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-next-1"'));
        assert.equal(result.commands[0].command.includes('T-NEXT-1'), false);
    });

    it('preserves parent note order for semantic child task IDs', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-540 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-A` and `T-LONG-CHILD`; continue with the first unfinished child. |',
            '| T-A | 🟦 TODO | P1 | workflow | Short child | gpt-5.4 | 2026-05-05 | strict | First. |',
            '| T-LONG-CHILD | 🟦 TODO | P1 | workflow | Long child | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-540', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-A"'));
    });

    it('preserves range prefix casing for numeric child task IDs', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-550 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-Case-1` through `T-Case-3`; continue through the range. |',
            '| T-Case-1 | 🟩 DONE | P1 | workflow | First | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-Case-2 | 🟦 TODO | P1 | workflow | Second | gpt-5.4 | 2026-05-05 | strict | Next. |',
            '| T-Case-3 | 🟦 TODO | P1 | workflow | Third | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-550', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-Case-2"'));
        assert.equal(result.commands[0].command.includes('T-CASE-2'), false);
    });

    it('does not pad variable-width numeric child task ranges', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-552 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-9` through `T-11`. |',
            '| T-9 | TODO | P1 | workflow | First | gpt-5.4 | 2026-05-05 | strict | Next. |',
            '| T-10 | TODO | P1 | workflow | Second | gpt-5.4 | 2026-05-05 | strict | Later. |',
            '| T-11 | TODO | P1 | workflow | Third | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-552', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-9"'));
        assert.equal(result.commands[0].command.includes('T-09'), false);
    });

    it('does not synthesize mixed-prefix numeric child task ranges', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-554 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-001` through `T-ALT-003`. |',
            '| T-001 | DONE | P1 | workflow | First | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-002 | TODO | P1 | workflow | Mixed middle | gpt-5.4 | 2026-05-05 | strict | Should not be synthesized. |',
            '| T-ALT-003 | TODO | P1 | workflow | Literal endpoint | gpt-5.4 | 2026-05-05 | strict | Endpoint. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-554', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-ALT-003"'));
        assert.equal(result.commands[0].command.includes('T-002'), false);
    });

    it('does not treat malformed status substrings as lifecycle tokens', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-560 | NOT_DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-561`. |',
            '| T-561 | TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-560', repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.status, 'DECOMPOSED');
        assert.notEqual(result.next_gate, 'child-task');
        assert.equal(text.includes('next-step "T-561"'), false);
    });

    it('does not treat suffixed status tokens as lifecycle tokens', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-562 | DECOMPOSED/blocked | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-563`. |',
            '| T-563 | DONE-ish | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Not canonical. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-562', repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.status, 'DECOMPOSED');
        assert.notEqual(result.next_gate, 'child-task');
        assert.equal(text.includes('next-step "T-563"'), false);
    });

    it('does not skip children whose status only contains DONE as a substring', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-570 | DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-571` through `T-572`. |',
            '| T-571 | UNDONE | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Not complete. |',
            '| T-572 | TODO | P1 | workflow | Later child | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-570', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-571"'));
    });

    it('fails closed when requested task ID casing differs from TASK.md', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-next-1 | DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-next-2`. |',
            '| T-next-2 | TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-NEXT-1', repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'task-id-casing');
        assert.ok(result.commands[0].command.includes('next-step "T-next-1"'));
    });
});
