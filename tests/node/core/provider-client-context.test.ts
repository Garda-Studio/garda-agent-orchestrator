import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    getProviderEntries,
    normalizeProviderId,
    ProviderClientContextInputError,
    resolveProviderClientContext
} from '../../../src/core/provider-registry';

describe('provider client context: identity and evidence boundaries', () => {
    it('keeps the actual client, model and instruction selection independent', () => {
        const context = resolveProviderClientContext({
            clientIdentity: ' Codex ', surface: 'cloud', reportedVersion: ' 0.159.0-alpha.3 ',
            modelProvider: 'DeepSeek', modelId: 'deepseek-reasoner',
            sourceOfTruth: 'Claude', activeAgentFiles: 'CLAUDE.md'
        });
        assert.equal(context.requestedProviderId, 'Codex');
        assert.equal(context.clientId, 'Codex');
        assert.equal(context.surface, 'cloud');
        assert.equal(context.reportedVersion, '0.159.0-alpha.3');
        assert.deepEqual(context.model, { provider: 'DeepSeek', id: 'deepseek-reasoner' });
        assert.deepEqual(context.instructions, { sourceOfTruth: 'Claude', activeAgentFiles: 'CLAUDE.md' });
        assert.deepEqual(context.evidence, { nativeLoading: 'unknown', reviewerLaunch: 'unknown' });
        assert.equal(context.status, 'unverified');
        assert.deepEqual(context.refusals, []);
    });

    it('does not infer a client from model, source, instruction files or environment-like fields', () => {
        const context = resolveProviderClientContext({
            modelProvider: 'Codex', modelId: 'gpt-6.1-sol', sourceOfTruth: 'Codex',
            activeAgentFiles: 'AGENTS.md', CODEX_THREAD_ID: 'declared-only',
            reviewerCapabilityTier: 'delegation_required'
        });
        assert.equal(context.clientId, null);
        assert.equal(context.requestedProviderId, null);
        assert.equal(context.status, 'refused');
        assert.deepEqual(context.refusals, ['CLIENT_REQUIRED']);
    });

    it('does not treat historical instruction aliases as explicit client identities', () => {
        assert.equal(normalizeProviderId('AGENTS.md'), 'Codex');
        assert.equal(normalizeProviderId('deepseek-reasoner'), 'DeepSeek');
        for (const identity of ['AGENTS.md', 'agents', 'CLAUDE.md', 'GEMINI.md', 'deepseek-reasoner', 'unknown-client']) {
            const context = resolveProviderClientContext({ clientIdentity: identity });
            assert.equal(context.clientId, null, identity);
            assert.deepEqual(context.refusals, ['CLIENT_UNKNOWN'], identity);
        }
    });

    it('accepts explicit canonical, display and launch labels without asserting launch capability', () => {
        for (const identity of ['GitHubCopilot', 'GitHub Copilot', 'github copilot cli']) {
            const context = resolveProviderClientContext({ clientIdentity: identity });
            assert.equal(context.clientId, 'GitHubCopilot');
            assert.equal(context.status, 'unverified');
        }
        assert.equal(resolveProviderClientContext({ clientIdentity: 'claude code' }).clientId, 'Claude');
    });

    it('leaves every concrete registry client unverified with unknown version and surface', () => {
        for (const entry of getProviderEntries().filter((value) => !value.requiresHostClient)) {
            const context = resolveProviderClientContext({ clientIdentity: entry.id });
            assert.equal(context.clientId, entry.id);
            assert.equal(context.status, 'unverified');
            assert.equal(context.surface, 'unknown');
            assert.equal(context.reportedVersion, null);
            assert.deepEqual(context.evidence, { nativeLoading: 'unknown', reviewerLaunch: 'unknown' });
        }
    });

    it('requires a concrete host for the historical DeepSeek provider without falling back', () => {
        const context = resolveProviderClientContext({ clientIdentity: 'DeepSeek' });
        assert.equal(context.requestedProviderId, 'DeepSeek');
        assert.equal(context.clientId, null);
        assert.equal(context.status, 'refused');
        assert.deepEqual(context.refusals, ['HOST_CLIENT_REQUIRED']);
    });

    it('keeps the historical provider separate from an explicitly selected host and model', () => {
        const context = resolveProviderClientContext({
            clientIdentity: 'DeepSeek', hostClientIdentity: 'Codex', modelProvider: 'DeepSeek',
            modelId: 'deepseek-chat', sourceOfTruth: 'DeepSeek', activeAgentFiles: 'AGENTS.md'
        });
        assert.equal(context.requestedProviderId, 'DeepSeek');
        assert.equal(context.clientId, 'Codex');
        assert.deepEqual(context.model, { provider: 'DeepSeek', id: 'deepseek-chat' });
        assert.deepEqual(context.instructions, { sourceOfTruth: 'DeepSeek', activeAgentFiles: 'AGENTS.md' });
        assert.equal(context.status, 'unverified');
    });

    it('refuses unknown and non-concrete hosts instead of guessing from files or model aliases', () => {
        for (const host of ['AGENTS.md', 'unsupported-host', 'deepseek-reasoner']) {
            const context = resolveProviderClientContext({ clientIdentity: 'DeepSeek', hostClientIdentity: host });
            assert.equal(context.clientId, null);
            assert.deepEqual(context.refusals, ['HOST_CLIENT_UNKNOWN']);
        }
        assert.deepEqual(resolveProviderClientContext({
            clientIdentity: 'DeepSeek', hostClientIdentity: 'DeepSeek'
        }).refusals, ['HOST_CLIENT_NOT_CONCRETE']);
    });

    it('refuses conflicting concrete client and host declarations', () => {
        const context = resolveProviderClientContext({ clientIdentity: 'Codex', hostClientIdentity: 'Claude' });
        assert.equal(context.clientId, null);
        assert.deepEqual(context.refusals, ['HOST_CLIENT_CONFLICT']);
        assert.equal(resolveProviderClientContext({
            clientIdentity: 'Claude', hostClientIdentity: 'Claude Code'
        }).clientId, 'Claude');
    });

    it('retains client identity while refusing reported unsupported or unavailable operations', () => {
        const context = resolveProviderClientContext({
            clientIdentity: 'Codex', nativeLoading: 'unsupported', reviewerLaunch: 'unavailable'
        });
        assert.equal(context.clientId, 'Codex');
        assert.equal(context.status, 'refused');
        assert.deepEqual(context.refusals, ['NATIVE_LOADING_UNSUPPORTED', 'REVIEWER_LAUNCH_UNAVAILABLE']);
        assert.deepEqual(context.evidence, { nativeLoading: 'unsupported', reviewerLaunch: 'unavailable' });
    });

    it('handles each negative evidence state with a deterministic refusal code', () => {
        for (const [field, prefix] of [['nativeLoading', 'NATIVE_LOADING'], ['reviewerLaunch', 'REVIEWER_LAUNCH']]) {
            for (const state of ['unsupported', 'unavailable']) {
                const context = resolveProviderClientContext({ clientIdentity: 'Cursor', [field]: state });
                assert.deepEqual(context.refusals, [`${prefix}_${state.toUpperCase()}`]);
                assert.equal(context.status, 'refused');
            }
        }
    });

    it('rejects positive capability labels as metadata rather than accepting fabricated proof', () => {
        for (const field of ['nativeLoading', 'reviewerLaunch']) {
            for (const value of ['PASS', 'PASSED', 'available', 'supported', 'ready', true, {}]) {
                assert.throws(() => resolveProviderClientContext({ clientIdentity: 'Codex', [field]: value }),
                    (error: unknown) => error instanceof ProviderClientContextInputError && error.field === field);
            }
        }
    });

    it('normalizes explicit metadata choices without upgrading unknown evidence', () => {
        const context = resolveProviderClientContext({
            clientIdentity: 'Codex', surface: ' CLI ', nativeLoading: ' UNKNOWN ', reviewerLaunch: null,
            reportedVersion: ' ', sourceOfTruth: ' Codex ', activeAgentFiles: ' AGENTS.md,CLAUDE.md '
        });
        assert.equal(context.surface, 'cli');
        assert.equal(context.reportedVersion, null);
        assert.equal(context.status, 'unverified');
        assert.equal(context.instructions.activeAgentFiles, 'AGENTS.md,CLAUDE.md');
    });

    it('validates input shapes, tokens and surface at the public boundary', () => {
        for (const input of [undefined, null, [], 'Codex', 1, new Date()]) {
            assert.throws(() => resolveProviderClientContext(input), ProviderClientContextInputError);
        }
        for (const [field, value] of [
            ['surface', 'browser'], ['clientIdentity', 1], ['modelId', 'bad\u0000token'],
            ['activeAgentFiles', false], ['reportedVersion', 'x'.repeat(1025)]
        ]) {
            assert.throws(() => resolveProviderClientContext({ [field as string]: value }),
                (error: unknown) => error instanceof ProviderClientContextInputError && error.field === field);
        }
    });

    it('returns an immutable value snapshot without retaining the mutable request', () => {
        const request = { clientIdentity: 'Codex', modelId: 'first', sourceOfTruth: 'Cursor' };
        const context = resolveProviderClientContext(request);
        request.modelId = 'second'; request.sourceOfTruth = 'Claude';
        assert.equal(context.model.id, 'first');
        assert.equal(context.instructions.sourceOfTruth, 'Cursor');
        for (const value of [context, context.model, context.instructions, context.evidence, context.refusals]) {
            assert.ok(Object.isFrozen(value));
        }
    });
});

describe('provider client context: Desktop and generic declarations', () => {
    it('uses explicit new named hosts for DeepSeek without changing model or instruction source', () => {
        const context = resolveProviderClientContext({
            clientIdentity: 'DeepSeek', hostClientIdentity: 'opencode-cli', modelProvider: 'DeepSeek',
            modelId: 'deepseek-reasoner', sourceOfTruth: 'Codex', activeAgentFiles: 'AGENTS.md'
        });
        assert.equal(context.requestedProviderId, 'DeepSeek');
        assert.equal(context.clientId, 'OpenCode');
        assert.deepEqual(context.model, { provider: 'DeepSeek', id: 'deepseek-reasoner' });
        assert.deepEqual(context.instructions, { sourceOfTruth: 'Codex', activeAgentFiles: 'AGENTS.md' });
        assert.equal(context.status, 'unverified');
        assert.deepEqual(context.refusals, []);
    });

    it('normalizes Desktop labels and IDs but retains host conflict refusals', () => {
        assert.equal(resolveProviderClientContext({
            clientIdentity: ' OpenCode CLI ', hostClientIdentity: 'OPENCODE-CLI'
        }).clientId, 'OpenCode');
        assert.deepEqual(resolveProviderClientContext({
            clientIdentity: 'grok-cli', hostClientIdentity: 'Codex'
        }).refusals, ['HOST_CLIENT_CONFLICT']);
        const context = resolveProviderClientContext({ clientIdentity: 'iflow-cli', reviewerLaunch: 'unavailable' });
        assert.equal(context.clientId, 'IFlow');
        assert.equal(context.status, 'refused');
        assert.deepEqual(context.refusals, ['REVIEWER_LAUNCH_UNAVAILABLE']);
    });

    it('requires both a generic client name and explicit rule paths without a Codex default', () => {
        const absent = resolveProviderClientContext({
            clientIdentity: 'generic-cli', sourceOfTruth: 'Codex', activeAgentFiles: 'AGENTS.md'
        });
        assert.equal(absent.requestedProviderId, 'generic-cli');
        assert.equal(absent.clientId, null);
        assert.equal(absent.status, 'refused');
        assert.deepEqual(absent.refusals, ['GENERIC_CLIENT_NAME_REQUIRED', 'GENERIC_RULE_PATHS_REQUIRED']);
        assert.deepEqual(resolveProviderClientContext({
            clientIdentity: 'generic-cli', genericClientName: 'custom', genericRulePaths: []
        }).refusals, ['GENERIC_RULE_PATHS_REQUIRED']);
        assert.deepEqual(resolveProviderClientContext({
            clientIdentity: 'generic-cli', genericRulePaths: ['rules.md']
        }).refusals, ['GENERIC_CLIENT_NAME_REQUIRED']);
    });

    it('retains a valid explicit generic declaration as unverified metadata with independent instruction choice', () => {
        const context = resolveProviderClientContext({
            clientIdentity: 'Generic CLI agent', genericClientName: ' MyTool ',
            genericRulePaths: [' rules/first.md ', 'nested/second.md', 'rules/first.md'], surface: 'cli',
            sourceOfTruth: 'Qwen', activeAgentFiles: 'QWEN.md', modelProvider: 'openai', modelId: 'model'
        });
        assert.equal(context.requestedProviderId, 'generic-cli');
        assert.equal(context.clientId, 'generic-cli');
        assert.deepEqual(context.genericClient, { name: 'MyTool', rulePaths: ['rules/first.md', 'nested/second.md'] });
        assert.deepEqual(context.instructions, { sourceOfTruth: 'Qwen', activeAgentFiles: 'QWEN.md' });
        assert.equal(context.status, 'unverified');
        assert.deepEqual(context.evidence, { nativeLoading: 'unknown', reviewerLaunch: 'unknown' });
    });

    it('does not turn a generic name or rules declaration into canonical client identity or launch proof', () => {
        const context = resolveProviderClientContext({
            clientIdentity: 'generic-cli', genericClientName: 'Codex', genericRulePaths: ['AGENTS.md'],
            nativeLoading: 'unsupported', reviewerLaunch: 'unavailable'
        });
        assert.equal(context.clientId, 'generic-cli');
        assert.equal(context.genericClient?.name, 'Codex');
        assert.deepEqual(context.refusals, ['NATIVE_LOADING_UNSUPPORTED', 'REVIEWER_LAUNCH_UNAVAILABLE']);
        assert.deepEqual(resolveProviderClientContext({
            genericClientName: 'Codex', genericRulePaths: ['AGENTS.md']
        }).refusals, ['CLIENT_REQUIRED']);
        assert.equal(resolveProviderClientContext({ clientIdentity: 'Codex', genericRulePaths: false }).clientId, 'Codex');
    });

    it('accepts a declared generic DeepSeek host only after its own explicit configuration is complete', () => {
        assert.deepEqual(resolveProviderClientContext({
            clientIdentity: 'DeepSeek', hostClientIdentity: 'generic-cli'
        }).refusals, ['GENERIC_CLIENT_NAME_REQUIRED', 'GENERIC_RULE_PATHS_REQUIRED']);
        const context = resolveProviderClientContext({
            clientIdentity: 'DeepSeek', hostClientIdentity: 'generic-cli', genericClientName: 'custom',
            genericRulePaths: ['custom.md'], modelProvider: 'DeepSeek'
        });
        assert.equal(context.requestedProviderId, 'DeepSeek');
        assert.equal(context.clientId, 'generic-cli');
        assert.deepEqual(context.genericClient, { name: 'custom', rulePaths: ['custom.md'] });
        assert.equal(context.status, 'unverified');
    });

    it('validates bounded generic names and rule-path collections with field-specific redacted errors', () => {
        for (const value of [false, 'rules.md', {}, Array.from({ length: 33 }, () => 'rules.md')]) {
            assert.throws(() => resolveProviderClientContext({
                clientIdentity: 'generic-cli', genericClientName: 'custom', genericRulePaths: value
            }), (error: unknown) => error instanceof ProviderClientContextInputError && error.field === 'genericRulePaths');
        }
        for (const value of ['', null, undefined, 3, 'bad\u0000path', 'x'.repeat(1025)]) {
            assert.throws(() => resolveProviderClientContext({
                clientIdentity: 'generic-cli', genericClientName: 'custom', genericRulePaths: [value]
            }), (error: unknown) => error instanceof ProviderClientContextInputError && error.field === 'genericRulePaths[0]');
        }
        assert.throws(() => resolveProviderClientContext({
            clientIdentity: 'generic-cli', genericClientName: 'custom', genericRulePaths: Array(1)
        }), (error: unknown) => error instanceof ProviderClientContextInputError && error.field === 'genericRulePaths[0]');
        assert.throws(() => resolveProviderClientContext({
            clientIdentity: 'generic-cli', genericClientName: 'private\u0000value', genericRulePaths: ['rules.md']
        }), (error: unknown) => error instanceof ProviderClientContextInputError
            && error.field === 'genericClientName' && !error.message.includes('private'));
    });

    it('freezes a copied generic configuration and preserves the prior non-generic response shape', () => {
        const request = { clientIdentity: 'generic-cli', genericClientName: 'custom', genericRulePaths: ['rules.md'] };
        const context = resolveProviderClientContext(request);
        request.genericClientName = 'changed'; request.genericRulePaths.push('other.md');
        assert.deepEqual(context.genericClient, { name: 'custom', rulePaths: ['rules.md'] });
        assert.ok(Object.isFrozen(context.genericClient));
        assert.ok(Object.isFrozen(context.genericClient?.rulePaths));
        assert.ok(!Object.hasOwn(resolveProviderClientContext({ clientIdentity: 'Codex' }), 'genericClient'));
        assert.ok(!Object.hasOwn(resolveProviderClientContext({ clientIdentity: 'generic-cli' }), 'genericClient'));
    });
});
