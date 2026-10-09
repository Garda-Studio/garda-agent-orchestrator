import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getProviderClientCatalog, getProviderEntries, resolveProviderClientContext } from '../../../src/core/provider-registry';

interface DesktopCatalogFixture {
    sourceCommit: string;
    sourceSha256: string;
    revision: string;
    cli: { id: string; label: string; executable: string; unsupportedReason: string | null }[];
    modelApiIds: string[];
}

const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/providers/desktop-cli-catalog-2026-09-29.json'), 'utf8')) as DesktopCatalogFixture;

describe('Desktop CLI identity declarations', () => {
    it('matches the independently projected exact Desktop catalog while keeping model APIs separate', () => {
        assert.equal(fixture.sourceCommit, '245d71f5b16b899912b5be21a1aa9309a38425ed');
        assert.equal(fixture.sourceSha256, '3ddba0a985bb58d2c8ec7f755c4b381dde49e3971b95aebe572ca5e92a7c1bac');
        assert.equal(fixture.revision, '2026-09-29.1');
        const catalog = getProviderClientCatalog();
        assert.deepEqual(catalog.map(entry => ({
            id: entry.desktopId, label: entry.displayLabel, executable: entry.declaredExecutable,
            unsupportedReason: entry.desktopManagedExecutionConstraint
        })), fixture.cli);
        assert.equal(catalog.filter(entry => entry.desktopId !== 'generic-cli').length, 16);
        assert.equal(catalog.filter(entry => entry.desktopId === 'generic-cli').length, 1);
        assert.equal(new Set(catalog.map(entry => entry.clientId)).size, 17);
        assert.equal(fixture.modelApiIds.length, 19);
        assert.ok(fixture.modelApiIds.includes('deepseek'));
        assert.ok(!catalog.some(entry => entry.desktopId === 'deepseek'));
    });

    it('resolves every named Desktop declaration without certifying native loading or launch', () => {
        for (const entry of getProviderClientCatalog().filter(value => value.desktopId !== 'generic-cli')) {
            for (const identity of [entry.desktopId, entry.clientId, entry.displayLabel]) {
                const context = resolveProviderClientContext({ clientIdentity: identity });
                assert.equal(context.clientId, entry.clientId, identity);
                assert.equal(context.requestedProviderId, entry.clientId, identity);
                assert.equal(context.status, 'unverified', identity);
                assert.equal(context.surface, 'unknown');
                assert.equal(context.reportedVersion, null);
                assert.deepEqual(context.evidence, { nativeLoading: 'unknown', reviewerLaunch: 'unknown' });
                assert.deepEqual(context.refusals, []);
            }
        }
    });

    it('preserves the nine additional identities as clients rather than model or instruction aliases', () => {
        const clients = {
            'grok-cli': 'Grok', 'opencode-cli': 'OpenCode', 'kimi-cli': 'Kimi', 'codebuddy-cli': 'CodeBuddy',
            'iflow-cli': 'IFlow', 'auggie-cli': 'Auggie', 'kiro-cli': 'Kiro', 'goose-cli': 'Goose', 'cline-cli': 'Cline'
        };
        for (const [desktopId, clientId] of Object.entries(clients)) {
            assert.equal(resolveProviderClientContext({ clientIdentity: desktopId }).clientId, clientId);
        }
        for (const identity of ['openai', 'anthropic', 'xai', 'grok-4', 'QWEN.md', 'AGENTS.md']) {
            assert.deepEqual(resolveProviderClientContext({ clientIdentity: identity }).refusals, ['CLIENT_UNKNOWN']);
        }
        assert.deepEqual(resolveProviderClientContext({
            modelProvider: 'xai', modelId: 'grok-4', sourceOfTruth: 'Codex', activeAgentFiles: 'AGENTS.md'
        }).refusals, ['CLIENT_REQUIRED']);
    });

    it('keeps Gemini, Windsurf and historical DeepSeek identities outside the Desktop named catalog', () => {
        const legacyIds = getProviderEntries().map(entry => entry.id);
        assert.equal(legacyIds.length, 10);
        for (const id of ['Gemini', 'Windsurf', 'DeepSeek']) assert.ok(legacyIds.includes(id));
        assert.equal(resolveProviderClientContext({ clientIdentity: 'Gemini' }).clientId, 'Gemini');
        assert.equal(resolveProviderClientContext({ clientIdentity: 'Windsurf' }).clientId, 'Windsurf');
        assert.equal(resolveProviderClientContext({ clientIdentity: 'antigravity-cli' }).clientId, 'Antigravity');
        assert.deepEqual(resolveProviderClientContext({ clientIdentity: 'DeepSeek' }).refusals, ['HOST_CLIENT_REQUIRED']);
        assert.ok(!getProviderClientCatalog().some(entry => ['Gemini', 'Windsurf', 'DeepSeek'].includes(entry.clientId)));
    });

    it('retains Desktop managed-execution restrictions as declarations rather than runtime permission', () => {
        const constrained = getProviderClientCatalog().filter(entry => entry.desktopManagedExecutionConstraint);
        assert.deepEqual(constrained.map(entry => entry.desktopId).sort(), ['auggie-cli', 'cursor-cli', 'junie-cli']);
        for (const entry of constrained) {
            assert.match(entry.desktopManagedExecutionConstraint!, /dedicated invocation and permission adapter/);
            assert.equal(resolveProviderClientContext({ clientIdentity: entry.desktopId }).status, 'unverified');
        }
    });

    it('returns frozen identity data without exporting model or positive capability flags', () => {
        const catalog = getProviderClientCatalog();
        assert.ok(Object.isFrozen(catalog));
        for (const entry of catalog) {
            assert.ok(Object.isFrozen(entry));
            assert.ok(!Object.hasOwn(entry, 'capabilities'));
            assert.ok(!Object.hasOwn(entry, 'modelProvider'));
            assert.ok(!Object.hasOwn(entry, 'nativeLoading'));
        }
    });
});
