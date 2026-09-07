import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './next-step-review-reuse-fixtures';
import {
    isFullSuiteSatisfiedBySemanticCycleResume,
    isReviewSatisfiedBySemanticCycleResume
} from '../../../../src/gates/next-step/next-step-review-reuse-routing';
const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    assertGateChainDecision,
    buildReviewReuseCandidatesForDiagnostics,
    fileSha256,
    formatNextStepText,
    fs,
    makeTempRepo,
    markReviewEvidenceAsStrictReuse,
    path,
    resolveNextStep,
    reviewsRoot,
    seedCompilePass,
    seedFullSuiteValidation,
    seedReviewGatePass,
    seedRulePack,
    seedStartedTask,
    TASK_ID,
    writeFreshReviewContextWithoutRouting,
    writeJson,
    writePreflight,
    writeReviewEvidence
} = fx;
void [assert];

function materializeCurrentStrictReuse(repoRoot: string, taskId: string, reviewType: string): void {
    const contextPath = writeFreshReviewContextWithoutRouting(repoRoot, taskId, reviewType);
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const domainScopeFingerprints = metrics.domain_scope_fingerprints
        && typeof metrics.domain_scope_fingerprints === 'object'
        && !Array.isArray(metrics.domain_scope_fingerprints)
        ? metrics.domain_scope_fingerprints as Record<string, unknown>
        : null;
    const legacyScopes = domainScopeFingerprints?.legacy
        && typeof domainScopeFingerprints.legacy === 'object'
        && !Array.isArray(domainScopeFingerprints.legacy)
        ? domainScopeFingerprints.legacy as Record<string, unknown>
        : {};
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const treeState = context.tree_state && typeof context.tree_state === 'object' && !Array.isArray(context.tree_state)
        ? context.tree_state as Record<string, unknown>
        : {};
    const contextSha256 = fileSha256(contextPath);
    const treeStateSha256 = String(treeState.tree_state_sha256 || '').trim();
    const reviewScopeSha256 = String(legacyScopes.review_scope_sha256 || '').trim();
    const codeScopeSha256 = String(legacyScopes.code_scope_sha256 || '').trim();

    receipt.preflight_sha256 = fileSha256(preflightPath);
    receipt.review_context_sha256 = contextSha256;
    receipt.review_tree_state_sha256 = treeStateSha256;
    if (domainScopeFingerprints) {
        receipt.domain_scope_fingerprints = domainScopeFingerprints;
    }
    if (reviewScopeSha256) {
        receipt.review_scope_sha256 = reviewScopeSha256;
    }
    if (codeScopeSha256) {
        receipt.code_scope_sha256 = codeScopeSha256;
    }
    writeJson(receiptPath, receipt);

    const receiptSha256 = fileSha256(receiptPath);
    const receiptSnapshotPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt-${receiptSha256}.json`);
    fs.copyFileSync(receiptPath, receiptSnapshotPath);
    const artifactSha256 = fileSha256(artifactPath);
    const artifactSnapshotPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-artifact-${artifactSha256}.md`);
    fs.copyFileSync(artifactPath, artifactSnapshotPath);

    appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', {
        ...receipt,
        reuse_event_type: 'REVIEW_EVIDENCE_REUSED',
        receipt_path: receiptPath,
        receipt_sha256: receiptSha256,
        receipt_snapshot_path: receiptSnapshotPath,
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_path: artifactPath,
        review_artifact_sha256: artifactSha256,
        review_artifact_snapshot_path: artifactSnapshotPath,
        review_artifact_snapshot_sha256: artifactSha256,
        review_context_path: contextPath,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeStateSha256
    });
}

describe('gates/next-step review reuse rebind routing', () => {
    it('accepts only review lanes named by a reusable semantic-cycle transaction', () => {
        assert.equal(isReviewSatisfiedBySemanticCycleResume({
            reviewType: 'security',
            ordinarySatisfied: false,
            semanticResumeReusable: true,
            acceptedReviewTypes: ['code', 'security']
        }), true);
        assert.equal(isReviewSatisfiedBySemanticCycleResume({
            reviewType: 'api',
            ordinarySatisfied: false,
            semanticResumeReusable: true,
            acceptedReviewTypes: ['code', 'security']
        }), false);
        assert.equal(isReviewSatisfiedBySemanticCycleResume({
            reviewType: 'security',
            ordinarySatisfied: false,
            semanticResumeReusable: false,
            acceptedReviewTypes: ['security']
        }), false);
    });

    it('accepts semantic full-suite evidence only while active configuration matches', () => {
        assert.equal(isFullSuiteSatisfiedBySemanticCycleResume({
            semanticResumeReusable: true,
            acceptedFullSuite: true,
            currentConfigMatches: true
        }), true);
        assert.equal(isFullSuiteSatisfiedBySemanticCycleResume({
            semanticResumeReusable: true,
            acceptedFullSuite: true,
            currentConfigMatches: false
        }), false);
    });

    it('does not treat stale pre-compile review routing as upstream pass evidence', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('current REVIEWER_DELEGATION_ROUTED telemetry'));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-context-to-routing',
            status: 'pass'
        });
        assert.ok(result.reason.includes('LaneScope=review_type'));
        assert.ok(result.reason.includes('opaque handoff artifact'));
        assert.ok(result.reason.includes('Do not open or summarize'));
        assert.ok(result.reason.includes('new clean-context delegated reviewer'));
        assert.ok(result.reason.includes('provider-native/internal agent or subagent tool'));
        assert.ok(result.reason.includes('not a shell command or hand-written artifact'));
        assert.ok(result.reason.includes('do not reuse an existing reviewer session'));
        assert.ok(result.reason.includes('fork_context=false'));
        assert.ok(result.reason.includes('If the current provider session cannot launch a fresh delegated reviewer, stop and report that blocker'));
        assert.ok(result.reason.includes('instead of fabricating routing, launch, review, receipt, or telemetry evidence'));
        assert.ok(result.reason.includes('Reviewer readiness chain: preflight scope=current -> review context=current'));
        assert.ok(result.reason.includes('routing=missing current-cycle telemetry'));
        assert.ok(result.reason.includes('launch artifact=blocked until routing'));
        assert.equal(result.commands[0].label, 'Record fresh delegated review routing');
    });

    it('rebinds downstream strict-sequential review when upstream reuse is recorded after downstream phase', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.ok(result.reason.includes("latest review phase predates the upstream review record"), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('advances to review gate when downstream current PASS context reuse is accepted after upstream remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_CONTEXT_REUSE_ACCEPTED', 'PASS', {
            review_type: 'test',
            current_pass_review_evidence: true,
            output_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-test-review-context.json`)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check', result.reason);
        assert.ok(result.commands[0].command.includes('gate required-reviews-check'));
        assert.ok(!result.commands[0].command.includes('build-review-context'));
        assert.ok(!result.reason.includes('latest review phase predates the upstream review record'));
    });

    it('materializes upstream code reuse before restarted downstream test rebind', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', { restarted: true });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        appendEvent(repoRoot, TASK_ID, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        appendEvent(repoRoot, TASK_ID, 'SHELL_SMOKE_PREFLIGHT_RECORDED');

        const testFile = path.join(repoRoot, 'tests', 'restart-cycle.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("restart cycle", () => {});\n', 'utf8');
        const restartedPreflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/restart-cycle.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        const restartedTaskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const restartedCompileEvidencePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`);
        appendEvent(repoRoot, TASK_ID, 'COHERENT_CYCLE_RESTARTED', 'PASS', {
            restart_event_schema_version: 1,
            task_id: TASK_ID,
            event_type: 'COHERENT_CYCLE_RESTARTED',
            task_mode_path: restartedTaskModePath.replace(/\\/g, '/'),
            task_mode_sha256: fileSha256(restartedTaskModePath),
            preflight_path: restartedPreflightPath.replace(/\\/g, '/'),
            preflight_sha256: fileSha256(restartedPreflightPath),
            compile_evidence_path: restartedCompileEvidencePath.replace(/\\/g, '/'),
            compile_evidence_sha256: fileSha256(restartedCompileEvidencePath),
            detected_changed_files_count: 2,
            elapsed_ms: 1,
            restart_reason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
            next_step_summary: 'continue restarted downstream rebind through upstream reuse materialization'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('prepare-reviewer-launch'));
    });

    it('does not rebind downstream strict-sequential review after the review gate passed', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate', result.reason);
        assert.ok(!result.commands[0].command.includes('build-review-context'));
        assert.ok(!result.reason.includes('latest review phase predates the upstream review record'));
    });

    it('materializes upstream code reuse after test-only remediation before downstream test', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        const testFile = path.join(repoRoot, 'tests', 'review-domain.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review domain", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-domain.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('prepare-reviewer-launch'));
    });

    it('materializes upstream code reuse before failed test review after a test-only remediation delta', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as {
            full_suite_validation: {
                enabled: boolean;
                command: string;
                placement: string;
            };
        };
        workflowConfig.full_suite_validation.enabled = true;
        workflowConfig.full_suite_validation.command = 'npm test';
        workflowConfig.full_suite_validation.placement = 'after_compile_before_reviews';
        writeJson(workflowConfigPath, workflowConfig);
        const testFile = path.join(repoRoot, 'tests', 'failed-test-review.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("failed test review", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/failed-test-review.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test', {
            verdict: 'fail',
            body: 'P1: Missing test assertion coverage for the failed test lane rerun.\n\n'
        });

        fs.writeFileSync(
            testFile,
            'test("failed test review", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        seedFullSuiteValidation(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('full-suite-validation'));
        assert.ok(!result.commands[0].command.includes('prepare-reviewer-launch'));
    });

    it('materializes upstream code reuse before failed test review plus test-only remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as {
            full_suite_validation: {
                enabled: boolean;
                command: string;
                placement: string;
            };
        };
        workflowConfig.full_suite_validation.enabled = true;
        workflowConfig.full_suite_validation.command = 'npm test';
        workflowConfig.full_suite_validation.placement = 'after_compile_before_reviews';
        writeJson(workflowConfigPath, workflowConfig);
        const testFile = path.join(repoRoot, 'tests', 'performance-upstream-test-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("performance upstream test remediation", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/performance-upstream-test-remediation.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            performance: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'performance');
        writeReviewEvidence(repoRoot, TASK_ID, 'test', {
            verdict: 'fail',
            body: 'P1: Missing assertion coverage for the failed test review rerun.\n\n'
        });

        fs.writeFileSync(
            testFile,
            'test("performance upstream test remediation", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            performance: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        seedFullSuiteValidation(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
        assert.ok(!result.commands[0].command.includes('--review-type "performance"'));
        assert.ok(!result.commands[0].command.includes('full-suite-validation'));
        assert.doesNotMatch(result.title, /Materialize 'performance' review reuse/);
    });

    for (const history of ['recent', 'outside-tail', 'compile-outside-tail', 'invalid-old-json', 'forged-source', 'invalid-old-timing']) it(`routes materialized code reuse safely with ${history} history`, () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'materialized-code-reuse.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("materialized reuse", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/materialized-code-reuse.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test', {
            verdict: 'fail',
            body: 'P1: Missing rerun coverage in the test-only remediation path.\n\n'
        });
        if (history === 'invalid-old-timing') {
            const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            receipt.review_output_source_mtime_utc = '2026-04-27T23:59:59.000Z';
            writeJson(receiptPath, receipt);
        }
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'code');

        fs.writeFileSync(
            testFile,
            'test("materialized reuse", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        if (history !== 'recent') {
            appendEvent(repoRoot, TASK_ID, 'DIAGNOSTIC_NOISE', 'INFO', { padding: 'x'.repeat(2 * 1024 * 1024) });
        }
        seedCompilePass(repoRoot, TASK_ID);
        if (history === 'compile-outside-tail') {
            appendEvent(repoRoot, TASK_ID, 'DIAGNOSTIC_NOISE', 'INFO', { padding: 'x'.repeat(2 * 1024 * 1024) });
        }
        materializeCurrentStrictReuse(repoRoot, TASK_ID, 'code');
        if (history === 'invalid-old-json') {
            const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`);
            fs.writeFileSync(timelinePath, '{invalid JSON}\n' + fs.readFileSync(timelinePath, 'utf8'));
        }
        if (history === 'forged-source') {
            const receipt = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`), 'utf8'));
            const sourceSnapshotPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt-${receipt.reused_from_receipt_sha256}.json`);
            fs.writeFileSync(sourceSnapshotPath, '{}');
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        if (history === 'invalid-old-json' || history === 'forged-source' || history === 'invalid-old-timing') {
            assert.equal(result.status, 'BLOCKED');
            assert.notEqual(result.review.next_review_type, 'test', 'invalid historical evidence must not authorize downstream review');
            return;
        }
        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'test', result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
        assert.doesNotMatch(result.title, /Materialize 'code' review reuse/);
    });

    it('keeps upstream code first before downstream test when code domain changed', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        const testFile = path.join(repoRoot, 'tests', 'review-domain.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review domain", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-domain.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Prepare 'code' review context/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('materializes upstream code reuse before downstream refactor after test-only remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'strict-reuse-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("strict reuse remediation", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/strict-reuse-remediation.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');

        fs.writeFileSync(
            testFile,
            'test("strict reuse remediation", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
        assert.ok(!result.commands[0].command.includes('--review-type "refactor"'));

        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });

        const securityResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(securityResult.next_gate, 'build-review-context', securityResult.reason);
        assert.equal(securityResult.review.next_review_type, 'security', securityResult.reason);
        assert.match(securityResult.title, /Materialize 'security' review reuse/);
        assert.match(securityResult.reason, /not bound as current-cycle review evidence/);
        assert.ok(!securityResult.commands[0].command.includes('--review-type "code"'));
        assert.ok(securityResult.commands[0].command.includes('--review-type "security"'));
        assert.ok(!securityResult.commands[0].command.includes('--review-type "refactor"'));
        assert.deepEqual(securityResult.invalidation_impact?.affected_review_lanes, ['security', 'refactor', 'test']);
        assert.deepEqual(securityResult.invalidation_impact?.minimal_recovery_chain, [
            'build-review-context',
            'materialize current-cycle review reuse',
            'rerun navigator before downstream review/check gates'
        ]);
        assert.deepEqual(securityResult.invalidation_impact?.reuse_candidates, [
            'security (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'refactor (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'test (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)'
        ]);
    });

    it('re-materializes stale upstream reuse after a later compile before downstream refactor', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'strict-reuse-repeat-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("strict reuse repeat remediation", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/strict-reuse-repeat-remediation.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'code');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'security');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'refactor');

        fs.writeFileSync(
            testFile,
            'test("strict reuse repeat remediation", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.match(result.reason, /not bound as current-cycle review evidence/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
        assert.ok(!result.commands[0].command.includes('--review-type "refactor"'));
        assert.deepEqual(result.invalidation_impact?.stale_artifact_classes, [
            'preflight/scope',
            'compile evidence',
            'review context',
            'reviewer routing',
            'reviewer launch/invocation',
            'review artifact/receipt',
            'review gate evidence'
        ]);
        assert.deepEqual(result.invalidation_impact?.affected_review_lanes, ['code', 'security', 'refactor', 'test']);
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, [
            'code (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'security (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'refactor (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'test (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)'
        ]);

        const text = formatNextStepText(result);
        assert.match(text, /InvalidationImpact:/);
        assert.match(text, /AffectedReviewLanes: code, security, refactor, test/);
        assert.match(text, /ReuseCandidates: code \(current PASS evidence may be rebound/);
    });

    it('routes review-gate stale upstream failures to upstream rebind instead of retrying the review gate', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        const testFile = path.join(repoRoot, 'tests', 'review-gate-stale-upstream.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review gate stale upstream", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-gate-stale-upstream.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            violations: [
                "Review 'code' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle."
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.ok(result.reason.includes('not bound as current-cycle review evidence'), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.deepEqual(result.invalidation_impact?.stale_artifact_classes, [
            'preflight/scope',
            'compile evidence',
            'review context',
            'reviewer routing',
            'reviewer launch/invocation',
            'review artifact/receipt',
            'review gate evidence'
        ]);
        assert.deepEqual(result.invalidation_impact?.affected_review_lanes, ['code']);
        assert.deepEqual(result.invalidation_impact?.minimal_recovery_chain, [
            'build-review-context',
            'materialize current-cycle review reuse',
            'rerun navigator before downstream review/check gates'
        ]);
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, [
            'code (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)'
        ]);
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('advances after current PASS context acceptance resolves the stale upstream gate failure', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        fx.writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            taskProfile: 'balanced',
            expectedReviewTypes: ['code', 'test']
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            violations: [
                "Review 'code' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle."
            ]
        });

        const blocked = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(blocked.next_gate, 'build-review-context', blocked.reason);
        assert.ok(blocked.commands[0].command.includes('--review-type "code"'));

        appendEvent(repoRoot, TASK_ID, 'REVIEW_CONTEXT_REUSE_ACCEPTED', 'PASS', {
            review_type: 'code',
            current_pass_review_evidence: true,
            output_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`)
        });

        const recovered = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(recovered.next_gate, 'required-reviews-check', recovered.reason);
        assert.ok(recovered.commands[0].command.includes('gate required-reviews-check'));
        assert.ok(!recovered.commands[0].command.includes('build-review-context'));
    });

    it('routes review context hash mismatch failures to upstream recovery instead of fresh reviewer work', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        const testFile = path.join(repoRoot, 'tests', 'review-gate-hash-mismatch.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review gate hash mismatch", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-gate-hash-mismatch.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            violations: [
                "Review context hash mismatch for 'code'. Review-context artifact was modified after receipt was issued."
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.ok(result.reason.includes('not bound as current-cycle review evidence'), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
        assert.ok(!result.commands[0].command.includes('prepare-reviewer-launch'));
        assert.deepEqual(result.invalidation_impact?.minimal_recovery_chain, [
            'build-review-context',
            'materialize current-cycle review reuse',
            'rerun navigator before downstream review/check gates'
        ]);
    });

    it('routes lane-domain-current historical PASS evidence to review reuse after coherent-cycle restart', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const changedFiles = ['src/app.ts', 'tests/rebound-context.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        const reboundPreflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        const reboundPreflight = JSON.parse(fs.readFileSync(reboundPreflightPath, 'utf8'));
        writeJson(reboundPreflightPath, {
            ...reboundPreflight,
            coherent_cycle_rebound_marker: true
        });
        fx.seedPostPreflightRulePack(repoRoot, TASK_ID, reboundPreflightPath);
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Prepare|Rebind|Materialize/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'), result.commands[0].command);
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
        assert.ok(!result.commands[0].command.includes('prepare-reviewer-launch'));
    });

    it('routes review-gate stale upstream failures even when upstream context is current after a later compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-gate-later-compile.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            violations: [
                "Review 'code' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle."
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.ok(result.reason.includes('not bound as current-cycle review evidence'), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, [
            'code (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'security (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'refactor (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'test (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)'
        ]);
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('keeps concrete reuse candidates visible when route text represents validated reuse', () => {
        const reuseCandidates = buildReviewReuseCandidatesForDiagnostics(
            "Recover stale upstream 'code' review evidence after review gate failure. " +
            "The latest required-reviews-check failed after compile, and upstream 'code' is lane-domain current " +
            "but its review-context/routing binding is stale for the current preflight. " +
            "Rebind 'code' through build-review-context/reuse before rerunning required-reviews-check.",
            ['code', 'test']
        );

        assert.deepEqual(reuseCandidates, [
            'code (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'test (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)'
        ]);
    });

    it('rejects misleading none diagnostics for historical PASS lanes while authoritative reuse validation is pending', () => {
        const reuseCandidates = buildReviewReuseCandidatesForDiagnostics(
            "The existing 'code' PASS evidence is lane-domain current, but its exact review-context/reuse hash " +
            'eligibility has not been validated for the current preflight. Reuse eligibility validation is still ' +
            'required before treating that PASS evidence as reusable.',
            ['code']
        );

        assert.deepEqual(reuseCandidates, [
            'code (historical PASS evidence exists; authoritative reuse eligibility is pending build-review-context validation)'
        ]);
    });

    it('re-materializes lane-domain-current reused review evidence after a later compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`);
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const originalPreflight = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')
        ) as Record<string, unknown>;
        const originalPreflightMetrics = originalPreflight.metrics as Record<string, unknown>;
        const originalLegacyScopes = ((originalPreflightMetrics.domain_scope_fingerprints as Record<string, unknown>)
            .legacy || {}) as Record<string, unknown>;
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_scope_sha256 = originalLegacyScopes.review_scope_sha256;
        receipt.code_scope_sha256 = originalLegacyScopes.code_scope_sha256;
        writeJson(receiptPath, receipt);
        const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
        const historicalReceiptSha256 = fileSha256(receiptPath);
        const historicalReceiptSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-receipt-${historicalReceiptSha256}.json`
        );
        fs.copyFileSync(receiptPath, historicalReceiptSnapshotPath);
        const historicalContextSha256 = fileSha256(contextPath);
        const reviewArtifactSha256 = fileSha256(artifactPath);
        const reviewArtifactSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-artifact-${reviewArtifactSha256}.md`
        );
        fs.copyFileSync(artifactPath, reviewArtifactSnapshotPath);
        const currentReviewContextReuseSha256 = '7'.repeat(64);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            ...receipt,
            receipt_path: receiptPath,
            receipt_sha256: historicalReceiptSha256,
            receipt_snapshot_path: historicalReceiptSnapshotPath,
            receipt_snapshot_sha256: historicalReceiptSha256,
            review_artifact_path: artifactPath,
            review_artifact_sha256: reviewArtifactSha256,
            review_artifact_snapshot_path: reviewArtifactSnapshotPath,
            review_artifact_snapshot_sha256: reviewArtifactSha256,
            review_context_path: contextPath,
            review_context_sha256: historicalContextSha256,
            review_context_reuse_sha256: currentReviewContextReuseSha256,
            review_tree_state_sha256: receipt.review_tree_state_sha256
        });
        receipt.reused_existing_review = true;
        receipt.reused_from_receipt_path = receiptPath;
        receipt.reused_from_receipt_sha256 = historicalReceiptSha256;
        receipt.review_context_reuse_sha256 = currentReviewContextReuseSha256;
        receipt.reused_from_review_context_sha256 = historicalContextSha256;
        receipt.reused_from_review_context_reuse_sha256 = currentReviewContextReuseSha256;
        receipt.reused_from_review_tree_state_sha256 = reviewerProvenance.review_tree_state_sha256;
        receipt.reused_from_review_scope_sha256 = receipt.review_scope_sha256;
        receipt.reused_from_code_scope_sha256 = receipt.code_scope_sha256;
        writeJson(receiptPath, receipt);
        const currentReceiptSha256 = fileSha256(receiptPath);
        const currentReceiptSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-receipt-${currentReceiptSha256}.json`
        );
        fs.copyFileSync(receiptPath, currentReceiptSnapshotPath);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            ...receipt,
            receipt_path: receiptPath,
            receipt_sha256: currentReceiptSha256,
            receipt_snapshot_path: currentReceiptSnapshotPath,
            receipt_snapshot_sha256: currentReceiptSha256,
            review_artifact_path: artifactPath,
            review_artifact_sha256: reviewArtifactSha256,
            review_artifact_snapshot_path: reviewArtifactSnapshotPath,
            review_artifact_snapshot_sha256: reviewArtifactSha256,
            review_context_path: contextPath,
            review_context_sha256: historicalContextSha256,
            review_context_reuse_sha256: currentReviewContextReuseSha256,
            review_tree_state_sha256: receipt.review_tree_state_sha256
        });

        const testFile = path.join(repoRoot, 'tests', 'review-domain.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review domain", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-domain.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse/);
        assert.match(result.reason, /not bound as current-cycle review evidence/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });
});
