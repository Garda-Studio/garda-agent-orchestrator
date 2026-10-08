import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import type { ReviewDependencyGraphDeclaration } from '../../../../src/core/review-dependency-graph';
import type { FullSuiteValidationPlacement } from '../../../../src/core/workflow-config';
import { buildTaskProfilePolicySnapshot } from '../../../../src/policy/task-profile-policy-snapshot';
import { resolveNextStepRequiredReviewTypes } from '../../../../src/gates/next-step/next-step-required-review-lanes';
import { buildNextStepReviewLaunchPlan } from '../../../../src/gates/next-step/next-step-review-launch-planner';
import {
    ALL_REVIEW_FLAGS, TASK_ID, appendEvent, buildTaskModeArtifact, makeTempRepo,
    normalizeForTimeline, resolveNextStep, reviewsRoot, seedCompilePass,
    seedRulePack, seedStartedTask, writeJson, writePreflight
} from './next-step-review-cycle-fixtures';

const CUSTOM_IDS = ['architecture-boundary', 'data-boundary'];

// All authority below belongs to isolated unit-test repositories, never the active task.
function seedRequiredLanes(requiredIds: string[], options: {
    graph?: ReviewDependencyGraphDeclaration;
    fullSuite?: { enabled: boolean; placement: FullSuiteValidationPlacement };
} = {}) {
    const repoRoot = makeTempRepo();
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const configRoot = path.join(bundleRoot, 'live', 'config');
    const profilesPath = path.join(configRoot, 'profiles.json');
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const allIds = [...Object.keys(ALL_REVIEW_FLAGS), ...CUSTOM_IDS];
    profiles.built_in_profiles.balanced.review_policy = Object.fromEntries(
        allIds.map(id => [id, requiredIds.includes(id)])
    );
    if (options.graph) profiles.built_in_profiles.balanced.review_dependency_graph = options.graph;
    writeJson(profilesPath, profiles);
    writeJson(path.join(configRoot, 'review-capabilities.json'), Object.fromEntries(allIds.map(id => [id, true])));
    writeJson(path.join(configRoot, 'review-catalog.json'), {
        version: 1,
        custom_review_types: [...CUSTOM_IDS].reverse().map(id => ({
            id, display_label: id, enabled_by_default: false, skill_id: 'code-review',
            trigger: { mode: 'manual' }, coverage_category_ids: ['maintainability'],
            reviewer_role: { role_id: `${id}-reviewer`, focus_tags: ['maintainability'] }
        }))
    });
    const workflowPath = path.join(configRoot, 'workflow-config.json');
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
    workflow.review_execution_policy = { mode: 'parallel_all' };
    Object.assign(workflow.full_suite_validation, options.fullSuite || { enabled: false });
    writeJson(workflowPath, workflow);

    seedStartedTask(repoRoot, TASK_ID);
    const profileSnapshot = buildTaskProfilePolicySnapshot(bundleRoot, 'balanced', {
        reviewExecutionPolicyMode: 'parallel_all', reviewExecutionPolicyConfigured: true,
        fullSuiteValidationEnabled: options.fullSuite?.enabled || false,
        fullSuiteValidationPlacement: options.fullSuite?.placement || 'after_compile_before_reviews'
    });
    const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
    writeJson(taskModePath, buildTaskModeArtifact({
        taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, effectiveDepth: 2,
        taskSummary: 'Route immutable custom review lanes', startBanner: 'Garda captures my mind',
        provider: 'Codex', canonicalSourceOfTruth: 'Codex', executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved', taskProfile: 'balanced', profileSelectionSource: 'task_queue',
        activeProfile: 'balanced', profileSource: 'built_in', runtimeActiveProfile: 'balanced',
        runtimeProfileSource: 'built_in', profilePolicySnapshot: profileSnapshot
    }));
    appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
        artifact_path: normalizeForTimeline(taskModePath), provider: 'Codex',
        profile_policy_snapshot_required: true, profile_policy_snapshot_hash: profileSnapshot.snapshot_hash
    });
    seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY', taskModePath);
    appendEvent(repoRoot, TASK_ID, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    appendEvent(repoRoot, TASK_ID, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
    const preflightPath = writePreflight(repoRoot, TASK_ID,
        Object.fromEntries(allIds.map(id => [id, requiredIds.includes(id)])),
        { reviewPolicyMode: 'parallel_all' });
    seedCompilePass(repoRoot, TASK_ID);
    return { repoRoot, preflightPath };
}

test('custom-only immutable requirements stay visible and require a real reviewer context', () => {
    const { repoRoot } = seedRequiredLanes([...CUSTOM_IDS].reverse());
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.deepEqual(result.review.required_reviews, CUSTOM_IDS);
    assert.deepEqual(result.review.launchable_review_types, CUSTOM_IDS);
    assert.equal(result.review.next_review_type, CUSTOM_IDS[0]);
    assert.equal(result.next_gate, 'build-review-context');
    assert.match(result.commands[0].command, /--review-type "architecture-boundary"/);
    assert.equal(result.status, 'BLOCKED');
});

test('mixed built-in and custom requirements preserve built-in presentation order', () => {
    const { repoRoot } = seedRequiredLanes(['test', 'data-boundary', 'security', 'code', 'architecture-boundary']);
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.deepEqual(result.review.required_reviews,
        ['code', 'security', 'test', ...CUSTOM_IDS]);
    assert.equal(result.review.next_review_type, 'code');
    assert.ok(result.review.launchable_review_types.includes('data-boundary'));
});

test('a frozen custom prerequisite blocks a built-in lane and controls executable routing', () => {
    const graph = {
        preparation_order: ['data-boundary', 'code'],
        dependencies: { 'data-boundary': [], code: ['data-boundary'] }
    };
    const { repoRoot } = seedRequiredLanes(['code', 'data-boundary'], { graph });
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.deepEqual(result.review.required_reviews, ['code', 'data-boundary']);
    assert.deepEqual(result.review.launchable_review_types, ['data-boundary']);
    assert.equal(result.review.next_review_type, 'data-boundary');
    assert.equal(result.next_gate, 'build-review-context');
    assert.match(result.commands[0].command, /--review-type "data-boundary"/);
    assert.deepEqual(result.review.blocked_review_lanes.map(lane => [lane.review_type, lane.blocked_by]),
        [['code', ['data-boundary']]]);
});

test('a custom PASS text cannot hide missing context, receipt or full-suite evidence', () => {
    const { repoRoot } = seedRequiredLanes(['data-boundary'], {
        fullSuite: { enabled: true, placement: 'after_compile_before_reviews' }
    });
    fs.writeFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-data-boundary.md`),
        'DATA BOUNDARY REVIEW PASSED\n');
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.deepEqual(result.review.required_reviews, ['data-boundary']);
    assert.equal(result.next_gate, 'full-suite-validation');
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.review.trust_note);
});

test('inactive and foreign flags cannot be promoted into immutable required lanes', () => {
    for (const laneId of ['architecture-boundary', 'foreign-boundary']) {
        const { repoRoot, preflightPath } = seedRequiredLanes(['data-boundary']);
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        preflight.required_reviews[laneId] = true;
        writeJson(preflightPath, preflight);
        assert.throws(() => resolveNextStep({ repoRoot, taskId: TASK_ID }),
            /immutable|snapshot|projection|selection|required_reviews/);
    }
});

test('recognized custom PASS text still routes missing context and receipt recovery', () => {
    const { repoRoot } = seedRequiredLanes(['data-boundary']);
    fs.writeFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-data-boundary.md`),
        'DATA BOUNDARY REVIEW PASSED\n');
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.equal(result.next_gate, 'build-review-context');
    assert.equal(result.review.next_review_type, 'data-boundary');
    assert.equal(result.status, 'BLOCKED');
});

test('scope refresh diagnostics retain the required custom review lane', () => {
    const { repoRoot } = seedRequiredLanes(['data-boundary']);
    fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = 2;\n');
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.equal(result.next_gate, 'classify-change');
    assert.deepEqual(result.invalidation_impact?.affected_review_lanes, ['data-boundary']);
});

test('current failed custom lanes retain priority over unstarted built-in lanes', () => {
    const { preflightPath } = seedRequiredLanes(['code', 'data-boundary']);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    const required = resolveNextStepRequiredReviewTypes(preflight);
    // A planner-unit projection of current evidence, not an active-task receipt.
    const result = buildNextStepReviewLaunchPlan({
        requiredReviewTypes: required, requiredReviews: preflight.required_reviews,
        policyMode: 'parallel_all', dependencyGraph: preflight.effective_review_snapshot.review_dependency_graph,
        reviewStates: required.map(reviewType => ({
            reviewType, ready: false, failed: reviewType === 'data-boundary',
            artifactExists: reviewType === 'data-boundary', verdictToken: null, failToken: null,
            violations: []
        })),
        isSatisfied: () => false, isCurrentFailed: state => state.reviewType === 'data-boundary'
    });
    assert.equal(result.failed_review_type, 'data-boundary');
    assert.equal(result.next_review_type, 'data-boundary');
    assert.deepEqual(result.launchable_review_types, []);
});

test('snapshot-free compatibility preserves built-ins and rejects custom requirements', () => {
    assert.deepEqual(resolveNextStepRequiredReviewTypes({ required_reviews: {
        test: true, dependency: true, code: true, api: false
    } }), ['code', 'dependency', 'test']);
    assert.deepEqual(resolveNextStepRequiredReviewTypes(null), []);
    assert.throws(() => resolveNextStepRequiredReviewTypes({ required_reviews: {
        code: true, 'data-boundary': true
    } }), /cannot authorize custom required review ids/);
    assert.throws(() => resolveNextStepRequiredReviewTypes({
        required_reviews: { code: true }, effective_review_snapshot: null
    }), /must be a JSON object/);
});

test('a malformed present snapshot never falls back to its built-in flags', () => {
    const { preflightPath } = seedRequiredLanes(['code', 'data-boundary']);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    preflight.effective_review_snapshot.snapshot_sha256 = 'f'.repeat(64);
    assert.throws(() => resolveNextStepRequiredReviewTypes(preflight), /snapshot hash mismatch/);
});
