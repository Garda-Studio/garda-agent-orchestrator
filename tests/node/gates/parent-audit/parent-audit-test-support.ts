import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildScopeContentFingerprint } from '../../../../src/gates/compile/compile-gate';
import { runHumanCommitCommand } from '../../../../src/cli/commands/gates';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';
import { resolveParentCompletionPolicy } from '../../../../src/core/parent-completion-policy';
import { parentDigest, parentRecordDigest } from '../../../../src/gates/parent-audit/parent-audit-auth';
import type { ParentReviewInput, ParentAuditOutput } from '../../../../src/gates/parent-audit/parent-audit-types';
import { serializeTaskPlan, type TaskPlan } from '../../../../src/schemas/task-plan';
import { selectTaskModePlan } from '../../../../src/gates/task-mode/task-mode-plan';

export const PARENT_ID = 'T-PARENT-1';
export const roots: string[] = [];

interface FixtureReviewResult { reviewType: string; passed: boolean }

function recordFixtureReview(bundle: string, taskId: string, result: FixtureReviewResult): void {
    // Recording succeeds even when the independent review verdict fails.
    appendMandatoryTaskEvent(bundle, taskId, 'REVIEW_RECORDED', 'PASS', 'Isolated native review record.', {
        review_type: result.reviewType,
        review_findings_validation: { accepted: true },
        review_findings_disposition: { blocking_count: result.passed ? 0 : 1,
            verdict: result.passed ? 'pass_no_findings' : 'fail_for_fix_now' }
    });
}

export function git(root: string, args: string[]): string {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

export function writeQueue(root: string, parentNotes: string, statuses = ['DECOMPOSED', 'DONE', 'DONE']) {
    fs.writeFileSync(path.join(root, 'TASK.md'), ['## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${PARENT_ID} | ${statuses[0]} | P0 | test | Parent completion fixture | local | 2026-10-21 | balanced | ${parentNotes} |`,
        `| ${PARENT_ID}-1 | ${statuses[1]} | P0 | test | First accepted change | local | 2026-10-21 | balanced | First requirement. |`,
        `| ${PARENT_ID}-2 | ${statuses[2]} | P0 | test | Second accepted change | local | 2026-10-21 | balanced | Second requirement. |`, ''].join('\n'));
}

export async function publishChild(root: string, taskId: string, file: string, content: string): Promise<void> {
    fs.writeFileSync(path.join(root, file), content);
    git(root, ['add', '--', file]);
    const scope = buildScopeContentFingerprint(root, 'explicit_changed_files', [file]);
    const auditApi = require('../../../../src/gates/task-audit/task-audit-summary');
    const closeoutApi = require('../../../../src/gates/task-audit/task-audit-summary-closeout-sync');
    // Isolate the ordinary leaf audit only. Native commit, signing, SOURCE publication and Git verification remain real.
    const auditMock = mock.method(auditApi, 'buildTaskAuditSummary', () => ({ task_id: taskId,
        status: 'PASS', integrity_status: 'PASS', blockers: [], point_in_time_snapshot: { status: 'STABLE' },
        final_closeout: { implementation_summary: { changed_files: [file], scope_content_sha256: scope,
            audited_scope_provenance: { use_staged: false, detection_source: 'explicit_changed_files' } } } }));
    const closeoutMock = mock.method(closeoutApi, 'synchronizeFinalCloseoutArtifacts', (value: unknown) => value);
    try { assert.equal(await runHumanCommitCommand(['--task-id', taskId, '-m', 'test: accepted isolated child'], { cwd: root }), 0); }
    finally { auditMock.mock.restore(); closeoutMock.mock.restore(); }
}

export async function parentFixture(options: { origin?: 'runtime' | 'manual'; enabled?: boolean; children?: boolean; legacy?: boolean;
    legacyUnhashed?: boolean; originalResults?: Array<{ command: string; passed: boolean }>;
    originalReviews?: FixtureReviewResult[]; childReviews?: FixtureReviewResult[]; compileAfterChildReviews?: boolean;
    plan?: Pick<TaskPlan, 'acceptance_criteria' | 'verification_expectations' | 'validation_strategy' | 'out_of_scope'>;
    originalCommand?: string; declaredReport?: 'fresh' | 'stale'; originalSuiteBlocked?: boolean;
    childSuiteOutcomes?: Array<'PASSED' | 'BLOCKED' | 'WARNED' | 'SKIPPED'>; childEarlierSuitePassed?: boolean;
    compileAfterChildSuite?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-parent-audit-'));
    roots.push(root);
    git(root, ['init']); git(root, ['config', 'user.name', 'Parent Audit Tests']); git(root, ['config', 'user.email', 'parent-audit@example.invalid']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'garda-agent-orchestrator/\nTASK.md\nparent-report.txt\n');
    fs.writeFileSync(path.join(root, 'parent-check.cjs'), options.declaredReport === 'fresh'
        ? "require('node:fs').writeFileSync('parent-report.txt', 'current report ' + Date.now()); console.log('original parent validation passed');\n"
        : "console.log('original parent validation passed');\n");
    if (options.declaredReport === 'stale') fs.writeFileSync(path.join(root, 'parent-report.txt'), 'stale original report');
    fs.writeFileSync(path.join(root, 'first.ts'), 'export const first = 0;\n');
    fs.writeFileSync(path.join(root, 'second.ts'), 'export const second = 0;\n');
    git(root, ['add', '.']); git(root, ['commit', '-m', 'isolated baseline']);
    const bundle = path.join(root, 'garda-agent-orchestrator'), reviews = path.join(bundle, 'runtime/reviews');
    fs.mkdirSync(reviews, { recursive: true });
    const config = path.join(bundle, 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const defaults = buildDefaultWorkflowConfig(); defaults.parent_audit.enabled = options.enabled ?? false;
    defaults.full_suite_validation.command = 'node unrelated-previous-task.js'; defaults.full_suite_validation.enabled = true;
    fs.writeFileSync(config, JSON.stringify(defaults, null, 2) + '\n');
    writeQueue(root, `Decomposition source: ${options.origin === 'manual' ? 'manual-operator' : 'orchestrator'}; child tasks: ${PARENT_ID}-1, ${PARENT_ID}-2; execute sequentially.`);
    if (options.children !== false) {
        // This grant is for the temporary fixture only, never the real working repository.
        handleSet({ targetRoot: root, localCommitEnabled: 'true', json: true, operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
        for (const [index, file] of ['first.ts', 'second.ts'].entries()) {
            const childId = `${PARENT_ID}-${index + 1}`;
            for (const review of options.childReviews ?? []) recordFixtureReview(bundle, childId, review);
            const suite = options.childSuiteOutcomes?.[index];
            if (options.childEarlierSuitePassed) appendMandatoryTaskEvent(bundle, childId, 'FULL_SUITE_VALIDATION_PASSED', 'PASS',
                'Isolated earlier native child suite result.', { command: 'node child-check.cjs' });
            if (suite) appendMandatoryTaskEvent(bundle, childId, 'FULL_SUITE_VALIDATION_' + suite,
                suite === 'PASSED' ? 'PASS' : suite === 'WARNED' ? 'WARN' : suite === 'SKIPPED' ? 'INFO' : 'BLOCKED',
                'Isolated native child suite result.', { command: 'node child-check.cjs' });
            if (options.compileAfterChildReviews || options.compileAfterChildSuite) appendMandatoryTaskEvent(bundle, childId, 'COMPILE_GATE_PASSED', 'PASS',
                'Isolated newer child compile.', {});
            await publishChild(root, childId, file, `export const ${index === 0 ? 'first' : 'second'} = ${index + 1};\n`);
        }
    }
    if (options.origin !== 'manual') {
        let planBinding: { plan_guided: true; plan_path: string; plan_sha256: string } | undefined;
        if (options.plan) {
            const plan: TaskPlan = { schema_version: 1, task_id: PARENT_ID, status: 'approved', goal: 'Integrate both original children.',
                scope_files: ['first.ts', 'second.ts'], risk_level: 'medium', steps: [{ id: 'integrate', title: 'Verify the combined result.' }], ...options.plan };
            const file = path.join(reviews, PARENT_ID + '-task-plan.json');
            fs.writeFileSync(file, serializeTaskPlan(plan));
            planBinding = { plan_guided: true, ...selectTaskModePlan(root, PARENT_ID, file).plan! };
        }
        appendMandatoryTaskEvent(bundle, PARENT_ID, 'TASK_MODE_ENTERED', 'PASS', 'Isolated runtime-parent entry fixture.', {
            dirty_workspace_baseline_count: 0, ...planBinding });
        if (options.originalSuiteBlocked) appendMandatoryTaskEvent(bundle, PARENT_ID, 'FULL_SUITE_VALIDATION_BLOCKED', 'BLOCKED',
            'Isolated pre-execution suite blocker without an executed command.', {});
        if (options.originalCommand) appendMandatoryTaskEvent(bundle, PARENT_ID, 'FULL_SUITE_VALIDATION_FAILED', 'FAIL', 'Isolated original native failure.', {
            command: options.originalCommand, ...(options.declaredReport ? { report_attempts: [{ report_evidence: {
                declarations: [{ path: 'parent-report.txt', max_bytes: 4096 }] } }] } : {}) });
        for (const result of options.originalResults ?? []) appendMandatoryTaskEvent(bundle, PARENT_ID,
            result.passed ? 'FULL_SUITE_VALIDATION_PASSED' : 'FULL_SUITE_VALIDATION_FAILED', result.passed ? 'PASS' : 'FAIL',
            'Isolated original command result.', { command: result.command });
        for (const review of options.originalReviews ?? []) recordFixtureReview(bundle, PARENT_ID, review);
        const artifact = buildStrictDecompositionDecisionArtifact({ taskId: PARENT_ID, decision: 'split-required', taskProfile: 'balanced',
            taskSummary: 'Parent completion fixture', reason: 'Two independently scoped changes in the isolated fixture.', scopeRisk: 'Aggregate integration and native evidence ownership.',
            expectedReviewTypes: ['code'], atomicityConstraints: ['Keep accepted child sources intact.'],
            ...(options.legacy ? {} : { parentCompletionPolicy: resolveParentCompletionPolicy('runtime', options.enabled ?? false) }),
            workPackageContract: { schema_version: 2, finding_obligations: [], work_packages: [1, 2].map(index => ({
                task_id: `${PARENT_ID}-${index}`, profile: 'balanced', root_cause_area: `isolated-${index}`, objective: `Implement isolated requirement ${index}.`,
                scope_obligations: [`Own isolated source change ${index}.`], validation_contract: ['Run ordinary focused validation and native gates.'],
                finding_obligation_ids: [], required_review_types: ['code'] })) } });
        const file = path.join(reviews, PARENT_ID + '-strict-decomposition-decision.json');
        fs.writeFileSync(file, JSON.stringify(artifact));
        appendMandatoryTaskEvent(bundle, PARENT_ID, 'STRICT_DECOMPOSITION_DECISION_RECORDED', 'INFO', 'Isolated split decision.', {
            artifact_path: file.replace(/\\/gu, '/'), ...(options.legacyUnhashed ? {} : { artifact_sha256: parentDigest(fs.readFileSync(file)) }), decision: 'split-required', task_profile: 'balanced',
            task_summary_sha256: artifact.task_summary_sha256, proposed_child_task_ids: artifact.proposed_children.map(child => child.task_id),
            work_package_contract_sha256: artifact.work_package_contract_sha256 });
        // Existing original-parent proof suites own WIP authentication; this suite isolates the new parent policy and SOURCE composition.
        mock.method(require('../../../../src/gates/task-audit/task-audit-summary-parent-obligation-proofs'), 'qualifyWip', () => undefined);
        // Only the provider transport/capability attestation is simulated; publication and source checks are native.
        mock.method(require('../../../../src/gates/review/reviewer-routing'), 'resolveRuntimeReviewerIdentity', () => ({
            identity_status: 'resolved', violations: [], execution_provider: 'Codex', canonical_entrypoint: 'AGENTS.md',
            expected_execution_mode: 'delegated_subagent', reviewer_subagent_launch_status: 'launchable', no_delegate_mode: { active: false }
        }));
    }
    return { root, bundle, reviews, config };
}

export function outputFor(input: ParentReviewInput, finding = false): ParentAuditOutput {
    const ids = input.obligations.map(row => row.id);
    const findings = finding ? [{ id: 'F-001', severity: 'high' as const, title: 'Joint requirement is missing',
        description: 'The isolated combined source does not implement the required joint behavior.', remediation: 'Implement and verify the missing joint behavior.',
        requirement_ids: ids, evidence: ['first.ts:1', 'second.ts:1'] }] : [];
    return { schema_version: 1, task_id: input.task_id, attempt_id: input.attempt_id, input_sha256: parentRecordDigest(input),
        requirements: ids.map(id => ({ id, result: finding ? 'finding' as const : 'satisfied' as const,
            evidence: ['first.ts:1', 'second.ts:1'], finding_ids: finding ? ['F-001'] : [] })), findings };
}

export function cleanupParentFixtures() {
    mock.restoreAll();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
