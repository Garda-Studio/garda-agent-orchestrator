import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildDefaultReviewRemediationModePolicy,
    evaluateReviewRemediationMode,
    getReviewRemediationModePolicyViolations,
    REVIEW_REMEDIATION_PROTECTED_BOUNDARY_SIGNALS
} from '../../../../src/policy/review-remediation-mode-policy';
import {
    buildTaskProfilePolicySnapshot,
    resolveTaskProfileReviewRemediationModePolicy,
    validateTaskProfilePolicySnapshot
} from '../../../../src/policy/task-profile-policy-snapshot';
import { runInit } from '../../../../src/materialization/init';

function makeBundle(explicitPolicy: boolean): { root: string; bundleRoot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-delta-e2e-'));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.cpSync(path.resolve('template', 'config'), configDir, { recursive: true });
    const profiles = JSON.parse(fs.readFileSync(path.resolve('template', 'config', 'profiles.json'), 'utf8')) as {
        built_in_profiles: Record<string, Record<string, unknown>>;
    };
    if (!explicitPolicy) {
        for (const profile of Object.values(profiles.built_in_profiles)) {
            delete profile.review_remediation_mode_policy;
        }
    }
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify(profiles, null, 2), 'utf8');
    return { root, bundleRoot };
}

function buildSnapshot(bundleRoot: string) {
    return buildTaskProfilePolicySnapshot(bundleRoot, 'balanced', {
        reviewExecutionPolicyMode: 'strict_sequential',
        reviewExecutionPolicyConfigured: true,
        fullSuiteValidationEnabled: true,
        fullSuiteValidationPlacement: 'after_compile_before_reviews',
        lockTimestampUtc: '2026-08-20T00:00:00.000Z'
    });
}

test('profile materialization rejects silent legacy DELTA enablement until explicit policy migration', () => {
    const legacy = makeBundle(false);
    const migrated = makeBundle(true);
    try {
        const legacySnapshot = buildSnapshot(legacy.bundleRoot);
        assert.equal(validateTaskProfilePolicySnapshot(legacySnapshot).status, 'PASS');
        assert.equal(Object.hasOwn(legacySnapshot, 'review_remediation_mode_policy'), false);
        const legacyResolution = resolveTaskProfileReviewRemediationModePolicy(legacySnapshot);
        assert.equal(legacyResolution.legacy_fallback, true);
        assert.equal(evaluateReviewRemediationMode({
            policy: legacyResolution.policy,
            legacyFallback: legacyResolution.legacy_fallback,
            reviewType: 'test',
            category: 'leaf_test',
            changedFilesCount: 1,
            changedLinesTotal: 4,
            consecutiveDeltaReviews: 0
        }).mode, 'FULL');

        const migratedSnapshot = buildSnapshot(migrated.bundleRoot);
        assert.equal(validateTaskProfilePolicySnapshot(migratedSnapshot).status, 'PASS');
        assert.equal(migratedSnapshot.review_remediation_mode_policy?.policy_id, 'conservative_review_remediation_mode_v1');
        const migratedResolution = resolveTaskProfileReviewRemediationModePolicy(migratedSnapshot);
        assert.equal(migratedResolution.legacy_fallback, false);
        assert.equal(evaluateReviewRemediationMode({
            policy: migratedResolution.policy,
            legacyFallback: migratedResolution.legacy_fallback,
            reviewType: 'test',
            category: 'leaf_test',
            changedFilesCount: 1,
            changedLinesTotal: 4,
            consecutiveDeltaReviews: 0
        }).mode, 'DELTA');
    } finally {
        fs.rmSync(legacy.root, { recursive: true, force: true });
        fs.rmSync(migrated.root, { recursive: true, force: true });
    }
});

test('bounded mode matrix admits leaf-test and local-code repairs and deterministically forces FULL fallbacks', () => {
    const policy = buildDefaultReviewRemediationModePolicy();
    type AssessmentOverrides = Omit<Partial<Parameters<typeof evaluateReviewRemediationMode>[0]>, 'policy'>;
    const assess = (overrides: AssessmentOverrides = {}) => (
        evaluateReviewRemediationMode({
            policy,
            reviewType: 'code',
            category: 'production',
            changedFilesCount: 1,
            changedLinesTotal: 12,
            consecutiveDeltaReviews: 0,
            ...overrides
        })
    );

    assert.equal(assess().mode, 'DELTA');
    assert.equal(assess({ reviewType: 'test', category: 'leaf_test' }).mode, 'DELTA');
    assert.equal(assess({ initialReview: true }).mode, 'FULL');
    assert.equal(assess({ consecutiveDeltaReviews: policy.max_consecutive_delta_reviews }).mode, 'FULL');
    assert.equal(assess({ changedFilesCount: policy.max_delta_changed_files + 1 }).mode, 'FULL');
    assert.equal(assess({ changedLinesTotal: null }).mode, 'FULL');
    assert.equal(assess({ reviewType: 'architecture-boundary' }).mode, 'FULL');
    assert.equal(assess({ taskCriteriaChanged: true }).mode, 'FULL');
    assert.equal(assess({ policyChanged: true }).mode, 'FULL');
    assert.equal(assess({ scopeMembershipChanged: true }).mode, 'FULL');
    assert.equal(assess({ uncertainCrossFileImpact: true }).mode, 'FULL');
    for (const category of policy.force_full_categories) {
        assert.equal(assess({ category }).mode, 'FULL', category);
    }
    for (const signal of REVIEW_REMEDIATION_PROTECTED_BOUNDARY_SIGNALS) {
        assert.equal(assess({ protectedBoundarySignals: [signal] }).mode, 'FULL', signal);
    }
});

test('policy migration surface permits explicit disables and custom lanes while rejecting malformed identifiers', () => {
    const policy = buildDefaultReviewRemediationModePolicy() as unknown as Record<string, unknown>;
    assert.deepEqual(getReviewRemediationModePolicyViolations(policy), []);

    const allDisabled = structuredClone(policy);
    allDisabled.delta_eligible_review_types = [];
    assert.deepEqual(getReviewRemediationModePolicyViolations(allDisabled), []);

    const unsupported = structuredClone(policy);
    unsupported.delta_eligible_review_types = ['custom_lane'];
    assert.ok(getReviewRemediationModePolicyViolations(unsupported).some((entry) => entry.includes('unsupported')));

    const oversized = structuredClone(policy);
    oversized.max_delta_changed_lines = 401;
    assert.ok(getReviewRemediationModePolicyViolations(oversized).some((entry) => entry.includes('safety ceiling 400')));
});

test('shipped and materialized workspace profiles expose the same explicit conservative policy', () => {
    const sourceProfiles = JSON.parse(fs.readFileSync(path.resolve('template', 'config', 'profiles.json'), 'utf8'));
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-delta-installed-'));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    try {
        fs.cpSync(path.resolve('template'), path.join(bundleRoot, 'template'), { recursive: true });
        runInit({
            targetRoot,
            bundleRoot,
            sourceOfTruth: 'Codex',
            assistantLanguage: 'English',
            assistantBrevity: 'concise'
        });
        const installedProfilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
        assert.equal(fs.existsSync(installedProfilesPath), true);
        const installedProfiles = JSON.parse(fs.readFileSync(installedProfilesPath, 'utf8'));
        for (const profileName of Object.keys(sourceProfiles.built_in_profiles).sort()) {
            assert.deepEqual(
                installedProfiles.built_in_profiles[profileName].review_remediation_mode_policy,
                sourceProfiles.built_in_profiles[profileName].review_remediation_mode_policy,
                profileName
            );
        }
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});
