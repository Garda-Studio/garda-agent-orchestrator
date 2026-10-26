import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256 } from '../../../../src/core/file-hashing';
import { assessTrustBoundaryAnalysisApplicability } from '../../../../src/core/trust-boundary-analysis';
import { resolveReviewRemediationModePolicyFromSnapshot } from '../../../../src/policy/review-remediation-mode-policy';
import { validateTaskProfilePolicySnapshot, resolveTaskProfileReviewTriggerPolicy } from '../../../../src/policy/task-profile-policy-snapshot';
import { classifyReviewRemediationDelta } from '../../../../src/gates/review-remediation/review-remediation-delta';
import { resolveRuntimeReviewRemediationModeGuards } from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import type { AuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';

export function classifyHistoryRemediation(state: AuthenticatedHistoryFixture, baselinePath: string, expectDelta: boolean) {
    const preflight = JSON.parse(fs.readFileSync(state.preflightPath, 'utf8'));
    const mode = JSON.parse(fs.readFileSync(path.join(path.dirname(state.preflightPath), state.taskId + '-task-mode.json'), 'utf8'));
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const profile = validateTaskProfilePolicySnapshot(mode.profile_policy_snapshot);
    assert.equal(profile.status, 'PASS', profile.violations.join(' '));
    assert.ok(profile.snapshot);
    assert.equal(profile.snapshot.snapshot_hash, preflight.profile_policy_snapshot.snapshot_hash);
    const guards = resolveRuntimeReviewRemediationModeGuards({ currentChangedFiles: state.files, preflightPayload: preflight,
        authenticatedTaskCriteria: mode.task_summary, currentTaskCriteria: mode.task_summary });
    assert.equal(assessTrustBoundaryAnalysisApplicability(preflight).required, true);
    assert.deepEqual(guards.protectedBoundarySignals, []);
    const policy = resolveReviewRemediationModePolicyFromSnapshot(profile.snapshot);
    const triggers = resolveTaskProfileReviewTriggerPolicy(profile.snapshot);
    const inputs = { ...guards, consecutiveDeltaReviews: 0, uncertainCrossFileImpact: false };
    const delta = classifyReviewRemediationDelta({ repoRoot: state.repoRoot, taskId: state.taskId, reviewType: 'test',
        baselineArtifactPath: baselinePath, baselineArtifactSha256: fileSha256(baselinePath)!, currentChangedFiles: state.files,
        testPathRegexes: triggers.test_path_regexes, fileRoles: triggers.file_roles,
        structuralTestPathRegexes: triggers.test_refactor_structural_path_regexes,
        structuralTestChangedLinesThreshold: triggers.test_refactor_changed_lines_threshold,
        modePolicy: policy.policy, modePolicyLegacyFallback: policy.legacy_fallback, ...inputs });
    assert.equal(delta.full_review_required, !expectDelta, JSON.stringify(delta.full_review_reasons));
    return { inputs, classification: { source: 'delta' as const, delta,
        profilePolicySnapshot: profile.snapshot,
        baselineProfilePolicySnapshotSha256: baseline.bindings.policy.profile_policy_snapshot_sha256 } };
}
