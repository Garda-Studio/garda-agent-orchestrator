import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { getRepoRoot } from '../../../../scripts/node-foundation/build';
import { runContractMigrations } from '../../../../src/lifecycle/agent-init/contract-migrations';
import { buildManualValidationEvidence } from '../../../../src/gates/review-context/review-context-manual-validation-evidence';
import { resolveFailedReviewRemediationRoute } from '../../../../src/gates/next-step/next-step-review-reuse-routing';
import type { FailedReviewRemediationRouteOptions } from '../../../../src/gates/next-step/next-step-review-reuse-routing';

const HEADING = '### Manual Validation Evidence Selector';

function selectorSection(content: string): string {
    const section = content.replace(/\r\n/gu, '\n').split(`${HEADING}\n`)[1];
    assert.ok(section, 'Published selector instructions must exist');
    return section.split(/\n#{1,3} /u)[0].trim();
}

function makeFixture(context: TestContext) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-selector-guidance-'));
    context.after(() => {
        assert.equal(path.dirname(repoRoot), path.resolve(os.tmpdir()));
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
    const canonical = fs.readFileSync(path.join(getRepoRoot(), 'template', 'docs', 'agent-rules', '40-commands.md'), 'utf8');
    const json = selectorSection(canonical).match(/```json\n([\s\S]*?)\n```/u);
    assert.ok(json, 'The published selector must be valid JSON');
    const selector = JSON.parse(json[1]) as { task_id?: string; selected_logs: Array<{ path: string; command: string; exit_code: number }> };
    assert.equal(selector.task_id, 'T-042');
    assert.equal(selector.selected_logs[0].command, 'node --version');
    const taskId = 'T-042';
    const manualRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', taskId);
    fs.mkdirSync(manualRoot, { recursive: true });
    const probe = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
    assert.equal(probe.status, selector.selected_logs[0].exit_code, String(probe.error || probe.stderr));
    fs.writeFileSync(path.join(manualRoot, selector.selected_logs[0].path), probe.stdout + probe.stderr);
    const selectorPath = path.join(manualRoot, 'review-evidence.json');
    fs.writeFileSync(selectorPath, JSON.stringify(selector));
    return { repoRoot, taskId, canonical, selector, selectorPath };
}

test('published selector repairs missing managed guidance, preserves project text and attaches a real supplemental log', context => {
    const fixture = makeFixture(context);
    const templatePath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'template', 'docs', 'agent-rules', '40-commands.md');
    const livePath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '40-commands.md');
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    fs.writeFileSync(templatePath, fixture.canonical);
    const oldRules = fixture.canonical.replace(/### Manual Validation Evidence Selector\n[\s\S]*?(?=\n## Project Commands)/u, '');
    fs.writeFileSync(livePath, oldRules + '\n## Project-owned instructions\nKeep the private project command.\n');
    assert.ok(!fs.readFileSync(livePath, 'utf8').includes(HEADING));

    const migrated = runContractMigrations({ rootPath: fixture.repoRoot });
    assert.ok(migrated.appliedFiles.includes('garda-agent-orchestrator/live/docs/agent-rules/40-commands.md'));
    const current = fs.readFileSync(livePath, 'utf8');
    assert.equal(selectorSection(current), selectorSection(fixture.canonical));
    assert.match(current, /Keep the private project command\./u);
    assert.equal(runContractMigrations({ rootPath: fixture.repoRoot }).appliedCount, 0);
    const evidence = buildManualValidationEvidence({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, reviewType: 'test' });
    assert.equal(evidence?.selected_log_count, 1);
    assert.equal(evidence?.logs[0].exit_code, 0);
    assert.ok(evidence?.logs[0].artifact_sha256);
    assert.equal(evidence?.trust_boundary.evidence_is_untrusted, true);
    assert.equal(evidence?.trust_boundary.replaces_mandatory_gates, false);
});

test('published selector with missing root task identity is rejected by the unchanged evidence consumer', context => {
    const fixture = makeFixture(context);
    delete fixture.selector.task_id;
    fs.writeFileSync(fixture.selectorPath, JSON.stringify(fixture.selector));
    const evidence = buildManualValidationEvidence({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, reviewType: 'test' });
    assert.equal(evidence?.selected_log_count, 0);
    assert.ok(evidence?.warnings.some(warning => warning.includes('selector task_id is required')));
});

test('published selector for a foreign task is rejected by the unchanged evidence consumer', context => {
    const fixture = makeFixture(context);
    fixture.selector.task_id = 'T-043';
    fs.writeFileSync(fixture.selectorPath, JSON.stringify(fixture.selector));
    const evidence = buildManualValidationEvidence({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, reviewType: 'test' });
    assert.equal(evidence?.selected_log_count, 0);
    assert.ok(evidence?.warnings.some(warning => warning.includes('selector task_id does not match')));
});

test('navigator manual evidence recovery names root task identity and preserves mandatory gates', () => {
    const command = { label: 'Existing recovery command', command: 'existing-bound-restart' };
    const options: FailedReviewRemediationRouteOptions = {
        taskId: 'T-042', reviewType: 'test', verdictToken: 'TEST REVIEW FAILED',
        failureKind: 'missing-validation-evidence', failureReason: 'missing attached evidence',
        currentReviewRecordedEvidenceCurrent: true, focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true, scopedDiffReadiness: { ready: true, reason: 'current' },
        reviewerReadinessChain: '', reviewContextChain: '', downstreamReviewTypes: [],
        reviewerResultRecoveryIdentity: null, launchArtifactState: 'missing_or_invalid',
        commands: { restartReviewCycle: command, rerunNavigator: command, compileGate: command,
            buildScopedDiff: command, buildReviewContext: command, recordResult: command }
    };
    const route = resolveFailedReviewRemediationRoute(options);
    assert.equal(route?.nextGate, 'review-evidence-refresh');
    assert.match(route?.reason || '', /root task_id="T-042".*alongside selected_logs/u);
    assert.match(route?.reason || '', /never replace mandatory gates or review receipts/u);
    assert.match(route?.reason || '', /manual-validation\/T-042\/review-evidence\.json/u);
    assert.deepEqual(route?.commands, [command]);
});
