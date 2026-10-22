import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentDigest } from '../../../../src/gates/parent-audit/parent-audit-auth';
import { runParentValidation, readParentValidations } from '../../../../src/gates/parent-audit/parent-audit-validation';
import { inspectParentCompletion } from '../../../../src/gates/parent-audit/parent-audit-state';
import { materializeSplitRequiredLatch } from '../../../../src/gates/next-step/next-step-split-required-latch';
import { resolveParentCompletionPolicy, parseParentCompletionPolicy, readParentAuditEnabled } from '../../../../src/core/parent-completion-policy';
import { registerParentCompletionContract, readParentCompletionContract, registerParentAtDecomposition } from '../../../../src/gates/parent-audit/parent-audit-contract';
import { resolveLocalCommitAvailability } from '../../../../src/core/auth/local-commit-availability';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { serializeTaskPlan } from '../../../../src/schemas/task-plan';
import { validateWorkflowConfig } from '../../../../src/schemas/config-artifacts-workflow';
import { cleanupParentFixtures, parentFixture, PARENT_ID, writeQueue } from './parent-audit-test-support';

afterEach(cleanupParentFixtures);

test('an unrelated review lane cannot erase a genuine original review failure', async () => {
    const fixture = await parentFixture({ children: false, originalReviews: [
        { reviewType: 'security', passed: false }, { reviewType: 'code', passed: true }
    ] });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.unresolved_failures, ['REVIEW_RECORDED:security']);
});

test('automatic parent completion requires the originally failed review lane in every child', async () => {
    const fixture = await parentFixture({ originalReviews: [{ reviewType: 'security', passed: false }],
        childReviews: [{ reviewType: 'code', passed: true }] });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('successful recording of a failed child review cannot resolve the parent failure', async () => {
    const fixture = await parentFixture({ originalReviews: [{ reviewType: 'security', passed: false }],
        childReviews: [{ reviewType: 'security', passed: false }, { reviewType: 'code', passed: true }] });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('a child review before its latest compile cannot resolve an original parent review failure', async () => {
    const fixture = await parentFixture({ originalReviews: [{ reviewType: 'security', passed: false }],
        childReviews: [{ reviewType: 'security', passed: true }], compileAfterChildReviews: true });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('a successful original review rerun clears only the matching lane', async () => {
    const fixture = await parentFixture({ children: false, originalReviews: [
        { reviewType: 'security', passed: false }, { reviewType: 'code', passed: false },
        { reviewType: 'security', passed: true }
    ] });
    assert.deepEqual(registerParentCompletionContract(fixture.root, PARENT_ID).unresolved_failures, ['REVIEW_RECORDED:code']);
});

test('matching current child review verdicts resolve the original review failure', async () => {
    const fixture = await parentFixture({ originalReviews: [{ reviewType: 'security', passed: false }],
        childReviews: [{ reviewType: 'security', passed: true }, { reviewType: 'code', passed: true }] });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.unresolved_failures, ['REVIEW_RECORDED:security']);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
});

test('native parent audit reads the same boolean-like settings accepted by the schema', async () => {
    const fixture = await parentFixture({ children: false });
    const raw = JSON.parse(fs.readFileSync(fixture.config, 'utf8'));
    for (const value of [true, false, 'true', 'false', 1, 0, 'ON', ' off ']) {
        raw.parent_audit.enabled = value;
        const normalized = validateWorkflowConfig(raw).parent_audit as { enabled: boolean };
        fs.writeFileSync(fixture.config, JSON.stringify(raw));
        assert.equal(readParentAuditEnabled(fixture.root), normalized.enabled, JSON.stringify(value));
    }
    raw.parent_audit.enabled = 'sometimes';
    fs.writeFileSync(fixture.config, JSON.stringify(raw));
    assert.throws(() => validateWorkflowConfig(raw), /parent_audit/iu);
    assert.throws(() => readParentAuditEnabled(fixture.root), /parent_audit/iu);
});

test('native guard freezes a schema-valid textual audit setting as a boolean', async () => {
    const fixture = await parentFixture({ enabled: true, children: false });
    writeQueue(fixture.root, `Decomposition source: orchestrator; child tasks: ${PARENT_ID}-1, ${PARENT_ID}-2;`, ['IN_PROGRESS', 'DONE', 'DONE']);
    const raw = JSON.parse(fs.readFileSync(fixture.config, 'utf8'));
    raw.parent_audit.enabled = 'true';
    assert.deepEqual(validateWorkflowConfig(raw).parent_audit, { enabled: true });
    fs.writeFileSync(fixture.config, JSON.stringify(raw));
    const preflight = path.join(fixture.reviews, PARENT_ID + '-preflight.json');
    fs.writeFileSync(preflight, JSON.stringify({ task_id: PARENT_ID, metrics: { changed_files_count: 0, changed_lines_total: 0, actual_changed_files: [] } }));
    const result = materializeSplitRequiredLatch({ repoRoot: fixture.root,
        eventsRoot: path.join(fixture.bundle, 'runtime/task-events'), reviewsRoot: fixture.reviews,
        taskId: PARENT_ID, guardKind: 'scope_budget', guardReason: 'Textual setting regression.',
        rawGuardSummary: 'Textual setting regression.', preflightPath: preflight, guardDetails: {} });
    const frozen = JSON.parse(fs.readFileSync(result.artifact_path, 'utf8')).parent_completion_policy;
    assert.deepEqual(frozen, resolveParentCompletionPolicy('runtime', true));
    raw.parent_audit.enabled = 'false';
    fs.writeFileSync(fixture.config, JSON.stringify(raw));
    assert.equal(registerParentAtDecomposition(fixture.root, PARENT_ID)!.policy.audit_enabled, true);
});

test('parent plan binding accepts the native canonical digest and then freezes exact bytes', async () => {
    const fixture = await parentFixture({ children: false, plan: { verification_expectations: ['Inspect both original changes.'] } });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    const file = path.join(fixture.reviews, PARENT_ID + '-task-plan.json');
    const bytes = fs.readFileSync(file);
    assert.equal(contract.plan_binding!.sha256, parentDigest(bytes));
    assert.notEqual(contract.plan_binding!.sha256, JSON.parse(bytes.toString('utf8')).plan_sha256);
    assert.equal(readParentCompletionContract(fixture.root, PARENT_ID)!.plan_binding!.sha256, parentDigest(bytes));
    fs.writeFileSync(file, bytes.toString('utf8') + '\n');
    assert.throws(() => readParentCompletionContract(fixture.root, PARENT_ID), /evidence binding/iu);
});

test('parent registration rejects changed plan content and a forged embedded plan digest', async () => {
    const fixture = await parentFixture({ children: false, plan: { verification_expectations: ['Inspect both original changes.'] } });
    const file = path.join(fixture.reviews, PARENT_ID + '-task-plan.json');
    const bytes = fs.readFileSync(file);
    const changed = JSON.parse(bytes.toString('utf8'));
    changed.verification_expectations = ['Silently discard the original integration requirement.'];
    fs.writeFileSync(file, serializeTaskPlan(changed));
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID), /plan binding/iu);
    const forged = JSON.parse(bytes.toString('utf8'));
    forged.plan_sha256 = '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(forged));
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID), /plan binding/iu);
});

test('native guard production freezes its audit switch across recovery and later setting changes', async () => {
    const fixture = await parentFixture({ enabled: true, children: false });
    writeQueue(fixture.root, `Decomposition source: orchestrator; child tasks: ${PARENT_ID}-1, ${PARENT_ID}-2;`, ['IN_PROGRESS', 'DONE', 'DONE']);
    const preflight = path.join(fixture.reviews, PARENT_ID + '-preflight.json');
    fs.writeFileSync(preflight, JSON.stringify({ task_id: PARENT_ID, metrics: { changed_files_count: 0, changed_lines_total: 0, actual_changed_files: [] } }));
    const params = { repoRoot: fixture.root, eventsRoot: path.join(fixture.bundle, 'runtime/task-events'), reviewsRoot: fixture.reviews,
        taskId: PARENT_ID, guardKind: 'scope_budget' as const, guardReason: 'Isolated guard fixture.', rawGuardSummary: 'Isolated guard fixture.',
        preflightPath: preflight, guardDetails: {} };
    const first = materializeSplitRequiredLatch(params);
    assert.equal(JSON.parse(fs.readFileSync(first.artifact_path, 'utf8')).parent_completion_policy.audit_enabled, true);
    const raw = JSON.parse(fs.readFileSync(fixture.config, 'utf8')); raw.parent_audit.enabled = false;
    fs.writeFileSync(fixture.config, JSON.stringify(raw));
    const recovered = materializeSplitRequiredLatch(params);
    assert.equal(JSON.parse(fs.readFileSync(recovered.artifact_path, 'utf8')).parent_completion_policy.audit_enabled, true);
    assert.equal(registerParentAtDecomposition(fixture.root, PARENT_ID)!.policy.audit_enabled, true);
});

test('automatic mode preserves genuine original failures and executes only their frozen command', async () => {
    const fixture = await parentFixture({ originalCommand: 'node parent-check.cjs' });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.original_commands, ['node parent-check.cjs']);
    assert.deepEqual(contract.unresolved_failures, ['FULL_SUITE_VALIDATION']);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
    await assert.rejects(runParentValidation(fixture.root, PARENT_ID, 1), /not declared/iu);
    assert.equal((await runParentValidation(fixture.root, PARENT_ID, 0)).status, 'PASSED');
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
});

test('current child suites resolve a pre-execution parent suite blocker without inventing a command', async () => {
    const fixture = await parentFixture({ originalSuiteBlocked: true, childSuiteOutcomes: ['PASSED', 'PASSED'] });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.original_commands, []);
    assert.deepEqual(contract.unresolved_failures, ['FULL_SUITE_VALIDATION']);
    const inspection = inspectParentCompletion(fixture.root, PARENT_ID)!;
    assert.deepEqual(inspection.violations, []);
    assert.equal(inspection.childSources.length, 2);
    assert.equal(inspection.ready, true);
    assert.deepEqual(readParentCompletionContract(fixture.root, PARENT_ID), contract);
});

test('a blocked child suite cannot resolve a pre-execution parent suite blocker', async () => {
    const fixture = await parentFixture({ originalSuiteBlocked: true, childSuiteOutcomes: ['PASSED', 'BLOCKED'] });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('child suites before a newer compile cannot resolve a pre-execution parent suite blocker', async () => {
    const fixture = await parentFixture({ originalSuiteBlocked: true, childSuiteOutcomes: ['PASSED', 'PASSED'], compileAfterChildSuite: true });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('passing child suites cannot waive a genuinely executed failed parent command', async () => {
    const fixture = await parentFixture({ originalSuiteBlocked: true, childSuiteOutcomes: ['PASSED', 'PASSED'],
        originalCommand: 'node parent-check.cjs' });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.original_commands, ['node parent-check.cjs']);
    assert.deepEqual(contract.unresolved_failures, ['FULL_SUITE_VALIDATION']);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('warned child suites cannot reuse an earlier pass to resolve a pre-execution parent blocker', async () => {
    const fixture = await parentFixture({ originalSuiteBlocked: true, childEarlierSuitePassed: true,
        childSuiteOutcomes: ['WARNED', 'WARNED'] });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('skipped child suites cannot reuse an earlier pass to resolve a pre-execution parent blocker', async () => {
    const fixture = await parentFixture({ originalSuiteBlocked: true, childEarlierSuitePassed: true,
        childSuiteOutcomes: ['SKIPPED', 'SKIPPED'] });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('a different successful original command cannot clear an unresolved failed command', async () => {
    const fixture = await parentFixture({ originalResults: [
        { command: 'node parent-check.cjs', passed: false }, { command: 'node other-check.cjs', passed: true }
    ] });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.original_commands, ['node parent-check.cjs', 'node other-check.cjs']);
    assert.deepEqual(contract.unresolved_failures, ['FULL_SUITE_VALIDATION']);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
});

test('a successful rerun resolves only the matching original command failure', async () => {
    const fixture = await parentFixture({ originalResults: [
        { command: 'node parent-check.cjs', passed: false }, { command: 'node parent-check.cjs', passed: true }
    ] });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.unresolved_failures, []);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
});

test('an injected policy on an unhashed legacy strict decision still requires explicit compatibility', async () => {
    const fixture = await parentFixture({ legacy: true, legacyUnhashed: true, enabled: true, children: false });
    const file = path.join(fixture.reviews, PARENT_ID + '-strict-decomposition-decision.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.parent_completion_policy = resolveParentCompletionPolicy('runtime', false);
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(registerParentAtDecomposition(fixture.root, PARENT_ID), null);
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID), /compatibility/iu);
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID, { legacyAuditEnabled: true,
        compatibilityReason: 'An explicit compatibility choice owns this unhashed legacy policy.' });
    assert.equal(contract.compatibility, true);
    assert.equal(contract.policy.audit_enabled, true);
});

test('declared parent reports are frozen and stale reports cannot become passing evidence', async () => {
    const fixture = await parentFixture({ enabled: true, originalCommand: 'node parent-check.cjs', declaredReport: 'stale' });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    const validation = await runParentValidation(fixture.root, PARENT_ID, 0);
    assert.equal(validation.status, 'FAILED');
    assert.match(validation.report_violations!.join(' '), /fresh|stale/iu);
    assert.equal(readParentValidations(fixture.root, contract)[0]!.status, 'FAILED');
});

test('fresh parent reports retain authenticated bytes with the validation output', async () => {
    const fixture = await parentFixture({ enabled: true, originalCommand: 'node parent-check.cjs', declaredReport: 'fresh' });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    const validation = await runParentValidation(fixture.root, PARENT_ID, 0);
    assert.equal(validation.status, 'PASSED');
    assert.equal(readParentValidations(fixture.root, contract)[0]!.report_capture!.reports.length, 1);
    assert.match(fs.readFileSync(validation.output_path!, 'utf8'), /current report/u);
});

test('native guard decomposition freezes the same policy and retained guards require a choice', async () => {
    const fixture = await parentFixture({ enabled: true, children: false });
    const file = path.join(fixture.reviews, PARENT_ID + '-split-required.json');
    const artifact = { schema_version: 1, task_id: PARENT_ID, status: 'SPLIT_REQUIRED', guard_kind: 'scope_budget',
        materialization_phase: 'complete', status_sync: { outcome: 'updated', previous_status: 'IN_PROGRESS', next_status: 'SPLIT_REQUIRED' } };
    fs.writeFileSync(file, JSON.stringify(artifact));
    const details = { status: 'SPLIT_REQUIRED', guard_kind: 'scope_budget', artifact_path: file.replace(/\\/gu, '/'), artifact_sha256: parentDigest(fs.readFileSync(file)) };
    appendMandatoryTaskEvent(fixture.bundle, PARENT_ID, 'SPLIT_REQUIRED_LATCHED', 'BLOCKED', 'Isolated native guard latch.', details);
    appendMandatoryTaskEvent(fixture.bundle, PARENT_ID, 'STATUS_CHANGED', 'INFO', 'Isolated native guard status.',
        { ...details, previous_status: 'IN_PROGRESS', new_status: 'SPLIT_REQUIRED', reason: 'auto_split_guard_latched' });
    assert.equal(registerParentAtDecomposition(fixture.root, PARENT_ID), null);
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID), /compatibility/iu);
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID, { legacyAuditEnabled: true,
        compatibilityReason: 'Explicit retained guard fixture aggregate audit choice.' });
    assert.equal(contract.decomposition_kind, 'guard');
    assert.equal(contract.policy.audit_enabled, true);
    const raw = JSON.parse(fs.readFileSync(fixture.config, 'utf8')); raw.parent_audit.enabled = false;
    fs.writeFileSync(fixture.config, JSON.stringify(raw));
    assert.equal(readParentCompletionContract(fixture.root, PARENT_ID)!.policy.audit_enabled, true);
});

test('registration rejects decomposition from an earlier task entry and preserves legacy transition choice', async () => {
    const fixture = await parentFixture({ legacy: true, children: false });
    assert.equal(registerParentAtDecomposition(fixture.root, PARENT_ID), null, 'legacy transition must not infer current global policy');
    appendMandatoryTaskEvent(fixture.bundle, PARENT_ID, 'TASK_MODE_ENTERED', 'PASS', 'Isolated newer parent entry.', {});
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID, { legacyAuditEnabled: false,
        compatibilityReason: 'An old decomposition cannot satisfy this new task cycle.' }), /earlier task cycle/iu);
});

test('manual-at-creation origin always takes precedence over the audit switch', () => {
    assert.deepEqual(resolveParentCompletionPolicy('manual-at-creation', true), { schema_version: 1, origin: 'manual-at-creation', audit_enabled: false });
    assert.equal(resolveParentCompletionPolicy('runtime', true).audit_enabled, true);
    assert.equal(resolveParentCompletionPolicy('runtime', false).audit_enabled, false);
    assert.throws(() => parseParentCompletionPolicy({ schema_version: 1, origin: 'manual-at-creation', audit_enabled: true }), /invalid/iu);
});

test('native registration freezes runtime policy and ignores later global settings', async () => {
    const fixture = await parentFixture({ enabled: true });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    const raw = JSON.parse(fs.readFileSync(fixture.config, 'utf8')); raw.parent_audit.enabled = false;
    fs.writeFileSync(fixture.config, JSON.stringify(raw));
    assert.equal(readParentCompletionContract(fixture.root, PARENT_ID)!.policy.audit_enabled, true);
    assert.deepEqual(contract.original_commands, [], 'a merely configured previous-task suite is not a parent obligation');
});

test('manual registration needs no local commit grant and cannot manufacture one', async () => {
    const fixture = await parentFixture({ origin: 'manual', enabled: true, children: false });
    assert.equal(resolveLocalCommitAvailability(fixture.root).enabled, false);
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(contract.policy.audit_enabled, false);
    assert.equal(resolveLocalCommitAvailability(fixture.root).enabled, false);
});

test('a runtime entry cannot gain manual-at-creation exemption by editing notes', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    appendMandatoryTaskEvent(fixture.bundle, PARENT_ID, 'TASK_MODE_ENTERED', 'PASS', 'Isolated real runtime boundary.', {});
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID), /Manual-at-creation/iu);
});

test('retained runtime parents need one explicit compatibility choice without reset', async () => {
    const fixture = await parentFixture({ legacy: true });
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID), /compatibility/iu);
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID, { legacyAuditEnabled: false,
        compatibilityReason: 'The original parent intent was automatic child aggregation.' });
    assert.equal(contract.compatibility, true);
    assert.equal(contract.policy.audit_enabled, false);
    writeQueue(fixture.root, `Decomposition source: manual-operator; child tasks: ${PARENT_ID}-1, ${PARENT_ID}-2;`);
    assert.equal(readParentCompletionContract(fixture.root, PARENT_ID)!.policy.origin, 'runtime');
});
