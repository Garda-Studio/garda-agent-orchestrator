import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import {
    handleProfile,
    buildProfileListOutput,
    buildProfileCurrentOutput,
    buildProfileUseOutput,
    buildProfileCreateOutput,
    buildProfileDeleteOutput,
    buildProfileValidateOutput,
    hashReviewFindingPolicy,
    runProfileFindingPolicyCommand
} from '../../../../src/cli/commands/profile';
import type { ProfileEntry } from '../../../../src/cli/commands/profile/profile-types';
import { handleUiProfileRequest } from '../../../../src/reports/ui/actions/profile-actions';
import { buildHelpText } from '../../../../src/cli/commands/cli-help-output';
import {
    buildDefaultReviewRemediationModePolicy,
    resolveReviewRemediationModePolicyFromProfile
} from '../../../../src/policy/review-remediation-mode-policy';
import {
    buildOperatorConfirmationArgs as freshOperatorConfirmationArgs
} from './operator-confirmation-test-helpers';

const PACKAGE_JSON = { name: 'test-pkg', version: '1.0.0' };

function createTempBundleWithProfiles(profiles?: Record<string, unknown>): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const data = profiles || {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Default profile.',
                depth: 2,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
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
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: true }
            },
            fast: {
                description: 'Speed-optimised profile.',
                depth: 1,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: false },
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
                review_policy: { code: true, db: true, security: true, refactor: true },
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
                description: 'Documentation-focused profile.',
                depth: 1,
                review_policy: { code: false, db: false, security: false, refactor: false },
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
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify(data, null, 2), 'utf8');
    return bundleRoot;
}

function writeCustomReviewConfig(bundleRoot: string, capabilityEnabled: boolean): void {
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.writeFileSync(path.join(configDir, 'review-catalog.json'), JSON.stringify({
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
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'review-capabilities.json'), JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: true,
        dependency: true,
        'architecture-boundary': capabilityEnabled
    }, null, 2), 'utf8');
}

function addInvalidInactiveProfile(bundleRoot: string): void {
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.user_profiles.invalid_inactive = {
        ...data.built_in_profiles.balanced,
        review_policy: {
            ...data.built_in_profiles.balanced.review_policy,
            ghost: 'auto'
        }
    };
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2), 'utf8');
}

function captureConsole(fn: () => unknown): { lines: string[]; result: unknown } {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
        const result = fn();
        return { lines, result };
    } finally {
        console.log = originalLog;
    }
}

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/gu, '');
}

function captureJsonProfileCommand(argv: string[]): Record<string, unknown> {
    const { lines } = captureConsole(() => handleProfile(argv, PACKAGE_JSON));
    return JSON.parse(lines.join('\n')) as Record<string, unknown>;
}

async function invokeUiProfileRequest(
    repoRoot: string,
    actionToken: string,
    payload: Record<string, unknown>
): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> {
    const localPort = 43821;
    const requestStream = new PassThrough();
    const request = requestStream as unknown as http.IncomingMessage;
    Object.assign(request, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${localPort}`,
            'x-garda-action-token': actionToken
        }
    });
    Object.defineProperty(request, 'socket', { value: { localPort } });
    let status = 0;
    let responseBody = '';
    const response = {
        writeHead(statusCode: number): void {
            status = statusCode;
        },
        end(chunk?: string): void {
            responseBody += chunk || '';
        }
    } as unknown as http.ServerResponse;
    const handling = handleUiProfileRequest(request, response, repoRoot, {
        actionsEnabled: true,
        actionToken,
        trustedOriginHost: '127.0.0.1',
        actionRunner: async () => ({ exit_code: 0, signal: null, stdout: '', stderr: '' })
    });
    requestStream.end(JSON.stringify(payload));
    await handling;
    return {
        status,
        json: async () => JSON.parse(responseBody) as Record<string, unknown>
    };
}

async function previewUiProfileRequest(
    repoRoot: string,
    actionToken: string,
    payload: Record<string, unknown>
): Promise<string> {
    const response = await invokeUiProfileRequest(repoRoot, actionToken, { ...payload, mode: 'preview' });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.status, 'previewed');
    assert.match(String(preview.preview_sha256), /^[a-f0-9]{64}$/u);
    return String(preview.preview_sha256);
}

async function captureConsoleAsync(fn: () => Promise<unknown>): Promise<{ lines: string[]; result: unknown }> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
        const result = await fn();
        return { lines, result };
    } finally {
        console.log = originalLog;
    }
}

test('profile list shows all profiles with active marker', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['list', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('GARDA_PROFILES'));
    assert.ok(output.includes('ActiveProfile: balanced'));
    assert.ok(output.includes('(*)'));
    assert.ok(output.includes('balanced'));
    assert.ok(output.includes('fast'));
    assert.ok(output.includes('strict'));
    assert.ok(output.includes('docs-only'));
    assert.match(output, /strict\s+depth=3 decomposition=true provenance=legacy_strict_compatibility/u);
    assert.match(output, /balanced\s+depth=2 decomposition=true provenance=legacy_balanced_default/u);
    assert.ok(output.includes('Review Catalog Lanes'));
});

test('profile list explains a new custom catalog lane as inactive until the profile enables it', () => {
    const bundleRoot = createTempBundleWithProfiles();
    writeCustomReviewConfig(bundleRoot, true);
    const { lines } = captureConsole(() => handleProfile(['list', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.match(output, /architecture-boundary\(disabled:profile_disabled\)/u);
});

test('profile list reports invalid inactive profile policy without blocking recovery', () => {
    const bundleRoot = createTempBundleWithProfiles();
    addInvalidInactiveProfile(bundleRoot);

    const parsed = captureJsonProfileCommand(['list', '--bundle-root', bundleRoot, '--json']);
    const policies = parsed.profile_review_catalog_policies as Record<string, Record<string, unknown>>;
    assert.equal(policies.balanced.validation_issues, undefined);
    assert.deepEqual(policies.invalid_inactive.validation_issues, [
        "Profile 'invalid_inactive' review_policy contains unknown catalog review id 'ghost'."
    ]);
});

test('profile command without subcommand shows current profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('GARDA_PROFILES'));
    assert.ok(output.includes('Action: current'));
    assert.ok(output.includes('ActiveProfile: balanced'));
    assert.ok(output.includes('Tip: run "profile list" to inspect all available profiles.'));
});

test('profile help documents guarded finding-policy preview and apply flow', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['--help', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = stripAnsi(lines.join('\n'));
    assert.match(output, /profile policy preview <name>/u);
    assert.match(output, /profile policy apply <name>/u);
    assert.match(output, /--expected-policy-sha256/u);
    assert.match(output, /--expected-plan-sha256/u);
    assert.match(output, /--critical fix_now/u);
    assert.match(output, /--residual-risk ACTION/u);
    assert.match(output, /future task snapshots only/u);

    for (const argv of [['policy', '--help'], ['policy', 'preview', '--help']]) {
        const nested = stripAnsi(captureConsole(() => handleProfile(argv, PACKAGE_JSON)).lines.join('\n'));
        assert.match(nested, /profile policy preview <name>/u);
    }
    assert.match(stripAnsi(buildHelpText(PACKAGE_JSON)), /profile\s+.*finding policy/iu);
});

test('profile policy rejects unrelated explicit target and bundle roots', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const unrelatedTargetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-target-'));

    assert.throws(
        () => handleProfile([
            'policy', 'preview', 'balanced',
            '--preset', 'strict',
            '--target-root', unrelatedTargetRoot,
            '--bundle-root', bundleRoot,
            '--json'
        ], PACKAGE_JSON),
        /target-root.*parent.*bundle-root/iu
    );
});

test('profile list --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['list', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.active_profile, 'balanced');
    assert.ok(Array.isArray(parsed.built_in_profiles));
    assert.ok(parsed.built_in_profiles.includes('balanced'));
    assert.equal(
        (parsed.profile_task_decomposition_policies as Record<string, { enabled: boolean }>).strict.enabled,
        true
    );
});

test('profile current shows active profile details', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['current', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('ActiveProfile: balanced'));
    assert.ok(output.includes('Type: built-in'));
    assert.ok(output.includes('Depth: 2'));
    assert.ok(output.includes('TaskDecomposition: enabled=true, configured=false, provenance=legacy_balanced_default'));
    assert.ok(output.includes('ReviewFindingPolicy: policy_id=balanced'));
    assert.ok(output.includes('critical=fix_now'));
    assert.ok(output.includes('residual_risk=create_follow_up'));
    assert.ok(output.includes('ReviewTriggerPolicy:'));
    assert.ok(output.includes('changed_lines_threshold=20'));
});

test('profile current --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['current', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.active_profile, 'balanced');
    assert.equal(parsed.is_built_in, true);
    assert.equal(parsed.entry.depth, 2);
    assert.equal(parsed.review_trigger_policy.schema_version, 1);
    assert.equal(parsed.review_trigger_policy.test_refactor_changed_lines_threshold, 20);
    assert.ok(parsed.review_trigger_policy.refactor_path_regexes.length > 0);
});

test('profile current ignores invalid inactive profile catalog policy', () => {
    const bundleRoot = createTempBundleWithProfiles();
    addInvalidInactiveProfile(bundleRoot);

    const { lines } = captureConsole(() => handleProfile([
        'current',
        '--bundle-root', bundleRoot,
        '--json'
    ], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.active_profile, 'balanced');
    assert.equal(parsed.review_catalog_policy.profile_name, 'balanced');
});

test('profile current exposes catalog lane states and activation reasons', () => {
    const bundleRoot = createTempBundleWithProfiles();
    writeCustomReviewConfig(bundleRoot, true);
    const parsed = captureJsonProfileCommand(['current', '--bundle-root', bundleRoot, '--json']);
    const catalogPolicy = parsed.review_catalog_policy as {
        activity_basis: string;
        task_effective_selection: string;
        catalog_sha256: string;
        policy_sha256: string;
        lanes: Array<Record<string, unknown>>;
    };
    const customLane = catalogPolicy.lanes.find((lane) => lane.id === 'architecture-boundary');
    assert.ok(customLane);
    assert.equal(customLane.state, 'disabled');
    assert.equal(customLane.active, false);
    assert.equal(customLane.inactive_reason, 'profile_disabled');
    assert.equal(catalogPolicy.activity_basis, 'profile_policy_and_capability');
    assert.equal(catalogPolicy.task_effective_selection, 'resolved_during_preflight');
    assert.match(catalogPolicy.catalog_sha256, /^[a-f0-9]{64}$/u);
    assert.match(catalogPolicy.policy_sha256, /^[a-f0-9]{64}$/u);
});

test('profile current rejects conflating profile eligibility with task-effective review selection', () => {
    const bundleRoot = createTempBundleWithProfiles();
    writeCustomReviewConfig(bundleRoot, true);
    const { lines } = captureConsole(() => handleProfile(['current', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.match(output, /activity_basis=profile_policy_and_capability/u);
    assert.match(output, /task_effective_selection=resolved_during_preflight/u);
    assert.match(output, /profile_inactive=/u);
});

test('profile use switches the active profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('PreviousProfile: balanced'));
    assert.ok(output.includes('ActiveProfile: fast'));
    assert.ok(output.includes('CHANGED'));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.equal(data.active_profile, 'fast');
});

test('profile use with nonexistent profile throws', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['use', 'nonexistent', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /not found/
    );
});

test('profile use with same profile shows NO_CHANGE', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['use', 'balanced', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('NO_CHANGE'));
});

test('profile create adds a user profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile([
        'create', 'my-custom',
        '--bundle-root', bundleRoot,
        '--description', 'A custom test profile',
        '--depth', '3'
    ], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('CREATED'));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(data.user_profiles['my-custom']);
    assert.equal(data.user_profiles['my-custom'].depth, 3);
    assert.equal(data.user_profiles['my-custom'].description, 'A custom test profile');
    assert.equal(data.user_profiles['my-custom'].review_finding_policy.policy_id, 'balanced');
    assert.equal(data.user_profiles['my-custom'].review_finding_policy.findings.critical, 'fix_now');
    assert.equal(data.user_profiles['my-custom'].review_finding_policy.findings.medium, 'fix_now');
    assert.equal(data.user_profiles['my-custom'].review_finding_policy.residual_risk, 'create_follow_up');
});

test('profile create with --copy-from clones an existing profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'strict-copy',
        '--bundle-root', bundleRoot,
        '--copy-from', 'strict',
        '--description', 'Strict clone'
    ], PACKAGE_JSON));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(data.user_profiles['strict-copy']);
    assert.equal(data.user_profiles['strict-copy'].depth, 3);
    assert.equal(data.user_profiles['strict-copy'].description, 'Strict clone');
    assert.equal(data.user_profiles['strict-copy'].review_policy.code, true);
    assert.equal(data.user_profiles['strict-copy'].review_finding_policy.policy_id, 'strict');
    assert.equal(data.user_profiles['strict-copy'].review_finding_policy.findings.low, 'fix_now');
});

test('profile create with --copy-from preserves legacy missing review finding policy', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.user_profiles.legacy = {
        description: 'Legacy profile without review finding policy.',
        depth: 2,
        review_policy: { code: true, db: 'auto', security: 'auto', refactor: false },
        token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
        skills: { auto_suggest: true }
    };
    fs.writeFileSync(profilesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

    captureConsole(() => handleProfile([
        'create', 'legacy-copy',
        '--bundle-root', bundleRoot,
        '--copy-from', 'legacy',
        '--description', 'Legacy clone'
    ], PACKAGE_JSON));

    const updated = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    assert.ok(updated.user_profiles['legacy-copy']);
    assert.equal(updated.user_profiles['legacy-copy'].description, 'Legacy clone');
    assert.equal(updated.user_profiles['legacy-copy'].review_policy.code, true);
    assert.equal(Object.hasOwn(updated.user_profiles['legacy-copy'], 'review_finding_policy'), false);
    assert.equal(Object.hasOwn(updated.user_profiles['legacy-copy'], 'review_remediation_mode_policy'), false);
    const remediationPolicy = resolveReviewRemediationModePolicyFromProfile(
        updated.user_profiles['legacy-copy'].review_remediation_mode_policy,
        'legacy-copy'
    );
    assert.equal(remediationPolicy.legacy_fallback, true);
});

test('profile create rejects name conflicting with built-in', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'balanced', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /already exists/
    );
});

test('profile create rejects invalid name', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'My Profile!', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Invalid profile name/
    );
});

test('profile create rejects invalid depth', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'test-bad', '--bundle-root', bundleRoot, '--depth', '5'], PACKAGE_JSON),
        /must be 1, 2, or 3/
    );
});

test('profile create without a name starts full interactive prompts when TTY is available', async () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const cliHelpersPath = require.resolve('../../../../src/cli/commands/cli-helpers');
    const cliHelpers = require(cliHelpersPath);
    const originals = {
        supportsInteractivePrompts: cliHelpers.supportsInteractivePrompts,
        promptTextInput: cliHelpers.promptTextInput,
        promptSingleSelect: cliHelpers.promptSingleSelect
    };

    cliHelpers.supportsInteractivePrompts = () => true;
    cliHelpers.promptTextInput = async (title: string) => {
        assert.equal(
            fs.existsSync(`${profilesPath}.garda-write.lock`),
            false,
            'interactive prompts must not hold the shared profiles writer lock'
        );
        if (title === 'Enter profile name') return 'guided-profile';
        if (title === 'Enter profile description (defaults from profile \'strict\')') return 'Interactive guided profile';
        throw new Error(`Unexpected promptTextInput title: ${title}`);
    };
    cliHelpers.promptSingleSelect = async (config: { title: string }) => {
        switch (config.title) {
            case 'Choose base profile for new profile settings': return 'strict';
            case 'Select profile depth (from profile \'strict\')': return '2';
            case 'Customize review policy': return 'true';
            case 'Review policy: code (from base)': return 'true';
            case 'Review policy: db (from base)': return 'false';
            case 'Review policy: security (from base)': return 'true';
            case 'Review policy: refactor (from base)': return 'auto';
            case 'Review policy: api (from base)': return 'false';
            case 'Review policy: test (from base)': return 'true';
            case 'Review policy: performance (from base)': return 'false';
            case 'Review policy: infra (from base)': return 'false';
            case 'Review policy: dependency (from base)': return 'true';
            case 'Customize token economy': return 'true';
            case 'Token economy: enabled (from base)': return 'true';
            case 'Token economy: strip_examples (from base)': return 'false';
            case 'Token economy: strip_code_blocks (from base)': return 'false';
            case 'Token economy: scoped_diffs (from base)': return 'true';
            case 'Token economy: compact_reviewer_output (from base)': return 'false';
            case 'Customize skill behavior': return 'true';
            case 'Skills: auto_suggest': return 'false';
            default:
                throw new Error(`Unexpected promptSingleSelect title: ${config.title}`);
        }
    };

    try {
        const { lines } = await captureConsoleAsync(() => Promise.resolve(handleProfile([
            'create',
            '--bundle-root', bundleRoot
        ], PACKAGE_JSON)));
        const output = lines.join('\n');
        assert.ok(output.includes('CREATED'));
        assert.ok(output.includes("Defaults are copied from profile 'strict'. You can keep inherited values or override them."));

        const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
        const created = data.user_profiles['guided-profile'];
        assert.ok(created);
        assert.equal(created.description, 'Interactive guided profile');
        assert.equal(created.depth, 2);
        assert.equal(created.review_policy.code, true);
        assert.equal(created.review_policy.db, false);
        assert.equal(created.review_policy.refactor, 'auto');
        assert.equal(created.review_policy.test, true);
        assert.equal(created.review_policy.dependency, true);
        assert.equal(created.token_economy.strip_examples, false);
        assert.equal(created.token_economy.compact_reviewer_output, false);
        assert.equal(created.skills.auto_suggest, false);
    } finally {
        cliHelpers.supportsInteractivePrompts = originals.supportsInteractivePrompts;
        cliHelpers.promptTextInput = originals.promptTextInput;
        cliHelpers.promptSingleSelect = originals.promptSingleSelect;
    }
});

test('profile create without a name rejects when interactive prompts are unavailable', async () => {
    const bundleRoot = createTempBundleWithProfiles();
    const cliHelpersPath = require.resolve('../../../../src/cli/commands/cli-helpers');
    const cliHelpers = require(cliHelpersPath);
    const originalSupportsInteractivePrompts = cliHelpers.supportsInteractivePrompts;
    cliHelpers.supportsInteractivePrompts = () => false;
    try {
        await assert.rejects(
            async () => {
                await Promise.resolve(handleProfile(['create', '--bundle-root', bundleRoot], PACKAGE_JSON));
            },
            /TTY terminal/
        );
    } finally {
        cliHelpers.supportsInteractivePrompts = originalSupportsInteractivePrompts;
    }
});

test('interactive profile creation rejects a source snapshot changed while prompts are open', async () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const cliHelpers = require(require.resolve('../../../../src/cli/commands/cli-helpers'));
    const originals = {
        supportsInteractivePrompts: cliHelpers.supportsInteractivePrompts,
        promptTextInput: cliHelpers.promptTextInput,
        promptSingleSelect: cliHelpers.promptSingleSelect
    };
    cliHelpers.supportsInteractivePrompts = () => true;
    cliHelpers.promptTextInput = async (title: string) => {
        if (title === 'Enter profile name') return 'stale-source-copy';
        if (title.includes('Enter profile description')) {
            const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
            data.built_in_profiles.strict.description = 'Changed while prompting';
            fs.writeFileSync(profilesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
            return 'Copy from the original strict profile';
        }
        throw new Error(`Unexpected promptTextInput title: ${title}`);
    };
    cliHelpers.promptSingleSelect = async (config: { title: string }) => {
        if (config.title.startsWith('Select profile depth')) return '2';
        if (config.title.startsWith('Customize ')) return 'false';
        throw new Error(`Unexpected promptSingleSelect title: ${config.title}`);
    };
    try {
        await assert.rejects(
            () => Promise.resolve(handleProfile([
                'create', '--copy-from', 'strict', '--bundle-root', bundleRoot
            ], PACKAGE_JSON)),
            /profiles config changed.*restart profile creation/iu
        );
        const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
        assert.equal(data.user_profiles['stale-source-copy'], undefined);
    } finally {
        cliHelpers.supportsInteractivePrompts = originals.supportsInteractivePrompts;
        cliHelpers.promptTextInput = originals.promptTextInput;
        cliHelpers.promptSingleSelect = originals.promptSingleSelect;
    }
});

test('profile create rejects --json in interactive mode', async () => {
    const bundleRoot = createTempBundleWithProfiles();
    await assert.rejects(
        async () => {
            await Promise.resolve(handleProfile(['create', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
        },
        /--json is not supported with interactive profile creation/
    );
});

test('profile delete removes a user profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'temp-profile',
        '--bundle-root', bundleRoot,
        '--description', 'Temporary'
    ], PACKAGE_JSON));
    const { lines } = captureConsole(() => handleProfile(['delete', 'temp-profile', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('DELETED'));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.equal(data.user_profiles['temp-profile'], undefined);
});

test('profile delete rejects built-in profile deletion', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['delete', 'balanced', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Cannot delete built-in profile/
    );
});

test('profile delete rejects deletion of nonexistent user profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['delete', 'nonexistent', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /not found/
    );
});

test('profile delete reassigns active profile to first built-in when deleting the active profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'custom-active',
        '--bundle-root', bundleRoot,
        '--description', 'Will become active then deleted'
    ], PACKAGE_JSON));
    captureConsole(() => handleProfile(['use', 'custom-active', '--bundle-root', bundleRoot], PACKAGE_JSON));
    captureConsole(() => handleProfile(['delete', 'custom-active', '--bundle-root', bundleRoot], PACKAGE_JSON));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.equal(data.user_profiles['custom-active'], undefined);
    assert.ok(data.active_profile in data.built_in_profiles, 'Active profile should fall back to a built-in');
});

test('profile validate passes for valid profiles', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    assert.ok(result && typeof result === 'object');
    assert.equal((result as { passed: boolean }).passed, true);
});

test('profile validate passes for legacy missing review finding policy', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.user_profiles.legacy = {
        description: 'Legacy profile without review finding policy.',
        depth: 2,
        review_policy: { code: true, db: 'auto', security: 'auto', refactor: false },
        token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
        skills: { auto_suggest: true }
    };
    fs.writeFileSync(profilesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    assert.ok(result && typeof result === 'object');
    assert.equal((result as { passed: boolean }).passed, true);
});

test('profile validate rejects review ids that are absent from the catalog', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.built_in_profiles.balanced.review_policy.ghost = 'auto';
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2), 'utf8');

    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const validation = result as { passed: boolean; issues: string[] };
    assert.equal(validation.passed, false);
    assert.match(validation.issues.join('\n'), /unknown catalog review id 'ghost'/u);
});

test('profile validate accepts registered remediation lanes and rejects unregistered remediation lanes', () => {
    const bundleRoot = createTempBundleWithProfiles();
    writeCustomReviewConfig(bundleRoot, true);
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.built_in_profiles.balanced.review_remediation_mode_policy = buildDefaultReviewRemediationModePolicy();
    const policy = data.built_in_profiles.balanced.review_remediation_mode_policy;
    policy.delta_eligible_review_types.push('architecture-boundary');
    policy.delta_eligible_review_types.sort();
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2), 'utf8');

    const accepted = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    assert.equal((accepted.result as { passed: boolean }).passed, true);

    policy.delta_eligible_review_types.push('ghost');
    policy.delta_eligible_review_types.sort();
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2), 'utf8');
    const rejected = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const validation = rejected.result as { passed: boolean; issues: string[] };
    assert.equal(validation.passed, false);
    assert.match(validation.issues.join('\n'), /absent from the review catalog: ghost/iu);
});

test('profile validate rejects a required custom lane whose capability is disabled', () => {
    const bundleRoot = createTempBundleWithProfiles();
    writeCustomReviewConfig(bundleRoot, false);
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.built_in_profiles.balanced.review_policy['architecture-boundary'] = true;
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2), 'utf8');

    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const validation = result as { passed: boolean; issues: string[] };
    assert.equal(validation.passed, false);
    assert.match(validation.issues.join('\n'), /architecture-boundary.*required.*capability.*disabled/iu);
});

test('ProfileEntry critical finding action type is fixed to fix_now', () => {
    type CriticalAction = NonNullable<ProfileEntry['review_finding_policy']>['findings']['critical'];

    const allowedCriticalAction: CriticalAction = 'fix_now';
    assert.equal(allowedCriticalAction, 'fix_now');

    // @ts-expect-error critical finding disposition is schema-locked to fix_now.
    const disallowedCriticalAction: CriticalAction = 'ignore';
    assert.equal(disallowedCriticalAction, 'ignore');
});

test('profile policy preview and apply share normalized hashes and write bounded future-task audit evidence', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--preset', 'soft',
        '--bundle-root', bundleRoot,
        '--json'
    ]);

    assert.equal(preview.status, 'PREVIEW');
    assert.equal(preview.operation, 'set');
    assert.match(String(preview.policy_sha256), /^[a-f0-9]{64}$/u);
    assert.equal(
        preview.policy_sha256,
        createHash('sha256').update(JSON.stringify(preview.policy), 'utf8').digest('hex'),
        'policy_sha256 must identify only the normalized policy content'
    );
    assert.match(String(preview.plan_sha256), /^[a-f0-9]{64}$/u);
    assert.match(String(preview.before_config_sha256), /^[a-f0-9]{64}$/u);
    assert.equal((preview.policy as { policy_id: string }).policy_id, 'soft');
    assert.equal((preview.task_effect as { scope: string }).scope, 'future_tasks_only');

    const applied = captureJsonProfileCommand([
        'policy', 'apply', 'balanced',
        '--preset', 'soft',
        '--expected-policy-sha256', String(preview.policy_sha256),
        '--expected-plan-sha256', String(preview.plan_sha256),
        '--expected-config-sha256', String(preview.before_config_sha256),
        '--bundle-root', bundleRoot,
        '--json',
        ...freshOperatorConfirmationArgs()
    ]);

    assert.equal(applied.status, 'APPLIED');
    assert.equal(applied.policy_sha256, preview.policy_sha256);
    assert.equal((applied.policy as { policy_id: string }).policy_id, 'soft');
    assert.equal((applied.task_effect as { active_task_snapshots_changed: boolean }).active_task_snapshots_changed, false);
    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.equal(data.built_in_profiles.balanced.review_finding_policy.policy_id, 'soft');

    const auditPath = String(applied.audit_path);
    const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/u);
    assert.equal(auditLines.length, 2);
    const auditRecords = auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const preparedAudit = auditRecords.find((record) => record.transaction_state === 'PREPARED');
    assert.equal(preparedAudit?.status, 'PREPARED');
    assert.equal(preparedAudit?.intended_status, 'APPLIED');
    const audit = auditRecords.find((record) => record.transaction_state === 'COMMITTED');
    assert.ok(audit, 'changed apply must finish its durable audit transaction');
    assert.equal(audit.event_source, 'profile-finding-policy-mutation');
    assert.equal(audit.target_profile, 'balanced');
    assert.equal(audit.policy_sha256, preview.policy_sha256);
    assert.equal(audit.affects_active_task_snapshots, false);
    assert.equal(audit.affects_future_tasks_only, true);
    assert.equal(audit.active_task_discovery_status, 'resolved');
    assert.equal(audit.active_task_discovery_error, null);
    assert.ok(JSON.stringify(audit).length < 2048, 'audit payload must remain bounded');
});

test('profile policy preview rejects apply-only binding and confirmation flags', () => {
    const bundleRoot = createTempBundleWithProfiles();
    for (const [flag, value] of [
        ['--expected-policy-sha256', 'invalid'],
        ['--expected-plan-sha256', 'invalid'],
        ['--expected-config-sha256', 'invalid'],
        ['--operator-confirmed', 'yes'],
        ['--operator-confirmed-at-utc', 'not-a-timestamp']
    ]) {
        assert.throws(
            () => handleProfile([
                'policy', 'preview', 'balanced', '--preset', 'soft',
                flag, value, '--bundle-root', bundleRoot
            ], PACKAGE_JSON),
            /preview does not accept apply-only options/iu
        );
    }
});

test('profile policy audit discovers tasks from the workspace owning an explicit bundle root', () => {
    const stagedBundleRoot = createTempBundleWithProfiles();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-workspace-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    fs.renameSync(stagedBundleRoot, bundleRoot);
    fs.writeFileSync(path.join(workspaceRoot, 'TASK.md'), [
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-777 | 🟨 IN_PROGRESS | P1 | test | Local task | test | 2026-07-18 | balanced | local |'
    ].join('\n'), 'utf8');
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--preset', 'soft',
        '--bundle-root', bundleRoot,
        '--json'
    ]);

    const applied = captureJsonProfileCommand([
        'policy', 'apply', 'balanced',
        '--preset', 'soft',
        '--expected-policy-sha256', String(preview.policy_sha256),
        '--expected-plan-sha256', String(preview.plan_sha256),
        '--expected-config-sha256', String(preview.before_config_sha256),
        '--bundle-root', bundleRoot,
        '--json',
        ...freshOperatorConfirmationArgs()
    ]);

    const auditRecords = fs.readFileSync(String(applied.audit_path), 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as {
            transaction_state: string;
            active_task_count: number;
            active_task_ids_sha256: string;
        });
    const committed = auditRecords.find((record) => record.transaction_state === 'COMMITTED');
    assert.equal(committed?.active_task_count, 1);
    assert.equal(
        committed?.active_task_ids_sha256,
        createHash('sha256').update(JSON.stringify(['T-777']), 'utf8').digest('hex')
    );
});

test('programmatic profile policy mutation rejects a bundle owned by another workspace', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const preview = runProfileFindingPolicyCommand({
        mode: 'preview',
        targetProfile: 'balanced',
        parsedOptions: { preset: 'soft' },
        repoRoot: path.dirname(bundleRoot),
        bundleRoot
    });
    const unrelatedRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-unrelated-workspace-'));

    assert.throws(
        () => runProfileFindingPolicyCommand({
            mode: 'apply',
            targetProfile: 'balanced',
            parsedOptions: {
                preset: 'soft',
                expectedPolicySha256: preview.policy_sha256,
                expectedPlanSha256: preview.plan_sha256,
                expectedConfigSha256: preview.before_config_sha256,
                operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString()
            },
            repoRoot: unrelatedRepoRoot,
            bundleRoot
        }),
        /parent directory of --bundle-root/iu
    );
});

test('programmatic profile policy mutation rejects an external bundle through a filesystem alias', () => {
    const externalBundleRoot = createTempBundleWithProfiles();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-alias-workspace-'));
    const aliasedBundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.symlinkSync(
        externalBundleRoot,
        aliasedBundleRoot,
        process.platform === 'win32' ? 'junction' : 'dir'
    );

    assert.throws(
        () => runProfileFindingPolicyCommand({
            mode: 'preview',
            targetProfile: 'balanced',
            parsedOptions: { preset: 'soft' },
            repoRoot,
            bundleRoot: aliasedBundleRoot
        }),
        /parent directory of --bundle-root/iu
    );
});

test('programmatic profile policy mutation keeps using the validated bundle after an alias swap', () => {
    const stagedOwnedBundleRoot = createTempBundleWithProfiles();
    const externalBundleRoot = createTempBundleWithProfiles();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-alias-swap-workspace-'));
    const ownedBundleRoot = path.join(repoRoot, 'owned-bundle');
    const aliasedBundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.renameSync(stagedOwnedBundleRoot, ownedBundleRoot);
    fs.symlinkSync(ownedBundleRoot, aliasedBundleRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const externalProfilesPath = path.join(externalBundleRoot, 'live', 'config', 'profiles.json');
    const externalProfilesBefore = fs.readFileSync(externalProfilesPath, 'utf8');
    const preview = runProfileFindingPolicyCommand({
        mode: 'preview',
        targetProfile: 'balanced',
        parsedOptions: { preset: 'soft' },
        repoRoot,
        bundleRoot: ownedBundleRoot
    });
    const fsModule = require('node:fs');
    const originalRealpathSyncNative = fsModule.realpathSync.native;
    let aliasSwapped = false;
    fsModule.realpathSync.native = (targetPath: fs.PathLike) => {
        const resolved = originalRealpathSyncNative(targetPath);
        if (!aliasSwapped && path.resolve(String(targetPath)) === path.resolve(aliasedBundleRoot)) {
            aliasSwapped = true;
            fs.unlinkSync(aliasedBundleRoot);
            fs.symlinkSync(
                externalBundleRoot,
                aliasedBundleRoot,
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        }
        return resolved;
    };
    try {
        const applied = runProfileFindingPolicyCommand({
            mode: 'apply',
            targetProfile: 'balanced',
            parsedOptions: {
                preset: 'soft',
                expectedPolicySha256: preview.policy_sha256,
                expectedPlanSha256: preview.plan_sha256,
                expectedConfigSha256: preview.before_config_sha256,
                operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString()
            },
            repoRoot,
            bundleRoot: aliasedBundleRoot
        });

        assert.equal(aliasSwapped, true);
        assert.equal(applied.status, 'APPLIED');
        assert.equal(path.resolve(applied.config_path), path.resolve(ownedBundleRoot, 'live', 'config', 'profiles.json'));
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(ownedBundleRoot, 'live', 'config', 'profiles.json'), 'utf8'))
                .built_in_profiles.balanced.review_finding_policy.policy_id,
            'soft'
        );
        assert.equal(fs.readFileSync(externalProfilesPath, 'utf8'), externalProfilesBefore);
    } finally {
        fsModule.realpathSync.native = originalRealpathSyncNative;
    }
});

test('programmatic profile policy mutation rejects canonical bundle replacement after ownership validation', () => {
    const stagedOwnedBundleRoot = createTempBundleWithProfiles();
    const externalBundleRoot = createTempBundleWithProfiles();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-bundle-replacement-workspace-'));
    const ownedBundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const relocatedOwnedBundleRoot = path.join(repoRoot, 'validated-bundle');
    fs.renameSync(stagedOwnedBundleRoot, ownedBundleRoot);
    const preview = runProfileFindingPolicyCommand({
        mode: 'preview',
        targetProfile: 'balanced',
        parsedOptions: { preset: 'soft' },
        repoRoot,
        bundleRoot: ownedBundleRoot
    });
    const externalProfilesPath = path.join(externalBundleRoot, 'live', 'config', 'profiles.json');
    const externalProfilesBefore = fs.readFileSync(externalProfilesPath, 'utf8');
    const ownedProfilesPath = path.join(ownedBundleRoot, 'live', 'config', 'profiles.json');
    const fsModule = require('node:fs');
    const originalExistsSync = fsModule.existsSync;
    let bundleReplaced = false;
    fsModule.existsSync = (targetPath: fs.PathLike) => {
        if (!bundleReplaced && path.resolve(String(targetPath)) === path.resolve(ownedProfilesPath)) {
            bundleReplaced = true;
            fs.renameSync(ownedBundleRoot, relocatedOwnedBundleRoot);
            fs.symlinkSync(
                externalBundleRoot,
                ownedBundleRoot,
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        }
        return originalExistsSync(targetPath);
    };
    try {
        assert.throws(
            () => runProfileFindingPolicyCommand({
                mode: 'apply',
                targetProfile: 'balanced',
                parsedOptions: {
                    preset: 'soft',
                    expectedPolicySha256: preview.policy_sha256,
                    expectedPlanSha256: preview.plan_sha256,
                    expectedConfigSha256: preview.before_config_sha256,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString()
                },
                repoRoot,
                bundleRoot: ownedBundleRoot
            }),
            /real directory|changed after profile policy ownership validation/iu
        );
        assert.equal(bundleReplaced, true);
        assert.equal(fs.readFileSync(externalProfilesPath, 'utf8'), externalProfilesBefore);
    } finally {
        fsModule.existsSync = originalExistsSync;
    }
});

test('profile policy apply does not overwrite an in-place config edit after audit preparation', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft', '--bundle-root', bundleRoot, '--json'
    ]);
    const filesystemModule = require(require.resolve('../../../../src/core/filesystem'));
    const originalWriteTextFileAtomically = filesystemModule.writeTextFileAtomically;
    let competingEditWritten = false;
    filesystemModule.writeTextFileAtomically = (filePath: string, ...args: unknown[]) => {
        const result = originalWriteTextFileAtomically(filePath, ...args);
        if (!competingEditWritten && path.basename(filePath).includes('.garda-commit-')) {
            competingEditWritten = true;
            const competingData = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
            competingData.built_in_profiles.balanced.description = 'concurrent in-place edit';
            fs.writeFileSync(profilesPath, `${JSON.stringify(competingData, null, 2)}\n`, 'utf8');
        }
        return result;
    };
    try {
        assert.throws(
            () => handleProfile([
                'policy', 'apply', 'balanced', '--preset', 'soft',
                '--expected-policy-sha256', String(preview.policy_sha256),
                '--expected-plan-sha256', String(preview.plan_sha256),
                '--expected-config-sha256', String(preview.before_config_sha256),
                '--bundle-root', bundleRoot,
                ...freshOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /divergent config|stale preview/iu
        );
        assert.equal(competingEditWritten, true);
        assert.equal(
            JSON.parse(fs.readFileSync(profilesPath, 'utf8')).built_in_profiles.balanced.description,
            'concurrent in-place edit'
        );
        const auditRecords = fs.readFileSync(
            path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl'),
            'utf8'
        ).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
        assert.deepEqual(auditRecords.map((record) => record.transaction_state), ['PREPARED']);
    } finally {
        filesystemModule.writeTextFileAtomically = originalWriteTextFileAtomically;
    }
});

test('profile policy apply restores an in-place config edit made at the final claim boundary', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft', '--bundle-root', bundleRoot, '--json'
    ]);
    const fsModule = require('node:fs');
    const originalRenameSync = fsModule.renameSync;
    let competingEditWritten = false;
    fsModule.renameSync = (sourcePath: fs.PathLike, targetPath: fs.PathLike) => {
        if (
            !competingEditWritten
            && path.resolve(String(sourcePath)) === path.resolve(profilesPath)
            && path.basename(String(targetPath)).includes('.garda-claimed-')
        ) {
            competingEditWritten = true;
            const competingData = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
            competingData.built_in_profiles.balanced.description = 'late concurrent in-place edit';
            fs.writeFileSync(profilesPath, `${JSON.stringify(competingData, null, 2)}\n`, 'utf8');
        }
        return originalRenameSync(sourcePath, targetPath);
    };
    try {
        assert.throws(
            () => handleProfile([
                'policy', 'apply', 'balanced', '--preset', 'soft',
                '--expected-policy-sha256', String(preview.policy_sha256),
                '--expected-plan-sha256', String(preview.plan_sha256),
                '--expected-config-sha256', String(preview.before_config_sha256),
                '--bundle-root', bundleRoot,
                ...freshOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /claimed config|stale preview/iu
        );
    } finally {
        fsModule.renameSync = originalRenameSync;
    }
    assert.equal(competingEditWritten, true);
    assert.equal(
        JSON.parse(fs.readFileSync(profilesPath, 'utf8')).built_in_profiles.balanced.description,
        'late concurrent in-place edit'
    );
    const auditRecords = fs.readFileSync(
        path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl'),
        'utf8'
    ).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.deepEqual(auditRecords.map((record) => record.transaction_state), ['PREPARED']);
});

test('profile policy apply never clobbers a config created during final publication', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft', '--bundle-root', bundleRoot, '--json'
    ]);
    const fsModule = require('node:fs');
    const originalLinkSync = fsModule.linkSync;
    let competingConfigPublished = false;
    fsModule.linkSync = (sourcePath: fs.PathLike, targetPath: fs.PathLike) => {
        if (
            !competingConfigPublished
            && path.resolve(String(targetPath)) === path.resolve(profilesPath)
            && path.basename(String(sourcePath)).includes('.garda-commit-')
        ) {
            competingConfigPublished = true;
            const competingData = JSON.parse(fs.readFileSync(String(sourcePath), 'utf8'));
            competingData.built_in_profiles.balanced.description = 'concurrent published config';
            fs.writeFileSync(profilesPath, `${JSON.stringify(competingData, null, 2)}\n`, 'utf8');
        }
        return originalLinkSync(sourcePath, targetPath);
    };
    try {
        assert.throws(
            () => handleProfile([
                'policy', 'apply', 'balanced', '--preset', 'soft',
                '--expected-policy-sha256', String(preview.policy_sha256),
                '--expected-plan-sha256', String(preview.plan_sha256),
                '--expected-config-sha256', String(preview.before_config_sha256),
                '--bundle-root', bundleRoot,
                ...freshOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /divergent config/iu
        );
    } finally {
        fsModule.linkSync = originalLinkSync;
    }
    assert.equal(competingConfigPublished, true);
    assert.equal(
        JSON.parse(fs.readFileSync(profilesPath, 'utf8')).built_in_profiles.balanced.description,
        'concurrent published config'
    );
});

test('profile readers and the next locked writer recover a config left in a commit claim', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const beforeData = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const beforeConfigSha256 = createHash('sha256')
        .update(JSON.stringify(beforeData), 'utf8')
        .digest('hex');
    const claimedPath = path.join(
        path.dirname(profilesPath),
        `.profiles.json.garda-claimed-${beforeConfigSha256}-${'0'.repeat(64)}-interrupted`
    );
    fs.renameSync(profilesPath, claimedPath);

    const validation = captureConsole(
        () => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON)
    ).result as { passed: boolean };
    assert.equal(validation.passed, true);
    const current = captureJsonProfileCommand(['current', '--bundle-root', bundleRoot, '--json']);
    assert.equal(current.active_profile, 'balanced');
    assert.equal(fs.existsSync(profilesPath), false);

    captureJsonProfileCommand(['use', 'fast', '--bundle-root', bundleRoot, '--json']);
    assert.equal(fs.existsSync(claimedPath), false);
    assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
});

test('profile claim recovery reconciles interrupted publication and restoration hard links', () => {
    const publicationBundleRoot = createTempBundleWithProfiles();
    const publicationProfilesPath = path.join(publicationBundleRoot, 'live', 'config', 'profiles.json');
    const beforeData = JSON.parse(fs.readFileSync(publicationProfilesPath, 'utf8'));
    const afterData = structuredClone(beforeData);
    afterData.active_profile = 'fast';
    const beforeConfigSha256 = createHash('sha256')
        .update(JSON.stringify(beforeData), 'utf8')
        .digest('hex');
    const afterConfigSha256 = createHash('sha256')
        .update(JSON.stringify(afterData), 'utf8')
        .digest('hex');
    const publicationClaimedPath = path.join(
        path.dirname(publicationProfilesPath),
        `.profiles.json.garda-claimed-${beforeConfigSha256}-${afterConfigSha256}-publication`
    );
    const publicationTempPath = path.join(
        path.dirname(publicationProfilesPath),
        '.profiles.json.garda-commit-interrupted'
    );
    fs.renameSync(publicationProfilesPath, publicationClaimedPath);
    fs.writeFileSync(publicationTempPath, `${JSON.stringify(afterData, null, 2)}\n`, 'utf8');
    fs.linkSync(publicationTempPath, publicationProfilesPath);

    const publishedCurrent = captureJsonProfileCommand([
        'current', '--bundle-root', publicationBundleRoot, '--json'
    ]);
    assert.equal(publishedCurrent.active_profile, 'fast');
    captureJsonProfileCommand(['use', 'balanced', '--bundle-root', publicationBundleRoot, '--json']);
    assert.equal(fs.existsSync(publicationClaimedPath), false);
    assert.equal(fs.existsSync(publicationTempPath), false);
    assert.equal(JSON.parse(fs.readFileSync(publicationProfilesPath, 'utf8')).active_profile, 'balanced');

    const restorationBundleRoot = createTempBundleWithProfiles();
    const restorationProfilesPath = path.join(restorationBundleRoot, 'live', 'config', 'profiles.json');
    const restorationData = JSON.parse(fs.readFileSync(restorationProfilesPath, 'utf8'));
    const restorationBeforeSha256 = createHash('sha256')
        .update(JSON.stringify(restorationData), 'utf8')
        .digest('hex');
    const restorationClaimedPath = path.join(
        path.dirname(restorationProfilesPath),
        `.profiles.json.garda-claimed-${restorationBeforeSha256}-${'0'.repeat(64)}-restoration`
    );
    fs.renameSync(restorationProfilesPath, restorationClaimedPath);
    fs.linkSync(restorationClaimedPath, restorationProfilesPath);

    captureJsonProfileCommand(['use', 'fast', '--bundle-root', restorationBundleRoot, '--json']);
    assert.equal(fs.existsSync(restorationClaimedPath), false);
    assert.equal(JSON.parse(fs.readFileSync(restorationProfilesPath, 'utf8')).active_profile, 'fast');
});

test('profile readers retry when the canonical config moves to an authenticated claim before open', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const beforeData = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const beforeConfigSha256 = createHash('sha256')
        .update(JSON.stringify(beforeData), 'utf8')
        .digest('hex');
    const claimedPath = path.join(
        path.dirname(profilesPath),
        `.profiles.json.garda-claimed-${beforeConfigSha256}-${'0'.repeat(64)}-reader-race`
    );
    const fsModule = require('node:fs');
    const originalOpenSync = fsModule.openSync;
    let movedBeforeOpen = false;
    fsModule.openSync = (filePath: fs.PathLike, ...args: unknown[]) => {
        if (!movedBeforeOpen && path.resolve(String(filePath)) === path.resolve(profilesPath)) {
            movedBeforeOpen = true;
            fs.renameSync(profilesPath, claimedPath);
        }
        return originalOpenSync(filePath, ...args);
    };
    try {
        const current = captureJsonProfileCommand(['current', '--bundle-root', bundleRoot, '--json']);
        assert.equal(current.active_profile, 'balanced');
    } finally {
        fsModule.openSync = originalOpenSync;
        if (!fs.existsSync(profilesPath) && fs.existsSync(claimedPath)) {
            fs.renameSync(claimedPath, profilesPath);
        }
    }
    assert.equal(movedBeforeOpen, true);
});

test('profile claim recovery preserves the original when the published config is not authenticated', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const beforeData = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const beforeConfigSha256 = createHash('sha256')
        .update(JSON.stringify(beforeData), 'utf8')
        .digest('hex');
    const claimedPath = path.join(
        path.dirname(profilesPath),
        `.profiles.json.garda-claimed-${beforeConfigSha256}-${'0'.repeat(64)}-interrupted`
    );
    fs.renameSync(profilesPath, claimedPath);
    const divergentData = structuredClone(beforeData);
    divergentData.built_in_profiles.balanced.description = 'unauthenticated publication';
    fs.writeFileSync(profilesPath, `${JSON.stringify(divergentData, null, 2)}\n`, 'utf8');

    assert.throws(
        () => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /diverges from the pending claim after hash/iu
    );
    assert.equal(fs.existsSync(claimedPath), true);
    assert.equal(
        JSON.parse(fs.readFileSync(profilesPath, 'utf8')).built_in_profiles.balanced.description,
        'unauthenticated publication'
    );
});

test('profile policy apply serializes config writers and fails before config write when audit preparation fails', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--preset', 'soft',
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    const before = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const auditPath = path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl');
    fs.mkdirSync(auditPath, { recursive: true });

    assert.throws(
        () => handleProfile([
            'policy', 'apply', 'balanced',
            '--preset', 'soft',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot,
            ...freshOperatorConfirmationArgs()
        ], PACKAGE_JSON),
        /audit recovery failed|audit.*failed/iu
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(profilesPath, 'utf8')), before);
    assert.equal(fs.existsSync(`${profilesPath}.garda-write.lock`), false);

    fs.rmSync(auditPath, { recursive: true });
    const contendedLockPath = `${profilesPath}.garda-write.lock`;
    fs.writeFileSync(contendedLockPath, JSON.stringify({
        lock_id: randomUUID(),
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    }), 'utf8');
    assert.throws(
        () => handleProfile([
            'policy', 'apply', 'balanced',
            '--preset', 'soft',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot,
            ...freshOperatorConfirmationArgs()
        ], PACKAGE_JSON),
        /profiles config lock/iu
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(profilesPath, 'utf8')), before);
    assert.equal(fs.existsSync(contendedLockPath), true);
});

test('profile policy apply rejects linked audit and lock artifacts without changing their targets', () => {
    const applyPreview = (bundleRoot: string, preview: Record<string, unknown>): void => {
        handleProfile([
            'policy', 'apply', 'balanced', '--preset', 'soft',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot,
            ...freshOperatorConfirmationArgs()
        ], PACKAGE_JSON);
    };
    const createPreview = (bundleRoot: string): Record<string, unknown> => captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft', '--bundle-root', bundleRoot, '--json'
    ]);

    const linkedAuditBundleRoot = createTempBundleWithProfiles();
    const linkedAuditPath = path.join(linkedAuditBundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl');
    const auditVictim = path.join(path.dirname(linkedAuditBundleRoot), `audit-victim-${randomUUID()}.txt`);
    fs.mkdirSync(path.dirname(linkedAuditPath), { recursive: true });
    fs.writeFileSync(auditVictim, 'audit-victim', 'utf8');
    fs.linkSync(auditVictim, linkedAuditPath);
    assert.throws(
        () => applyPreview(linkedAuditBundleRoot, createPreview(linkedAuditBundleRoot)),
        /audit recovery failed|additional hard links/iu
    );
    assert.equal(fs.readFileSync(auditVictim, 'utf8'), 'audit-victim');

    const linkedLockBundleRoot = createTempBundleWithProfiles();
    const linkedProfilesPath = path.join(linkedLockBundleRoot, 'live', 'config', 'profiles.json');
    const lockVictim = path.join(path.dirname(linkedLockBundleRoot), `lock-victim-${randomUUID()}.txt`);
    fs.writeFileSync(lockVictim, 'lock-victim', 'utf8');
    fs.linkSync(lockVictim, `${linkedProfilesPath}.garda-write.lock`);
    assert.throws(
        () => applyPreview(linkedLockBundleRoot, createPreview(linkedLockBundleRoot)),
        /profiles config lock/iu
    );
    assert.equal(fs.readFileSync(lockVictim, 'utf8'), 'lock-victim');
});

test('profile policy apply rejects a runtime directory link that leaves the bundle', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft', '--bundle-root', bundleRoot, '--json'
    ]);
    const runtimePath = path.join(bundleRoot, 'runtime');
    const externalRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-external-runtime-'));
    fs.rmSync(runtimePath, { recursive: true, force: true });
    fs.symlinkSync(externalRuntime, runtimePath, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
        () => handleProfile([
            'policy', 'apply', 'balanced', '--preset', 'soft',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot,
            ...freshOperatorConfirmationArgs()
        ], PACKAGE_JSON),
        /audit preparation failed|audit directory/iu
    );
    assert.equal(fs.existsSync(path.join(externalRuntime, 'profile-finding-policy-audit.jsonl')), false);
});

test('profile writers reject a linked config directory that leaves the bundle', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const configPath = path.join(bundleRoot, 'live', 'config');
    const externalConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-external-config-'));
    const externalProfilesPath = path.join(externalConfig, 'profiles.json');
    fs.copyFileSync(path.join(configPath, 'profiles.json'), externalProfilesPath);
    const externalLockPath = `${externalProfilesPath}.garda-write.lock`;
    const externalLockContents = JSON.stringify({ pid: 2_147_483_647, released: true });
    fs.writeFileSync(externalLockPath, externalLockContents, 'utf8');
    fs.rmSync(configPath, { recursive: true, force: true });
    fs.symlinkSync(externalConfig, configPath, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
        () => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /config directory/iu
    );
    assert.equal(JSON.parse(fs.readFileSync(externalProfilesPath, 'utf8')).active_profile, 'balanced');
    assert.equal(fs.readFileSync(externalLockPath, 'utf8'), externalLockContents);
});

test('profile policy planning rejects a linked profiles config file', (t) => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const externalProfilesPath = path.join(os.tmpdir(), `gao-external-profiles-${randomUUID()}.json`);
    const externalContents = fs.readFileSync(profilesPath, 'utf8');
    fs.writeFileSync(externalProfilesPath, externalContents, 'utf8');
    fs.unlinkSync(profilesPath);
    try {
        fs.symlinkSync(externalProfilesPath, profilesPath, 'file');
    } catch (error: unknown) {
        if (String((error as NodeJS.ErrnoException).code || '').toUpperCase() === 'EPERM') {
            t.skip('File symlink creation is unavailable in this Windows environment.');
            return;
        }
        throw error;
    }

    assert.throws(
        () => handleProfile([
            'policy', 'preview', 'balanced', '--preset', 'soft', '--bundle-root', bundleRoot
        ], PACKAGE_JSON),
        /profiles config must be a regular file/iu
    );
    assert.equal(fs.readFileSync(externalProfilesPath, 'utf8'), externalContents);
});

test('profile policy apply recovers a prepared audit after a simulated process interruption', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const initialPreview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--preset', 'soft',
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    const auditPath = path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const historicalRecords = Array.from({ length: 2500 }, (_, index) => JSON.stringify({
        schema_version: 1,
        event_source: 'profile-finding-policy-mutation',
        transaction_id: `historical-${index}`,
        transaction_state: 'COMMITTED'
    })).join('\n');
    fs.writeFileSync(auditPath, `${historicalRecords}\n${JSON.stringify({
        schema_version: 1,
        event_source: 'profile-finding-policy-mutation',
        timestamp_utc: new Date().toISOString(),
        transaction_id: 'simulated-crash',
        transaction_state: 'PREPARED',
        intended_status: 'APPLIED',
        status: 'APPLIED',
        before_config_sha256: initialPreview.before_config_sha256,
        after_config_sha256: initialPreview.after_config_sha256
    })}`, 'utf8');
    const interruptedConfig = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    interruptedConfig.built_in_profiles.balanced.review_finding_policy = initialPreview.policy;
    fs.writeFileSync(profilesPath, `${JSON.stringify(interruptedConfig, null, 2)}\n`, 'utf8');

    captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));

    const records = fs.readFileSync(auditPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const recovered = records.find((record) => (
        record.transaction_id === 'simulated-crash'
        && record.transaction_state === 'COMMITTED'
    ));
    assert.equal(recovered?.recovered, true);
    assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
});

test('profile policy audit covers no-change, aborted write, and aborted recovery terminals', () => {
    const noChangeBundleRoot = createTempBundleWithProfiles();
    const noChangePreview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'balanced',
        '--bundle-root', noChangeBundleRoot, '--json'
    ]);
    assert.equal(noChangePreview.changed, false);
    const noChange = captureJsonProfileCommand([
        'policy', 'apply', 'balanced', '--preset', 'balanced',
        '--expected-policy-sha256', String(noChangePreview.policy_sha256),
        '--expected-plan-sha256', String(noChangePreview.plan_sha256),
        '--expected-config-sha256', String(noChangePreview.before_config_sha256),
        '--bundle-root', noChangeBundleRoot, '--json',
        ...freshOperatorConfirmationArgs()
    ]);
    assert.equal(noChange.status, 'NO_CHANGE');
    const noChangeRecords = fs.readFileSync(String(noChange.audit_path), 'utf8')
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(noChangeRecords.length, 1);
    assert.equal(noChangeRecords[0].transaction_state, 'COMMITTED');
    assert.equal(noChangeRecords[0].status, 'NO_CHANGE');

    const failedWriteBundleRoot = createTempBundleWithProfiles();
    const failedWriteProfilesPath = path.join(failedWriteBundleRoot, 'live', 'config', 'profiles.json');
    const failedWritePreview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft',
        '--bundle-root', failedWriteBundleRoot, '--json'
    ]);
    const fsModule = require('node:fs');
    const originalLinkSync = fsModule.linkSync;
    fsModule.linkSync = (sourcePath: fs.PathLike, targetPath: fs.PathLike) => {
        if (
            path.resolve(String(targetPath)) === path.resolve(failedWriteProfilesPath)
            && path.basename(String(sourcePath)).includes('.garda-commit-')
        ) {
            throw new Error('simulated profiles config write failure');
        }
        return originalLinkSync(sourcePath, targetPath);
    };
    try {
        assert.throws(
            () => handleProfile([
                'policy', 'apply', 'balanced', '--preset', 'soft',
                '--expected-policy-sha256', String(failedWritePreview.policy_sha256),
                '--expected-plan-sha256', String(failedWritePreview.plan_sha256),
                '--expected-config-sha256', String(failedWritePreview.before_config_sha256),
                '--bundle-root', failedWriteBundleRoot,
                ...freshOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /simulated profiles config write failure/u
        );
    } finally {
        fsModule.linkSync = originalLinkSync;
    }
    const failedWriteAuditPath = path.join(failedWriteBundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl');
    const failedWriteRecords = fs.readFileSync(failedWriteAuditPath, 'utf8')
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.deepEqual(failedWriteRecords.map((record) => record.transaction_state), ['PREPARED', 'ABORTED']);

    const committedErrorBundleRoot = createTempBundleWithProfiles();
    const committedErrorProfilesPath = path.join(committedErrorBundleRoot, 'live', 'config', 'profiles.json');
    const committedErrorPreview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft',
        '--bundle-root', committedErrorBundleRoot, '--json'
    ]);
    const originalUnlinkSync = fsModule.unlinkSync;
    fsModule.unlinkSync = (targetPath: fs.PathLike) => {
        const result = originalUnlinkSync(targetPath);
        if (
            path.dirname(String(targetPath)) === path.dirname(committedErrorProfilesPath)
            && path.basename(String(targetPath)).includes('.garda-commit-')
        ) {
            throw new Error(`simulated post-commit finalization failure ${'x'.repeat(5_000)}`);
        }
        return result;
    };
    try {
        assert.throws(
            () => handleProfile([
                'policy', 'apply', 'balanced', '--preset', 'soft',
                '--expected-policy-sha256', String(committedErrorPreview.policy_sha256),
                '--expected-plan-sha256', String(committedErrorPreview.plan_sha256),
                '--expected-config-sha256', String(committedErrorPreview.before_config_sha256),
                '--bundle-root', committedErrorBundleRoot,
                ...freshOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /config committed.*post-commit finalization failure/iu
        );
    } finally {
        fsModule.unlinkSync = originalUnlinkSync;
    }
    assert.equal(
        JSON.parse(fs.readFileSync(committedErrorProfilesPath, 'utf8'))
            .built_in_profiles.balanced.review_finding_policy.policy_id,
        'soft'
    );
    const committedErrorLines = fs.readFileSync(
        path.join(committedErrorBundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl'),
        'utf8'
    ).trim().split(/\r?\n/u);
    assert.ok(committedErrorLines.every((line) => Buffer.byteLength(`${line}\n`, 'utf8') <= 2_048));
    const committedErrorRecords = committedErrorLines.map((line) => JSON.parse(line));
    assert.deepEqual(
        committedErrorRecords.map((record) => record.transaction_state),
        ['PREPARED', 'COMMITTED']
    );
    assert.equal(committedErrorRecords.at(-1)?.committed_after_write_error, true);
    assert.ok(String(committedErrorRecords.at(-1)?.write_error).length <= 256);

    const recoveryBundleRoot = createTempBundleWithProfiles();
    const recoveryPreview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft',
        '--bundle-root', recoveryBundleRoot, '--json'
    ]);
    const recoveryAuditPath = path.join(recoveryBundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl');
    fs.mkdirSync(path.dirname(recoveryAuditPath), { recursive: true });
    fs.writeFileSync(recoveryAuditPath, `${JSON.stringify({
        schema_version: 1,
        event_source: 'profile-finding-policy-mutation',
        transaction_id: 'simulated-abort',
        transaction_state: 'PREPARED',
        intended_status: 'APPLIED',
        status: 'APPLIED',
        before_config_sha256: recoveryPreview.before_config_sha256,
        after_config_sha256: recoveryPreview.after_config_sha256
    })}\n`, 'utf8');
    captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', recoveryBundleRoot], PACKAGE_JSON));
    const recoveryRecords = fs.readFileSync(recoveryAuditPath, 'utf8')
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const recoveredAbort = recoveryRecords.find((record) => (
        record.transaction_id === 'simulated-abort' && record.transaction_state === 'ABORTED'
    ));
    assert.equal(recoveredAbort?.recovered, true);
});

test('UI profile writer rebuilds its plan under the shared lock before persisting', async () => {
    const stagedBundleRoot = createTempBundleWithProfiles();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-ui-lock-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.renameSync(stagedBundleRoot, bundleRoot);
    const targetProfilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const profileDataModule = require(require.resolve('../../../../src/cli/commands/profile/profile-data'));
    const originalWithProfilesDataLock = profileDataModule.withProfilesDataLock;
    profileDataModule.withProfilesDataLock = (lockedProfilesPath: string, operation: () => unknown) => {
        const data = JSON.parse(fs.readFileSync(lockedProfilesPath, 'utf8'));
        data.user_profiles['ui-race'] = {
            ...data.built_in_profiles.balanced,
            description: 'competing-writer'
        };
        fs.writeFileSync(lockedProfilesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        return originalWithProfilesDataLock(lockedProfilesPath, operation);
    };
    try {
        const action = {
            operation: 'create',
            profile_name: 'ui-race',
            copy_from: 'balanced'
        };
        const previewSha256 = await previewUiProfileRequest(repoRoot, 'profile-test-token', action);
        const response = await invokeUiProfileRequest(repoRoot, 'profile-test-token', {
            ...action,
            mode: 'execute',
            confirmation: 'APPLY PROFILE CHANGE',
            preview_sha256: previewSha256
        });
        assert.equal(response.status, 409);
        const payload = await response.json();
        assert.equal(payload.status, 'state_conflict');
        assert.equal(payload.code, 'state_conflict');
        assert.match(String(payload.error), /already exists/iu);
        assert.equal(
            JSON.parse(fs.readFileSync(targetProfilesPath, 'utf8')).user_profiles['ui-race'].description,
            'competing-writer'
        );
    } finally {
        profileDataModule.withProfilesDataLock = originalWithProfilesDataLock;
    }
});

test('UI profile writer recovers a pending policy audit before changing profiles', async () => {
    const stagedBundleRoot = createTempBundleWithProfiles();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-ui-recovery-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.renameSync(stagedBundleRoot, bundleRoot);
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft',
        '--bundle-root', bundleRoot, '--json'
    ]);
    const auditPath = path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.writeFileSync(auditPath, `${JSON.stringify({
        schema_version: 1,
        event_source: 'profile-finding-policy-mutation',
        transaction_id: 'ui-recovery',
        transaction_state: 'PREPARED',
        intended_status: 'APPLIED',
        status: 'APPLIED',
        before_config_sha256: preview.before_config_sha256,
        after_config_sha256: preview.after_config_sha256
    })}\n`, 'utf8');

    const action = {
        operation: 'create',
        profile_name: 'after-recovery',
        copy_from: 'balanced'
    };
    const previewSha256 = await previewUiProfileRequest(repoRoot, 'profile-test-token', action);
    const response = await invokeUiProfileRequest(repoRoot, 'profile-test-token', {
        ...action,
        mode: 'execute',
        confirmation: 'APPLY PROFILE CHANGE',
        preview_sha256: previewSha256
    });

    assert.equal(response.status, 200);
    const recoveryRecords = fs.readFileSync(auditPath, 'utf8')
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const recoveredAbort = recoveryRecords.find((record) => (
        record.transaction_id === 'ui-recovery' && record.transaction_state === 'ABORTED'
    ));
    assert.equal(recoveredAbort?.recovered, true);
    const profiles = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(profiles.user_profiles['after-recovery']);
});

test('UI profile writer reports executed when only post-commit lock release fails', async () => {
    const stagedBundleRoot = createTempBundleWithProfiles();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-ui-release-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.renameSync(stagedBundleRoot, bundleRoot);
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const cleanupPath = `${profilesPath}.garda-write.lock.dead-owner-cleanup`;
    fs.writeFileSync(cleanupPath, JSON.stringify({
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    }), 'utf8');
    const fsModule = require('node:fs');
    const originalFtruncateSync = fsModule.ftruncateSync;
    fsModule.ftruncateSync = () => { throw new Error('injected UI post-commit release failure'); };
    try {
        const action = {
            operation: 'create',
            profile_name: 'committed-ui-profile',
            copy_from: 'balanced'
        };
        const previewSha256 = await previewUiProfileRequest(repoRoot, 'profile-test-token', action);
        const response = await invokeUiProfileRequest(repoRoot, 'profile-test-token', {
            ...action,
            mode: 'execute',
            confirmation: 'APPLY PROFILE CHANGE',
            preview_sha256: previewSha256
        });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.status, 'executed');
        assert.match(String(payload.warning), /release failure/iu);
        assert.ok(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).user_profiles['committed-ui-profile']);
    } finally {
        fsModule.ftruncateSync = originalFtruncateSync;
        fs.rmSync(`${profilesPath}.garda-write.lock`, { force: true });
        fs.rmSync(cleanupPath, { force: true });
    }
});

test('profile use, create, and delete acquire the shared lock before reading profiles', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    fs.writeFileSync(profilesPath, '{invalid-json', 'utf8');

    for (const argv of [
        ['use', 'fast', '--bundle-root', bundleRoot],
        ['create', 'locked-profile', '--bundle-root', bundleRoot],
        ['delete', 'locked-profile', '--bundle-root', bundleRoot]
    ]) {
        fs.writeFileSync(lockPath, JSON.stringify({
            lock_id: `contended-${argv[0]}`,
            pid: process.pid,
            created_at_utc: new Date().toISOString()
        }), 'utf8');
        assert.throws(
            () => handleProfile(argv, PACKAGE_JSON),
            /profiles config lock/iu,
            `${argv[0]} must acquire the shared lock before reading profiles.json`
        );
        fs.rmSync(lockPath, { force: true });
    }
});

test('profiles writer publishes owner and cleanup locks without hard-link crash windows', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const fsModule = require('node:fs');
    const originalLinkSync = fsModule.linkSync;
    let linkCalls = 0;
    fsModule.linkSync = () => {
        linkCalls += 1;
        throw new Error('profiles locking must not publish through hard links');
    };
    try {
        captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.equal(linkCalls, 0);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8')).active_profile,
            'fast'
        );
    } finally {
        fsModule.linkSync = originalLinkSync;
    }
});

test('dead-owner cleanup recovers a stale cleanup guard', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    const deadOwner = JSON.stringify({ pid: 2_147_483_647, created_at_utc: new Date(0).toISOString() });
    fs.writeFileSync(lockPath, deadOwner, 'utf8');
    fs.writeFileSync(cleanupPath, deadOwner, 'utf8');

    captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));

    assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(cleanupPath), false);
});

test('dead-owner cleanup release failure is surfaced and remains recoverable', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: 2_147_483_647,
        created_at_utc: new Date(0).toISOString()
    }), 'utf8');
    const fsModule = require('node:fs');
    const originalUnlinkSync = fsModule.unlinkSync;
    let failureInjected = false;
    fsModule.unlinkSync = (targetPath: fs.PathLike) => {
        if (
            !failureInjected
            && path.resolve(String(targetPath)).startsWith(`${path.resolve(cleanupPath)}.garda-release-`)
        ) {
            failureInjected = true;
            throw new Error('injected cleanup release failure');
        }
        return originalUnlinkSync(targetPath);
    };
    try {
        assert.throws(
            () => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /release profiles dead-owner cleanup guard.*injected cleanup release failure/iu
        );
        assert.equal(failureInjected, true);
        assert.equal(JSON.parse(fs.readFileSync(cleanupPath, 'utf8')).released, true);
        assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'balanced');

        captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
        assert.equal(fs.existsSync(lockPath), false);
        assert.equal(fs.existsSync(cleanupPath), false);
    } finally {
        fsModule.unlinkSync = originalUnlinkSync;
        fs.rmSync(lockPath, { force: true });
        fs.rmSync(cleanupPath, { force: true });
    }
});

test('dead-owner cleanup recovers crash-partial lock metadata', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    fs.writeFileSync(lockPath, '{partial', 'utf8');
    fs.writeFileSync(cleanupPath, '{partial', 'utf8');
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    fs.utimesSync(cleanupPath, new Date(0), new Date(0));

    captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));

    assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(cleanupPath), false);
});

test('dead-owner cleanup recovers aged valid JSON with malformed owner shapes', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    fs.writeFileSync(lockPath, '{}', 'utf8');
    fs.writeFileSync(cleanupPath, 'null', 'utf8');
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    fs.utimesSync(cleanupPath, new Date(0), new Date(0));

    captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));

    assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(cleanupPath), false);
});

test('dead-owner cleanup never removes a replacement live profiles lock', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, created_at_utc: new Date(0).toISOString() }), 'utf8');
    const fsModule = require('node:fs');
    const originalLstatSync = fsModule.lstatSync;
    let replacementInjected = false;
    fsModule.lstatSync = (targetPath: fs.PathLike) => {
        if (!replacementInjected && path.resolve(String(targetPath)) === path.resolve(lockPath)) {
            replacementInjected = true;
            fs.unlinkSync(lockPath);
            fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, created_at_utc: new Date().toISOString() }), 'utf8');
        }
        return originalLstatSync(targetPath);
    };
    try {
        assert.throws(
            () => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /profiles config lock/iu
        );
        assert.equal(replacementInjected, true);
        assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
    } finally {
        fsModule.lstatSync = originalLstatSync;
        fs.rmSync(lockPath, { force: true });
        fs.rmSync(`${lockPath}.dead-owner-cleanup`, { force: true });
    }
});

test('profiles lock acquisition rejects a replacement owner lock without removing it', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    const fsModule = require('node:fs');
    const originalLstatSync = fsModule.lstatSync;
    let replacementInjected = false;
    fsModule.lstatSync = (targetPath: fs.PathLike) => {
        if (!replacementInjected && path.resolve(String(targetPath)) === path.resolve(lockPath)) {
            replacementInjected = true;
            fs.unlinkSync(lockPath);
            fs.writeFileSync(lockPath, JSON.stringify({
                pid: process.pid,
                created_at_utc: new Date().toISOString(),
                replacement: true
            }), 'utf8');
        }
        return originalLstatSync(targetPath);
    };
    try {
        assert.throws(
            () => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /profiles config lock/iu
        );
        assert.equal(replacementInjected, true);
        assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).replacement, true);
        assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'balanced');
    } finally {
        fsModule.lstatSync = originalLstatSync;
        fs.rmSync(lockPath, { force: true });
        fs.rmSync(`${lockPath}.dead-owner-cleanup`, { force: true });
    }
});

test('profiles lock release remains recoverable when a live cleanup guard is contended', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    fs.writeFileSync(cleanupPath, JSON.stringify({
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    }), 'utf8');

    captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));

    assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).released, true);
    fs.unlinkSync(cleanupPath);

    captureConsole(() => handleProfile(['use', 'balanced', '--bundle-root', bundleRoot], PACKAGE_JSON));

    assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'balanced');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(cleanupPath), false);
});

test('profiles lock release reports tombstone persistence failures', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const lockPath = `${profilesPath}.garda-write.lock`;
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    fs.writeFileSync(cleanupPath, JSON.stringify({
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    }), 'utf8');
    const fsModule = require('node:fs');
    const originalFtruncateSync = fsModule.ftruncateSync;
    fsModule.ftruncateSync = () => { throw new Error('injected tombstone failure'); };
    try {
        assert.throws(
            () => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /Could not release profiles config lock.*injected tombstone failure/iu
        );
        assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
    } finally {
        fsModule.ftruncateSync = originalFtruncateSync;
        fs.rmSync(lockPath, { force: true });
        fs.rmSync(cleanupPath, { force: true });
    }
});

test('profile policy reports success when only post-commit lock release fails', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const cleanupPath = `${profilesPath}.garda-write.lock.dead-owner-cleanup`;
    fs.writeFileSync(cleanupPath, JSON.stringify({
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    }), 'utf8');
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft', '--bundle-root', bundleRoot, '--json'
    ]);
    const fsModule = require('node:fs');
    const originalFtruncateSync = fsModule.ftruncateSync;
    fsModule.ftruncateSync = () => { throw new Error('injected post-commit release failure'); };
    try {
        const applied = captureJsonProfileCommand([
            'policy', 'apply', 'balanced', '--preset', 'soft',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot, '--json',
            ...freshOperatorConfirmationArgs()
        ]);
        assert.equal(applied.status, 'APPLIED');
        assert.match((applied.diagnostics as string[]).at(-1) || '', /committed.*lock release failed/iu);
        assert.equal(
            JSON.parse(fs.readFileSync(profilesPath, 'utf8')).built_in_profiles.balanced.review_finding_policy.policy_id,
            'soft'
        );
    } finally {
        fsModule.ftruncateSync = originalFtruncateSync;
        fs.rmSync(`${profilesPath}.garda-write.lock`, { force: true });
        fs.rmSync(cleanupPath, { force: true });
    }
});

test('profile policy no-change release warning does not report a config commit', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const cleanupPath = `${profilesPath}.garda-write.lock.dead-owner-cleanup`;
    const before = fs.readFileSync(profilesPath, 'utf8');
    fs.writeFileSync(cleanupPath, JSON.stringify({
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    }), 'utf8');
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'balanced', '--bundle-root', bundleRoot, '--json'
    ]);
    assert.equal(preview.changed, false);
    const fsModule = require('node:fs');
    const originalFtruncateSync = fsModule.ftruncateSync;
    fsModule.ftruncateSync = () => { throw new Error('injected no-change release failure'); };
    try {
        const applied = captureJsonProfileCommand([
            'policy', 'apply', 'balanced', '--preset', 'balanced',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot, '--json',
            ...freshOperatorConfirmationArgs()
        ]);
        const diagnostic = (applied.diagnostics as string[]).at(-1) || '';
        assert.equal(applied.status, 'NO_CHANGE');
        assert.match(diagnostic, /no-change audit committed.*lock release failed/iu);
        assert.doesNotMatch(diagnostic, /profiles config committed/iu);
        assert.equal(fs.readFileSync(profilesPath, 'utf8'), before);
    } finally {
        fsModule.ftruncateSync = originalFtruncateSync;
        fs.rmSync(`${profilesPath}.garda-write.lock`, { force: true });
        fs.rmSync(cleanupPath, { force: true });
    }
});

test('profiles lock release never removes a replacement cleanup guard', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const cleanupPath = `${profilesPath}.garda-write.lock.dead-owner-cleanup`;
    const fsModule = require('node:fs');
    const originalLstatSync = fsModule.lstatSync;
    let cleanupLstatCalls = 0;
    fsModule.lstatSync = (targetPath: fs.PathLike) => {
        if (path.resolve(String(targetPath)) === path.resolve(cleanupPath)) {
            cleanupLstatCalls += 1;
            if (cleanupLstatCalls === 2) {
                fs.unlinkSync(cleanupPath);
                fs.writeFileSync(cleanupPath, JSON.stringify({ replacement: true }), 'utf8');
            }
        }
        return originalLstatSync(targetPath);
    };
    try {
        assert.throws(
            () => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /cleanup lock path changed|release profiles config lock/iu
        );
        assert.equal(JSON.parse(fs.readFileSync(cleanupPath, 'utf8')).replacement, true);
        assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).active_profile, 'fast');
    } finally {
        fsModule.lstatSync = originalLstatSync;
        fs.rmSync(`${profilesPath}.garda-write.lock`, { force: true });
        fs.rmSync(cleanupPath, { force: true });
    }
});

test('profile policy rejects safety weakening and stale preview hashes before write', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const before = fs.readFileSync(profilesPath, 'utf8');

    assert.throws(
        () => handleProfile([
            'policy', 'preview', 'balanced',
            '--preset', 'custom',
            '--critical', 'ignore',
            '--high', 'fix_now',
            '--medium', 'fix_now',
            '--low', 'create_follow_up',
            '--residual-risk', 'create_follow_up',
            '--bundle-root', bundleRoot,
            '--json'
        ], PACKAGE_JSON),
        /critical.*immutable|critical.*fix_now/iu
    );
    assert.equal(fs.readFileSync(profilesPath, 'utf8'), before);

    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--preset', 'strict',
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    assert.equal(
        preview.policy_sha256,
        hashReviewFindingPolicy(preview.policy as Parameters<typeof hashReviewFindingPolicy>[0])
    );
    assert.throws(
        () => handleProfile([
            'policy', 'apply', 'fast',
            '--preset', 'strict',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot,
            ...freshOperatorConfirmationArgs()
        ], PACKAGE_JSON),
        /Policy (?:input|plan) changed/iu
    );
    assert.equal(fs.readFileSync(profilesPath, 'utf8'), before);
    assert.throws(
        () => handleProfile([
            'policy', 'apply', 'balanced',
            '--preset', 'strict',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot
        ], PACKAGE_JSON),
        /requires explicit operator confirmation/iu
    );
    assert.equal(fs.readFileSync(profilesPath, 'utf8'), before);
    const changed = JSON.parse(before);
    changed.active_profile = 'fast';
    fs.writeFileSync(profilesPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
    const staleBeforeApply = fs.readFileSync(profilesPath, 'utf8');

    assert.throws(
        () => handleProfile([
            'policy', 'apply', 'balanced',
            '--preset', 'strict',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot,
            ...freshOperatorConfirmationArgs()
        ], PACKAGE_JSON),
        /config.*changed|stale.*preview/iu
    );
    assert.equal(fs.readFileSync(profilesPath, 'utf8'), staleBeforeApply);
});

test('profile policy reserves terminal audit capacity before committing config', () => {
    const stagedBundleRoot = createTempBundleWithProfiles();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-audit-budget-'));
    const longParent = path.join(workspaceRoot, 'x'.repeat(180));
    const bundleRoot = path.join(longParent, 'garda-agent-orchestrator');
    fs.mkdirSync(longParent, { recursive: true });
    fs.renameSync(stagedBundleRoot, bundleRoot);
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const before = fs.readFileSync(profilesPath, 'utf8');
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced', '--preset', 'soft', '--bundle-root', bundleRoot, '--json'
    ]);

    assert.throws(
        () => handleProfile([
            'policy', 'apply', 'balanced',
            '--preset', 'soft',
            '--expected-policy-sha256', String(preview.policy_sha256),
            '--expected-plan-sha256', String(preview.plan_sha256),
            '--expected-config-sha256', String(preview.before_config_sha256),
            '--bundle-root', bundleRoot,
            '--json',
            ...freshOperatorConfirmationArgs()
        ], PACKAGE_JSON),
        /audit preparation failed.*exceeds 2048 bytes/iu
    );
    assert.equal(fs.readFileSync(profilesPath, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl')), false);
});

test('profile policy copy and reset produce deterministic normalized policies', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const shippedProfilesPath = path.join(bundleRoot, 'template', 'config', 'profiles.json');
    fs.mkdirSync(path.dirname(shippedProfilesPath), { recursive: true });
    fs.copyFileSync(profilesPath, shippedProfilesPath);
    captureConsole(() => handleProfile([
        'create', 'copy-target',
        '--bundle-root', bundleRoot,
        '--copy-from', 'balanced'
    ], PACKAGE_JSON));

    const copyPreview = captureJsonProfileCommand([
        'policy', 'preview', 'copy-target',
        '--copy-from', 'strict',
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    assert.equal(copyPreview.operation, 'copy');
    assert.equal((copyPreview.policy as { policy_id: string }).policy_id, 'strict');
    const copied = captureJsonProfileCommand([
        'policy', 'apply', 'copy-target',
        '--copy-from', 'strict',
        '--expected-policy-sha256', String(copyPreview.policy_sha256),
        '--expected-plan-sha256', String(copyPreview.plan_sha256),
        '--expected-config-sha256', String(copyPreview.before_config_sha256),
        '--bundle-root', bundleRoot,
        '--json',
        ...freshOperatorConfirmationArgs()
    ]);
    assert.equal(copied.policy_sha256, copyPreview.policy_sha256);

    const mutated = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    mutated.built_in_profiles.balanced.review_finding_policy = mutated.built_in_profiles.strict.review_finding_policy;
    fs.writeFileSync(profilesPath, `${JSON.stringify(mutated, null, 2)}\n`, 'utf8');
    const resetPreview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--reset',
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    assert.equal(resetPreview.operation, 'reset');
    assert.equal((resetPreview.policy as { policy_id: string }).policy_id, 'balanced');
    const repeatedResetPreview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--reset',
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    assert.equal(repeatedResetPreview.policy_sha256, resetPreview.policy_sha256);
    const reset = captureJsonProfileCommand([
        'policy', 'apply', 'balanced',
        '--reset',
        '--expected-policy-sha256', String(resetPreview.policy_sha256),
        '--expected-plan-sha256', String(resetPreview.plan_sha256),
        '--expected-config-sha256', String(resetPreview.before_config_sha256),
        '--bundle-root', bundleRoot,
        '--json',
        ...freshOperatorConfirmationArgs()
    ]);
    assert.equal(reset.policy_sha256, resetPreview.policy_sha256);
    assert.equal(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).built_in_profiles.balanced.review_finding_policy.policy_id, 'balanced');

    fs.unlinkSync(shippedProfilesPath);
    assert.throws(
        () => handleProfile([
            'policy', 'preview', 'copy-target',
            '--reset',
            '--bundle-root', bundleRoot,
            '--json'
        ], PACKAGE_JSON),
        /shipped profile.*balanced.*not found/iu
    );
});

test('non-reset profile policy operations ignore a malformed optional reset baseline', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const shippedProfilesPath = path.join(bundleRoot, 'template', 'config', 'profiles.json');
    fs.mkdirSync(path.dirname(shippedProfilesPath), { recursive: true });
    fs.writeFileSync(shippedProfilesPath, '{malformed', 'utf8');

    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--preset', 'soft',
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    assert.equal(preview.operation, 'set');
    assert.throws(
        () => handleProfile([
            'policy', 'preview', 'balanced', '--reset', '--bundle-root', bundleRoot, '--json'
        ], PACKAGE_JSON),
        /JSON|property name/iu
    );
});

test('profile policy reports and materializes legacy migration without changing active task snapshots', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.user_profiles.legacy = {
        description: 'Legacy policy profile',
        depth: 2,
        review_policy: { code: true },
        token_economy: { enabled: true },
        skills: { auto_suggest: true }
    };
    fs.writeFileSync(profilesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'legacy',
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    const migration = preview.migration as { required: boolean; reason: string };
    assert.equal(preview.operation, 'migrate');
    assert.equal(migration.required, true);
    assert.match(migration.reason, /missing review_finding_policy/iu);
    assert.equal((preview.policy as { policy_id: string }).policy_id, 'strict');

    const applied = captureJsonProfileCommand([
        'policy', 'apply', 'legacy',
        '--expected-policy-sha256', String(preview.policy_sha256),
        '--expected-plan-sha256', String(preview.plan_sha256),
        '--expected-config-sha256', String(preview.before_config_sha256),
        '--bundle-root', bundleRoot,
        '--json',
        ...freshOperatorConfirmationArgs()
    ]);
    assert.equal((applied.migration as { required: boolean }).required, false);
    const updated = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    assert.equal(updated.user_profiles.legacy.review_finding_policy.policy_id, 'strict');
});

test('profile policy copy reports legacy source migration diagnostics', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.user_profiles.legacy_source = {
        description: 'Legacy copy source',
        depth: 2,
        review_policy: { code: true },
        token_economy: { enabled: true },
        skills: { auto_suggest: true }
    };
    data.user_profiles.copy_target = {
        ...data.built_in_profiles.balanced,
        description: 'Copy target'
    };
    fs.writeFileSync(profilesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'copy_target', '--copy-from', 'legacy_source',
        '--bundle-root', bundleRoot, '--json'
    ]);
    assert.equal(preview.operation, 'copy');
    assert.equal((preview.policy as { policy_id: string }).policy_id, 'strict');
    assert.match((preview.diagnostics as string[]).join(' '), /legacy_source.*missing review_finding_policy/iu);
});

test('profile policy text output includes migration reason and diagnostics', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    data.user_profiles.legacy_text = {
        description: 'Legacy text output profile',
        depth: 2,
        review_policy: { code: true },
        token_economy: { enabled: true },
        skills: { auto_suggest: true }
    };
    fs.writeFileSync(profilesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

    const { lines } = captureConsole(() => handleProfile([
        'policy', 'preview', 'legacy_text', '--bundle-root', bundleRoot
    ], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.match(output, /MigrationReason: .*missing review_finding_policy/iu);
    assert.match(output, /Diagnostics: .*strict/iu);
});

test('profile policy accepts equivalent Windows roots with different casing', () => {
    if (process.platform !== 'win32') return;
    const bundleRoot = createTempBundleWithProfiles();
    const preview = captureJsonProfileCommand([
        'policy', 'preview', 'balanced',
        '--preset', 'soft',
        '--target-root', path.dirname(bundleRoot).toUpperCase(),
        '--bundle-root', bundleRoot,
        '--json'
    ]);
    assert.equal(preview.operation, 'set');
});

test('profile validate --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.validation, 'PASS');
    assert.equal(parsed.issue_count, 0);
});

test('profile with unknown subcommand throws', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['unknown-action', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Unknown profile action/
    );
});

test('profile list throws when profiles.json is missing', () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-'));
    assert.throws(
        () => handleProfile(['list', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Profiles config not found/
    );
});

test('buildProfileListOutput formats text correctly', () => {
    const data = {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: { description: 'Default.', depth: 2, review_policy: { code: true }, token_economy: { enabled: true }, skills: { auto_suggest: true } }
        },
        user_profiles: {
            custom: { description: 'Custom.', depth: 1, review_policy: { code: false }, token_economy: { enabled: false }, skills: { auto_suggest: false } }
        }
    } as any;
    const output = buildProfileListOutput(data, '/bundle', false);
    assert.ok(output.includes('GARDA_PROFILES'));
    assert.ok(output.includes('remediation=FULL-only'));
    assert.ok(output.includes('balanced'));
    assert.ok(output.includes('custom'));
    assert.ok(output.includes('User Profiles'));
});

test('buildProfileCurrentOutput text includes all fields', () => {
    const data = {
        version: 1,
        active_profile: 'fast',
        built_in_profiles: {
            fast: { description: 'Fast.', depth: 1, review_policy: { code: true }, token_economy: { enabled: true }, skills: { auto_suggest: false } }
        },
        user_profiles: {}
    } as any;
    const output = buildProfileCurrentOutput(data, '/bundle', false);
    assert.ok(output.includes('ActiveProfile: fast'));
    assert.ok(output.includes('Type: built-in'));
    assert.ok(output.includes('Depth: 1'));
    assert.ok(output.includes('ReviewRemediationModePolicy: configured=false, legacy_full_only=true'));
    assert.ok(output.includes('Why: Active profile settings are used by default.'));
    assert.ok(output.includes('Tip: run "profile list" to inspect all available profiles.'));
});

test('buildProfileUseOutput shows CHANGED vs NO_CHANGE', () => {
    assert.ok(buildProfileUseOutput('fast', 'balanced', false).includes('CHANGED'));
    assert.ok(buildProfileUseOutput('balanced', 'balanced', false).includes('NO_CHANGE'));
});

test('buildProfileCreateOutput shows CREATED', () => {
    const output = buildProfileCreateOutput('test-profile', '/config/profiles.json', false);
    assert.ok(output.includes('CREATED'));
    assert.ok(output.includes('test-profile'));
});

test('buildProfileDeleteOutput shows DELETED', () => {
    const output = buildProfileDeleteOutput('test-profile', '/config/profiles.json', false);
    assert.ok(output.includes('DELETED'));
    assert.ok(output.includes('test-profile'));
});

test('buildProfileValidateOutput shows PASS/FAIL', () => {
    const data = { version: 1, active_profile: 'balanced', built_in_profiles: { balanced: {} }, user_profiles: {} } as any;
    assert.ok(buildProfileValidateOutput(data, [], '/config', false).includes('PASS'));
    assert.ok(buildProfileValidateOutput(data, ['bad'], '/config', false).includes('FAIL'));
});

test('profile create accepts valid kebab-case names', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'my-profile-2',
        '--bundle-root', bundleRoot,
        '--description', 'Valid name'
    ], PACKAGE_JSON));
    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(data.user_profiles['my-profile-2']);
    assert.equal(
        data.user_profiles['my-profile-2'].review_remediation_mode_policy.policy_id,
        'conservative_review_remediation_mode_v1'
    );
    assert.deepEqual(
        data.user_profiles['my-profile-2'].review_remediation_mode_policy.delta_eligible_review_types,
        ['api', 'code', 'db', 'dependency', 'infra', 'performance', 'refactor', 'security', 'test']
    );
});

test('profile create defaults every registered catalog lane to DELTA eligibility', () => {
    const bundleRoot = createTempBundleWithProfiles();
    writeCustomReviewConfig(bundleRoot, true);
    captureConsole(() => handleProfile([
        'create', 'catalog-defaults',
        '--bundle-root', bundleRoot,
        '--description', 'Catalog defaults'
    ], PACKAGE_JSON));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(data.user_profiles['catalog-defaults'].review_remediation_mode_policy
        .delta_eligible_review_types.includes('architecture-boundary'));
});

test('profile create accepts localized lowercase profile names', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'ьестовый',
        '--bundle-root', bundleRoot,
        '--description', 'Localized profile'
    ], PACKAGE_JSON));
    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(data.user_profiles['ьестовый']);
});

test('profile create rejects names starting with digit', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', '1bad', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Invalid profile name/
    );
});

test('profile create rejects names with uppercase', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'BadName', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Invalid profile name/
    );
});

test('profile create rejects names ending with hyphen', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'bad-', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Invalid profile name/
    );
});

test('profile create rejects non-integer depth like 2abc', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'test-strict', '--bundle-root', bundleRoot, '--depth', '2abc'], PACKAGE_JSON),
        /must be 1, 2, or 3/
    );
});

test('profile create rejects empty description', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'test-empty', '--bundle-root', bundleRoot, '--description', ''], PACKAGE_JSON),
        /must not be empty/
    );
});

test('profile use rejects prototype-chain names like constructor', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['use', 'constructor', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /not found/
    );
});

test('profile delete rejects prototype-chain names like toString', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['delete', 'toString', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /not found/
    );
});

test('profile use --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.action, 'use');
    assert.equal(parsed.active_profile, 'fast');
    assert.equal(parsed.previous_profile, 'balanced');
    assert.equal(parsed.changed, true);
});

test('profile create --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile([
        'create', 'json-test',
        '--bundle-root', bundleRoot,
        '--description', 'For JSON',
        '--json'
    ], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.action, 'create');
    assert.equal(parsed.profile, 'json-test');
});

test('profile delete --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'del-json',
        '--bundle-root', bundleRoot,
        '--description', 'Will delete'
    ], PACKAGE_JSON));
    const { lines } = captureConsole(() => handleProfile(['delete', 'del-json', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.action, 'delete');
    assert.equal(parsed.profile, 'del-json');
});

test('profile validate reports FAIL for malformed profiles.json', () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), '{"version":1}', 'utf8');
    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    assert.ok(result && typeof result === 'object');
    assert.equal((result as { passed: boolean }).passed, false);
});

test('profile validate reports FAIL when profiles.json is missing', () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-'));
    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    assert.ok(result && typeof result === 'object');
    assert.equal((result as { passed: boolean }).passed, false);
});
