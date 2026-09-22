import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveEffectivePolicy,
    mergeReviewPolicy,
    mergeTokenEconomy,
    mergeSkills,
    loadProfilesData,
    loadReviewCapabilities,
    loadTokenEconomyConfig,
    loadSkillPacksConfig,
    loadPathsConfig,
    getProfileEntry,
    getProfileSource,
    resolveConfigPaths,
    formatEffectivePolicy,
    formatEffectivePolicyJson,
    applyProfileGuardrails,
    formatProfileGuardrailDiagnostics,
    resolveReviewFollowUpPolicy,
    resolveReviewFollowUpTaskProfileAssignment,
    resolveProfileTaskDecompositionPolicy,
    type ReviewCapabilities,
    type TokenEconomyConfig,
    type SkillPacksConfig,
    type ProfileReviewPolicy,
    type ProfileTokenEconomy,
    type ProfileSkills
} from '../../../src/policy/profile-resolver';
import {
    buildTaskProfilePolicySnapshot,
    computeTaskProfilePolicySnapshotHash,
    resolveTaskProfileReviewRemediationModePolicy,
    resolveTaskProfileTaskDecompositionPolicy,
    validateTaskProfilePolicySnapshot
} from '../../../src/policy/task-profile-policy-snapshot';
import { buildDefaultReviewRemediationModePolicy } from '../../../src/policy/review-remediation-mode-policy';
import { normalizeTaskProfileValue, resolveTaskProfileSelection } from '../../../src/policy/task-profile-selection';

test('task profile normalization preserves the default sentinel and normalizes explicit names', () => {
    for (const value of [undefined, null, '', '   ']) {
        assert.equal(normalizeTaskProfileValue(value), null);
    }
    assert.equal(normalizeTaskProfileValue(' DEFAULT '), 'default');
    assert.equal(normalizeTaskProfileValue(' STRICT '), 'strict');
});

test('task profile selection inherits the workspace for blank and default values without writing config', (t) => {
    const bundleRoot = makeTempBundle({});
    t.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));
    const profilesPath = path.join(bundleRoot, 'live/config/profiles.json');
    const before = fs.readFileSync(profilesPath, 'utf8');
    for (const value of [undefined, null, '', ' DEFAULT ']) {
        const result = resolveTaskProfileSelection(bundleRoot, value, 'docs-only');
        assert.deepEqual(result.selection, {
            task_profile: value === ' DEFAULT ' ? 'default' : null,
            profile_selection_source: 'workspace_active',
            effective_profile: 'balanced',
            effective_profile_source: 'built_in',
            runtime_active_profile: 'balanced',
            runtime_profile_source: 'built_in'
        });
        assert.equal(result.effective_policy.profile_name, 'balanced');
    }
    assert.equal(fs.readFileSync(profilesPath, 'utf8'), before);
});

test('explicit task profile overrides the workspace and preserves both profile identities', (t) => {
    const bundleRoot = makeTempBundle({});
    t.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));
    const result = resolveTaskProfileSelection(bundleRoot, ' STRICT ', 'test-only');
    assert.deepEqual(result.selection, {
        task_profile: 'strict',
        profile_selection_source: 'task_queue',
        effective_profile: 'strict',
        effective_profile_source: 'built_in',
        runtime_active_profile: 'balanced',
        runtime_profile_source: 'built_in'
    });
    assert.equal(result.effective_policy.depth, 3);
    assert.equal(result.effective_policy.scope_category, 'test-only');
});

test('task profile selection resolves user profiles and rejects unknown explicit profiles', (t) => {
    const bundleRoot = makeTempBundle({});
    t.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));
    const profilesPath = path.join(bundleRoot, 'live/config/profiles.json');
    const profiles = loadProfilesData(profilesPath);
    profiles.user_profiles['team-review'] = structuredClone(profiles.built_in_profiles.strict);
    profiles.active_profile = 'team-review';
    fs.writeFileSync(profilesPath, JSON.stringify(profiles), 'utf8');
    const inherited = resolveTaskProfileSelection(bundleRoot, 'default', 'docs-only');
    assert.equal(inherited.selection.effective_profile, 'team-review');
    assert.equal(inherited.selection.effective_profile_source, 'user');
    assert.equal(inherited.selection.runtime_profile_source, 'user');
    const explicit = resolveTaskProfileSelection(bundleRoot, ' TEAM-REVIEW ', 'docs-only');
    assert.equal(explicit.selection.profile_selection_source, 'task_queue');
    assert.equal(explicit.effective_policy.depth, 3);
    assert.throws(() => resolveTaskProfileSelection(bundleRoot, 'missing'), /Profile 'missing' not found/u);
});

test('task profile selection forwards review guardrails and zero-diff scope evidence', (t) => {
    const bundleRoot = makeTempBundle({});
    t.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));
    const ordinary = resolveTaskProfileSelection(bundleRoot, 'docs-only', 'docs-only');
    assert.equal(ordinary.effective_policy.review_policy.code, false);
    const forced = resolveTaskProfileSelection(bundleRoot, 'docs-only', 'docs-only', { forceCodeReview: true });
    assert.equal(forced.effective_policy.review_policy.code, true);
    const zeroDiff = resolveTaskProfileSelection(bundleRoot, 'strict', 'empty', {
        zeroDiffBaselineOnly: true, domainSurface: {}
    });
    assert.equal(zeroDiff.effective_policy.guardrail_diagnostics?.zero_diff_no_reviewable_scope, true);
    assert.equal(zeroDiff.effective_policy.review_policy.code, false);
    const protectedScope = resolveTaskProfileSelection(bundleRoot, 'fast', 'code', {
        domainSurface: { db: false, security: true }, protectedControlPlaneChanged: true
    });
    assert.equal(protectedScope.effective_policy.review_policy.code, true);
    assert.equal(protectedScope.effective_policy.review_policy.security, true);
    assert.equal(protectedScope.effective_policy.review_policy.db, false);
});

test('profile task decomposition enables strict and balanced defaults and disables other legacy profiles', () => {
    const strict = resolveProfileTaskDecompositionPolicy(undefined, 'strict');
    const balanced = resolveProfileTaskDecompositionPolicy(undefined, 'balanced');
    const custom = resolveProfileTaskDecompositionPolicy(undefined, 'custom-profile');

    assert.deepEqual(
        [strict.enabled, balanced.enabled, custom.enabled],
        [true, true, false]
    );
    assert.equal(strict.provenance, 'legacy_strict_compatibility');
    assert.equal(balanced.provenance, 'legacy_balanced_default');
    assert.equal(resolveProfileTaskDecompositionPolicy({ enabled: true }, 'balanced').enabled, true);
});

test('profile task decomposition rejects forged malformed explicit configuration fail closed', () => {
    for (const value of [true, { enabled: 'yes' }, { enabled: true, extra: false }]) {
        const resolution = resolveProfileTaskDecompositionPolicy(value, 'balanced');
        assert.equal(resolution.enabled, false);
        assert.equal(resolution.valid, false);
        assert.match(resolution.diagnostics.join('\n'), /fail-closed/iu);
    }
});

test('follow-up task profile assignment follows the built-in lowering ladder', () => {
    const available = ['strict', 'balanced', 'fast', 'docs-only'];
    const policy = resolveReviewFollowUpPolicy({
        schema_version: 1,
        materialization_mode: 'grouped_by_parent',
        task_profile: { mode: 'one_level_lighter', fixed_profile: null }
    }, 'strict').policy;

    assert.equal(resolveReviewFollowUpTaskProfileAssignment(policy, 'strict', available).profile, 'balanced');
    assert.equal(resolveReviewFollowUpTaskProfileAssignment(policy, 'balanced', available).profile, 'fast');
    assert.equal(resolveReviewFollowUpTaskProfileAssignment(policy, 'fast', available).profile, 'fast');
});

test('follow-up task profile assignment supports inherit and fixed modes', () => {
    const available = ['strict', 'balanced', 'fast', 'custom-profile'];
    const inherited = resolveReviewFollowUpPolicy({
        schema_version: 1,
        materialization_mode: 'per_finding',
        task_profile: { mode: 'inherit_parent', fixed_profile: null }
    }, 'strict').policy;
    const fixed = resolveReviewFollowUpPolicy({
        schema_version: 1,
        materialization_mode: 'per_finding',
        task_profile: { mode: 'fixed_profile', fixed_profile: 'fast' }
    }, 'strict').policy;

    assert.equal(resolveReviewFollowUpTaskProfileAssignment(inherited, 'strict', available).profile, 'strict');
    assert.equal(resolveReviewFollowUpTaskProfileAssignment(fixed, 'strict', available).profile, 'fast');
    assert.equal(resolveReviewFollowUpTaskProfileAssignment(fixed, 'strict', available).source, 'fixed_profile');
});

test('one-level lowering fails closed for custom and docs-only profiles', () => {
    const available = ['strict', 'balanced', 'fast', 'docs-only', 'custom-profile'];
    const policy = resolveReviewFollowUpPolicy({
        schema_version: 1,
        materialization_mode: 'per_finding',
        task_profile: { mode: 'one_level_lighter', fixed_profile: null }
    }, 'custom-profile').policy;

    for (const parent of ['custom-profile', 'docs-only']) {
        const assignment = resolveReviewFollowUpTaskProfileAssignment(policy, parent, available);
        assert.equal(assignment.profile, parent);
        assert.equal(assignment.source, 'safe_inherit_parent');
        assert.match(assignment.diagnostics.join('\n'), /instead of guessing/iu);
    }
});

test('invalid fixed follow-up profile fails closed visibly', () => {
    const policy = resolveReviewFollowUpPolicy({
        schema_version: 1,
        materialization_mode: 'per_finding',
        task_profile: { mode: 'fixed_profile', fixed_profile: 'missing-profile' }
    }, 'strict').policy;
    const assignment = resolveReviewFollowUpTaskProfileAssignment(policy, 'strict', ['strict', 'balanced', 'fast']);

    assert.equal(assignment.profile, 'strict');
    assert.equal(assignment.source, 'safe_inherit_parent');
    assert.match(assignment.diagnostics.join('\n'), /unavailable/iu);
});


function makeTempBundle(configs: {
    profiles?: Record<string, unknown>;
    reviewCatalog?: Record<string, unknown>;
    reviewCapabilities?: Record<string, unknown>;
    tokenEconomy?: Record<string, unknown>;
    skillPacks?: Record<string, unknown>;
    paths?: Record<string, unknown>;
}): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-policy-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const defaultProfiles = {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Default profile.',
                depth: 2,
                review_policy: {
                    code: true,
                    db: 'auto',
                    security: 'auto',
                    refactor: 'auto',
                    api: 'auto',
                    test: true,
                    performance: 'auto',
                    infra: 'auto',
                    dependency: 'auto'
                },
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
                },
                review_follow_up_policy: {
                    schema_version: 1,
                    materialization_mode: 'grouped_by_parent'
                },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: true }
            },
            fast: {
                description: 'Speed-optimised.',
                depth: 1,
                review_policy: {
                    code: 'auto',
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: 'auto',
                    performance: false,
                    infra: false,
                    dependency: false
                },
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
                },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: false }
            },
            strict: {
                description: 'Maximum rigour.',
                depth: 3,
                review_policy: {
                    code: true,
                    db: 'auto',
                    security: true,
                    refactor: 'auto',
                    api: 'auto',
                    test: true,
                    performance: true,
                    infra: 'auto',
                    dependency: 'auto'
                },
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
                },
                token_economy: { enabled: true, strip_examples: false, strip_code_blocks: false, scoped_diffs: true, compact_reviewer_output: false },
                skills: { auto_suggest: true }
            },
            'docs-only': {
                description: 'Documentation-focused.',
                depth: 1,
                review_policy: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                },
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
                },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                skills: { auto_suggest: false }
            }
        },
        user_profiles: {}
    };

    const defaultCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: true, test: true, performance: true, infra: true, dependency: true
    };

    const defaultTokenEconomy = {
        enabled: true, enabled_depths: [1, 2],
        strip_examples: true, strip_code_blocks: true,
        scoped_diffs: true, compact_reviewer_output: true,
        fail_tail_lines: 50
    };

    const defaultSkillPacks = { version: 1, installed_packs: [] };

    const defaultPaths = {
        metrics_path: 'garda-agent-orchestrator/runtime/metrics.jsonl',
        runtime_roots: ['src/'],
        fast_path_roots: ['frontend/'],
        fast_path_allowed_regexes: [],
        fast_path_sensitive_regexes: [],
        sql_or_migration_regexes: [],
        triggers: { db: ['(^|/)db/'], security: ['(^|/)auth/'] },
        code_like_regexes: ['\\.ts$']
    };

    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify(configs.profiles || defaultProfiles, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'review-catalog.json'), JSON.stringify(configs.reviewCatalog || {
        version: 1,
        custom_review_types: []
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'review-capabilities.json'), JSON.stringify(configs.reviewCapabilities || defaultCapabilities, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'token-economy.json'), JSON.stringify(configs.tokenEconomy || defaultTokenEconomy, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'skill-packs.json'), JSON.stringify(configs.skillPacks || defaultSkillPacks, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'paths.json'), JSON.stringify(configs.paths || defaultPaths, null, 2), 'utf8');

    return bundleRoot;
}

function cleanUp(bundleRoot: string): void {
    fs.rmSync(bundleRoot, { recursive: true, force: true });
}

function customReviewCatalog(): Record<string, unknown> {
    return {
        version: 1,
        custom_review_types: [{
            id: 'architecture-boundary',
            display_label: 'Architecture boundary review',
            enabled_by_default: false,
            skill_id: 'code-review',
            trigger: { mode: 'signals', signal_ids: ['paths.config'] },
            coverage_category_ids: ['maintainability'],
            reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['boundaries'] }
        }]
    };
}


test('resolveConfigPaths returns correct paths', () => {
    const paths = resolveConfigPaths('/fake/bundle');
    assert.ok(paths.profiles.endsWith(path.join('live', 'config', 'profiles.json')));
    assert.ok(paths.reviewCatalog.endsWith(path.join('live', 'config', 'review-catalog.json')));
    assert.ok(paths.reviewCapabilities.endsWith(path.join('live', 'config', 'review-capabilities.json')));
    assert.ok(paths.tokenEconomy.endsWith(path.join('live', 'config', 'token-economy.json')));
    assert.ok(paths.skillPacks.endsWith(path.join('live', 'config', 'skill-packs.json')));
    assert.ok(paths.paths.endsWith(path.join('live', 'config', 'paths.json')));
});


test('loadProfilesData throws for missing file', () => {
    assert.throws(() => loadProfilesData('/nonexistent/profiles.json'), /not found/);
});

test('loadProfilesData loads valid profiles', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const configDir = path.join(bundleRoot, 'live', 'config');
        const data = loadProfilesData(path.join(configDir, 'profiles.json'));
        assert.equal(data.active_profile, 'balanced');
        assert.ok(Object.hasOwn(data.built_in_profiles, 'balanced'));
    } finally {
        cleanUp(bundleRoot);
    }
});

test('task profile snapshot hash-binds explicit decomposition and migrates legacy snapshots without mutation', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: Record<string, Record<string, unknown>>;
        };
        profiles.built_in_profiles.balanced.task_decomposition = { enabled: true };
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');

        const snapshot = buildTaskProfilePolicySnapshot(bundleRoot, 'balanced', {
            reviewExecutionPolicyMode: 'strict_sequential',
            reviewExecutionPolicyConfigured: true
        });
        assert.deepEqual(snapshot.task_decomposition, {
            enabled: true,
            configured: true,
            provenance: 'explicit_profile_config',
            diagnostics: []
        });
        assert.equal(validateTaskProfilePolicySnapshot(snapshot).status, 'PASS');

        const tampered = structuredClone(snapshot);
        tampered.task_decomposition!.enabled = false;
        assert.equal(validateTaskProfilePolicySnapshot(tampered).status, 'HASH_MISMATCH');

        const legacy = structuredClone(snapshot) as typeof snapshot;
        delete legacy.task_decomposition;
        legacy.snapshot_hash = computeTaskProfilePolicySnapshotHash(legacy);
        assert.equal(validateTaskProfilePolicySnapshot(legacy).status, 'PASS');
        const migrated = resolveTaskProfileTaskDecompositionPolicy(legacy);
        assert.equal(migrated.enabled, true);
        assert.equal(migrated.provenance, 'legacy_snapshot_balanced_default');
    } finally {
        cleanUp(bundleRoot);
    }
});

test('task profile snapshots preserve legacy FULL-only mode until the profile explicitly enables DELTA', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: Record<string, Record<string, unknown>>;
        };
        const legacySnapshot = buildTaskProfilePolicySnapshot(bundleRoot, 'balanced', {
            reviewExecutionPolicyMode: 'strict_sequential',
            reviewExecutionPolicyConfigured: true
        });
        assert.equal(Object.hasOwn(legacySnapshot, 'review_remediation_mode_policy'), false);
        assert.equal(resolveTaskProfileReviewRemediationModePolicy(legacySnapshot).legacy_fallback, true);

        profiles.built_in_profiles.balanced.review_remediation_mode_policy =
            buildDefaultReviewRemediationModePolicy();
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
        const explicitSnapshot = buildTaskProfilePolicySnapshot(bundleRoot, 'balanced', {
            reviewExecutionPolicyMode: 'strict_sequential',
            reviewExecutionPolicyConfigured: true
        });
        assert.equal(explicitSnapshot.review_remediation_mode_policy?.initial_review_mode, 'FULL');
        assert.equal(resolveTaskProfileReviewRemediationModePolicy(explicitSnapshot).legacy_fallback, false);
        assert.equal(validateTaskProfilePolicySnapshot(explicitSnapshot).status, 'PASS');
    } finally {
        cleanUp(bundleRoot);
    }
});

test('effective policy rejects malformed decomposition configuration', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: Record<string, Record<string, unknown>>;
        };
        profiles.built_in_profiles.balanced.task_decomposition = { enabled: 'yes' };
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
        assert.throws(
            () => resolveEffectivePolicy(bundleRoot, { profileOverride: 'balanced' }),
            /invalid task_decomposition/iu
        );
    } finally {
        cleanUp(bundleRoot);
    }
});

test('shipped template profiles and review capabilities use profile-driven review defaults', () => {
    const repoRoot = process.cwd();
    const profiles = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'template', 'config', 'profiles.json'), 'utf8')
    ) as { built_in_profiles: Record<string, { task_decomposition: { enabled: boolean }; review_policy: Record<string, unknown>; review_finding_policy: Record<string, unknown> }> };
    const capabilities = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'template', 'config', 'review-capabilities.json'), 'utf8')
    ) as Record<string, boolean>;

    assert.deepEqual(capabilities, {
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: true,
        dependency: true
    });
    assert.deepEqual(Object.fromEntries(
        Object.entries(profiles.built_in_profiles).map(([name, entry]) => [name, entry.task_decomposition.enabled])
    ), {
        balanced: true,
        fast: false,
        strict: true,
        'docs-only': false
    });
    assert.deepEqual(profiles.built_in_profiles.balanced.review_policy, {
        code: true,
        db: 'auto',
        security: 'auto',
        refactor: 'auto',
        api: 'auto',
        test: true,
        performance: 'auto',
        infra: 'auto',
        dependency: 'auto'
    });
    assert.deepEqual(profiles.built_in_profiles.balanced.review_finding_policy, {
        schema_version: 1,
        policy_id: 'balanced',
        findings: {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'create_follow_up'
        },
        residual_risk: 'create_follow_up'
    });
    assert.deepEqual(profiles.built_in_profiles.fast.review_policy, {
        code: 'auto',
        db: false,
        security: false,
        refactor: false,
        api: false,
        test: 'auto',
        performance: false,
        infra: false,
        dependency: false
    });
    assert.deepEqual(profiles.built_in_profiles.fast.review_finding_policy, {
        schema_version: 1,
        policy_id: 'custom',
        findings: {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'ignore',
            low: 'ignore'
        },
        residual_risk: 'ignore'
    });
    assert.deepEqual(profiles.built_in_profiles.strict.review_policy, {
        code: true,
        db: 'auto',
        security: true,
        refactor: 'auto',
        api: 'auto',
        test: true,
        performance: true,
        infra: 'auto',
        dependency: 'auto'
    });
    assert.deepEqual(profiles.built_in_profiles.strict.review_finding_policy, {
        schema_version: 1,
        policy_id: 'strict',
        findings: {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'fix_now'
        },
        residual_risk: 'fix_now'
    });
    assert.deepEqual(profiles.built_in_profiles['docs-only'].review_policy, {
        code: false,
        db: false,
        security: false,
        refactor: false,
        api: false,
        test: false,
        performance: false,
        infra: false,
        dependency: false
    });
    assert.deepEqual(profiles.built_in_profiles['docs-only'].review_finding_policy, {
        schema_version: 1,
        policy_id: 'soft',
        findings: {
            critical: 'fix_now',
            high: 'create_follow_up',
            medium: 'ignore',
            low: 'ignore'
        },
        residual_risk: 'ignore'
    });
});


test('loadReviewCapabilities returns defaults for missing file', () => {
    const caps = loadReviewCapabilities('/nonexistent/review-capabilities.json');
    assert.equal(caps.code, true);
    assert.equal(caps.api, true);
    assert.equal(caps.infra, true);
});

test('loadReviewCapabilities reads config values', () => {
    const bundleRoot = makeTempBundle({ reviewCapabilities: {
        code: true, db: false, security: true, refactor: false,
        api: true, test: false, performance: false, infra: true, dependency: false
    }});
    try {
        const caps = loadReviewCapabilities(path.join(bundleRoot, 'live', 'config', 'review-capabilities.json'));
        assert.equal(caps.db, false);
        assert.equal(caps.api, true);
        assert.equal(caps.infra, true);
    } finally {
        cleanUp(bundleRoot);
    }
});


test('loadTokenEconomyConfig returns defaults for missing file', () => {
    const config = loadTokenEconomyConfig('/nonexistent/token-economy.json');
    assert.equal(config.enabled, true);
    assert.equal(config.fail_tail_lines, 50);
});

test('loadTokenEconomyConfig reads config values', () => {
    const bundleRoot = makeTempBundle({ tokenEconomy: {
        enabled: false, enabled_depths: [1],
        strip_examples: false, strip_code_blocks: false,
        scoped_diffs: false, compact_reviewer_output: false,
        fail_tail_lines: 100
    }});
    try {
        const config = loadTokenEconomyConfig(path.join(bundleRoot, 'live', 'config', 'token-economy.json'));
        assert.equal(config.enabled, false);
        assert.deepEqual(config.enabled_depths, [1]);
        assert.equal(config.fail_tail_lines, 100);
    } finally {
        cleanUp(bundleRoot);
    }
});


test('loadSkillPacksConfig returns defaults for missing file', () => {
    const config = loadSkillPacksConfig('/nonexistent/skill-packs.json');
    assert.deepEqual(config.installed_packs, []);
});

test('loadSkillPacksConfig reads installed packs', () => {
    const bundleRoot = makeTempBundle({ skillPacks: { version: 1, installed_packs: ['docs-process', 'testing-strategy'] }});
    try {
        const config = loadSkillPacksConfig(path.join(bundleRoot, 'live', 'config', 'skill-packs.json'));
        assert.deepEqual(config.installed_packs, ['docs-process', 'testing-strategy']);
    } finally {
        cleanUp(bundleRoot);
    }
});


test('getProfileEntry returns built-in profile', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const data = loadProfilesData(path.join(bundleRoot, 'live', 'config', 'profiles.json'));
        const entry = getProfileEntry(data, 'balanced');
        assert.ok(entry);
        assert.equal(entry.depth, 2);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('getProfileEntry returns null for unknown', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const data = loadProfilesData(path.join(bundleRoot, 'live', 'config', 'profiles.json'));
        assert.equal(getProfileEntry(data, 'nonexistent'), null);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('getProfileSource distinguishes built_in and user', () => {
    const profiles = {
        version: 1, active_profile: 'balanced',
        built_in_profiles: {
            balanced: { description: 'D', depth: 2, review_policy: { code: true }, token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true }, skills: { auto_suggest: true } }
        },
        user_profiles: {
            'my-custom': { description: 'Custom', depth: 1, review_policy: { code: true }, token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true }, skills: { auto_suggest: false } }
        }
    };
    const bundleRoot = makeTempBundle({ profiles });
    try {
        const data = loadProfilesData(path.join(bundleRoot, 'live', 'config', 'profiles.json'));
        assert.equal(getProfileSource(data, 'balanced'), 'built_in');
        assert.equal(getProfileSource(data, 'my-custom'), 'user');
        assert.equal(getProfileSource(data, 'ghost'), null);
    } finally {
        cleanUp(bundleRoot);
    }
});


test('mergeReviewPolicy: "auto" defers to capabilities', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: 'auto' };
    const caps: ReviewCapabilities = { code: true, db: true, security: false, refactor: true, api: true, test: false, performance: false, infra: false, dependency: false };
    const { merged, floorsApplied } = mergeReviewPolicy(profile, caps, false);
    assert.equal(merged.db, true);
    assert.equal(merged.security, false);
    assert.equal(merged.refactor, true);
    assert.equal(merged.api, true);
    assert.equal(floorsApplied.length, 0);
});

test('mergeReviewPolicy: explicit false overrides capability', () => {
    const profile: ProfileReviewPolicy = { code: true, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = { code: true, db: true, security: true, refactor: true, api: false, test: false, performance: false, infra: false, dependency: false };
    const { merged } = mergeReviewPolicy(profile, caps, false);
    assert.equal(merged.db, false);
    assert.equal(merged.security, false);
    assert.equal(merged.refactor, false);
});

test('mergeReviewPolicy: safety floor forces code=true for code-changing tasks', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = { code: true, db: true, security: true, refactor: true, api: false, test: false, performance: false, infra: false, dependency: false };
    const { merged, floorsApplied } = mergeReviewPolicy(profile, caps, true);
    assert.equal(merged.code, true);
    assert.equal(merged.security, true);
    assert.equal(merged.db, true);
    assert.equal(merged.refactor, true);
    assert.equal(floorsApplied.length, 4);
    assert.ok(floorsApplied.some(f => f.includes('code')));
    assert.ok(floorsApplied.some(f => f.includes('security')));
    assert.ok(floorsApplied.some(f => f.includes('db')));
    assert.ok(floorsApplied.some(f => f.includes('refactor')));
});

test('mergeReviewPolicy: no safety floor for non-code-changing tasks', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = { code: true, db: true, security: true, refactor: true, api: false, test: false, performance: false, infra: false, dependency: false };
    const { merged, floorsApplied } = mergeReviewPolicy(profile, caps, false);
    assert.equal(merged.code, false);
    assert.equal(floorsApplied.length, 0);
});

test('mergeReviewPolicy: capabilities keys not in profile are passed through', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: 'auto' };
    const caps: ReviewCapabilities = { code: true, db: true, security: true, refactor: true, api: true, test: true, performance: false, infra: false, dependency: true };
    const { merged } = mergeReviewPolicy(profile, caps, false);
    assert.equal(merged.api, true);
    assert.equal(merged.test, true);
    assert.equal(merged.dependency, true);
    assert.equal(merged.infra, false);
});

test('mergeReviewPolicy: safety floor does not fire when all floor keys already true', () => {
    const profile: ProfileReviewPolicy = { code: true, db: true, security: true, refactor: true };
    const caps: ReviewCapabilities = { code: true, db: true, security: true, refactor: true, api: false, test: false, performance: false, infra: false, dependency: false };
    const { floorsApplied } = mergeReviewPolicy(profile, caps, true);
    assert.equal(floorsApplied.length, 0);
});

test('resolveEffectivePolicy keeps an omitted custom catalog lane inactive', () => {
    const bundleRoot = makeTempBundle({
        reviewCatalog: customReviewCatalog(),
        reviewCapabilities: { 'architecture-boundary': true }
    });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: false });
        const catalogPolicy = policy.review_catalog_policy;
        assert.ok(catalogPolicy);
        const lane = catalogPolicy.lanes.find(({ id }) => id === 'architecture-boundary');
        assert.ok(lane);
        assert.equal(lane.state, 'disabled');
        assert.equal(lane.state_source, 'custom_disabled_default');
        assert.equal(lane.capability_enabled, true);
        assert.equal(lane.active, false);
        assert.equal(lane.inactive_reason, 'profile_disabled');
        assert.equal(policy.review_policy['architecture-boundary'], false);
        assert.match(catalogPolicy.catalog_sha256, /^[a-f0-9]{64}$/u);
        assert.match(catalogPolicy.policy_sha256, /^[a-f0-9]{64}$/u);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy activates auto custom profile intent without selecting the lane early', () => {
    const bundleRoot = makeTempBundle({
        reviewCatalog: customReviewCatalog(),
        reviewCapabilities: { 'architecture-boundary': true }
    });
    try {
        const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: Record<string, { review_policy: Record<string, boolean | 'auto'> }>;
        };
        profiles.built_in_profiles.balanced.review_policy['architecture-boundary'] = 'auto';
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');

        const policy = resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: false });
        const catalogPolicy = policy.review_catalog_policy;
        assert.ok(catalogPolicy);
        const lane = catalogPolicy.lanes.find(({ id }) => id === 'architecture-boundary');
        assert.ok(lane);
        assert.equal(lane.state, 'auto');
        assert.equal(lane.state_source, 'profile');
        assert.equal(lane.active, true);
        assert.equal(lane.inactive_reason, null);
        assert.equal(policy.review_policy['architecture-boundary'], false);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy rejects unknown catalog review ids', () => {
    const bundleRoot = makeTempBundle({ reviewCatalog: customReviewCatalog() });
    try {
        const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: Record<string, { review_policy: Record<string, boolean | 'auto'> }>;
        };
        profiles.built_in_profiles.balanced.review_policy.ghost = true;
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');

        assert.throws(
            () => resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: false }),
            /unknown catalog review id 'ghost'/u
        );
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy accepts registered remediation lanes and rejects unregistered remediation lanes', () => {
    const bundleRoot = makeTempBundle({
        reviewCatalog: customReviewCatalog(),
        reviewCapabilities: { 'architecture-boundary': true }
    });
    try {
        const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
        profiles.built_in_profiles.balanced.review_remediation_mode_policy =
            buildDefaultReviewRemediationModePolicy();
        const remediationPolicy = profiles.built_in_profiles.balanced.review_remediation_mode_policy;
        remediationPolicy.delta_eligible_review_types.push('architecture-boundary');
        remediationPolicy.delta_eligible_review_types.sort();
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');

        const policy = resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: false });
        assert.ok(policy.review_remediation_mode_policy.policy.delta_eligible_review_types.includes(
            'architecture-boundary'
        ));

        remediationPolicy.delta_eligible_review_types.push('ghost');
        remediationPolicy.delta_eligible_review_types.sort();
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
        assert.throws(
            () => resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: false }),
            /absent from the review catalog: ghost/iu
        );
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy rejects a required lane with a disabled capability', () => {
    const bundleRoot = makeTempBundle({
        reviewCatalog: customReviewCatalog(),
        reviewCapabilities: { 'architecture-boundary': false }
    });
    try {
        const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: Record<string, { review_policy: Record<string, boolean | 'auto'> }>;
        };
        profiles.built_in_profiles.balanced.review_policy['architecture-boundary'] = true;
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');

        assert.throws(
            () => resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: false }),
            /architecture-boundary.*required.*capability.*disabled/iu
        );
    } finally {
        cleanUp(bundleRoot);
    }
});


test('mergeTokenEconomy: profile overrides boolean flags, config keeps numeric', () => {
    const profileTE: ProfileTokenEconomy = { enabled: false, strip_examples: false, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true };
    const configTE: TokenEconomyConfig = { enabled: true, enabled_depths: [1, 2, 3], strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true, fail_tail_lines: 75 };
    const merged = mergeTokenEconomy(profileTE, configTE);
    assert.equal(merged.enabled, false);
    assert.equal(merged.strip_examples, false);
    assert.equal(merged.strip_code_blocks, true);
    assert.equal(merged.scoped_diffs, false);
    assert.deepEqual(merged.enabled_depths, [1, 2, 3]);
    assert.equal(merged.fail_tail_lines, 75);
});


test('mergeSkills: profile controls flags, config controls packs', () => {
    const profileSkills: ProfileSkills = { auto_suggest: false };
    const skillPacks: SkillPacksConfig = { version: 1, installed_packs: ['docs-process'] };
    const { skills, installed_packs } = mergeSkills(profileSkills, skillPacks);
    assert.equal(skills.auto_suggest, false);
    assert.deepEqual(installed_packs, ['docs-process']);
});


test('loadPathsConfig returns defaults for missing file', () => {
    const config = loadPathsConfig('/nonexistent/paths.json');
    assert.ok(Array.isArray(config.runtime_roots));
    assert.ok(config.runtime_roots.length > 0);
    assert.deepEqual(config.triggers, {});
});

test('loadPathsConfig reads config values', () => {
    const bundleRoot = makeTempBundle({ paths: {
        metrics_path: 'custom/metrics.jsonl',
        runtime_roots: ['src/', 'lib/'],
        fast_path_roots: ['web/'],
        fast_path_allowed_regexes: ['\\.ts$'],
        fast_path_sensitive_regexes: [],
        sql_or_migration_regexes: ['\\.sql$'],
        triggers: { db: ['(^|/)db/'], security: ['(^|/)auth/'] },
        code_like_regexes: ['\\.ts$']
    }});
    try {
        const config = loadPathsConfig(path.join(bundleRoot, 'live', 'config', 'paths.json'));
        assert.equal(config.metrics_path, 'custom/metrics.jsonl');
        assert.deepEqual(config.runtime_roots, ['src/', 'lib/']);
        assert.deepEqual(Object.keys(config.triggers), ['db', 'security']);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('loadPathsConfig filters non-string array elements', () => {
    const bundleRoot = makeTempBundle({ paths: {
        metrics_path: '',
        runtime_roots: ['src/', 42, null, 'lib/'],
        fast_path_roots: [],
        fast_path_allowed_regexes: [],
        fast_path_sensitive_regexes: [],
        sql_or_migration_regexes: [],
        triggers: { db: ['pattern', 123] },
        code_like_regexes: []
    }});
    try {
        const config = loadPathsConfig(path.join(bundleRoot, 'live', 'config', 'paths.json'));
        assert.deepEqual(config.runtime_roots, ['src/', 'lib/']);
        assert.deepEqual(config.triggers.db, ['pattern']);
    } finally {
        cleanUp(bundleRoot);
    }
});


test('resolveEffectivePolicy: balanced profile with defaults', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.equal(policy.profile_name, 'balanced');
        assert.equal(policy.profile_source, 'built_in');
        assert.equal(policy.depth, 2);
        assert.equal(policy.review_policy.code, true);
        assert.equal(policy.review_finding_policy.policy_id, 'balanced');
        assert.equal(policy.review_finding_policy.findings.critical, 'fix_now');
        assert.equal(policy.review_finding_policy.findings.high, 'fix_now');
        assert.equal(policy.review_finding_policy.findings.medium, 'fix_now');
        assert.equal(policy.review_finding_policy.findings.low, 'create_follow_up');
        assert.equal(policy.review_finding_policy.residual_risk, 'create_follow_up');
        assert.equal(policy.review_finding_policy_diagnostics.length, 1);
        assert.match(policy.review_finding_policy_diagnostics[0], /resolved/i);
        assert.equal(policy.review_follow_up_policy.materialization_mode, 'grouped_by_parent');
        assert.match(policy.review_follow_up_policy_diagnostics.join('\n'), /resolved/i);
        assert.equal(policy.token_economy.enabled, true);
        assert.equal(policy.safety_floors_applied.length, 0);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: legacy profile without review_finding_policy resolves fail-closed to strict', () => {
    const profiles = {
        version: 1,
        active_profile: 'legacy',
        built_in_profiles: {
            legacy: {
                description: 'Legacy profile.',
                depth: 2,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    };
    const bundleRoot = makeTempBundle({ profiles });
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.equal(policy.review_finding_policy.policy_id, 'strict');
        assert.deepEqual(policy.review_finding_policy.findings, {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'fix_now'
        });
        assert.equal(policy.review_finding_policy.residual_risk, 'fix_now');
        assert.match(policy.review_finding_policy_diagnostics.join('\n'), /missing review_finding_policy/i);
        assert.match(policy.review_finding_policy_diagnostics.join('\n'), /fail-closed to strict/i);
        assert.equal(policy.review_follow_up_policy.materialization_mode, 'per_finding');
        assert.match(policy.review_follow_up_policy_diagnostics.join('\n'), /defaulted compatibly/i);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: custom review_finding_policy cannot weaken critical safety floor', () => {
    const profiles = {
        version: 1,
        active_profile: 'custom',
        built_in_profiles: {
            custom: {
                description: 'Custom profile.',
                depth: 2,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'custom',
                    findings: {
                        critical: 'ignore',
                        high: 'create_follow_up',
                        medium: 'ignore',
                        low: 'ignore'
                    },
                    residual_risk: 'ignore'
                },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    };
    const bundleRoot = makeTempBundle({ profiles });
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.equal(policy.review_finding_policy.policy_id, 'strict');
        assert.deepEqual(policy.review_finding_policy.findings, {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'fix_now'
        });
        assert.equal(policy.review_finding_policy.residual_risk, 'fix_now');
        assert.match(policy.review_finding_policy_diagnostics.join('\n'), /immutable safety floor/i);
        assert.match(policy.review_finding_policy_diagnostics.join('\n'), /fail-closed to strict/i);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: docs-only profile enforces code safety floor for code tasks', () => {
    const profiles = {
        version: 1, active_profile: 'docs-only',
        built_in_profiles: {
            'docs-only': {
                description: 'Docs only.',
                depth: 1,
                review_policy: { code: false, db: false, security: false, refactor: false },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                skills: { auto_suggest: false }
            }
        },
        user_profiles: {}
    };
    const bundleRoot = makeTempBundle({ profiles });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: true });
        assert.equal(policy.review_policy.code, true);
        assert.ok(policy.safety_floors_applied.length > 0);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: docs-only profile allows code=false for non-code tasks', () => {
    const profiles = {
        version: 1, active_profile: 'docs-only',
        built_in_profiles: {
            'docs-only': {
                description: 'Docs only.',
                depth: 1,
                review_policy: { code: false, db: false, security: false, refactor: false },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                skills: { auto_suggest: false }
            }
        },
        user_profiles: {}
    };
    const bundleRoot = makeTempBundle({ profiles });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: false });
        assert.equal(policy.review_policy.code, false);
        assert.equal(policy.safety_floors_applied.length, 0);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: profileOverride selects different profile', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { profileOverride: 'strict', isCodeChangingTask: false });
        assert.equal(policy.profile_name, 'strict');
        assert.equal(policy.depth, 3);
        assert.equal(policy.review_policy.db, true);
        assert.equal(policy.review_policy.security, true);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: unknown profileOverride throws', () => {
    const bundleRoot = makeTempBundle({});
    try {
        assert.throws(
            () => resolveEffectivePolicy(bundleRoot, { profileOverride: 'nonexistent' }),
            /not found/
        );
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: user profile resolution', () => {
    const profiles = {
        version: 1, active_profile: 'my-team',
        built_in_profiles: {
            balanced: {
                description: 'Default.',
                depth: 2,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {
            'my-team': {
                description: 'Team profile.',
                depth: 3,
                review_policy: { code: true, db: true, security: true, refactor: true },
                token_economy: { enabled: false, strip_examples: false, strip_code_blocks: false, scoped_diffs: true, compact_reviewer_output: false },
                skills: { auto_suggest: true }
            }
        }
    };
    const bundleRoot = makeTempBundle({ profiles });
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.equal(policy.profile_name, 'my-team');
        assert.equal(policy.profile_source, 'user');
        assert.equal(policy.depth, 3);
        assert.equal(policy.token_economy.enabled, false);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: missing config files fall back to defaults', () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-policy-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const profiles = {
        version: 1, active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Default.',
                depth: 2,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    };
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify(profiles, null, 2), 'utf8');
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.equal(policy.profile_name, 'balanced');
        assert.equal(policy.review_policy.code, true);
        assert.equal(policy.token_economy.fail_tail_lines, 50);
        assert.deepEqual(policy.installed_packs, []);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: installed skill packs are passed through', () => {
    const bundleRoot = makeTempBundle({ skillPacks: { version: 1, installed_packs: ['docs-process', 'testing-strategy'] } });
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.deepEqual(policy.installed_packs, ['docs-process', 'testing-strategy']);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: config token_economy numeric fields preserved', () => {
    const bundleRoot = makeTempBundle({ tokenEconomy: {
        enabled: true, enabled_depths: [3],
        strip_examples: true, strip_code_blocks: true,
        scoped_diffs: true, compact_reviewer_output: true,
        fail_tail_lines: 200
    }});
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.deepEqual(policy.token_economy.enabled_depths, [3]);
        assert.equal(policy.token_economy.fail_tail_lines, 200);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: fast profile disables non-code domain reviews', () => {
    const bundleRoot = makeTempBundle({
        reviewCapabilities: {
            code: true, db: false, security: true, refactor: true,
            api: false, test: false, performance: false, infra: false, dependency: false
        }
    });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { profileOverride: 'fast', isCodeChangingTask: false });
        assert.equal(policy.review_policy.db, false);
        assert.equal(policy.review_policy.refactor, false);
        assert.equal(policy.review_policy.security, false);
        assert.equal(policy.review_policy.test, false);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: strict profile requires selected reviews and leaves domain reviews capability-driven', () => {
    const bundleRoot = makeTempBundle({
        reviewCapabilities: {
            code: true, db: false, security: false, refactor: false,
            api: false, test: false, performance: false, infra: false, dependency: false
        }
    });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { profileOverride: 'strict', isCodeChangingTask: false });
        assert.equal(policy.review_policy.code, true);
        assert.equal(policy.review_policy.db, false);
        assert.equal(policy.review_policy.security, true);
        assert.equal(policy.review_policy.refactor, false);
        assert.equal(policy.review_policy.performance, true);
        assert.equal(policy.review_policy.test, true);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: strict profile suppresses auto domain reviews without domain surface evidence', () => {
    const bundleRoot = makeTempBundle({
        reviewCapabilities: {
            code: true, db: true, security: true, refactor: true,
            api: true, test: true, performance: true, infra: true, dependency: true
        }
    });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, {
            profileOverride: 'strict',
            scopeCategory: 'code',
            domainSurface: {
                db: false,
                api: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        assert.equal(policy.review_policy.code, true);
        assert.equal(policy.review_policy.security, true);
        assert.equal(policy.review_policy.refactor, false);
        assert.equal(policy.review_policy.test, true);
        assert.equal(policy.review_policy.performance, true);
        assert.equal(policy.review_policy.db, false);
        assert.equal(policy.review_policy.api, false);
        assert.equal(policy.review_policy.dependency, false);
        const dbDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'db');
        const apiDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'api');
        const performanceDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'performance');
        const dependencyDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'dependency');
        assert.equal(dbDecision?.decision, 'not_applicable_no_domain_surface');
        assert.equal(dbDecision?.effective_value, false);
        assert.equal(apiDecision?.decision, 'not_applicable_no_domain_surface');
        assert.equal(performanceDecision?.decision, 'profile_forced');
        assert.equal(performanceDecision?.effective_value, true);
        assert.equal(dependencyDecision?.decision, 'not_applicable_no_domain_surface');
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: strict profile keeps domain review when domain surface evidence is present', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot, {
            profileOverride: 'strict',
            scopeCategory: 'code',
            domainSurface: { db: true }
        });
        assert.equal(policy.review_policy.db, true);
        const dbDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'db');
        assert.equal(dbDecision?.decision, 'domain_triggered');
        assert.equal(dbDecision?.effective_value, true);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: explicit all-domain override keeps strict domain reviews without surface evidence', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot, {
            profileOverride: 'strict',
            scopeCategory: 'code',
            domainSurface: {
                db: false,
                api: false,
                performance: false,
                infra: false,
                dependency: false
            },
            forceAllDomainReviews: true
        });
        assert.equal(policy.review_policy.db, true);
        assert.equal(policy.review_policy.api, true);
        assert.equal(policy.review_policy.performance, true);
        assert.equal(policy.review_policy.dependency, true);
        assert.equal(policy.review_policy.infra, true);
        const dbDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'db');
        const apiDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'api');
        const performanceDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'performance');
        const dependencyDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'dependency');
        assert.equal(dbDecision?.decision, 'profile_forced');
        assert.equal(dbDecision?.effective_value, true);
        assert.equal(apiDecision?.decision, 'profile_forced');
        assert.equal(performanceDecision?.decision, 'profile_forced');
        assert.equal(dependencyDecision?.decision, 'profile_forced');
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: resolution_sources populated', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.ok(policy.resolution_sources.profiles.endsWith('profiles.json'));
        assert.ok(policy.resolution_sources.review_capabilities.endsWith('review-capabilities.json'));
        assert.ok(policy.resolution_sources.token_economy.endsWith('token-economy.json'));
        assert.ok(policy.resolution_sources.skill_packs.endsWith('skill-packs.json'));
        assert.ok(policy.resolution_sources.paths.endsWith('paths.json'));
    } finally {
        cleanUp(bundleRoot);
    }
});


test('resolveEffectivePolicy: config files are not modified after resolution', () => {
    const bundleRoot = makeTempBundle({});
    const configDir = path.join(bundleRoot, 'live', 'config');
    const profilesBefore = fs.readFileSync(path.join(configDir, 'profiles.json'), 'utf8');
    const capsBefore = fs.readFileSync(path.join(configDir, 'review-capabilities.json'), 'utf8');
    const tokenBefore = fs.readFileSync(path.join(configDir, 'token-economy.json'), 'utf8');
    const skillBefore = fs.readFileSync(path.join(configDir, 'skill-packs.json'), 'utf8');
    const pathsBefore = fs.readFileSync(path.join(configDir, 'paths.json'), 'utf8');

    try {
        resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: true });
        resolveEffectivePolicy(bundleRoot, { profileOverride: 'strict', isCodeChangingTask: false });
        resolveEffectivePolicy(bundleRoot, { profileOverride: 'docs-only', isCodeChangingTask: true });

        assert.equal(fs.readFileSync(path.join(configDir, 'profiles.json'), 'utf8'), profilesBefore);
        assert.equal(fs.readFileSync(path.join(configDir, 'review-capabilities.json'), 'utf8'), capsBefore);
        assert.equal(fs.readFileSync(path.join(configDir, 'token-economy.json'), 'utf8'), tokenBefore);
        assert.equal(fs.readFileSync(path.join(configDir, 'skill-packs.json'), 'utf8'), skillBefore);
        assert.equal(fs.readFileSync(path.join(configDir, 'paths.json'), 'utf8'), pathsBefore);
    } finally {
        cleanUp(bundleRoot);
    }
});


test('formatEffectivePolicy produces readable text', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        const text = formatEffectivePolicy(policy);
        assert.ok(text.includes('EFFECTIVE_POLICY'));
        assert.ok(text.includes('Profile: balanced'));
        assert.ok(text.includes('Depth: 2'));
        assert.ok(text.includes('ReviewPolicy:'));
        assert.ok(text.includes('TokenEconomy:'));
    } finally {
        cleanUp(bundleRoot);
    }
});

test('formatEffectivePolicy includes safety floors section when floors applied', () => {
    const profiles = {
        version: 1, active_profile: 'docs-only',
        built_in_profiles: {
            'docs-only': {
                description: 'Docs only.',
                depth: 1,
                review_policy: { code: false, db: false, security: false, refactor: false },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                skills: { auto_suggest: false }
            }
        },
        user_profiles: {}
    };
    const bundleRoot = makeTempBundle({ profiles });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { isCodeChangingTask: true });
        const text = formatEffectivePolicy(policy);
        assert.ok(text.includes('SafetyFloors:'));
        assert.ok(text.includes('code'));
    } finally {
        cleanUp(bundleRoot);
    }
});

test('formatEffectivePolicyJson produces valid JSON', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        const json = formatEffectivePolicyJson(policy);
        const parsed = JSON.parse(json);
        assert.equal(parsed.profile_name, 'balanced');
        assert.equal(parsed.depth, 2);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('formatEffectivePolicy: installed packs shown when present', () => {
    const bundleRoot = makeTempBundle({ skillPacks: { version: 1, installed_packs: ['docs-process'] } });
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        const text = formatEffectivePolicy(policy);
        assert.ok(text.includes('installed_packs: [docs-process]'));
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: paths config included in effective policy', () => {
    const bundleRoot = makeTempBundle({ paths: {
        metrics_path: 'test/metrics.jsonl',
        runtime_roots: ['src/', 'lib/'],
        fast_path_roots: ['web/'],
        fast_path_allowed_regexes: [],
        fast_path_sensitive_regexes: [],
        sql_or_migration_regexes: [],
        triggers: { db: ['(^|/)db/'], security: ['(^|/)auth/'] },
        code_like_regexes: ['\\.ts$']
    }});
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.deepEqual(policy.paths.runtime_roots, ['src/', 'lib/']);
        assert.deepEqual(Object.keys(policy.paths.triggers), ['db', 'security']);
        assert.equal(policy.paths.metrics_path, 'test/metrics.jsonl');
    } finally {
        cleanUp(bundleRoot);
    }
});

test('formatEffectivePolicy: includes Paths section', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        const text = formatEffectivePolicy(policy);
        assert.ok(text.includes('Paths:'));
        assert.ok(text.includes('runtime_roots: [src/]'));
        assert.ok(text.includes('fast_path_roots: [frontend/]'));
        assert.ok(text.includes('trigger_categories: [db, security]'));
    } finally {
        cleanUp(bundleRoot);
    }
});


test('resolveEffectivePolicy: isCodeChangingTask defaults to true', () => {
    const profiles = {
        version: 1, active_profile: 'docs-only',
        built_in_profiles: {
            'docs-only': {
                description: 'Docs only.',
                depth: 1,
                review_policy: { code: false, db: false, security: false, refactor: false },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                skills: { auto_suggest: false }
            }
        },
        user_profiles: {}
    };
    const bundleRoot = makeTempBundle({ profiles });
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.equal(policy.review_policy.code, true, 'code review should be forced by safety floor when isCodeChangingTask defaults to true');
    } finally {
        cleanUp(bundleRoot);
    }
});

test('mergeReviewPolicy: extra capability keys not in profile are preserved', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: 'auto' };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: true, test: true, performance: true, infra: false, dependency: true
    };
    const { merged } = mergeReviewPolicy(profile, caps, false);
    assert.equal(merged.api, true);
    assert.equal(merged.test, true);
    assert.equal(merged.performance, true);
    assert.equal(merged.infra, false);
    assert.equal(merged.dependency, true);
});

test('mergeReviewPolicy: extra profile keys not in capabilities are included', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: 'auto', custom_review: true };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const { merged } = mergeReviewPolicy(profile, caps, false);
    assert.equal(merged.custom_review, true);
});


test('mergeReviewPolicy: code-changing task enforces code+security+db+refactor safety floors', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const { merged, floorsApplied } = mergeReviewPolicy(profile, caps, true);
    assert.equal(merged.code, true, 'code must be true for code-changing tasks');
    assert.equal(merged.security, true, 'security must be true for code-changing tasks');
    assert.equal(merged.db, true, 'db must be true for code-changing tasks');
    assert.equal(merged.refactor, true, 'refactor must be true for code-changing tasks');
    assert.equal(floorsApplied.length, 4, 'all four floors should fire');
});

test('mergeReviewPolicy: non-code task allows profile to disable code/security/db/refactor', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const { merged, floorsApplied } = mergeReviewPolicy(profile, caps, false);
    assert.equal(merged.code, false, 'code can be disabled for non-code tasks');
    assert.equal(merged.security, false, 'security can be disabled for non-code tasks');
    assert.equal(merged.db, false, 'db can be disabled for non-code tasks');
    assert.equal(merged.refactor, false, 'refactor can be disabled for non-code tasks');
    assert.equal(floorsApplied.length, 0, 'no floors should fire');
});

test('mergeReviewPolicy: code-changing task does not override already-true values', () => {
    const profile: ProfileReviewPolicy = { code: true, db: true, security: true, refactor: true };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const { merged, floorsApplied } = mergeReviewPolicy(profile, caps, true);
    assert.equal(merged.code, true);
    assert.equal(merged.security, true);
    assert.equal(merged.db, true);
    assert.equal(merged.refactor, true);
    assert.equal(floorsApplied.length, 0, 'no floors needed when profile already enables them');
});


test('applyProfileGuardrails: code scope triggers guardrails', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'code', 'docs-only');
    assert.equal(result.guardrails_active, true);
    assert.equal(result.lightening_eligible, false);
    assert.equal(result.is_code_changing_task, true);
    const flooredDecisions = result.decisions.filter(d => d.decision === 'safety_floor_enforced');
    assert.equal(flooredDecisions.length, 4, 'code+security+db+refactor should be floored');
});

test('applyProfileGuardrails: docs-only scope allows lightening', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'docs-only', 'docs-only');
    assert.equal(result.guardrails_active, false);
    assert.equal(result.lightening_eligible, true);
    assert.equal(result.is_code_changing_task, false);
    const lightened = result.decisions.filter(d => d.decision === 'lightened_by_profile');
    assert.ok(lightened.length >= 4, 'docs-only scope should lighten code/security/db/refactor');
});

test('applyProfileGuardrails: docs-only scope suppresses strict profile code security and refactor without sensitive surface', () => {
    const profile: ProfileReviewPolicy = { code: true, db: true, security: true, refactor: true };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: true, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'docs-only', 'strict', {
        domainSurface: {
            db: false,
            security: false,
            api: false,
            performance: false,
            infra: false,
            dependency: false
        }
    });

    assert.equal(result.guardrails_active, false);
    assert.equal(result.lightening_eligible, true);
    for (const reviewType of ['code', 'security', 'refactor']) {
        const decision = result.decisions.find(d => d.review_type === reviewType);
        assert.equal(decision?.effective_value, false, `${reviewType} review should be suppressed`);
        assert.equal(decision?.decision, 'lightened_by_profile');
        assert.match(String(decision?.reason || ''), /docs-only/);
    }
});

test('applyProfileGuardrails: docs-only scope keeps security review for sensitive docs surface', () => {
    const profile: ProfileReviewPolicy = { code: true, db: true, security: true, refactor: true };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: true, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'docs-only', 'strict', {
        domainSurface: {
            db: false,
            security: true,
            api: false,
            performance: false,
            infra: false,
            dependency: false
        }
    });

    const securityDecision = result.decisions.find(d => d.review_type === 'security');
    assert.equal(securityDecision?.effective_value, true);
    assert.equal(securityDecision?.decision, 'profile_forced');
    for (const reviewType of ['code', 'refactor']) {
        const decision = result.decisions.find(d => d.review_type === reviewType);
        assert.equal(decision?.effective_value, false, `${reviewType} review should still be suppressed`);
        assert.equal(decision?.decision, 'lightened_by_profile');
    }
});

test('applyProfileGuardrails: test-only scope suppresses profile-forced code security and refactor reviews', () => {
    const profile: ProfileReviewPolicy = { code: true, db: true, security: true, refactor: true, test: true };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: true, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'test-only', 'strict', {
        domainSurface: {
            db: false,
            security: false,
            api: false,
            performance: false,
            infra: false,
            dependency: false
        }
    });

    assert.equal(result.guardrails_active, false);
    assert.equal(result.lightening_eligible, true);
    assert.equal(result.is_code_changing_task, false);
    for (const reviewType of ['code', 'security', 'refactor']) {
        const decision = result.decisions.find(d => d.review_type === reviewType);
        assert.equal(decision?.effective_value, false, `${reviewType} review should be suppressed`);
        assert.equal(decision?.decision, 'lightened_by_profile');
        assert.match(String(decision?.reason || ''), /test-only/);
    }
    assert.equal(result.decisions.find(d => d.review_type === 'test')?.effective_value, true);
});

test('applyProfileGuardrails: test-only scope keeps security review for sensitive test paths', () => {
    const profile: ProfileReviewPolicy = { code: true, db: true, security: true, refactor: true };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: true, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'test-only', 'strict', {
        domainSurface: {
            db: false,
            security: true,
            api: false,
            performance: false,
            infra: false,
            dependency: false
        }
    });
    const securityDecision = result.decisions.find(d => d.review_type === 'security');
    assert.equal(securityDecision?.effective_value, true);
    assert.equal(securityDecision?.decision, 'profile_forced');
});

test('applyProfileGuardrails: test-only scope keeps security review when domain surface evidence is absent', () => {
    const profile: ProfileReviewPolicy = { code: true, db: true, security: true, refactor: true };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: true, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'test-only', 'strict');
    const securityDecision = result.decisions.find(d => d.review_type === 'security');
    assert.equal(securityDecision?.effective_value, true);
    assert.equal(securityDecision?.decision, 'profile_forced');
});

test('applyProfileGuardrails: fast docs-only scope lightens explicit code review', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'docs-only', 'fast');
    const codeDecision = result.decisions.find(d => d.review_type === 'code');
    assert.equal(codeDecision?.effective_value, false);
    assert.equal(codeDecision?.decision, 'lightened_by_profile');
    assert.match(String(codeDecision?.reason || ''), /true docs-only scope/);
});

test('applyProfileGuardrails: balanced docs-only scope lightens explicit code review', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: 'auto' };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: true, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'docs-only', 'balanced');
    const codeDecision = result.decisions.find(d => d.review_type === 'code');
    assert.equal(codeDecision?.effective_value, false);
    assert.equal(codeDecision?.decision, 'lightened_by_profile');
});

test('applyProfileGuardrails: zero-diff baseline-only scope suppresses profile-forced reviews', () => {
    const profile: ProfileReviewPolicy = { code: true, db: true, security: true, refactor: true };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: true, test: true, performance: true, infra: false, dependency: true
    };
    const result = applyProfileGuardrails(profile, caps, 'empty', 'strict', {
        zeroDiffBaselineOnly: true,
        domainSurface: {
            db: false,
            api: false,
            performance: false,
            infra: false,
            dependency: false
        }
    });

    assert.equal(result.zero_diff_no_reviewable_scope, true);
    assert.equal(result.guardrails_active, false);
    assert.equal(result.lightening_eligible, true);
    for (const reviewType of ['code', 'security', 'refactor', 'db']) {
        const decision = result.decisions.find(d => d.review_type === reviewType);
        assert.equal(decision?.effective_value, false, `${reviewType} review should be suppressed`);
        assert.equal(decision?.decision, 'zero_diff_no_reviewable_scope');
        assert.match(String(decision?.reason || ''), /no reviewable diff/);
    }
    assert.equal(result.safety_floors_applied.length, 0);
});

test('applyProfileGuardrails: zero-diff suppression fails closed when code review is forced', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'empty', 'fast', {
        zeroDiffBaselineOnly: true,
        forceCodeReview: true,
        domainSurface: {
            db: false,
            api: false,
            performance: false,
            infra: false,
            dependency: false
        }
    });
    const codeDecision = result.decisions.find(d => d.review_type === 'code');
    assert.equal(result.zero_diff_no_reviewable_scope, false);
    assert.equal(codeDecision?.effective_value, true);
    assert.equal(codeDecision?.decision, 'profile_forced');
});

test('applyProfileGuardrails: fast docs-only suppresses code review for protected control-plane docs surface', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(
        profile,
        caps,
        'docs-only',
        'fast',
        { protectedControlPlaneChanged: true, protectedControlPlaneDocsOnly: true }
    );
    const codeDecision = result.decisions.find(d => d.review_type === 'code');
    assert.equal(codeDecision?.effective_value, false);
    assert.equal(codeDecision?.decision, 'lightened_by_profile');
});

test('applyProfileGuardrails: fast docs-only keeps code review for non-doc protected control-plane scope', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(
        profile,
        caps,
        'docs-only',
        'fast',
        { protectedControlPlaneChanged: true, protectedControlPlaneDocsOnly: false }
    );
    const codeDecision = result.decisions.find(d => d.review_type === 'code');
    assert.equal(codeDecision?.effective_value, true);
    assert.equal(codeDecision?.decision, 'profile_forced');
});

test('applyProfileGuardrails: fast docs-only keeps code review when explicitly forced', () => {
    const profile: ProfileReviewPolicy = { code: true, db: 'auto', security: 'auto', refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(
        profile,
        caps,
        'docs-only',
        'fast',
        { forceCodeReview: true }
    );
    const codeDecision = result.decisions.find(d => d.review_type === 'code');
    assert.equal(codeDecision?.effective_value, true);
    assert.equal(codeDecision?.decision, 'profile_forced');
    assert.match(String(codeDecision?.reason || ''), /explicitly forced/);
});

test('applyProfileGuardrails: config-only scope allows lightening', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'config-only', 'fast');
    assert.equal(result.guardrails_active, false);
    assert.equal(result.lightening_eligible, true);
});

test('applyProfileGuardrails: audit-only scope allows lightening', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'audit-only', 'docs-only');
    assert.equal(result.lightening_eligible, true);
    assert.equal(result.guardrails_active, false);
});

test('applyProfileGuardrails: mixed scope triggers guardrails', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'mixed', 'fast');
    assert.equal(result.guardrails_active, true);
    assert.equal(result.lightening_eligible, false);
});

test('applyProfileGuardrails: auto profile values show as capability_default', () => {
    const profile: ProfileReviewPolicy = { code: 'auto', db: 'auto', security: 'auto', refactor: 'auto' };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'docs-only', 'balanced');
    const capDefaults = result.decisions.filter(d => d.decision === 'capability_default');
    assert.ok(capDefaults.length >= 4, 'auto values should show as capability_default');
});


test('formatProfileGuardrailDiagnostics: includes all diagnostic fields', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'code', 'docs-only');
    const text = formatProfileGuardrailDiagnostics(result);
    assert.ok(text.includes('PROFILE_REVIEW_DECISIONS'));
    assert.ok(text.includes('Profile: docs-only'));
    assert.ok(text.includes('ScopeCategory: code'));
    assert.ok(text.includes('GuardrailsActive: true'));
    assert.ok(text.includes('safety_floor_enforced'));
    assert.ok(text.includes('SafetyFloors:'));
});

test('formatProfileGuardrailDiagnostics: shows lightened decisions for docs-only', () => {
    const profile: ProfileReviewPolicy = { code: false, db: false, security: false, refactor: false };
    const caps: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const result = applyProfileGuardrails(profile, caps, 'docs-only', 'docs-only');
    const text = formatProfileGuardrailDiagnostics(result);
    assert.ok(text.includes('LighteningEligible: true'));
    assert.ok(text.includes('lightened_by_profile'));
    assert.ok(!text.includes('SafetyFloors:'), 'no safety floors for docs-only');
});


test('resolveEffectivePolicy: scopeCategory docs-only allows profile to disable code review', () => {
    const bundleRoot = makeTempBundle({
        profiles: {
            version: 1,
            active_profile: 'docs-only',
            built_in_profiles: {
                'docs-only': {
                    description: 'Docs only.',
                    depth: 1,
                    review_policy: { code: false, db: false, security: false, refactor: false },
                    token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                    skills: { auto_suggest: false }
                }
            },
            user_profiles: {}
        }
    });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { scopeCategory: 'docs-only' });
        assert.equal(policy.review_policy.code, false, 'code review should be off for docs-only scope');
        assert.equal(policy.review_policy.security, false, 'security review should be off for docs-only scope');
        assert.equal(policy.safety_floors_applied.length, 0);
        assert.ok(policy.guardrail_diagnostics !== null);
        assert.equal(policy.guardrail_diagnostics!.lightening_eligible, true);
        assert.equal(policy.scope_category, 'docs-only');
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: balanced docs-only protected docs surface does not force code review', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot, {
            scopeCategory: 'docs-only',
            protectedControlPlaneChanged: true,
            protectedControlPlaneDocsOnly: true
        });
        assert.equal(policy.review_policy.code, false, 'protected documentation surface should not force code review');
        const codeDecision = policy.guardrail_diagnostics!.decisions.find(d => d.review_type === 'code');
        assert.equal(codeDecision?.decision, 'lightened_by_profile');
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: scopeCategory code enforces safety floors even with docs-only profile', () => {
    const bundleRoot = makeTempBundle({
        profiles: {
            version: 1,
            active_profile: 'docs-only',
            built_in_profiles: {
                'docs-only': {
                    description: 'Docs only.',
                    depth: 1,
                    review_policy: { code: false, db: false, security: false, refactor: false },
                    token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                    skills: { auto_suggest: false }
                }
            },
            user_profiles: {}
        }
    });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { scopeCategory: 'code' });
        assert.equal(policy.review_policy.code, true, 'code review must be enforced for code scope');
        assert.equal(policy.review_policy.security, true, 'security must be enforced for code scope');
        assert.equal(policy.review_policy.db, true, 'db must be enforced for code scope');
        assert.equal(policy.review_policy.refactor, true, 'refactor must be enforced for code scope');
        assert.equal(policy.safety_floors_applied.length, 4);
        assert.equal(policy.review_catalog_policy?.activity_basis, 'profile_policy_and_capability');
        assert.equal(policy.review_catalog_policy?.task_effective_selection, 'resolved_during_preflight');
        const codeLane = policy.review_catalog_policy?.lanes.find(({ id }) => id === 'code');
        assert.equal(codeLane?.state, 'disabled');
        assert.equal(codeLane?.active, false, 'catalog activity describes profile eligibility, not task selection');
        assert.ok(policy.guardrail_diagnostics !== null);
        assert.equal(policy.guardrail_diagnostics!.guardrails_active, true);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('resolveEffectivePolicy: no guardrail diagnostics without scopeCategory', () => {
    const bundleRoot = makeTempBundle({});
    try {
        const policy = resolveEffectivePolicy(bundleRoot);
        assert.equal(policy.guardrail_diagnostics, null);
        assert.equal(policy.scope_category, null);
    } finally {
        cleanUp(bundleRoot);
    }
});

test('formatEffectivePolicy: includes scope category and guardrail diagnostics', () => {
    const bundleRoot = makeTempBundle({
        profiles: {
            version: 1,
            active_profile: 'docs-only',
            built_in_profiles: {
                'docs-only': {
                    description: 'Docs only.',
                    depth: 1,
                    review_policy: { code: false, db: false, security: false, refactor: false },
                    token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                    skills: { auto_suggest: false }
                }
            },
            user_profiles: {}
        }
    });
    try {
        const policy = resolveEffectivePolicy(bundleRoot, { scopeCategory: 'docs-only' });
        const text = formatEffectivePolicy(policy);
        assert.ok(text.includes('ScopeCategory: docs-only'));
        assert.ok(text.includes('PROFILE_REVIEW_DECISIONS'));
        assert.ok(text.includes('LighteningEligible: true'));
    } finally {
        cleanUp(bundleRoot);
    }
});
