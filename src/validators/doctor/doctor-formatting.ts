import { formatManifestResult } from '../validate-manifest';
import { formatVerifyResult } from '../verify';
import { resolveBundleName } from '../../core/constants';
import { getBundlePath } from '../workspace-layout';
import {
    formatProviderComplianceDetail
} from '../provider-compliance';
import { buildProfileAwareQueueNextLine } from '../task-command';
import { buildAgentInitializationRecoveryGuidance } from '../status/status-recommendations';
import type { DoctorResult } from '../doctor';

const ANSI_RED = '\x1b[31m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';

function color(text: string, ansiColor: string): string {
    return ansiColor + text + ANSI_RESET;
}

function normalizePathForDisplay(pathValue: string): string {
    return pathValue.replace(/\\/g, '/');
}

function pushViolationSamples(lines: string[], violations: readonly string[], limit: number): void {
    for (var i = 0; i < violations.length && i < limit; i++) {
        lines.push('  - ' + violations[i]);
    }
    if (violations.length > limit) {
        lines.push('  - ... ' + (violations.length - limit) + ' more');
    }
}

function hasProjectCommandsPendingViolation(violations: readonly string[]): boolean {
    return violations.some((violation) => /\bPROJECT_COMMANDS_PENDING\b/.test(violation));
}

function pushProjectCommandsRecoveryAction(lines: string[], result: DoctorResult): void {
    const guidance = buildAgentInitializationRecoveryGuidance({
        bundlePath: getBundlePath(result.targetRoot),
        resolvedTargetRoot: result.targetRoot,
        agentInitializationPendingReason: 'PROJECT_COMMANDS_PENDING'
    });
    lines.push(guidance.primary);
    for (const alternative of guidance.alternatives) {
        lines.push(alternative);
    }
}

function formatLargeModuleTaskRefs(
    ownerTasks: readonly { task_id: string; status: string }[],
    todoFollowUpExists: boolean
): string {
    if (ownerTasks.length === 0) {
        return ' owner=unknown follow_up=no';
    }
    const refs = ownerTasks.slice(0, 4).map((task) => `${task.task_id}(${task.status})`).join(', ');
    const suffix = ownerTasks.length > 4 ? `, +${ownerTasks.length - 4}` : '';
    return ` owner=${refs}${suffix} follow_up=${todoFollowUpExists ? 'yes' : 'no'}`;
}

function pushLargeModuleFileLines(
    lines: string[],
    title: string,
    entries: readonly {
        relative_path: string;
        line_count: number;
        owner_tasks: readonly { task_id: string; status: string }[];
        todo_follow_up_exists: boolean;
    }[]
): void {
    lines.push(`  ${title}:`);
    if (entries.length === 0) {
        lines.push('    none');
        return;
    }
    for (const entry of entries.slice(0, 5)) {
        lines.push(
            '    ' + entry.relative_path + ': ' + entry.line_count + ' lines' +
            formatLargeModuleTaskRefs(entry.owner_tasks, entry.todo_follow_up_exists)
        );
    }
}

function pushLargeModuleReport(lines: string[], result: DoctorResult): void {
    const report = result.largeModuleReport;
    const nextStepBudget = report.next_step_module_budget;
    lines.push('Large Module Decomposition Report');
    lines.push('  Mode: ' + report.mode);
    lines.push('  Role: recurring size and responsibility signal for decomposition work; report-only, non-blocking.');
    lines.push('  ScannedRoots: ' + (report.scanned_roots.length > 0 ? report.scanned_roots.join(', ') : 'none'));
    lines.push(
        '  Summary: files=' + report.summary.scanned_file_count +
        ', total_lines=' + report.summary.total_lines +
        ', largest_source=' + report.summary.largest_source_lines +
        ', largest_test=' + report.summary.largest_test_lines +
        ', files_with_follow_up=' + report.summary.files_with_todo_follow_up
    );
    lines.push(
        '  Next-step module budget: status=' + nextStepBudget.status +
        ', modules=' + nextStepBudget.total_module_count +
        ', total_lines=' + nextStepBudget.total_lines +
        ', coordinator_budget=' + nextStepBudget.coordinator_line_budget +
        ', helper_budget=' + nextStepBudget.helper_line_budget +
        ', largest_helper=' + nextStepBudget.largest_helper_lines +
        ', over_budget=' + nextStepBudget.over_budget_count
    );
    if (nextStepBudget.modules.length > 0) {
        lines.push('  Next-step modules:');
        for (const entry of nextStepBudget.modules.slice(0, 5)) {
            const exception = entry.exception_reason ? ' exception=' + entry.exception_reason : '';
            lines.push(
                '    ' + entry.relative_path + ': ' + entry.line_count + '/' + entry.line_budget +
                ' lines role=' + entry.role +
                ' status=' + entry.budget_status +
                ' responsibility=' + entry.responsibility +
                formatLargeModuleTaskRefs(entry.owner_tasks, entry.todo_follow_up_exists) +
                exception
            );
        }
    }
    pushLargeModuleFileLines(lines, 'Largest source/script files', report.top_source_files);
    pushLargeModuleFileLines(lines, 'Largest test files', report.top_test_files);
    lines.push('  Largest declarations:');
    if (report.top_declarations.length === 0) {
        lines.push('    none');
    } else {
        for (const declaration of report.top_declarations.slice(0, 5)) {
            lines.push(
                '    ' + declaration.relative_path + ':' + declaration.start_line +
                ' ' + declaration.declaration_kind + ' ' + declaration.declaration_name +
                ' spans ' + declaration.line_count + ' lines' +
                formatLargeModuleTaskRefs(declaration.owner_tasks, declaration.todo_follow_up_exists)
            );
        }
    }
    lines.push('');
}

function collectVerifyViolations(result: DoctorResult): string[] {
    const violations: string[] = [];
    const grouped = result.verifyResult.violations as unknown as Record<string, readonly string[] | undefined>;
    for (const key of Object.keys(grouped)) {
        const group = grouped[key];
        if (!group || group.length === 0) continue;
        for (const item of group) {
            violations.push(key + ': ' + item);
        }
    }
    return violations;
}

function formatDoctorFailureSummary(result: DoctorResult): string[] {
    if (result.passed) return [];

    const lines: string[] = [];
    lines.push(color('Doctor Failure Summary', ANSI_BOLD));
    lines.push('Status: ' + color('FAIL', ANSI_RED));
    lines.push('Read this section first; detailed evidence follows below.');

    const blockers: string[] = [];
    const verifyViolations = collectVerifyViolations(result);
    if (!result.verifyResult.passed) {
        blockers.push(
            'Verify failed: ' + result.verifyResult.totalViolationCount +
            ' violation(s); first details are listed below.'
        );
    }
    if (result.parityResult.isStale) {
        blockers.push('Source parity is STALE: source and deployed bundle differ.');
    }
    if (result.manifestError) {
        blockers.push('Manifest validation errored: ' + result.manifestError);
    } else if (result.manifestResult && !result.manifestResult.passed) {
        blockers.push('Manifest validation failed.');
    } else if (!result.manifestResult) {
        blockers.push('Manifest validation did not produce a result.');
    }
    if (result.protectedManifestEvidence && result.protectedManifestAssessment?.blocks) {
        blockers.push(
            'Protected Control-Plane Manifest is ' + result.protectedManifestEvidence.status +
            ' with ' + result.protectedManifestEvidence.changed_files.length + ' changed protected file(s).'
        );
    }
    if (result.lockHealth.stale_count > 0) {
        blockers.push('Task-event locks include ' + result.lockHealth.stale_count + ' stale lock(s).');
    }
    if (result.reviewLockHealth && result.reviewLockHealth.stale_count > 0) {
        blockers.push('Review artifact locks include ' + result.reviewLockHealth.stale_count + ' stale lock(s).');
    }
    if (result.completionFinalizationLockHealth && result.completionFinalizationLockHealth.stale_count > 0) {
        blockers.push('Completion finalization locks include ' + result.completionFinalizationLockHealth.stale_count + ' stale lock(s).');
    }
    if (result.providerComplianceResult && !result.providerComplianceResult.passed) {
        blockers.push('Provider control compliance failed.');
    }
    if (result.nestedBundleDuplication.duplicatesFound) {
        blockers.push('Nested Garda bundle duplication detected.');
    }
    if (!result.runtimeMismatchEvidence.passed) {
        blockers.push(
            'Runtime compatibility check failed for Node ' + result.runtimeMismatchEvidence.current_node_version +
            ' against ' + result.runtimeMismatchEvidence.required_range + '.'
        );
    }
    if (!result.permissionEvidence.passed) {
        blockers.push('Permission checks failed for one or more workspace paths.');
    }
    if (!result.rootScratchArtifactEvidence.passed) {
        blockers.push(
            'Repository root contains ' + result.rootScratchArtifactEvidence.found.length +
            ' forbidden reviewer scratch artifact(s).'
        );
    }
    if (!result.partialStateEvidence.passed) {
        blockers.push('Partial lifecycle state detected.');
    }
    if (!result.rollbackHealthEvidence.passed) {
        blockers.push('Rollback snapshot health is degraded.');
    }
    if (result.profileHealthEvidence && result.profileHealthEvidence.config_exists && !result.profileHealthEvidence.passed) {
        blockers.push('Profile health is degraded.');
    }

    if (blockers.length === 0) {
        blockers.push('Doctor failed; inspect detailed evidence below for the blocking subsystem.');
    }

    lines.push('Blockers:');
    pushViolationSamples(lines, blockers.map(function (item) { return color(item, ANSI_RED); }), 8);

    const actionLines: string[] = [];
    if (result.protectedManifestEvidence && result.protectedManifestAssessment?.blocks) {
        const changedFiles = result.protectedManifestEvidence.changed_files;
        actionLines.push('Inspect protected drift before repair:');
        for (var i = 0; i < changedFiles.length && i < 5; i++) {
            actionLines.push('  - ' + normalizePathForDisplay(changedFiles[i]));
        }
        if (changedFiles.length > 5) {
            actionLines.push('  - ... ' + (changedFiles.length - 5) + ' more');
        }
        actionLines.push('If the drift is operator-approved, run: node garda-agent-orchestrator/bin/garda.js repair protected-manifest --target-root "." --confirm');
    } else if (result.parityResult.isStale && result.parityResult.remediation) {
        actionLines.push(result.parityResult.remediation);
    } else if (result.lockHealth.stale_count > 0) {
        actionLines.push('Run: garda doctor --target-root "." --cleanup-stale-locks --dry-run');
    } else if (result.reviewLockHealth && result.reviewLockHealth.stale_count > 0) {
        actionLines.push('Run: garda doctor --target-root "." --cleanup-stale-locks --dry-run');
    } else if (hasProjectCommandsPendingViolation(verifyViolations)) {
        pushProjectCommandsRecoveryAction(actionLines, result);
    } else if (!result.runtimeMismatchEvidence.passed) {
        actionLines.push('Inspect runtime compatibility diagnostics, then rerun doctor.');
    } else if (!result.rootScratchArtifactEvidence.passed) {
        actionLines.push('Move or remove root reviewer scratch files after preserving any needed review output under runtime/tmp/reviews.');
    } else if (!result.partialStateEvidence.passed) {
        actionLines.push('Rerun update/rollback/setup instead of deleting lifecycle sentinels or locks manually.');
    } else {
        actionLines.push('Fix the blocker(s), then rerun: garda doctor --target-root "."');
    }

    lines.push('Next action:');
    for (const actionLine of actionLines) {
        lines.push('  ' + color(actionLine, ANSI_YELLOW));
    }

    if (verifyViolations.length > 0) {
        lines.push('First verify violation(s):');
        pushViolationSamples(lines, verifyViolations, 3);
    }

    return lines;
}

export function formatDoctorResult(result: DoctorResult): string {
    var lines: string[] = [];
    const failureSummary = formatDoctorFailureSummary(result);
    if (failureSummary.length > 0) {
        lines.push(...failureSummary);
        lines.push('');
        lines.push('Detailed Evidence');
        lines.push('');
    }
    lines.push(formatVerifyResult(result.verifyResult));
    lines.push('');

    // Source-vs-bundle parity summary.
    if (result.parityResult.isSourceCheckout) {
        lines.push('Source Parity (Self-hosted)');
        if (result.parityResult.isStale) {
            lines.push('  Status: STALE');
            for (var k = 0; k < result.parityResult.violations.length; k++) {
                lines.push('  Violation: ' + result.parityResult.violations[k]);
            }
            if (result.parityResult.remediation) {
                lines.push('  Fix: ' + result.parityResult.remediation);
            }
        } else {
            lines.push('  Status: MATCH');
            lines.push('  Version: ' + (result.parityResult.rootVersion || 'unknown'));
        }
        lines.push('');
    }

    if (result.manifestResult) lines.push(formatManifestResult(result.manifestResult));
    else if (result.manifestError) { lines.push('MANIFEST_VALIDATION_FAILED'); lines.push('Error: '+result.manifestError); }
    lines.push('');

    // Protected control-plane manifest early signal
    if (result.protectedManifestEvidence) {
        lines.push('Protected Control-Plane Manifest');
        lines.push('  Status: '+result.protectedManifestEvidence.status);
        lines.push('  ManifestPath: '+result.protectedManifestEvidence.manifest_path);
        lines.push('  Role: trusted protected control-plane baseline for lifecycle drift checks.');
        if (result.protectedManifestEvidence.status === 'DRIFT') {
            var driftFiles = result.protectedManifestEvidence.changed_files;
            lines.push('  DriftCount: '+driftFiles.length);
            for (var dfi = 0; dfi < driftFiles.length; dfi++) {
                lines.push('  - '+driftFiles[dfi]);
            }
            if (result.protectedManifestAssessment?.code === 'INFO_SOURCE_CHECKOUT') {
                lines.push('  Assessment: INFO_SOURCE_CHECKOUT');
                lines.push('  Impact: Informational in a self-hosted source checkout while protected source and generated bundle files evolve together.');
                lines.push('  Fix: Optional: re-run setup/update/reinit after intentional control-plane changes settle and you want to refresh the trusted manifest.');
            } else if (result.protectedManifestAssessment?.code === 'INFO_SOURCE_CHECKOUT_INHERITED_DRIFT') {
                lines.push('  Assessment: INFO_SOURCE_CHECKOUT_INHERITED_DRIFT');
                lines.push('  Impact: Informational for task start because the clean source checkout inherited protected-manifest drift from prior committed control-plane work.');
                lines.push('  Fix: Optional: run repair protected-manifest after operator verification to refresh the trusted manifest.');
            } else if (result.protectedManifestAssessment?.code === 'INFO_TASK_CONTEXT_ALLOWED_DRIFT') {
                lines.push('  Assessment: INFO_TASK_CONTEXT_ALLOWED_DRIFT');
                lines.push('  Impact: Informational because the current task context already explains this inherited protected drift.');
            } else {
                lines.push('  Fix: Re-run setup/update/reinit to refresh the trusted manifest, or verify changes are intentional.');
            }
        } else if (result.protectedManifestEvidence.status === 'INVALID') {
            lines.push('  Fix: Re-run setup/update/reinit to regenerate the trusted manifest.');
        }
        lines.push('');
    }

    // Timeline evidence summary
    if (result.timelineEvidence.length > 0) {
        lines.push('Timeline Evidence');
        lines.push('  Canonical: runtime/task-events/<task-id>.jsonl');
        lines.push('  Derived indexes: runtime/task-events/all-tasks.jsonl, runtime/task-events/.timeline-summary.json');
        for (var i = 0; i < result.timelineEvidence.length; i++) {
            var te = result.timelineEvidence[i];
            lines.push(
                '  ' + te.task_id + ': integrity=' + te.status +
                ', completeness=' + te.completeness_status +
                ' (' + te.integrity_event_count + ' events)'
            );
        }
        if (result.timelineWarnings.length > 0) {
            lines.push('Timeline Warnings');
            for (var j = 0; j < result.timelineWarnings.length; j++) {
                lines.push('  - ' + result.timelineWarnings[j]);
            }
        }
        lines.push('');
    }

    if (result.lockCleanup) {
        lines.push('Task-Event Lock Cleanup');
        lines.push('  Mode: ' + (result.lockCleanup.dry_run ? 'DRY_RUN' : 'APPLY'));
        lines.push('  LockRoot: ' + result.lockCleanup.lock_root);
        lines.push('  StaleCandidates: ' + result.lockCleanup.removable_stale_locks.length);
        lines.push('  Removed: ' + result.lockCleanup.removed_locks.length);
        if (result.lockCleanup.retained_live_locks.length > 0) {
            lines.push('  LiveLocksRetained: ' + result.lockCleanup.retained_live_locks.join(', '));
        }
        if (result.lockCleanup.failed_locks.length > 0) {
            lines.push('  CleanupFailures: ' + result.lockCleanup.failed_locks.join(', '));
        }
        for (const warning of result.lockCleanup.warnings) {
            lines.push('  Warning: ' + warning);
        }
        lines.push('');
    }

    if (result.lockHealth.locks.length > 0 || result.lockCleanup) {
        lines.push('Task-Event Locks');
        lines.push('  Scope: ' + result.lockHealth.subsystem_scope_note);
        lines.push('  Role: protects writes to canonical task timelines and derived task-event indexes.');
        lines.push(
            '  Summary: active=' + result.lockHealth.active_count +
            ', stale=' + result.lockHealth.stale_count
        );
        for (const lock of result.lockHealth.locks) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
            const ownerAliveText = lock.owner_alive === null ? 'unknown' : (lock.owner_alive ? 'yes' : 'no');
            const ownerHostText = lock.owner_hostname || 'unknown';
            lines.push(
                '  ' + lock.lock_name + ': ' + lock.status +
                ' scope=' + lock.scope +
                (lock.task_id ? ' task=' + lock.task_id : '') +
                ' age=' + ageText +
                ' owner_pid=' + ownerPidText +
                ' owner_alive=' + ownerAliveText +
                ' owner_host=' + ownerHostText +
                ' metadata=' + lock.owner_metadata_status +
                ' stale_reason=' + (lock.stale_reason || 'none')
            );
            lines.push('    Fix: ' + lock.remediation);
        }
        lines.push('');
    }

    if (result.reviewLockCleanup) {
        lines.push('Review Artifact Lock Cleanup');
        lines.push('  Mode: ' + (result.reviewLockCleanup.dry_run ? 'DRY_RUN' : 'APPLY'));
        lines.push('  LockRoot: ' + result.reviewLockCleanup.lock_root);
        lines.push('  StaleCandidates: ' + result.reviewLockCleanup.removable_stale_locks.length);
        lines.push('  Removed: ' + result.reviewLockCleanup.removed_locks.length);
        if (result.reviewLockCleanup.retained_live_locks.length > 0) {
            lines.push('  LiveLocksRetained: ' + result.reviewLockCleanup.retained_live_locks.join(', '));
        }
        if (result.reviewLockCleanup.failed_locks.length > 0) {
            lines.push('  CleanupFailures: ' + result.reviewLockCleanup.failed_locks.join(', '));
        }
        for (const warning of result.reviewLockCleanup.warnings) {
            lines.push('  Warning: ' + warning);
        }
        lines.push('');
    }

    if ((result.reviewLockHealth && result.reviewLockHealth.locks.length > 0) || result.reviewLockCleanup) {
        const reviewLockHealth = result.reviewLockHealth || {
            lock_root: '',
            subsystem_scope_note: '',
            locks: [],
            active_count: 0,
            stale_count: 0
        };
        lines.push('Review Artifact Locks');
        lines.push('  Scope: ' + reviewLockHealth.subsystem_scope_note);
        lines.push(
            '  Summary: active=' + reviewLockHealth.active_count +
            ', stale=' + reviewLockHealth.stale_count
        );
        for (const lock of reviewLockHealth.locks) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
            const ownerAliveText = lock.owner_alive === null ? 'unknown' : (lock.owner_alive ? 'yes' : 'no');
            const ownerHostText = lock.owner_hostname || 'unknown';
            lines.push(
                '  ' + lock.lock_name + ': ' + lock.status +
                (lock.task_id ? ' task=' + lock.task_id : '') +
                (lock.artifact_type ? ' artifact=' + lock.artifact_type : '') +
                ' age=' + ageText +
                ' owner_pid=' + ownerPidText +
                ' owner_alive=' + ownerAliveText +
                ' owner_host=' + ownerHostText +
                ' metadata=' + lock.owner_metadata_status +
                ' stale_reason=' + (lock.stale_reason || 'none')
            );
            lines.push('    Fix: ' + lock.remediation);
        }
        lines.push('');
    }

    if (result.completionFinalizationLockHealth && result.completionFinalizationLockHealth.locks.length > 0) {
        lines.push('Completion Finalization Locks');
        lines.push('  Scope: ' + result.completionFinalizationLockHealth.subsystem_scope_note);
        lines.push(
            '  AcquisitionPolicy: timeout=' + result.completionFinalizationLockHealth.acquisition_policy.timeout_ms +
            'ms, retry=' + result.completionFinalizationLockHealth.acquisition_policy.retry_ms +
            'ms, stale_after=' + result.completionFinalizationLockHealth.acquisition_policy.stale_after_ms + 'ms'
        );
        lines.push(
            '  Summary: active=' + result.completionFinalizationLockHealth.active_count +
            ', stale=' + result.completionFinalizationLockHealth.stale_count
        );
        lines.push('  Cleanup: doctor --cleanup-stale-locks does not remove completion finalization locks automatically.');
        for (const lock of result.completionFinalizationLockHealth.locks) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
            const ownerAliveText = lock.owner_alive === null ? 'unknown' : (lock.owner_alive ? 'yes' : 'no');
            const ownerHostText = lock.owner_hostname || 'unknown';
            lines.push(
                '  ' + lock.lock_name + ': ' + (lock.stale ? 'STALE' : 'ACTIVE') +
                ' task=' + lock.task_id +
                ' age=' + ageText +
                ' owner_pid=' + ownerPidText +
                ' owner_alive=' + ownerAliveText +
                ' owner_host=' + ownerHostText +
                ' metadata=' + lock.owner_metadata_status +
                ' stale_reason=' + (lock.stale_reason || 'none')
            );
            lines.push('    Fix: ' + lock.remediation);
        }
        lines.push('');
    }

    // Provider control compliance detail
    if (result.providerComplianceResult) {
        var complianceLines = formatProviderComplianceDetail(result.providerComplianceResult);
        for (const cl of complianceLines) {
            lines.push(cl);
        }
        lines.push('');
    }

    // Nested bundle duplication warning
    if (result.nestedBundleDuplication.duplicatesFound) {
        lines.push('Nested Bundle Duplication (IDE Index Risk)');
        lines.push('  Status: DUPLICATES_FOUND');
        for (const dp of result.nestedBundleDuplication.duplicatePaths) {
            lines.push('  Duplicate: ' + dp);
        }
        lines.push('  Fix: Remove nested copies or ensure .vscode/settings.json excludes them from indexing.');
        lines.push('');
    }

    // Runtime compatibility
    const runtimeWarnings = result.runtimeMismatchEvidence.warnings || [];
    const runtimeStatus = result.runtimeMismatchEvidence.passed
        ? (runtimeWarnings.length > 0 ? 'WARN' : 'OK')
        : 'FAILED';
    lines.push('Runtime Compatibility');
    lines.push('  Node: ' + result.runtimeMismatchEvidence.current_node_version);
    lines.push('  Required: ' + result.runtimeMismatchEvidence.required_range);
    lines.push('  Status: ' + runtimeStatus);
    for (const rv of result.runtimeMismatchEvidence.violations) {
        lines.push('  Violation: ' + rv);
    }
    for (const warning of runtimeWarnings) {
        lines.push('  Warning: ' + warning);
    }
    lines.push('');

    // Permission checks
    var permFailed = result.permissionEvidence.checks.filter(function (c) {
        return c.exists && !c.accessible;
    });
    if (permFailed.length > 0 || !result.permissionEvidence.passed) {
        lines.push('Permission Checks');
        lines.push('  Status: FAIL');
        for (const pf of permFailed) {
            lines.push('  ' + pf.path + ' (' + pf.kind + '): ' + (pf.error || 'not accessible'));
        }
        lines.push('  Fix: Ensure the current user has read/write access to the listed paths.');
        lines.push('');
    }

    if (!result.rootScratchArtifactEvidence.passed) {
        lines.push('Root Reviewer Scratch Artifacts');
        lines.push('  Status: FAIL');
        lines.push('  Root: ' + result.rootScratchArtifactEvidence.checked_root);
        lines.push('  ForbiddenNames: ' + result.rootScratchArtifactEvidence.forbidden_names.join(', '));
        for (const entry of result.rootScratchArtifactEvidence.found) {
            lines.push('  - ' + entry.path + ' kind=' + entry.kind);
        }
        lines.push('  Fix: Preserve needed review output, then move scratch files into runtime/tmp/reviews/<task-id>/<review-type>/ or remove them.');
        lines.push('');
    }

    // Partial-state detection
    if (!result.partialStateEvidence.passed) {
        lines.push('Partial State');
        lines.push('  Status: DETECTED');
        for (const pv of result.partialStateEvidence.violations) {
            lines.push('  - ' + pv);
        }
        lines.push('  Recovery: rerun update/rollback/setup instead of deleting lifecycle sentinels or locks manually.');
        lines.push('');
    }

    // Rollback health
    if (result.rollbackHealthEvidence.snapshot_count > 0) {
        lines.push('Rollback Snapshots');
        lines.push('  Root: ' + result.rollbackHealthEvidence.snapshots_root);
        lines.push('  Count: ' + result.rollbackHealthEvidence.snapshot_count);
        lines.push('  Status: ' + (result.rollbackHealthEvidence.passed ? 'HEALTHY' : 'DEGRADED'));
        for (const snap of result.rollbackHealthEvidence.snapshots) {
            lines.push(
                '  ' + snap.name + ': records=' + (snap.has_records ? 'present' : 'MISSING') +
                (snap.has_records ? ' valid=' + (snap.records_valid ? 'yes' : 'no') : '')
            );
        }
        if (result.rollbackHealthEvidence.violations.length > 0) {
            for (const rbv of result.rollbackHealthEvidence.violations) {
                lines.push('  Warning: ' + rbv);
            }
        }
        lines.push('');
    }

    if (result.taskHistoryLedgerSummary.file_count > 0) {
        lines.push('Task History Ledgers');
        lines.push('  Root: ' + result.taskHistoryLedgerSummary.root_path);
        lines.push('  Files: ' + result.taskHistoryLedgerSummary.file_count);
        lines.push(
            '  Status: verified=' + result.taskHistoryLedgerSummary.verified_count +
            ', incomplete=' + result.taskHistoryLedgerSummary.incomplete_count +
            ', contradictory=' + result.taskHistoryLedgerSummary.contradictory_count +
            ', invalid=' + result.taskHistoryLedgerSummary.invalid_count
        );
        lines.push('');
    }

    pushLargeModuleReport(lines, result);

    // Profile health
    if (result.profileHealthEvidence) {
        lines.push('Profile Health');
        if (result.profileHealthEvidence.config_exists) {
            lines.push('  ActiveProfile: ' + (result.profileHealthEvidence.active_profile || 'none'));
            if (result.profileHealthEvidence.profile_source) {
                lines.push('  ProfileSource: ' + result.profileHealthEvidence.profile_source);
            }
            lines.push('  ProfileCount: ' + result.profileHealthEvidence.profile_count);
            lines.push('  Status: ' + (result.profileHealthEvidence.passed ? 'HEALTHY' : 'DEGRADED'));
            for (const pv of result.profileHealthEvidence.violations) {
                lines.push('  - ' + pv);
            }
        } else {
            lines.push('  Status: NOT_CONFIGURED');
        }
        lines.push('');
    }

    if (result.passed) {
        lines.push('Doctor: PASSED');
        lines.push(buildProfileAwareQueueNextLine(result.targetRoot, getBundlePath(result.targetRoot), `node ${resolveBundleName()}/bin/garda.js`));
    }
    else { lines.push('Doctor: FAIL'); lines.push('Resolve listed issues and rerun doctor.'); }
    lines.push(...(result.trackedBundleWarnings || []).map(warning => 'Warning: ' + warning));
    lines.push(...(result.ruleRefreshWarnings || []).map(warning => 'Warning: ' + warning));
    return lines.join('\n');
}

/**
 * Format doctor result in compact mode.
 * On success: single summary line. On failure: full output (delegates to formatDoctorResult).
 */
export function formatDoctorResultCompact(result: DoctorResult): string {
    if (!result.passed || result.trackedBundleWarnings?.length || result.ruleRefreshWarnings?.length) {
        return formatDoctorResult(result);
    }
    const manifestStatus = result.manifestResult
        ? (result.manifestResult.passed ? 'PASSED' : 'FAIL')
        : (result.manifestError ? 'ERROR' : 'SKIPPED');
    const profileSuffix = result.profileHealthEvidence && result.profileHealthEvidence.active_profile
        ? ` | profile=${result.profileHealthEvidence.active_profile}`
        : '';
    return `Doctor: PASSED | verify=PASSED | manifest=${manifestStatus}${profileSuffix}`;
}

export function formatDoctorResultJson(result: DoctorResult): string {
    return JSON.stringify(result, null, 2);
}
