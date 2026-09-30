import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildReportTaskDetail, buildSkippedTaskDetail } from '../../../src/reports/report-data/task-detail';
import { buildTaskProgress } from '../../../src/reports/report-data/task-progress';
import { buildTaskAuditSummary } from '../../../src/gates/task-audit/task-audit-summary';
import { resolveNextStep } from '../../../src/gates/next-step';
import {
    TASK_ID,
    makeTempRepo,
    reviewsRoot,
    eventsRoot,
    seedStartedTask,
    seedCompletedTaskWithIndependentCodeReview,
    materializeFinalCloseout
} from '../gates/next-step/next-step-completion-fixtures';

function snapshot(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    function visit(directory: string): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else files[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
    }
    visit(root);
    return files;
}

function progressOptions(root: string) {
    return {
        repoRoot: root,
        taskId: TASK_ID,
        reviewsRoot: reviewsRoot(root),
        eventsRoot: eventsRoot(root),
        taskKnown: true,
        audit: buildTaskAuditSummary({ repoRoot: root, taskId: TASK_ID })
    };
}

test('task progress exposes one canonical start action and repeated reads preserve every repository file', () => {
    const root = makeTempRepo();
    const before = snapshot(root);
    const detail = buildReportTaskDetail({ repoRoot: root, taskId: TASK_ID });
    const second = buildReportTaskDetail({ repoRoot: root, taskId: TASK_ID });
    const next = resolveNextStep({ repoRoot: root, taskId: TASK_ID });
    assert.equal(detail.progress?.state, 'incomplete');
    assert.equal(detail.progress.current_stage, 'enter-task-mode');
    assert.equal(detail.progress.next_action?.command, next.commands[0].command);
    assert.deepEqual(second.progress, detail.progress);
    assert.deepEqual(detail.progress.completed_stages, []);
    assert.deepEqual(detail.progress.timing, { first_event_utc: null, last_event_utc: null });
    assert.deepEqual(snapshot(root), before);
    assert.equal(buildSkippedTaskDetail(TASK_ID, 0).progress, null);
    assert.ok(detail.stats);
    assert.ok(detail.full_suite_validation);
});

test('task progress keeps completed startup stages and the current blocker from validated evidence', () => {
    const root = makeTempRepo();
    seedStartedTask(root, TASK_ID);
    const before = snapshot(root);
    const detail = buildReportTaskDetail({ repoRoot: root, taskId: TASK_ID });
    const next = resolveNextStep({ repoRoot: root, taskId: TASK_ID });
    assert.equal(detail.progress?.state, 'blocked');
    assert.equal(detail.progress.current_stage, next.next_gate);
    assert.equal(detail.progress.blocker?.reason, next.reason.slice(0, 2048));
    assert.ok(detail.progress.completed_stages.some(stage => stage.gate === 'enter-task-mode'));
    assert.ok(detail.progress.remaining_stages.some(stage => stage.gate === 'completion-gate'));
    assert.ok(detail.progress.timing.first_event_utc);
    assert.ok(detail.progress.evidence_references.every(reference => path.dirname(reference.path) === reviewsRoot(root).replace(/\\/gu, '/')));
    assert.deepEqual(snapshot(root), before);
});

test('task progress requires a materialized current final report and never writes pending closeout artifacts', () => {
    const root = makeTempRepo();
    seedCompletedTaskWithIndependentCodeReview(root, TASK_ID);
    const before = snapshot(root);
    const detail = buildReportTaskDetail({ repoRoot: root, taskId: TASK_ID });
    assert.equal(detail.progress?.state, 'incomplete');
    assert.equal(detail.progress.final_report.state, 'pending');
    assert.equal(detail.progress.final_report.exists, false);
    assert.equal(detail.progress.navigator_status, 'READY');
    assert.equal(detail.progress.blocker, null);
    assert.match(detail.progress.next_action?.command || '', /gate task-audit-summary/u);
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(path.join(reviewsRoot(root), `${TASK_ID}-final-user-report.md`)), false);
});

test('task progress exposes completed state and a validated report reference without returning report content', () => {
    const root = makeTempRepo();
    seedCompletedTaskWithIndependentCodeReview(root, TASK_ID);
    materializeFinalCloseout(root, TASK_ID);
    const before = snapshot(root);
    const detail = buildReportTaskDetail({ repoRoot: root, taskId: TASK_ID });
    const report = path.join(reviewsRoot(root), `${TASK_ID}-final-user-report.md`);
    assert.equal(detail.progress?.state, 'completed');
    assert.equal(detail.progress.final_report.state, 'available');
    assert.equal(detail.progress.final_report.path, report.replace(/\\/gu, '/'));
    assert.equal(detail.progress.final_report.sha256, createHash('sha256').update(fs.readFileSync(report)).digest('hex'));
    assert.equal(detail.progress.next_action, null);
    assert.equal(detail.progress.blocker, null);
    assert.deepEqual(detail.progress.remaining_stages, []);
    assert.ok(detail.progress.completed_stages.some(stage => stage.gate === 'completion-gate'));
    assert.equal(Object.hasOwn(detail.progress.final_report, 'body'), false);
    assert.deepEqual(buildReportTaskDetail({ repoRoot: root, taskId: TASK_ID }).progress, detail.progress);
    assert.deepEqual(snapshot(root), before);
});

test('task progress rejects stale completed evidence after source drift and preserves the existing report', () => {
    const root = makeTempRepo();
    seedCompletedTaskWithIndependentCodeReview(root, TASK_ID);
    materializeFinalCloseout(root, TASK_ID);
    fs.appendFileSync(path.join(root, 'src', 'app.ts'), 'export const drift = true;\n');
    const before = snapshot(root);
    const detail = buildReportTaskDetail({ repoRoot: root, taskId: TASK_ID });
    assert.equal(detail.progress?.state, 'stale');
    assert.equal(detail.progress.final_report.state, 'stale');
    assert.equal(detail.progress.final_report.sha256, null);
    assert.deepEqual(detail.progress.completed_stages, []);
    assert.ok(detail.progress.next_action);
    assert.deepEqual(snapshot(root), before);
});

test('task progress rejects foreign task audits, escaping roots and unsafe task ids without reading foreign reports', () => {
    const root = makeTempRepo();
    const outside = makeTempRepo();
    const options = progressOptions(root);
    const foreignAudit = { ...options.audit, task_id: 'T-FOREIGN' };
    const foreign = buildTaskProgress({ ...options, audit: foreignAudit });
    assert.equal(foreign.state, 'unavailable');
    assert.deepEqual(foreign.evidence_references, []);
    const invalidId = buildTaskProgress({ ...options, taskId: '../T-FOREIGN' });
    assert.equal(invalidId.state, 'unavailable');
    const junction = path.join(root, 'foreign-reviews');
    fs.symlinkSync(reviewsRoot(outside), junction, process.platform === 'win32' ? 'junction' : 'dir');
    const before = snapshot(outside);
    const escaped = buildTaskProgress({ ...options, reviewsRoot: junction });
    assert.equal(escaped.state, 'unavailable');
    assert.equal(escaped.final_report.path, null);
    assert.deepEqual(snapshot(outside), before);
});

test('task progress rejects oversized closeout references and bounds unavailable diagnostics', () => {
    const root = makeTempRepo();
    const options = progressOptions(root);
    fs.writeFileSync(path.join(reviewsRoot(root), `${TASK_ID}-final-user-report.md`), Buffer.alloc(1024 * 1024 + 1));
    const before = snapshot(root);
    const progress = buildTaskProgress(options);
    assert.equal(progress.state, 'unavailable');
    assert.equal(progress.final_report.state, 'unavailable');
    assert.equal(progress.final_report.path, null);
    assert.ok(JSON.stringify(progress).length < 4096);
    assert.deepEqual(snapshot(root), before);
});

test('task progress reports unknown and unavailable evidence without inventing stages or durations', () => {
    const root = makeTempRepo();
    const options = progressOptions(root);
    const unknown = buildTaskProgress({
        ...options, taskKnown: false,
        audit: { ...options.audit, first_event_utc: 'x'.repeat(65536), last_event_utc: 'not a timestamp' }
    });
    const unavailable = buildTaskProgress({ ...options, audit: null });
    assert.equal(unknown.state, 'unknown');
    assert.equal(unavailable.state, 'unavailable');
    assert.deepEqual(unknown.completed_stages, []);
    assert.deepEqual(unavailable.remaining_stages, []);
    assert.deepEqual(Object.keys(unknown.timing), ['first_event_utc', 'last_event_utc']);
    assert.deepEqual(unknown.timing, { first_event_utc: null, last_event_utc: null });
    assert.ok(JSON.stringify(unknown).length < 4096);
    assert.equal(unknown.next_action, null);
});
