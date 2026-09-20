import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runBuildReviewContextCommand } from '../../../../../../src/cli/commands/gate-build-handlers';
import { runFullSuiteValidationCommand } from '../../../../../../src/cli/commands/gates';
import { resolveCanonicalReviewReceiptPath } from '../../../../../../src/cli/commands/gate-review-handlers/context/review-context-runtime-validation';
import {
    bindAuthoritativeRemediationDecisionToPreflight
} from '../../../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import {
    emitCurrentPassReviewContextReuseAccepted
} from '../../../../../../src/cli/commands/gate-flows/review-context/review-context-telemetry';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import {
    resolveAuthoritativeReviewRemediationDecision
} from '../../../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { fileSha256, normalizePath } from '../../../../../../src/gates/shared/helpers';
import {
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    prepareCurrentReviewPhase,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeBalancedProfilesConfig,
    writeCompilePassEvidence,
    writePreflight,
    writeReviewCapabilitiesConfig
} from '../../gate-test-helpers';
import { seedRemediationRepoBase } from '../review-cycle/gates-review-cycle-fixtures';

describe('gate build-review-context CLI flow binding', () => {
    for (const mutatedArtifact of [
        'preflight',
        'review-context',
        'receipt',
        'review-artifact',
        'findings-validation',
        'findings-disposition'
    ] as const) {
        it(`rejects ${mutatedArtifact} mutation between current-PASS validation and telemetry emission`, async () => {
            const repoRoot = createTempRepo();
            const taskId = `T-current-pass-telemetry-${mutatedArtifact}`;
            try {
                const reviewsRoot = getReviewsRoot(repoRoot);
                const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
                const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
                const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
                const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
                const findingsValidationArtifactPath = path.join(
                    reviewsRoot,
                    `${taskId}-code-findings-validation.json`
                );
                const findingsDispositionArtifactPath = path.join(
                    reviewsRoot,
                    `${taskId}-code-findings-disposition.json`
                );
                const artifactPaths = {
                    preflight: preflightPath,
                    'review-context': reviewContextPath,
                    receipt: receiptPath,
                    'review-artifact': reviewArtifactPath,
                    'findings-validation': findingsValidationArtifactPath,
                    'findings-disposition': findingsDispositionArtifactPath
                };
                fs.mkdirSync(reviewsRoot, { recursive: true });
                fs.writeFileSync(preflightPath, '{"preflight":true}\n', 'utf8');
                fs.writeFileSync(reviewContextPath, '{"schema_version":2,"context":true}\n', 'utf8');
                fs.writeFileSync(receiptPath, '{"review_output_format":"findings_json"}\n', 'utf8');
                fs.writeFileSync(reviewArtifactPath, 'REVIEW PASSED\n', 'utf8');
                fs.writeFileSync(findingsValidationArtifactPath, '{"accepted":true}\n', 'utf8');
                fs.writeFileSync(findingsDispositionArtifactPath, '{"blocking":0}\n', 'utf8');
                const currentPassReviewEvidence = {
                    reusedExistingReview: false,
                    preflightSha256: fileSha256(preflightPath),
                    reviewContextSha256: fileSha256(reviewContextPath),
                    receiptPath,
                    receiptSha256: fileSha256(receiptPath),
                    reviewArtifactPath,
                    reviewArtifactSha256: fileSha256(reviewArtifactPath),
                    findingsValidationArtifactPath,
                    findingsValidationArtifactSha256: fileSha256(findingsValidationArtifactPath),
                    findingsDispositionArtifactPath,
                    findingsDispositionArtifactSha256: fileSha256(findingsDispositionArtifactPath),
                    findingsValidationRequired: true,
                    reviewerExecutionMode: 'delegated_subagent',
                    reviewerIdentity: 'agent:reviewer',
                    reviewRecordedSequence: 1,
                    reviewRecordedEventSha256: 'a'.repeat(64),
                    remediationMode: 'DELTA',
                    remediationAuthoritativeDecisionSha256: 'b'.repeat(64),
                    remediationClassificationSha256: 'c'.repeat(64),
                    remediationAuthorityEligible: true
                };
                fs.writeFileSync(artifactPaths[mutatedArtifact], `{"mutated":"${mutatedArtifact}"}\n`, 'utf8');

                await assert.rejects(
                    emitCurrentPassReviewContextReuseAccepted({
                        repoRoot,
                        taskId,
                        reviewType: 'code',
                        depth: 2,
                        preflightPath,
                        reviewContextPath,
                        ruleContextArtifactPath: null,
                        currentPassReviewEvidence
                    }),
                    /unchanged authenticated evidence hashes/i
                );
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    }

    it('rejects partial findings evidence for verdict-token current PASS telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-current-pass-telemetry-partial-findings';
        try {
            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
            const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
            const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
            const findingsValidationArtifactPath = path.join(
                reviewsRoot,
                `${taskId}-code-findings-validation.json`
            );
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.writeFileSync(preflightPath, '{"preflight":true}\n', 'utf8');
            fs.writeFileSync(reviewContextPath, '{"schema_version":2,"context":true}\n', 'utf8');
            fs.writeFileSync(receiptPath, '{"review_output_format":"verdict_token"}\n', 'utf8');
            fs.writeFileSync(reviewArtifactPath, 'REVIEW PASSED\n', 'utf8');
            fs.writeFileSync(findingsValidationArtifactPath, '{"accepted":true}\n', 'utf8');

            await assert.rejects(
                emitCurrentPassReviewContextReuseAccepted({
                    repoRoot,
                    taskId,
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    reviewContextPath,
                    ruleContextArtifactPath: null,
                    currentPassReviewEvidence: {
                        reusedExistingReview: false,
                        preflightSha256: fileSha256(preflightPath),
                        reviewContextSha256: fileSha256(reviewContextPath),
                        receiptPath,
                        receiptSha256: fileSha256(receiptPath),
                        reviewArtifactPath,
                        reviewArtifactSha256: fileSha256(reviewArtifactPath),
                        findingsValidationArtifactPath,
                        findingsValidationArtifactSha256: fileSha256(findingsValidationArtifactPath),
                        findingsDispositionArtifactPath: null,
                        findingsDispositionArtifactSha256: null,
                        findingsValidationRequired: false,
                        reviewerExecutionMode: 'delegated_subagent',
                        reviewerIdentity: 'agent:reviewer',
                        reviewRecordedSequence: 1,
                        reviewRecordedEventSha256: 'a'.repeat(64),
                        remediationMode: 'DELTA',
                        remediationAuthoritativeDecisionSha256: 'b'.repeat(64),
                        remediationClassificationSha256: 'c'.repeat(64),
                        remediationAuthorityEligible: true
                    }
                }),
                /findings evidence does not match the bound review output format/i
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    for (const scenario of ['preserved', 'invalidated', 'reuse-rejected', 'tampered-receipt', 'stale-tree', 'forged-decision'] as const) {
        it(`validates current PASS evidence before applying a remediation fallback contract: ${scenario}`, async () => {
            const repoRoot = createTempRepo();
            const taskId = `T-current-pass-remediation-${scenario}`;
            try {
                seedTaskQueue(repoRoot, taskId);
                seedInitAnswers(repoRoot, 'Qwen');
                runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Preserve authenticated current PASS evidence' });
                const preflightPath = writePreflight(repoRoot, taskId, {
                    changed_files: ['src/app.ts'],
                    required_reviews: { code: true, test: true },
                    review_execution_policy: { mode: 'test_after_code' }
                });
                writeCompilePassEvidence(repoRoot, taskId, preflightPath);
                const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
                seedReusableReviewEvidence(
                    repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer'
                );
                const receiptPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-receipt.json`);
                const contextBefore = fs.readFileSync(reviewContextPath, 'utf8');
                const receiptBefore = fs.readFileSync(receiptPath, 'utf8');
                const preflightSha256 = fileSha256(preflightPath)!;
                const classification = {
                    source: 'runtime_fix' as const,
                    classification: {
                        category: 'review_evidence_only',
                        reason: 'Replace downstream reviewer evidence without changing source or compile evidence.',
                        blocked_before_reuse: false,
                        invalidated_review_types: scenario === 'invalidated' ? ['code', 'test'] : ['test']
                    }
                };
                const decision = bindAuthoritativeRemediationDecisionToPreflight(
                    resolveAuthoritativeReviewRemediationDecision({
                        taskId,
                        currentReviewType: scenario === 'invalidated' ? 'code' : 'test',
                        classification,
                        requiredReviews: { code: true, test: true },
                        reviewExecutionPolicyMode: 'test_after_code',
                        reusableReceipts: scenario === 'reuse-rejected' ? [{
                            review_type: 'code', reuse_status: 'REJECTED', findings_satisfied: false
                        }] : []
                    }),
                    preflightSha256
                );
                if (scenario === 'forged-decision') {
                    decision.decision_sha256 = '0'.repeat(64);
                }
                appendTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS',
                    'Restart downstream review evidence.', {
                        task_id: taskId,
                        event_type: 'REVIEW_CYCLE_RESTARTED',
                        status: 'PASSED',
                        preflight_sha256: preflightSha256,
                        authoritative_review_decision: decision,
                        authoritative_review_classification: classification
                    });
                if (scenario === 'tampered-receipt') {
                    const receipt = JSON.parse(receiptBefore) as Record<string, unknown>;
                    receipt.review_context_sha256 = '0'.repeat(64);
                    fs.writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');
                }
                if (scenario === 'stale-tree') {
                    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = true;\n', 'utf8');
                }
                const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
                const timelineBefore = fs.readFileSync(timelinePath, 'utf8');
                const build = () => runBuildReviewContextCommand({
                    repoRoot, reviewType: 'code', depth: '2', preflightPath, outputPath: reviewContextPath
                });
                if (scenario === 'forged-decision') {
                    await assert.rejects(build, /persisted authoritative remediation decision.*failed validation/i);
                    assert.equal(fs.readFileSync(reviewContextPath, 'utf8'), contextBefore);
                    return;
                }
                const result = await build();
                if (scenario === 'preserved') {
                    assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: True'), result.outputLines.join('\n'));
                    assert.equal(result.acceptedReviewEvidenceKind, 'FRESH');
                    assert.equal(fs.readFileSync(reviewContextPath, 'utf8'), contextBefore);
                    assert.equal(fs.readFileSync(receiptPath, 'utf8'), receiptBefore);
                    const appendedEvents = fs.readFileSync(timelinePath, 'utf8').slice(timelineBefore.length)
                        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
                    assert.deepEqual(appendedEvents.map((event) => event.event_type), ['REVIEW_CONTEXT_REUSE_ACCEPTED']);
                    const acceptedDetails = appendedEvents[0].details as Record<string, unknown>;
                    assert.equal(acceptedDetails.preflight_sha256, fileSha256(preflightPath));
                    assert.equal(acceptedDetails.review_context_sha256, fileSha256(reviewContextPath));
                    assert.equal(acceptedDetails.receipt_sha256, fileSha256(receiptPath));
                    assert.equal(
                        acceptedDetails.review_artifact_sha256,
                        fileSha256(path.join(getReviewsRoot(repoRoot), `${taskId}-code.md`))
                    );
                    assert.equal(acceptedDetails.review_reuse_evidence, 'FRESH');
                    assert.equal(acceptedDetails.reused_existing_review, false);
                    assert.equal(acceptedDetails.findings_validation_required, true);
                    assert.equal(acceptedDetails.remediation_authority_eligible, false);
                    assert.equal(typeof acceptedDetails.review_recorded_sequence, 'number');
                    assert.match(String(acceptedDetails.review_recorded_event_sha256), /^[0-9a-f]{64}$/u);
                } else {
                    assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'), result.outputLines.join('\n'));
                    assert.equal(result.reusedReviewEvidence, false);
                    const context = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
                    assert.equal((context.review_execution as Record<string, unknown>).mode, 'FULL');
                    assert.notEqual(fs.readFileSync(reviewContextPath, 'utf8'), contextBefore);
                }
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    }

    it('preserves custom review-context output path wiring', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-review-context-cli-binding-custom-output';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');

        const outputPath = path.join(getReviewsRoot(repoRoot), 'custom', `${taskId}-context.json`);
        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath
        });

        assert.equal(result.outputPath, normalizePath(outputPath));
        assert.equal(fs.existsSync(outputPath), true);
        assert.equal(result.outputLines.includes(`ReviewContextPath: ${normalizePath(outputPath)}`), true);
        assert.equal(result.outputLines.includes(`OutputPath: ${normalizePath(outputPath)}`), true);
        assert.equal(
            normalizePath(resolveCanonicalReviewReceiptPath(preflightPath, taskId, 'code')),
            normalizePath(path.join(getReviewsRoot(repoRoot), `${taskId}-code-receipt.json`))
        );
        assert.notEqual(
            path.dirname(resolveCanonicalReviewReceiptPath(preflightPath, taskId, 'code')),
            path.dirname(outputPath)
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails closed for missing preflight path before lifecycle work', async () => {
        const repoRoot = createTempRepo();
        await assert.rejects(
            () => runBuildReviewContextCommand({
                repoRoot,
                reviewType: 'code',
                depth: '2',
                preflightPath: 'garda-agent-orchestrator/runtime/reviews/missing-preflight.json'
            }),
            /Path not found/
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails closed for invalid depth at the CLI binding boundary', async () => {
        const repoRoot = createTempRepo();
        const preflightPath = writePreflight(repoRoot, 'T-review-context-cli-binding-invalid-depth');
        await assert.rejects(
            () => runBuildReviewContextCommand({
                repoRoot,
                reviewType: 'code',
                depth: '4',
                preflightPath
            }),
            /Depth must be an integer between 1 and 3/
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts an extensible review type while preserving canonical path resolution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-review-context-cli-binding-extensible-review';
        const reviewType = 'architecture-boundary';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeBalancedProfilesConfig(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const configRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
        const profilesPath = path.join(configRoot, 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: { balanced: { review_policy: Record<string, unknown> } };
        };
        profiles.built_in_profiles.balanced.review_policy[reviewType] = true;
        fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
        const capabilitiesPath = path.join(configRoot, 'review-capabilities.json');
        const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8')) as Record<string, boolean>;
        capabilities[reviewType] = true;
        fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(configRoot, 'review-catalog.json'), `${JSON.stringify({
            version: 1,
            custom_review_types: [{
                id: reviewType,
                display_label: 'Architecture boundary review',
                enabled_by_default: false,
                skill_id: 'code-review',
                trigger: { mode: 'manual', signal_ids: [] },
                coverage_category_ids: ['maintainability'],
                reviewer_role: {
                    role_id: 'architecture-reviewer',
                    focus_tags: ['maintainability']
                }
            }]
        }, null, 2)}\n`, 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 7;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');

        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType,
            depth: '2',
            preflightPath
        });
        const expectedPath = normalizePath(
            path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`)
        );
        assert.equal(result.outputPath, expectedPath);
        assert.equal(fs.existsSync(result.outputPath), true);
        assert.ok(result.outputLines.includes(`ReviewContextPath: ${expectedPath}`));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rematerializes persisted remediation REUSE after full-suite evidence refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-review-context-remediation-reuse-full-suite-refresh';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        fs.mkdirSync(path.dirname(workflowConfigPath), { recursive: true });
        const workflowConfig = fs.existsSync(workflowConfigPath)
            ? JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>
            : {};
        workflowConfig.compile_gate = { command: 'node -e "process.exit(0)"' };
        workflowConfig.full_suite_validation = {
            enabled: true,
            command: 'node -e "process.exit(0)"',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        };
        workflowConfig.review_execution_policy = { mode: 'test_after_code' };
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Rematerialize persisted remediation reuse after full-suite refresh',
            plannedChangedFiles: ['src/app.ts']
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId, 'Codex');
        runShellSmokeForTask(repoRoot, taskId, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            },
            review_execution_policy: { mode: 'test_after_code' }
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const initialFullSuite = await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath });
        assert.equal(initialFullSuite.exitCode, 0, initialFullSuite.outputText);
        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );

        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const currentCycleFullSuite = await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath });
        assert.equal(currentCycleFullSuite.exitCode, 0, currentCycleFullSuite.outputText);
        const preflightSha256 = fileSha256(preflightPath);
        assert.ok(preflightSha256);
        const authoritativeClassification = {
            source: 'runtime_fix' as const,
            classification: {
                category: 'test_coverage_only',
                reason: 'Test-only remediation preserves upstream code review evidence.',
                blocked_before_reuse: false,
                invalidated_review_types: ['test']
            }
        };
        const preliminaryDecision = bindAuthoritativeRemediationDecisionToPreflight(
            resolveAuthoritativeReviewRemediationDecision({
                taskId,
                currentReviewType: 'test',
                classification: authoritativeClassification,
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'test_after_code'
            }),
            preflightSha256
        );
        appendTaskEvent(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            taskId,
            'REVIEW_CYCLE_RESTARTED',
            'PASS',
            'Persisted preliminary remediation decision.',
            {
                task_id: taskId,
                event_type: 'REVIEW_CYCLE_RESTARTED',
                status: 'PASSED',
                preflight_sha256: preflightSha256,
                authoritative_review_decision: preliminaryDecision,
                authoritative_review_classification: authoritativeClassification
            }
        );
        const currentCycleReuse = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '3',
            preflightPath
        });
        assert.equal(
            currentCycleReuse.reusedReviewEvidence,
            true,
            currentCycleReuse.outputLines.join('\n')
        );

        const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
            resolveAuthoritativeReviewRemediationDecision({
                taskId,
                currentReviewType: 'test',
                classification: authoritativeClassification,
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'test_after_code',
                reusableReceipts: [{
                    review_type: 'code',
                    reuse_status: 'ACCEPTED',
                    findings_satisfied: true,
                    evidence_kind: 'REUSED'
                }]
            }),
            preflightSha256
        );
        appendTaskEvent(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            taskId,
            'REVIEW_CYCLE_RESTARTED',
            'PASS',
            'Persisted remediation reuse decision.',
            {
                task_id: taskId,
                event_type: 'REVIEW_CYCLE_RESTARTED',
                status: 'PASSED',
                preflight_sha256: preflightSha256,
                authoritative_review_decision: authoritativeDecision,
                authoritative_review_classification: authoritativeClassification
            }
        );

        const refreshedFullSuite = await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath });
        assert.equal(refreshedFullSuite.exitCode, 0, refreshedFullSuite.outputText);
        const rematerializedReuse = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '3',
            preflightPath
        });
        assert.equal(rematerializedReuse.reusedReviewEvidence, true);
        const rematerializedContext = JSON.parse(fs.readFileSync(codeReviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.equal(
            (rematerializedContext.review_execution as Record<string, unknown>).source,
            'initial_full'
        );
        assert.equal(
            (rematerializedContext.full_suite_validation as Record<string, unknown>).cycle_binding_valid,
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
