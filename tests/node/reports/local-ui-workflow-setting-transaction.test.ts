import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBundleItems } from '../../../src/cli/commands/cli-bundle-helpers';
import { normalizeWorkflowFileConfig } from '../../../src/cli/commands/workflow/workflow-command-state';
import { evaluateProtectedControlPlaneManifest, writeProtectedControlPlaneManifest } from '../../../src/gates/shared/helpers';
import { startLocalUiServer } from '../../../src/reports/ui';
import { runUiActionCommand } from '../../../src/reports/ui/actions/action-common';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

interface SettingResult {
    status: string;
    current_value?: number;
    proposed_value?: number;
    exit_code?: number;
    code?: string;
    timed_out?: boolean;
}

interface WorkflowAudit {
    command: string;
    before_sha256: string;
    after_sha256: string;
    changed_fields: string[];
}

function fixture(): { root: string; bundle: string; config: string; audit: string } {
    const root = makeLocalUiTempRepo();
    const bundle = path.join(root, 'garda-agent-orchestrator');
    writeLocalUiRepoFixture(root);
    const config = path.join(bundle, 'live/config/workflow-config.json');
    // Start from canonical config so regex-set normalization is not mistaken for a lost write.
    const configured = normalizeWorkflowFileConfig(JSON.parse(fs.readFileSync(config, 'utf8')));
    fs.writeFileSync(config, JSON.stringify(configured, null, 2) + '\n');
    const originalInputs = fs.readFileSync(config);
    // Materialize executable assets only; the fixture's live inputs remain intact.
    syncBundleItems(process.cwd(), bundle);
    // Installation publishes this manifest and cache before the UI accepts settings.
    writeProtectedControlPlaneManifest(root);
    assert.deepEqual(fs.readFileSync(config), originalInputs);
    assert.equal(evaluateProtectedControlPlaneManifest(root, null, true).status, 'MATCH');
    return {
        root,
        bundle,
        config,
        audit: path.join(bundle, 'runtime/workflow-config-audit.jsonl')
    };
}

function digest(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

async function requestHeaders(url: string): Promise<Record<string, string>> {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const token = (await response.text()).match(/const actionToken = "([^"]+)";/u);
    assert.ok(token, 'actual page must supply its action token');
    return {
        origin: url.slice(0, -1),
        'content-type': 'application/json',
        'x-garda-action-token': token[1]
    };
}

async function postSetting(
    url: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>
): Promise<{ status: number; result: SettingResult }> {
    const response = await fetch(url + 'api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000)
    });
    return { status: response.status, result: await response.json() as SettingResult };
}

test('concurrent UI settings retain both native commits and an unbroken audit chain', { timeout: 30_000 }, async () => {
    const { root, config, audit } = fixture();
    const beforeBytes = fs.readFileSync(config);
    const before = JSON.parse(beforeBytes.toString('utf8'));
    let preparedRequests = 0;
    let releaseRequests: () => void = () => { throw new Error('launch barrier not initialized'); };
    const bothPrepared = new Promise<void>((resolve) => { releaseRequests = resolve; });
    const server = await startLocalUiServer({
        repoRoot: root,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action, actionRoot) => {
            assert.equal(actionRoot, root);
            assert.equal(action.command.executable, process.execPath);
            assert.deepEqual(action.command.args.slice(1, 3), ['workflow', 'set']);
            preparedRequests += 1;
            if (preparedRequests === 2) releaseRequests();
            await bothPrepared;
            // Both HTTP requests have prepared their old-value response snapshots.
            // Use the unmodified runner to launch separate real native CLI writers.
            return runUiActionCommand(action, actionRoot);
        }
    });
    try {
        const headers = await requestHeaders(server.url);
        const [green, red] = await Promise.all([
            postSetting(server.url, headers, {
                setting_id: 'full-suite-green-summary-max-lines',
                value: 7,
                mode: 'execute',
                confirmation: 'APPLY GARDA SETTING'
            }),
            postSetting(server.url, headers, {
                setting_id: 'full-suite-red-failure-chunk-lines',
                value: 13,
                mode: 'execute',
                confirmation: 'APPLY GARDA SETTING'
            })
        ]);
        assert.equal(preparedRequests, 2);
        for (const response of [green, red]) {
            assert.equal(response.status, 200, JSON.stringify(response.result));
            assert.equal(response.result.status, 'executed');
            assert.equal(response.result.exit_code, 0);
            assert.equal(response.result.timed_out, false);
        }
        assert.equal(green.result.current_value, before.full_suite_validation.green_summary_max_lines);
        assert.equal(red.result.current_value, before.full_suite_validation.red_failure_chunk_lines);
        const persistedBytes = fs.readFileSync(config);
        const persisted = JSON.parse(persistedBytes.toString('utf8'));
        const expected = structuredClone(before);
        expected.full_suite_validation.green_summary_max_lines = 7;
        expected.full_suite_validation.red_failure_chunk_lines = 13;
        assert.deepEqual(persisted, expected, 'each native write must preserve the other setting and unrelated policy');
        const records: WorkflowAudit[] = fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(records.length, 2);
        assert.ok(records.every(record => record.command === 'workflow set'));
        assert.equal(records[0].before_sha256, digest(beforeBytes));
        assert.equal(records[1].before_sha256, records[0].after_sha256);
        assert.equal(records[1].after_sha256, digest(persistedBytes));
        assert.deepEqual(records.flatMap(record => record.changed_fields).sort(), [
            'full_suite_validation.green_summary_max_lines',
            'full_suite_validation.red_failure_chunk_lines'
        ]);
        assert.equal(evaluateProtectedControlPlaneManifest(root, null, true).status, 'MATCH');
        const settings = await (await fetch(server.url + 'api/settings')).json() as {
            settings: Array<{ id: string; current_value: unknown }>;
        };
        assert.equal(settings.settings.find(setting => setting.id === 'full-suite-green-summary-max-lines')?.current_value, 7);
        assert.equal(settings.settings.find(setting => setting.id === 'full-suite-red-failure-chunk-lines')?.current_value, 13);
    } finally {
        releaseRequests();
        await cleanupLocalUiTestResources({ repoRoot: root, server });
    }
});

test('UI settings preview and rejected execution never enter the native writer', { timeout: 30_000 }, async () => {
    const { root, config, audit } = fixture();
    const before = fs.readFileSync(config);
    let runnerCalls = 0;
    const server = await startLocalUiServer({
        repoRoot: root,
        port: 0,
        actionsEnabled: true,
        actionRunner: async () => {
            runnerCalls += 1;
            throw new Error('a preview or rejected request must not launch a writer');
        }
    });
    try {
        const headers = await requestHeaders(server.url);
        const setting = { setting_id: 'full-suite-green-summary-max-lines', value: 7 };
        const preview = await postSetting(server.url, headers, { ...setting, mode: 'preview' });
        assert.equal(preview.status, 200);
        assert.equal(preview.result.status, 'previewed');
        const unconfirmed = await postSetting(server.url, headers, {
            ...setting, mode: 'execute', confirmation: 'wrong'
        });
        assert.equal(unconfirmed.status, 409);
        assert.equal(unconfirmed.result.status, 'confirmation_required');
        const untrusted = await postSetting(server.url, {
            ...headers, 'x-garda-action-token': 'wrong'
        }, { ...setting, mode: 'execute', confirmation: 'APPLY GARDA SETTING' });
        assert.equal(untrusted.status, 403);
        assert.equal(untrusted.result.code, 'action_boundary_rejected');
        const invalid = await postSetting(server.url, headers, {
            ...setting, value: 0, mode: 'execute', confirmation: 'APPLY GARDA SETTING'
        });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.result.code, 'invalid_setting_value');
        assert.equal(runnerCalls, 0);
        assert.deepEqual(fs.readFileSync(config), before);
        assert.equal(fs.existsSync(audit), false);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot: root, server });
    }
});
