import {
    describe,
    it,
    assert,
    childProcess,
    fs,
    path,
    runBuildReviewContextCommand,
    runCompileGateCommand,
    runRequiredReviewsCheckCommand,
    runCliMainWithHandling,
    computeCodeReviewScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    resolveReviewContextReuseContractBindings,
    appendTaskEvent,
    createTempRepo,
    findLastTimelineEventIndex,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runShellSmokeForTask,
    resolveReviewerExecutionFixture,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    writeReceiptBackedReviewArtifact,
    runGit,
    getReviewTreeStateSha256FromFixtureContext,
    updateLatestHistoricalReviewRecordedDetails
} from './gates-review-reuse-fixtures';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath
} from '../../../../../../src/gates/review/review-findings-validation-artifact';
import {
    buildReviewFindingsDispositionArtifact,
    getReviewFindingsDispositionArtifactPath,
    getReviewFindingsDispositionArtifactSnapshotPath
} from '../../../../../../src/gates/review/review-findings-disposition-artifact';
import {
    resolveLockedReviewFindingPolicyFromPreflight
} from '../../../../../../src/gates/review/review-finding-disposition';
import {
    validateReviewFindingsContract
} from '../../../../../../src/gates/review/review-findings-artifact-verdict';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../../../src/gates/review/review-evidence-contract';
import type { ReviewRemediationReviewContract } from '../../../../../../src/gates/review-remediation/review-remediation-review-contract';
import {
    materializeReviewFindingsFollowUpTasks
} from '../../../../../../src/gates/review/review-findings-follow-up-tasks';
import {
    TRUST_BOUNDARY_ANALYSIS_RULE_ID
} from '../../../../../../src/core/trust-boundary-analysis';
import {
    QUALITY_CHECKLIST_ID,
    resolveDefaultQualityChecklistArtifactPath
} from '../../../../../../src/gates/quality-checklist';

function sha256File(filePath: string): string {
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(fs.readFileSync(filePath, 'utf8')).digest('hex');
}

function sha256Text(text: string): string {
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(text).digest('hex');
}

function sha256Json(value: unknown): string {
    return sha256Text(`${JSON.stringify(value, null, 2)}\n`);
}

function seedBalancedTaskQueue(repoRoot: string, taskId: string): void {
    seedTaskQueue(repoRoot, taskId);
    const taskPath = path.join(repoRoot, 'TASK.md');
    const taskText = fs.readFileSync(taskPath, 'utf8');
    fs.writeFileSync(taskPath, taskText.replace('| default | fixture |', '| balanced | fixture |'), 'utf8');
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.copyFileSync(
        path.resolve('template/config/profiles.json'),
        path.join(configDir, 'profiles.json')
    );
}

function seedTrustBoundaryChecklist(repoRoot: string, taskId: string, preflightPath: string): void {
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(repoRoot, taskId);
    const preflightSha256 = sha256File(preflightPath);
    const evidenceRelativePath = 'tests/node/gates/review-context/review-context-trust-boundary-analysis.test.ts';
    const evidencePath = path.join(repoRoot, evidenceRelativePath);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(
        evidencePath,
        "test('rejects replaced trust-boundary evidence', () => { assert.equal(true, true); });\n",
        'utf8'
    );
    const artifactText = `${JSON.stringify({
        task_id: taskId,
        checklist_id: QUALITY_CHECKLIST_ID,
        preflight_sha256: preflightSha256,
        status: 'PASS',
        rules: [{
            id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
            scope_applicability: 'active'
        }],
        answers: [{
            rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
            trust_boundary_matrix: [{
                boundary_id: 'TB-FIXTURE-001',
                boundary: 'Workflow configuration input to review-reuse validation',
                authority_source: 'Hash-chained QUALITY_CHECKLIST_RECORDED test event',
                mutable_inputs: ['workflow configuration', 'quality-checklist artifact'],
                integrity_evidence: ['recorded artifact sha256', 'preflight sha256'],
                canonical_reconstruction: 'Rebuild from the current workflow configuration and preflight.',
                toctou_replay: 'Reject a digest mismatch or stale preflight binding.',
                negative_paths: [{
                    kind: 'replaced',
                    scenario: 'rejects replaced trust-boundary evidence',
                    expected_behavior: 'Reject review-context construction.',
                    evidence_files: [
                        `${evidenceRelativePath}#rejects replaced trust-boundary evidence`
                    ]
                }]
            }]
        }]
    }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'QUALITY_CHECKLIST_RECORDED',
        'PASS',
        'Quality checklist test fixture recorded.',
        {
            artifact_path: artifactPath.replace(/\\/gu, '/'),
            artifact_hash: sha256Text(artifactText),
            status: 'PASS',
            outcome: 'PASS',
            checklist_id: QUALITY_CHECKLIST_ID,
            preflight_path: path.resolve(preflightPath).replace(/\\/gu, '/'),
            preflight_sha256: preflightSha256
        },
        { actor: 'gate' }
    );
}

function addBalancedLowFindingToReusableCodeReview(
    repoRoot: string,
    taskId: string,
    preflightPath: string
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const reviewContextText = fs.readFileSync(reviewContextPath, 'utf8');
    const reviewContext = JSON.parse(reviewContextText) as Record<string, unknown>;
    const reviewContextSha256 = sha256Text(reviewContextText);
    const reviewTreeStateSha256 = getReviewTreeStateSha256FromFixtureContext(reviewContext);
    const coverageContract = reviewContext.coverage_contract as Record<string, unknown>;
    const reviewExecution = reviewContext.review_execution as ReviewRemediationReviewContract;
    const reviewExecutionBindings = resolveReviewContextExecutionEvidenceBindings(reviewContext).bindings!;
    const report = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    const findings = report.findings as Record<string, unknown[]>;
    const coverageLedger = report.coverage_ledger as Record<string, unknown>;
    const entries = coverageLedger.entries as Array<Record<string, unknown>>;
    const obligationId = String(entries[0]?.obligation_id || 'FILE-001');
    findings.low = [{
        id: 'F-001',
        title: 'Accepted low follow-up finding',
        description: 'A low severity reviewer finding at src/gates/review-context/review-context-token-economy.ts:54 should be retained as non-blocking under balanced review finding policy.',
        evidence: [{
            location: 'src/app.ts:1',
            observation: 'The changed line remains covered by historical review evidence.'
        }],
        coverage_obligation_ids: [obligationId]
    }];
    entries[0].finding_ids = ['F-001'];
    const artifactText = `${JSON.stringify(report, null, 2)}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactSha256 = sha256Text(artifactText);
    const artifactSnapshotPath = artifactPath.replace(/\.md$/u, `-artifact-${artifactSha256}.md`);
    fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');

    const validation = validateReviewFindingsContract({
        content: artifactText,
        expectedTaskId: taskId,
        expectedReviewType: 'code',
        expectedReviewContextSha256: reviewContextSha256,
        expectedTreeStateSha256: reviewTreeStateSha256 || undefined,
        coverageContract: coverageContract as never,
        repoRoot,
        expectedReviewExecutionContract: reviewExecution
    });
    assert.equal(validation.valid, true, validation.violations.join('\n'));
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId,
        reviewType: 'code',
        validation,
        reviewOutputSha256: artifactSha256,
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: artifactSha256,
        reviewContextPath,
        reviewContextSha256,
        preflightPath,
        preflightSha256: String(receipt.preflight_sha256 || ''),
        scopeSha256: typeof receipt.scope_sha256 === 'string' ? receipt.scope_sha256 : null,
        reviewScopeSha256: typeof receipt.review_scope_sha256 === 'string' ? receipt.review_scope_sha256 : null,
        codeScopeSha256: typeof receipt.code_scope_sha256 === 'string' ? receipt.code_scope_sha256 : null,
        reviewTreeStateSha256,
        coverageContract: coverageContract as never
    });
    const validationArtifactSha256 = sha256Json(validationArtifact);
    const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
        validationArtifactPath,
        validationArtifactSha256
    );
    fs.writeFileSync(validationArtifactPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
    fs.writeFileSync(validationArtifactSnapshotPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const policyResolution = resolveLockedReviewFindingPolicyFromPreflight(preflight);
    const dispositionArtifactPath = getReviewFindingsDispositionArtifactPath(artifactPath);
    const dispositionArtifact = buildReviewFindingsDispositionArtifact({
        taskId,
        reviewType: 'code',
        validationArtifact,
        validationArtifactPath,
        validationArtifactSha256,
        policyResolution
    });
    const dispositionArtifactSha256 = sha256Json(dispositionArtifact);
    const dispositionSnapshotPath = getReviewFindingsDispositionArtifactSnapshotPath(
        dispositionArtifactPath,
        dispositionArtifactSha256
    );
    fs.writeFileSync(dispositionArtifactPath, `${JSON.stringify(dispositionArtifact, null, 2)}\n`, 'utf8');
    fs.writeFileSync(dispositionSnapshotPath, `${JSON.stringify(dispositionArtifact, null, 2)}\n`, 'utf8');

    const reportSha256 = sha256Json(report);
    Object.assign(receipt, {
        review_artifact_sha256: artifactSha256,
        review_output_sha256: artifactSha256,
        review_output_format: 'findings_json',
        review_output_schema_version: Number(report.schema_version),
        review_findings_report_sha256: reportSha256,
        review_findings_report: report,
        review_findings_summary: {
            finding_counts: { critical: 0, high: 0, medium: 0, low: 1 },
            residual_risk_count: 0,
            coverage_entry_count: entries.length
        },
        review_findings_validation: {
            artifact_path: validationArtifactPath.replace(/\\/g, '/'),
            artifact_sha256: validationArtifactSha256,
            snapshot_path: validationArtifactSnapshotPath.replace(/\\/g, '/'),
            snapshot_sha256: validationArtifactSha256,
            status: validationArtifact.validation_result.status,
            accepted: validationArtifact.validation_result.accepted,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            violation_count: validationArtifact.validation_result.violations.length
        },
        review_findings_disposition: dispositionArtifact.disposition_result,
        review_findings_disposition_artifact: {
            artifact_path: dispositionArtifactPath.replace(/\\/g, '/'),
            artifact_sha256: dispositionArtifactSha256,
            snapshot_path: dispositionSnapshotPath.replace(/\\/g, '/'),
            snapshot_sha256: dispositionArtifactSha256,
            disposition_result_sha256: dispositionArtifact.disposition_result_sha256,
            policy_id: dispositionArtifact.policy.policy_id,
            policy_source: dispositionArtifact.policy.policy_source,
            item_count: dispositionArtifact.summary.item_count,
            fix_now_count: dispositionArtifact.summary.fix_now_count,
            follow_up_pending_count: dispositionArtifact.summary.follow_up_pending_count,
            ignored_count: dispositionArtifact.summary.ignored_count,
            blocking_count: dispositionArtifact.summary.blocking_count
        },
        review_output_contract: {
            schema_version: 1,
            format: 'findings_json',
            report_sha256: reportSha256,
            validation_artifact_sha256: validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            disposition_artifact_sha256: dispositionArtifactSha256,
            disposition_result_sha256: dispositionArtifact.disposition_result_sha256,
            raw_output_sha256: artifactSha256,
            review_artifact_sha256: artifactSha256,
            review_context_sha256: reviewContextSha256,
            review_tree_state_sha256: reviewTreeStateSha256,
            coverage_contract_sha256: String(coverageContract.contract_sha256 || ''),
            ...reviewExecutionBindings,
            reviewer_identity: receipt.reviewer_identity,
            reviewer_provenance_event_sha256: (receipt.reviewer_provenance as Record<string, unknown> | undefined)?.event_sha256 ?? null
        }
    });
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptSha256 = sha256Text(receiptText);
    const receiptSnapshotPath = artifactPath.replace(/\.md$/u, `-receipt-${receiptSha256}.json`);
    fs.writeFileSync(receiptPath, receiptText, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptText, 'utf8');
    updateLatestHistoricalReviewRecordedDetails(repoRoot, taskId, 'code', (details) => {
        Object.assign(details, receipt, {
            receipt_path: receiptPath.replace(/\\/g, '/'),
            receipt_sha256: receiptSha256,
            receipt_snapshot_path: receiptSnapshotPath.replace(/\\/g, '/'),
            receipt_snapshot_sha256: receiptSha256,
            review_artifact_path: artifactPath.replace(/\\/g, '/'),
            review_artifact_snapshot_path: artifactSnapshotPath.replace(/\\/g, '/'),
            review_artifact_snapshot_sha256: artifactSha256,
            review_context_path: reviewContextPath.replace(/\\/g, '/')
        });
    });
}

function enablePreReviewFullSuite(repoRoot: string): void {
    const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
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
    fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
}

function writeFullSuitePassEvidence(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    revision: string
): string {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const latestCompile = [...readTaskTimelineEvents(repoRoot, taskId)]
        .reverse()
        .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
    assert.ok(latestCompile);
    const compileTimestamp = String((latestCompile as Record<string, unknown>).timestamp_utc || '').trim();
    assert.ok(compileTimestamp);
    const outputArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-${revision}.log`);
    fs.writeFileSync(outputArtifactPath, `full suite pass ${revision}\n`, 'utf8');
    const cycleBinding = {
        task_id: taskId,
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: sha256File(preflightPath),
        compile_gate_timestamp: compileTimestamp
    };
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    fs.writeFileSync(artifactPath, `${JSON.stringify({
        task_id: taskId,
        status: 'PASSED',
        enabled: true,
        command: 'npm test',
        placement: 'after_compile_before_reviews',
        exit_code: 0,
        timed_out: false,
        duration_ms: 1000,
        output_artifact_path: outputArtifactPath.replace(/\\/g, '/'),
        compact_summary: [`# full suite pass ${revision}`],
        failure_chunks: [],
        violations: [],
        warnings: [],
        cycle_binding: cycleBinding
    }, null, 2)}\n`, 'utf8');
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'FULL_SUITE_VALIDATION_PASSED', 'PASS', 'Full suite validation passed.', {
        command: 'npm test',
        placement: 'after_compile_before_reviews',
        cycle_binding: cycleBinding,
        artifact_path: artifactPath.replace(/\\/g, '/')
    });
    return artifactPath;
}

describe('cli/commands/gates - review reuse upstream reuse', () => {
    it('rejects schema-v3 reuse when the source findings validation artifact is tampered before materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-976-validation-reject';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const value = 1;\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject tampered findings validation reuse evidence'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'explicit_changed_files',
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 1 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const validationReference = receipt.review_findings_validation as Record<string, unknown>;
        const validationArtifactPath = String(validationReference.artifact_path || '').trim();
        const validationSnapshotPath = String(validationReference.snapshot_path || '').trim();
        assert.ok(validationArtifactPath);
        assert.ok(validationSnapshotPath);
        fs.writeFileSync(validationArtifactPath, `${JSON.stringify({ tampered: true }, null, 2)}\n`, 'utf8');
        fs.writeFileSync(validationSnapshotPath, `${JSON.stringify({ tampered: true }, null, 2)}\n`, 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'explicit_changed_files',
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 1 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const latestReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        assert.notEqual(latestReceipt.reused_existing_review, true);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentCycleRecordedEvents = events.filter((event, index) => (
            index > latestCompileSequence
            && event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(currentCycleRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses current-cycle code review evidence and unblocks downstream test review when runtime code scope is unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-reuse-code-review';
        seedBalancedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 5;\nconst b = 7;\nconsole.log(a + b);\n', 'utf8');

        const priorPreflightPath = writePreflight(
            repoRoot,
            taskId,
            {
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 3 },
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            },
            `${taskId}-prior-preflight.json`
        );
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-reuse.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        const codeExecution = resolveReviewerExecutionFixture(taskId, 'Qwen', 'agent:code-reviewer');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review evidence when only test scope changes'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        writeCompilePassEvidence(repoRoot, taskId, priorPreflightPath);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            priorPreflightPath,
            reviewContextPath,
            codeExecution.reviewerIdentity
        );
        addBalancedLowFindingToReusableCodeReview(repoRoot, taskId, priorPreflightPath);
        const taskPath = path.join(repoRoot, 'TASK.md');
        const taskTextBeforeFollowUp = fs.readFileSync(taskPath, 'utf8');
        const followUpMaterialization = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId,
            reviewType: 'code'
        });
        assert.equal(
            followUpMaterialization.status,
            'MATERIALIZED',
            followUpMaterialization.violations.join('\n')
        );
        const materializedTaskText = fs.readFileSync(taskPath, 'utf8');
        const followUpArtifactPath = path.join(reviewsRoot, `${taskId}-code-findings-follow-ups.json`);
        const followUpArtifactText = fs.readFileSync(followUpArtifactPath, 'utf8');
        fs.writeFileSync(taskPath, taskTextBeforeFollowUp, 'utf8');
        fs.rmSync(followUpArtifactPath, { force: true });
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reuse code review evidence when only test scope changes',
            ['src/app.ts', 'tests/app.test.ts'],
            `${taskId}-preflight.json`,
            path.join(reviewsRoot, `${taskId}-task-mode.json`)
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const rejectedReuse = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(rejectedReuse.reusedReviewEvidence, false);
        assert.ok(rejectedReuse.outputLines.some((line) => (
            line.includes('prior findings disposition evidence is not satisfied')
            && line.toLowerCase().includes('follow-up artifact')
        )), rejectedReuse.outputLines.join('\n'));

        fs.writeFileSync(taskPath, materializedTaskText, 'utf8');
        fs.writeFileSync(followUpArtifactPath, followUpArtifactText, 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot
            ]);
            writeReceiptBackedReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(refreshedReceipt.reviewer_identity, codeExecution.reviewerIdentity);
        assert.equal(refreshedReceipt.reused_existing_review, true);
        const reusedDisposition = refreshedReceipt.review_findings_disposition as Record<string, unknown>;
        assert.equal(reusedDisposition.verdict, 'pass_with_follow_up_or_ignored_findings');
        assert.equal(reusedDisposition.blocking_count, 0);
        assert.equal(((reusedDisposition.findings as Record<string, Record<string, unknown>>).low).action, 'create_follow_up');
        const refreshedReport = refreshedReceipt.review_findings_report as Record<string, unknown>;
        assert.equal(refreshedReceipt.review_findings_report_sha256, sha256Json(refreshedReport));
        const refreshedFindings = refreshedReport.findings as Record<string, Array<Record<string, unknown>>>;
        assert.match(String(refreshedFindings.low[0].description), /review-context-token-economy\.ts:54/);
        const refreshedValidationReference = refreshedReceipt.review_findings_validation as Record<string, unknown>;
        assert.equal(
            sha256Text(fs.readFileSync(String(refreshedValidationReference.artifact_path), 'utf8')),
            refreshedValidationReference.artifact_sha256
        );
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const reusedCoverage = refreshedReceipt.review_coverage as Record<string, unknown>;
        assert.equal(reusedCoverage.status, 'PASS');
        assert.equal(reusedCoverage.contract_sha256, reviewContext.coverage_contract.contract_sha256);
        assert.equal(
            reusedCoverage.completed_obligation_count,
            reviewContext.coverage_contract.obligation_count
        );
        assert.equal(
            refreshedReceipt.review_tree_state_sha256,
            getReviewTreeStateSha256FromFixtureContext(reviewContext)
        );
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-test-review-context.json`)), true);
        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            testReviewVerdict: 'TEST REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true,"test":true}',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewGateResult.exitCode, 0, reviewGateResult.outputLines.join('\n'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestReviewRecorded = [...events].reverse().find((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '') === 'code'
            && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
        ));
        const latestReviewRecordedDetails = latestReviewRecorded?.details as Record<string, unknown> | undefined;
        assert.equal(
            sha256Text(fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')),
            latestReviewRecordedDetails?.receipt_sha256
        );
        let latestCompileSequence = -1;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            if (events[index].event_type === 'COMPILE_GATE_PASSED') {
                latestCompileSequence = index;
                break;
            }
        }
        const reviewPhaseSequences = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEW_PHASE_STARTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ))
            .map(({ index }) => index);
        const recordedEvents = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEW_RECORDED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.ok(latestCompileSequence >= 0);
        assert.ok(reviewPhaseSequences.some((sequence) => sequence < latestCompileSequence));
        assert.ok(recordedEvents.some(({ index }) => index < latestCompileSequence));
        assert.equal(recordedEvents.some(({ index }) => index > latestCompileSequence), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence for a pure test-only rerun', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-test-only-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const testReviewSkillDir = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'skills',
            'testing-strategy'
        );
        fs.mkdirSync(testReviewSkillDir, { recursive: true });
        fs.copyFileSync(
            path.resolve('template/skill-packs/quality-architecture/skills/testing-strategy/SKILL.md'),
            path.join(testReviewSkillDir, 'SKILL.md')
        );
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a pure test-only rerun'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        const priorReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const refreshedContractBindings = resolveReviewContextReuseContractBindings(refreshedReviewContext);
        assert.equal(
            refreshedReceipt.review_coverage_contract_sha256,
            refreshedContractBindings.coverageContractSha256
        );
        assert.equal(
            refreshedReceipt.review_rule_context_sha256,
            refreshedContractBindings.ruleContextSha256
        );
        assert.equal(
            refreshedReceipt.review_tree_state_sha256,
            getReviewTreeStateSha256FromFixtureContext(refreshedReviewContext)
        );
        assert.equal(
            refreshedReceipt.reused_from_review_tree_state_sha256,
            priorReceipt.review_tree_state_sha256
        );
        assert.equal(
            refreshedReceipt.reused_from_review_context_sha256,
            priorReceipt.review_context_sha256
        );
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeReviewReuseCodeScopeFingerprint(
                'code',
                JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
                repoRoot
            ).code_scope_sha256
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const recordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.ok(recordedEvents.length >= 1);
        assert.equal((recordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        const firstReuseProvenance = refreshedReceipt.reviewer_provenance as Record<string, unknown>;
        const secondPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, secondPreflightPath);

        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', secondPreflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const secondRefreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const secondRefreshedReviewContext = JSON.parse(
            fs.readFileSync(reviewContextPath, 'utf8')
        ) as Record<string, unknown>;
        const secondRefreshedContractBindings = resolveReviewContextReuseContractBindings(
            secondRefreshedReviewContext
        );
        assert.equal(secondRefreshedReceipt.reused_existing_review, true);
        assert.equal(
            secondRefreshedReceipt.review_coverage_contract_sha256,
            secondRefreshedContractBindings.coverageContractSha256
        );
        assert.equal(
            secondRefreshedReceipt.review_rule_context_sha256,
            secondRefreshedContractBindings.ruleContextSha256
        );
        assert.deepEqual(secondRefreshedReceipt.reviewer_provenance, firstReuseProvenance);
        assert.equal(
            secondRefreshedReceipt.reused_from_review_context_sha256,
            priorReceipt.review_context_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_receipt_sha256,
            refreshedReceipt.reused_from_receipt_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_review_tree_state_sha256,
            refreshedReceipt.reused_from_review_tree_state_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_review_scope_sha256,
            refreshedReceipt.reused_from_review_scope_sha256
        );
        const secondEvents = readTaskTimelineEvents(repoRoot, taskId);
        const secondLatestCompileSequence = findLastTimelineEventIndex(secondEvents, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const secondCurrentCycleCodeEvents = secondEvents
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => (
                index > secondLatestCompileSequence
                && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEWER_INVOCATION_ATTESTED' || event.event_type === 'REVIEW_RECORDED')
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 0);
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEW_RECORDED').length, 1);

        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', secondPreflightPath,
                '--repo-root', repoRoot
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-test-review-context.json`)), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('skips rebuilding an unchanged current-cycle PASS review context', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-context-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse current-cycle PASS review context when bindings are unchanged'
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');

        const originalContextText = fs.readFileSync(reviewContextPath, 'utf8');
        const originalReceiptText = fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8');
        const eventsBefore = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(
            eventsBefore,
            (event) => event.event_type === 'COMPILE_GATE_PASSED'
        );
        assert.ok(latestCompileSequence >= 0);
        const currentCycleCodeReviewPhaseCount = eventsBefore.filter((event, index) => {
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : {};
            return (
                index > latestCompileSequence
                && event.event_type === 'REVIEW_PHASE_STARTED'
                && String(details.review_type || '').trim().toLowerCase() === 'code'
            );
        }).length;
        assert.equal(currentCycleCodeReviewPhaseCount, 1);
        const reviewRecordedEvent = [...eventsBefore].reverse().find((event) => (
            event.event_type === 'REVIEW_RECORDED'
        ));
        const reviewRecordedIntegrity = reviewRecordedEvent?.integrity as Record<string, unknown> | undefined;
        assert.equal(typeof reviewRecordedIntegrity?.task_sequence, 'number');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: True'));
        assert.ok(result.outputLines.some((line) => line.includes('review context rebuild skipped')));
        assert.equal(fs.readFileSync(reviewContextPath, 'utf8'), originalContextText);
        assert.equal(fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8'), originalReceiptText);
        const eventsAfter = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(eventsAfter.length, eventsBefore.length + 1);
        const reuseAcceptedEvent = eventsAfter.at(-1);
        assert.equal(reuseAcceptedEvent?.event_type, 'REVIEW_CONTEXT_REUSE_ACCEPTED');
        assert.equal(reuseAcceptedEvent?.outcome, 'PASS');
        const reuseAcceptedDetails = reuseAcceptedEvent?.details as Record<string, unknown>;
        assert.equal(reuseAcceptedDetails.review_type, 'code');
        assert.equal(reuseAcceptedDetails.current_pass_review_evidence, true);
        assert.equal(reuseAcceptedDetails.output_path, reviewContextPath.replace(/\\/g, '/'));
        assert.equal(
            reuseAcceptedDetails.review_recorded_sequence,
            reviewRecordedIntegrity?.task_sequence,
            'reuse telemetry must reference the authenticated task sequence, not the zero-based event index'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds stale full-suite current-pass context and rematerializes strict reuse without fresh reviewer routing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-full-suite-rebind-reused-current-pass';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        enablePreReviewFullSuite(repoRoot);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Rebuild stale full-suite review context while preserving strict review reuse'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        writeCompilePassEvidence(repoRoot, taskId, priorPreflightPath);
        writeFullSuitePassEvidence(repoRoot, taskId, priorPreflightPath, 'prior');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const firstFullSuitePath = writeFullSuitePassEvidence(repoRoot, taskId, preflightPath, 'first-current');
        const firstFullSuiteSha256 = sha256File(firstFullSuitePath);

        const firstBuild = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });
        assert.equal(firstBuild.reusedReviewEvidence, true, firstBuild.outputLines.join('\n'));
        assert.ok(firstBuild.outputLines.includes('ReviewReuseDecision: accepted'), firstBuild.outputLines.join('\n'));
        const firstContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const firstFullSuiteEvidence = firstContext.full_suite_validation as Record<string, unknown>;
        assert.equal(firstFullSuiteEvidence.artifact_sha256, firstFullSuiteSha256);

        const secondFullSuitePath = writeFullSuitePassEvidence(repoRoot, taskId, preflightPath, 'second-current');
        const secondFullSuiteSha256 = sha256File(secondFullSuitePath);
        assert.notEqual(secondFullSuiteSha256, firstFullSuiteSha256);

        const secondBuild = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });
        const secondOutput = secondBuild.outputLines.join('\n');
        assert.equal(secondBuild.reusedReviewEvidence, true, secondOutput);
        assert.ok(secondBuild.outputLines.includes('CurrentPassReviewEvidence: rejected'), secondOutput);
        assert.ok(
            secondBuild.outputLines.some((line) => line.includes('review context full-suite validation binding is stale')),
            secondOutput
        );
        assert.ok(secondBuild.outputLines.includes('ReviewReuseDecision: accepted'), secondOutput);
        assert.ok(!secondBuild.outputLines.some((line) => line.includes('review context rebuild skipped')), secondOutput);

        const secondContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const secondFullSuiteEvidence = secondContext.full_suite_validation as Record<string, unknown>;
        assert.equal(secondFullSuiteEvidence.artifact_sha256, secondFullSuiteSha256);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(latestCompileSequence >= 0);
        const codeReviewEventsAfterCompile = events
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => {
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : {};
                return (
                    index > latestCompileSequence
                    && (
                        event.event_type === 'REVIEWER_DELEGATION_ROUTED'
                        || event.event_type === 'REVIEW_RECORDED'
                    )
                    && String(details.review_type || details.reviewType || '').trim().toLowerCase() === 'code'
                );
            });
        assert.equal(codeReviewEventsAfterCompile.filter(({ event }) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 0);
        const currentCycleRecorded = codeReviewEventsAfterCompile.filter(({ event }) => event.event_type === 'REVIEW_RECORDED');
        assert.equal(currentCycleRecorded.length, 2);
        assert.ok(currentCycleRecorded.every(({ event }) => (
            (event.details as Record<string, unknown>).reused_existing_review === true
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses matching historical code-review evidence when later mutable and recorded receipts were overwritten by polluted scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-historical-reuse-after-receipt-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse historical code review evidence after mutable receipt overwrite'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const originalArtifactText = fs.readFileSync(artifactPath, 'utf8');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const originalHistoricalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEW_RECORDED'
                && typeof event.details === 'object'
                && event.details !== null
                && !Array.isArray(event.details)
                && String((event.details as Record<string, unknown>).review_type || '').trim() === 'code'
            ));
        assert.ok(originalHistoricalReviewRecorded);
        const originalHistoricalDetails = originalHistoricalReviewRecorded.details as Record<string, unknown>;
        const originalReceiptSnapshotSha256 = String(originalHistoricalDetails.receipt_snapshot_sha256 || '').trim();
        assert.ok(originalReceiptSnapshotSha256);
        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        const pollutedArtifactText = [
            '# Review',
            '',
            'This later polluted review artifact represents a real subsequent review cycle that overwrote the canonical markdown artifact for a broader scope.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(artifactPath, pollutedArtifactText, 'utf8');
        const crypto = require('node:crypto');
        const pollutedArtifactHash = crypto
            .createHash('sha256')
            .update(pollutedArtifactText)
            .digest('hex');
        const pollutedArtifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${pollutedArtifactHash}.md`);
        fs.writeFileSync(pollutedArtifactSnapshotPath, pollutedArtifactText, 'utf8');
        const overwrittenReceipt = {
            ...originalReceipt,
            review_artifact_sha256: pollutedArtifactHash,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        };
        assert.notEqual(overwrittenReceipt.code_scope_sha256, originalReceipt.code_scope_sha256);
        writeCompilePassEvidence(repoRoot, taskId, pollutedPreflightPath);
        const pollutedReceiptText = JSON.stringify(overwrittenReceipt, null, 2) + '\n';
        const pollutedReceiptHash = crypto.createHash('sha256').update(pollutedReceiptText).digest('hex');
        const pollutedReceiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${pollutedReceiptHash}.json`);
        fs.writeFileSync(receiptPath, pollutedReceiptText, 'utf8');
        fs.writeFileSync(pollutedReceiptSnapshotPath, pollutedReceiptText, 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'polluted review recorded', {
            ...overwrittenReceipt,
            receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
            receipt_sha256: pollutedReceiptHash,
            receipt_snapshot_path: path.normalize(pollutedReceiptSnapshotPath).replace(/\\/g, '/'),
            receipt_snapshot_sha256: pollutedReceiptHash,
            review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
            review_artifact_snapshot_path: path.normalize(pollutedArtifactSnapshotPath).replace(/\\/g, '/'),
            review_artifact_snapshot_sha256: pollutedArtifactHash,
            review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, true);
        assert.ok(result.outputLines.some((line) => line.includes('matched historical REVIEW_RECORDED')));
        assert.ok(result.outputLines.some((line) => line.includes('rejected latest mutable receipt')));
        const refreshedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reused_existing_review, true);
        assert.equal(refreshedReceipt.reused_from_receipt_sha256, originalReceiptSnapshotSha256);
        assert.notEqual(refreshedReceipt.reused_from_receipt_sha256, pollutedReceiptHash);
        assert.equal(refreshedReceipt.reused_from_code_scope_sha256, originalReceipt.code_scope_sha256);
        assert.notEqual(refreshedReceipt.reused_from_code_scope_sha256, overwrittenReceipt.code_scope_sha256);
        assert.equal(refreshedReceipt.reused_from_review_scope_sha256, originalReceipt.review_scope_sha256);
        assert.equal(fs.readFileSync(artifactPath, 'utf8'), originalArtifactText);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence for a docs-only post-review delta', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-docs-only-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n- Updated docs.\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a docs-only delta'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'CHANGELOG.md'],
            metrics: { changed_lines_total: 5 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeReviewReuseCodeScopeFingerprint(
                'code',
                JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
                repoRoot
            ).code_scope_sha256
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const recordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.ok(recordedEvents.length >= 1);
        assert.equal((recordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code and test review evidence when only changelog is added after reviews', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-docs-only-code-test-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code and test review evidence after changelog-only delta'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, testReviewContextPath, 'agent:test-reviewer');

        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Documented the user-visible change.\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'CHANGELOG.md'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(codeBuild.outputLines.some((line) => line.startsWith('ReviewReuseReason: accepted:')));

        const testBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: testReviewContextPath
        });
        assert.equal(testBuild.reusedReviewEvidence, true);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const refreshedTestReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-test-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(
            refreshedTestReceipt.review_scope_sha256,
            computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const testRecordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.equal((testRecordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior review evidence across review-cycle limit-only workflow config changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-workflow-limits-review-reuse';
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        const workflowConfigRelativePath = 'garda-agent-orchestrator/live/config/workflow-config.json';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        initializeGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewedFeature = true;\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse reviews after one-shot limit configuration drift'
        });

        const reviewsRoot = getReviewsRoot(repoRoot);
        const requiredReviews = {
            code: true,
            db: false,
            security: true,
            refactor: true,
            api: false,
            test: true,
            performance: false,
            infra: false,
            dependency: false
        };
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: requiredReviews
        }, `${taskId}-prior-preflight.json`);
        const reviewTypes = [
            ['code', 'REVIEW PASSED', 'agent:code-reviewer'],
            ['security', 'SECURITY REVIEW PASSED', 'agent:security-reviewer'],
            ['refactor', 'REFACTOR REVIEW PASSED', 'agent:refactor-reviewer'],
            ['test', 'TEST REVIEW PASSED', 'agent:test-reviewer']
        ] as const;
        for (const [reviewType, verdict, reviewerIdentity] of reviewTypes) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                priorPreflightPath,
                path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`),
                reviewerIdentity
            );
        }

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, any>;
        workflowConfig.review_cycle_guard.max_failed_non_test_reviews += 1;
        workflowConfig.review_cycle_guard.max_total_non_test_reviews += 1;
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', workflowConfigRelativePath],
            metrics: { changed_lines_total: 5 },
            triggers: { changed_workflow_config_files: [workflowConfigRelativePath] },
            required_reviews: requiredReviews
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        seedTrustBoundaryChecklist(repoRoot, taskId, preflightPath);

        for (const [reviewType] of reviewTypes) {
            const build = await runBuildReviewContextCommand({
                repoRoot,
                reviewType,
                depth: 2,
                preflightPath,
                outputPath: path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`)
            });
            assert.equal(build.reusedReviewEvidence, true, `${reviewType} review should be reused`);
            assert.ok(build.outputLines.includes('ReviewReuseDecision: accepted'));
        }

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint('security', preflight, repoRoot);
        const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, repoRoot);
        assert.deepEqual(codeScopeFingerprint.review_reuse_neutral_config_files, [workflowConfigRelativePath]);
        assert.deepEqual(reviewScopeFingerprint.review_reuse_neutral_config_files, [workflowConfigRelativePath]);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(workflowConfigRelativePath), false);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(workflowConfigRelativePath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps task-owned manual-validation evidence out of non-test code scope but not generic review scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-manual-validation-neutral-reuse';
        const reviewsRoot = getReviewsRoot(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse non-test reviews after manual-validation evidence refresh'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 2 }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            priorPreflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );
        const priorPreflight = JSON.parse(fs.readFileSync(priorPreflightPath, 'utf8')) as Record<string, unknown>;
        const priorCodeScope = computeReviewReuseCodeScopeFingerprint('code', priorPreflight, repoRoot);
        const priorReviewScope = computeReviewRelevantScopeFingerprint(priorPreflight, repoRoot);
        const evidencePath = `garda-agent-orchestrator/runtime/manual-validation/${taskId}/review-evidence.json`;
        const selectorPath = `garda-agent-orchestrator/runtime/manual-validation/${taskId}/selector.json`;
        const logPath = `garda-agent-orchestrator/runtime/manual-validation/${taskId}/gradle-test.log`;
        fs.mkdirSync(path.dirname(path.join(repoRoot, evidencePath)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, evidencePath), JSON.stringify({ task_id: taskId }) + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, selectorPath), JSON.stringify({ files: [logPath] }) + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, logPath), 'BUILD SUCCESSFUL\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', evidencePath, selectorPath, logPath],
            metrics: { changed_lines_total: 4 }
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
        const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

        assert.deepEqual(codeScopeFingerprint.review_reuse_neutral_evidence_files, [logPath, evidencePath, selectorPath]);
        assert.deepEqual(reviewScopeFingerprint.review_reuse_neutral_evidence_files, []);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(evidencePath), false);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(selectorPath), false);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(logPath), false);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(evidencePath), true);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(selectorPath), true);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(logPath), true);
        assert.equal(codeScopeFingerprint.code_scope_sha256, priorCodeScope.code_scope_sha256);
        assert.notEqual(reviewScopeFingerprint.review_scope_sha256, priorReviewScope.review_scope_sha256);

        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(codeBuild.outputLines.some((line) => line.startsWith('ReviewReuseReason: accepted:')));

        const otherTaskSelectorPath = 'garda-agent-orchestrator/runtime/manual-validation/T-OTHER/review-evidence.json';
        const otherTaskPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', otherTaskSelectorPath],
            metrics: { changed_lines_total: 4 }
        }, `${taskId}-other-task-preflight.json`);
        const otherTaskPreflight = JSON.parse(fs.readFileSync(otherTaskPreflightPath, 'utf8')) as Record<string, unknown>;
        const otherTaskCodeScope = computeReviewReuseCodeScopeFingerprint('code', otherTaskPreflight, repoRoot);

        assert.deepEqual(otherTaskCodeScope.review_reuse_neutral_evidence_files, []);
        assert.equal(otherTaskCodeScope.non_test_changed_files.includes(otherTaskSelectorPath), true);
        assert.notEqual(otherTaskCodeScope.code_scope_sha256, priorCodeScope.code_scope_sha256);

        const symlinkPath = selectorPath;
        const symlinkBlob = childProcess.spawnSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: repoRoot,
            input: 'src/app.ts',
            encoding: 'utf8',
            windowsHide: true
        });
        assert.equal(symlinkBlob.status, 0, symlinkBlob.stderr);
        runGit(repoRoot, [
            'update-index',
            '--add',
            '--cacheinfo',
            `120000,${String(symlinkBlob.stdout || '').trim()},${symlinkPath}`
        ]);
        const symlinkPreflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_staged_only',
            changed_files: ['src/app.ts', symlinkPath],
            metrics: { changed_lines_total: 4 }
        }, `${taskId}-symlink-preflight.json`);
        const symlinkPreflight = JSON.parse(fs.readFileSync(symlinkPreflightPath, 'utf8')) as Record<string, unknown>;
        const symlinkCodeScope = computeReviewReuseCodeScopeFingerprint('code', symlinkPreflight, repoRoot);

        assert.deepEqual(symlinkCodeScope.review_reuse_neutral_evidence_files, []);
        assert.equal(symlinkCodeScope.non_test_changed_files.includes(symlinkPath), true);
        assert.notEqual(symlinkCodeScope.code_scope_sha256, priorCodeScope.code_scope_sha256);

        const escapedTailPath = `garda-agent-orchestrator/runtime/manual-validation/${taskId}/nested/../escaped.log`;
        fs.writeFileSync(path.join(repoRoot, escapedTailPath), 'BUILD SUCCESSFUL\n', 'utf8');
        const escapedTailPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', escapedTailPath],
            metrics: { changed_lines_total: 4 }
        }, `${taskId}-escaped-tail-preflight.json`);
        const escapedTailPreflight = JSON.parse(
            fs.readFileSync(escapedTailPreflightPath, 'utf8')
        ) as Record<string, unknown>;
        const escapedTailCodeScope = computeReviewReuseCodeScopeFingerprint('code', escapedTailPreflight, repoRoot);

        assert.deepEqual(escapedTailCodeScope.review_reuse_neutral_evidence_files, []);
        assert.equal(escapedTailCodeScope.non_test_changed_files.includes(escapedTailPath), true);
        assert.notEqual(escapedTailCodeScope.code_scope_sha256, priorCodeScope.code_scope_sha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps review-cycle policy workflow config changes in review reuse fingerprints', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-workflow-policy-no-reuse';
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        const workflowConfigRelativePath = 'garda-agent-orchestrator/live/config/workflow-config.json';
        initializeGitRepo(repoRoot);

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 }
        }, `${taskId}-prior-preflight.json`);
        const priorPreflight = JSON.parse(fs.readFileSync(priorPreflightPath, 'utf8')) as Record<string, unknown>;
        const priorCodeScopeSha256 = computeReviewReuseCodeScopeFingerprint(
            'code',
            priorPreflight,
            repoRoot
        ).code_scope_sha256;
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, any>;
        workflowConfig.review_cycle_guard.excluded_review_types = ['security'];
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', workflowConfigRelativePath],
            metrics: { changed_lines_total: 5 },
            triggers: { changed_workflow_config_files: [workflowConfigRelativePath] }
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
        const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

        assert.deepEqual(codeScopeFingerprint.review_reuse_neutral_config_files, []);
        assert.deepEqual(reviewScopeFingerprint.review_reuse_neutral_config_files, []);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(workflowConfigRelativePath), true);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(workflowConfigRelativePath), true);
        assert.notEqual(codeScopeFingerprint.code_scope_sha256, priorCodeScopeSha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence when non-runtime performance support is delegated to performance review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-code-reuse-performance-support';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review when only benchmark support changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "alpha";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 4 },
            triggers: { performance: true },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(codeBuild.outputLines.some((line) => line.includes('non-runtime performance support file(s) delegated')));

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
