import {
    describe,
    it as nodeIt,
    assert,
    fs,
    path,
    runCliMainWithHandling,
    gateReviewHandlers,
    createTempRepo,
    seedTaskQueue,
    seedInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    createReviewerRoutingFixture,
    writePreflight,
    prepareCurrentReviewPhase,
    readTaskTimelineEvents,
    runCliWithCapturedOutput,
    manualReviewContextTaskScopeFixture,
    manualReviewContextBindingFixture,
    reviewContextScopedDiffFixture,
    writeManualReviewerHandoffFixture,
    buildNoFindingsJsonReviewReport,
    buildReviewExecutionEvidenceFixture,
    recordReviewRoutingViaCli,
    attestReviewerInvocationForTest,
    seedPromptBoundReviewFixture
} from './gates-command-review-result-fixtures';
import { createPartitionedTestRegistrar } from '../../gate-test-partition';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { fileSha256 } from '../../../../../../src/gate-runtime/hash';
import { readReviewArtifactState } from '../../../../../../src/gates/next-step/next-step-review-artifact-readers';
import {
    buildReviewOutputCorrectionArtifact,
    persistReviewOutputCorrection,
    readReviewOutputCorrectionArtifact
} from '../../../../../../src/gates/review/review-output-correction';
import { resolveReviewExecutionRuntimeBindings } from '../../../../../../src/cli/commands/gate-review-handlers/context/review-context-runtime-validation';
import {
    formatReviewFollowUpTaskClosurePolicyMetadata,
    resolveReviewFollowUpTaskClosurePolicy
} from '../../../../../../src/core/review-follow-up-task-closure-policy';

const it = createPartitionedTestRegistrar(
    nodeIt,
    'GARDA_REVIEW_RESULT_NORMALIZATION_PART',
    6
);

function loadLifecycleEventEmittersModule(): {
    emitReviewOutputCorrectionAcceptedEventAsync: (...args: unknown[]) => Promise<unknown>;
} {
    return require(path.join(
        __dirname,
        '../../../../../../src/gate-runtime/timeline/lifecycle-event-emitters.js'
    )) as {
        emitReviewOutputCorrectionAcceptedEventAsync: (...args: unknown[]) => Promise<unknown>;
    };
}

function buildNoFindingCoverageLedger(reviewContextPath: string): string[] {
    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as {
        coverage_contract: {
            obligations: Array<{ id: string; kind: string; target: string }>;
        };
        task_scope: { changed_files: string[] };
    };
    const defaultFile = reviewContext.task_scope.changed_files[0];
    return reviewContext.coverage_contract.obligations.map((obligation) => `- ${JSON.stringify({
        id: obligation.id,
        evidence: [{
            location: `${obligation.kind === 'file' ? obligation.target : defaultFile}:1`,
            observation: `Verified concrete ${obligation.kind} behavior for ${obligation.target} against the assigned review contract.`
        }],
        result: 'no-finding',
        finding_ids: []
    })}`);
}

function buildNoFindingsJsonReport(reviewContextPath: string, taskId: string, reviewType = 'code'): Record<string, unknown> {
    return buildNoFindingsJsonReviewReport(reviewContextPath, taskId, reviewType);
}

function writeProfilesConfig(repoRoot: string, activeProfile: 'soft' | 'balanced' | 'strict' | 'custom-reviewer'): void {
    const profileEntry = (description: string, depth: number) => ({
        description,
        depth,
        review_policy: {
            code: true,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        token_economy: { enabled: depth < 3 },
        skills: {}
    });
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
        version: 1,
        active_profile: activeProfile,
        built_in_profiles: {
            soft: profileEntry('Soft fixture profile', 1),
            balanced: profileEntry('Balanced fixture profile', 2),
            strict: profileEntry('Strict fixture profile', 3)
        },
        user_profiles: {
            'custom-reviewer': profileEntry('Custom fixture profile', 3)
        }
    }, null, 2)}\n`, 'utf8');
}

function balancedProfilePolicySnapshot(): Record<string, unknown> {
    return {
        review_finding_policy: {
            schema_version: 1,
            policy_id: 'balanced',
            findings: {
                critical: 'fix_now',
                high: 'fix_now',
                medium: 'fix_now',
                low: 'create_follow_up'
            },
            residual_risk: 'create_follow_up'
        }
    };
}

function softProfilePolicySnapshot(): Record<string, unknown> {
    return {
        review_finding_policy: {
            schema_version: 1,
            policy_id: 'soft',
            findings: {
                critical: 'fix_now',
                high: 'create_follow_up',
                medium: 'ignore',
                low: 'ignore'
            },
            residual_risk: 'ignore'
        }
    };
}

function followUpClosureScenarioInput(
    taskId: string,
    skipLowFindings: boolean,
    forbidChildTasks: boolean
): {
    taskNotes: string;
    parentTask: { taskId: string; notes: string };
    profilePolicySnapshot: Record<string, unknown>;
} {
    const parentTaskId = taskId.replace(/-F[1-9][0-9]*$/u, '');
    const parentNotes = `Review follow-up tasks materialized: \`${taskId}\`; artifact `
        + `\`garda-agent-orchestrator/runtime/reviews/${parentTaskId}-review-findings-follow-up-tasks.json\`.`;
    const taskNotes = `Child of \`${parentTaskId}\`. review_follow_up_fingerprint=${'a'.repeat(64)}. `
        + formatReviewFollowUpTaskClosurePolicyMetadata({
            skip_low_findings: skipLowFindings,
            forbid_child_tasks: forbidChildTasks
        });
    return {
        taskNotes,
        parentTask: { taskId: parentTaskId, notes: parentNotes },
        profilePolicySnapshot: {
            ...balancedProfilePolicySnapshot(),
            review_follow_up_task_closure_policy: resolveReviewFollowUpTaskClosurePolicy(taskNotes, {
                taskId,
                taskRows: [
                    { taskId: parentTaskId, notes: parentNotes },
                    { taskId, notes: taskNotes }
                ]
            })
        }
    };
}

function addFindingToReport(
    report: Record<string, unknown>,
    reviewContextPath: string,
    severity: 'critical' | 'high' | 'medium' | 'low',
    id: string
): Record<string, unknown> {
    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as {
        coverage_contract: {
            obligations: Array<{ id: string; kind: string; target: string }>;
        };
        task_scope: { changed_files: string[] };
    };
    const defaultFile = reviewContext.task_scope.changed_files[0];
    const obligationId = reviewContext.coverage_contract.obligations[0].id;
    const findings = report.findings as Record<string, unknown[]>;
    findings[severity] = [{
        id,
        title: `${severity} policy disposition fixture finding`,
        description: `The reviewer reported a ${severity} finding so record-review-result must apply the locked profile disposition.`,
        evidence: [{
            location: `${defaultFile}:1`,
            observation: `Concrete ${severity} evidence bound to the changed file for policy disposition coverage.`
        }],
        coverage_obligation_ids: [obligationId]
    }];
    const coverageLedger = report.coverage_ledger as { entries: Array<{ obligation_id: string; finding_ids: string[] }> };
    coverageLedger.entries = coverageLedger.entries.map((entry, index) => ({
        ...entry,
        finding_ids: index === 0 ? [id] : entry.finding_ids
    }));
    return report;
}

function addResidualRiskToReport(
    report: Record<string, unknown>,
    reviewContextPath: string,
    id: string
): Record<string, unknown> {
    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as {
        task_scope: { changed_files: string[] };
    };
    const defaultFile = reviewContext.task_scope.changed_files[0];
    const residualRisks = report.residual_risks as unknown[];
    residualRisks.push({
        id,
        description: 'Evidence-bound residual risk used to verify locked profile disposition behavior.',
        evidence: [{
            location: `${defaultFile}:1`,
            observation: 'Concrete residual-risk evidence bound to the changed file for policy disposition coverage.'
        }]
    });
    return report;
}

function profileNeutralValidationSnapshot(validationArtifact: Record<string, unknown>): Record<string, unknown> {
    const validationResult = validationArtifact.validation_result as Record<string, unknown>;
    const profileNeutralResult = { ...validationResult };
    delete profileNeutralResult.bindings;
    return profileNeutralResult;
}

function rebindCompletedLaunchAttemptForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextPath: string;
    launchArtifactPath: string;
    reviewerLaunchAttemptId: string;
    reviewOutputPath?: string;
    recordCompletion?: boolean;
    provider?: string;
    attestationSource?: string;
}): void {
    const invocationEvent = [...readTaskTimelineEvents(options.repoRoot, options.taskId)]
        .reverse()
        .find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
    assert.ok(invocationEvent?.details);
    const launchArtifact = JSON.parse(fs.readFileSync(options.launchArtifactPath, 'utf8')) as Record<string, unknown>;
    const invocationDetails = invocationEvent.details as Record<string, unknown>;
    const reviewContextSha256 = createHash('sha256')
        .update(fs.readFileSync(options.reviewContextPath))
        .digest('hex');
    const normalizedLaunchArtifactPath = options.launchArtifactPath.replace(/\\/g, '/');
    const launchInputArtifactPath = path.join(path.dirname(options.launchArtifactPath), 'reviewer-launch-input.json');
    const normalizedLaunchInputArtifactPath = launchInputArtifactPath.replace(/\\/g, '/');
    const launchBindingSha256 = String(
        launchArtifact.launch_binding_sha256
        || invocationDetails.launch_binding_sha256
        || ''
    ).trim();
    const routingEventSha256 = String(
        launchArtifact.routing_event_sha256
        || invocationDetails.routing_event_sha256
        || ''
    ).trim();
    const copyPasteReviewerLaunchPrompt = String(
        launchArtifact.copy_paste_reviewer_launch_prompt
        || `Delegated ${options.reviewType} reviewer launch prompt for ${options.taskId}.`
    );
    const copyPasteReviewerLaunchPromptSha256 = createHash('sha256')
        .update(copyPasteReviewerLaunchPrompt, 'utf8')
        .digest('hex');
    const launchPreparedAtUtc = new Date().toISOString();
    const preparedEvent = appendTaskEvent(
        getOrchestratorRoot(options.repoRoot),
        options.taskId,
        'REVIEWER_LAUNCH_PREPARED',
        'INFO',
        'Reviewer launch attempt rebound by lifecycle regression fixture.',
        {
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routingEventSha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_attempt_id: options.reviewerLaunchAttemptId,
            reviewer_launch_artifact_path: normalizedLaunchArtifactPath,
            reviewer_launch_input_artifact_path: normalizedLaunchInputArtifactPath,
            reviewer_prompt_sha256: launchArtifact.reviewer_prompt_sha256,
            role_prompt_sha256: launchArtifact.role_prompt_sha256,
            prompt_template_sha256: launchArtifact.prompt_template_sha256,
            output_template_sha256: launchArtifact.output_template_sha256,
            evidence_manifest_sha256: launchArtifact.evidence_manifest_sha256,
            copy_paste_reviewer_launch_prompt_sha256: copyPasteReviewerLaunchPromptSha256,
            launch_prepared_at_utc: launchPreparedAtUtc
        },
        { passThru: true }
    );
    const preparedLaunchEventSha256 = String(preparedEvent?.integrity?.event_sha256 || '').trim();
    const preparedLaunchEventTaskSequence = Number(preparedEvent?.integrity?.task_sequence);
    assert.match(preparedLaunchEventSha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(preparedLaunchEventTaskSequence) && preparedLaunchEventTaskSequence > 0);
    fs.writeFileSync(launchInputArtifactPath, `${JSON.stringify({
        schema_version: 1,
        artifact_type: 'delegated_reviewer_handoff',
        handoff_role: 'delegated_reviewer',
        task_id: options.taskId,
        reviewer_launch_attempt_id: options.reviewerLaunchAttemptId,
        review_type: options.reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: options.reviewerIdentity,
        review_context_path: options.reviewContextPath.replace(/\\/g, '/'),
        review_context_sha256: reviewContextSha256,
        routing_event_sha256: routingEventSha256,
        launch_binding_sha256: launchBindingSha256,
        prepared_launch_event_sha256: preparedLaunchEventSha256,
        prepared_launch_event_task_sequence: preparedLaunchEventTaskSequence,
        copy_paste_reviewer_launch_prompt: copyPasteReviewerLaunchPrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPasteReviewerLaunchPromptSha256
    }, null, 2)}\n`, 'utf8');
    const launchInputArtifactSha256 = createHash('sha256')
        .update(fs.readFileSync(launchInputArtifactPath))
        .digest('hex');
    const pinnedInputEvent = appendTaskEvent(
        getOrchestratorRoot(options.repoRoot),
        options.taskId,
        'REVIEWER_LAUNCH_INPUT_PINNED',
        'INFO',
        'Reviewer launch input pinned by lifecycle regression fixture.',
        {
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routingEventSha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_attempt_id: options.reviewerLaunchAttemptId,
            prepared_launch_event_sha256: preparedLaunchEventSha256,
            reviewer_launch_artifact_path: normalizedLaunchArtifactPath,
            reviewer_launch_input_artifact_path: normalizedLaunchInputArtifactPath,
            reviewer_launch_input_artifact_sha256: launchInputArtifactSha256
        },
        { passThru: true }
    );
    const pinnedInputEventSha256 = String(pinnedInputEvent?.integrity?.event_sha256 || '').trim();
    const pinnedInputEventTaskSequence = Number(pinnedInputEvent?.integrity?.task_sequence);
    assert.match(pinnedInputEventSha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(pinnedInputEventTaskSequence) && pinnedInputEventTaskSequence > 0);
    launchArtifact.reviewer_launch_attempt_id = options.reviewerLaunchAttemptId;
    launchArtifact.reviewer_launch_artifact_path = normalizedLaunchArtifactPath;
    launchArtifact.reviewer_launch_input_artifact_path = normalizedLaunchInputArtifactPath;
    launchArtifact.reviewer_launch_input_artifact_sha256 = launchInputArtifactSha256;
    launchArtifact.reviewer_launch_input_pinned_event_sha256 = pinnedInputEventSha256;
    launchArtifact.reviewer_launch_input_pinned_event_task_sequence = pinnedInputEventTaskSequence;
    launchArtifact.prepared_launch_event_sha256 = preparedLaunchEventSha256;
    launchArtifact.prepared_launch_event_task_sequence = preparedLaunchEventTaskSequence;
    launchArtifact.copy_paste_reviewer_launch_prompt = copyPasteReviewerLaunchPrompt;
    launchArtifact.copy_paste_reviewer_launch_prompt_sha256 = copyPasteReviewerLaunchPromptSha256;
    launchArtifact.launch_input_mode = 'copy_paste_prompt';
    launchArtifact.launch_input_sha256 = copyPasteReviewerLaunchPromptSha256;
    launchArtifact.launch_input_copy_paste_reviewer_launch_prompt_sha256 = copyPasteReviewerLaunchPromptSha256;
    launchArtifact.review_output_path = (
        options.reviewOutputPath || path.join(path.dirname(options.launchArtifactPath), 'review-output.md')
    ).replace(/\\/g, '/');
    if (options.provider) {
        launchArtifact.provider = options.provider;
    }
    if (options.attestationSource) {
        launchArtifact.attestation_source = options.attestationSource;
    }
    const reboundLaunchCompletedAtUtc = options.recordCompletion ? new Date().toISOString() : null;
    if (reboundLaunchCompletedAtUtc) {
        launchArtifact.launch_completed_at_utc = reboundLaunchCompletedAtUtc;
    }
    fs.writeFileSync(options.launchArtifactPath, `${JSON.stringify(launchArtifact, null, 2)}\n`, 'utf8');
    const launchArtifactSha256 = createHash('sha256')
        .update(fs.readFileSync(options.launchArtifactPath))
        .digest('hex');
    const reboundDetails = {
        ...invocationDetails,
        reviewer_launch_attempt_id: options.reviewerLaunchAttemptId,
        reviewer_launch_artifact_path: normalizedLaunchArtifactPath,
        reviewer_launch_artifact_sha256: launchArtifactSha256,
        reviewer_launch_input_artifact_path: normalizedLaunchInputArtifactPath,
        reviewer_launch_input_artifact_sha256: launchInputArtifactSha256,
        reviewer_launch_input_pinned_event_sha256: pinnedInputEventSha256,
        reviewer_launch_input_pinned_event_task_sequence: pinnedInputEventTaskSequence,
        prepared_launch_event_sha256: preparedLaunchEventSha256,
        prepared_launch_event_task_sequence: preparedLaunchEventTaskSequence,
        launch_binding_sha256: launchBindingSha256,
        review_context_sha256: reviewContextSha256,
        ...(options.attestationSource
            ? {
                reviewer_launch_attestation_source: options.attestationSource,
                attestation_source: options.attestationSource
            }
            : {}),
        ...(reboundLaunchCompletedAtUtc ? { launch_completed_at_utc: reboundLaunchCompletedAtUtc } : {})
    };
    if (options.recordCompletion) {
        appendTaskEvent(
            getOrchestratorRoot(options.repoRoot),
            options.taskId,
            'REVIEWER_DELEGATION_STARTED',
            'INFO',
            'Reviewer delegation start rebound by lifecycle regression fixture.',
            reboundDetails
        );
        appendTaskEvent(
            getOrchestratorRoot(options.repoRoot),
            options.taskId,
            'REVIEWER_LAUNCH_COMPLETED',
            'PASS',
            'Reviewer launch completion rebound by lifecycle regression fixture.',
            reboundDetails
        );
    }
    appendTaskEvent(
        getOrchestratorRoot(options.repoRoot),
        options.taskId,
        'REVIEWER_INVOCATION_ATTESTED',
        'INFO',
        'Reviewer invocation rebound by lifecycle regression fixture.',
        reboundDetails
    );
}

describe('gates command review result - normalization', () => {

    it('record-review-result preserves multiple independent findings through normalization and receipt recording', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-318-heading-normalization';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers/index.ts` and `src/gates/completion-verdict-markdown.ts` for reviewer receipt heading normalization, confirming that obvious markdown variants remain auditable without changing raw evidence.',
            '',
            '### Validation Notes',
            'Reviewed both independent failure boundaries and the complete normalization and receipt path.',
            '',
            '**Findings by Severity**',
            '- High: `src/first.ts:10` forged evidence is accepted; impact: trust bypass; remediation: bind the receipt hash.',
            '- Medium: `src/later.ts:42` later category is skipped; impact: incomplete review; remediation: finish the complete sweep.',
            '',
            '## Deferred Findings',
            'none',
            '',
            '### Residual Risks',
            'none',
            '',
            '## **Verdict**',
            'REVIEW FAILED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(rawReviewContent.includes('**Findings by Severity**'));
        assert.ok(rawReviewContent.includes('forged evidence is accepted'));
        assert.ok(rawReviewContent.includes('later category is skipped'));
        assert.ok(rawReviewContent.includes('### Residual Risks'));
        assert.ok(rawReviewContent.includes('## **Verdict**'));
        assert.ok(artifactContent.includes('## Findings by Severity\n- High: `src/first.ts:10` forged evidence is accepted'));
        assert.ok(artifactContent.includes('- Medium: `src/later.ts:42` later category is skipped'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        assert.ok(artifactContent.includes('## Verdict\nREVIEW FAILED'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        const reviewExecutionBindings = resolveReviewExecutionRuntimeBindings(
            JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>
        );
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        for (const [field, expectedValue] of Object.entries(reviewExecutionBindings)) {
            assert.equal(receipt[field], expectedValue);
        }
        const invocationEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        assert.equal(
            receipt.reviewer_provenance.reviewer_launch_artifact_path,
            (invocationEvent?.details as Record<string, unknown>)?.reviewer_launch_artifact_path
        );
        assert.equal(
            receipt.reviewer_provenance.reviewer_launch_artifact_sha256,
            (invocationEvent?.details as Record<string, unknown>)?.reviewer_launch_artifact_sha256
        );
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects an invocation-bound substituted review execution contract', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-992-result-execution-binding-tamper';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const invocationEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        assert.ok(invocationEvent?.details);
        const launchArtifact = JSON.parse(
            fs.readFileSync(fixture.launchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        fs.writeFileSync(fixture.launchArtifactPath, `${JSON.stringify({
            ...launchArtifact,
            review_execution_contract_sha256: '0'.repeat(64)
        }, null, 2)}\n`, 'utf8');
        const substitutedLaunchArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(fixture.launchArtifactPath))
            .digest('hex');
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEWER_INVOCATION_ATTESTED',
            'INFO',
            'Reviewer invocation rebound to a substituted execution contract by regression fixture.',
            {
                ...(invocationEvent.details as Record<string, unknown>),
                reviewer_launch_artifact_sha256: substitutedLaunchArtifactSha256
            }
        );
        const reviewOutputDir = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code'
        );
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.writeFileSync(
            reviewOutputPath,
            `${JSON.stringify(buildNoFindingsJsonReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
            'utf8'
        );

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', reviewOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.ok(
            result.errors.some((line) => line.includes(
                'Reviewer launch artifact review_execution_contract_sha256 does not match the current authenticated review context'
            )),
            result.errors.join('\n')
        );
        assert.equal(
            fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)),
            false
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEW_RECORDED'),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result does not convert PASS validation-boundary notes into deferred findings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-496-validation-boundary-notes';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` and `src/gates/build-review-context.ts` for PASS review normalization. I did not identify a blocking lifecycle, routing, review-trust, or test-adequacy regression.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            '- Full repository test suite was not run by this reviewer. Focused validation passed: `npm test -- tests/node/gates/build-review-context.test.ts`.',
            '- Read-only review; full-suite validation was already covered by the mandatory gate.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('## Findings by Severity\nNone'));
        assert.ok(artifactContent.includes('## Deferred Findings\n\nNone'));
        assert.ok(artifactContent.includes('## Residual Risks\nNone'));
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        assert.ok(!artifactContent.includes('- [follow-up] Full repository test suite was not run by this reviewer'));
        assert.ok(!artifactContent.includes('- [follow-up] Read-only review; full-suite validation was already covered'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result filters inline-diff validation-boundary notes from PASS residual risks', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-575-inline-diff-boundary-note';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` and `src/gates/completion-verdict-findings.ts` for PASS review boundary-note handling. I confirmed the reviewer-output parser keeps non-actionable validation limits out of strict follow-up sections.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            '- Review artifact did not include inline diff; reviewer relied on the generated review context and source inspection for `src/cli/commands/gate-review-handlers/index.ts`.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('Review artifact did not include inline diff'));
        assert.ok(artifactContent.includes('## Findings by Severity\nNone'));
        assert.ok(artifactContent.includes('## Deferred Findings\n\nNone'));
        assert.ok(artifactContent.includes('## Residual Risks\nNone'));
        const normalizedDeferredStart = artifactContent.lastIndexOf('## Deferred Findings');
        const normalizedDeferredBlock = normalizedDeferredStart >= 0
            ? artifactContent.slice(normalizedDeferredStart).split('## Residual Risks')[0] || ''
            : '';
        assert.ok(!normalizedDeferredBlock.includes('Review artifact did not include inline diff'));
        const normalizedResidualStart = artifactContent.lastIndexOf('## Residual Risks');
        const normalizedResidualBlock = normalizedResidualStart >= 0
            ? artifactContent.slice(normalizedResidualStart).split('## Verdict')[0] || ''
            : '';
        assert.ok(!normalizedResidualBlock.includes('Review artifact did not include inline diff'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result filters command log notes from PASS deferred follow-up obligations', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-545-command-log-notes';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` and `src/gates/build-review-context.ts` for reviewer output normalization.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none.',
            '',
            'Commands run:',
            '- `Get-Content TASK.md -TotalCount 260`',
            '- `rg -n "Deferred Findings|Commands run" src/cli/commands/gate-review-handlers/index.ts`',
            '- `npm test -- tests/node/cli/commands/gates.test.ts`',
            '',
            '## Deferred Findings',
            'none.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('## Findings by Severity\nNone'));
        assert.ok(artifactContent.includes('## Deferred Findings\n\nNone'));
        assert.ok(artifactContent.includes('## Residual Risks\nNone'));
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        const normalizedDeferredStart = artifactContent.lastIndexOf('## Deferred Findings');
        const normalizedDeferredBlock = normalizedDeferredStart >= 0
            ? artifactContent.slice(normalizedDeferredStart).split('## Residual Risks')[0] || ''
            : '';
        assert.ok(!normalizedDeferredBlock.includes('Commands run:'));
        assert.ok(!normalizedDeferredBlock.includes('Get-Content TASK.md'));
        assert.ok(!normalizedDeferredBlock.includes('rg -n'));
        assert.ok(!normalizedDeferredBlock.includes('npm test -- tests/node/cli/commands/gates.test.ts'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result deduplicates PASS deferred findings before strict follow-up enforcement', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-545-dedup-deferred';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-refactor.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-refactor-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'refactor'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'refactor'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'refactor');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Refactor Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` for duplicate deferred finding handling.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            '- Add focused coverage for reviewer command-log normalization.',
            '  Justification: Keep one canonical structured follow-up obligation.',
            '- Add focused coverage for reviewer command-log normalization.',
            '  Justification: Keep one canonical structured follow-up obligation.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REFACTOR REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'refactor',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:refactor-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'refactor',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:refactor-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const normalizedDeferredStart = artifactContent.lastIndexOf('## Deferred Findings');
        const normalizedDeferredBlock = normalizedDeferredStart >= 0
            ? artifactContent.slice(normalizedDeferredStart).split('## Residual Risks')[0] || ''
            : '';
        assert.equal(
            (normalizedDeferredBlock.match(/Add focused coverage for reviewer command-log normalization\./g) || []).length,
            1
        );
        assert.ok(normalizedDeferredBlock.includes('Justification: Keep one canonical structured follow-up obligation.'));
        assert.ok(!normalizedDeferredBlock.includes('Justification: Preserved from raw reviewer output during PASS review normalization.'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects command-like active findings in PASS output instead of inferring follow-ups', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-545-command-like-finding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-security.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'security'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'security'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'security');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Security Review',
            '',
            'Reviewed reviewer output normalization for command-like active findings.',
            '',
            '## Findings by Severity',
            '- High: npm install can pull attacker-controlled packages when reviewer output parsing trusts command-looking findings as validation notes.',
            '',
            '## Deferred Findings',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'SECURITY REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'security',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:security-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'security',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:security-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects command-prefixed risk signals in command blocks instead of inferring follow-ups', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-545-command-risk-signal';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Code Review',
            '',
            'Reviewed command-block preservation for security-relevant validation output.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            'Commands run:',
            '- `npm audit found vulnerabilities in reviewer output materialization`',
            '- `npm audit reported advisory CVE-2026-0001 RCE XSS credential secret token injection traversal`',
            '',
            '## Deferred Findings',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result does not convert T-547-2 PASS residual-risk noise into deferred findings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-547-2-residual-risk-noise';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Validated PASS review normalization for ordinary reviewer summaries.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            '- I could not execute the touched tests directly with `node --test` because this repo\'s test files are TypeScript ESM and require the project\'s normal test harness/runner; direct invocation fails at module loading.',
            '- Based on code inspection, enforcement is correctly wired for mutating `workflow set` paths and coverage was added for missing, missing-timestamp, and stale timestamp cases.',
            '- Time-based tests rely on wall-clock `new Date().toISOString()` and could be sensitive to extreme clock skew in unusual environments, but this is a low residual risk and the suite passed in current preflight.',
            '- Reviewed `src/gates/next-step.ts`, `tests/node/gates/next-step.test.ts`, and `CHANGELOG.md`. I did not identify a blocking lifecycle, routing, review-trust, or test-adequacy regression.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('## Findings by Severity\nNone'));
        assert.ok(artifactContent.includes('## Deferred Findings\n\nNone'));
        assert.ok(artifactContent.includes('## Residual Risks\nNone'));
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        assert.ok(!artifactContent.includes('- [follow-up] I could not execute the touched tests directly'));
        assert.ok(!artifactContent.includes('- [follow-up] Based on code inspection'));
        assert.ok(!artifactContent.includes('- [follow-up] Time-based tests rely on wall-clock'));
        assert.ok(!artifactContent.includes('- [follow-up] Reviewed `src/gates/next-step.ts`'));
        const preservedQuote = artifactContent.split('## Preserved Raw Reviewer Output\n\n')[1]?.split('\n\n')[0];
        assert.ok(preservedQuote, 'Normalized PASS must include the preserved reviewer output block.');
        const preservedOutput = preservedQuote.split('\n').map((line) => line.replace(/^> ?/u, '')).join('\n');
        assert.equal(preservedOutput, reviewOutputContent, 'Markdown quoting must preserve all original residual-risk text.');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_sha256, createHash('sha256').update(reviewOutputContent).digest('hex'));
        assert.equal(receipt.review_artifact_sha256, createHash('sha256').update(artifactContent).digest('hex'));
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result still preserves actionable PASS follow-ups as deferred findings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-496-actionable-followup';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` for PASS review normalization and confirmed the artifact remains auditable after preserving explicit structured deferred findings.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            '- Add explicit future-skew regression coverage for workflow set operator timestamps.',
            '  Justification: The main task covered missing and stale timestamp paths; future-skew workflow-specific coverage can be tracked as separate hardening.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        assert.ok(artifactContent.includes('## Deferred Findings'));
        assert.ok(artifactContent.includes('- Add explicit future-skew regression coverage for workflow set operator timestamps. Justification: The main task covered missing and stale timestamp paths; future-skew workflow-specific coverage can be tracked as separate hardening.'));
        assert.ok(!artifactContent.includes('Justification: Preserved from raw reviewer output during PASS review normalization.'));
        assert.ok(artifactContent.includes('## Residual Risks\nNone'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result materializes no-findings PASS output with substantive validation notes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-validation-notes-pass';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'accepted-result-attempt',
            recordCompletion: true
        });
        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        const report = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        (report.validation_notes as Array<Record<string, unknown>>).push({
            id: 'N-002',
            topic: 'focused-self-validation',
            note: 'The reviewer ran one narrow validation relevant to the changed source behavior.',
            command: 'node tools/validate-contract.js garda-agent-orchestrator/runtime/init-answers.json',
            command_outcome: 'passed',
            diagnostics: 'The focused validation completed successfully with no reported contract errors.',
            evidence: [{
                location: 'src/app.ts:1',
                observation: 'The changed source contract motivated this focused validation.'
            }]
        });
        fs.writeFileSync(
            reviewOutputPath,
            `${JSON.stringify(report, null, 2)}\n`,
            'utf8'
        );

        const result = await runCliWithCapturedOutput([
            'gate',
            'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', reviewOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 0, result.errors.join('\n'));
        const artifactPath = path.join(fixture.reviewsRoot, `${taskId}-code.md`);
        assert.equal(fs.existsSync(artifactPath), true);
        const artifact = fs.readFileSync(artifactPath, 'utf8');
        assert.equal(/REVIEW PASSED|REVIEW FAILED|## Verdict/u.test(artifact), false);
        const receiptPath = path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`);
        assert.equal(fs.existsSync(receiptPath), true);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const coverage = receipt.review_coverage as Record<string, unknown>;
        assert.equal(coverage.status, 'PASS');
        assert.equal(coverage.completed_obligation_count, coverage.obligation_count);
        assert.equal(receipt.review_output_format, 'findings_json');
        const reviewExecutionBindings = resolveReviewExecutionRuntimeBindings(
            JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>
        );
        const reviewOutputContract = receipt.review_output_contract as Record<string, unknown>;
        for (const [field, expectedValue] of Object.entries(reviewExecutionBindings)) {
            assert.equal(receipt[field], expectedValue);
            assert.equal(reviewOutputContract[field], expectedValue);
        }
        const acceptedValidationArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-findings-validation.json`
        );
        const acceptedValidationArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(acceptedValidationArtifactPath))
            .digest('hex');
        const rejectedReplay = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        rejectedReplay.validation_notes = [];
        const unboundReplayOutputPath = path.join(reviewOutputDir, 'unbound-invalid-replay.md');
        fs.writeFileSync(unboundReplayOutputPath, `${JSON.stringify(rejectedReplay, null, 2)}\n`, 'utf8');
        const replayResult = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', unboundReplayOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });
        assert.notEqual(replayResult.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched',
            'an accepted attempt must not be relabeled after an invalid replay'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        assert.equal(
            createHash('sha256').update(fs.readFileSync(acceptedValidationArtifactPath)).digest('hex'),
            acceptedValidationArtifactSha256,
            'an invalid replay must not replace accepted validation evidence'
        );
        assert.equal(
            JSON.parse(fs.readFileSync(acceptedValidationArtifactPath, 'utf8')).validation_result.status,
            'accepted'
        );
        const completedLaunchArtifactText = fs.readFileSync(fixture.launchArtifactPath, 'utf8');
        const completedLaunchArtifactSha256 = createHash('sha256')
            .update(completedLaunchArtifactText)
            .digest('hex');
        fs.writeFileSync(fixture.launchArtifactPath, `${JSON.stringify({
            ...JSON.parse(completedLaunchArtifactText),
            attestation_state: 'launch_failed',
            launch_failure_stage: 'review_findings_validation',
            rejected_reviewer_launch_artifact_sha256: completedLaunchArtifactSha256,
            review_findings_validation_artifact_path: acceptedValidationArtifactPath.replace(/\\/g, '/'),
            review_findings_validation_artifact_sha256: acceptedValidationArtifactSha256
        }, null, 2)}\n`, 'utf8');
        const relabeledReplayResult = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', unboundReplayOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });
        assert.notEqual(relabeledReplayResult.exitCode, 0);
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false,
            'mutable failed-state relabel must not create authenticated failure telemetry'
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects headings-only PASS output with empty validation notes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-validation-notes-empty';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'stale-rejected-output-attempt',
            recordCompletion: true
        });
        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        const report = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        report.validation_notes = [];
        fs.writeFileSync(reviewOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        fs.utimesSync(reviewOutputPath, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

        const result = await runCliWithCapturedOutput([
            'gate',
            'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', reviewOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.ok(
            result.errors.some((line) => (
                line.includes('review_output_source_mtime_utc')
            )),
            result.errors.join('\n')
        );
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects malformed coverage result tokens before receipt recording', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-976-result-invalid-coverage-token';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'review-output.md');
        const ledger = buildNoFindingCoverageLedger(fixture.reviewContextPath);
        ledger[0] = ledger[0].replace('"result":"no-finding"', '"result":"maybe"');
        fs.writeFileSync(outputPath, [
            '# Review', '',
            '## Validation Notes',
            'Reviewed the complete current code scope and concrete generated coverage obligations.', '',
            '## Coverage Ledger', ...ledger, '',
            '## Findings by Severity', 'None', '',
            '## Deferred Findings', 'None', '',
            '## Residual Risks', 'None', '',
            '## Verdict', 'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const recordArgs = [
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];
        const result = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });

        assert.equal(result.exitCode, 1);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects a generated coverage context downgraded before reviewer attestation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-976-result-schema-downgrade';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const downgradedContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8'));
        downgradedContext.schema_version = 2;
        fs.writeFileSync(fixture.reviewContextPath, `${JSON.stringify(downgradedContext, null, 2)}\n`, 'utf8');
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(fixture.reviewsRoot, `${taskId}-downgraded-output.md`);
        fs.writeFileSync(outputPath, '# Review\n\n## Verdict\nREVIEW PASSED\n', 'utf8');

        const recordArgs = [
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];
        const taskEventsPath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'task-events',
            `${taskId}.jsonl`
        );
        const authenticatedTimeline = fs.readFileSync(taskEventsPath, 'utf8');
        const corruptedTimelineLines = authenticatedTimeline.trim().split(/\r?\n/u);
        const completedEvent = JSON.parse(
            corruptedTimelineLines[corruptedTimelineLines.length - 1]
        ) as Record<string, unknown>;
        (completedEvent.integrity as Record<string, unknown>).event_sha256 = '0'.repeat(64);
        corruptedTimelineLines[corruptedTimelineLines.length - 1] = JSON.stringify(completedEvent);
        fs.writeFileSync(taskEventsPath, `${corruptedTimelineLines.join('\n')}\n`, 'utf8');

        const unauthenticatedResult = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });

        assert.notEqual(unauthenticatedResult.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched',
            'corrupted completion-event integrity must not authorize terminalization'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        fs.writeFileSync(taskEventsPath, authenticatedTimeline, 'utf8');

        const result = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });

        assert.equal(result.exitCode, 1);
        assert.ok([...result.logs, ...result.errors].join('\n').includes('require review-context schema_version 3 or newer'));
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result records one verdict-free JSON finding and derives a failed gate verdict', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-2-result-findings-json';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
            coverage_contract: {
                contract_sha256: string;
                obligations: Array<{ id: string; kind: string; target: string }>;
            };
            task_scope: { changed_files: string[] };
            tree_state: { tree_state_sha256: string };
        };
        const defaultFile = reviewContext.task_scope.changed_files[0];
        const reviewContextSha256 = createHash('sha256').update(fs.readFileSync(fixture.reviewContextPath)).digest('hex');
        const outputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'review-output.md');
        fs.writeFileSync(outputPath, `${JSON.stringify({
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            review_context_sha256: reviewContextSha256,
            tree_state_sha256: reviewContext.tree_state.tree_state_sha256,
            review_execution: buildReviewExecutionEvidenceFixture(fixture.reviewContextPath),
            validation_notes: [{
                id: 'N-001',
                topic: 'complete-scope-sweep',
                note: 'Reviewed the complete assigned code scope and generated coverage obligations.',
                evidence: [{
                    location: `${defaultFile}:1`,
                    observation: 'Validated concrete source behavior and receipt materialization for verdict-free JSON review output.'
                }]
            }],
            coverage_ledger: {
                coverage_contract_sha256: reviewContext.coverage_contract.contract_sha256,
                entries: reviewContext.coverage_contract.obligations.map((obligation, index) => ({
                    obligation_id: obligation.id,
                    evidence: [{
                        location: `${obligation.kind === 'file' ? obligation.target : defaultFile}:1`,
                        observation: `Verified concrete ${obligation.kind} behavior for ${obligation.target} against the assigned review contract.`
                    }],
                    finding_ids: index === 0 ? ['F-001'] : []
                }))
            },
            findings: {
                critical: [],
                high: [{
                    id: 'F-001',
                    title: 'Example verdict-free JSON finding',
                    description: 'The reviewer reported an active finding at src/gates/review-context/review-context-token-economy.ts:54 without emitting a legacy verdict token.',
                    evidence: [{
                        location: `${defaultFile}:1`,
                        observation: 'The finding is bound to a changed file and line for JSON ingestion coverage.'
                    }],
                    coverage_obligation_ids: [reviewContext.coverage_contract.obligations[0].id]
                }],
                medium: [],
                low: []
            },
            residual_risks: [],
            reviewer_notes: [
                'No legacy verdict token is present in this JSON output.',
                'Sanitize API_TOKEN=fixture-secret before durable persistence.'
            ]
        }, null, 2)}\n`, 'utf8');

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 0, result.errors.join('\n'));
        assert.ok(result.logs.some((line) => line.includes('VerdictToken: REVIEW FAILED')), result.logs.join('\n'));
        const artifact = fs.readFileSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`), 'utf8');
        assert.equal(/REVIEW PASSED|REVIEW FAILED|## Verdict/u.test(artifact), false);
        assert.doesNotMatch(artifact, /fixture-secret/);
        const receiptPath = path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.deepEqual(receipt.review_coverage.finding_ids, ['F-001']);
        assert.equal(receipt.review_output_format, 'findings_json');
        assert.equal(receipt.review_output_schema_version, 2);
        assert.equal(receipt.review_output_contract.format, 'findings_json');
        assert.equal(receipt.review_output_contract.review_context_sha256, reviewContextSha256);
        assert.equal(receipt.review_output_contract.review_tree_state_sha256, reviewContext.tree_state.tree_state_sha256);
        assert.equal(receipt.review_output_contract.coverage_contract_sha256, reviewContext.coverage_contract.contract_sha256);
        assert.equal(receipt.review_output_contract.reviewer_identity, fixture.reviewerIdentity);
        assert.equal(receipt.review_findings_validation.status, 'accepted');
        assert.equal(receipt.review_findings_validation.accepted, true);
        const acceptedLaunchArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8'));
        assert.equal(acceptedLaunchArtifact.attestation_state, 'launched');
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        assert.equal(receipt.review_output_contract.validation_artifact_sha256, receipt.review_findings_validation.artifact_sha256);
        assert.equal(
            receipt.review_output_contract.validation_result_sha256,
            receipt.review_findings_validation.validation_result_sha256
        );
        const validationArtifactPath = path.join(fixture.reviewsRoot, `${taskId}-code-findings-validation.json`);
        assert.equal(receipt.review_findings_validation.artifact_path, validationArtifactPath.replace(/\\/g, '/'));
        const validationArtifact = JSON.parse(fs.readFileSync(validationArtifactPath, 'utf8'));
        assert.equal(validationArtifact.artifact_type, 'review_findings_validation');
        assert.equal(validationArtifact.validation_result.status, 'accepted');
        assert.equal(validationArtifact.validation_result.normalized_inventory.finding_count, 1);
        assert.match(
            validationArtifact.validation_result.normalized_inventory.findings_by_severity.high[0].description,
            /review-context-token-economy\.ts:54/
        );
        assert.equal(
            validationArtifact.validation_result_sha256,
            createHash('sha256')
                .update(`${JSON.stringify(validationArtifact.validation_result, null, 2)}\n`)
                .digest('hex')
        );
        assert.equal(
            createHash('sha256').update(fs.readFileSync(validationArtifactPath)).digest('hex'),
            receipt.review_findings_validation.artifact_sha256
        );
        const dispositionArtifactPath = path.join(fixture.reviewsRoot, `${taskId}-code-findings-disposition.json`);
        assert.equal(receipt.review_findings_disposition_artifact.artifact_path, dispositionArtifactPath.replace(/\\/g, '/'));
        assert.equal(
            receipt.review_output_contract.disposition_artifact_sha256,
            receipt.review_findings_disposition_artifact.artifact_sha256
        );
        assert.equal(
            receipt.review_output_contract.disposition_result_sha256,
            receipt.review_findings_disposition_artifact.disposition_result_sha256
        );
        const dispositionArtifact = JSON.parse(fs.readFileSync(dispositionArtifactPath, 'utf8'));
        assert.equal(dispositionArtifact.artifact_type, 'review_findings_disposition');
        assert.equal(dispositionArtifact.source_validation.accepted, true);
        assert.equal(
            dispositionArtifact.source_validation.artifact_sha256,
            receipt.review_findings_validation.artifact_sha256
        );
        assert.deepEqual(dispositionArtifact.disposition_result, receipt.review_findings_disposition);
        assert.equal(dispositionArtifact.items.length, 1);
        assert.equal(dispositionArtifact.items[0].id, 'F-001');
        assert.equal(dispositionArtifact.items[0].kind, 'finding');
        assert.equal(dispositionArtifact.items[0].severity, 'high');
        assert.equal(dispositionArtifact.items[0].source_rule, 'review_finding_policy.findings.high');
        assert.equal(
            dispositionArtifact.items[0].action,
            receipt.review_findings_disposition.findings.high.action
        );
        assert.equal(dispositionArtifact.items[0].audit_status, 'retained_in_disposition_artifact');
        assert.equal(
            createHash('sha256').update(fs.readFileSync(dispositionArtifactPath)).digest('hex'),
            receipt.review_findings_disposition_artifact.artifact_sha256
        );
        assert.equal(receipt.review_findings_report.findings.high.length, 1);
        assert.equal(receipt.review_findings_report.findings.high[0].id, 'F-001');
        assert.match(
            receipt.review_findings_report.findings.high[0].description,
            /review-context-token-economy\.ts:54/
        );
        assert.equal(receipt.review_findings_report.reviewer_notes[1], 'Sanitize API_TOKEN=<redacted> before durable persistence.');
        assert.doesNotMatch(fs.readFileSync(String(receipt.review_output_path), 'utf8'), /fixture-secret/);
        assert.equal(
            receipt.review_findings_report_sha256,
            createHash('sha256')
                .update(`${JSON.stringify(receipt.review_findings_report, null, 2)}\n`)
                .digest('hex')
        );
        assert.deepEqual(receipt.review_findings_summary.finding_ids_by_severity.high, ['F-001']);
        assert.equal(receipt.review_findings_summary.active_finding_count, 1);
        const recordedEvents = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'REVIEW_RECORDED');
        assert.equal(recordedEvents.length, 1);
        const recordedDetails = recordedEvents[0].details as Record<string, unknown>;
        const receiptFileSha256 = createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex');
        assert.equal(recordedDetails.receipt_sha256, receiptFileSha256);
        const receiptSnapshotPath = String(recordedDetails.receipt_snapshot_path || '');
        assert.equal(fs.existsSync(receiptSnapshotPath), true);
        assert.equal(
            createHash('sha256').update(fs.readFileSync(receiptSnapshotPath)).digest('hex'),
            receiptFileSha256
        );
        assert.equal(Object.prototype.hasOwnProperty.call(recordedDetails, 'review_findings_report'), false);
        assert.equal(recordedDetails.review_findings_report_sha256, receipt.review_findings_report_sha256);
        assert.deepEqual(recordedDetails.review_findings_summary, receipt.review_findings_summary);
        assert.equal(
            recordedDetails.review_findings_report_telemetry_policy,
            'omitted_full_payload_receipt_only'
        );
        assert.equal(fs.existsSync(outputPath), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result applies locked balanced dispositions before deriving the gate verdict', async () => {
        const skipLowClosure = followUpClosureScenarioInput('T-979-10-F1', true, false);
        const forbidChildClosure = followUpClosureScenarioInput('T-979-11-F1', false, true);
        const forbidChildResidualClosure = followUpClosureScenarioInput('T-979-12-F1', false, true);
        const scenarios = [
            {
                taskId: 'T-979-9-balanced-low-follow-up',
                profilePolicySnapshot: balancedProfilePolicySnapshot(),
                subject: 'finding' as const,
                severity: 'low' as const,
                expectedVerdict: 'REVIEW PASSED',
                expectedPolicyId: 'balanced',
                expectedAction: 'create_follow_up',
                expectedBlockingCount: 0,
                expectedDispositionVerdict: 'pass_with_follow_up_or_ignored_findings'
            },
            {
                taskId: 'T-979-9-balanced-residual-follow-up',
                profilePolicySnapshot: balancedProfilePolicySnapshot(),
                subject: 'residual_risk' as const,
                severity: null,
                expectedVerdict: 'REVIEW PASSED',
                expectedPolicyId: 'balanced',
                expectedAction: 'create_follow_up',
                expectedBlockingCount: 0,
                expectedDispositionVerdict: 'pass_with_follow_up_or_ignored_findings'
            },
            {
                taskId: 'T-979-9-soft-low-ignore',
                profilePolicySnapshot: softProfilePolicySnapshot(),
                subject: 'finding' as const,
                severity: 'low' as const,
                expectedVerdict: 'REVIEW PASSED',
                expectedPolicyId: 'soft',
                expectedAction: 'ignore',
                expectedBlockingCount: 0,
                expectedDispositionVerdict: 'pass_with_follow_up_or_ignored_findings'
            },
            {
                taskId: 'T-979-9-soft-residual-ignore',
                profilePolicySnapshot: softProfilePolicySnapshot(),
                subject: 'residual_risk' as const,
                severity: null,
                expectedVerdict: 'REVIEW PASSED',
                expectedPolicyId: 'soft',
                expectedAction: 'ignore',
                expectedBlockingCount: 0,
                expectedDispositionVerdict: 'pass_with_follow_up_or_ignored_findings'
            },
            {
                taskId: 'T-979-9-balanced-high-fix-now',
                profilePolicySnapshot: balancedProfilePolicySnapshot(),
                subject: 'finding' as const,
                severity: 'high' as const,
                expectedVerdict: 'REVIEW FAILED',
                expectedPolicyId: 'balanced',
                expectedAction: 'fix_now',
                expectedBlockingCount: 1,
                expectedDispositionVerdict: 'fail_for_fix_now'
            },
            {
                taskId: 'T-979-10-F1',
                profilePolicySnapshot: skipLowClosure.profilePolicySnapshot,
                taskNotes: skipLowClosure.taskNotes,
                parentTask: skipLowClosure.parentTask,
                subject: 'finding' as const,
                severity: 'low' as const,
                expectedVerdict: 'REVIEW PASSED',
                expectedPolicyId: 'balanced',
                expectedAction: 'ignore',
                expectedBlockingCount: 0,
                expectedDispositionVerdict: 'pass_with_follow_up_or_ignored_findings',
                expectedSourceRule: 'review_follow_up_task_closure_policy.skip_low_findings'
            },
            {
                taskId: 'T-979-11-F1',
                profilePolicySnapshot: forbidChildClosure.profilePolicySnapshot,
                taskNotes: forbidChildClosure.taskNotes,
                parentTask: forbidChildClosure.parentTask,
                subject: 'finding' as const,
                severity: 'low' as const,
                expectedVerdict: 'REVIEW FAILED',
                expectedPolicyId: 'balanced',
                expectedAction: 'fix_now',
                expectedBlockingCount: 1,
                expectedDispositionVerdict: 'fail_for_fix_now',
                expectedSourceRule: 'review_follow_up_task_closure_policy.forbid_child_tasks'
            },
            {
                taskId: 'T-979-12-F1',
                profilePolicySnapshot: forbidChildResidualClosure.profilePolicySnapshot,
                taskNotes: forbidChildResidualClosure.taskNotes,
                parentTask: forbidChildResidualClosure.parentTask,
                subject: 'residual_risk' as const,
                severity: null,
                expectedVerdict: 'REVIEW FAILED',
                expectedPolicyId: 'balanced',
                expectedAction: 'fix_now',
                expectedBlockingCount: 1,
                expectedDispositionVerdict: 'fail_for_fix_now',
                expectedSourceRule: 'review_follow_up_task_closure_policy.forbid_child_tasks'
            }
        ];

        for (const scenario of scenarios) {
            const repoRoot = createTempRepo();
            try {
                const fixture = await seedPromptBoundReviewFixture({
                    repoRoot,
                    taskId: scenario.taskId,
                    ...('taskNotes' in scenario ? { taskNotes: scenario.taskNotes } : {}),
                    ...('parentTask' in scenario ? { parentTask: scenario.parentTask } : {}),
                    preflightOverrides: {
                        profile_policy_snapshot: scenario.profilePolicySnapshot
                    }
                });
                attestReviewerInvocationForTest({
                    repoRoot,
                    taskId: scenario.taskId,
                    reviewType: 'code',
                    reviewContextPath: fixture.reviewContextPath,
                    reviewerIdentity: fixture.reviewerIdentity
                });
                const outputDir = path.join(
                    repoRoot,
                    'garda-agent-orchestrator',
                    'runtime',
                    'tmp',
                    'reviews',
                    scenario.taskId,
                    'code'
                );
                fs.mkdirSync(outputDir, { recursive: true });
                const outputPath = path.join(outputDir, 'review-output.md');
                const report = scenario.subject === 'finding'
                    ? addFindingToReport(
                        buildNoFindingsJsonReport(fixture.reviewContextPath, scenario.taskId),
                        fixture.reviewContextPath,
                        scenario.severity,
                        'F-001'
                    )
                    : addResidualRiskToReport(
                        buildNoFindingsJsonReport(fixture.reviewContextPath, scenario.taskId),
                        fixture.reviewContextPath,
                        'R-001'
                    );
                fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

                const result = await runCliWithCapturedOutput([
                    'gate', 'record-review-result',
                    '--task-id', scenario.taskId,
                    '--review-type', 'code',
                    '--preflight-path', fixture.preflightPath,
                    '--review-output-path', outputPath,
                    '--repo-root', repoRoot,
                    '--reviewer-execution-mode', 'delegated_subagent',
                    '--reviewer-identity', fixture.reviewerIdentity
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, result.errors.join('\n'));
                assert.ok(
                    result.logs.some((line) => line.includes(`VerdictToken: ${scenario.expectedVerdict}`)),
                    result.logs.join('\n')
                );
                assert.ok(
                    result.logs.some((line) => line.includes(`ReviewFindingsBlockingCount: ${scenario.expectedBlockingCount}`)),
                    result.logs.join('\n')
                );
                const receipt = JSON.parse(fs.readFileSync(
                    path.join(fixture.reviewsRoot, `${scenario.taskId}-code-receipt.json`),
                    'utf8'
                ));
                assert.equal(receipt.review_findings_disposition.policy_id, scenario.expectedPolicyId);
                assert.equal(receipt.review_findings_disposition.policy_source, 'preflight_profile_policy_snapshot');
                if (scenario.subject === 'finding') {
                    assert.equal(receipt.review_findings_disposition.findings[scenario.severity].action, scenario.expectedAction);
                    assert.deepEqual(receipt.review_findings_disposition.findings[scenario.severity].ids, ['F-001']);
                } else {
                    assert.equal(receipt.review_findings_disposition.residual_risks.action, scenario.expectedAction);
                    assert.deepEqual(receipt.review_findings_disposition.residual_risks.ids, ['R-001']);
                }
                assert.equal(receipt.review_findings_disposition.blocking_count, scenario.expectedBlockingCount);
                assert.equal(receipt.review_findings_disposition.verdict, scenario.expectedDispositionVerdict);
                assert.equal(receipt.review_findings_disposition.counts_by_action[scenario.expectedAction], 1);
                const dispositionArtifactPath = path.join(
                    fixture.reviewsRoot,
                    `${scenario.taskId}-code-findings-disposition.json`
                );
                const dispositionArtifact = JSON.parse(fs.readFileSync(dispositionArtifactPath, 'utf8'));
                assert.deepEqual(dispositionArtifact.disposition_result, receipt.review_findings_disposition);
                assert.equal(
                    receipt.review_output_contract.disposition_artifact_sha256,
                    receipt.review_findings_disposition_artifact.artifact_sha256
                );
                assert.equal(
                    receipt.review_output_contract.disposition_result_sha256,
                    receipt.review_findings_disposition_artifact.disposition_result_sha256
                );
                assert.equal(
                    createHash('sha256').update(fs.readFileSync(dispositionArtifactPath)).digest('hex'),
                    receipt.review_findings_disposition_artifact.artifact_sha256
                );
                assert.equal(dispositionArtifact.items.length, 1);
                const dispositionItem = dispositionArtifact.items[0];
                const expectedClosureSourceRule = 'expectedSourceRule' in scenario
                    ? scenario.expectedSourceRule
                    : undefined;
                assert.equal(dispositionItem.id, scenario.subject === 'finding' ? 'F-001' : 'R-001');
                assert.equal(dispositionItem.action, scenario.expectedAction);
                assert.equal(
                    dispositionItem.source_rule,
                    expectedClosureSourceRule
                        ?? (scenario.subject === 'finding'
                            ? `review_finding_policy.findings.${String(scenario.severity)}`
                            : 'review_finding_policy.residual_risk')
                );
                if (expectedClosureSourceRule) {
                    assert.deepEqual(
                        receipt.review_findings_disposition.review_follow_up_task_closure_policy,
                        scenario.profilePolicySnapshot.review_follow_up_task_closure_policy
                    );
                    assert.deepEqual(
                        dispositionArtifact.policy.review_follow_up_task_closure_policy,
                        scenario.profilePolicySnapshot.review_follow_up_task_closure_policy
                    );
                }
                assert.equal(
                    dispositionItem.materialization_status,
                    scenario.expectedAction === 'fix_now'
                        ? 'requires_fix_now'
                        : scenario.expectedAction === 'create_follow_up'
                            ? 'pending_follow_up_materialization'
                            : 'audited_ignored'
                );
                assert.equal(dispositionItem.audit_status, 'retained_in_disposition_artifact');
                const remediationBaselinePath = path.join(
                    fixture.reviewsRoot,
                    `${scenario.taskId}-code-remediation-baseline.json`
                );
                assert.equal(
                    fs.existsSync(remediationBaselinePath),
                    scenario.expectedAction === 'fix_now'
                );
                if (scenario.expectedAction === 'fix_now') {
                    const baseline = JSON.parse(fs.readFileSync(remediationBaselinePath, 'utf8'));
                    const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8'));
                    const expectedItemId = scenario.subject === 'finding' ? 'F-001' : 'R-001';
                    assert.equal(baseline.artifact_type, 'review_findings_remediation_baseline');
                    assert.equal(baseline.schema_version, 2);
                    assert.equal(baseline.task_id, scenario.taskId);
                    assert.equal(baseline.review_type, 'code');
                    assert.deepEqual(baseline.fix_now_items.map((item: { id: string }) => item.id), [expectedItemId]);
                    assert.equal(baseline.fix_now_items[0].action, 'fix_now');
                    assert.equal(baseline.path_line_inventory.length, 1);
                    assert.deepEqual(baseline.path_line_inventory[0].item_ids, [expectedItemId]);
                    assert.equal(
                        baseline.bindings.findings_validation.artifact_sha256,
                        receipt.review_findings_validation.artifact_sha256
                    );
                    assert.equal(
                        baseline.bindings.findings_disposition.artifact_sha256,
                        receipt.review_findings_disposition_artifact.artifact_sha256
                    );
                    assert.equal(baseline.delta_base.task_id, scenario.taskId);
                    assert.equal(baseline.delta_base.review_type, 'code');
                    assert.equal(
                        baseline.delta_base.review_tree_state_sha256,
                        reviewContext.tree_state.tree_state_sha256
                    );
                    assert.deepEqual(baseline.delta_base.changed_files, ['src/app.ts']);
                    assert.equal(
                        baseline.delta_base.changed_files_sha256,
                        createHash('sha256').update('src/app.ts').digest('hex')
                    );
                    assert.equal(baseline.delta_base.entries.length, 1);
                    assert.equal(baseline.delta_base.entries[0].path, 'src/app.ts');
                    assert.equal(
                        baseline.delta_base.entries[0].content_sha256,
                        createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'src', 'app.ts'))).digest('hex')
                    );
                    assert.match(baseline.delta_base.snapshot_sha256, /^[0-9a-f]{64}$/u);
                    const recordedEvent = readTaskTimelineEvents(repoRoot, scenario.taskId)
                        .find((event) => event.event_type === 'REVIEW_RECORDED');
                    const recordedDetails = recordedEvent?.details as Record<string, unknown> | undefined;
                    assert.equal(recordedDetails?.remediation_baseline_path, remediationBaselinePath.replace(/\\/gu, '/'));
                    assert.equal(
                        recordedDetails?.remediation_baseline_sha256,
                        createHash('sha256').update(fs.readFileSync(remediationBaselinePath)).digest('hex')
                    );
                    assert.equal(fs.existsSync(String(recordedDetails?.remediation_baseline_snapshot_path || '')), true);
                }
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
    });

    it('record-review-result keeps findings validation profile-independent across profile variants', async () => {
        const profileNames = ['soft', 'balanced', 'strict', 'custom-reviewer'] as const;
        let expectedProfileNeutralValidation: Record<string, unknown> | null = null;

        for (const profileName of profileNames) {
            const repoRoot = createTempRepo();
            try {
                const taskId = 'T-979-7-profile-independent-validation';
                const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
                writeProfilesConfig(repoRoot, profileName);
                attestReviewerInvocationForTest({
                    repoRoot,
                    taskId,
                    reviewType: 'code',
                    reviewContextPath: fixture.reviewContextPath,
                    reviewerIdentity: fixture.reviewerIdentity
                });

                const outputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
                fs.mkdirSync(outputDir, { recursive: true });
                const outputPath = path.join(outputDir, 'review-output.md');
                fs.writeFileSync(
                    outputPath,
                    `${JSON.stringify(buildNoFindingsJsonReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
                    'utf8'
                );

                const result = await runCliWithCapturedOutput([
                    'gate', 'record-review-result',
                    '--task-id', taskId,
                    '--review-type', 'code',
                    '--preflight-path', fixture.preflightPath,
                    '--review-output-path', outputPath,
                    '--repo-root', repoRoot,
                    '--reviewer-execution-mode', 'delegated_subagent',
                    '--reviewer-identity', fixture.reviewerIdentity
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, result.errors.join('\n'));
                const validationArtifactPath = path.join(fixture.reviewsRoot, `${taskId}-code-findings-validation.json`);
                const validationArtifact = JSON.parse(fs.readFileSync(validationArtifactPath, 'utf8')) as Record<string, unknown>;
                const validationResult = validationArtifact.validation_result as Record<string, unknown>;
                assert.equal(validationResult.status, 'accepted');
                assert.equal(validationResult.accepted, true);
                assert.equal(
                    JSON.stringify(validationResult).includes(profileName),
                    false,
                    `profile '${profileName}' leaked into findings validation result`
                );

                const actualProfileNeutralValidation = profileNeutralValidationSnapshot(validationArtifact);
                if (expectedProfileNeutralValidation === null) {
                    expectedProfileNeutralValidation = actualProfileNeutralValidation;
                } else {
                    assert.deepEqual(actualProfileNeutralValidation, expectedProfileNeutralValidation);
                }
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
    });

    it('record-review-result persists rejected findings validation artifact before failing invalid findings JSON', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-json-invalid-validation-artifact';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const explicitLaunchArtifactPath = path.join(
            path.dirname(fixture.launchArtifactPath),
            'explicit-reviewer-launch.json'
        );
        fs.renameSync(fixture.launchArtifactPath, explicitLaunchArtifactPath);
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: explicitLaunchArtifactPath,
            reviewerLaunchAttemptId: 'explicit-path-rejected-attempt',
            reviewOutputPath: path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                'reviews',
                taskId,
                'code',
                'review-output.md'
            )
        });
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
            coverage_contract: {
                contract_sha256: string;
                obligations: Array<{ id: string; kind: string; target: string }>;
            };
            task_scope: { changed_files: string[] };
            tree_state: { tree_state_sha256: string };
        };
        const defaultFile = reviewContext.task_scope.changed_files[0];
        const reviewContextSha256 = createHash('sha256').update(fs.readFileSync(fixture.reviewContextPath)).digest('hex');
        const outputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'review-output.md');
        const invalidReviewOutput = `${JSON.stringify({
            schema_version: 1,
            task_id: taskId,
            review_type: 'code',
            review_context_sha256: reviewContextSha256,
            tree_state_sha256: reviewContext.tree_state.tree_state_sha256,
            validation_notes: [],
            coverage_ledger: {
                coverage_contract_sha256: reviewContext.coverage_contract.contract_sha256,
                entries: reviewContext.coverage_contract.obligations.map((obligation) => ({
                    obligation_id: obligation.id,
                    evidence: [{
                        location: `${obligation.kind === 'file' ? obligation.target : defaultFile}:1`,
                        observation: `Verified concrete ${obligation.kind} behavior for ${obligation.target} against the assigned review contract.`
                    }],
                    finding_ids: []
                }))
            },
            findings: { critical: [], high: [], medium: [], low: [] },
            residual_risks: [],
            reviewer_notes: ['password=super-secret-review-output']
        }, null, 2)}\n`;
        fs.writeFileSync(outputPath, invalidReviewOutput, 'utf8');

        const recordArgs = [
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];
        const validationArtifactPath = path.join(fixture.reviewsRoot, `${taskId}-code-findings-validation.json`);
        const incompleteResult = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });
        assert.notEqual(incompleteResult.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(explicitLaunchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        assert.equal(fs.existsSync(validationArtifactPath), true);
        const incompleteValidationSha256 = createHash('sha256')
            .update(fs.readFileSync(validationArtifactPath))
            .digest('hex');
        const invocationEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        assert.ok(invocationEvent?.details);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEWER_LAUNCH_COMPLETED',
            'PASS',
            'Stale launch completion fixture with mismatched launch-artifact hash.',
            {
                ...(invocationEvent.details as Record<string, unknown>),
                reviewer_launch_artifact_sha256: '0'.repeat(64)
            }
        );

        const staleCompletionResult = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });
        assert.notEqual(staleCompletionResult.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(explicitLaunchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        const incompleteValidationFamily = fs.readdirSync(fixture.reviewsRoot)
            .filter((name) => name.startsWith(`${taskId}-code-findings-validation`))
            .sort()
            .map((name) => ({
                name,
                sha256: createHash('sha256')
                    .update(fs.readFileSync(path.join(fixture.reviewsRoot, name)))
                    .digest('hex')
            }));
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: explicitLaunchArtifactPath,
            reviewerLaunchAttemptId: 'explicit-path-rejected-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true,
            provider: 'StatelessFixture'
        });
        const unboundOutputPath = path.join(outputDir, 'unbound-invalid-output.md');
        fs.writeFileSync(unboundOutputPath, invalidReviewOutput, 'utf8');
        const unboundResult = await runCliWithCapturedOutput([
            ...recordArgs.slice(0, 9),
            unboundOutputPath,
            ...recordArgs.slice(10)
        ], { cwd: repoRoot });
        assert.notEqual(unboundResult.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(explicitLaunchArtifactPath, 'utf8')).attestation_state,
            'launched',
            'an unbound output path must not terminalize an unconsumed completed attempt'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        const resultRecorderLockPath = path.join(
            path.dirname(explicitLaunchArtifactPath),
            '.record-review-result.lock'
        );
        fs.mkdirSync(resultRecorderLockPath, { recursive: true });
        fs.writeFileSync(path.join(resultRecorderLockPath, 'owner.json'), `${JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString(),
            owner_label: `record-review-result:${taskId}:code`
        }, null, 2)}\n`, 'utf8');
        const concurrentResult = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });
        assert.notEqual(concurrentResult.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(explicitLaunchArtifactPath, 'utf8')).attestation_state,
            'launched',
            'a concurrent result recorder must not enter the recovery transition'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        fs.rmSync(resultRecorderLockPath, { recursive: true, force: true });
        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const lockPath = path.join(taskEventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2)}\n`, 'utf8');

        const rollbackResult = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });
        assert.notEqual(rollbackResult.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(explicitLaunchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        assert.equal(
            createHash('sha256').update(fs.readFileSync(validationArtifactPath)).digest('hex'),
            incompleteValidationSha256
        );
        assert.deepEqual(
            fs.readdirSync(fixture.reviewsRoot)
                .filter((name) => name.startsWith(`${taskId}-code-findings-validation`))
                .sort()
                .map((name) => ({
                    name,
                    sha256: createHash('sha256')
                        .update(fs.readFileSync(path.join(fixture.reviewsRoot, name)))
                        .digest('hex')
                })),
            incompleteValidationFamily
        );
        fs.rmSync(lockPath, { recursive: true, force: true });
        const completedLaunchArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(explicitLaunchArtifactPath))
            .digest('hex');

        const result = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.ok(
            result.errors.some((line) => line.includes('Verdict-free findings JSON report is invalid')),
            result.errors.join('\n')
        );
        assert.equal(fs.existsSync(validationArtifactPath), true);
        const validationArtifact = JSON.parse(fs.readFileSync(validationArtifactPath, 'utf8'));
        assert.equal(validationArtifact.validation_result.status, 'rejected');
        assert.equal(validationArtifact.validation_result.accepted, false);
        assert.ok(validationArtifact.validation_result.violations.some((violation: string) =>
            violation.includes('validation_notes must contain at least one validation note')
        ));
        assert.equal(
            fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-findings-disposition.json`)),
            false
        );
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        assert.equal(fs.existsSync(outputPath), true, 'rejected reviewer output must remain available as audit evidence');
        assert.equal(fs.existsSync(fixture.launchArtifactPath), false);
        const preservedLaunchArtifact = JSON.parse(fs.readFileSync(explicitLaunchArtifactPath, 'utf8'));
        assert.equal(preservedLaunchArtifact.attestation_state, 'launched');
        assert.equal(preservedLaunchArtifact.launch_failure_stage, undefined);
        assert.equal(
            createHash('sha256').update(fs.readFileSync(explicitLaunchArtifactPath)).digest('hex'),
            completedLaunchArtifactSha256
        );
        const correctionArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        );
        const correctionArtifact = JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')) as {
            state: string;
            recovery: {
                correction_attempt: number;
                selected_transport: string;
                available_transports: string[];
            };
            binding: {
                reviewer_attempt_id: string;
                validation_artifact_path: string;
                validation_artifact_sha256: string;
                original_output_path: string;
            };
            transport_binding: {
                session_availability: string;
                availability_attestation: {
                    evidence_type: string;
                } | null;
            };
        };
        assert.equal(correctionArtifact.state, 'REVIEW_OUTPUT_CORRECTION_REQUIRED');
        assert.equal(correctionArtifact.recovery.correction_attempt, 1);
        assert.equal(correctionArtifact.recovery.selected_transport, 'correction_only_invocation');
        assert.equal(correctionArtifact.recovery.available_transports.includes('live_reviewer_continuation'), false);
        assert.equal(correctionArtifact.recovery.available_transports.includes('correction_only_invocation'), true);
        assert.equal(correctionArtifact.transport_binding.session_availability, 'stateless');
        assert.equal(
            correctionArtifact.transport_binding.availability_attestation?.evidence_type,
            'fail_closed_no_provider_session_receipt'
        );
        assert.equal(correctionArtifact.binding.reviewer_attempt_id, 'explicit-path-rejected-attempt');
        const correctionLaunchArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction-launch.json`
        );
        const correctionLaunchArtifact = JSON.parse(fs.readFileSync(correctionLaunchArtifactPath, 'utf8')) as {
            artifact_type: string;
            state: string;
            correction_artifact_sha256: string;
        };
        assert.equal(correctionLaunchArtifact.artifact_type, 'review_output_correction_launch');
        assert.equal(correctionLaunchArtifact.state, 'prepared');
        assert.equal(
            correctionLaunchArtifact.correction_artifact_sha256,
            createHash('sha256').update(fs.readFileSync(correctionArtifactPath)).digest('hex')
        );
        const validationArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(validationArtifactPath))
            .digest('hex');
        assert.equal(
            correctionArtifact.binding.validation_artifact_path,
            validationArtifactPath
                .replace(/\.json$/u, `-${validationArtifactSha256}.json`)
                .replace(/\\/g, '/')
        );
        assert.equal(
            correctionArtifact.binding.validation_artifact_sha256,
            validationArtifactSha256
        );
        assert.equal(
            fs.readFileSync(correctionArtifact.binding.original_output_path, 'utf8'),
            invalidReviewOutput
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED').length,
            0
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION').length,
            1
        );

        const secondCorrection = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });
        assert.notEqual(secondCorrection.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')).recovery.correction_attempt,
            2
        );
        const exhaustedCorrection = await runCliWithCapturedOutput(recordArgs, { cwd: repoRoot });
        assert.notEqual(exhaustedCorrection.exitCode, 0);
        const exhaustedArtifact = JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')) as {
            state: string;
            recovery: { correction_attempt: number; selected_transport: string };
        };
        assert.equal(exhaustedArtifact.state, 'FULL_REVIEW_REQUIRED');
        assert.equal(exhaustedArtifact.recovery.correction_attempt, 3);
        assert.equal(exhaustedArtifact.recovery.selected_transport, 'full_reviewer_relaunch');
        const currentPreflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
        const failedReviewState = readReviewArtifactState(
            fixture.reviewsRoot,
            taskId,
            'code',
            fixture.preflightPath,
            createHash('sha256').update(fs.readFileSync(fixture.preflightPath)).digest('hex'),
            currentPreflight,
            repoRoot
        );
        assert.equal(failedReviewState.failureKind, 'review-correction-full-review-required');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result does not terminalize output rewritten after launch completion', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-post-completion-rewrite';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify({ schema_version: 1 }, null, 2)}\n`, 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'post-completion-rewrite-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true
        });
        const completedAttempt = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'REVIEWER_LAUNCH_COMPLETED'
                && String((event.details as Record<string, unknown> | undefined)?.reviewer_launch_attempt_id || '')
                    === 'post-completion-rewrite-attempt');
        assert.ok(completedAttempt);
        fs.writeFileSync(outputPath, `${JSON.stringify({ schema_version: 1, replaced: true }, null, 2)}\n`, 'utf8');
        const postCompletionMtime = new Date(Date.parse(String(
            (completedAttempt.details as Record<string, unknown> | undefined)?.launch_completed_at_utc || ''
        )) + 1_000);
        fs.utimesSync(outputPath, postCompletionMtime, postCompletionMtime);

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        assert.equal(
            fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-findings-validation.json`)),
            true
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result preserves the completed launch and requests correction when the first output is malformed JSON', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-malformed-first-output';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, '{ malformed reviewer output\n', 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'malformed-first-output-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true
        });

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        const validationArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-findings-validation.json`
        );
        const validationArtifact = JSON.parse(fs.readFileSync(validationArtifactPath, 'utf8')) as {
            validation_result: { accepted: boolean; detected: boolean; violations: string[] };
        };
        assert.equal(validationArtifact.validation_result.accepted, false);
        assert.equal(validationArtifact.validation_result.detected, false);
        assert.ok(validationArtifact.validation_result.violations.includes('review output must be a JSON object.'));
        const preservedLaunchArtifact = JSON.parse(
            fs.readFileSync(fixture.launchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        assert.equal(preservedLaunchArtifact.attestation_state, 'launched');
        assert.equal(preservedLaunchArtifact.launch_failure_stage, undefined);
        const correctionArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        );
        const correctionArtifact = JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')) as {
            state: string;
            recovery: { correction_attempt: number; selected_transport: string };
            binding: { original_output_path: string };
        };
        assert.equal(correctionArtifact.state, 'FULL_REVIEW_REQUIRED');
        assert.equal(correctionArtifact.recovery.correction_attempt, 1);
        assert.equal(correctionArtifact.recovery.selected_transport, 'full_reviewer_relaunch');
        assert.equal(fs.readFileSync(correctionArtifact.binding.original_output_path, 'utf8'), '{ malformed reviewer output\n');
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED').length,
            0
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED').length,
            1
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result ignores a prior correction package after a fresh full-review launch', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-fresh-full-review-after-correction';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, '{ malformed reviewer output\n', 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'rejected-output-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true
        });

        const rejectedResult = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });
        assert.notEqual(rejectedResult.exitCode, 0);

        const correctionArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        );
        const correctionBeforeFullReview = JSON.parse(
            fs.readFileSync(correctionArtifactPath, 'utf8')
        ) as { state: string; binding: { reviewer_attempt_id: string; validation_artifact_path: string } };
        assert.equal(correctionBeforeFullReview.state, 'FULL_REVIEW_REQUIRED');
        assert.equal(correctionBeforeFullReview.binding.reviewer_attempt_id, 'rejected-output-attempt');
        fs.appendFileSync(
            correctionBeforeFullReview.binding.validation_artifact_path,
            '\nvalidation snapshot superseded by a later full-review cycle',
            'utf8'
        );

        fs.writeFileSync(
            outputPath,
            `${JSON.stringify(buildNoFindingsJsonReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
            'utf8'
        );
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'fresh-full-review-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true
        });

        const acceptedResult = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.equal(
            acceptedResult.exitCode,
            0,
            [...acceptedResult.errors, ...acceptedResult.logs].join('\n')
        );
        const receipt = JSON.parse(fs.readFileSync(
            path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`),
            'utf8'
        )) as { reviewer_identity: string; review_findings_validation: { accepted: boolean } };
        assert.equal(receipt.reviewer_identity, fixture.reviewerIdentity);
        assert.equal(receipt.review_findings_validation.accepted, true);
        const correctionAfterFullReview = JSON.parse(
            fs.readFileSync(correctionArtifactPath, 'utf8')
        ) as { state: string };
        assert.equal(correctionAfterFullReview.state, 'FULL_REVIEW_REQUIRED');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result requests correction for a plain-text transport error even when it contains a legacy verdict token', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-54-result-plain-transport-error';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(
            outputPath,
            'Agent errored: stream disconnected before completion.\n\n## Verdict\nREVIEW PASSED\n',
            'utf8'
        );
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'plain-transport-error-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true
        });

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        const validationArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-findings-validation.json`
        );
        const validationArtifact = JSON.parse(fs.readFileSync(validationArtifactPath, 'utf8')) as {
            validation_result: { accepted: boolean; detected: boolean; violations: string[] };
        };
        assert.equal(validationArtifact.validation_result.accepted, false);
        assert.equal(validationArtifact.validation_result.detected, false);
        assert.ok(validationArtifact.validation_result.violations.includes('review output must be a JSON object.'));
        const preservedLaunchArtifact = JSON.parse(
            fs.readFileSync(fixture.launchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        assert.equal(preservedLaunchArtifact.attestation_state, 'launched');
        assert.equal(preservedLaunchArtifact.launch_failure_stage, undefined);
        const correctionArtifact = JSON.parse(fs.readFileSync(
            path.join(fixture.reviewsRoot, `${taskId}-code-output-correction.json`),
            'utf8'
        )) as { state: string; binding: { original_output_path: string } };
        assert.equal(correctionArtifact.state, 'FULL_REVIEW_REQUIRED');
        assert.equal(
            fs.readFileSync(correctionArtifact.binding.original_output_path, 'utf8'),
            'Agent errored: stream disconnected before completion.\n\n## Verdict\nREVIEW PASSED\n'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED').length,
            0
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED').length,
            1
        );
        assert.equal(
            fs.readFileSync(outputPath, 'utf8'),
            'Agent errored: stream disconnected before completion.\n\n## Verdict\nREVIEW PASSED\n'
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result accepts corrected findings without mutating the completed launch', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-corrected-findings-recovery';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const rejectedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        rejectedReport.unexpected = true;
        fs.writeFileSync(outputPath, `${JSON.stringify(rejectedReport, null, 2)}\n`, 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'corrected-findings-recovery-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true
        });
        const completedLaunchSha256 = createHash('sha256')
            .update(fs.readFileSync(fixture.launchArtifactPath))
            .digest('hex');
        const args = [
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];

        const rejected = await runCliWithCapturedOutput(args, { cwd: repoRoot });

        assert.notEqual(rejected.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        const preservedLaunchSha256 = createHash('sha256')
            .update(fs.readFileSync(fixture.launchArtifactPath))
            .digest('hex');
        assert.equal(preservedLaunchSha256, completedLaunchSha256);
        fs.writeFileSync(
            outputPath,
            `${JSON.stringify(buildNoFindingsJsonReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
            'utf8'
        );
        const correctionArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        );
        const correctionOnlyArtifact = JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')) as {
            recovery: { selected_transport: string; available_transports: string[] };
        };
        assert.equal(correctionOnlyArtifact.recovery.selected_transport, 'correction_only_invocation');
        assert.equal(
            correctionOnlyArtifact.recovery.available_transports.includes('live_reviewer_continuation'),
            false
        );
        const correctionLaunchInputSha256 = createHash('sha256')
            .update(fs.readFileSync(correctionArtifactPath))
            .digest('hex');
        const correctionProducerIdentity = 'agent:/root/corrected-findings-recovery';
        const correctionProviderInvocationId = '/root/corrected-findings-recovery';
        const correctionInvocation = await runCliWithCapturedOutput([
            'gate', 'record-review-output-correction-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--correction-artifact-path', correctionArtifactPath,
            '--correction-producer-identity', correctionProducerIdentity,
            '--provider-invocation-id', correctionProviderInvocationId,
            '--attestation-source', 'codex_collaboration_spawn_agent',
            '--launch-input-sha256', correctionLaunchInputSha256,
            '--fork-context', 'false',
            '--repo-root', repoRoot
        ], { cwd: repoRoot });
        assert.equal(correctionInvocation.exitCode, 0, correctionInvocation.errors.join('\n'));
        assert.match(correctionInvocation.logs.join('\n'), /REVIEW_OUTPUT_CORRECTION_DELEGATION_STARTED/u);
        const correctionProviderResponsePath = String(JSON.parse(fs.readFileSync(
            path.join(fixture.reviewsRoot, `${taskId}-code-output-correction-launch.json`),
            'utf8'
        )).provider_response_output_path || '');
        assert.ok(correctionProviderResponsePath);
        fs.writeFileSync(
            correctionProviderResponsePath,
            fs.readFileSync(outputPath, 'utf8'),
            'utf8'
        );
        const correctionInvocationCompleted = await runCliWithCapturedOutput([
            'gate', 'record-review-output-correction-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--correction-artifact-path', correctionArtifactPath,
            '--repo-root', repoRoot
        ], { cwd: repoRoot });
        assert.equal(
            correctionInvocationCompleted.exitCode,
            0,
            correctionInvocationCompleted.errors.join('\n')
        );
        const boundInvocationEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                && (event.details as Record<string, unknown> | undefined)?.invocation_role
                    === 'review_output_correction'
            ));
        assert.ok(boundInvocationEvent?.details);
        const boundInvocationEventSha256 = String(
            (boundInvocationEvent.integrity as Record<string, unknown> | undefined)?.event_sha256 || ''
        );
        assert.match(boundInvocationEventSha256, /^[0-9a-f]{64}$/u);
        const boundInvocationDetails = boundInvocationEvent.details as Record<string, unknown>;
        assert.equal(boundInvocationDetails.provider_invocation_id, correctionProviderInvocationId);
        const correctedArgs = [
            ...args,
            '--correction-producer-identity', correctionProducerIdentity,
            '--correction-provider-invocation-id', correctionProviderInvocationId,
            '--correction-provider-invocation-event-sha256', boundInvocationEventSha256,
            '--correction-attestation-source', 'codex_collaboration_spawn_agent',
            '--correction-launch-input-sha256', correctionLaunchInputSha256,
            '--correction-fork-context', 'false'
        ];
        const receiptPath = path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`);
        fs.mkdirSync(receiptPath);

        const persistenceFailure = await runCliWithCapturedOutput(correctedArgs, { cwd: repoRoot });

        assert.notEqual(persistenceFailure.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        assert.equal(
            createHash('sha256').update(fs.readFileSync(fixture.launchArtifactPath)).digest('hex'),
            preservedLaunchSha256
        );
        assert.equal(
            JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')).state,
            'REVIEW_OUTPUT_CORRECTION_REQUIRED'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_ACCEPTED').length,
            0
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED').length,
            1
        );
        fs.rmSync(receiptPath, { recursive: true, force: true });

        const lifecycleEventEmitters = loadLifecycleEventEmittersModule();
        const originalEmitCorrectionAccepted =
            lifecycleEventEmitters.emitReviewOutputCorrectionAcceptedEventAsync;
        let acceptanceTelemetryFailure: Awaited<ReturnType<typeof runCliWithCapturedOutput>>;
        try {
            lifecycleEventEmitters.emitReviewOutputCorrectionAcceptedEventAsync = async () => null;
            acceptanceTelemetryFailure = await runCliWithCapturedOutput(correctedArgs, { cwd: repoRoot });
        } finally {
            lifecycleEventEmitters.emitReviewOutputCorrectionAcceptedEventAsync =
                originalEmitCorrectionAccepted;
        }
        assert.notEqual(acceptanceTelemetryFailure.exitCode, 0);
        assert.match(
            acceptanceTelemetryFailure.errors.join('\n'),
            /correction acceptance telemetry failed/iu
        );
        assert.equal(
            JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')).state,
            'REVIEW_OUTPUT_CORRECTION_REQUIRED'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_ACCEPTED').length,
            0
        );

        const corrected = await runCliWithCapturedOutput(correctedArgs, { cwd: repoRoot });

        assert.equal(corrected.exitCode, 0, corrected.errors.join('\n'));
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        assert.equal(
            createHash('sha256').update(fs.readFileSync(fixture.launchArtifactPath)).digest('hex'),
            completedLaunchSha256
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED').length,
            0
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_ACCEPTED').length,
            1
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED').length,
            1
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_RECORDED').length,
            1
        );
        const correctionRead = readReviewOutputCorrectionArtifact(correctionArtifactPath);
        assert.deepEqual(correctionRead.violations, []);
        assert.equal(correctionRead.artifact?.state, 'CORRECTION_ACCEPTED');
        const correctionTimeline = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => [
                'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
                'REVIEW_OUTPUT_CORRECTION_ACCEPTED',
                'REVIEW_RECORDED'
            ].includes(String(event.event_type || '')));
        assert.deepEqual(
            correctionTimeline.map((event) => event.event_type),
            [
                'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
                'REVIEW_OUTPUT_CORRECTION_ACCEPTED',
                'REVIEW_RECORDED'
            ]
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result atomically authenticates a live correction response', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-authenticated-live-correction';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const rejectedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        rejectedReport.unexpected = true;
        fs.writeFileSync(outputPath, `${JSON.stringify(rejectedReport, null, 2)}\n`, 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'authenticated-live-correction-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true,
            provider: 'Codex'
        });
        const baseArgs = [
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];
        const rejected = await runCliWithCapturedOutput(baseArgs, { cwd: repoRoot });
        assert.notEqual(rejected.exitCode, 0);

        const correctionArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        );
        const pendingCorrection = readReviewOutputCorrectionArtifact(correctionArtifactPath).artifact!;
        const originalInvocationEventSha256 = pendingCorrection.binding.reviewer_invocation_event_sha256!;
        const originalInvocation = readTaskTimelineEvents(repoRoot, taskId).find((event) => (
            event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && String(
                (event.integrity as Record<string, unknown> | undefined)?.event_sha256 || ''
            ) === originalInvocationEventSha256
        ));
        const originalInvocationDetails = originalInvocation?.details as Record<string, unknown>;
        const originalProviderInvocationId = String(originalInvocationDetails.provider_invocation_id || '');
        const originalAttestationSource = String(
            originalInvocationDetails.reviewer_launch_attestation_source
            || originalInvocationDetails.attestation_source
            || ''
        );
        const correctionInputSha256 = fileSha256(correctionArtifactPath)!;
        fs.writeFileSync(
            outputPath,
            `${JSON.stringify(buildNoFindingsJsonReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
            'utf8'
        );
        const correctedOutputSha256 = fileSha256(outputPath);
        const correctedArgs = [
            ...baseArgs,
            '--correction-producer-identity', fixture.reviewerIdentity,
            '--correction-provider-invocation-id', originalProviderInvocationId,
            '--correction-provider-invocation-event-sha256', originalInvocationEventSha256,
            '--correction-attestation-source', originalAttestationSource,
            '--correction-launch-input-sha256', correctionInputSha256
        ];
        const outsideResponseRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'garda-live-response-outside-')
        );
        const outsideResponsePath = path.join(outsideResponseRoot, 'review-output.md');
        fs.writeFileSync(
            outsideResponsePath,
            `${JSON.stringify(buildNoFindingsJsonReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
            'utf8'
        );
        const linkedResponseRoot = path.join(path.dirname(outputPath), 'linked-response-root');
        fs.symlinkSync(
            outsideResponseRoot,
            linkedResponseRoot,
            process.platform === 'win32' ? 'junction' : 'dir'
        );
        const escapedResponseAttestation = await runCliWithCapturedOutput([
            'gate', 'record-review-output-correction-response',
            '--task-id', taskId,
            '--review-type', 'code',
            '--correction-artifact-path', correctionArtifactPath,
            '--review-output-path', path.join(linkedResponseRoot, 'review-output.md'),
            '--reviewer-identity', fixture.reviewerIdentity,
            '--provider-invocation-id', originalProviderInvocationId,
            '--attestation-source', originalAttestationSource,
            '--repo-root', repoRoot
        ], { cwd: repoRoot });
        assert.notEqual(escapedResponseAttestation.exitCode, 0);
        assert.match(
            escapedResponseAttestation.errors.join('\n'),
            /symlink|junction|task-owned/iu
        );
        fs.unlinkSync(linkedResponseRoot);
        const responseAttestation = await runCliWithCapturedOutput([
            'gate', 'record-review-output-correction-response',
            '--task-id', taskId,
            '--review-type', 'code',
            '--correction-artifact-path', correctionArtifactPath,
            '--review-output-path', outputPath,
            '--reviewer-identity', fixture.reviewerIdentity,
            '--provider-invocation-id', originalProviderInvocationId,
            '--attestation-source', originalAttestationSource,
            '--repo-root', repoRoot
        ], { cwd: repoRoot });
        assert.equal(responseAttestation.exitCode, 0, responseAttestation.errors.join('\n'));

        const corrected = await runCliWithCapturedOutput(correctedArgs, { cwd: repoRoot });

        assert.equal(corrected.exitCode, 0, corrected.errors.join('\n'));
        const accepted = readReviewOutputCorrectionArtifact(correctionArtifactPath);
        assert.deepEqual(accepted.violations, []);
        assert.equal(accepted.artifact?.state, 'CORRECTION_ACCEPTED');
        assert.equal(accepted.artifact?.transport_binding?.session_availability, 'available');
        assert.equal(
            accepted.artifact?.transport_binding?.availability_attestation
                ?.provider_invocation_event_sha256,
            originalInvocationEventSha256
        );
        assert.equal(
            accepted.artifact?.transport_binding?.availability_attestation?.provider_response_sha256,
            correctedOutputSha256
        );
        const liveEvents = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
            event.event_type === 'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION'
        ));
        assert.equal(liveEvents.length, 1);
        assert.equal(
            accepted.artifact?.transport_binding?.availability_attestation
                ?.provider_response_event_sha256,
            (liveEvents[0]?.integrity as Record<string, unknown>).event_sha256
        );
        assert.equal(
            (liveEvents[0]?.details as Record<string, unknown>)
                .availability_provider_invocation_event_sha256,
            originalInvocationEventSha256
        );
        fs.rmSync(outsideResponseRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    for (const attestationSource of [
        'multi_agent_v1',
        'multi_agent_v1.spawn_agent',
        'collaboration.spawn_agent'
    ])
    it(`routes ${attestationSource} Codex corrections through a clean correction-only reviewer`, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-multi-agent-correction-only';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const rejectedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        rejectedReport.unexpected = true;
        fs.writeFileSync(outputPath, `${JSON.stringify(rejectedReport, null, 2)}\n`, 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'multi-agent-correction-only-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true,
            provider: 'Codex',
            attestationSource
        });

        const rejected = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(rejected.exitCode, 0);
        const correctionArtifact = readReviewOutputCorrectionArtifact(path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        )).artifact!;
        assert.equal(correctionArtifact.recovery.selected_transport, 'correction_only_invocation');
        assert.equal(
            correctionArtifact.recovery.available_transports.includes('live_reviewer_continuation'),
            false
        );
        assert.equal(correctionArtifact.recovery.handoff?.provider_action, 'launch_correction_only_reviewer');
        assert.equal(correctionArtifact.transport_binding?.session_availability, 'stateless');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects caller-asserted Codex availability before correction-only fallback', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-live-codex-correction';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const rejectedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        rejectedReport.unexpected = true;
        fs.writeFileSync(outputPath, `${JSON.stringify(rejectedReport, null, 2)}\n`, 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'live-codex-correction-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true,
            provider: 'Codex'
        });

        const recordResultArgs = [
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];
        const rejected = await runCliWithCapturedOutput(recordResultArgs, { cwd: repoRoot });

        assert.notEqual(rejected.exitCode, 0);
        const correctionArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        );
        const correctionArtifact = JSON.parse(fs.readFileSync(
            correctionArtifactPath,
            'utf8'
        )) as {
            transport_binding: {
                provider_invocation_id: string;
                session_availability: string;
            };
            recovery: {
                selected_transport: string;
                available_transports: string[];
                handoff: { provider_action: string; target_reviewer_identity: string };
            };
        };
        assert.equal(correctionArtifact.recovery.selected_transport, 'live_reviewer_continuation');
        assert.equal(
            correctionArtifact.recovery.available_transports.includes('live_reviewer_continuation'),
            true
        );
        assert.equal(correctionArtifact.recovery.handoff.provider_action, 'continue_delegated_reviewer');
        assert.equal(correctionArtifact.recovery.handoff.target_reviewer_identity, fixture.reviewerIdentity);
        assert.equal(correctionArtifact.transport_binding.session_availability, 'pending');
        assert.deepEqual(
            readReviewOutputCorrectionArtifact(correctionArtifactPath).violations,
            [],
            fs.readFileSync(correctionArtifactPath, 'utf8')
        );
        assert.equal(fs.existsSync(
            path.join(fixture.reviewsRoot, `${taskId}-code-output-correction-launch.json`)
        ), false);

        const buildTransportArgs = (
            sessionAvailability: string,
            attestationSource?: string
        ) => [
            'gate', 'record-review-output-correction-transport',
            '--task-id', taskId,
            '--review-type', 'code',
            '--correction-artifact-path', correctionArtifactPath,
            '--session-availability', sessionAvailability,
            '--reviewer-identity', fixture.reviewerIdentity,
            '--provider-invocation-id', correctionArtifact.transport_binding.provider_invocation_id,
            ...(attestationSource ? ['--attestation-source', attestationSource] : []),
            '--repo-root', repoRoot
        ];
        const transportArgs = buildTransportArgs('closed');
        const forgedLive = await runCliWithCapturedOutput(
            buildTransportArgs('available'),
            { cwd: repoRoot }
        );
        assert.notEqual(forgedLive.exitCode, 0);
        assert.match(
            forgedLive.errors.join('\n'),
            /requires fail-closed --session-availability 'closed' or 'stateless'/iu
        );
        assert.equal(
            readReviewOutputCorrectionArtifact(correctionArtifactPath).artifact
                ?.transport_binding?.session_availability,
            'pending'
        );
        const pendingArtifactText = fs.readFileSync(correctionArtifactPath, 'utf8');
        const timelinePath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'task-events',
            `${taskId}.jsonl`
        );
        const pendingTimelineText = fs.readFileSync(timelinePath, 'utf8');
        const labeledLive = await runCliWithCapturedOutput(
            buildTransportArgs('available', 'codex_collaboration_followup_task'),
            { cwd: repoRoot }
        );
        assert.notEqual(labeledLive.exitCode, 0);
        assert.match(
            labeledLive.errors.join('\n'),
            /Live continuation is frozen only with an authenticated corrected response/iu
        );
        assert.equal(fs.readFileSync(correctionArtifactPath, 'utf8'), pendingArtifactText);
        assert.equal(fs.readFileSync(timelinePath, 'utf8'), pendingTimelineText);
        const sharedTransportLockPath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            '.record-review-output-correction-transport.lock'
        );
        fs.mkdirSync(sharedTransportLockPath, { recursive: true });
        fs.writeFileSync(
            path.join(sharedTransportLockPath, 'owner.json'),
            `${JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                created_at_utc: new Date().toISOString(),
                owner_label: `record-review-output-correction-transport:${taskId}:code`
            }, null, 2)}\n`,
            'utf8'
        );
        const blockedResult = await runCliWithCapturedOutput(recordResultArgs, { cwd: repoRoot });
        assert.notEqual(blockedResult.exitCode, 0);
        assert.match(
            blockedResult.errors.join('\n'),
            /timed out acquiring file lock: .*\.record-review-output-correction-transport\.lock/iu
        );
        assert.equal(fs.readFileSync(correctionArtifactPath, 'utf8'), pendingArtifactText);
        assert.equal(fs.readFileSync(timelinePath, 'utf8'), pendingTimelineText);
        fs.rmSync(sharedTransportLockPath, { recursive: true, force: true });
        const selected = await runCliWithCapturedOutput(transportArgs, { cwd: repoRoot });
        assert.equal(selected.exitCode, 0, selected.errors.join('\n'));
        assert.deepEqual(readReviewOutputCorrectionArtifact(correctionArtifactPath).violations, []);
        const fallbackArtifact = JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')) as {
            transport_binding: { session_availability: string };
            recovery: { selected_transport: string; handoff: { provider_action: string } };
        };
        assert.equal(fallbackArtifact.transport_binding.session_availability, 'closed');
        assert.equal(fallbackArtifact.recovery.selected_transport, 'correction_only_invocation');
        assert.equal(fallbackArtifact.recovery.handoff.provider_action, 'launch_correction_only_reviewer');
        assert.equal(fs.existsSync(
            path.join(fixture.reviewsRoot, `${taskId}-code-output-correction-launch.json`)
        ), true);
        const eventsAfterSelection = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(eventsAfterSelection.at(-1)?.event_type, 'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION');
        fs.writeFileSync(
            timelinePath,
            `${eventsAfterSelection.slice(0, -1).map((event) => JSON.stringify(event)).join('\n')}\n`,
            'utf8'
        );

        const recovered = await runCliWithCapturedOutput(transportArgs, { cwd: repoRoot });
        assert.equal(recovered.exitCode, 0, recovered.errors.join('\n'));
        assert.equal(
            recovered.logs.some((line) => line.includes('REVIEW_OUTPUT_CORRECTION_TRANSPORT_RECOVERED')),
            true
        );
        const recoveredEvents = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
            event.event_type === 'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION'
        ));
        assert.equal(recoveredEvents.length, 1);
        const recoveredDetails = recoveredEvents[0]?.details as Record<string, unknown> | undefined;
        assert.equal(
            typeof recoveredDetails?.previous_correction_package_sha256,
            'string'
        );

        const repeated = await runCliWithCapturedOutput(transportArgs, { cwd: repoRoot });
        assert.equal(repeated.exitCode, 0, repeated.errors.join('\n'));
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
            event.event_type === 'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION'
        )).length, 1);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-output-correction-invocation attests a correction-only reviewer once', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-correction-only-invocation-attestation';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const originalInvocation = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        assert.ok(originalInvocation?.details);
        const originalInvocationSha256 = String(
            (originalInvocation.integrity as Record<string, unknown> | undefined)?.event_sha256 || ''
        );
        assert.match(originalInvocationSha256, /^[0-9a-f]{64}$/u);
        const originalInvocationDetails = originalInvocation.details as Record<string, unknown>;
        const originalReviewerAttemptId = String(
            originalInvocationDetails.reviewer_launch_attempt_id
            || originalInvocationDetails.provider_invocation_id
            || originalInvocationSha256
        );
        const originalRejectedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        originalRejectedReport.unexpected = 'original-rejected-output';
        const rawOutput = `${JSON.stringify(originalRejectedReport, null, 2)}\n`;
        const invalidCorrectionReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        invalidCorrectionReport.unexpected = 'first-correction-output';
        const invalidCorrectionOutput = `${JSON.stringify(invalidCorrectionReport, null, 2)}\n`;
        const rejectedOutputPath = path.join(fixture.reviewsRoot, `${taskId}-code-rejected-placeholder.md`);
        const validationArtifactContent = '{}\n';
        const validationArtifactSha256 = createHash('sha256')
            .update(validationArtifactContent)
            .digest('hex');
        const validationArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-findings-validation-${validationArtifactSha256}.json`
        );
        fs.writeFileSync(rejectedOutputPath, rawOutput, 'utf8');
        fs.writeFileSync(validationArtifactPath, validationArtifactContent, 'utf8');
        const reviewContext = JSON.parse(
            fs.readFileSync(fixture.reviewContextPath, 'utf8')
        ) as Record<string, unknown>;
        const reviewArtifactPath = path.join(fixture.reviewsRoot, `${taskId}-code.md`);
        const correctionArtifact = buildReviewOutputCorrectionArtifact({
            taskId,
            reviewType: 'code',
            rejectedOutputPath,
            rejectedOutputSha256: createHash('sha256').update(rawOutput).digest('hex'),
            rejectedOutputContent: rawOutput,
            reviewContextPath: fixture.reviewContextPath,
            reviewContextSha256: createHash('sha256')
                .update(fs.readFileSync(fixture.reviewContextPath))
                .digest('hex'),
            reviewTreeStateSha256: String(
                (reviewContext.tree_state as Record<string, unknown>).tree_state_sha256 || ''
            ),
            reviewerIdentity: fixture.reviewerIdentity,
            reviewerAttemptId: originalReviewerAttemptId,
            reviewerInvocationEventSha256: originalInvocationSha256,
            validationArtifactPath,
            validationArtifactSha256,
            violations: ['findings.high[0].description is required.'],
            capabilities: {
                live_reviewer_continuation: false,
                api_conversation_continuation: false,
                correction_only_invocation: true
            }
        });
        const persisted = persistReviewOutputCorrection({
            repoRoot,
            reviewArtifactPath,
            rawOutput,
            artifact: correctionArtifact
        });
        const correctionInputSha256 = createHash('sha256')
            .update(fs.readFileSync(persisted.artifactPath))
            .digest('hex');
        const args = [
            'gate', 'record-review-output-correction-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--correction-artifact-path', persisted.artifactPath,
            '--correction-producer-identity', 'agent:/root/correction-only-reviewer',
            '--provider-invocation-id', '/root/correction-only-reviewer',
            '--attestation-source', 'codex_collaboration_spawn_agent',
            '--launch-input-sha256', correctionInputSha256,
            '--fork-context', 'false',
            '--repo-root', repoRoot
        ];

        const started = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.equal(started.exitCode, 0, started.errors.join('\n'));
        assert.match(started.logs.join('\n'), /REVIEW_OUTPUT_CORRECTION_DELEGATION_STARTED/u);
        const startedTimeline = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(startedTimeline.filter((event) => (
            event.event_type === 'REVIEWER_DELEGATION_STARTED'
            && (event.details as Record<string, unknown> | undefined)?.invocation_role
                === 'review_output_correction'
        )).length, 1);
        assert.equal(startedTimeline.filter((event) => (
            event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && (event.details as Record<string, unknown> | undefined)?.invocation_role
                === 'review_output_correction'
        )).length, 0);
        assert.equal(startedTimeline.filter((event) => (
            event.event_type === 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED'
        )).length, 0);
        const startedCorrectionLaunchArtifact = JSON.parse(fs.readFileSync(
            persisted.correctionLaunchArtifactPath!,
            'utf8'
        )) as { provider_response_output_path: string };
        fs.writeFileSync(
            startedCorrectionLaunchArtifact.provider_response_output_path,
            invalidCorrectionOutput,
            'utf8'
        );

        const rejectedResupply = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.notEqual(rejectedResupply.exitCode, 0);
        assert.match(
            rejectedResupply.errors.join('\n'),
            /completion consumes the frozen provider delegation receipt/iu
        );
        const completionArgs = [
            'gate', 'record-review-output-correction-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--correction-artifact-path', persisted.artifactPath,
            '--repo-root', repoRoot
        ];
        const completed = await runCliWithCapturedOutput(completionArgs, { cwd: repoRoot });
        assert.equal(completed.exitCode, 0, completed.errors.join('\n'));
        assert.match(completed.logs.join('\n'), /REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED/u);
        const repeated = await runCliWithCapturedOutput(completionArgs, { cwd: repoRoot });

        assert.equal(repeated.exitCode, 0, repeated.errors.join('\n'));
        const correctionDelegations = readTaskTimelineEvents(repoRoot, taskId).filter((event) => {
            const details = event.details as Record<string, unknown> | undefined;
            return event.event_type === 'REVIEWER_DELEGATION_STARTED'
                && details?.invocation_role === 'review_output_correction';
        });
        const correctionInvocations = readTaskTimelineEvents(repoRoot, taskId).filter((event) => {
            const details = event.details as Record<string, unknown> | undefined;
            return event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                && details?.invocation_role === 'review_output_correction';
        });
        const correctionInvocationTelemetry = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
            event.event_type === 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED'
        ));
        assert.equal(correctionDelegations.length, 1);
        assert.equal(correctionInvocations.length, 1);
        assert.equal(correctionInvocationTelemetry.length, 1);
        assert.equal(
            (correctionInvocationTelemetry[0]?.details as Record<string, unknown>).state,
            'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED'
        );
        assert.equal(
            (correctionInvocations[0]?.details as Record<string, unknown>).launch_input_sha256,
            correctionInputSha256
        );
        assert.equal(
            (correctionInvocations[0]?.details as Record<string, unknown>)
                .correction_delegation_started_event_sha256,
            (correctionDelegations[0]?.integrity as Record<string, unknown>).event_sha256
        );
        const pendingCorrectionRead = readReviewOutputCorrectionArtifact(persisted.artifactPath);
        assert.deepEqual(pendingCorrectionRead.violations, []);
        assert.equal(
            pendingCorrectionRead.artifact?.binding.reviewer_attempt_id,
            originalReviewerAttemptId
        );
        const completedCorrectionLaunchArtifact = JSON.parse(fs.readFileSync(
            persisted.correctionLaunchArtifactPath!,
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(completedCorrectionLaunchArtifact.state, 'delegation_started');
        assert.equal(
            completedCorrectionLaunchArtifact.correction_producer_identity,
            'agent:/root/correction-only-reviewer'
        );
        const rejectedCorrection = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', startedCorrectionLaunchArtifact.provider_response_output_path,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--correction-producer-identity', 'agent:/root/correction-only-reviewer',
            '--correction-provider-invocation-id', '/root/correction-only-reviewer',
            '--correction-provider-invocation-event-sha256', String(
                (correctionInvocationTelemetry[0]?.details as Record<string, unknown>)
                    .provider_invocation_event_sha256 || ''
            ),
            '--correction-attestation-source', 'codex_collaboration_spawn_agent',
            '--correction-launch-input-sha256', correctionInputSha256,
            '--correction-fork-context', 'false',
            '--repo-root', repoRoot
        ], { cwd: repoRoot });
        assert.notEqual(rejectedCorrection.exitCode, 0);
        const retriedCorrection = JSON.parse(fs.readFileSync(persisted.artifactPath, 'utf8')) as {
            state: string;
            recovery: { correction_attempt: number; selected_transport: string };
        };
        assert.equal(
            retriedCorrection.recovery.correction_attempt,
            2,
            rejectedCorrection.errors.join('\n')
        );
        assert.equal(retriedCorrection.state, 'REVIEW_OUTPUT_CORRECTION_REQUIRED');
        assert.equal(retriedCorrection.recovery.selected_transport, 'correction_only_invocation');
        const correctionLaunchArtifact = JSON.parse(fs.readFileSync(
            persisted.correctionLaunchArtifactPath!,
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(correctionLaunchArtifact.state, 'prepared');
        assert.equal(correctionLaunchArtifact.correction_producer_identity, undefined);

        const secondCorrectionInputSha256 = fileSha256(persisted.artifactPath)!;
        const secondProducerIdentity = 'agent:/root/correction-only-reviewer-2';
        const secondProviderInvocationId = '/root/correction-only-reviewer-2';
        const secondInvocationArgs = [
            'gate', 'record-review-output-correction-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--correction-artifact-path', persisted.artifactPath,
            '--correction-producer-identity', secondProducerIdentity,
            '--provider-invocation-id', secondProviderInvocationId,
            '--attestation-source', 'codex_collaboration_spawn_agent',
            '--launch-input-sha256', secondCorrectionInputSha256,
            '--fork-context', 'false',
            '--repo-root', repoRoot
        ];
        const secondStarted = await runCliWithCapturedOutput(secondInvocationArgs, { cwd: repoRoot });
        assert.equal(secondStarted.exitCode, 0, secondStarted.errors.join('\n'));
        const secondLaunchArtifact = JSON.parse(fs.readFileSync(
            persisted.correctionLaunchArtifactPath!,
            'utf8'
        )) as { provider_response_output_path: string };
        assert.match(secondLaunchArtifact.provider_response_output_path, /\.attempt-2\.provider-response\.json$/u);
        fs.writeFileSync(secondLaunchArtifact.provider_response_output_path, rawOutput, 'utf8');

        const secondCompleted = await runCliWithCapturedOutput(completionArgs, { cwd: repoRoot });
        assert.equal(secondCompleted.exitCode, 0, secondCompleted.errors.join('\n'));
        const secondInvocationTelemetry = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => {
                const details = event.details as Record<string, unknown> | undefined;
                return event.event_type === 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED'
                    && details?.reviewer_identity === secondProducerIdentity;
            });
        assert.ok(secondInvocationTelemetry?.details);
        const secondInvocationDetails = secondInvocationTelemetry.details as Record<string, unknown>;
        const exhaustedCorrection = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', secondLaunchArtifact.provider_response_output_path,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--correction-producer-identity', secondProducerIdentity,
            '--correction-provider-invocation-id', secondProviderInvocationId,
            '--correction-provider-invocation-event-sha256', String(
                secondInvocationDetails.provider_invocation_event_sha256 || ''
            ),
            '--correction-attestation-source', 'codex_collaboration_spawn_agent',
            '--correction-launch-input-sha256', secondCorrectionInputSha256,
            '--correction-fork-context', 'false',
            '--repo-root', repoRoot
        ], { cwd: repoRoot });
        assert.notEqual(exhaustedCorrection.exitCode, 0);
        const exhaustedArtifact = JSON.parse(fs.readFileSync(persisted.artifactPath, 'utf8')) as {
            state: string;
            recovery: { correction_attempt: number; selected_transport: string };
        };
        assert.equal(exhaustedArtifact.recovery.correction_attempt, 3);
        assert.equal(exhaustedArtifact.state, 'FULL_REVIEW_REQUIRED');
        assert.equal(exhaustedArtifact.recovery.selected_transport, 'full_reviewer_relaunch');
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => (
            event.event_type === 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED'
        )), true);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects an invalid correction before it can replace the findings baseline', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-invalid-correction-findings-substitution';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const rejectedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        rejectedReport.unexpected = true;
        const rejectedOutput = `${JSON.stringify(rejectedReport, null, 2)}\n`;
        fs.writeFileSync(outputPath, rejectedOutput, 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'invalid-correction-substitution-attempt',
            reviewOutputPath: outputPath,
            recordCompletion: true
        });
        const baseArgs = [
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];
        const rejected = await runCliWithCapturedOutput(baseArgs, { cwd: repoRoot });
        assert.notEqual(rejected.exitCode, 0);
        const correctionArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        );
        const before = JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')) as {
            binding: { findings_semantic_fingerprint: string; original_output_path: string };
        };
        const boundInvocationEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                && String(
                    (event.details as Record<string, unknown> | undefined)?.reviewer_launch_attempt_id || ''
                ) === 'invalid-correction-substitution-attempt'
            ));
        assert.ok(boundInvocationEvent?.details);
        const boundInvocationDetails = boundInvocationEvent.details as Record<string, unknown>;
        const boundInvocationEventSha256 = String(
            (boundInvocationEvent.integrity as Record<string, unknown> | undefined)?.event_sha256 || ''
        );
        const changedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        changedReport.unexpected = true;
        const changedFindings = changedReport.findings as Record<string, unknown[]>;
        changedFindings.high.push({
            id: 'F-001',
            title: 'Substituted finding',
            description: 'This semantic finding was not present in the original rejected output.',
            evidence: [{ location: 'src/app.ts:1', observation: 'Substitution regression evidence.' }],
            coverage_obligation_ids: ['FILE-001']
        });
        fs.writeFileSync(outputPath, `${JSON.stringify(changedReport, null, 2)}\n`, 'utf8');

        const changed = await runCliWithCapturedOutput([
            ...baseArgs,
            '--correction-producer-identity', fixture.reviewerIdentity,
            '--correction-provider-invocation-id', String(boundInvocationDetails.provider_invocation_id || ''),
            '--correction-provider-invocation-event-sha256', boundInvocationEventSha256,
            '--correction-attestation-source', 'codex_collaboration_followup_task',
            '--correction-launch-input-sha256', createHash('sha256')
                .update(fs.readFileSync(correctionArtifactPath))
                .digest('hex')
        ], { cwd: repoRoot });

        assert.notEqual(changed.exitCode, 0);
        assert.ok(
            changed.errors.some((line) => line.includes('semantic findings fingerprint')),
            changed.errors.join('\n')
        );
        const after = JSON.parse(fs.readFileSync(correctionArtifactPath, 'utf8')) as {
            state: string;
            binding: { findings_semantic_fingerprint: string; original_output_path: string };
        };
        assert.equal(after.state, 'FULL_REVIEW_REQUIRED');
        assert.equal(after.binding.findings_semantic_fingerprint, before.binding.findings_semantic_fingerprint);
        assert.equal(fs.readFileSync(after.binding.original_output_path, 'utf8'), rejectedOutput);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result persists a correction package for rejected stdin findings output', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-stdin-rejected-correction';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const boundOutputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(boundOutputPath), { recursive: true });
        const rejectedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        rejectedReport.unexpected = true;
        const rejectedOutput = `${JSON.stringify(rejectedReport, null, 2)}\n`;
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'stdin-rejected-attempt',
            reviewOutputPath: boundOutputPath,
            recordCompletion: true
        });

        const mutableHandlers = gateReviewHandlers as { readReviewOutputFromStdin: () => Promise<string> };
        const originalReadReviewOutputFromStdin = mutableHandlers.readReviewOutputFromStdin;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        mutableHandlers.readReviewOutputFromStdin = async () => rejectedOutput;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            assert.notEqual(process.exitCode ?? 0, 0);
        } finally {
            mutableHandlers.readReviewOutputFromStdin = originalReadReviewOutputFromStdin;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const correctionArtifact = JSON.parse(fs.readFileSync(
            path.join(fixture.reviewsRoot, `${taskId}-code-output-correction.json`),
            'utf8'
        )) as { state: string; binding: { original_output_path: string } };
        assert.equal(correctionArtifact.state, 'REVIEW_OUTPUT_CORRECTION_REQUIRED');
        assert.equal(fs.readFileSync(correctionArtifact.binding.original_output_path, 'utf8'), rejectedOutput);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result requires a full review when correction provider provenance changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-result-correction-attempt-mismatch';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'review-output.md'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const rejectedReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        rejectedReport.unexpected = true;
        fs.writeFileSync(outputPath, `${JSON.stringify(rejectedReport, null, 2)}\n`, 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'correction-attempt-1',
            reviewOutputPath: outputPath,
            recordCompletion: true
        });
        const args = [
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];

        const rejected = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.notEqual(rejected.exitCode, 0);
        fs.writeFileSync(
            outputPath,
            `${JSON.stringify(buildNoFindingsJsonReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
            'utf8'
        );
        const correctionArtifactPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-output-correction.json`
        );
        const boundInvocationEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                && String(
                    (event.details as Record<string, unknown> | undefined)?.reviewer_launch_attempt_id || ''
                ) === 'correction-attempt-1'
            ));
        assert.ok(boundInvocationEvent);
        const boundInvocationEventSha256 = String(
            (boundInvocationEvent.integrity as Record<string, unknown> | undefined)?.event_sha256 || ''
        );
        assert.match(boundInvocationEventSha256, /^[0-9a-f]{64}$/u);
        const mismatchedAttempt = await runCliWithCapturedOutput([
            ...args,
            '--correction-producer-identity', fixture.reviewerIdentity,
            '--correction-provider-invocation-id', 'forged-correction-invocation',
            '--correction-provider-invocation-event-sha256', boundInvocationEventSha256,
            '--correction-attestation-source', 'codex_collaboration_followup_task',
            '--correction-launch-input-sha256', createHash('sha256')
                .update(fs.readFileSync(correctionArtifactPath))
                .digest('hex')
        ], { cwd: repoRoot });

        assert.notEqual(mismatchedAttempt.exitCode, 0);
        assert.ok(
            mismatchedAttempt.errors.some((line) => line.includes('provider invocation id does not match')),
            mismatchedAttempt.errors.join('\n')
        );
        const correctionArtifact = JSON.parse(fs.readFileSync(
            correctionArtifactPath,
            'utf8'
        )) as { state: string; recovery: { selected_transport: string } };
        assert.equal(correctionArtifact.state, 'FULL_REVIEW_REQUIRED');
        assert.equal(correctionArtifact.recovery.selected_transport, 'full_reviewer_relaunch');
        const fullReviewRequiredEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED');
        assert.ok(fullReviewRequiredEvent?.details);
        assert.equal(
            String((fullReviewRequiredEvent.details as Record<string, unknown>).correction_package_sha256 || ''),
            fileSha256(correctionArtifactPath)
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_RECORDED').length,
            0
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt preserves launch provenance and requests correction for rejected canonical findings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-7-receipt-json-invalid-validation-artifact';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const artifactPath = path.join(fixture.reviewsRoot, `${taskId}-code.md`);
        const invalidReport = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        invalidReport.validation_notes = [];
        fs.writeFileSync(artifactPath, `${JSON.stringify(invalidReport, null, 2)}\n`, 'utf8');
        rebindCompletedLaunchAttemptForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextPath: fixture.reviewContextPath,
            launchArtifactPath: fixture.launchArtifactPath,
            reviewerLaunchAttemptId: 'receipt-rejected-attempt',
            reviewOutputPath: artifactPath,
            recordCompletion: true
        });
        const completedLaunchArtifact = JSON.parse(
            fs.readFileSync(fixture.launchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        // Model the one-millisecond inversion caused by filesystem mtime and ISO timestamp rounding.
        const roundedOutputMtime = new Date(
            Date.parse(String(completedLaunchArtifact.launch_completed_at_utc || '')) + 1
        );
        fs.utimesSync(artifactPath, roundedOutputMtime, roundedOutputMtime);
        const receiptArgs = [
            'gate', 'record-review-receipt',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-context-path', fixture.reviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--repo-root', repoRoot
        ];
        const outsideValidationDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), 'garda-findings-validation-outside-')
        );
        const outsideSentinelPath = path.join(outsideValidationDirectory, 'sentinel.txt');
        const linkedValidationFamilyPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-findings-validation-external.json`
        );
        fs.writeFileSync(outsideSentinelPath, 'outside-validation-family', 'utf8');
        try {
            fs.symlinkSync(
                outsideValidationDirectory,
                linkedValidationFamilyPath,
                process.platform === 'win32' ? 'junction' : 'dir'
            );

            const linkedValidationFamilyResult = await runCliWithCapturedOutput(receiptArgs, { cwd: repoRoot });

            assert.notEqual(linkedValidationFamilyResult.exitCode, 0);
            assert.ok(
                linkedValidationFamilyResult.errors.some((line) =>
                    line.includes('Review findings validation rollback path must stay inside repo root')
                    || line.includes('must not traverse symlinks or junctions')
                ),
                linkedValidationFamilyResult.errors.join('\n')
            );
            assert.equal(fs.readFileSync(outsideSentinelPath, 'utf8'), 'outside-validation-family');
            assert.equal(
                JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
                'launched',
                'a linked validation-family member must fail before terminalizing the launch'
            );
        } finally {
            fs.rmSync(linkedValidationFamilyPath, { recursive: true, force: true });
            fs.rmSync(outsideValidationDirectory, { recursive: true, force: true });
        }
        const directoryValidationFamilyPath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-findings-validation-directory.json`
        );
        const directoryValidationSentinelPath = path.join(directoryValidationFamilyPath, 'sentinel.txt');
        fs.mkdirSync(directoryValidationFamilyPath);
        fs.writeFileSync(directoryValidationSentinelPath, 'in-repo-validation-family-directory', 'utf8');

        const directoryValidationFamilyResult = await runCliWithCapturedOutput(receiptArgs, { cwd: repoRoot });

        assert.notEqual(directoryValidationFamilyResult.exitCode, 0);
        assert.ok(
            directoryValidationFamilyResult.errors.some((line) =>
                line.includes('rollback family members must be regular files')
            ),
            directoryValidationFamilyResult.errors.join('\n')
        );
        assert.equal(
            fs.readFileSync(directoryValidationSentinelPath, 'utf8'),
            'in-repo-validation-family-directory'
        );
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched',
            'a directory validation-family member must fail before terminalizing the launch'
        );
        fs.rmSync(directoryValidationFamilyPath, { recursive: true, force: true });
        const resultLockPath = path.join(
            path.dirname(fixture.launchArtifactPath),
            '.record-review-result.lock'
        );
        fs.mkdirSync(resultLockPath, { recursive: true });
        fs.writeFileSync(path.join(resultLockPath, 'owner.json'), `${JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString(),
            owner_label: `record-review-result:${taskId}:code`
        }, null, 2)}\n`, 'utf8');

        const concurrentResult = await runCliWithCapturedOutput(receiptArgs, { cwd: repoRoot });

        assert.notEqual(concurrentResult.exitCode, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')).attestation_state,
            'launched'
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        fs.rmSync(resultLockPath, { recursive: true, force: true });

        const result = await runCliWithCapturedOutput(receiptArgs, { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.match(result.errors.join('\n'), /Verdict-free findings JSON report is invalid/u);
        const preservedLaunchArtifact = JSON.parse(
            fs.readFileSync(fixture.launchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        assert.equal(preservedLaunchArtifact.attestation_state, 'launched');
        assert.equal(preservedLaunchArtifact.launch_failure_stage, undefined);
        const correctionArtifact = JSON.parse(fs.readFileSync(
            path.join(fixture.reviewsRoot, `${taskId}-code-output-correction.json`),
            'utf8'
        )) as {
            state: string;
            binding: { reviewer_attempt_id: string; original_output_path: string };
        };
        assert.equal(correctionArtifact.state, 'REVIEW_OUTPUT_CORRECTION_REQUIRED');
        assert.equal(
            correctionArtifact.binding.reviewer_attempt_id,
            'receipt-rejected-attempt'
        );
        assert.equal(
            fs.readFileSync(correctionArtifact.binding.original_output_path, 'utf8'),
            fs.readFileSync(artifactPath, 'utf8')
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'),
            false
        );
        assert.equal(
            fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)),
            false
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result treats residual-risk-only findings JSON as a failed gate verdict', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-2-result-json-residual-risk';
        const fixture = await seedPromptBoundReviewFixture({
            repoRoot,
            taskId,
            preflightOverrides: {
                profile_policy_snapshot: {
                    review_finding_policy: {
                        schema_version: 1,
                        policy_id: 'strict',
                        findings: {
                            critical: 'fix_now',
                            high: 'fix_now',
                            medium: 'fix_now',
                            low: 'fix_now'
                        },
                        residual_risk: 'fix_now'
                    }
                }
            }
        });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
            coverage_contract: {
                contract_sha256: string;
                obligations: Array<{ id: string; kind: string; target: string }>;
            };
            task_scope: { changed_files: string[] };
            tree_state: { tree_state_sha256: string };
        };
        const defaultFile = reviewContext.task_scope.changed_files[0];
        const reviewContextSha256 = createHash('sha256').update(fs.readFileSync(fixture.reviewContextPath)).digest('hex');
        const outputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'review-output.md');
        fs.writeFileSync(outputPath, `${JSON.stringify({
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            review_context_sha256: reviewContextSha256,
            tree_state_sha256: reviewContext.tree_state.tree_state_sha256,
            review_execution: buildReviewExecutionEvidenceFixture(fixture.reviewContextPath),
            validation_notes: [{
                id: 'N-001',
                topic: 'complete-scope-sweep',
                note: 'Reviewed the complete assigned code scope and residual-risk-only JSON lifecycle behavior.',
                evidence: [{
                    location: `${defaultFile}:1`,
                    observation: 'Validated concrete residual risk behavior for verdict-free JSON review output.'
                }]
            }],
            coverage_ledger: {
                coverage_contract_sha256: reviewContext.coverage_contract.contract_sha256,
                entries: reviewContext.coverage_contract.obligations.map((obligation) => ({
                    obligation_id: obligation.id,
                    evidence: [{
                        location: `${obligation.kind === 'file' ? obligation.target : defaultFile}:1`,
                        observation: `Verified concrete ${obligation.kind} behavior for ${obligation.target} against residual-risk JSON handling.`
                    }],
                    finding_ids: []
                }))
            },
            findings: { critical: [], high: [], medium: [], low: [] },
            residual_risks: [{
                id: 'R-001',
                description: 'Residual-risk-only JSON reports must not receive a pass receipt.',
                evidence: [{
                    location: `${defaultFile}:1`,
                    observation: 'The residual risk is bound to a changed source file and line.'
                }]
            }],
            reviewer_notes: ['No legacy verdict token is present in this JSON output.']
        }, null, 2)}\n`, 'utf8');

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 0, result.errors.join('\n'));
        assert.ok(result.logs.some((line) => line.includes('VerdictToken: REVIEW FAILED')), result.logs.join('\n'));
        const receiptPath = path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        const remediationBaselinePath = path.join(
            fixture.reviewsRoot,
            `${taskId}-code-remediation-baseline.json`
        );
        assert.equal(fs.existsSync(remediationBaselinePath), true);
        const baseline = JSON.parse(fs.readFileSync(remediationBaselinePath, 'utf8'));
        assert.deepEqual(baseline.accepted_findings, []);
        assert.deepEqual(baseline.accepted_residual_risks.map((risk: { id: string }) => risk.id), ['R-001']);
        assert.deepEqual(baseline.fix_now_items, [{
            id: 'R-001',
            kind: 'residual_risk',
            severity: 'residual_risk',
            action: 'fix_now',
            source_rule: 'review_finding_policy.residual_risk',
            evidence_locations: [`${defaultFile}:1`]
        }]);
        assert.equal(baseline.schema_version, 2);
        assert.equal(baseline.delta_base.task_id, taskId);
        assert.equal(baseline.delta_base.review_type, 'code');
        assert.equal(
            baseline.delta_base.review_tree_state_sha256,
            reviewContext.tree_state.tree_state_sha256
        );
        assert.deepEqual(baseline.delta_base.changed_files, reviewContext.task_scope.changed_files);
        assert.equal(
            baseline.delta_base.changed_files_sha256,
            createHash('sha256').update(reviewContext.task_scope.changed_files.join('\n')).digest('hex')
        );
        assert.equal(baseline.delta_base.entries.length, 1);
        assert.equal(baseline.delta_base.entries[0].path, defaultFile);
        assert.equal(
            baseline.delta_base.entries[0].content_sha256,
            createHash('sha256').update(fs.readFileSync(path.join(repoRoot, defaultFile))).digest('hex')
        );
        assert.match(baseline.delta_base.snapshot_sha256, /^[0-9a-f]{64}$/u);
        assert.equal(
            baseline.bindings.findings_validation.artifact_sha256,
            receipt.review_findings_validation.artifact_sha256
        );
        assert.equal(
            baseline.bindings.findings_disposition.artifact_sha256,
            receipt.review_findings_disposition_artifact.artifact_sha256
        );
        const recordedEvent = readTaskTimelineEvents(repoRoot, taskId)
            .find((event) => event.event_type === 'REVIEW_RECORDED');
        const recordedDetails = recordedEvent?.details as Record<string, unknown> | undefined;
        assert.equal(recordedDetails?.remediation_baseline_path, remediationBaselinePath.replace(/\\/gu, '/'));
        assert.equal(
            recordedDetails?.remediation_baseline_sha256,
            createHash('sha256').update(fs.readFileSync(remediationBaselinePath)).digest('hex')
        );
        assert.equal(fs.existsSync(String(recordedDetails?.remediation_baseline_snapshot_path || '')), true);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects legacy verdict-token output for current generated review contexts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-5-result-rejects-legacy-verdict';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'review-output.md');
        fs.writeFileSync(outputPath, [
            '# Review',
            '',
            'Reviewed the current generated review context for the changed orchestrator receipt ingestion files, including the binding between review context hashes, coverage obligations, and delegated reviewer identity. This output is intentionally substantive but still returns a legacy verdict token instead of the required verdict-free findings JSON report.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.ok(
            result.errors.some((line) => line.includes('require a verdict-free findings JSON report')),
            result.errors.join('\n')
        );
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result preserves canonical evidence-only marker with reserved coverage id', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-976-result-evidence-only-coverage';
        const focusedTarget = 'tests/node/example.test.ts';
        fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, focusedTarget), 'export {};\n', 'utf8');
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'review-output.md');
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
            coverage_contract: { obligations: Array<{ id: string; kind: string; target: string }> };
            task_scope: { changed_files: string[] };
        };
        const report = buildNoFindingsJsonReport(fixture.reviewContextPath, taskId);
        const coverageLedger = report.coverage_ledger as {
            entries: Array<{ finding_ids: string[] }>;
        };
        coverageLedger.entries[0].finding_ids = ['F-000'];
        const findings = report.findings as {
            high: Array<Record<string, unknown>>;
        };
        const marker = `[garda:evidence-only:missing-focused-validation] test=${focusedTarget}; action=run-and-record-focused-test`;
        const validationNotes = report.validation_notes as Array<Record<string, unknown>>;
        validationNotes.push({
            id: 'N-002',
            topic: 'focused-self-validation',
            note: 'The reviewer attempted the smallest relevant focused test after prior execution evidence was unavailable.',
            command: `node --test ${focusedTarget}`,
            command_outcome: 'unavailable',
            diagnostics: 'The isolated reviewer environment did not provide the runtime needed to execute the focused test.',
            evidence: [{
                location: `${reviewContext.task_scope.changed_files[0]}:1`,
                observation: `The changed implementation is covered by ${focusedTarget}, which motivated the focused attempt.`
            }]
        });
        findings.high = [{
            id: 'F-000',
            title: marker,
            description: marker,
            evidence: [{
                location: `${reviewContext.task_scope.changed_files[0]}:1`,
                observation: 'Focused validation was not available during reviewer execution and must be run as the exact evidence-only follow-up.'
            }],
            coverage_obligation_ids: [reviewContext.coverage_contract.obligations[0].id]
        }];
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 0, result.errors.join('\n'));
        const receipt = JSON.parse(fs.readFileSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`), 'utf8'));
        assert.deepEqual(receipt.review_coverage.finding_ids, ['F-000']);
        assert.equal(receipt.review_findings_disposition.verdict, 'pass_no_findings');
        assert.equal(receipt.review_findings_disposition.total_count, 0);
        assert.equal(receipt.review_findings_disposition.blocking_count, 0);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects reserved coverage id on an ordinary finding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-976-result-reserved-id-misuse';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const outputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'review-output.md');
        const ledger = buildNoFindingCoverageLedger(fixture.reviewContextPath);
        ledger[0] = ledger[0]
            .replace('"result":"no-finding"', '"result":"finding"')
            .replace('"finding_ids":[]', '"finding_ids":["F-000"]');
        fs.writeFileSync(outputPath, [
            '# Review', '',
            '## Validation Notes',
            'Reviewed the complete current code scope and reserved finding identifier contract.', '',
            '## Coverage Ledger', ...ledger, '',
            '## Findings by Severity',
            '- Medium: [F-000] src/app.ts:1 ordinary implementation defect; remediation: fix it.', '',
            '## Deferred Findings', 'None', '',
            '## Residual Risks', 'None', '',
            '## Verdict', 'REVIEW FAILED'
        ].join('\n'), 'utf8');

        const result = await runCliWithCapturedOutput([
            'gate', 'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', outputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 1);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result fails closed when bound output template is stale before PASS notes policy resolution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-validation-notes-template-stale';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const reviewerHandoff = writeManualReviewerHandoffFixture(repoRoot, taskId, 'code');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_handoff: reviewerHandoff,
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');
        const outputTemplate = reviewerHandoff.output_template as Record<string, unknown>;
        fs.writeFileSync(String(outputTemplate.artifact_path), '# tampered output template\n', 'utf8');
        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            '## Validation Notes',
            'Reviewed the legacy markdown output-template binding path before PASS notes policy resolution.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        await recordReviewRoutingViaCli({
            taskId,
            reviewType: 'code',
            repoRoot,
            reviewerExecutionMode: 'delegated_subagent',
            reviewerIdentity: 'agent:code-reviewer'
        });

        const result = await runCliWithCapturedOutput([
            'gate',
            'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', preflightPath,
            '--review-output-path', reviewOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', 'agent:code-reviewer'
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.errors.some((line) => line.includes('reviewer output template artifact is stale')), result.errors.join('\n'));
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code.md`)), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result fails closed when output template binding is missing before PASS notes policy resolution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-validation-notes-template-missing';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const reviewerHandoff = writeManualReviewerHandoffFixture(repoRoot, taskId, 'code');
        delete reviewerHandoff.output_template;
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_handoff: reviewerHandoff,
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');
        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            '## Validation Notes',
            'Reviewed the legacy markdown output-template binding path before PASS notes policy resolution.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        await recordReviewRoutingViaCli({
            taskId,
            reviewType: 'code',
            repoRoot,
            reviewerExecutionMode: 'delegated_subagent',
            reviewerIdentity: 'agent:code-reviewer'
        });

        const result = await runCliWithCapturedOutput([
            'gate',
            'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', preflightPath,
            '--review-output-path', reviewOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', 'agent:code-reviewer'
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.errors.some((line) => line.includes('reviewer_handoff.output_template.artifact_path')), result.errors.join('\n'));
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code.md`)), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result keeps trivial pass review blocked when lossless normalization would otherwise add deferred follow-up', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-trivial-pass-findings';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# R',
            '',
            'x',
            '',
            '## Findings by Severity',
            '- High: x',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        assert.ok(capturedErrors.some((line) => line.includes('trivial or obviously synthetic')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), true);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects PASS output with active findings and residual risks instead of inferring follow-ups', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-pass-findings';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the materialization guard against a pass artifact that still reports active follow-up while preserving the reviewer evidence losslessly.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` this reviewer intentionally kept an unresolved blocker while claiming a pass verdict.',
            '',
            '## Residual Risks',
            '- Confirm the follow-up stays visible to operators after pass-review normalization.',
            '',
            '## Verdict',
            'REVIEW PASSED',
            '',
            '## Additional Reviewer Notes',
            'The unresolved blocker stays intentionally visible in the raw review output for audit provenance.'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        const rawReviewContent = fs.readFileSync(reviewOutputPath, 'utf8');
        assert.ok(rawReviewContent.includes('still reports active follow-up while preserving the reviewer evidence losslessly.'));
        assert.ok(rawReviewContent.includes('## Findings by Severity'));
        assert.ok(rawReviewContent.includes('## Residual Risks\n- Confirm the follow-up stays visible to operators after pass-review normalization.'));
        assert.ok(rawReviewContent.includes('## Additional Reviewer Notes'));
        assert.ok(capturedErrors.some((line) => line.includes('still contains active High findings')));
        assert.ok(capturedErrors.some((line) => line.includes('still contains active residual risks')));
        assert.ok(capturedErrors.some((line) => line.includes('Only real accepted actionable follow-ups belong')));
        assert.equal(capturedErrors.some((line) => line.includes('Move accepted non-blocking follow-up')), false);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects no-findings PASS output when deferred findings lack justification', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-pass-no-findings-recovery';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the no-findings pass-review materialization path with concrete scope notes and enough detail to stay above the trivial-review threshold while still keeping the artifact intentionally malformed for recovery guidance.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            '- [low] follow up on reviewer wording in `src/cli/commands/gate-review-handlers.ts:1`',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        const rawReviewContent = fs.readFileSync(reviewOutputPath, 'utf8');
        assert.ok(rawReviewContent.includes('## Deferred Findings'));
        assert.ok(rawReviewContent.includes('- [low] follow up on reviewer wording'));
        assert.ok(!rawReviewContent.includes('Justification:'));
        assert.ok(capturedErrors.some((line) => line.includes("deferred finding without usable 'Justification:'")));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects ambiguous duplicate reviewer section headings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-318-duplicate-heading';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/gates/completion-verdict-markdown.ts` and duplicate section handling with enough concrete detail to avoid the triviality filter while keeping the duplicate heading malformed on purpose.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '**Findings by Severity**',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        assert.ok(capturedErrors.some((line) => line.includes("ambiguous duplicate section heading for '## Findings by Severity'")));
        assert.ok(capturedErrors.some((line) => line.includes("Accepted section heading shapes include '## Findings by Severity'")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
