import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import { resolveNextStep } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { syncDecomposedParentsToDone } from '../../../../src/gates/next-step/next-step-task-queue-status-sync';

const TASK_ID = 'T-NEXT-1';
const requireFromTest = createRequire(__filename);


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

describe('gates/next-step decomposed parent status sync', () => {
    it('marks nested decomposed parents DONE when all explicit descendants are DONE', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-322 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-409`, `T-410`, `T-411`, and `T-412` through normal gates. |',
            '| T-409 | 🟪 DECOMPOSED | P1 | workflow/task-queue-formatting-nested | Nested parent | gpt-5.5 | 2026-05-06 | strict | Child of `T-322`. Execute leaf tasks `T-413`, `T-414`, and `T-415` through normal gates. |',
            '| T-413 | 🟪 DECOMPOSED | P1 | workflow | Nested advisory parent | gpt-5.5 | 2026-05-06 | strict | Child of `T-409`. Execute child tasks `T-416` and `T-417` through normal gates. |',
            '| T-416 | 🟩 DONE | P1 | workflow | Source child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-417 | 🟩 DONE | P1 | testing | Test child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-414 | 🟩 DONE | P1 | security | Path safety child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-415 | 🟩 DONE | P1 | testing | Advisory regressions | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-410 | 🟩 DONE | P1 | workflow | Enforcement continuation | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-411 | 🟩 DONE | P1 | workflow | Materialization continuation | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-412 | 🟩 DONE | P1 | testing | Split cleanup continuation | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-322', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DONE');
        assert.equal(result.next_gate, null);
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('transitioned completed parent task(s) to DONE: T-413, T-409, T-322'));
        assert.ok(taskMd.includes('| T-322 | 🟩 DONE |'));
        assert.match(taskMd, /\| T-409\s+\| 🟩 DONE \| P1\s+\| workflow\/task-queue-formatting-nested \| Nested parent\s+\|/u);
        assert.match(taskMd, /\| T-413\s+\| 🟩 DONE \| P1\s+\| workflow\s+\| Nested advisory parent\s+\|/u);
        assert.doesNotMatch(taskMd, /^\|---\|---\|---\|---\|---\|---\|---\|---\|---\|$/mu);
    });

    it('reflows the canonical Active Queue table when decomposed parents are marked DONE', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-980 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-981` through normal gates; preserve escaped \\| pipe. |',
            '| T-981 | 🟩 DONE | P1 | workflow/task-queue-formatting | Child with longer area | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '',
            '## Блок очереди',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| RU-1 | untouched | P1 | ru | lower table | me | 2026-06-04 | balanced | stays compact |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-980', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const [upperQueue, lowerSummary] = taskMd.split('## Блок очереди');

        assert.equal(result.status, 'DONE');
        assert.equal(result.next_gate, null);
        assert.match(upperQueue, /\| T-980\s+\| 🟩 DONE \| P1\s+\| workflow\s+\| Parent\s+\| gpt-5\.5 \| 2026-05-06 \| strict\s+\| Execute child tasks `T-981` through normal gates; preserve escaped \\| pipe\. \|/u);
        assert.match(upperQueue, /\| T-981\s+\| 🟩 DONE \| P1\s+\| workflow\/task-queue-formatting \| Child with longer area \| gpt-5\.5 \| 2026-05-06 \| strict\s+\| Complete\.\s+\|/u);
        assert.doesNotMatch(upperQueue, /^\|---\|---\|---\|---\|---\|---\|---\|---\|---\|$/mu);
        assert.ok(lowerSummary.includes('|---|---|---|---|---|---|---|---|---|'));
        assert.ok(lowerSummary.includes('| RU-1 | untouched | P1 | ru | lower table | me | 2026-06-04 | balanced | stays compact |'));
    });

    it('does not rewrite TASK.md when decomposed parents are already DONE', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const content = [
            '# TASK.md',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-990 | 🟩 DONE | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-991` through normal gates. |',
            '| T-991 | 🟩 DONE | P1 | workflow/task-queue-formatting | Child with longer area | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n');
        fs.writeFileSync(taskPath, content, 'utf8');

        const result = syncDecomposedParentsToDone(repoRoot, 'T-990', ['T-990']);
        const updated = fs.readFileSync(taskPath, 'utf8');

        assert.equal(result.outcome, 'already_synced');
        assert.equal(updated, content);
    });

    it('revalidates decomposed parent completion at write time before marking DONE', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const allDoneContent = [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-800 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-801` through normal gates. |',
            '| T-801 | 🟩 DONE | P1 | workflow | Child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n');
        const changedContent = allDoneContent.replace(
            '| T-801 | 🟩 DONE |',
            '| T-801 | TODO |'
        );
        fs.writeFileSync(taskPath, changedContent, 'utf8');

        const mutableFs = requireFromTest('node:fs') as typeof fs;
        const originalReadFileSync = mutableFs.readFileSync as unknown as (
            filePath: fs.PathOrFileDescriptor,
            options?: unknown
        ) => string | Buffer;
        let taskMdReadCount = 0;
        mutableFs.readFileSync = ((filePath: fs.PathOrFileDescriptor, options?: unknown): string | Buffer => {
            if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(taskPath)) {
                taskMdReadCount += 1;
                if (taskMdReadCount === 1) {
                    return allDoneContent;
                }
            }
            return originalReadFileSync(filePath, options);
        }) as typeof fs.readFileSync;

        try {
            const result = syncDecomposedParentsToDone(repoRoot, 'T-800', ['T-800']);

            assert.equal(result.outcome, 'write_failed');
            assert.match(result.error_message || '', /write-time revalidation/u);
            const taskMd = originalReadFileSync(taskPath, 'utf8') as string;
            assert.ok(taskMd.includes('| T-800 | 🟪 DECOMPOSED |'));
            assert.ok(taskMd.includes('| T-801 | TODO |'));
        } finally {
            mutableFs.readFileSync = originalReadFileSync as unknown as typeof fs.readFileSync;
        }
    });

    it('revalidates already-DONE nested parent descendants at write time before marking root DONE', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const allDoneContent = [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-900 | 🟪 DECOMPOSED | P1 | workflow | Root parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-901` through normal gates. |',
            '| T-901 | 🟪 DECOMPOSED | P1 | workflow | Nested parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-902` through normal gates. |',
            '| T-902 | 🟩 DONE | P1 | workflow | Nested child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n');
        const changedContent = allDoneContent
            .replace('| T-901 | 🟪 DECOMPOSED |', '| T-901 | 🟩 DONE |')
            .replace('| T-902 | 🟩 DONE |', '| T-902 | TODO |');
        fs.writeFileSync(taskPath, changedContent, 'utf8');

        const mutableFs = requireFromTest('node:fs') as typeof fs;
        const originalReadFileSync = mutableFs.readFileSync as unknown as (
            filePath: fs.PathOrFileDescriptor,
            options?: unknown
        ) => string | Buffer;
        let taskMdReadCount = 0;
        mutableFs.readFileSync = ((filePath: fs.PathOrFileDescriptor, options?: unknown): string | Buffer => {
            if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(taskPath)) {
                taskMdReadCount += 1;
                if (taskMdReadCount === 1) {
                    return allDoneContent;
                }
            }
            return originalReadFileSync(filePath, options);
        }) as typeof fs.readFileSync;

        try {
            const result = syncDecomposedParentsToDone(repoRoot, 'T-900', ['T-900']);

            assert.equal(result.outcome, 'write_failed');
            assert.match(result.error_message || '', /write-time revalidation/u);
            const taskMd = originalReadFileSync(taskPath, 'utf8') as string;
            assert.ok(taskMd.includes('| T-900 | 🟪 DECOMPOSED |'));
            assert.ok(taskMd.includes('| T-901 | 🟩 DONE |'));
            assert.ok(taskMd.includes('| T-902 | TODO |'));
        } finally {
            mutableFs.readFileSync = originalReadFileSync as unknown as typeof fs.readFileSync;
        }
    });

    it('ignores T-408-style operational backticks after an explicit child list', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-408 | 🟪 DECOMPOSED | P0 | workflow | Split parent | gpt-5.5 | 2026-05-06 | strict | Parent stopped after scope-budget split. Child tasks: `T-420`, `T-421`, and `T-422`. Continue via child tasks and let `next-step` transition this parent to `DECOMPOSED` after detecting the linked children. |',
            '| T-420 | 🟩 DONE | P0 | workflow | First child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-421 | 🟩 DONE | P1 | docs | Second child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-422 | 🟩 DONE | P1 | testing | Third child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-408', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DONE');
        assert.equal(result.next_gate, null);
        assert.ok(!result.reason.includes('next-step'));
        assert.ok(!result.reason.includes('DECOMPOSED`'));
        assert.ok(taskMd.includes('| T-408 | 🟩 DONE |'));
    });

    it('rolls back decomposed parent DONE sync when mandatory completion event append fails', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-950 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-951` through normal gates; preserve escaped \\| pipe. |',
            '| T-951 | 🟩 DONE | P1 | workflow/task-queue-formatting | Child with longer area | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '',
            '## Блок очереди',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| RU-1 | untouched | P1 | ru | lower table | me | 2026-06-04 | balanced | stays compact |',
            ''
        ].join('\n'), 'utf8');
        const targetEventPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            'T-950.jsonl'
        );
        const mutableFs = requireFromTest('node:fs') as typeof fs;
        const originalOpenSync = mutableFs.openSync;
        mutableFs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
            const opensForAppend = typeof flags === 'number'
                ? (flags & fs.constants.O_APPEND) !== 0
                : String(flags).includes('a');
            if (opensForAppend && typeof filePath === 'string' && path.resolve(filePath) === path.resolve(targetEventPath)) {
                throw new Error('forced event append failure');
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fs.openSync;

        try {
            const result = resolveNextStep({ taskId: 'T-950', repoRoot });
            const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
            const [upperQueue, lowerSummary] = taskMd.split('## Блок очереди');

            assert.equal(result.status, 'DECOMPOSED');
            assert.equal(result.next_gate, 'task-status-sync');
            assert.ok(result.reason.includes('Rolled back TASK.md status changes'));
            assert.match(upperQueue, /\| T-950\s+\| 🟪 DECOMPOSED \| P1\s+\| workflow\s+\| Parent\s+\| gpt-5\.5 \| 2026-05-06 \| strict\s+\| Execute child tasks `T-951` through normal gates; preserve escaped \\| pipe\. \|/u);
            assert.doesNotMatch(upperQueue, /^\|---\|---\|---\|---\|---\|---\|---\|---\|---\|$/mu);
            assert.ok(lowerSummary.includes('|---|---|---|---|---|---|---|---|---|'));
        } finally {
            mutableFs.openSync = originalOpenSync;
        }
    });

    it('records a compensating status event before rolling back when completion event append fails', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-960 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-961` through normal gates. |',
            '| T-961 | 🟩 DONE | P1 | workflow | Child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');
        const targetEventPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            'T-960.jsonl'
        );
        const mutableFs = requireFromTest('node:fs') as typeof fs;
        const originalOpenSync = mutableFs.openSync;
        let targetOpenCount = 0;
        mutableFs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
            const opensForAppend = typeof flags === 'number'
                ? (flags & fs.constants.O_APPEND) !== 0
                : String(flags).includes('a');
            if (opensForAppend && typeof filePath === 'string' && path.resolve(filePath) === path.resolve(targetEventPath)) {
                targetOpenCount += 1;
                if (targetOpenCount === 2) {
                    throw new Error('forced completion event append failure');
                }
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fs.openSync;

        try {
            const result = resolveNextStep({ taskId: 'T-960', repoRoot });
            const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
            const eventLog = fs.readFileSync(targetEventPath, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> });
            const statusEvents = eventLog.filter((event) => event.event_type === 'STATUS_CHANGED');

            assert.equal(result.status, 'DECOMPOSED');
            assert.equal(result.next_gate, 'task-status-sync');
            assert.ok(result.reason.includes('Compensating STATUS_CHANGED event(s) recorded for: T-960'));
            assert.ok(result.reason.includes('Rolled back TASK.md status changes for: T-960'));
            assert.ok(taskMd.includes('| T-960 | 🟪 DECOMPOSED |'));
            assert.deepEqual(statusEvents.map((event) => event.details?.new_status), ['DONE', 'DECOMPOSED']);
        } finally {
            mutableFs.openSync = originalOpenSync;
        }
    });

    it('fails closed when the shared TASK.md status lock is held during decomposed parent sync', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const lockPath = `${taskPath}.garda-status-sync.lock`;
        fs.writeFileSync(taskPath, [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-970 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-971` through normal gates. |',
            '| T-971 | 🟩 DONE | P1 | workflow | Child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(lockPath, 'held by another status sync\n', 'utf8');

        try {
            const result = resolveNextStep({ taskId: 'T-970', repoRoot });
            const taskMd = fs.readFileSync(taskPath, 'utf8');

            assert.equal(result.status, 'DECOMPOSED');
            assert.equal(result.next_gate, 'task-status-sync');
            assert.ok(result.reason.includes('Could not acquire TASK.md status-sync lock'));
            assert.ok(taskMd.includes('| T-970 | 🟪 DECOMPOSED |'));
        } finally {
            fs.unlinkSync(lockPath);
        }
    });
});
