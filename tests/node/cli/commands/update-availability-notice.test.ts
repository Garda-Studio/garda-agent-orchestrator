import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { buildUpdateCommand, formatUpdateAvailabilityNotice } from '../../../../src/lifecycle/update-availability/update-availability-notice';
import { createUpdateAvailabilityService } from '../../../../src/lifecycle/update-availability/update-availability-service';
import { createTempRepo, initializeGitRepo, seedInitAnswers, seedTaskQueue, runEnterTaskMode, runCliWithCapturedOutput } from './gate-test-helpers';
import { makeTempRepo, TASK_ID, seedCompletedTaskWithIndependentCodeReview, materializeFinalCloseout,
    seedStartedTask, writePreflight, ALL_REVIEW_FLAGS, seedCompilePass, seedReviewGatePass, seedDocImpactPass, seedCompletionPass
} from '../../gates/next-step/next-step-completion-fixtures';
import { buildTaskAuditSummary, synchronizeFinalCloseoutArtifacts } from '../../gates/next-step/next-step-test-support';

test('terminal notice uses English, two lines and the exact existing update command', () => {
    const target = path.resolve('workspace with spaces');
    const notice = formatUpdateAvailabilityNotice(target, {
        status: 'available', currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: null
    });
    assert.equal(notice, `Garda update available: 1.4.3 → 1.4.4\ngarda check-update --target-root "${target.replace(/\\/gu, '/')}" --apply`);
    assert.ok(notice.includes('--apply'));
    assert.equal(notice.split('\n').length, 2);
});

test('terminal command safely quotes interpolation and apostrophes', () => {
    const target = path.resolve("project's $work `name");
    const command = buildUpdateCommand(target);
    assert.ok(command.includes("--target-root '"));
    assert.ok(command.endsWith("' --apply"));
    assert.ok(command.includes(process.platform === 'win32' ? "project''s" : "project'\\''s"));
});

test('ordinary and failed checks produce no terminal notification', () => {
    for (const status of ['unknown', 'checking', 'up_to_date', 'unavailable', 'disabled'] as const) {
        assert.equal(formatUpdateAvailabilityNotice('.', { status, currentVersion: '1.4.3', latestVersion: null, updateCommand: null }), '');
    }
});

function enableAvailability(t: TestContext, root: string): string {
    const bundle = path.join(root, 'garda-agent-orchestrator');
    fs.writeFileSync(path.join(bundle, 'VERSION'), '1.4.3');
    fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    const calls = path.join(root, 'fixture-npm-calls.jsonl');
    const fakeNpm = path.join(root, 'fixture-npm-cli.js');
    fs.writeFileSync(fakeNpm, `require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
process.stdout.write(JSON.stringify({version:'1.4.4','dist.integrity':${JSON.stringify('sha512-' + Buffer.alloc(64, 1).toString('base64'))}}));`);
    const oldNpm = process.env.npm_execpath;
    const oldEnabled = process.env.GARDA_UPDATE_CHECK;
    process.env.npm_execpath = fakeNpm;
    process.env.GARDA_UPDATE_CHECK = '1';
    t.after(() => {
        if (oldNpm === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = oldNpm;
        if (oldEnabled === undefined) delete process.env.GARDA_UPDATE_CHECK; else process.env.GARDA_UPDATE_CHECK = oldEnabled;
    });
    return calls;
}

test('public confirmed task entry schedules a cold check and preserves the unfinished owner WIP', async t => {
    const root = createTempRepo(t);
    const calls = enableAvailability(t, root);
    seedInitAnswers(root);
    seedTaskQueue(root, 'T-060');
    fs.appendFileSync(path.join(root, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\nfixture-npm-calls.jsonl\n');
    initializeGitRepo(root);
    assert.equal(runEnterTaskMode({ repoRoot: root, taskId: 'T-060', taskSummary: 'Unfinished release owner', plannedChangedFiles: ['src/owner.ts'] }).exitCode, 0);
    fs.appendFileSync(path.join(root, 'TASK.md'), '\n| T-146 | TODO | P2 | ux | Advisory updates | agent | 2026-09-27 | default | |\n');
    const wip = path.join(root, 'src', 'owner.ts');
    fs.writeFileSync(wip, 'export const unfinishedRelease = 1;\n');
    const ownerMode = path.join(root, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-060-task-mode.json');
    const ownerBefore = fs.readFileSync(ownerMode);
    const baseArgs = ['gate', 'enter-task-mode', '--task-id', 'T-146', '--entry-mode', 'EXPLICIT_TASK_EXECUTION', '--requested-depth', '2',
        '--task-summary', 'Advisory update fixture', '--provider', 'Codex', '--planned-changed-file', 'src/second.ts', '--repo-root', root];
    const denied = await runCliWithCapturedOutput(baseArgs);
    assert.notEqual(denied.exitCode, 0);
    assert.equal(fs.existsSync(calls), false, 'failed entry must not schedule metadata work');
    const accepted = await runCliWithCapturedOutput([...baseArgs, '--allow-active-task', 'T-060', '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
    assert.equal(accepted.exitCode, 0, accepted.errors.join('\n'));
    assert.match(accepted.logs.join('\n'), /TASK_MODE_ENTERED/u);
    const service = createUpdateAvailabilityService(root);
    const deadline = Date.now() + 7000;
    while (service.snapshot().status !== 'available' && Date.now() < deadline) await delay(20);
    assert.equal(service.snapshot().status, 'available');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
    assert.equal(fs.readFileSync(wip, 'utf8'), 'export const unfinishedRelease = 1;\n');
    assert.deepEqual(fs.readFileSync(ownerMode), ownerBefore);
    assert.match(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), /T-060.*IN_PROGRESS/u);
});

test('public completed next-step adds English text/JSON notices without rewriting canonical reports or another owner WIP', async t => {
    const root = makeTempRepo();
    enableAvailability(t, root);
    await createUpdateAvailabilityService(root, { automaticEnabled: true, queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const wip = path.join(root, 'src', 'owner.ts');
    fs.writeFileSync(wip, 'export const unfinishedRelease = 1;\n');
    seedCompletedTaskWithIndependentCodeReview(root, TASK_ID);
    materializeFinalCloseout(root, TASK_ID);
    const queuePath = path.join(root, 'TASK.md');
    fs.writeFileSync(queuePath, fs.readFileSync(queuePath, 'utf8').trimEnd() + '\n| T-060 | TODO | P2 | release | Release owner | agent | 2026-09-27 | balanced | |\n');
    assert.equal(runEnterTaskMode({ repoRoot: root, taskId: 'T-060', taskSummary: 'Unfinished release owner', plannedChangedFiles: ['src/owner.ts'] }).exitCode, 0);
    const ownerMode = path.join(root, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-060-task-mode.json');
    const ownerBefore = fs.readFileSync(ownerMode);
    const reports = ['final-user-report.md', 'final-closeout.json', 'final-closeout.md'].map(suffix => path.join(root, 'garda-agent-orchestrator', 'runtime', 'reviews', `${TASK_ID}-${suffix}`));
    const before = reports.map(file => fs.readFileSync(file));
    const expected = `Garda update available: 1.4.3 → 1.4.4\ngarda check-update --target-root "${root.replace(/\\/gu, '/')}" --apply`;
    const text = await runCliWithCapturedOutput(['next-step', TASK_ID, '--repo-root', root]);
    assert.equal(text.exitCode, 0, text.errors.join('\n'));
    assert.ok(text.logs.join('\n').includes(expected), text.logs.join('\n').split('\n').filter(line => /Status:|NextGate:|Reason:|Garda update/u.test(line)).join('\n'));
    const json = await runCliWithCapturedOutput(['next-step', TASK_ID, '--repo-root', root, '--as-json']);
    assert.equal(json.exitCode, 0, json.errors.join('\n'));
    const parsed = JSON.parse(json.logs.join('\n')) as { status: string; update_notice: string; update_notice_instruction: string };
    assert.equal(parsed.status, 'DONE');
    assert.equal(parsed.update_notice, expected);
    assert.match(parsed.update_notice_instruction, /after the canonical final user report/u);
    reports.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    assert.equal(fs.readFileSync(wip, 'utf8'), 'export const unfinishedRelease = 1;\n');
    assert.deepEqual(fs.readFileSync(ownerMode), ownerBefore);
    assert.match(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), /T-060.*IN_PROGRESS/u);
});

test('public completed next-step preserves update notices with a custom reviews root', async t => {
    const root = makeTempRepo();
    enableAvailability(t, root);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    seedStartedTask(root, TASK_ID);
    writePreflight(root, TASK_ID, { ...ALL_REVIEW_FLAGS });
    seedCompilePass(root, TASK_ID);
    seedReviewGatePass(root, TASK_ID);
    seedDocImpactPass(root, TASK_ID);
    seedCompletionPass(root, TASK_ID);
    const defaultReviews = path.join(root, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const customReviews = path.join(root, 'garda-agent-orchestrator', 'runtime', 'custom reviews');
    fs.cpSync(defaultReviews, customReviews, { recursive: true });
    synchronizeFinalCloseoutArtifacts(buildTaskAuditSummary({ taskId: TASK_ID, repoRoot: root, reviewsRoot: customReviews }));
    const reportPath = path.join(customReviews, `${TASK_ID}-final-user-report.md`);
    const original = fs.readFileSync(reportPath);
    assert.equal(fs.existsSync(path.join(defaultReviews, `${TASK_ID}-final-user-report.md`)), false);
    const args = ['next-step', TASK_ID, '--repo-root', root, '--reviews-root', customReviews];
    const text = await runCliWithCapturedOutput(args);
    assert.equal(text.exitCode, 0, text.errors.join('\n'));
    assert.match(text.logs.join('\n'), /Garda update available: 1\.4\.3 → 1\.4\.4/u);
    const json = await runCliWithCapturedOutput([...args, '--as-json']);
    assert.equal(json.exitCode, 0, json.errors.join('\n'));
    const parsed = JSON.parse(json.logs.join('\n')) as { status: string; update_notice: string };
    assert.equal(parsed.status, 'DONE');
    assert.match(parsed.update_notice, /Garda update available: 1\.4\.3 → 1\.4\.4/u);
    assert.ok(parsed.update_notice.includes(buildUpdateCommand(root)));
    assert.deepEqual(fs.readFileSync(reportPath), original);
});
