/**
 * T-110: Regression tests proving that the canonical provider registry stays
 * in sync with derived helpers (constants, materialization profiles, reviewer routing).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getDirectoryScopedProviderEntrypointFiles,
    getProviderBridgeDirectoryPaths,
    getProviderEntries,
    getProviderEntryByBridgePath,
    getProviderEntryById,
    getProviderIds,
    getProviderBridgeRelativePaths,
    getProviderEntrypointMap,
    getProviderEntrypointFiles,
    getProviderEntriesByEntrypointFile,
    getProviderAliasMap,
    getProviderBridgeEntries,
    getRequiredProviderEntryByBridgePath,
    getRequiredReviewSkillBridgeHostEntry,
    normalizeProviderId,
    resolveProviderFromEnvironment,
    getReviewSkillBridgeHostEntry,
    getReviewerCapabilityTier,
    formatProviderIdList
} from '../../../src/core/provider-registry';
import {
    SOURCE_OF_TRUTH_VALUES,
    SOURCE_TO_ENTRYPOINT_MAP,
    ALL_AGENT_ENTRYPOINT_FILES
} from '../../../src/core/constants';
import {
    getCanonicalEntrypointFile,
    getLegacyManagedGitignoreEntries,
    getProviderOrchestratorProfileDefinitions
} from '../../../src/materialization/common';
import { INSTALL_BACKUP_CANDIDATE_PATHS } from '../../../src/materialization/content-builders';
import {
    resolveReviewerRoutingPolicy
} from '../../../src/gates/review/reviewer-routing';
import { getUpdateRollbackItems } from '../../../src/lifecycle/update';
import { PROVIDER_AGENT_FILES } from '../../../src/lifecycle/uninstall-helpers';

// ===========================================================================
// 1. Registry internal consistency
// ===========================================================================

describe('provider-registry: internal consistency', () => {
    it('has no duplicate provider ids', () => {
        const ids = getProviderIds();
        assert.strictEqual(ids.length, new Set(ids).size);
    });

    it('derived entrypoint file list stays deduplicated even when providers share one entrypoint', () => {
        const files = getProviderEntrypointFiles();
        assert.strictEqual(files.length, new Set(files).size);
    });

    it('shared AGENTS.md entrypoint is owned by registry providers without dedicated native files', () => {
        const entries = getProviderEntriesByEntrypointFile('AGENTS.md');
        assert.deepStrictEqual(entries.map((entry) => entry.id), ['Codex', 'Cursor', 'DeepSeek']);
    });

    it('every entry has at least one alias', () => {
        for (const entry of getProviderEntries()) {
            assert.ok(entry.aliases.length > 0, `${entry.id} has no aliases`);
        }
    });

    it('marks only the historical DeepSeek model-provider identity as requiring a concrete host', () => {
        assert.deepStrictEqual(getProviderEntries().filter((entry) => entry.requiresHostClient).map((entry) => entry.id), ['DeepSeek']);
        assert.strictEqual(normalizeProviderId('deepseek-reasoner'), 'DeepSeek');
        assert.strictEqual(getProviderEntrypointMap().DeepSeek, 'AGENTS.md');
        assert.strictEqual(getReviewerCapabilityTier('DeepSeek'), 'delegation_required');
    });

    it('delegation-required providers always expose launch metadata', () => {
        for (const entry of getProviderEntries().filter((provider) => provider.reviewerCapabilityTier === 'delegation_required')) {
            assert.ok(entry.reviewerLaunchLabel?.trim(), `${entry.id} is missing reviewerLaunchLabel`);
            assert.ok(
                entry.delegatedReviewerLaunchInstruction?.trim(),
                `${entry.id} is missing delegatedReviewerLaunchInstruction`
            );
        }
    });

    it('Codex reviewer launch guidance names the real subagent handoff contract', () => {
        const codex = getProviderEntryById('Codex');
        assert.ok(codex);
        const instruction = codex.delegatedReviewerLaunchInstruction;
        assert.ok(instruction);
        assert.match(instruction, /current Codex client's declared subagent tool and schema/);
        assert.match(instruction, /when collaboration\.spawn_agent is exposed/);
        assert.ok(instruction.includes('fork_turns="none"'));
        assert.ok(instruction.includes('fork_context=false only if exposed'));
        assert.doesNotMatch(instruction, /multi_agent_v1\.spawn_agent/);
        assert.ok(instruction.includes('never infer launch capability from the provider label'));
        assert.ok(instruction.includes('reviewer-facing CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath'));
        assert.ok(instruction.includes('not ReviewerLaunchArtifactPath control metadata'));
        assert.ok(instruction.includes('if no fresh isolated launch is available, stop'));
        assert.strictEqual(codex.id, 'Codex');
        assert.strictEqual(codex.entrypointFile, 'AGENTS.md');
        assert.strictEqual(codex.reviewerCapabilityTier, 'delegation_required');
    });

    it('registry entries are deeply frozen and immutable', () => {
        const entries = getProviderEntries();
        assert.ok(Object.isFrozen(entries), 'entries array must be frozen');
        for (const entry of entries) {
            assert.ok(Object.isFrozen(entry), `entry ${entry.id} must be frozen`);
            assert.ok(Object.isFrozen(entry.aliases), `aliases for ${entry.id} must be frozen`);
            if (entry.bridge) {
                assert.ok(Object.isFrozen(entry.bridge), `bridge for ${entry.id} must be frozen`);
                assert.ok(Object.isFrozen(entry.bridge.gitignoreEntries), `bridge.gitignoreEntries for ${entry.id} must be frozen`);
            }
        }
    });

    it('alias map values point to valid entrypoint files', () => {
        const validFiles = new Set(getProviderEntrypointFiles());
        for (const [alias, file] of Object.entries(getProviderAliasMap())) {
            assert.ok(validFiles.has(file), `Alias '${alias}' maps to unknown file '${file}'`);
        }
    });

    it('bridge entries all have non-null bridge field', () => {
        for (const entry of getProviderBridgeEntries()) {
            assert.ok(entry.bridge !== null, `${entry.id} returned from getProviderBridgeEntries but bridge is null`);
        }
    });

    it('bridge directory metadata stays self-consistent', () => {
        for (const entry of getProviderBridgeEntries()) {
            const bridge = entry.bridge!;
            assert.strictEqual(
                bridge.managedDirectoryRelativePath,
                path.posix.dirname(bridge.orchestratorRelativePath),
                `${entry.id} managedDirectoryRelativePath drifted from orchestratorRelativePath`
            );

            const directoryIgnoreEntries = bridge.gitignoreEntries.filter((gitignoreEntry) => gitignoreEntry.endsWith('/'));
            const entrypointCoveredByDirectoryIgnore = directoryIgnoreEntries.some((gitignoreEntry) => (
                entry.entrypointFile.startsWith(gitignoreEntry)
            ));
            assert.strictEqual(
                bridge.entrypointCoveredByDirectoryIgnore,
                entrypointCoveredByDirectoryIgnore,
                `${entry.id} entrypointCoveredByDirectoryIgnore drifted from gitignoreEntries`
            );

            if (bridge.profileVariant === 'compact_router') {
                assert.strictEqual(
                    bridge.selfReferenceRequirement,
                    'bridge_path',
                    `${entry.id} compact_router bridge must require bridge_path self-reference`
                );
            }
        }
    });

    it('getProviderEntryById resolves providers case-insensitively', () => {
        assert.strictEqual(getProviderEntryById('githubcopilot')?.entrypointFile, '.github/copilot-instructions.md');
        assert.strictEqual(getProviderEntryById('UnknownProvider'), null);
    });

    it('normalizeProviderId accepts explicit tool aliases without changing canonical ids', () => {
        assert.strictEqual(normalizeProviderId('github-copilot-cli'), 'GitHubCopilot');
        assert.strictEqual(normalizeProviderId('GitHub Copilot CLI'), 'GitHubCopilot');
        assert.strictEqual(normalizeProviderId('copilot-cli'), 'GitHubCopilot');
        assert.strictEqual(normalizeProviderId('GitHub Copilot Agent'), 'GitHubCopilot');
        assert.strictEqual(normalizeProviderId('github-copilot-coding-agent'), 'GitHubCopilot');
        assert.strictEqual(normalizeProviderId('OtherProvider'), null);
    });

    it('resolves runtime provider from registry-owned environment markers', () => {
        assert.strictEqual(resolveProviderFromEnvironment({ GARDA_EXECUTION_PROVIDER: 'codex' }), 'Codex');
        assert.strictEqual(
            resolveProviderFromEnvironment({ GITHUB_COPILOT_CLI: '1', CLAUDE_CODE_SSE_PORT: '1' }),
            'GitHubCopilot'
        );
        assert.strictEqual(
            resolveProviderFromEnvironment({ QWEN_CODE: '1', CODEX_HOME: '/tmp/codex' }),
            'Qwen'
        );
        assert.strictEqual(resolveProviderFromEnvironment({ CURSOR_AGENT: '1' }), 'Cursor');
        assert.strictEqual(resolveProviderFromEnvironment({}), null);
    });

    it('formats provider id lists from the registry', () => {
        assert.strictEqual(formatProviderIdList('|'), getProviderIds().join('|'));
        assert.strictEqual(formatProviderIdList(), getProviderIds().join(', '));
    });

    it('getProviderEntryByBridgePath resolves providers case-insensitively', () => {
        assert.strictEqual(getProviderEntryByBridgePath('.GITHUB/agents/orchestrator.md')?.id, 'GitHubCopilot');
        assert.strictEqual(getProviderEntryByBridgePath('missing/bridge.md'), null);
    });

    it('required bridge lookup fails fast for unknown bridge paths', () => {
        assert.strictEqual(
            getRequiredProviderEntryByBridgePath('.github/agents/orchestrator.md').id,
            'GitHubCopilot'
        );
        assert.throws(
            () => getRequiredProviderEntryByBridgePath('missing/bridge.md'),
            /does not define bridge path/i
        );
    });

    it('review-skill bridge host stays anchored in the registry', () => {
        const hostEntry = getReviewSkillBridgeHostEntry();
        assert.ok(hostEntry, 'expected a review-skill bridge host');
        assert.strictEqual(hostEntry.id, 'GitHubCopilot');
        assert.strictEqual(hostEntry.bridge?.reviewSkillBridgeHost, true);
    });

    it('required review-skill bridge host lookup enforces uniqueness at access time', () => {
        const hostEntry = getRequiredReviewSkillBridgeHostEntry();
        assert.strictEqual(hostEntry.id, 'GitHubCopilot');
        assert.strictEqual(hostEntry.bridge?.reviewSkillBridgeHost, true);
    });
});

// ===========================================================================
// 2. Derived constants stay in sync with registry
// ===========================================================================

describe('provider-registry: derived constants sync', () => {
    it('SOURCE_OF_TRUTH_VALUES matches registry provider ids', () => {
        assert.deepStrictEqual([...SOURCE_OF_TRUTH_VALUES], [...getProviderIds()]);
    });

    it('SOURCE_TO_ENTRYPOINT_MAP matches registry entrypoint map', () => {
        const registryMap = getProviderEntrypointMap();
        for (const [key, value] of Object.entries(SOURCE_TO_ENTRYPOINT_MAP)) {
            assert.strictEqual(registryMap[key], value, `Mismatch for provider '${key}'`);
        }
        for (const [key, value] of Object.entries(registryMap)) {
            assert.strictEqual((SOURCE_TO_ENTRYPOINT_MAP as Record<string, string>)[key], value, `Missing key '${key}' in SOURCE_TO_ENTRYPOINT_MAP`);
        }
    });

    it('ALL_AGENT_ENTRYPOINT_FILES matches registry entrypoint files', () => {
        assert.deepStrictEqual([...ALL_AGENT_ENTRYPOINT_FILES], [...getProviderEntrypointFiles()]);
    });
});

// ===========================================================================
// 3. Materialization profiles stay in sync
// ===========================================================================

describe('provider-registry: materialization profiles sync', () => {
    it('orchestrator profiles cover all providers with bridges', () => {
        const bridgeEntries = getProviderBridgeEntries();
        const profiles = getProviderOrchestratorProfileDefinitions();
        assert.strictEqual(profiles.length, bridgeEntries.length);

        const profilePaths = new Set(profiles.map((p) => p.orchestratorRelativePath));
        for (const entry of bridgeEntries) {
            assert.ok(
                profilePaths.has(entry.bridge!.orchestratorRelativePath),
                `Missing profile for bridge path '${entry.bridge!.orchestratorRelativePath}'`
            );
        }
    });

    it('orchestrator profiles preserve bridge metadata flags from the registry', () => {
        const antigravityProfile = getProviderOrchestratorProfileDefinitions().find(
            (profile) => profile.orchestratorRelativePath === '.antigravity/agents/orchestrator.md'
        );
        assert.ok(antigravityProfile);
        assert.strictEqual(antigravityProfile.managedDirectoryRelativePath, '.antigravity/agents');
        assert.strictEqual(antigravityProfile.entrypointCoveredByDirectoryIgnore, true);
        assert.strictEqual(antigravityProfile.profileVariant, 'compact_router');
        assert.strictEqual(antigravityProfile.selfReferenceRequirement, 'bridge_path');
        assert.strictEqual(antigravityProfile.reviewSkillBridgeHost, false);

        const skillBridgeHostProfile = getProviderOrchestratorProfileDefinitions().find(
            (profile) => profile.reviewSkillBridgeHost
        );
        assert.ok(skillBridgeHostProfile);
        assert.strictEqual(skillBridgeHostProfile.orchestratorRelativePath, '.github/agents/orchestrator.md');
        assert.strictEqual(skillBridgeHostProfile.managedDirectoryRelativePath, '.github/agents');
        assert.strictEqual(skillBridgeHostProfile.entrypointCoveredByDirectoryIgnore, false);
    });

    it('getCanonicalEntrypointFile resolves all registered providers', () => {
        for (const id of getProviderIds()) {
            const file = getCanonicalEntrypointFile(id);
            const expected = getProviderEntrypointMap()[id];
            assert.strictEqual(file, expected, `getCanonicalEntrypointFile mismatch for '${id}'`);
        }
    });

    it('directory-scoped entrypoints stay in sync with common gitignore helper', () => {
        assert.deepStrictEqual(
            [...getLegacyManagedGitignoreEntries()].sort(),
            [...getDirectoryScopedProviderEntrypointFiles()]
        );
    });

    it('install backup candidates include all registry entrypoints and provider bridges', () => {
        for (const entrypointFile of getProviderEntrypointFiles()) {
            assert.ok(
                INSTALL_BACKUP_CANDIDATE_PATHS.includes(entrypointFile),
                `Entrypoint '${entrypointFile}' missing from INSTALL_BACKUP_CANDIDATE_PATHS`
            );
        }
        for (const bridgePath of getProviderBridgeRelativePaths()) {
            assert.ok(
                INSTALL_BACKUP_CANDIDATE_PATHS.includes(bridgePath),
                `Bridge '${bridgePath}' missing from INSTALL_BACKUP_CANDIDATE_PATHS`
            );
        }
    });

    it('provider agent uninstall paths match registry bridge paths exactly', () => {
        assert.deepStrictEqual([...PROVIDER_AGENT_FILES], [...getProviderBridgeRelativePaths()]);
    });

    it('update rollback items include all registry entrypoints and provider bridge directories', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-provider-registry-'));
        const answersPath = path.join(tempDir, 'answers.json');
        fs.writeFileSync(answersPath, '{}', 'utf8');
        try {
            const rollbackItems = getUpdateRollbackItems(tempDir, answersPath);
            for (const entrypointFile of getProviderEntrypointFiles()) {
                assert.ok(
                    rollbackItems.includes(entrypointFile),
                    `Rollback items missing entrypoint '${entrypointFile}'`
                );
            }
            for (const bridgeDirectory of getProviderBridgeDirectoryPaths()) {
                assert.ok(
                    rollbackItems.includes(bridgeDirectory),
                    `Rollback items missing bridge directory '${bridgeDirectory}'`
                );
            }
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

// ===========================================================================
// 4. Reviewer routing stays in sync with capability tiers
// ===========================================================================

describe('provider-registry: reviewer routing sync', () => {
    it('resolveReviewerRoutingPolicy capability_level matches registry tier for all providers', () => {
        for (const entry of getProviderEntries()) {
            const policy = resolveReviewerRoutingPolicy(entry.id);
            const expectedTier = entry.reviewerCapabilityTier;
            assert.strictEqual(
                policy.capability_level, expectedTier,
                `Routing policy mismatch for '${entry.id}': got '${policy.capability_level}', expected '${expectedTier}'`
            );
        }
    });

    it('getReviewerCapabilityTier returns correct tier for each provider', () => {
        for (const entry of getProviderEntries()) {
            assert.strictEqual(getReviewerCapabilityTier(entry.id), entry.reviewerCapabilityTier);
        }
    });

    it('getReviewerCapabilityTier returns null for unknown provider', () => {
        assert.strictEqual(getReviewerCapabilityTier('UnknownProvider'), null);
    });

    it('delegation_required providers expose reviewer launch metadata', () => {
        for (const entry of getProviderEntries().filter((e) => e.reviewerCapabilityTier === 'delegation_required')) {
            assert.ok(entry.reviewerLaunchLabel?.trim(), `${entry.id} must define reviewerLaunchLabel`);
            assert.ok(
                entry.delegatedReviewerLaunchInstruction?.trim(),
                `${entry.id} must define delegatedReviewerLaunchInstruction`
            );
        }
    });

    it('delegation_conditional providers are no longer present in the strict delegated review contract', () => {
        const delegationConditional = getProviderEntries()
            .filter((e) => e.reviewerCapabilityTier === 'delegation_conditional')
            .map((e) => e.id)
            .sort();
        assert.deepStrictEqual(delegationConditional, []);
    });

    it('single_agent_only providers are no longer present in the strict delegated review contract', () => {
        const singleAgent = getProviderEntries()
            .filter((e) => e.reviewerCapabilityTier === 'single_agent_only')
            .map((e) => e.id)
            .sort();
        assert.deepStrictEqual(singleAgent, []);
    });
});
