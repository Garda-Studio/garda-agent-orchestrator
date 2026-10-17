import * as path from 'node:path';

import {
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    buildBundleRelativePath as buildCoreBundleRelativePath,
    resolveBundleNameForTarget
} from '../../core/constants';
import { quoteCommandValue as quoteShellCommandValue } from '../../core/command-quoting';
import type {
    NextStepCommand,
    NextStepResult
} from './';
import type {
    NextStepProjectMemorySummary
} from './next-step-doc-closeout-readiness';
import {
    formatKnownNonBlockingSignals
} from '../shared/known-nonblocking-signals';
import { buildOperatorNextActionBlock } from '../shared/operator-action-output';

function formatInlineText(value: string): string {
    return value.replace(/[\r\n\u2028\u2029]+/gu, ' ').trim();
}

export function buildCommand(label: string, command: string): NextStepCommand {
    return { label, command };
}

export function buildNavigatorCommand(cliPrefix: string, taskId: string): string {
    return `${cliPrefix} next-step "${taskId}" --repo-root "."`;
}

export function buildProjectMemoryImpactCommand(
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    projectMemory: NextStepProjectMemorySummary
): string {
    const parts = [
        `${cliPrefix} gate project-memory-impact`,
        `--task-id "${taskId}"`,
        `--mode ${quoteCommandValue(projectMemory.mode)}`,
        `--preflight-path "${preflightCommandPath}"`
    ];
    if (
        projectMemory.update_needed === true
        && projectMemory.affected_memory_files.length > 0
        && !projectMemory.command_update_inference_error
    ) {
        parts.push('--confirm-updated');
        const updatedMemoryFiles = projectMemory.command_updated_memory_files;
        const updatedMemoryFileSet = new Set(updatedMemoryFiles);
        const skippedMemoryFiles = projectMemory.command_skipped_memory_files.length > 0
            ? projectMemory.command_skipped_memory_files
            : projectMemory.affected_memory_files.filter((candidate) => !updatedMemoryFileSet.has(candidate));
        for (const file of updatedMemoryFiles) {
            parts.push(`--updated-memory-file ${quoteCommandValue(file)}`);
        }
        for (const file of skippedMemoryFiles) {
            parts.push(`--skipped-memory-file ${quoteCommandValue(file)}`);
        }
        parts.push('--skip-unchanged-candidates-rationale "Current project-memory content already covers unedited candidate files; no additional durable map change is needed for this task impact."');
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function quoteCommandValue(value: string): string {
    return quoteShellCommandValue(value);
}

export function buildBundleRelativePath(repoRoot: string, relativePath: string): string {
    return normalizePath(buildCoreBundleRelativePath(relativePath, resolveBundleNameForTarget(repoRoot)));
}

export function toRepoDisplayPath(repoRoot: string, filePath: string): string {
    const resolved = resolvePathInsideRepo(filePath, repoRoot, { allowMissing: true });
    if (!resolved) {
        return normalizePath(filePath);
    }
    return normalizePath(path.relative(repoRoot, resolved));
}

export function formatNextStepText(result: NextStepResult): string {
    const primaryCommand = result.commands.length === 1 ? result.commands[0] : null;
    const commandReference = result.status === 'DONE'
        ? 'none'
        : result.commands.length > 1
            ? `choose one of the ${result.commands.length} Commands entries below`
            : 'inspect diagnostics; no executable command is available';
    const detailsPath = result.final_report?.closeout_json_path
        || `garda-agent-orchestrator/runtime/task-events/${result.task_id}.jsonl`;
    const lines = [
        ...buildOperatorNextActionBlock({
            status: result.status,
            gate: result.next_gate || 'none',
            action: primaryCommand?.label || result.title,
            reason: result.reason,
            command: primaryCommand?.command,
            commandReference,
            detailsPath,
            detailsHint: `For structured diagnostics, rerun the navigator with --as-json.`
        }),
        '',
        'GARDA_NEXT_STEP',
        `Task: ${result.task_id}`,
        `Navigator: ${result.navigator_command}`,
        'Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints.',
        `Status: ${result.status}`,
        `NextGate: ${result.next_gate || 'none'}`
    ];
    if (result.warnings.length > 0) {
        lines.push('Warnings:');
        for (const warning of result.warnings) {
            lines.push(`  - ${warning}`);
        }
    }
    if (result.review_cycle_block) {
        const block = result.review_cycle_block;
        lines.push(`OperatorDecisionRequired: ${block.operator_decision_required}`);
        lines.push(`ReviewCycleBlock: reason=${formatNextStepInlineValue(block.reason)}; auto_split_enabled=${block.auto_split_enabled}; wait_for_operator=${block.wait_for_operator}`);
        lines.push(
            `ReviewCycleCounts: total_non_test_reviews=${block.total_non_test_review_count}; ` +
            `failed_non_test_reviews=${block.failed_non_test_review_count}; ` +
            `excluded_review_types=${formatNextStepInlineList(block.excluded_review_types)}`
        );
        lines.push(
            `ReviewCycleCumulativeCounts: total_non_test_reviews=${block.cumulative_total_non_test_review_count}; ` +
            `failed_non_test_reviews=${block.cumulative_failed_non_test_review_count}; ` +
            `fresh_non_test_reviews=${block.fresh_non_test_review_count}; ` +
            `reused_non_test_reviews=${block.reused_non_test_review_count}`
        );
        lines.push(
            `ReviewCycleCurrentScopeCounts: total_non_test_reviews=${block.current_scope_total_non_test_review_count}; ` +
            `failed_non_test_reviews=${block.current_scope_failed_non_test_review_count}`
        );
        lines.push(
            `ReviewCycleLimits: max_total_non_test_reviews=${block.max_total_non_test_reviews}; ` +
            `max_failed_non_test_reviews=${block.max_failed_non_test_reviews}`
        );
        const countEntries = Object.entries(block.counts_by_review_type);
        lines.push('ReviewCycleCountsByType:');
        if (countEntries.length === 0) {
            lines.push('  none');
        } else {
            for (const [reviewType, counts] of countEntries) {
                lines.push(`  ${formatNextStepInlineValue(reviewType)}: total=${counts.total}; passed=${counts.passed}; failed=${counts.failed}; pending=${counts.pending}`);
            }
        }
        const currentScopeEntries = Object.entries(block.current_scope_counts_by_review_type);
        lines.push('ReviewCycleCurrentScopeCountsByType:');
        if (currentScopeEntries.length === 0) {
            lines.push('  none');
        } else {
            for (const [reviewType, counts] of currentScopeEntries) {
                lines.push(`  ${formatNextStepInlineValue(reviewType)}: total=${counts.total}; passed=${counts.passed}; failed=${counts.failed}; pending=${counts.pending}`);
            }
        }
        const freshReuseEntries = Object.entries(block.fresh_reused_by_review_type);
        lines.push('ReviewCycleFreshReuseByType:');
        if (freshReuseEntries.length === 0) {
            lines.push('  none');
        } else {
            for (const [reviewType, counts] of freshReuseEntries) {
                lines.push(`  ${formatNextStepInlineValue(reviewType)}: fresh=${counts.fresh}; reused=${counts.reused}`);
            }
        }
        const scopeHashEntries = Object.entries(block.top_scope_hashes_by_review_type);
        lines.push('ReviewCycleTopScopeHashesByType:');
        if (scopeHashEntries.length === 0) {
            lines.push('  none');
        } else {
            for (const [reviewType, scopeHashes] of scopeHashEntries) {
                const uniqueCount = block.scope_hash_count_by_review_type[reviewType] ?? scopeHashes.length;
                const topScopeHashes = scopeHashes
                    .map((entry) =>
                        `${entry.scope_hash}:total=${entry.total};failed=${entry.failed};passed=${entry.passed};pending=${entry.pending};fresh=${entry.fresh};reused=${entry.reused};current_scope=${entry.current_scope}`
                    )
                    .join(', ');
                lines.push(`  ${formatNextStepInlineValue(reviewType)}: unique=${uniqueCount}; top=${topScopeHashes || 'none'}`);
            }
        }
        if (block.latest_failed_review) {
            const latest = block.latest_failed_review;
            const summary = latest.summary ? `; summary=${formatNextStepInlineValue(latest.summary)}` : '';
            const artifactPath = latest.review_artifact_path ? `; artifact=${formatNextStepInlineValue(latest.review_artifact_path)}` : '';
            lines.push(
                `LatestFailedReview: review_type=${formatNextStepInlineValue(latest.review_type)}; event=${formatNextStepInlineValue(latest.event_type)}; ` +
                `outcome=${formatNextStepInlineValue(latest.outcome || 'unknown')}; sequence=${latest.sequence}${artifactPath}${summary}`
            );
        } else {
            lines.push('LatestFailedReview: none');
        }
        lines.push(`TestReviewExcluded: ${block.excluded_review_types.includes('test')}`);
        lines.push(`OperatorChoices: ${block.choices.join(', ')}`);
        if (block.operator_choice_guidance.length > 0) {
            lines.push('OperatorChoiceGuidance:');
            for (const guidance of block.operator_choice_guidance) {
                lines.push(`  - ${guidance}`);
            }
        }
        if (block.auto_split_prompt) {
            lines.push(
                `AutoSplitPromptArtifact: path=${formatNextStepInlineValue(block.auto_split_prompt.artifact_path)}; ` +
                `sha256=${block.auto_split_prompt.artifact_sha256}; next_action=${block.auto_split_prompt.next_action}`
            );
            lines.push(`AutoSplitInstructions: ${block.auto_split_prompt.instructions.join(', ')}`);
            lines.push(`AutoSplitConstraints: ${block.auto_split_prompt.constraints.join(', ')}`);
        }
    }
    if (result.profile) {
        lines.push(`TaskProfile: ${result.profile.task_selected_profile || 'default'} (${result.profile.profile_selection_source || 'unknown'})`);
        if (result.profile.runtime_active_profile) {
            lines.push(`RuntimeActiveProfile: ${result.profile.runtime_active_profile} (${result.profile.runtime_active_profile_source || 'unknown'})`);
        }
        if (result.profile.effective_profile) {
            lines.push(`EffectiveProfile: ${result.profile.effective_profile} (${result.profile.effective_profile_source || 'unknown'})`);
        }
        if (result.profile.total_forecast_tokens != null) {
            const tokenParts = [`total~${result.profile.total_forecast_tokens}`];
            if (result.profile.effective_forecast_tokens != null) {
                tokenParts.push(`effective~${result.profile.effective_forecast_tokens}`);
            }
            if (result.profile.token_economy_active_for_depth != null) {
                tokenParts.push(`token_economy_active=${result.profile.token_economy_active_for_depth}`);
            }
            lines.push(`TokenBudget: ${tokenParts.join('; ')}`);
        }
    }
    if (result.markdown_working_plan) {
        lines.push(`MarkdownWorkingPlanPath: ${result.markdown_working_plan.working_plan_path}`);
        lines.push(`MarkdownWorkingPlanSha256: ${result.markdown_working_plan.working_plan_sha256}`);
    }
    if (result.full_suite_validation.config_source === 'unavailable_workflow_config') {
        lines.push(`FullSuite: unavailable; ${result.full_suite_validation.note}`);
    } else {
        lines.push(`FullSuite: enabled=${result.full_suite_validation.enabled}; placement=${result.full_suite_validation.placement}; command="${result.full_suite_validation.command}"; config=${result.full_suite_validation.config_path}`);
    }
    if (result.full_suite_validation.performance_guidance_note) {
        lines.push(`FullSuitePerformance: ${result.full_suite_validation.performance_guidance_note}`);
    }
    if (result.full_suite_validation.timeout_forecast_note) {
        lines.push(`FullSuiteTimeout: ${result.full_suite_validation.timeout_forecast_note}`);
    }
    if (result.project_memory) {
        lines.push(result.project_memory.visible_summary_line);
        if (result.project_memory.command_updated_memory_files.length > 0) {
            lines.push(`ProjectMemoryCommandUpdatedFiles: ${result.project_memory.command_updated_memory_files.join(', ')}`);
        }
        if (
            result.project_memory.command_skipped_memory_files.length > 0
            && !result.project_memory.command_update_inference_error
        ) {
            lines.push(`ProjectMemoryCommandSkippedFiles: ${result.project_memory.command_skipped_memory_files.join(', ')}`);
        }
        if (result.project_memory.command_update_inference_error) {
            lines.push(`ProjectMemoryCommandUpdateInference: ${result.project_memory.command_update_inference_error}`);
        }
    }
    if (result.optional_skill_selection) {
        const optionalSkills = result.optional_skill_selection;
        if (optionalSkills.visible_summary_line) {
            lines.push(optionalSkills.visible_summary_line);
        }
        lines.push(
            `OptionalSkillDecision: policy=${optionalSkills.policy_mode || 'unknown'}; ` +
            `decision=${optionalSkills.decision || 'unknown'}; artifact=${optionalSkills.artifact_path || 'none'}; ` +
            `present=${optionalSkills.artifact_present}`
        );
        if (optionalSkills.current_policy_mode) {
            lines.push(`OptionalSkillCurrentPolicyMode: ${optionalSkills.current_policy_mode}`);
        }
        lines.push(
            `OptionalSkillPhase: ${optionalSkills.selection_phase}; ` +
            `path_evidence_source=${optionalSkills.path_evidence_source}`
        );
        if (optionalSkills.post_diff_self_check) {
            lines.push('OptionalSkillPostDiffSelfCheck: true');
        }
        if (optionalSkills.timeline_invalid_json) {
            lines.push('OptionalSkillTimelineInvalidJson: true');
        }
        if (optionalSkills.artifact_violations.length > 0) {
            lines.push(`OptionalSkillArtifactViolations: ${optionalSkills.artifact_violations.join(' ')}`);
        }
        if (optionalSkills.selected_skill_ids.length > 0) {
            lines.push(`OptionalSkillSelected: ${optionalSkills.selected_skill_ids.join(', ')}`);
        }
        if (optionalSkills.selected_skill_details.length > 0) {
            lines.push(`OptionalSkillSelectedDetails: ${optionalSkills.selected_skill_details.map((entry) => `${entry.id}:${entry.source}:${entry.allowed_skill_path}`).join(', ')}`);
        } else if (optionalSkills.selected_skill_sources.length > 0) {
            lines.push(`OptionalSkillSelectedSources: ${optionalSkills.selected_skill_sources.join(', ')}`);
        }
        if (optionalSkills.activated_skill_ids.length > 0) {
            lines.push(`OptionalSkillActivatedCurrentCycle: ${optionalSkills.activated_skill_ids.join(', ')}`);
        }
        if (optionalSkills.declined_skill_ids.length > 0) {
            lines.push(`OptionalSkillDeclined: ${optionalSkills.declined_skill_ids.join(', ')}`);
        }
        if (optionalSkills.pending_activation_skill_ids.length > 0) {
            lines.push(`OptionalSkillPendingActivation: ${optionalSkills.pending_activation_skill_ids.join(', ')}`);
        }
        if (optionalSkills.recommended_missing_pack_ids.length > 0) {
            lines.push(`OptionalSkillRecommendedMissingPacks: ${optionalSkills.recommended_missing_pack_ids.join(', ')}`);
        }
        if (optionalSkills.skill_catalog_path) {
            lines.push(`OptionalSkillCatalog: ${optionalSkills.skill_catalog_path}`);
        }
        lines.push(`OptionalSkillTaskStartInstruction: ${optionalSkills.task_start_instruction}`);
        if (optionalSkills.activation_commands.length > 0) {
            lines.push('OptionalSkillActivationCommands:');
            for (const command of optionalSkills.activation_commands) {
                lines.push(`  - ${command}`);
            }
        }
        if (optionalSkills.decline_commands.length > 0) {
            lines.push('OptionalSkillDeclineCommands:');
            for (const command of optionalSkills.decline_commands) {
                lines.push(`  - ${command}`);
            }
        }
    }
    if (result.task_start_guidance) {
        const guidance = result.task_start_guidance;
        if (guidance.skill.mode === 'direct') {
            const activationState = guidance.skill.activation_commands.length > 0
                ? 'guarded activation command(s) are listed above'
                : 'no activation command is pending';
            lines.push(
                `TaskStartSkillSuggestion: ${guidance.skill.suggested_skill_ids.join(', ')}; ${activationState}`
            );
        } else {
            lines.push(
                `TaskStartSkillCatalog: relevant=none; catalog=${guidance.skill.catalog_path || 'unavailable'}`
            );
        }
        if (guidance.review) {
            const reviewLaneSummary = guidance.review.lanes.length > 0
                ? guidance.review.lanes.map((lane) => (
                    `${lane.id}:${formatInlineText(lane.display_label)}:${lane.selection}:profile_${lane.profile_state}`
                )).join(', ')
                : 'none';
            const omittedSuffix = guidance.review.omitted_lane_count > 0
                ? `; omitted=${guidance.review.omitted_lane_count}`
                : '';
            lines.push(
                `TaskStartReview${guidance.review.mode === 'direct' ? 'Suggestion' : 'Catalog'}: ` +
                `${reviewLaneSummary}${omittedSuffix}; advisory_only=true`
            );
            lines.push(
                'TaskStartReviewPolicy: guidance never makes a lane mandatory; catalog/profile policy and RequiredReviews remain authoritative.'
            );
        }
    }
    if (result.quality_checklist) {
        lines.push(result.quality_checklist.visible_summary_line);
    }
    lines.push(`ReviewExecutionOrder: ${result.review.review_execution_policy_mode} (${result.review.review_execution_policy_source})`);
    const findingPolicyActions = result.review.review_finding_policy_actions;
    lines.push(
        `FindingPolicy: ${result.review.review_finding_policy_id} (${result.review.review_finding_policy_source}); `
        + `critical=${findingPolicyActions.critical}; high=${findingPolicyActions.high}; `
        + `medium=${findingPolicyActions.medium}; low=${findingPolicyActions.low}; `
        + `residual_risk=${findingPolicyActions.residual_risk}`
    );
    if (result.review.required_reviews.length > 0) {
        lines.push(`RequiredReviews: ${result.review.required_reviews.join(', ')}`);
    } else {
        lines.push('RequiredReviews: none');
    }
    if (result.review.launchable_review_types.length > 0) {
        lines.push(`ReviewLaunchableBatch: ${result.review.launchable_review_types.join(', ')}`);
    }
    if (result.review.blocked_review_lanes.length > 0) {
        const blockedLanes = result.review.blocked_review_lanes
            .map((lane) => `${lane.review_type} blocked by ${lane.blocked_by.join(', ') || 'unknown'}`)
            .join('; ');
        lines.push(`BlockedReviewLanes: ${blockedLanes}`);
    }
    if (result.review.failed_review_type) {
        lines.push(`ReviewFailedCurrent: ${result.review.failed_review_type}`);
    }
    if (result.review.ordinary_doc_review_skips.length > 0 && result.review.required_reviews.length === 0) {
        const skipped = result.review.ordinary_doc_review_skips
            .map((entry) => `${entry.path} (matched ${entry.pattern})`)
            .join('; ');
        lines.push(`OrdinaryDocReviewSkips: ${skipped}`);
    }
    if (result.review.next_review_type) {
        lines.push(`NextReview: ${result.review.next_review_type}`);
    }
    if (result.review.blocked_review_dependencies.length > 0) {
        lines.push(`ReviewBlockedBy: ${result.review.blocked_review_dependencies.join(', ')}`);
        lines.push(`BlockedReviewerLaunches: do not prepare or launch '${result.review.next_review_type}' until current-cycle ${result.review.blocked_review_dependencies.join(', ')} review artifacts and receipts pass.`);
    }
    if (result.review.trust_note) {
        lines.push(result.review.trust_note);
    }
    if (result.invalidation_impact) {
        lines.push('InvalidationImpact:');
        lines.push(`  StaleArtifacts: ${result.invalidation_impact.stale_artifact_classes.join(', ') || 'none'}`);
        lines.push(`  AffectedReviewLanes: ${result.invalidation_impact.affected_review_lanes.join(', ') || 'none'}`);
        lines.push(`  MinimalRecoveryChain: ${result.invalidation_impact.minimal_recovery_chain.join(' -> ') || 'none'}`);
        lines.push(`  ReuseCandidates: ${result.invalidation_impact.reuse_candidates.join('; ') || 'none indicated'}`);
    }
    const knownNonBlockingSignalsLine = formatKnownNonBlockingSignals(result.known_non_blocking_signals || []);
    if (knownNonBlockingSignalsLine) {
        lines.push(knownNonBlockingSignalsLine);
    }
    lines.push(result.task_queue_status_contract.visible_summary_line);
    if (result.missing_artifacts.length > 0) {
        lines.push(`MissingArtifacts: ${result.missing_artifacts.map((artifact) => artifact.key).join(', ')}`);
    }
    if (result.final_report) {
        lines.push(`FinalUserReportPath: ${result.final_report.final_user_report_path}`);
        lines.push(`CopyPasteFinalUserReportSha256: ${result.final_report.final_user_report_sha256}`);
        lines.push(`CopyPasteFinalUserReport:\n${result.final_report.final_user_report_body}`);
        lines.push('FinalUserReportInstruction: write a short summary of what you did, then paste the compact CopyPasteFinalUserReport exactly as printed; do not expand referenced audit artifacts into chat; after that, present only the commit command and commit permission question listed in FinalReportOrder.');
        lines.push(`CloseoutArtifact: ${result.final_report.closeout_json_path}`);
        lines.push(`CloseoutMarkdown: ${result.final_report.closeout_markdown_path}`);
        lines.push('FinalReportOrder:');
        for (const [index, entry] of result.final_report.required_order.entries()) {
            lines.push(`  ${index + 1}. ${entry}`);
        }
    }
    if (result.commands.length > 0 || result.final_report) {
        lines.push('');
        lines.push('Commands:');
        if (result.commands.length === 0) {
            lines.push('  none');
        } else {
            for (const command of result.commands) {
                lines.push(`  ${command.label}: ${command.command}`);
            }
        }
    }
    if (result.status !== 'DONE' && result.review_cycle_block?.auto_split_prompt) {
        lines.push('AfterCommand: follow AutoSplitPromptArtifact instructions; do not run parent compile, review, or full-suite gates before split handling.');
    } else if (result.status !== 'DONE' && result.review_cycle_block) {
        lines.push(result.commands.length > 0
            ? `AfterCommand: after the operator-approved command above completes, rerun ${result.navigator_command}; do not run compile, review, or full-suite gates before the approval evidence exists.`
            : 'AfterCommand: inspect diagnostics only if needed, then wait for operator choice; do not run compile, review, or full-suite gates.');
    } else if (result.status !== 'DONE') {
        lines.push(`AfterCommand: rerun ${result.navigator_command} after the command above completes.`);
    }
    return `${lines.join('\n')}\n`;
}

export function formatNextStepInlineValue(value: string): string {
    return JSON.stringify(value);
}

export function formatNextStepInlineList(values: string[]): string {
    return values.length > 0
        ? values.map((value) => formatNextStepInlineValue(value)).join(',')
        : 'none';
}
