import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';

import {
    resolveClassifyDecisionRoute,
    resolveCompletedCloseoutDecisionRoute,
    resolveDelegatedReviewDecisionRoute,
    resolveFullSuiteDecisionRoute,
    resolveOptionalSkillSelectionDecisionRoute,
    resolvePendingOptionalSkillDecisionRoute,
    resolvePreGuardDecisionRoute,
    resolveStartupDecisionRoute,
    resolveTaskIdCaseMismatchDecisionRoute,
    resolveTaskQueueTerminalDecisionRoute
} from '../../../../src/gates/next-step/next-step-decision-route-groups';
import {
    resolveReviewCycleGuardDecisionRoute,
    resolveScopeBudgetGuardDecisionRoute,
    resolveValidationDecisionRoute
} from '../../../../src/gates/next-step/next-step-validation-routes';
import type {
    ScopeBudgetGuardEvaluation
} from '../../../../src/core/scope-budget-guard';
import type {
    NextStepReviewCycleBlock,
    ReviewCycleGuardEvaluation
} from '../../../../src/gates/next-step/next-step-review-cycle-guard';
import type {
    SplitRequiredLatchResult
} from '../../../../src/gates/next-step/next-step-split-required-latch';

function makeTempRuntime(): { repoRoot: string; reviewsRoot: string; eventsRoot: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-route-groups-'));
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(eventsRoot, { recursive: true });
    return { repoRoot, reviewsRoot, eventsRoot };
}

const noopCommand = (): never => {
    throw new Error('Lower-priority callback must not run.');
};

function makeReviewCycleEvaluation(overrides: Record<string, unknown> = {}): ReviewCycleGuardEvaluation {
    return {
        active: true,
        action: 'BLOCK_FOR_OPERATOR_DECISION',
        should_block: true,
        summary_line: 'Review cycle limit exceeded.',
        total_non_test_review_count: 2,
        failed_non_test_review_count: 1,
        excluded_review_types: ['test'],
        violations: [],
        ...overrides
    } as unknown as ReviewCycleGuardEvaluation;
}

function makeReviewCycleBlock(autoSplitEnabled: boolean): NextStepReviewCycleBlock {
    return {
        kind: 'review_cycle_guard',
        operator_decision_required: true,
        wait_for_operator: !autoSplitEnabled,
        auto_split_enabled: autoSplitEnabled,
        reason: 'Review cycle limit exceeded.',
        choices: ['allow_one_more_cycle', 'split_task'],
        operator_choice_guidance: [
            'allow_one_more_cycle: Continue once.',
            'split_task: Split the task.'
        ],
        auto_split_prompt: null
    } as unknown as NextStepReviewCycleBlock;
}

function makeSplitRequiredLatch(
    outcome: 'updated' | 'already_synced' | 'write_failed'
): SplitRequiredLatchResult {
    return {
        artifact_path: 'runtime/reviews/T-1-split-required.json',
        artifact_sha256: 'abc',
        status_sync: {
            outcome,
            task_id: 'T-1',
            previous_status: 'IN_PROGRESS',
            next_status: 'SPLIT_REQUIRED',
            task_path: 'TASK.md',
            error_message: outcome === 'write_failed' ? 'status update failed' : null
        },
        status_event_recorded: outcome === 'updated',
        latch_event_recorded: true,
        wip_capture: null
    } as SplitRequiredLatchResult;
}

test('resolveTaskQueueTerminalDecisionRoute preserves DONE conflict routing through task-reset', () => {
    const runtime = makeTempRuntime();
    const route = resolveTaskQueueTerminalDecisionRoute({
        ...runtime,
        taskId: 'T-1',
        cliPrefix: 'node bin/garda.js',
        taskEntries: new Map(),
        taskEntry: {
            taskId: 'T-1',
            status: 'DONE',
            area: 'workflow/test',
            title: 'Done task without gate evidence',
            profile: 'strict',
            notes: ''
        },
        completionGatePassed: false,
        latestCompletionCurrent: false,
        finalReportContractReady: false,
        finalReportContractBlocker: 'final report missing',
        summaryBlockers: ['compile-gate: missing'],
        filteredMissingArtifacts: [],
        corePresentArtifacts: []
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'task-reset');
    assert.equal(route.commands[0]?.label, 'Preview explicit operator reopen');
    assert.match(route.reason, /completion-gate: missing or not passed/);
});

test('aggregate completion keeps every audit blocker visible and preserves accepted terminal evidence', () => {
    const runtime = makeTempRuntime();
    try {
        const bundle = path.dirname(path.dirname(runtime.eventsRoot));
        appendMandatoryTaskEvent(bundle, 'T-1', 'STATUS_CHANGED', 'INFO', 'Isolated fixture.', {
            previous_status: 'DECOMPOSED', new_status: 'DONE', reason: 'decomposed_explicit_children_done'
        });
        appendMandatoryTaskEvent(bundle, 'T-1', 'DECOMPOSED_PARENT_COMPLETED', 'INFO', 'Isolated fixture.', {
            previous_status: 'DECOMPOSED', new_status: 'DONE', reason: 'explicit_children_done'
        });
        const options = {
            ...runtime, taskId: 'T-1', cliPrefix: 'node bin/garda.js', taskEntries: new Map(),
            taskEntry: { taskId: 'T-1', status: 'DONE', area: 'workflow', title: 'Aggregate', profile: 'balanced', notes: '' },
            completionGatePassed: false, latestCompletionCurrent: false,
            finalReportContractReady: true, finalReportContractBlocker: null,
            summaryBlockers: [] as string[], filteredMissingArtifacts: [], corePresentArtifacts: []
        };
        assert.equal(resolveTaskQueueTerminalDecisionRoute(options)?.status, 'DONE');
        for (const blocker of ['decomposed-parent-obligations: missing source', 'integrity: invalid timeline', 'finalization: in flight']) {
            const route = resolveTaskQueueTerminalDecisionRoute({ ...options, summaryBlockers: [blocker] });
            assert.equal(route?.status, 'BLOCKED');
            assert.equal(route?.nextGate, 'decomposed-parent-obligations');
            assert.ok(route?.reason.includes(blocker));
            assert.deepEqual(route?.commands, []);
        }
        const notReady = resolveTaskQueueTerminalDecisionRoute({ ...options,
            finalReportContractReady: false, finalReportContractBlocker: 'parent finalization is pending' });
        assert.equal(notReady?.status, 'BLOCKED');
        assert.match(notReady?.reason || '', /parent finalization is pending/);
    } finally { fs.rmSync(runtime.repoRoot, { recursive: true, force: true }); }
});

test('resolveTaskQueueTerminalDecisionRoute keeps an operator terminal discard DONE without completion evidence', () => {
    const runtime = makeTempRuntime();
    fs.writeFileSync(
        path.join(runtime.reviewsRoot, 'T-1-reset-report.json'),
        JSON.stringify({
            timestamp_utc: new Date().toISOString(),
            event_source: 'task-reset',
            task_id: 'T-1',
            previous_status: 'TODO',
            target_status: 'DONE',
            reset_by: 'operator'
        }) + '\n',
        'utf8'
    );
    try {
        const route = resolveTaskQueueTerminalDecisionRoute({
            ...runtime,
            taskId: 'T-1',
            cliPrefix: 'node bin/garda.js',
            taskEntries: new Map(),
            taskEntry: {
                taskId: 'T-1',
                status: 'DONE',
                area: 'workflow/test',
                title: 'Operator-discarded task',
                profile: 'fast',
                notes: ''
            },
            completionGatePassed: false,
            latestCompletionCurrent: false,
            finalReportContractReady: false,
            finalReportContractBlocker: 'final report missing',
            summaryBlockers: ['project-memory-impact: missing'],
            filteredMissingArtifacts: [],
            corePresentArtifacts: []
        });

        assert.ok(route);
        assert.equal(route.status, 'DONE');
        assert.equal(route.nextGate, null);
        assert.deepEqual(route.commands, []);
    } finally {
        fs.rmSync(runtime.repoRoot, { recursive: true, force: true });
    }
});

test('resolveTaskQueueTerminalDecisionRoute rejects terminal discard evidence bound to another task', () => {
    const runtime = makeTempRuntime();
    fs.writeFileSync(
        path.join(runtime.reviewsRoot, 'T-1-reset-report.json'),
        JSON.stringify({
            timestamp_utc: new Date().toISOString(),
            event_source: 'task-reset',
            task_id: 'T-OTHER',
            previous_status: 'TODO',
            target_status: 'DONE',
            reset_by: 'operator'
        }) + '\n',
        'utf8'
    );
    try {
        const route = resolveTaskQueueTerminalDecisionRoute({
            ...runtime,
            taskId: 'T-1',
            cliPrefix: 'node bin/garda.js',
            taskEntries: new Map(),
            taskEntry: {
                taskId: 'T-1',
                status: 'DONE',
                area: 'workflow/test',
                title: 'False DONE task',
                profile: 'fast',
                notes: ''
            },
            completionGatePassed: false,
            latestCompletionCurrent: false,
            finalReportContractReady: false,
            finalReportContractBlocker: 'final report missing',
            summaryBlockers: [],
            filteredMissingArtifacts: [],
            corePresentArtifacts: []
        });

        assert.ok(route);
        assert.equal(route.status, 'BLOCKED');
        assert.equal(route.nextGate, 'task-reset');
    } finally {
        fs.rmSync(runtime.repoRoot, { recursive: true, force: true });
    }
});

test('resolveScopeBudgetGuardDecisionRoute materializes a blocking latch and preserves sync failure', () => {
    const evaluation = {
        active: true,
        action: 'BLOCK_FOR_SPLIT',
        status: 'BLOCK',
        profile_name: 'balanced',
        violations: [],
        should_warn: true,
        should_block: true,
        continuation_allowed: false,
        summary_line: 'Scope budget exceeded.'
    } satisfies ScopeBudgetGuardEvaluation;
    const decision = resolveScopeBudgetGuardDecisionRoute({
        evaluation,
        guardReason: 'Sanitized scope budget guard reason',
        materializeLatch: () => ({
            artifact_path: 'runtime/reviews/T-1-split-required.json',
            artifact_sha256: 'abc',
            status_sync: {
                outcome: 'write_failed',
                task_id: 'T-1',
                previous_status: 'IN_PROGRESS',
                next_status: 'SPLIT_REQUIRED',
                task_path: 'TASK.md',
                error_message: 'status update failed'
            },
            status_event_recorded: true,
            latch_event_recorded: true,
            wip_capture: null
        } as SplitRequiredLatchResult),
        formatArtifactPath: (artifactPath: string) => artifactPath,
        presentArtifacts: []
    });

    assert.equal(decision.route?.status, 'BLOCKED');
    assert.equal(decision.route?.nextGate, 'split-required-latch');
    assert.match(decision.route?.reason || '', /status update failed/);
    assert.equal(decision.warnings.length, 1);
});

test('resolveScopeBudgetGuardDecisionRoute returns SPLIT_REQUIRED after successful latch sync', () => {
    const options = {
        evaluation: {
            active: true,
            action: 'BLOCK_FOR_SPLIT',
            status: 'BLOCK',
            profile_name: 'balanced',
            violations: [],
            should_warn: false,
            should_block: true,
            continuation_allowed: false,
            summary_line: 'Scope budget exceeded.'
        } satisfies ScopeBudgetGuardEvaluation,
        guardReason: null,
        formatArtifactPath: (artifactPath: string) => artifactPath,
        presentArtifacts: [{
            key: 'preflight',
            path: 'runtime/reviews/T-1-preflight.json',
            exists: true
        }]
    };
    const decision = resolveScopeBudgetGuardDecisionRoute({
        ...options,
        materializeLatch: () => makeSplitRequiredLatch('updated')
    });
    const idempotentDecision = resolveScopeBudgetGuardDecisionRoute({
        ...options,
        materializeLatch: () => makeSplitRequiredLatch('already_synced')
    });

    assert.equal(decision.route?.status, 'SPLIT_REQUIRED');
    assert.equal(decision.route?.nextGate, 'split-required-latch');
    assert.deepEqual(decision.route?.missingArtifacts, []);
    assert.equal(decision.route?.presentArtifacts?.length, 1);
    assert.equal(idempotentDecision.route?.status, 'SPLIT_REQUIRED');
});

test('resolveReviewCycleGuardDecisionRoute accepts one active continuation without building a block', () => {
    const evaluation = makeReviewCycleEvaluation();
    const decision = resolveReviewCycleGuardDecisionRoute({
        evaluation,
        getPendingRequiredReviewTypes: () => ['code'],
        assessContinuation: () => ({
            status: 'ACTIVE',
            reason: 'One additional review attempt remains.',
            artifact_path: 'runtime/reviews/T-1-review-cycle-continuation.json',
            artifact_sha256: 'abc',
            artifact: null,
            remaining_total_non_test_review_attempts: 1,
            remaining_failed_non_test_reviews: 1
        }),
        buildOperatorBlock: noopCommand,
        materializeLatch: noopCommand,
        materializeAutoSplitPrompt: noopCommand,
        buildContinuationCommand: noopCommand,
        buildSplitDecisionCommand: noopCommand,
        formatArtifactPath: (artifactPath) => artifactPath,
        presentArtifacts: [],
        defaultMissingArtifacts: []
    });

    assert.equal(decision.route, null);
    assert.equal(decision.warnings.length, 1);
    assert.match(decision.warnings[0] || '', /one-shot continuation active/);
});

test('resolveReviewCycleGuardDecisionRoute does not read review evidence for a nonblocking guard', () => {
    let pendingReviewReads = 0;
    const decision = resolveReviewCycleGuardDecisionRoute({
        evaluation: makeReviewCycleEvaluation({
            action: 'WARN_ONLY',
            should_block: false,
            violations: ['review cycle warning']
        }),
        getPendingRequiredReviewTypes: () => {
            pendingReviewReads += 1;
            return ['code'];
        },
        assessContinuation: noopCommand,
        buildOperatorBlock: noopCommand,
        materializeLatch: noopCommand,
        materializeAutoSplitPrompt: noopCommand,
        buildContinuationCommand: noopCommand,
        buildSplitDecisionCommand: noopCommand,
        formatArtifactPath: (artifactPath) => artifactPath,
        presentArtifacts: [],
        defaultMissingArtifacts: []
    });

    assert.equal(decision.route, null);
    assert.equal(pendingReviewReads, 0);
    assert.equal(decision.warnings.length, 1);
    assert.match(decision.warnings[0] || '', /Review cycle limit exceeded/);
});

test('resolveReviewCycleGuardDecisionRoute offers continuation and split for missing evidence', () => {
    const decision = resolveReviewCycleGuardDecisionRoute({
        evaluation: makeReviewCycleEvaluation(),
        getPendingRequiredReviewTypes: () => ['code'],
        assessContinuation: () => ({
            status: 'MISSING',
            reason: 'No continuation was recorded.',
            artifact_path: 'runtime/reviews/T-1-review-cycle-continuation.json',
            artifact_sha256: null,
            artifact: null,
            remaining_total_non_test_review_attempts: null,
            remaining_failed_non_test_reviews: null
        }),
        buildOperatorBlock: () => makeReviewCycleBlock(false),
        materializeLatch: noopCommand,
        materializeAutoSplitPrompt: noopCommand,
        buildContinuationCommand: () => 'record-continuation',
        buildSplitDecisionCommand: () => 'record-split',
        formatArtifactPath: (artifactPath) => artifactPath,
        presentArtifacts: [],
        defaultMissingArtifacts: []
    });

    assert.equal(decision.route?.status, 'BLOCKED');
    assert.equal(decision.route?.nextGate, 'review-cycle-attempt-guard');
    assert.deepEqual(
        decision.route?.commands.map((command) => command.command),
        ['record-continuation', 'record-split']
    );
});

test('resolveReviewCycleGuardDecisionRoute preserves auto-split success and sync failure', () => {
    const common = {
        evaluation: makeReviewCycleEvaluation(),
        getPendingRequiredReviewTypes: () => ['code'],
        assessContinuation: () => ({
            status: 'EXPIRED' as const,
            reason: 'The prior continuation expired.',
            artifact_path: 'runtime/reviews/T-1-review-cycle-continuation.json',
            artifact_sha256: 'abc',
            artifact: null,
            remaining_total_non_test_review_attempts: 0,
            remaining_failed_non_test_reviews: 0
        }),
        materializeAutoSplitPrompt: () => ({
            kind: 'review_cycle_auto_split_prompt' as const,
            artifact_path: 'runtime/reviews/T-1-auto-split.json',
            artifact_sha256: 'def',
            current_state: 'checkpoint' as const,
            latch_artifact_path: 'runtime/reviews/T-1-split-required.json',
            latch_artifact_sha256: 'abc',
            wip_capture_status: 'CAPTURED' as const,
            wip_manifest_path: 'runtime/reviews/T-1-wip.json',
            work_package_contract_path: 'runtime/reviews/T-1-work-package.json',
            next_action: 'Create child tasks.',
            state_next_action: 'inspect_checkpoint_scope' as const,
            next_action_command: 'inspect-checkpoint',
            instructions: ['Create child tasks.'],
            constraints: ['Do not continue the parent.']
        }),
        buildContinuationCommand: noopCommand,
        buildSplitDecisionCommand: noopCommand,
        formatArtifactPath: (artifactPath: string) => artifactPath,
        presentArtifacts: [],
        defaultMissingArtifacts: []
    };
    const successful = resolveReviewCycleGuardDecisionRoute({
        ...common,
        buildOperatorBlock: () => makeReviewCycleBlock(true),
        materializeLatch: () => makeSplitRequiredLatch('updated')
    });
    const failed = resolveReviewCycleGuardDecisionRoute({
        ...common,
        buildOperatorBlock: () => makeReviewCycleBlock(true),
        materializeLatch: () => makeSplitRequiredLatch('write_failed')
    });

    assert.equal(successful.route?.status, 'SPLIT_REQUIRED');
    assert.equal(successful.route?.reviewCycleBlock?.auto_split_prompt?.next_action, 'Create child tasks.');
    assert.equal(failed.route?.status, 'BLOCKED');
    assert.match(failed.route?.reason || '', /status update failed/);
});

test('resolveReviewCycleGuardDecisionRoute suppresses another continuation after expiry', () => {
    const decision = resolveReviewCycleGuardDecisionRoute({
        evaluation: makeReviewCycleEvaluation(),
        getPendingRequiredReviewTypes: () => ['code'],
        assessContinuation: () => ({
            status: 'EXPIRED',
            reason: 'The prior continuation expired.',
            artifact_path: 'runtime/reviews/T-1-review-cycle-continuation.json',
            artifact_sha256: 'abc',
            artifact: null,
            remaining_total_non_test_review_attempts: 0,
            remaining_failed_non_test_reviews: 0
        }),
        buildOperatorBlock: () => makeReviewCycleBlock(false),
        materializeLatch: noopCommand,
        materializeAutoSplitPrompt: noopCommand,
        buildContinuationCommand: noopCommand,
        buildSplitDecisionCommand: () => 'record-split',
        formatArtifactPath: (artifactPath) => artifactPath,
        presentArtifacts: [],
        defaultMissingArtifacts: []
    });

    assert.equal(decision.route?.status, 'BLOCKED');
    assert.deepEqual(decision.route?.commands.map((command) => command.command), ['record-split']);
    assert.deepEqual(decision.route?.reviewCycleBlock?.choices, ['split_task']);
    assert.match(
        decision.route?.reviewCycleBlock?.operator_choice_guidance.at(-1) || '',
        /continuation_already_recorded/
    );
});

test('resolveValidationDecisionRoute preserves quality, baseline implementation, compile, no-op, then full-suite precedence', () => {
    const qualityRoute = {
        status: 'BLOCKED' as const,
        nextGate: 'quality-checklist',
        title: 'Complete quality checklist.',
        reason: 'Checklist is pending.',
        commands: []
    };
    const compileRoute = {
        status: 'BLOCKED' as const,
        nextGate: 'compile-gate',
        title: 'Run compile gate.',
        reason: 'Compile is pending.',
        commands: []
    };
    const fullSuiteRoute = {
        status: 'BLOCKED' as const,
        nextGate: 'full-suite-validation',
        title: 'Run full suite.',
        reason: 'Full suite is pending.',
        commands: []
    };
    const common = {
        resolveBaselineOnlyPreImplementationRoute: () => null,
        resolveAuditedNoOpState: () => ({
            required: true,
            passed: false,
            evidenceStatus: 'EVIDENCE_FILE_MISSING',
            command: 'record-no-op'
        }),
        resolveFullSuiteValidationRoute: () => fullSuiteRoute
    };

    assert.equal(resolveValidationDecisionRoute({
        ...common,
        resolveQualityChecklistRoute: () => qualityRoute,
        resolveCompileGateRoute: () => compileRoute
    })?.nextGate, 'quality-checklist');
    assert.equal(resolveValidationDecisionRoute({
        ...common,
        resolveQualityChecklistRoute: () => null,
        resolveBaselineOnlyPreImplementationRoute: () => ({
            nextGate: 'implementation',
            title: 'Implement changes.',
            reason: 'Materialize the planned diff.'
        }),
        resolveCompileGateRoute: () => compileRoute
    })?.nextGate, 'implementation');
    assert.equal(resolveValidationDecisionRoute({
        ...common,
        resolveQualityChecklistRoute: () => null,
        resolveBaselineOnlyPreImplementationRoute: () => ({
            nextGate: 'implementation',
            title: 'Implement changes.',
            reason: 'Materialize the planned diff.'
        }),
        resolveCompileGateRoute: () => null
    })?.nextGate, 'implementation');
    assert.equal(resolveValidationDecisionRoute({
        ...common,
        resolveQualityChecklistRoute: () => null,
        resolveCompileGateRoute: () => compileRoute
    })?.nextGate, 'compile-gate');
    assert.equal(resolveValidationDecisionRoute({
        ...common,
        resolveQualityChecklistRoute: () => null,
        resolveCompileGateRoute: () => null
    })?.nextGate, 'record-no-op');
    assert.equal(resolveValidationDecisionRoute({
        ...common,
        resolveQualityChecklistRoute: () => null,
        resolveCompileGateRoute: () => null,
        resolveAuditedNoOpState: () => ({
            required: true,
            passed: true,
            evidenceStatus: 'PASS',
            command: 'record-no-op'
        })
    })?.nextGate, 'full-suite-validation');
});

test('resolveValidationDecisionRoute does not evaluate lower-priority resolvers', () => {
    let lowerPriorityReads = 0;
    const route = resolveValidationDecisionRoute({
        resolveQualityChecklistRoute: () => ({
            status: 'BLOCKED',
            nextGate: 'quality-checklist',
            title: 'Complete quality checklist.',
            reason: 'Checklist is pending.',
            commands: []
        }),
        resolveBaselineOnlyPreImplementationRoute: () => {
            lowerPriorityReads += 1;
            return null;
        },
        resolveCompileGateRoute: () => {
            lowerPriorityReads += 1;
            return null;
        },
        resolveAuditedNoOpState: () => {
            lowerPriorityReads += 1;
            return {
                required: false,
                passed: false,
                evidenceStatus: 'NOT_REQUIRED',
                command: 'record-no-op'
            };
        },
        resolveFullSuiteValidationRoute: () => {
            lowerPriorityReads += 1;
            return null;
        }
    });

    assert.equal(route?.nextGate, 'quality-checklist');
    assert.equal(lowerPriorityReads, 0);
});

test('resolveValidationDecisionRoute evaluates only manifest-projected validation gates', () => {
    let qualityReads = 0;
    let fullSuiteReads = 0;
    const route = resolveValidationDecisionRoute({
        lifecycleGateIds: ['compile-gate'],
        resolveQualityChecklistRoute: () => {
            qualityReads += 1;
            return null;
        },
        resolveBaselineOnlyPreImplementationRoute: () => null,
        resolveCompileGateRoute: () => ({
            status: 'BLOCKED',
            nextGate: 'compile-gate',
            title: 'Run compile gate.',
            reason: 'Compile is pending.',
            commands: []
        }),
        resolveAuditedNoOpState: () => ({
            required: false,
            passed: false,
            evidenceStatus: 'NOT_REQUIRED',
            command: 'record-no-op'
        }),
        resolveFullSuiteValidationRoute: () => {
            fullSuiteReads += 1;
            return null;
        }
    });

    assert.equal(route?.nextGate, 'compile-gate');
    assert.equal(qualityReads, 0);
    assert.equal(fullSuiteReads, 0);
});

test('resolveValidationDecisionRoute short-circuits after baseline, compile, and audited no-op winners', () => {
    let lowerPriorityReads = 0;
    const lowerPriority = () => {
        lowerPriorityReads += 1;
        return null;
    };
    const baselineRoute = resolveValidationDecisionRoute({
        resolveQualityChecklistRoute: () => null,
        resolveBaselineOnlyPreImplementationRoute: () => ({
            nextGate: 'implementation',
            title: 'Implement changes.',
            reason: 'Materialize the planned diff.'
        }),
        resolveCompileGateRoute: lowerPriority,
        resolveAuditedNoOpState: noopCommand,
        resolveFullSuiteValidationRoute: lowerPriority
    });
    assert.equal(baselineRoute?.nextGate, 'implementation');
    assert.equal(lowerPriorityReads, 0);

    const compileRoute = resolveValidationDecisionRoute({
        resolveQualityChecklistRoute: () => null,
        resolveBaselineOnlyPreImplementationRoute: () => null,
        resolveCompileGateRoute: () => ({
            status: 'BLOCKED',
            nextGate: 'compile-gate',
            title: 'Run compile gate.',
            reason: 'Compile is pending.',
            commands: []
        }),
        resolveAuditedNoOpState: noopCommand,
        resolveFullSuiteValidationRoute: lowerPriority
    });
    assert.equal(compileRoute?.nextGate, 'compile-gate');
    assert.equal(lowerPriorityReads, 0);

    const noOpRoute = resolveValidationDecisionRoute({
        resolveQualityChecklistRoute: () => null,
        resolveBaselineOnlyPreImplementationRoute: () => null,
        resolveCompileGateRoute: () => null,
        resolveAuditedNoOpState: () => ({
            required: true,
            passed: false,
            evidenceStatus: 'EVIDENCE_FILE_MISSING',
            command: 'record-no-op'
        }),
        resolveFullSuiteValidationRoute: lowerPriority
    });
    assert.equal(noOpRoute?.nextGate, 'record-no-op');
    assert.equal(lowerPriorityReads, 0);
});

test('resolveTaskIdCaseMismatchDecisionRoute preserves terminal casing recovery before startup', () => {
    const route = resolveTaskIdCaseMismatchDecisionRoute({
        requestedTaskId: 't-1',
        taskIdCaseMismatch: 'T-1',
        cliPrefix: 'node bin/garda.js',
        presentArtifacts: []
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'task-id-casing');
    assert.equal(route.commands[0]?.label, 'Rerun navigator with TASK.md casing');
    assert.equal(route.commands[0]?.command, 'node bin/garda.js next-step "T-1" --repo-root "."');
});

test('resolveStartupDecisionRoute preserves fresh task-mode startup command', () => {
    const route = resolveStartupDecisionRoute({
        enterTaskModePassed: false,
        protectedManifestRecovery: null,
        defaultExecutionProvider: 'Codex',
        enterTaskModeCommand:
            'node bin/garda.js gate enter-task-mode --task-id "T-1" --provider "Codex" --repo-root "."',
        startupCycleReadiness: {
            ready: false,
            reason: 'No TASK_MODE_ENTERED event exists for this task.',
            nextGate: 'load-rule-pack',
            title: 'Load TASK_ENTRY rules.'
        },
        loadRulePackPassed: false,
        rulePackStage: null,
        preflightExists: false,
        taskEntryRulePackCommand: 'node bin/garda.js gate load-rule-pack --task-id "T-1"',
        handshakeDiagnosticsPassed: false,
        handshakeDiagnosticsCommand: 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"',
        shellSmokePreflightPassed: false,
        shellSmokePreflightCommand: 'node bin/garda.js gate shell-smoke-preflight --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'enter-task-mode');
    assert.equal(route.commands[0]?.label, 'Enter task mode');
    assert.match(route.reason, /No TASK_MODE_ENTERED event exists/);
});

test('resolveClassifyDecisionRoute keeps failed classify recovery ahead of strict and protected routes', () => {
    let lowerPriorityRouteRead = false;
    const route = resolveClassifyDecisionRoute({
        preflightExists: false,
        classifyChangePassed: false,
        readFailedGateRecovery: () => ({
            nextGate: 'classify-change',
            title: 'Recover failed classify-change.',
            reason: 'The latest classify-change attempt failed.',
            command: 'node bin/garda.js gate classify-change --task-id "T-1"',
            label: 'Retry classify-change'
        }),
        resolveStrictDecompositionRoute: () => {
            lowerPriorityRouteRead = true;
            return null;
        },
        resolveProtectedScopeRoute: () => {
            lowerPriorityRouteRead = true;
            return null;
        },
        buildClassifyCommand: () => {
            lowerPriorityRouteRead = true;
            return 'unexpected';
        }
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.equal(route.commands[0]?.label, 'Retry classify-change');
    assert.equal(lowerPriorityRouteRead, false);
});

test('resolveClassifyDecisionRoute keeps protected restart ahead of ordinary classify fallback', () => {
    let classifyCommandBuilt = false;
    const route = resolveClassifyDecisionRoute({
        preflightExists: false,
        classifyChangePassed: false,
        readFailedGateRecovery: () => null,
        resolveStrictDecompositionRoute: () => null,
        resolveProtectedScopeRoute: () => ({
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode for protected scope before classify.',
            reason: 'Fresh operator approval is required.',
            commands: [{
                label: 'Restart task mode with orchestrator work',
                command: 'node bin/garda.js gate enter-task-mode --orchestrator-work'
            }]
        }),
        buildClassifyCommand: () => {
            classifyCommandBuilt = true;
            return 'unexpected';
        }
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'enter-task-mode');
    assert.equal(route.commands[0]?.label, 'Restart task mode with orchestrator work');
    assert.equal(classifyCommandBuilt, false);
});

test('resolveCompletedCloseoutDecisionRoute preserves final audit materialization routing', () => {
    const route = resolveCompletedCloseoutDecisionRoute({
        completionGatePassed: true,
        latestCompletionCurrent: true,
        postDoneDriftBlocked: false,
        postDoneDriftReason: '',
        finalReportContractReady: true,
        finalReportContractBlocker: '',
        finalReport: null,
        taskAuditCommand: 'node bin/garda.js gate task-audit-summary --task-id "T-1"',
        missingArtifacts: [{
            key: 'final-closeout',
            path: 'garda-agent-orchestrator/runtime/reviews/T-1-final-closeout.json',
            exists: false
        }]
    });

    assert.ok(route);
    assert.equal(route.status, 'READY');
    assert.equal(route.nextGate, 'task-audit-summary');
    assert.equal(route.commands[0]?.label, 'Build final audit summary');
    assert.equal(route.missingArtifacts?.[0]?.key, 'final-closeout');
});

const OPTIONAL_SKILL_SELECTION_BASE = Object.freeze({
    artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-1-optional-skill-selection.json',
    artifact_present: true,
    artifact_violations: [] as string[],
    timeline_invalid_json: false,
    current_policy_mode: 'mandatory',
    policy_mode: 'mandatory',
    decision: 'selected_installed_skills',
    selection_phase: 'pre_implementation',
    path_evidence_source: 'planned_changed_files',
    post_diff_self_check: false,
    selected_skill_ids: ['node-backend'],
    selected_skill_sources: ['custom_live'],
    selected_skill_details: [{
        id: 'node-backend',
        pack: 'node-backend',
        source: 'custom_live',
        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
    }],
    activated_skill_ids: [] as string[],
    declined_skill_ids: [] as string[],
    pending_activation_skill_ids: ['node-backend'],
    recommended_missing_pack_ids: [] as string[],
    as_is_reason: null,
    changed_paths: ['src/app.ts'],
    changed_paths_count: 1,
    visible_summary_line: 'Optional skills: node-backend',
    activation_commands: ['activate node-backend'],
    decline_commands: [] as string[],
    skill_catalog_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
    task_start_instruction: 'Activate node-backend.'
});

test('resolveOptionalSkillSelectionDecisionRoute keeps artifact violations ahead of remediation', () => {
    const route = resolveOptionalSkillSelectionDecisionRoute({
        optionalSkillSelection: {
            ...OPTIONAL_SKILL_SELECTION_BASE,
            artifact_violations: ['selection hash mismatch']
        },
        mandatoryRemediation: {
            label: 'Install missing skill pack',
            command: 'skills install node-backend',
            reason: 'Skill pack is missing.'
        },
        mandatoryPolicyMode: true,
        refreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        timelineIntegrityCommand: 'node bin/garda.js gate task-events-summary --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.match(route.reason, /selection hash mismatch/);
    assert.equal(route.commands[0]?.label, 'Refresh preflight and optional-skill selection');
});

test('resolveOptionalSkillSelectionDecisionRoute preserves mandatory remediation routing', () => {
    const route = resolveOptionalSkillSelectionDecisionRoute({
        optionalSkillSelection: OPTIONAL_SKILL_SELECTION_BASE,
        mandatoryRemediation: {
            label: 'Install missing skill pack',
            command: 'skills install node-backend',
            reason: 'Skill pack is missing.'
        },
        mandatoryPolicyMode: true,
        refreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        timelineIntegrityCommand: 'node bin/garda.js gate task-events-summary --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'optional-skill-remediation');
    assert.equal(route.reason, 'Skill pack is missing.');
    assert.equal(route.commands[0]?.command, 'skills install node-backend');
});

test('resolveOptionalSkillSelectionDecisionRoute fails closed on malformed mandatory timeline', () => {
    const route = resolveOptionalSkillSelectionDecisionRoute({
        optionalSkillSelection: {
            ...OPTIONAL_SKILL_SELECTION_BASE,
            timeline_invalid_json: true
        },
        mandatoryRemediation: null,
        mandatoryPolicyMode: true,
        refreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        timelineIntegrityCommand: 'node bin/garda.js gate task-events-summary --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'task-events-summary');
    assert.match(route.reason, /timeline JSONL is malformed/i);
    assert.equal(route.commands[0]?.label, 'Inspect task timeline integrity');
});

test('resolvePreGuardDecisionRoute preserves stale-cycle refresh ahead of later guards', () => {
    const route = resolvePreGuardDecisionRoute({
        preflightCycleReadiness: {
            ready: false,
            reason: 'Preflight evidence is older than task-mode evidence.'
        },
        preflightCycleRefreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        protectedControlPlane: {
            touched: true,
            taskModeHasOrchestratorWork: false,
            selfGuardDeny: true,
            selfGuardGuidance: 'Operator maintenance required.',
            maintenanceInspectionCommand: 'node bin/garda.js workflow set --self-guard',
            orchestratorWorkRestartCommand: 'node bin/garda.js gate enter-task-mode --orchestrator-work'
        },
        workspaceReadiness: {
            ready: false,
            reason: 'Workspace scope changed.'
        },
        workspaceRefreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        coherentCycleReadiness: {
            ready: false,
            reason: 'Coherent cycle is stale.'
        },
        navigatorCommand: 'node bin/garda.js next-step "T-1" --repo-root "."',
        postPreflightRulePack: {
            ready: false,
            reason: 'POST_PREFLIGHT evidence is missing.',
            stage: null,
            canBind: false,
            loadCommand: 'node bin/garda.js gate load-rule-pack --stage POST_PREFLIGHT',
            bindCommand: 'node bin/garda.js gate bind-rule-pack-to-preflight'
        },
        optionalSkillActivation: {
            skillId: 'node-backend',
            command: 'node bin/garda.js gate activate-optional-skill --skill-id node-backend'
        }
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.equal(route.commands[0]?.label, 'Refresh preflight');
    assert.match(route.reason, /older than task-mode evidence/);
});

test('resolvePendingOptionalSkillDecisionRoute preserves activation command contract', () => {
    const route = resolvePendingOptionalSkillDecisionRoute({
        skillId: 'node-backend',
        command: 'node bin/garda.js gate activate-optional-skill --skill-id "node-backend"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'activate-optional-skill');
    assert.equal(route.commands[0]?.label, 'Activate optional skill node-backend');
    assert.match(route.reason, /current task cycle has no matching activation evidence/);
});

test('resolveFullSuiteDecisionRoute preserves after-compile full-suite routing', () => {
    const route = resolveFullSuiteDecisionRoute({
        enabled: true,
        placement: 'after_compile_before_reviews',
        notRequiredForCurrentScope: false,
        gateStatus: null,
        gatePassed: false,
        timeoutBlockerExhausted: false,
        timeoutRepairTaskProposal: null,
        timedOutRetryAvailable: false,
        transientRetryEvidenceAvailable: false,
        transientRetryEvidenceReason: null,
        targetedDiagnosticRetryAvailable: false,
        targetedDiagnosticRetryReason: null,
        configPath: 'garda-agent-orchestrator/live/config/workflow-config.json',
        commandText: 'npm run test:sharded',
        timeoutForecastLine: 'Recommended full-suite command timeout: 389s.',
        command: 'node bin/garda.js gate full-suite-validation --task-id "T-1"',
        runMarkerRecoveryCommand: 'node bin/garda.js gate full-suite-run-marker-recovery --task-id "T-1"',
        runMarkerCleanupCommand: 'node bin/garda.js gate full-suite-run-marker-recovery --task-id "T-1" --clear-dead-marker --operator-confirmed yes',
        navigatorCommand: 'node bin/garda.js next-step "T-1" --repo-root "."',
        nextReviewType: 'code'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'full-suite-validation');
    assert.equal(route.commands[0]?.label, 'Run full-suite validation');
    assert.match(route.reason, /before launching independent reviewers/);
});

test('resolveDelegatedReviewDecisionRoute preserves missing routing recovery before reviewer launch', () => {
    const route = resolveDelegatedReviewDecisionRoute({
        reviewType: 'code',
        currentReviewReuseRecorded: false,
        currentReviewEvidenceSatisfied: false,
        currentReviewContextInvocationAttested: false,
        routingCurrent: false,
        artifactExists: false,
        receiptExists: false,
        reviewFailed: false,
        stateReady: false,
        stateViolationsText: 'review artifact or receipt is missing',
        reviewerIdentity: '',
        contextReviewerIdentity: '',
        reviewerIdentityIsPlanned: false,
        launchArtifactState: 'missing_or_invalid',
        providerLaunchTargetSummary: 'Codex via AGENTS.md',
        reviewerReadinessChain: 'reviewer readiness chain',
        reviewRoutingChain: 'review routing chain',
        launchPreparationChain: 'launch preparation chain',
        launchCompletionChain: 'launch completion chain',
        reviewInvocationChain: 'review invocation chain',
        reviewResultChain: 'review result chain',
        acceptedVerdictTokens: 'REVIEW PASSED',
        hiddenTimingTrustRemediation: null,
        reusedExistingReview: false,
        oneShotLaunchHint: null,
        instructions: {
            opaqueHandoff: 'opaque handoff',
            freshContextLaunch: 'fresh context',
            sessionReuseBoundary: 'no reuse',
            realSubagentOrStop: 'real subagent or stop',
            cleanupAfterReceipt: 'cleanup'
        },
        commands: {
            recordRouting: {
                label: 'Record fresh delegated review routing',
                command: 'node bin/garda.js gate record-review-routing --task-id "T-1"'
            },
            prepareLaunch: {
                label: 'Prepare delegated reviewer launch metadata',
                command: 'node bin/garda.js gate prepare-reviewer-launch --task-id "T-1"'
            },
            recordDelegationStartedChoices: [
                {
                    label: 'Record delegated reviewer start from launch artifact',
                    command: 'node bin/garda.js gate record-reviewer-delegation-started --task-id "T-1"'
                },
                {
                    label: 'Record delegated reviewer start from copy-paste prompt',
                    command: 'node bin/garda.js gate record-reviewer-delegation-started --task-id "T-1"'
                }
            ],
            recordDelegationStarted: {
                label: 'Record delegated reviewer start',
                command: 'node bin/garda.js gate record-reviewer-delegation-started --task-id "T-1"'
            },
            completeLaunch: {
                label: 'Complete delegated reviewer launch metadata',
                command: 'node bin/garda.js gate complete-reviewer-launch --task-id "T-1"'
            },
            recoverOrphanedLaunch: {
                label: 'Restart/supersede orphaned delegated reviewer launch',
                command: 'node bin/garda.js gate restart-review-cycle --task-id "T-1"'
            },
            recoverFailedLaunch: {
                label: 'Restart/supersede failed delegated reviewer launch',
                command: 'node bin/garda.js gate restart-review-cycle --task-id "T-1"'
            },
            recordInvocation: {
                label: 'Record delegated reviewer launch attestation',
                command: 'node bin/garda.js gate record-reviewer-invocation --task-id "T-1"'
            },
            recordResult: {
                label: 'Pipe delegated review output into stdin, then close reviewer',
                command: 'node bin/garda.js gate record-review-result --task-id "T-1"'
            }
        }
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'record-review-routing');
    assert.equal(route.commands[0]?.label, 'Record fresh delegated review routing');
    assert.match(route.title, /delegated reviewer routing/);
});
