import {
    createHash
} from 'node:crypto';
import {
    describe,
    it,
    assert,
    fs,
    path,
    runBuildReviewContextCommand,
    appendTaskEvent,
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    runEnterTaskMode,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    getReviewTreeStateSha256FromFixtureContext} from './gates-review-reuse-fixtures';
import {
    tryAcceptCurrentPassReviewEvidence
} from '../../../../../../src/cli/commands/gate-flows/review-context/review-context-flow-current-pass-reuse';
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
    materializeReviewFindingsFollowUpTasks
} from '../../../../../../src/gates/review/review-findings-follow-up-tasks';
import {
    validateReviewFindingsContract
} from '../../../../../../src/gates/review/review-findings-artifact-verdict';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../../../src/gates/review/review-evidence-contract';
import { REVIEW_FINDINGS_SCHEMA_VERSION } from '../../../../../../src/gates/review/review-findings-schema';
import type { ReviewRemediationReviewContract } from '../../../../../../src/gates/review-remediation/review-remediation-review-contract';

function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256File(filePath: string): string {
    return sha256Text(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildMissingFocusedValidationReport(options: {
    taskId: string;
    reviewType: string;
    reviewContextSha256: string;
    treeStateSha256: string;
    coverageContract: Record<string, unknown>;
    reviewExecution: ReviewRemediationReviewContract;
    includeNonBlockingFinding?: boolean;
}): Record<string, unknown> {
    const obligations = Array.isArray(options.coverageContract.obligations)
        ? options.coverageContract.obligations as Array<Record<string, unknown>>
        : [];
    const obligationIds = obligations
        .map((obligation) => String(obligation.id || '').trim())
        .filter(Boolean);
    const marker = '[garda:evidence-only:missing-focused-validation] test=tests/app.test.ts; action=run-and-record-focused-test';
    const findingIds = options.includeNonBlockingFinding ? ['F-000', 'F-001'] : ['F-000'];
    return {
        schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
        task_id: options.taskId,
        review_type: options.reviewType,
        review_context_sha256: options.reviewContextSha256,
        tree_state_sha256: options.treeStateSha256,
        review_execution: {
            mode: options.reviewExecution.mode,
            contract_sha256: options.reviewExecution.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        },
        validation_notes: [
            {
                id: 'N-001',
                topic: 'missing-focused-validation',
                note: 'Reviewed the current changed file and found the canonical missing focused-validation marker.',
                evidence: [
                    {
                        location: 'src/app.ts:1',
                        observation: 'Scoped changed file evidence for the missing focused-validation marker.'
                    }
                ]
            },
            {
                id: 'N-002',
                topic: 'focused-self-validation',
                note: 'The reviewer attempted the smallest relevant focused test before reporting missing validation evidence.',
                command: 'node --test tests/app.test.ts',
                command_outcome: 'unavailable',
                diagnostics: 'The focused test target is unavailable in this isolated fixture, so the command could not execute.',
                evidence: [
                    {
                        location: 'src/app.ts:1',
                        observation: 'The changed application path is the behavior targeted by tests/app.test.ts, which motivated the unavailable focused test.'
                    }
                ]
            }
        ],
        coverage_ledger: {
            coverage_contract_sha256: options.coverageContract.contract_sha256,
            entries: obligationIds.map((obligationId) => ({
                obligation_id: obligationId,
                evidence: [
                    {
                        location: 'src/app.ts:1',
                        observation: `Obligation ${obligationId} is blocked by missing focused-validation evidence.`
                    }
                ],
                finding_ids: findingIds
            }))
        },
        findings: {
            critical: [],
            high: [],
            medium: [
                {
                    id: 'F-000',
                    title: marker,
                    description: 'Focused validation evidence is missing for the current review scope.',
                    evidence: [
                        {
                            location: 'src/app.ts:1',
                            observation: 'No focused-validation evidence was available for this scoped change.'
                        }
                    ],
                    coverage_obligation_ids: obligationIds
                }
            ],
            low: options.includeNonBlockingFinding
                ? [
                    {
                        id: 'F-001',
                        title: 'Low follow-up finding',
                        description: 'A non-blocking low finding is present alongside missing focused-validation evidence.',
                        evidence: [
                            {
                                location: 'src/app.ts:1',
                                observation: 'The additional finding should not mask the missing focused-validation sentinel.'
                            }
                        ],
                        coverage_obligation_ids: obligationIds
                    }
                ]
                : []
        },
        residual_risks: [],
        reviewer_notes: ['Canonical evidence-only missing focused-validation marker.']
    };
}

function replaceCurrentReviewWithMissingFocusedValidation(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    reviewContextPath: string;
    includeNonBlockingFinding?: boolean;
}): void {
    const reviewsRoot = getReviewsRoot(options.repoRoot);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const reviewContextText = fs.readFileSync(options.reviewContextPath, 'utf8');
    const reviewContext = JSON.parse(reviewContextText) as Record<string, unknown>;
    const reviewContextSha256 = sha256Text(reviewContextText);
    const coverageContract = reviewContext.coverage_contract as Record<string, unknown>;
    const reviewExecution = reviewContext.review_execution as ReviewRemediationReviewContract;
    const reviewExecutionBindings = resolveReviewContextExecutionEvidenceBindings(reviewContext).bindings!;
    const treeStateSha256 = getReviewTreeStateSha256FromFixtureContext(reviewContext);
    assert.ok(treeStateSha256);
    const report = buildMissingFocusedValidationReport({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewContextSha256,
        treeStateSha256,
        coverageContract,
        reviewExecution,
        includeNonBlockingFinding: options.includeNonBlockingFinding
    });
    writeJson(artifactPath, report);
    const artifactSha256 = sha256File(artifactPath);
    const validation = validateReviewFindingsContract({
        content: fs.readFileSync(artifactPath, 'utf8'),
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: reviewContextSha256,
        expectedTreeStateSha256: treeStateSha256,
        coverageContract: coverageContract as never,
        repoRoot: options.repoRoot,
        expectedReviewExecutionContract: reviewExecution
    });
    assert.equal(validation.valid, true, validation.violations.join('\n'));

    const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validation,
        reviewOutputSha256: artifactSha256,
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: artifactSha256,
        reviewContextPath: options.reviewContextPath,
        reviewContextSha256,
        preflightPath: options.preflightPath,
        preflightSha256: String(receipt.preflight_sha256 || '').trim() || null,
        scopeSha256: String(receipt.scope_sha256 || '').trim() || null,
        reviewScopeSha256: String(receipt.review_scope_sha256 || '').trim() || null,
        codeScopeSha256: String(receipt.code_scope_sha256 || '').trim() || null,
        reviewTreeStateSha256: treeStateSha256,
        coverageContract: coverageContract as never
    });
    writeJson(validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = sha256File(validationArtifactPath);
    const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
        validationArtifactPath,
        validationArtifactSha256
    );
    writeJson(validationArtifactSnapshotPath, validationArtifact);

    const preflight = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8')) as Record<string, unknown>;
    const dispositionArtifactPath = getReviewFindingsDispositionArtifactPath(artifactPath);
    const dispositionArtifact = buildReviewFindingsDispositionArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validationArtifact,
        validationArtifactPath,
        validationArtifactSha256,
        policyResolution: resolveLockedReviewFindingPolicyFromPreflight(preflight)
    });
    writeJson(dispositionArtifactPath, dispositionArtifact);
    const dispositionArtifactSha256 = sha256File(dispositionArtifactPath);
    const dispositionArtifactSnapshotPath = getReviewFindingsDispositionArtifactSnapshotPath(
        dispositionArtifactPath,
        dispositionArtifactSha256
    );
    writeJson(dispositionArtifactSnapshotPath, dispositionArtifact);

    receipt.review_artifact_sha256 = artifactSha256;
    receipt.review_output_sha256 = artifactSha256;
    receipt.review_coverage = validation.coverage_validation;
    receipt.review_output_format = 'findings_json';
    receipt.review_output_schema_version = validation.report?.schema_version ?? null;
    const reportSha256 = validation.report
        ? sha256Text(`${JSON.stringify(validation.report, null, 2)}\n`)
        : null;
    receipt.review_findings_report_sha256 = reportSha256;
    receipt.review_findings_report = validation.report;
    receipt.review_findings_validation = {
        artifact_path: path.normalize(validationArtifactPath).replace(/\\/g, '/'),
        artifact_sha256: validationArtifactSha256,
        snapshot_path: path.normalize(validationArtifactSnapshotPath).replace(/\\/g, '/'),
        snapshot_sha256: validationArtifactSha256,
        status: validationArtifact.validation_result.status,
        accepted: validationArtifact.validation_result.accepted,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        violation_count: validationArtifact.validation_result.violations.length
    };
    receipt.review_findings_disposition = dispositionArtifact.disposition_result;
    receipt.review_findings_disposition_artifact = {
        artifact_path: path.normalize(dispositionArtifactPath).replace(/\\/g, '/'),
        artifact_sha256: dispositionArtifactSha256,
        snapshot_path: path.normalize(dispositionArtifactSnapshotPath).replace(/\\/g, '/'),
        snapshot_sha256: dispositionArtifactSha256,
        disposition_result_sha256: dispositionArtifact.disposition_result_sha256,
        policy_id: dispositionArtifact.policy.policy_id,
        policy_source: dispositionArtifact.policy.policy_source,
        item_count: dispositionArtifact.summary.item_count,
        fix_now_count: dispositionArtifact.summary.fix_now_count,
        follow_up_pending_count: dispositionArtifact.summary.follow_up_pending_count,
        ignored_count: dispositionArtifact.summary.ignored_count,
        blocking_count: dispositionArtifact.summary.blocking_count
    };
    receipt.review_output_contract = {
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
        review_tree_state_sha256: treeStateSha256,
        coverage_contract_sha256: coverageContract.contract_sha256,
        ...reviewExecutionBindings,
        reviewer_identity: receipt.reviewer_identity,
        reviewer_provenance_event_sha256: (receipt.reviewer_provenance as Record<string, unknown> | undefined)?.event_sha256 ?? null
    };
    receipt.review_result_recorded_at_utc = new Date().toISOString();
    receipt.review_output_source_mtime_utc = fs.statSync(artifactPath).mtime.toISOString();
    writeJson(receiptPath, receipt);
    if (options.includeNonBlockingFinding) {
        const followUpMaterialization = materializeReviewFindingsFollowUpTasks({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            dispositionArtifactPath,
            receiptPath
        });
        assert.equal(
            followUpMaterialization.status,
            'MATERIALIZED',
            followUpMaterialization.violations.join('\n')
        );
    }
    const receiptSha256 = sha256File(receiptPath);
    const receiptSnapshotPath = artifactPath.replace(/\.md$/u, `-receipt-${receiptSha256}.json`);
    const artifactSnapshotPath = artifactPath.replace(/\.md$/u, `-artifact-${artifactSha256}.md`);
    fs.copyFileSync(receiptPath, receiptSnapshotPath);
    fs.copyFileSync(artifactPath, artifactSnapshotPath);
    appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'REVIEW_RECORDED', 'PASS', 'recorded missing focused validation review', {
        ...receipt,
        receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
        receipt_sha256: receiptSha256,
        receipt_snapshot_path: path.normalize(receiptSnapshotPath).replace(/\\/g, '/'),
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
        review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
        review_artifact_snapshot_sha256: artifactSha256,
        review_context_path: path.normalize(options.reviewContextPath).replace(/\\/g, '/'),
        review_context_sha256: reviewContextSha256
    });
}

describe('cli/commands/gates - current-cycle review reuse rejections', () => {
    it('fails closed when current-cycle review-recorded telemetry lacks timeline integrity', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-recorded';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when REVIEW_RECORDED telemetry is untrusted'
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
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const timelineLines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0);
        const tamperedLines = timelineLines.map((line) => {
            const event = JSON.parse(line) as Record<string, unknown>;
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : {};
            if (
                event.event_type === 'REVIEW_RECORDED'
                && String(details.review_type || details.reviewType || '').trim().toLowerCase() === 'code'
            ) {
                delete event.integrity;
            }
            return JSON.stringify(event);
        });
        fs.writeFileSync(timelinePath, tamperedLines.join('\n') + '\n', 'utf8');

        await assert.rejects(
            () => runBuildReviewContextCommand({
                reviewType: 'code',
                depth: '2',
                preflightPath,
                outputPath: reviewContextPath,
                repoRoot
            }),
            /timeline contains legacy\/unverified event after integrity chain start/iu
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when the review context JSON is corrupt', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-corrupt-context';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when review context JSON is corrupt'
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
        fs.writeFileSync(reviewContextPath, '{not-json', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('existing review context is missing or corrupt')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when the receipt is no longer independently audited', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when receipt trust level is downgraded'
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
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.trust_level = 'LOCAL_ASSERTED';
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('review receipt bindings do not match')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when reviewer invocation provenance is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-missing-provenance';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reviewer invocation provenance is missing'
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
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reviewer_provenance = null;
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('reviewer invocation attestation')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle PASS review context when the handoff artifact is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-missing-handoff';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when the handoff artifact is missing'
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
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        const ruleContextArtifactPath = String(ruleContext.artifact_path || '');
        assert.ok(ruleContextArtifactPath);
        fs.rmSync(ruleContextArtifactPath, { force: true });

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('readable reviewer prompt artifact')));
        assert.equal(fs.existsSync(ruleContextArtifactPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle PASS review context when the reviewer-visible tree-state is stale', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-stale-tree-state';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reviewer-visible tree state changes'
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
        const originalContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const originalTreeStateSha256 = getReviewTreeStateSha256FromFixtureContext(originalContext);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changedAfterPass = true;\n', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('review context tree_state is stale')));
        const rebuiltContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.notEqual(getReviewTreeStateSha256FromFixtureContext(rebuiltContext), originalTreeStateSha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts current-cycle PASS reuse when findings contain only evidence-only missing-focused-validation', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-current-pass-missing-focused';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when missing focused validation remains unresolved'
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            profile_policy_snapshot: {
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'balanced',
                    findings: {
                        critical: 'fix_now',
                        high: 'fix_now',
                        medium: 'create_follow_up',
                        low: 'create_follow_up'
                    },
                    residual_risk: 'create_follow_up'
                }
            },
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
        replaceCurrentReviewWithMissingFocusedValidation({
            repoRoot,
            taskId,
            reviewType: 'code',
            preflightPath,
            reviewContextPath
        });

        const result = tryAcceptCurrentPassReviewEvidence({
            repoRoot,
            taskId,
            reviewType: 'code',
            preflightPath,
            preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            reviewContextPath
        });

        assert.equal(result.accepted, true, JSON.stringify(result, null, 2));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts current-cycle PASS reuse when evidence-only F-000 is mixed with non-blocking findings', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-current-pass-mixed-missing-focused';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when missing focused validation is mixed with follow-up findings'
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            profile_policy_snapshot: {
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'balanced',
                    findings: {
                        critical: 'fix_now',
                        high: 'fix_now',
                        medium: 'create_follow_up',
                        low: 'create_follow_up'
                    },
                    residual_risk: 'create_follow_up'
                }
            },
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
        replaceCurrentReviewWithMissingFocusedValidation({
            repoRoot,
            taskId,
            reviewType: 'code',
            preflightPath,
            reviewContextPath,
            includeNonBlockingFinding: true
        });

        const result = tryAcceptCurrentPassReviewEvidence({
            repoRoot,
            taskId,
            reviewType: 'code',
            preflightPath,
            preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            reviewContextPath
        });

        assert.equal(result.accepted, true, JSON.stringify(result, null, 2));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle reused PASS context when hidden timing trust distrusts the attested reviewer timing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-915-current-pass-hidden-timing-distrust';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current reused PASS evidence when hidden timing trust distrusts the attested reviewer timing'
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

        const firstBuild = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });
        assert.equal(firstBuild.reusedReviewEvidence, true, firstBuild.outputLines.join('\n'));

        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
        const timelineLines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0);
        let updatedInvocationEvent = false;
        const tamperedTimeline = timelineLines.map((line) => {
            const event = JSON.parse(line) as Record<string, unknown>;
            const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
                ? event.integrity as Record<string, unknown>
                : null;
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : null;
            if (
                event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                && integrity
                && details
                && Number(integrity.task_sequence) === Number(reviewerProvenance.task_sequence)
                && String(integrity.event_sha256 || '').trim().toLowerCase()
                    === String(reviewerProvenance.event_sha256 || '').trim().toLowerCase()
            ) {
                details.launch_prepared_at_utc = '2026-04-28T00:00:00.000Z';
                details.delegation_started_at_utc = '2026-04-28T00:00:01.000Z';
                details.launched_at_utc = '2026-04-28T00:00:01.000Z';
                details.launch_completed_at_utc = '2026-04-28T00:00:05.000Z';
                details.invocation_attested_at_utc = '2026-04-28T00:00:05.500Z';
                updatedInvocationEvent = true;
            }
            return JSON.stringify(event);
        });
        assert.equal(updatedInvocationEvent, true);
        fs.writeFileSync(timelinePath, `${tamperedTimeline.join('\n')}\n`, 'utf8');

        const secondCurrentPass = tryAcceptCurrentPassReviewEvidence({
            repoRoot,
            taskId,
            reviewType: 'code',
            preflightPath,
            preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            reviewContextPath
        });

        assert.equal(secondCurrentPass.accepted, false, JSON.stringify(secondCurrentPass, null, 2));
        const hiddenViolation = secondCurrentPass.reason;
        assert.match(hiddenViolation, /not sufficiently trustworthy/);
        assert.match(hiddenViolation, /Launch a real subagent using built-in tools/);
        assert.equal(
            /timing|threshold|elapsed|duration|seconds|too_short|impossible_ordering|missing_timing/i.test(hiddenViolation),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle reused PASS context when strict reuse telemetry is incomplete', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reused evidence telemetry is incomplete'
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
        await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        const crypto = require('node:crypto');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const forgedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        delete forgedReceipt.reused_from_receipt_sha256;
        delete forgedReceipt.reused_from_review_context_sha256;
        delete forgedReceipt.reused_from_review_context_reuse_sha256;
        delete forgedReceipt.reused_from_review_tree_state_sha256;
        delete forgedReceipt.reused_from_review_scope_sha256;
        delete forgedReceipt.reused_from_code_scope_sha256;
        const forgedReceiptText = `${JSON.stringify(forgedReceipt, null, 2)}\n`;
        const forgedReceiptSha256 = crypto.createHash('sha256').update(forgedReceiptText).digest('hex');
        const forgedReceiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${forgedReceiptSha256}.json`);
        fs.writeFileSync(receiptPath, forgedReceiptText, 'utf8');
        fs.writeFileSync(forgedReceiptSnapshotPath, forgedReceiptText, 'utf8');
        const artifactText = fs.readFileSync(artifactPath, 'utf8');
        const artifactSha256 = crypto.createHash('sha256').update(artifactText).digest('hex');
        const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactSha256}.md`);
        fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'forged current reuse recorded', {
            ...forgedReceipt,
            reused_existing_review: true,
            receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
            receipt_sha256: forgedReceiptSha256,
            receipt_snapshot_path: path.normalize(forgedReceiptSnapshotPath).replace(/\\/g, '/'),
            receipt_snapshot_sha256: forgedReceiptSha256,
            review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
            review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
            review_artifact_snapshot_sha256: artifactSha256,
            review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/'),
            review_context_sha256: forgedReceipt.review_context_sha256
        });

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('strict reused evidence telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
