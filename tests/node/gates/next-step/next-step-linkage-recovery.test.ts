import test, { mock } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleCompletionGate } from '../../../../src/cli/commands/gate-task-handlers';
import { runClassifyChangeCommand, runCompileGateCommand, runDocImpactGateCommand } from '../../../../src/cli/commands/gates';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import * as taskEvents from '../../../../src/gate-runtime/timeline/task-events-io';
import * as compactLifecycle from '../../../../src/core/compact/lifecycle';
import { parseCanonicalActiveTaskQueue } from '../../../../src/core/task-md-table';
import { resolveNextStep } from '../../../../src/gates/next-step/next-step';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { readCloseoutLinkageRecovery } from '../../../../src/gates/completion/completion-linkage-recovery';
import { writeBudgetOutputFilters } from '../../cli/commands/gate-test-helpers';
import {
    createTempRepo, initializeGitRepo, seedTaskQueue, seedInitAnswers,
    runEnterTaskMode, loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask,
    loadPostPreflightRulePack, writeCleanReviewArtifact, runRequiredReviewsCheckCommand,
    getOrchestratorRoot, getReviewsRoot, readTaskTimelineEvents
} from '../../cli/commands/gates/completion/gates-completion-fixtures';

const taskId = 'T-903-linkage-retry';
const followUpId = `${taskId}-F1`;
const details = {
    defect_id: 'linkage-fixture', summary: 'Closeout linkage regression',
    resolution: 'fixed_in_current_task', problem_record_id: taskId
};

async function seedFailedCloseout(problemRecordId = taskId, crossReference = false): Promise<{ repoRoot: string; preflightPath: string }> {
    const repoRoot = createTempRepo();
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/\n');
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    const taskPath = path.join(repoRoot, 'TASK.md');
    const content = fs.readFileSync(taskPath, 'utf8');
    const row = parseCanonicalActiveTaskQueue(content).rows[0].rawLine;
    fs.writeFileSync(taskPath, `- Other instruction for ${taskId}: ${taskId}\n\n` + content.replace(row,
        `${row}\n| T-904-existing | TODO | P2 | test | Existing neighbor | unassigned | 2026-10-06 | default | Original row. |`));
    seedInitAnswers(repoRoot);
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Closeout linkage regression', plannedChangedFiles: ['src/app.ts'] });
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    fs.appendFileSync(path.join(repoRoot, 'src/app.ts'), '\nexport const reviewedChange = 1;\n');
    const classified = runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Closeout linkage regression',
        changedFiles: ['src/app.ts'], outputPath: preflightPath, emitMetrics: false });
    assert.equal((JSON.parse(classified.outputText) as { task_id: string }).task_id, taskId);
    loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
    await runCompileGateCommand({ repoRoot, taskId, preflightPath, outputFiltersPath, emitMetrics: false });
    writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as { required_reviews: Record<string, boolean> };
    if (preflight.required_reviews.test) writeCleanReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');
    assert.equal(runRequiredReviewsCheckCommand({ repoRoot, taskId, preflightPath, outputFiltersPath, emitMetrics: false }).exitCode, 0);
    assert.equal(runDocImpactGateCommand({ repoRoot, taskId, preflightPath,
        decision: 'NO_DOC_UPDATES', behaviorChanged: false, changelogUpdated: false,
        rationale: 'No public behavior changes in this isolated lifecycle fixture.', emitMetrics: false }).exitCode, 0);
    fs.appendFileSync(path.join(repoRoot, 'TASK.md'), `\n\n## Orchestrator Problems\n- ${problemRecordId}: ${taskId}\n${problemRecordId === taskId ? '' : `- ${problemRecordId}0: reference ${taskId}\n`}`);
    if (crossReference) fs.appendFileSync(taskPath, `- T-99: related to ${problemRecordId} and ${taskId}\n- Other note: see ${problemRecordId} and ${taskId}\n`);
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED', 'PASSED', 'test',
        { ...details, problem_record_id: problemRecordId, follow_up_task_id: taskId });
    await assert.rejects(handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]),
        /final closeout materialization/);
    const failure = readTaskTimelineEvents(repoRoot, taskId).reverse().find(event => event.event_type === 'COMPLETION_GATE_FAILED');
    assert.ok((failure?.details as Record<string, unknown>)?.closeout_linkage_recovery, JSON.stringify(failure?.details));
    return { repoRoot, preflightPath };
}

function correctLink(repoRoot: string, problemRecordId = taskId): void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    let content = fs.readFileSync(taskPath, 'utf8');
    content = content.replace('\n\n## Orchestrator Problems',
        `\n| ${followUpId} | TODO | P2 | test | Verify integrated linkage | unassigned | 2026-10-06 | default | durable follow-up |\n\n## Orchestrator Problems`);
    fs.writeFileSync(taskPath, content.replace(`- ${problemRecordId}: ${taskId}`, `- ${problemRecordId}: ${followUpId}`));
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED', 'PASSED', 'test',
        { ...details, problem_record_id: problemRecordId, follow_up_task_id: followUpId });
}

test('native closeout retries a corrected distinct follow-up without relaunching validation', async () => {
    const { repoRoot, preflightPath } = await seedFailedCloseout();
    try {
        const before = readTaskTimelineEvents(repoRoot, taskId);
        correctLink(repoRoot);
        assert.ok(readCloseoutLinkageRecovery(repoRoot, taskId, preflightPath,
            path.join(getOrchestratorRoot(repoRoot), 'runtime/task-events', `${taskId}.jsonl`)),
        'Canonical correction must retain eligibility.');
        const next = resolveNextStep({ repoRoot, taskId });
        assert.equal(next.next_gate, 'completion-gate', JSON.stringify({ gate: next.next_gate, reason: next.reason }));
        await handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]);
        const summary = buildTaskAuditSummary({ repoRoot, taskId });
        assert.equal(summary.status, 'PASS', JSON.stringify(summary.blockers));
        assert.equal(summary.final_closeout.status, 'READY');
        const after = readTaskTimelineEvents(repoRoot, taskId);
        for (const eventType of ['PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_RECORDED', 'REVIEWER_DELEGATION_STARTED']) {
            assert.equal(after.filter(event => event.event_type === eventType).length,
                before.filter(event => event.event_type === eventType).length, eventType);
        }
        assert.ok(after.some(event => event.event_type === 'COMPLETION_GATE_FAILED'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('closeout metadata recovery rejects source, policy, evidence, queue and history drift', async (t) => {
    const { repoRoot, preflightPath } = await seedFailedCloseout('T-1');
    const negativeDetails = { ...details, problem_record_id: 'T-1' };
    try {
        correctLink(repoRoot, 'T-1');
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime/task-events', `${taskId}.jsonl`);
        const readProof = () => readCloseoutLinkageRecovery(repoRoot, taskId, preflightPath, timelinePath);
        assert.ok(readProof());
        const receiptName = fs.readdirSync(getReviewsRoot(repoRoot)).find(name => name.includes('code') && name.includes('receipt'));
        assert.ok(receiptName);
        const cases: Array<[string, string, (text: string) => string]> = [
            ['checked source', 'src/app.ts', text => text + '\nexport const drift = 2;'],
            ['preflight tampering', path.relative(repoRoot, preflightPath), text => text.replace(taskId, 'T-foreign')],
            ['review receipt', path.relative(repoRoot, path.join(getReviewsRoot(repoRoot), receiptName)), text => text + ' '],
            ['protected rules', path.relative(repoRoot, path.join(getOrchestratorRoot(repoRoot), 'live/docs/agent-rules/00-core.md')), text => text + '\nchanged'],
            ['workflow policy', path.relative(repoRoot, path.join(getOrchestratorRoot(repoRoot), 'live/config/workflow-config.json')), text => text + ' '],
            ['existing task contract', 'TASK.md', text => text.replace('| fixture |', '| altered contract |')],
            ['unrelated task document', 'TASK.md', text => text + '\nUnrelated instruction change\n'],
            ['task line-ending drift', 'TASK.md', text => text.replace(/\r?\n/gu, text.includes('\r\n') ? '\n' : '\r\n')],
            ['row outside canonical queue', 'TASK.md', text => text + parseCanonicalActiveTaskQueue(text).rows[0].rawLine + '\n'],
            ['existing queue row reordering', 'TASK.md', text => {
                const rows = parseCanonicalActiveTaskQueue(text).rows;
                const lines = text.split(/\r?\n/u);
                [lines[rows[0].lineIndex], lines[rows[1].lineIndex]] = [lines[rows[1].lineIndex], lines[rows[0].lineIndex]];
                return lines.join('\n');
            }],
            ['link outside problems section', 'TASK.md', text => text.replace(`- Other instruction for ${taskId}: ${taskId}`, `- Other instruction for ${taskId}: ${followUpId}`)],
            ['prefix-colliding problem record', 'TASK.md', text => text.replace(`- T-10: reference ${taskId}`, `- T-10: reference ${followUpId}`)],
            ['follow-up must be TODO', 'TASK.md', text => text.replace(`| ${followUpId} | TODO`, `| ${followUpId} | DONE`)],
            ['unrelated task addition', 'TASK.md', text => text.replace('\n\n## Orchestrator Problems', '\n| T-unrelated | TODO | P2 | test | Extra | unassigned | 2026-10-06 | default | extra |\n\n## Orchestrator Problems')]
        ];
        for (const [name, relativePath, mutate] of cases) await t.test(name, () => {
            const target = path.join(repoRoot, relativePath);
            const original = fs.readFileSync(target);
            try { fs.writeFileSync(target, mutate(original.toString())); assert.equal(readProof(), null); }
            finally { fs.writeFileSync(target, original); }
            assert.ok(readProof());
        });
        const source = path.join(repoRoot, 'src/app.ts');
        const originalSource = fs.readFileSync(source);
        fs.unlinkSync(source);
        assert.equal(readProof(), null, 'deletion');
        fs.writeFileSync(source, originalSource);
        fs.renameSync(source, source + '.renamed');
        assert.equal(readProof(), null, 'rename');
        fs.renameSync(source + '.renamed', source);
        const wip = path.join(repoRoot, 'unrelated.txt');
        fs.writeFileSync(wip, 'unrelated WIP');
        assert.equal(readProof(), null, 'unrelated WIP');
        fs.unlinkSync(wip);
        const head = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        execFileSync('git', ['-C', repoRoot, 'commit', '--allow-empty', '-m', 'fixture head drift']);
        assert.equal(readProof(), null, 'HEAD drift');
        execFileSync('git', ['-C', repoRoot, 'update-ref', 'HEAD', head]);
        assert.ok(readProof());
        const receipt = path.join(getReviewsRoot(repoRoot), receiptName);
        fs.renameSync(receipt, receipt + '.missing');
        assert.equal(readProof(), null, 'missing evidence');
        fs.renameSync(receipt + '.missing', receipt);
        const version = Object.getOwnPropertyDescriptor(process, 'version');
        try { Object.defineProperty(process, 'version', { value: 'v99.0.0' }); assert.equal(readProof(), null, 'runtime identity'); }
        finally { if (version) Object.defineProperty(process, 'version', version); }
        const timeline = fs.readFileSync(timelinePath);
        try { fs.appendFileSync(timelinePath, 'tampered timeline'); assert.equal(readProof(), null, 'timeline integrity'); }
        finally { fs.writeFileSync(timelinePath, timeline); }
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED', 'PASSED', 'test',
            { ...negativeDetails, summary: 'Different defect contract', follow_up_task_id: followUpId });
        assert.equal(readProof(), null, 'superseding acknowledgement changes contract');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED', 'PASSED', 'test',
            { ...negativeDetails, follow_up_task_id: followUpId });
        assert.ok(readProof());
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'new cycle', {});
        assert.equal(readProof(), null, 'new lifecycle work');
        assert.notEqual(resolveNextStep({ repoRoot, taskId }).next_gate, 'completion-gate');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('native retry rechecks bindings after its event and rejects concurrent source drift', async () => {
    let rejectedRaces = 0;
    const cases = [['CLOSEOUT_METADATA_RETRY_STARTED', 'source'], ['STATUS_CHANGED', 'TASK'], ['COMPLETION_GATE_PASSED', 'TASK'],
        ['STATUS_CHANGED', 'acknowledgement'], ['COMPLETION_GATE_PASSED', 'acknowledgement']];
    for (const [eventType, mutation] of cases) {
        const { repoRoot, preflightPath } = await seedFailedCloseout();
        const appendMethod = eventType === 'CLOSEOUT_METADATA_RETRY_STARTED' ? 'appendTaskEventAsync' : 'appendMandatoryTaskEventAsync';
        const originalAppend = taskEvents[appendMethod];
        let injected = false;
        try {
            correctLink(repoRoot);
            mock.method(taskEvents, appendMethod, async (...args: Parameters<typeof taskEvents.appendTaskEventAsync>) => {
                const result = await originalAppend(...args);
                if (args[2] === eventType) {
                    if (mutation === 'acknowledgement') appendTaskEvent(getOrchestratorRoot(repoRoot), taskId,
                        'ORCHESTRATOR_DEFECT_ACKNOWLEDGED', 'PASS', 'concurrent contract drift',
                        { ...details, summary: 'Changed defect contract', follow_up_task_id: followUpId });
                    else fs.appendFileSync(path.join(repoRoot, mutation === 'source' ? 'src/app.ts' : 'TASK.md'), '\n// concurrent drift\n');
                    injected = true;
                }
                return result;
            });
            await assert.rejects(handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]),
                /bindings changed (?:before|during) finalization/);
            assert.equal(injected, true, eventType);
            const last = readTaskTimelineEvents(repoRoot, taskId).reverse().find(event => event.event_type === 'COMPLETION_GATE_FAILED');
            assert.equal((last?.details as Record<string, unknown>).closeout_linkage_recovery, null);
            assert.notEqual(buildTaskAuditSummary({ repoRoot, taskId }).status, 'PASS');
            rejectedRaces += 1;
        } finally { mock.restoreAll(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
    }
    assert.equal(rejectedRaces, cases.length);
});

test('linkage correction preserves unrelated problem cross-references', async () => {
    const { repoRoot, preflightPath } = await seedFailedCloseout('T-1', true);
    try {
        correctLink(repoRoot, 'T-1');
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime/task-events', `${taskId}.jsonl`);
        assert.ok(readCloseoutLinkageRecovery(repoRoot, taskId, preflightPath, timelinePath));
        const taskPath = path.join(repoRoot, 'TASK.md');
        const original = fs.readFileSync(taskPath, 'utf8');
        fs.writeFileSync(taskPath, original.replace(`- T-99: related to T-1 and ${taskId}`,
            `- T-99: related to T-1 and ${followUpId}`));
        assert.equal(readCloseoutLinkageRecovery(repoRoot, taskId, preflightPath, timelinePath), null);
        fs.writeFileSync(taskPath, original.replace(`- Other note: see T-1 and ${taskId}`, `- Other note: see T-1 and ${followUpId}`));
        assert.equal(readCloseoutLinkageRecovery(repoRoot, taskId, preflightPath, timelinePath), null);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('native retry rejects a superseding acknowledgement during compact cleanup', async () => {
    const { repoRoot, preflightPath } = await seedFailedCloseout();
    const original = compactLifecycle.cleanupCompactAtTaskBoundary;
    let injected = false;
    try {
        correctLink(repoRoot);
        mock.method(compactLifecycle, 'cleanupCompactAtTaskBoundary', async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED', 'PASS',
                'concurrent cleanup drift', { ...details, summary: 'Changed defect contract', follow_up_task_id: followUpId });
            injected = true;
            return result;
        });
        await assert.rejects(handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]),
            /bindings changed during finalization/);
        assert.equal(injected, true);
        assert.notEqual(buildTaskAuditSummary({ repoRoot, taskId }).status, 'PASS');
    } finally { mock.restoreAll(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
