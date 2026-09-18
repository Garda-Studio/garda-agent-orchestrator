import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeReviewCatalog, readReviewCatalogConfigFile } from '../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../src/core/review-capabilities';
import {
    assertEffectiveReviewSnapshotExecutionPolicyBinding,
    assertEffectiveReviewSnapshotCurrent,
    buildEffectiveReviewSnapshot,
    collectKnownReviewSkillIds,
    deriveReviewPackageHints,
    getEffectiveReviewSnapshotViolations,
    resolveEffectiveReviewTaskIntent
} from '../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../src/policy/profile-review-catalog-policy';
import { buildTaskProfilePolicySnapshot } from '../../../src/policy/task-profile-policy-snapshot';
import {
    resolveEffectiveReviewLaneSet,
    resolveEffectiveReviewLaneSetOrLegacy
} from '../../../src/policy/effective-review-lane-set';
import {
    buildReviewLaneArtifactEvidence,
    getReviewLaneArtifactEvidenceViolations,
    resolveReviewContextLaneBinding
} from '../../../src/gates/review-context/review-context-lane';
import {
    resolveCompletionReviewContracts,
    resolveCompletionReviewSkillCandidates
} from '../../../src/gates/completion/completion-review-skill-contracts';
import {
    REVIEW_CONTRACTS,
    readConfiguredReviewContracts,
    resolveExpectedReviewVerdicts,
    validatePreflightForReview
} from '../../../src/gates/required-reviews/required-reviews-check-contracts';
import { collectEffectiveReviewTypeIds } from '../../../src/gates/task-audit/task-audit-summary-review-common';
import { collectEvidenceArtifacts } from '../../../src/gates/task-audit/task-audit-summary-review-evidence';
import { buildReviewIntegrityAttestation } from '../../../src/gates/task-audit/task-audit-summary-review-integrity';
import { readReviewTrustSummaryFromReviewGate } from '../../../src/gates/task-audit/task-audit-summary-review-trust';
import type { ProjectMemoryImpactLifecycleEvidence } from '../../../src/gates/project-memory-impact';

const PROFILE_HASH = 'a'.repeat(64);

test('configured implemented skills extend catalog validation without selecting a review lane', () => {
    const knownSkillIds = collectKnownReviewSkillIds([
        {
            id: 'architecture-review',
            directory: 'architecture-review',
            implemented: true
        },
        {
            id: 'placeholder-review',
            directory: 'placeholder-review',
            implemented: false
        }
    ]);

    assert.ok(knownSkillIds.includes('architecture-review'));
    assert.ok(!knownSkillIds.includes('placeholder-review'));
    assert.doesNotThrow(() => normalizeReviewCatalog({
        version: 1,
        custom_review_types: [
            {
                id: 'architecture-boundary',
                display_label: 'Architecture boundary review',
                enabled_by_default: false,
                skill_id: 'architecture-review',
                trigger: { mode: 'manual' },
                coverage_category_ids: ['maintainability'],
                reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
            }
        ]
    }, { knownSkillIds }));

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-review-contracts-'));
    try {
        const configDir = path.join(tmpRoot, 'live', 'config');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'review-catalog.json'), JSON.stringify({
            version: 1,
            custom_review_types: [
                {
                    id: 'architecture-boundary',
                    display_label: 'Architecture boundary review',
                    enabled_by_default: false,
                    skill_id: 'architecture-review',
                    trigger: { mode: 'manual' },
                    coverage_category_ids: ['maintainability'],
                    reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
                }
            ]
        }), 'utf8');
        fs.writeFileSync(path.join(configDir, 'skills-headlines.json'), JSON.stringify({
            version: 2,
            installed_pack_ids: [],
            baseline_skill_ids: [],
            installed_optional_skill_ids: [],
            custom_skill_ids: ['architecture-review'],
            skills: [
                {
                    id: 'architecture-review',
                    directory: 'architecture-review',
                    name: 'Architecture review',
                    summary: 'Reviews architectural boundaries.',
                    pack: null,
                    source: 'custom_live',
                    implemented: true,
                    review_binding: 'review_bound',
                    aliases: [],
                    task_signals: [],
                    changed_path_signals: [],
                    tags: []
                }
            ],
            optional_packs: []
        }), 'utf8');

        assert.deepEqual(readConfiguredReviewContracts(tmpRoot), [
            ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED']
        ]);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('effective review task intent falls back to the stored task summary', () => {
    assert.equal(
        resolveEffectiveReviewTaskIntent(undefined, 'Build the architecture boundary'),
        'Build the architecture boundary'
    );
    assert.equal(
        resolveEffectiveReviewTaskIntent('Explicit security intent', 'Stored task summary'),
        'Explicit security intent'
    );
});

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
            result[key] = canonicalize((value as Record<string, unknown>)[key]);
            return result;
        }, {});
    }
    return value;
}

function rehashSnapshot(snapshot: Record<string, unknown>): void {
    const { snapshot_sha256: ignored, ...body } = snapshot;
    void ignored;
    snapshot.snapshot_sha256 = createHash('sha256')
        .update(JSON.stringify(canonicalize(body)), 'utf8')
        .digest('hex');
}

function suppressReviewInDependencyGraph(snapshot: Record<string, unknown>, reviewId: string): void {
    const graph = snapshot.review_dependency_graph as Record<string, unknown>;
    graph.nodes = (graph.nodes as string[]).filter((id) => id !== reviewId);
    graph.preparation_order = (graph.preparation_order as string[]).filter((id) => id !== reviewId);
    delete (graph.dependencies as Record<string, unknown>)[reviewId];
    graph.preparation_batches = (graph.preparation_batches as string[][])
        .map((batch) => batch.filter((id) => id !== reviewId))
        .filter((batch) => batch.length > 0);
    const barrier = graph.full_suite_barrier as Record<string, unknown>;
    barrier.before_review_ids = (barrier.before_review_ids as string[]).filter((id) => id !== reviewId);
    const { graph_sha256: ignored, ...body } = graph;
    void ignored;
    graph.graph_sha256 = createHash('sha256')
        .update(JSON.stringify(canonicalize(body)), 'utf8')
        .digest('hex');
}

function buildCatalog(signalIds: string[] = ['package:payments', 'skill:node-backend', 'task:architecture']) {
    return normalizeReviewCatalog({
        version: 1,
        custom_review_types: [
            {
                id: 'architecture-boundary',
                display_label: 'Architecture boundary review',
                enabled_by_default: false,
                skill_id: 'architecture-review',
                trigger: {
                    mode: 'signals',
                    signal_ids: signalIds
                },
                coverage_category_ids: ['maintainability'],
                reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
            }
        ]
    }, { knownSkillIds: ['architecture-review'] });
}

function buildSnapshot(
    profileState: boolean | 'auto',
    input: Partial<Parameters<typeof buildEffectiveReviewSnapshot>[0]> = {},
    control: {
        profileOverrides?: Readonly<Record<string, boolean | 'auto'>>;
        signalIds?: string[];
    } = {}
) {
    const catalog = buildCatalog(control.signalIds);
    const capabilities = Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        { ...control.profileOverrides, 'architecture-boundary': profileState },
        capabilities,
        catalog
    );
    return buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: PROFILE_HASH,
        legacyRequiredReviews: { code: true },
        scopeCategory: 'code',
        taskIntent: 'Change a small handler',
        changedFiles: ['packages/payments/src/handler.ts'],
        taskTriggers: { api: true },
        ...input
    });
}

test('effective review snapshot preserves built-in requirements and never triggers a disabled custom lane', () => {
    const snapshot = buildSnapshot(false, {
        taskIntent: 'Architecture change',
        optionalSkillIds: ['node-backend']
    });

    assert.equal(snapshot.required_reviews.code, true);
    assert.equal(snapshot.required_reviews['architecture-boundary'], false);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.inactive_reasons,
        ['profile_disabled']
    );
});

test('effective review snapshot freezes a profile dependency graph and full-suite barrier', () => {
    const snapshot = buildSnapshot(true, {
        legacyRequiredReviews: { code: true, test: true },
        taskIntent: 'Architecture change',
        reviewExecutionPolicyMode: 'parallel_all',
        reviewDependencyGraph: {
            preparation_order: [
                'code', 'db', 'security', 'refactor', 'api', 'performance',
                'infra', 'dependency', 'architecture-boundary', 'test'
            ],
            dependencies: {
                'architecture-boundary': ['code'],
                test: ['architecture-boundary']
            }
        },
        fullSuiteValidation: { enabled: true, placement: 'before_test_review' }
    }, {
        profileOverrides: { test: true },
        signalIds: ['task:architecture']
    });

    assert.ok(snapshot.required_review_ids.includes('architecture-boundary'));
    assert.deepEqual(snapshot.review_dependency_graph?.dependencies['architecture-boundary'], ['code']);
    assert.deepEqual(snapshot.review_dependency_graph?.full_suite_barrier.before_review_ids, ['test']);
    assert.equal(snapshot.inputs.review_execution_policy?.mode, 'parallel_all');
    assert.deepEqual(getEffectiveReviewSnapshotViolations(snapshot), []);
});

test('rejects removal or self-rehashed substitution of the frozen dependency graph contract', () => {
    const snapshot = buildSnapshot(true, {
        legacyRequiredReviews: { code: true, test: true },
        reviewExecutionPolicyMode: 'test_after_code',
        fullSuiteValidation: { enabled: true, placement: 'before_test_review' }
    }, { profileOverrides: { test: true } });
    const frozenPolicy = snapshot.inputs.review_execution_policy!;

    const removedGraph = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    delete removedGraph.review_dependency_graph;
    rehashSnapshot(removedGraph);
    assert.ok(getEffectiveReviewSnapshotViolations(removedGraph).some((violation) => (
        violation.includes('must be present together')
    )));

    const downgraded = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    delete downgraded.review_dependency_graph;
    delete (downgraded.inputs as Record<string, unknown>).review_execution_policy;
    rehashSnapshot(downgraded);
    assert.throws(
        () => assertEffectiveReviewSnapshotExecutionPolicyBinding(
            downgraded as unknown as typeof snapshot,
            frozenPolicy
        ),
        /does not match the frozen task profile policy|canonical frozen task profile graph/u
    );

    const substituted = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const substitutedPolicy = (
        (substituted.inputs as Record<string, unknown>).review_execution_policy
    ) as Record<string, unknown>;
    substitutedPolicy.full_suite_validation = { enabled: true, placement: 'before_completion' };
    const substitutedGraph = substituted.review_dependency_graph as Record<string, unknown>;
    substitutedGraph.full_suite_barrier = {
        enabled: true,
        placement: 'before_completion',
        before_review_ids: []
    };
    const { graph_sha256: ignoredGraphHash, ...graphBody } = substitutedGraph;
    void ignoredGraphHash;
    substitutedGraph.graph_sha256 = createHash('sha256')
        .update(JSON.stringify(canonicalize(graphBody)), 'utf8')
        .digest('hex');
    rehashSnapshot(substituted);
    assert.throws(
        () => assertEffectiveReviewSnapshotExecutionPolicyBinding(
            substituted as unknown as typeof snapshot,
            frozenPolicy
        ),
        /does not match the frozen task profile policy/u
    );
});

test('rejects forged injected custom requirements without an immutable snapshot', () => {
    assert.throws(
        () => resolveEffectiveReviewLaneSetOrLegacy({
            required_reviews: { code: true, 'architecture-boundary': true }
        }),
        /cannot authorize custom required review ids: architecture-boundary/u
    );
});

test('task audit uses legacy lanes only when the immutable snapshot is absent', () => {
    assert.ok(collectEffectiveReviewTypeIds({ required_reviews: { code: true } }).includes('code'));

    const malformedSnapshot = {
        required_reviews: { code: true },
        effective_review_snapshot: { schema_version: 1 }
    };
    assert.throws(
        () => collectEffectiveReviewTypeIds(malformedSnapshot),
        /effective review snapshot is invalid/iu
    );
});

test('resolves custom closeout contracts only from the immutable snapshot', () => {
    const snapshot = buildSnapshot(true);
    const preflight = {
        required_reviews: snapshot.required_reviews,
        effective_review_snapshot: snapshot
    };
    const laneSet = resolveEffectiveReviewLaneSet(preflight);
    const completionContracts = resolveCompletionReviewContracts(preflight);
    const completionSkillCandidates = resolveCompletionReviewSkillCandidates(preflight);

    assert.ok(laneSet.required_review_ids.includes('architecture-boundary'));
    assert.deepEqual(
        completionContracts.find(([reviewType]) => reviewType === 'architecture-boundary'),
        ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED']
    );
    assert.deepEqual(completionSkillCandidates['architecture-boundary'], ['architecture-review']);

    assert.throws(
        () => resolveEffectiveReviewLaneSet({
            ...preflight,
            required_reviews: { ...snapshot.required_reviews, 'architecture-boundary': false }
        }),
        /does not match immutable lane selection/u
    );
});

test('task audit inventories custom review evidence from the immutable snapshot', () => {
    const snapshot = buildSnapshot(true);
    const preflight = {
        required_reviews: snapshot.required_reviews,
        effective_review_snapshot: snapshot
    };
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-audit-evidence-'));
    const reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
    const taskId = 'T-729-4C';
    const projectMemoryImpact: ProjectMemoryImpactLifecycleEvidence = {
        required: false,
        enabled: false,
        mode: 'off',
        configured_mode: 'off',
        run_before_final_closeout: false,
        artifact_path: '',
        update_artifact_path: '',
        status: null,
        outcome: null,
        evidence_status: 'NOT_REQUIRED',
        update_needed: null,
        affected_memory_files: [],
        updated_memory_files: [],
        compact_status: null,
        compact_refreshed: null,
        visible_summary_line: 'Project memory: not required',
        violations: []
    };

    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        for (const suffix of [
            '-architecture-boundary.md',
            '-architecture-boundary-review-context.json',
            '-architecture-boundary-receipt.json'
        ]) {
            fs.writeFileSync(path.join(reviewsRoot, `${taskId}${suffix}`), '{}', 'utf8');
        }

        const evidence = collectEvidenceArtifacts(
            repoRoot,
            reviewsRoot,
            taskId,
            path.join(repoRoot, 'runtime', 'task-events', `${taskId}.jsonl`),
            projectMemoryImpact,
            preflight
        );

        for (const kind of [
            'architecture-boundary-review',
            'architecture-boundary-review-context',
            'architecture-boundary-receipt'
        ]) {
            assert.equal(evidence.find((artifact) => artifact.kind === kind)?.exists, true);
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('rejects stale missing or definition-drifted custom receipt lane evidence', () => {
    const snapshot = buildSnapshot(true);
    const preflight = {
        required_reviews: snapshot.required_reviews,
        effective_review_snapshot: snapshot
    };
    const binding = resolveReviewContextLaneBinding(preflight, 'architecture-boundary');
    const evidence = buildReviewLaneArtifactEvidence(binding);

    assert.deepEqual(getReviewLaneArtifactEvidenceViolations({
        artifact: evidence,
        preflight,
        reviewType: 'architecture-boundary',
        label: 'Custom receipt'
    }), []);
    assert.ok(getReviewLaneArtifactEvidenceViolations({
        artifact: { ...evidence, review_lane_definition_sha256: 'f'.repeat(64) },
        preflight,
        reviewType: 'architecture-boundary',
        label: 'Custom receipt'
    }).some((violation) => violation.includes('review_lane_definition_sha256')));
    assert.ok(getReviewLaneArtifactEvidenceViolations({
        artifact: {},
        preflight,
        reviewType: 'architecture-boundary',
        label: 'Custom receipt'
    }).length > 0);
});

test('task audit rejects gate-derived custom trust when receipt lane evidence is invalid', () => {
    const snapshot = buildSnapshot(true);
    const preflight = {
        required_reviews: snapshot.required_reviews,
        effective_review_snapshot: snapshot
    };
    const reviewType = 'architecture-boundary';
    const taskId = 'T-CUSTOM-AUDIT';
    const preflightSha256 = 'b'.repeat(64);
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-audit-trust-'));
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const reviewGate = {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        preflight_hash_sha256: preflightSha256,
        required_reviews: { [reviewType]: true },
        review_checks: {
            [reviewType]: {
                required: true,
                skipped_by_override: false,
                receipt_valid: true,
                trust_level: 'INDEPENDENT_AUDITED',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:architecture-reviewer',
                reviewer_fallback_reason: null,
                reviewer_routing_policy: {
                    delegation_required: true,
                    expected_execution_mode: 'delegated_subagent',
                    fallback_allowed: false,
                    fallback_reason_required: false
                }
            }
        }
    };

    try {
        fs.writeFileSync(receiptPath, JSON.stringify({
            task_id: taskId,
            review_type: reviewType
        }), 'utf8');

        assert.equal(readReviewTrustSummaryFromReviewGate(
            reviewGate,
            { [reviewType]: true },
            taskId,
            'code',
            preflightSha256,
            preflight,
            reviewsRoot
        ), null);

        const integrity = buildReviewIntegrityAttestation({
            requiredReviews: { [reviewType]: true },
            reviewsRoot,
            taskId,
            scopeCategory: 'code',
            preflightSha256,
            reviewTrustSummary: null,
            currentPreflight: preflight
        });
        assert.ok(integrity.observed_issues.some((issue) => (
            issue.includes(reviewType) && issue.includes('review_lane_binding_sha256')
        )));

        const binding = resolveReviewContextLaneBinding(preflight, reviewType);
        fs.writeFileSync(receiptPath, JSON.stringify({
            task_id: taskId,
            review_type: reviewType,
            ...buildReviewLaneArtifactEvidence(binding)
        }), 'utf8');
        assert.equal(readReviewTrustSummaryFromReviewGate(
            reviewGate,
            { [reviewType]: true },
            taskId,
            'code',
            preflightSha256,
            preflight,
            reviewsRoot
        )?.status, 'INDEPENDENT_AUDITED');
    } finally {
        fs.rmSync(reviewsRoot, { recursive: true, force: true });
    }
});

test('built-in compatibility decisions preserve contextual profile guardrails', () => {
    const lightenedByGuardrail = buildSnapshot('auto', {
        legacyRequiredReviews: { code: false }
    }, { profileOverrides: { code: true } });
    const disabledByProfile = buildSnapshot('auto', {
        legacyRequiredReviews: { code: true }
    }, { profileOverrides: { code: false } });

    assert.equal(lightenedByGuardrail.required_reviews.code, false);
    assert.deepEqual(
        lightenedByGuardrail.lanes.find((lane) => lane.id === 'code')?.trigger_reasons,
        ['built_in_compatibility_not_required']
    );
    assert.equal(disabledByProfile.required_reviews.code, false);
    assert.deepEqual(
        disabledByProfile.lanes.find((lane) => lane.id === 'code')?.inactive_reasons,
        ['profile_disabled']
    );
});

test('zero-diff baseline suppresses profile-required built-in and custom lanes', () => {
    const snapshot = buildSnapshot(true, {
        zeroDiffBaselineOnly: true
    }, { profileOverrides: { code: true } });

    assert.equal(snapshot.required_reviews.code, false);
    assert.equal(snapshot.required_reviews['architecture-boundary'], false);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'code')?.inactive_reasons,
        ['zero_diff_no_reviewable_scope']
    );
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.inactive_reasons,
        ['zero_diff_no_reviewable_scope']
    );
    assert.deepEqual(getEffectiveReviewSnapshotViolations(snapshot), []);
});

test('auto custom lane requires an explicitly configured deterministic signal', () => {
    const unmatched = buildSnapshot('auto', {
        changedFiles: ['src/handler.ts'],
        taskIntent: 'Change a small handler',
        optionalSkillIds: []
    });
    const matched = buildSnapshot('auto', { optionalSkillIds: ['node-backend'] });

    assert.equal(unmatched.required_reviews['architecture-boundary'], false);
    assert.deepEqual(
        unmatched.lanes.find((lane) => lane.id === 'architecture-boundary')?.inactive_reasons,
        ['configured_signals_not_matched']
    );
    assert.equal(matched.required_reviews['architecture-boundary'], true);
    assert.deepEqual(
        matched.lanes.find((lane) => lane.id === 'architecture-boundary')?.trigger_reasons,
        ['package:payments=package_hint', 'skill:node-backend=selected_optional_skill']
    );
});

test('composed configured signal tokens preserve the first namespace delimiter', () => {
    const snapshot = buildSnapshot('auto', {
        changedFiles: ['src/handler.ts'],
        taskIntent: 'Change the architecture boundary'
    }, { signalIds: ['task:architecture.boundary'] });

    assert.equal(snapshot.required_reviews['architecture-boundary'], true);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.trigger_reasons,
        ['task:architecture.boundary=task_intent_token']
    );
});

test('configured stable trigger signals map to exact underscore preflight identifiers', () => {
    const snapshot = buildSnapshot('auto', {
        taskTriggers: { protected_control_plane_changed: true }
    }, { signalIds: ['trigger:protected-control-plane-changed'] });

    assert.equal(snapshot.required_reviews['architecture-boundary'], true);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.trigger_reasons,
        ['trigger:protected-control-plane-changed=task_scope_trigger']
    );
});

test('required custom lane is selected without treating skill availability as a trigger', () => {
    const snapshot = buildSnapshot(true, {
        changedFiles: ['src/handler.ts'],
        optionalSkillIds: []
    });

    assert.equal(snapshot.required_reviews['architecture-boundary'], true);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.trigger_reasons,
        ['profile_state=required']
    );
});

test('required custom lane is included in downstream verdict contracts', () => {
    const snapshot = buildSnapshot(true, {
        changedFiles: ['src/handler.ts'],
        optionalSkillIds: []
    });

    const verdicts = resolveExpectedReviewVerdicts(snapshot.required_reviews);

    assert.equal(verdicts['architecture-boundary'], 'ARCHITECTURE BOUNDARY REVIEW PASSED');
    assert.deepEqual(
        REVIEW_CONTRACTS.find(([reviewId]) => reviewId === 'architecture-boundary'),
        ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED']
    );
});

test('rejects self-hashed fabricated or inconsistent review-routing decisions', () => {
    const snapshot = buildSnapshot('auto', {}, { profileOverrides: { code: true } });
    const nonBoolean = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    (nonBoolean.required_reviews as Record<string, unknown>).code = 'false';
    rehashSnapshot(nonBoolean);

    assert.ok(getEffectiveReviewSnapshotViolations(nonBoolean).some(
        (violation) => /required_reviews\.code must be boolean/u.test(violation)
    ));

    const suppressedRequired = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const codeLane = (suppressedRequired.lanes as Array<Record<string, unknown>>)
        .find((lane) => lane.id === 'code');
    assert.ok(codeLane);
    codeLane.selection = 'optional';
    codeLane.trigger_reasons = ['built_in_compatibility_not_required'];
    (suppressedRequired.required_reviews as Record<string, unknown>).code = false;
    (suppressedRequired.optional_reviews as Record<string, unknown>).code = true;
    suppressedRequired.required_review_ids = (suppressedRequired.required_review_ids as string[])
        .filter((id) => id !== 'code');
    suppressedRequired.optional_review_ids = ['code', ...(suppressedRequired.optional_review_ids as string[])];
    rehashSnapshot(suppressedRequired);

    assert.ok(getEffectiveReviewSnapshotViolations(suppressedRequired).some(
        (violation) => /required profile lane 'code' must be required/u.test(violation)
    ));
});

test('canonical reconstruction rejects a self-rehashed auto-lane suppression', () => {
    const catalog = buildCatalog();
    const capabilities = Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        { 'architecture-boundary': 'auto' },
        capabilities,
        catalog
    );
    const snapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: PROFILE_HASH,
        legacyRequiredReviews: { code: true },
        scopeCategory: 'code',
        taskIntent: 'Change a small handler',
        changedFiles: ['packages/payments/src/handler.ts'],
        taskTriggers: { api: true }
    });
    const suppressed = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const lane = (suppressed.lanes as Array<Record<string, unknown>>)
        .find((entry) => entry.id === 'architecture-boundary');
    assert.ok(lane);
    lane.selection = 'inactive';
    lane.trigger_reasons = [];
    lane.inactive_reasons = ['configured_signals_not_matched'];
    (suppressed.required_reviews as Record<string, unknown>)['architecture-boundary'] = false;
    suppressed.required_review_ids = (suppressed.required_review_ids as string[])
        .filter((id) => id !== 'architecture-boundary');
    suppressReviewInDependencyGraph(suppressed, 'architecture-boundary');
    rehashSnapshot(suppressed);

    assert.deepEqual(getEffectiveReviewSnapshotViolations(suppressed), []);
    assert.throws(
        () => assertEffectiveReviewSnapshotCurrent(
            suppressed as unknown as Parameters<typeof assertEffectiveReviewSnapshotCurrent>[0],
            catalog,
            PROFILE_HASH,
            profilePolicy
        ),
        /canonical reconstruction mismatch/u
    );
});

test('rejects catalog and profile drift before downstream review routing', () => {
    const snapshot = buildSnapshot('auto');
    assert.deepEqual(getEffectiveReviewSnapshotViolations(snapshot), []);
    assert.doesNotThrow(() => assertEffectiveReviewSnapshotCurrent(snapshot, snapshot.catalog_sha256, PROFILE_HASH));
    assert.throws(
        () => assertEffectiveReviewSnapshotCurrent(snapshot, 'b'.repeat(64), PROFILE_HASH),
        /catalog drift detected/u
    );
    assert.throws(
        () => assertEffectiveReviewSnapshotCurrent(snapshot, snapshot.catalog_sha256, 'c'.repeat(64)),
        /profile drift detected/u
    );

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'effective-review-preflight-'));
    try {
        const bundleRoot = path.join(tmpRoot, 'garda-agent-orchestrator');
        const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
        const configDir = path.join(bundleRoot, 'live', 'config');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
            path.join(configDir, 'review-catalog.json'),
            JSON.stringify({ version: 1, custom_review_types: [] }),
            'utf8'
        );
        fs.writeFileSync(
            path.join(reviewsDir, 'T-729-3-task-mode.json'),
            JSON.stringify({ profile_policy_snapshot_required: false }),
            'utf8'
        );
        const preflightPath = path.join(reviewsDir, 'T-729-3-preflight.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: snapshot.required_reviews,
            profile_policy_snapshot: { snapshot_hash: PROFILE_HASH }
        }), 'utf8');
        const missingSnapshot = validatePreflightForReview(preflightPath, 'T-729-3');
        assert.ok(missingSnapshot.errors.some(
            (error) => /effective_review_snapshot.*required for downstream review routing/u.test(error)
        ));

        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: { ...snapshot.required_reviews, injected: true },
            profile_policy_snapshot: { snapshot_hash: PROFILE_HASH },
            effective_review_snapshot: snapshot
        }), 'utf8');
        const injectedProjection = validatePreflightForReview(preflightPath, 'T-729-3');
        assert.ok(injectedProjection.errors.some(
            (error) => /required_reviews.*must contain exactly the review ids/u.test(error)
        ));

        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: snapshot.required_reviews,
            profile_policy_snapshot: { snapshot_hash: PROFILE_HASH },
            effective_review_snapshot: snapshot
        }), 'utf8');

        REVIEW_CONTRACTS.splice(
            0,
            REVIEW_CONTRACTS.length,
            ...REVIEW_CONTRACTS.filter(([reviewId]) => reviewId !== 'architecture-boundary')
        );
        const catalogDrift = validatePreflightForReview(preflightPath, 'T-729-3');
        assert.equal(catalogDrift.required_reviews['architecture-boundary'], true);
        assert.deepEqual(
            REVIEW_CONTRACTS.find(([reviewId]) => reviewId === 'architecture-boundary'),
            ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED']
        );
        assert.ok(catalogDrift.errors.some((error) => /catalog drift detected/u.test(error)));

        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: snapshot.required_reviews,
            profile_policy_snapshot: { snapshot_hash: 'c'.repeat(64) },
            effective_review_snapshot: snapshot
        }), 'utf8');
        const profileDrift = validatePreflightForReview(preflightPath, 'T-729-3');
        assert.ok(profileDrift.errors.some((error) => /profile drift detected/u.test(error)));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('downstream routing preserves frozen policy across non-routing profile drift and rejects lane drift', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'effective-review-profile-drift-'));
    try {
        const bundleRoot = path.join(tmpRoot, 'garda-agent-orchestrator');
        const configDir = path.join(bundleRoot, 'live', 'config');
        const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
        fs.cpSync(path.resolve('template', 'config'), configDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });

        const frozenProfileSnapshot = buildTaskProfilePolicySnapshot(bundleRoot, 'balanced', {
            reviewExecutionPolicyMode: 'strict_sequential',
            reviewExecutionPolicyConfigured: true,
            lockTimestampUtc: '2026-01-01T00:00:00.000Z'
        });
        const catalog = readReviewCatalogConfigFile(path.join(configDir, 'review-catalog.json'));
        const profilePolicy = resolveProfileReviewCatalogPolicy(
            frozenProfileSnapshot.source.effective_profile,
            frozenProfileSnapshot.review_lane_selection.profile_review_policy,
            frozenProfileSnapshot.review_lane_selection.review_capabilities,
            catalog
        );
        const legacyRequiredReviews = Object.fromEntries(
            catalog.review_types.map((definition) => [definition.id, definition.id === 'code'])
        );
        const snapshot = buildEffectiveReviewSnapshot({
            catalog,
            profilePolicy,
            profileSnapshotSha256: frozenProfileSnapshot.snapshot_hash,
            legacyRequiredReviews,
            scopeCategory: 'code',
            taskIntent: 'Exercise profile drift detection',
            changedFiles: ['src/handler.ts'],
            taskTriggers: {},
            reviewExecutionPolicyMode: frozenProfileSnapshot.review_execution_policy.mode,
            reviewDependencyGraph:
                frozenProfileSnapshot.review_execution_policy.review_dependency_graph,
            fullSuiteValidation:
                frozenProfileSnapshot.review_execution_policy.full_suite_validation
        });
        const preflightPath = path.join(reviewsDir, 'T-729-3-preflight.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: snapshot.required_reviews,
            profile_policy_snapshot: frozenProfileSnapshot,
            effective_review_snapshot: snapshot
        }), 'utf8');
        const defaultTaskModePath = path.join(reviewsDir, 'T-729-3-task-mode.json');
        fs.writeFileSync(defaultTaskModePath, JSON.stringify({
            profile_policy_snapshot: frozenProfileSnapshot
        }), 'utf8');

        assert.deepEqual(validatePreflightForReview(preflightPath, 'T-729-3').errors, []);

        const customTaskModePath = path.join(tmpRoot, 'custom-artifacts', 'T-729-3-task-mode.json');
        fs.mkdirSync(path.dirname(customTaskModePath), { recursive: true });
        fs.renameSync(defaultTaskModePath, customTaskModePath);
        assert.ok(validatePreflightForReview(preflightPath, 'T-729-3').errors.some(
            (error) => /Path not found|ENOENT/u.test(error)
        ));
        assert.deepEqual(
            validatePreflightForReview(preflightPath, 'T-729-3', customTaskModePath).errors,
            []
        );
        fs.renameSync(customTaskModePath, defaultTaskModePath);

        fs.appendFileSync(path.join(configDir, 'profiles.json'), '\n', 'utf8');

        assert.deepEqual(validatePreflightForReview(preflightPath, 'T-729-3').errors, []);

        const profilesPath = path.join(configDir, 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as Record<string, any>;
        profiles.built_in_profiles.balanced.review_policy.code = false;
        fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');

        assert.ok(validatePreflightForReview(preflightPath, 'T-729-3').errors.some(
            (error) => /profile policy inputs changed after preflight \(review lane policy\)/iu.test(error)
        ));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('package hints are bounded exact tokens derived from conventional workspace roots', () => {
    assert.deepEqual(deriveReviewPackageHints([
        'packages/payments/src/index.ts',
        'apps/admin-ui/src/app.ts',
        'package.json',
        'src/unscoped.ts'
    ]), ['admin-ui', 'payments', 'root']);
});
