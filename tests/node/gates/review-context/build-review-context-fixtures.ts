import assertModule from 'node:assert/strict';
import * as cryptoModule from 'node:crypto';
import * as fsModule from 'node:fs';
import * as osModule from 'node:os';
import * as pathModule from 'node:path';
import * as childProcessModule from 'node:child_process';

import { runGitFixtureCommand } from '../git-fixtures';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import {
    assessTrustBoundaryAnalysisApplicability,
    TRUST_BOUNDARY_ANALYSIS_RULE_ID
} from '../../../../src/core/trust-boundary-analysis';
import {
    QUALITY_CHECKLIST_ID,
    resolveDefaultQualityChecklistArtifactPath
} from '../../../../src/gates/quality-checklist';
import { buildReviewContext as buildReviewContextImplementation, getRulePack, toNonNegativeInt, resolveContextOutputPath, resolveScopedDiffMetadataPath } from '../../../../src/gates/review-context/build-review-context';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { buildChangedFileFingerprintEntries } from '../../../../src/gates/review-context/review-context-diff';
import { buildReviewTreeState } from '../../../../src/gates/review/review-tree-state';
import {
    getCanonicalReviewContextPath,
    getLegacyDefaultReviewContextPath,
    resolveCanonicalReviewContextPath
} from '../../../../src/gates/review-context/review-context-paths';
import { computeReviewContextReuseHash } from '../../../../src/gates/review-reuse';
import { buildTaskModeArtifact, getTaskModeEvidence, resolveTaskModeArtifactPath } from '../../../../src/gates/task-mode';
import { resolveReviewerRoutingPolicy, resolveRuntimeReviewerIdentity } from '../../../../src/gates/review/reviewer-routing';
import { REVIEW_CONTRACTS } from '../../../../src/gates/required-reviews/required-reviews-check';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import { BUILT_IN_REVIEW_TYPE_IDS } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';

export const assert: typeof assertModule = assertModule;
export const crypto: typeof cryptoModule = cryptoModule;
export const fs: typeof fsModule = fsModule;
export const os: typeof osModule = osModule;
export const path: typeof pathModule = pathModule;
export const childProcess: typeof childProcessModule = childProcessModule;

export {
    appendTaskEvent,
    getRulePack,
    toNonNegativeInt,
    resolveContextOutputPath,
    resolveScopedDiffMetadataPath,
    getWorkspaceSnapshot,
    buildChangedFileFingerprintEntries,
    buildReviewTreeState,
    getCanonicalReviewContextPath,
    getLegacyDefaultReviewContextPath,
    resolveCanonicalReviewContextPath,
    computeReviewContextReuseHash,
    buildTaskModeArtifact,
    getTaskModeEvidence,
    resolveTaskModeArtifactPath,
    resolveReviewerRoutingPolicy,
    resolveRuntimeReviewerIdentity,
    REVIEW_CONTRACTS,
    serializeTaskPlan,
    validateTaskPlan
};

function seedApplicableTrustBoundaryAnalysisFixture(
    options: Parameters<typeof buildReviewContextImplementation>[0]
): void {
    const repoRoot = pathModule.resolve(options.repoRoot || '.');
    const preflightPath = pathModule.resolve(String(options.preflightPath || ''));
    const preflight = JSON.parse(fsModule.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const applicability = assessTrustBoundaryAnalysisApplicability(preflight);
    if (!applicability.required) {
        return;
    }
    const taskId = String(preflight.task_id || '').trim();
    const preflightSha256 = sha256Text(fsModule.readFileSync(preflightPath, 'utf8'));
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(repoRoot, taskId);
    const artifact = {
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
                boundary: 'Test fixture mutable input to review-context handoff',
                authority_source: 'Hash-chained QUALITY_CHECKLIST_RECORDED test event',
                mutable_inputs: ['quality-checklist artifact'],
                integrity_evidence: ['recorded artifact sha256'],
                canonical_reconstruction: 'Rebuild from the current preflight fixture.',
                toctou_replay: 'Reject a digest mismatch or stale preflight binding.',
                negative_paths: [{
                    kind: 'replaced',
                    scenario: 'rejects replaced trust-boundary evidence',
                    expected_behavior: 'Reject review-context construction.',
                    evidence_files: [
                        'tests/node/gates/review-context/review-context-trust-boundary-analysis.test.ts#rejects replaced trust-boundary evidence'
                    ]
                }]
            }]
        }]
    };
    const evidencePath = pathModule.join(
        repoRoot,
        'tests',
        'node',
        'gates',
        'review-context',
        'review-context-trust-boundary-analysis.test.ts'
    );
    fsModule.mkdirSync(pathModule.dirname(evidencePath), { recursive: true });
    if (!fsModule.existsSync(evidencePath)) {
        fsModule.writeFileSync(
            evidencePath,
            "test('rejects replaced trust-boundary evidence', () => { assert.equal(true, true); });\n",
            'utf8'
        );
    }
    const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
    if (fsModule.existsSync(artifactPath) && fsModule.readFileSync(artifactPath, 'utf8') === artifactText) {
        return;
    }
    fsModule.mkdirSync(pathModule.dirname(artifactPath), { recursive: true });
    fsModule.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactSha256 = sha256Text(artifactText);
    const orchestratorRoot = pathModule.resolve(pathModule.dirname(artifactPath), '..', '..');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'QUALITY_CHECKLIST_RECORDED',
        'PASS',
        'Quality checklist test fixture recorded.',
        {
            artifact_path: artifactPath.replace(/\\/gu, '/'),
            artifact_hash: artifactSha256,
            status: 'PASS',
            outcome: 'PASS',
            checklist_id: QUALITY_CHECKLIST_ID,
            preflight_path: preflightPath.replace(/\\/gu, '/'),
            preflight_sha256: preflightSha256
        },
        { actor: 'gate' }
    );
}

export function buildReviewContext(
    options: Parameters<typeof buildReviewContextImplementation>[0]
): ReturnType<typeof buildReviewContextImplementation> {
    seedApplicableTrustBoundaryAnalysisFixture(options);
    const preflight = options.preflightPayload
        ? cloneJson(options.preflightPayload)
        : JSON.parse(fsModule.readFileSync(options.preflightPath, 'utf8')) as Record<string, unknown>;
    if (preflight.effective_review_snapshot === undefined) {
        const requiredReviews = preflight.required_reviews
            && typeof preflight.required_reviews === 'object'
            && !Array.isArray(preflight.required_reviews)
            ? preflight.required_reviews as Record<string, boolean>
            : {};
        const customReviewIds = Object.keys(requiredReviews)
            .filter((reviewType) => !BUILT_IN_REVIEW_TYPE_IDS.includes(
                reviewType as (typeof BUILT_IN_REVIEW_TYPE_IDS)[number]
            ));
        const customReviewTypes = customReviewIds.map((reviewType) => ({
            id: reviewType,
            display_label: `${reviewType} review`,
            enabled_by_default: false,
            skill_id: 'security-review',
            trigger: { mode: 'manual', signal_ids: [] },
            coverage_category_ids: ['security'],
            reviewer_role: {
                role_id: `${reviewType}-reviewer`,
                focus_tags: ['security']
            }
        }));
        const catalog = normalizeReviewCatalog(
            { version: 1, custom_review_types: customReviewTypes },
            { knownSkillIds: ['security-review'] }
        );
        const capabilities = Object.fromEntries(
            catalog.review_types.map((definition) => [definition.id, true])
        ) as ReviewCapabilitiesConfigMap;
        const profilePolicy = resolveProfileReviewCatalogPolicy(
            'balanced',
            Object.fromEntries(customReviewIds.map((reviewType) => [reviewType, true])),
            capabilities,
            catalog
        );
        const snapshot = buildEffectiveReviewSnapshot({
            catalog,
            profilePolicy,
            profileSnapshotSha256: 'a'.repeat(64),
            legacyRequiredReviews: requiredReviews,
            scopeCategory: String(preflight.scope_category || 'code'),
            taskIntent: String(preflight.task_intent || preflight.task_id || 'review-context fixture'),
            changedFiles: Array.isArray(preflight.changed_files)
                ? preflight.changed_files.map((entry) => String(entry))
                : [],
            taskTriggers: preflight.triggers
                && typeof preflight.triggers === 'object'
                && !Array.isArray(preflight.triggers)
                ? preflight.triggers as Record<string, boolean>
                : {},
            zeroDiffBaselineOnly: false
        });
        preflight.effective_review_snapshot = snapshot;
        preflight.required_reviews = snapshot.required_reviews;
    }
    const snapshot = preflight.effective_review_snapshot as {
        lanes?: Array<{ id?: string; definition?: { skill_ids?: string[] } }>;
    };
    const lane = snapshot.lanes?.find((candidate) => candidate.id === options.reviewType);
    for (const skillId of lane?.definition?.skill_ids || []) {
        const skillRoot = pathModule.join(
            pathModule.resolve(options.repoRoot || '.'),
            'garda-agent-orchestrator',
            'live',
            'skills',
            skillId
        );
        const skillPath = pathModule.join(skillRoot, 'SKILL.md');
        if (!fsModule.existsSync(skillPath)) {
            fsModule.mkdirSync(skillRoot, { recursive: true });
            fsModule.writeFileSync(skillPath, `# ${skillId}\nFixture review skill.\n`, 'utf8');
        }
    }
    return buildReviewContextImplementation({ ...options, preflightPayload: preflight });
}

export function runGit(repoRoot: string, args: string[]): void {
    runGitFixtureCommand(repoRoot, [
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.safecrlf=false',
        ...args
    ]);
}

export function sha256Text(text: string): string {
    return cryptoModule.createHash('sha256').update(text).digest('hex');
}

export function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function writeTaskModeArtifactFixture(
    repoRoot: string,
    taskId: string,
    options: {
        provider: string | null;
        canonicalSourceOfTruth: string | null;
        routedTo?: string | null;
        executionProviderSource?: string | null;
        runtimeIdentityStatus?: string | null;
        materializeRoutedTo?: boolean;
        reviewerSubagentLaunchStatus?: 'launchable' | 'blocked' | 'unknown' | null;
        reviewerSubagentLaunchRoute?: string | null;
        reviewerSubagentLaunchReason?: string | null;
        reviewerSubagentLaunchRemediation?: string | null;
        taskSummary?: string;
        plan?: {
            plan_path: string;
            plan_sha256: string;
            plan_summary: string;
        } | null;
    }
): void {
    const normalizedRoutedTo = options.routedTo ? String(options.routedTo).replace(/\\/g, '/').replace(/^\.\//, '') : null;
    if (normalizedRoutedTo && options.materializeRoutedTo !== false) {
        const routePath = pathModule.join(repoRoot, normalizedRoutedTo);
        fsModule.mkdirSync(pathModule.dirname(routePath), { recursive: true });
        if (!fsModule.existsSync(routePath)) {
            fsModule.writeFileSync(routePath, '# routed workflow fixture\n', 'utf8');
        }
    }
    const taskModePath = resolveTaskModeArtifactPath(repoRoot, taskId, '');
    fsModule.writeFileSync(taskModePath, JSON.stringify(buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 3,
        effectiveDepth: 3,
        taskSummary: options.taskSummary || 'Enforce delegated reviewer routing',
        provider: options.provider,
        canonicalSourceOfTruth: options.canonicalSourceOfTruth,
        routedTo: options.routedTo ?? null,
        executionProviderSource: options.executionProviderSource ?? null,
        runtimeIdentityStatus: options.runtimeIdentityStatus ?? null,
        reviewerSubagentLaunchStatus: options.reviewerSubagentLaunchStatus ?? null,
        reviewerSubagentLaunchRoute: options.reviewerSubagentLaunchRoute ?? null,
        reviewerSubagentLaunchReason: options.reviewerSubagentLaunchReason ?? null,
        reviewerSubagentLaunchRemediation: options.reviewerSubagentLaunchRemediation ?? null,
        plan: options.plan ?? null
    }), null, 2), 'utf8');
    if (options.plan) {
        // Plan-bearing fixtures need the same immutable entry binding as real tasks.
        appendTaskEvent(pathModule.join(repoRoot, 'garda-agent-orchestrator'), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Synthetic plan-bound task entry.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            canonical_source_of_truth: options.canonicalSourceOfTruth,
            execution_provider_source: options.executionProviderSource ?? null,
            runtime_identity_status: options.runtimeIdentityStatus ?? null,
            plan_guided: true,
            plan_path: options.plan.plan_path,
            plan_sha256: options.plan.plan_sha256
        });
    }
}
