import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
    DEFAULT_UI_HOST,
    startLocalUiServer
} from '../../../src/reports/ui';
import { readJsonBody } from '../../../src/reports/ui/actions/http/action-http-common';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    setLocalUiTaskResetEnabled,
    writeLocalUiTaskResetAuditRecord,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

function extractActionToken(html: string): string {
    const match = html.match(/const actionToken = "([^"]+)";/u);
    assert.ok(match, 'expected inline action token');
    return match[1];
}

const makeTempRepo = makeLocalUiTempRepo;
const writeRepo = writeLocalUiRepoFixture;
const setTaskResetEnabled = setLocalUiTaskResetEnabled;

test('local UI JSON body limit counts UTF-8 bytes instead of decoded characters', async () => {
    const maxBytes = 32 * 1024;
    const body = JSON.stringify({ display_label: '€'.repeat(Math.floor(maxBytes / 3) + 1) });
    assert.ok(body.length < maxBytes);
    assert.ok(Buffer.byteLength(body, 'utf8') > maxBytes);

    const request = new PassThrough();
    const bodyPromise = readJsonBody(request as unknown as http.IncomingMessage, maxBytes);
    request.end(body);

    await assert.rejects(bodyPromise, /Request body is too large\./u);
});

function postJsonWithHostHeader(options: {
    port: number;
    path: string;
    hostHeader: string;
    origin: string;
    actionToken: string;
    body: unknown;
}): Promise<{ statusCode: number; payload: { code?: string } }> {
    const body = JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: DEFAULT_UI_HOST,
            port: options.port,
            path: options.path,
            method: 'POST',
            headers: {
                host: options.hostHeader,
                origin: options.origin,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'x-garda-action-token': options.actionToken
            }
        }, (response) => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                raw += chunk;
            });
            response.on('end', () => {
                resolve({
                    statusCode: response.statusCode || 0,
                    payload: raw ? JSON.parse(raw) as { code?: string } : {}
                });
            });
        });
        request.on('error', reject);
        request.end(body);
    });
}

test('local UI server returns JSON errors for API method and route failures', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const methodResponse = await fetch(`${server.url}api/report`, { method: 'POST' });
        assert.equal(methodResponse.status, 405);
        assert.match(methodResponse.headers.get('content-type') || '', /^application\/json\b/u);
        assert.deepEqual(await methodResponse.json(), {
            error: 'Only GET is supported.',
            code: 'method_not_allowed'
        });

        const routeResponse = await fetch(`${server.url}api/unknown`);
        assert.equal(routeResponse.status, 404);
        assert.match(routeResponse.headers.get('content-type') || '', /^application\/json\b/u);
        assert.deepEqual(await routeResponse.json(), {
            error: 'Not found.',
            code: 'not_found'
        });
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI server exposes server-owned idle session state and activity reset', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
            repoRoot,
            port: 0,
            idleMinutes: 0.01,
            idleWarningSeconds: 30
        });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const headers = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const initialResponse = await fetch(`${server.url}api/session`);
        assert.equal(initialResponse.status, 200);
        const initial = await initialResponse.json() as {
            enabled: boolean;
            state: string;
            idle_minutes: number;
            warning_seconds: number;
            seconds_until_warning: number | null;
        };
        assert.equal(initial.enabled, true);
        assert.equal(initial.state, 'active');
        assert.equal(initial.idle_minutes, 0.01);
        assert.equal(initial.warning_seconds, 30);
        assert.ok((initial.seconds_until_warning || 0) <= 1);

        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        const warning = await (await fetch(`${server.url}api/session`)).json() as {
            state: string;
            seconds_until_shutdown: number | null;
        };
        assert.equal(warning.state, 'warning');
        assert.ok((warning.seconds_until_shutdown || 0) <= 30);

        const activityResponse = await fetch(`${server.url}api/session/activity`, {
            method: 'POST',
            headers,
            body: JSON.stringify({})
        });
        assert.equal(activityResponse.status, 200);
        const activity = await activityResponse.json() as {
            state: string;
            seconds_until_shutdown: number | null;
        };
        assert.equal(activity.state, 'active');
        assert.equal(activity.seconds_until_shutdown, null);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI session posts require the page token and localhost boundary', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const missingToken = await fetch(`${server.url}api/session/activity`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1)
            },
            body: JSON.stringify({})
        });
        assert.equal(missingToken.status, 403);
        assert.equal((await missingToken.json() as { code: string }).code, 'session_boundary_rejected');

        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const crossOrigin = await fetch(`${server.url}api/session/activity`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': 'http://example.test',
                'x-garda-action-token': actionToken
            },
            body: JSON.stringify({})
        });
        assert.equal(crossOrigin.status, 403);
        assert.equal((await crossOrigin.json() as { code: string }).code, 'session_boundary_rejected');

        const spoofedHost = await postJsonWithHostHeader({
            port: server.port,
            path: '/api/session/activity',
            hostHeader: `evil.test:${server.port}`,
            origin: `http://evil.test:${server.port}`,
            actionToken,
            body: {}
        });
        assert.equal(spoofedHost.statusCode, 403);
        assert.equal(spoofedHost.payload.code, 'session_boundary_rejected');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI manual session shutdown closes the foreground server', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const closePromise = new Promise<void>((resolve) => server.server.once('close', resolve));
        const response = await fetch(`${server.url}api/session/shutdown`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1),
                'x-garda-action-token': actionToken
            },
            body: JSON.stringify({})
        });
        assert.equal(response.status, 200);
        const payload = await response.json() as { state: string; stop_message: string };
        assert.equal(payload.state, 'stopping');
        assert.match(payload.stop_message, /Rerun `garda ui`/u);
        await closePromise;
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI idle expiry closes the server without browser heartbeat', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        idleMinutes: 0.01,
        idleWarningSeconds: 0.01
    });
    try {
        const closePromise = new Promise<void>((resolve) => {
            const httpServer = server.server;
            const settle = () => resolve();
            httpServer.once('close', settle);
            queueMicrotask(() => {
                if (!httpServer.listening) {
                    httpServer.removeListener('close', settle);
                    settle();
                }
            });
        });
        await Promise.race([
            closePromise,
            new Promise<void>((_resolve, reject) => setTimeout(
                () => reject(new Error('server did not close after idle expiry')),
                15000
            ))
        ]);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI actions are disabled unless explicitly enabled', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const listResponse = await fetch(`${server.url}api/actions`);
        assert.equal(listResponse.status, 200);
        assert.deepEqual(await listResponse.json(), {
            enabled: false,
            switch_state: 'unknown',
            actions: []
        });

        const runResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action_id: 'garda-off', mode: 'preview' })
        });
        assert.equal(runResponse.status, 403);
        assert.equal((await runResponse.json() as { code: string }).code, 'actions_disabled');

        const settingsResponse = await fetch(`${server.url}api/settings`);
        assert.equal(settingsResponse.status, 200);
        const settings = await settingsResponse.json() as { enabled: boolean; settings: Array<{ id: string }> };
        assert.equal(settings.enabled, false);
        assert.ok(settings.settings.some((setting) => setting.id === 'full-suite-green-summary-max-lines'));

        const settingRunResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'preview', value: 7 })
        });
        assert.equal(settingRunResponse.status, 403);
        assert.equal((await settingRunResponse.json() as { code: string }).code, 'settings_disabled');

        const taskRunResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action_id: 'task-stats', mode: 'preview' })
        });
        assert.equal(taskRunResponse.status, 403);
        assert.equal((await taskRunResponse.json() as { code: string }).code, 'actions_disabled');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI switch actions support preview confirmation execution and audit', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            return {
                exit_code: 0,
                signal: null,
                stdout: 'ok',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const listResponse = await fetch(`${server.url}api/actions`);
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json() as {
            enabled: boolean;
            actions: Array<{
                id: string;
                category: string;
                command: string;
                timeout_ms: number;
                mutates: boolean;
                requires_confirmation: boolean;
                confirmation_phrase: string | null;
            }>;
        };
        assert.equal(list.enabled, true);
        assert.ok(list.actions.some((action) => action.id === 'status' && action.category === 'Inspection'));
        assert.ok(list.actions.some((action) => action.id === 'doctor' && action.category === 'Inspection'));
        assert.ok(list.actions.some((action) => action.id === 'status-why-blocked' && action.category === 'Inspection'));
        assert.ok(list.actions.some((action) => action.id === 'repair-inspect' && action.category === 'Inspection'));
        const rebuildIndexesAction = list.actions.find((action) => action.id === 'repair-rebuild-indexes');
        assert.ok(rebuildIndexesAction);
        assert.equal(rebuildIndexesAction.category, 'Repair');
        assert.equal(rebuildIndexesAction.mutates, true);
        assert.equal(rebuildIndexesAction.requires_confirmation, true);
        assert.equal(rebuildIndexesAction.confirmation_phrase, 'REBUILD GARDA INDEXES');
        assert.match(rebuildIndexesAction.command, /repair rebuild-indexes --target-root "?\."? --confirm/u);
        const protectedManifestAction = list.actions.find((action) => action.id === 'repair-protected-manifest');
        assert.ok(protectedManifestAction);
        assert.equal(protectedManifestAction.category, 'Repair');
        assert.equal(protectedManifestAction.confirmation_phrase, 'REFRESH PROTECTED MANIFEST');
        assert.match(protectedManifestAction.command, /repair protected-manifest --target-root "?\."? --confirm/u);
        const locksCleanupAction = list.actions.find((action) => action.id === 'repair-locks-cleanup-stale');
        assert.ok(locksCleanupAction);
        assert.equal(locksCleanupAction.category, 'Repair');
        assert.equal(locksCleanupAction.confirmation_phrase, 'CLEAN UP STALE LOCKS');
        assert.match(locksCleanupAction.command, /repair locks --target-root "?\."? --cleanup-stale --confirm/u);
        assert.ok(list.actions.some((action) => action.id === 'garda-on' && action.category === 'Garda switch'));
        assert.ok(list.actions.some((action) => action.id === 'garda-off' && action.category === 'Garda switch'));
        assert.ok(list.actions.every((action) => !['html-report', 'cleanup-preview', 'cleanup-apply'].includes(action.id)));
        assert.ok(list.actions.every((action) => action.command.includes('bin/garda.js')));
        assert.ok(list.actions.every((action) => Number.isInteger(action.timeout_ms) && action.timeout_ms > 0));

        const previewResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'garda-off', mode: 'preview' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.match(preview.command, /off --target-root/u);
        assert.equal(preview.requires_confirmation, true);
        assert.equal(preview.confirmation_phrase, 'TURN GARDA OFF');
        assert.deepEqual(executedCommands, []);

        const repairPreviewResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'repair-rebuild-indexes', mode: 'preview' })
        });
        assert.equal(repairPreviewResponse.status, 200);
        const repairPreview = await repairPreviewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(repairPreview.status, 'previewed');
        assert.match(repairPreview.command, /repair rebuild-indexes --target-root "?\."? --confirm/u);
        assert.equal(repairPreview.requires_confirmation, true);
        assert.equal(repairPreview.confirmation_phrase, 'REBUILD GARDA INDEXES');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'garda-off', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const repairBlockedResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'repair-rebuild-indexes', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(repairBlockedResponse.status, 409);
        assert.equal((await repairBlockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const executeResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'garda-off', mode: 'execute', confirmation: 'TURN GARDA OFF' })
        });
        assert.equal(executeResponse.status, 200);
        const execute = await executeResponse.json() as { status: string; stdout: string; audit_path: string };
        assert.equal(execute.status, 'executed');
        assert.equal(execute.stdout, 'ok');
        assert.equal(executedCommands.length, 1);

        const repairExecuteResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'repair-rebuild-indexes', mode: 'execute', confirmation: 'REBUILD GARDA INDEXES' })
        });
        assert.equal(repairExecuteResponse.status, 200);
        const repairExecute = await repairExecuteResponse.json() as { status: string; command: string; stdout: string };
        assert.equal(repairExecute.status, 'executed');
        assert.equal(repairExecute.stdout, 'ok');
        assert.match(repairExecute.command, /repair rebuild-indexes --target-root "?\."? --confirm/u);
        assert.equal(executedCommands.length, 2);
        assert.match(executedCommands[1], /repair rebuild-indexes --target-root "?\."? --confirm/u);
        assert.ok(fs.existsSync(execute.audit_path));
        const auditLines = fs.readFileSync(execute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.equal(auditLines.length, 6);
        assert.match(auditLines[0], /"status":"previewed"/u);
        assert.match(auditLines[1], /"action_id":"repair-rebuild-indexes"/u);
        assert.match(auditLines[1], /"status":"previewed"/u);
        assert.match(auditLines[2], /"status":"confirmation_required"/u);
        assert.match(auditLines[3], /"action_id":"repair-rebuild-indexes"/u);
        assert.match(auditLines[3], /"status":"confirmation_required"/u);
        assert.match(auditLines[4], /"status":"executed"/u);
        assert.match(auditLines[5], /"action_id":"repair-rebuild-indexes"/u);
        assert.match(auditLines[5], /"status":"executed"/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI manual backup action supports preview confirmation execution and audit', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            return {
                exit_code: 0,
                signal: null,
                stdout: 'backup ok',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const listResponse = await fetch(`${server.url}api/actions`);
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json() as {
            enabled: boolean;
            actions: Array<{
                id: string;
                category: string;
                command: string;
                requires_confirmation: boolean;
                confirmation_phrase: string;
            }>;
        };
        const action = list.actions.find((item) => item.id === 'backup-create-manual');
        assert.ok(action, 'manual backup action must be exposed');
        assert.equal(action.category, 'Backups');
        assert.match(action.command, /backup create --target-root \. --confirm/u);
        assert.equal(action.requires_confirmation, true);
        assert.equal(action.confirmation_phrase, 'CREATE BACKUP');

        const previewResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'backup-create-manual', mode: 'preview' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.match(preview.command, /backup create --target-root \. --confirm/u);
        assert.equal(preview.requires_confirmation, true);
        assert.equal(preview.confirmation_phrase, 'CREATE BACKUP');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'backup-create-manual', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const executeResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'backup-create-manual', mode: 'execute', confirmation: 'CREATE BACKUP' })
        });
        assert.equal(executeResponse.status, 200);
        const execute = await executeResponse.json() as { status: string; stdout: string; audit_path: string };
        assert.equal(execute.status, 'executed');
        assert.equal(execute.stdout, 'backup ok');
        assert.equal(executedCommands.length, 1);
        assert.match(executedCommands[0], /backup create --target-root \. --confirm/u);
        const auditLines = fs.readFileSync(execute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.equal(auditLines.length, 3);
        assert.match(auditLines[0], /"status":"previewed"/u);
        assert.match(auditLines[1], /"status":"confirmation_required"/u);
        assert.match(auditLines[2], /"action_id":"backup-create-manual"/u);
        assert.match(auditLines[2], /"status":"executed"/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI visible action timeout result returns deterministic HTTP and audit fields', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => ({
            exit_code: 1,
            signal: null,
            stdout: '',
            stderr: 'Process timed out after action budget.',
            timed_out: true,
            timeout_ms: action.timeout_ms
        })
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const response = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1),
                'x-garda-action-token': actionToken
            },
            body: JSON.stringify({ action_id: 'garda-off', mode: 'execute', confirmation: 'TURN GARDA OFF' })
        });

        assert.equal(response.status, 504);
        const payload = await response.json() as {
            status: string;
            timed_out: boolean;
            timeout_ms: number;
            stderr: string;
            audit_path: string;
        };
        assert.equal(payload.status, 'executed');
        assert.equal(payload.timed_out, true);
        assert.equal(payload.timeout_ms, 60000);
        assert.match(payload.stderr, /timed out/u);

        const auditLines = fs.readFileSync(payload.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.match(auditLines[auditLines.length - 1], /"action_id":"garda-off"/u);
        assert.match(auditLines[auditLines.length - 1], /"timed_out":true/u);
        assert.match(auditLines[auditLines.length - 1], /"timeout_ms":60000/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI cleanup settings expose policy edits dynamic cleanup and task purge', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            return {
                exit_code: 0,
                signal: null,
                stdout: action.id === 'cleanup-preview-custom'
                    ? [
                        'BatchPurgeCandidateTasks: 12',
                        'BatchPurgeSelectedTasks: 4',
                        'BatchPurgeSelectedTaskSample: T-001, T-002, T-003, T-004',
                        'BatchPurgeSharedIndexOperations: invalidate-reviews-index, prune-all-tasks-aggregate, prune-timeline-summary',
                        'Would remove (reviews): 3',
                        'Would remove (task-events): 1',
                        'Would free: 1.00 MB'
                    ].join('\n')
                    : 'cleanup ok',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };

        const policyResponse = await fetch(`${server.url}api/cleanup-settings`);
        assert.equal(policyResponse.status, 200);
        const policy = await policyResponse.json() as {
            enabled: boolean;
            confirmation_phrase: string;
            settings: {
                daily_maintenance_enabled: boolean;
                daily_maintenance_dry_run: boolean;
                purge_require_confirm: boolean;
                eligible_older_than_days: number;
                keep_latest_tasks: number;
                include_problematic_tasks: boolean;
            };
        };
        assert.equal(policy.enabled, true);
        assert.equal(policy.confirmation_phrase, 'SAVE CLEANUP SETTINGS');
        assert.equal(policy.settings.daily_maintenance_enabled, false);
        assert.equal(policy.settings.daily_maintenance_dry_run, false);
        assert.equal(policy.settings.purge_require_confirm, false);
        assert.equal(policy.settings.eligible_older_than_days, 30);
        assert.equal(policy.settings.keep_latest_tasks, 0);
        assert.equal(policy.settings.include_problematic_tasks, false);

        const settingsPayload = {
            daily_maintenance_enabled: true,
            daily_maintenance_max_tasks_per_run: '7',
            eligible_older_than_days: '45',
            keep_latest_tasks: '3',
            daily_maintenance_dry_run: false
        };
        const settingsPreviewResponse = await fetch(`${server.url}api/cleanup-settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'preview', settings: settingsPayload })
        });
        assert.equal(settingsPreviewResponse.status, 200);
        const settingsPreview = await settingsPreviewResponse.json() as {
            status: string;
            command: string;
            proposed_settings: { daily_maintenance: { eligible_older_than_days: number; keep_latest_tasks: number } };
        };
        assert.equal(settingsPreview.status, 'previewed');
        assert.match(settingsPreview.command, /runtime-retention\.json/u);
        assert.equal(settingsPreview.proposed_settings.daily_maintenance.eligible_older_than_days, 45);
        assert.equal(settingsPreview.proposed_settings.daily_maintenance.keep_latest_tasks, 3);

        const blockedSaveResponse = await fetch(`${server.url}api/cleanup-settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', settings: settingsPayload, confirmation: 'wrong' })
        });
        assert.equal(blockedSaveResponse.status, 409);
        assert.equal((await blockedSaveResponse.json() as { status: string }).status, 'confirmation_required');

        const saveResponse = await fetch(`${server.url}api/cleanup-settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', settings: settingsPayload, confirmation: 'SAVE CLEANUP SETTINGS' })
        });
        assert.equal(saveResponse.status, 200);
        const runtimeRetentionPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'runtime-retention.json');
        const savedPolicy = JSON.parse(fs.readFileSync(runtimeRetentionPath, 'utf8')) as {
            daily_maintenance: { enabled: boolean; max_tasks_per_run: number; eligible_older_than_days: number; keep_latest_tasks: number; dry_run: boolean };
        };
        assert.deepEqual(savedPolicy.daily_maintenance, {
            enabled: true,
            max_tasks_per_run: 7,
            eligible_older_than_days: 45,
            keep_latest_tasks: 3,
            dry_run: false
        });

        for (const preview of [true, false]) {
            const toggle = await fetch(`${server.url}api/cleanup-settings`, {
                method: 'POST',
                headers: actionHeaders,
                body: JSON.stringify({ mode: 'execute', settings: { daily_maintenance_dry_run: preview }, confirmation: 'SAVE CLEANUP SETTINGS' })
            });
            assert.equal(toggle.status, 200);
            const reloaded = await (await fetch(`${server.url}api/cleanup-settings`)).json() as {
                settings: { daily_maintenance_dry_run: boolean; purge_require_confirm: boolean };
            };
            assert.equal(reloaded.settings.daily_maintenance_dry_run, preview);
            assert.equal(reloaded.settings.purge_require_confirm, false);
            assert.equal(JSON.parse(fs.readFileSync(runtimeRetentionPath, 'utf8')).daily_maintenance.dry_run, preview);
        }

        const runPreviewResponse = await fetch(`${server.url}api/cleanup-run`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                mode: 'preview',
                eligible_older_than_days: '11',
                keep_latest_tasks: '2',
                include_problematic_tasks: true
            })
        });
        assert.equal(runPreviewResponse.status, 200);
        const runPreview = await runPreviewResponse.json() as { status: string; command: string; stdout: string };
        assert.equal(runPreview.status, 'previewed');
        assert.match(runPreview.command, /cleanup batch-task-purge --target-root \. --dry-run/u);
        assert.match(runPreview.command, /--runtime-retention-older-than-days 11/u);
        assert.match(runPreview.command, /--runtime-retention-keep-latest-tasks 2/u);
        assert.match(runPreview.command, /--include-problematic-tasks/u);
        assert.match(runPreview.stdout, /BatchPurgeCandidateTasks: 12/u);
        assert.match(runPreview.stdout, /BatchPurgeSelectedTasks: 4/u);
        assert.match(runPreview.stdout, /Would remove \(reviews\): 3/u);
        assert.equal(executedCommands.length, 1);

        const runBlockedResponse = await fetch(`${server.url}api/cleanup-run`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                mode: 'execute',
                eligible_older_than_days: '11',
                keep_latest_tasks: '2',
                include_problematic_tasks: true,
                confirmation: 'wrong'
            })
        });
        assert.equal(runBlockedResponse.status, 409);
        const runBlocked = await runBlockedResponse.json() as {
            status: string;
            confirmation_phrase: string;
            command: string;
        };
        assert.equal(runBlocked.status, 'confirmation_required');
        assert.equal(runBlocked.confirmation_phrase, 'RUN GARDA CLEANUP');
        assert.match(runBlocked.command, /cleanup batch-task-purge --target-root \. --confirm/u);
        assert.equal(executedCommands.length, 1);

        const runApplyResponse = await fetch(`${server.url}api/cleanup-run`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                mode: 'execute',
                eligible_older_than_days: '11',
                keep_latest_tasks: '2',
                include_problematic_tasks: true,
                confirmation: ' RUN GARDA CLEANUP '
            })
        });
        assert.equal(runApplyResponse.status, 200);
        const runApply = await runApplyResponse.json() as { status: string; command: string; stdout: string };
        assert.equal(runApply.status, 'executed');
        assert.match(runApply.command, /cleanup batch-task-purge --target-root \. --confirm/u);
        assert.match(runApply.command, /--runtime-retention-older-than-days 11/u);
        assert.match(runApply.command, /--runtime-retention-keep-latest-tasks 2/u);
        assert.match(runApply.command, /--include-problematic-tasks/u);
        assert.equal(runApply.stdout, 'cleanup ok');
        assert.equal(executedCommands.length, 2);

        const taskPurgeBlockedResponse = await fetch(`${server.url}api/cleanup-task-purge`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', task_id: 'T-100', confirmation: 'wrong' })
        });
        assert.equal(taskPurgeBlockedResponse.status, 409);
        assert.equal((await taskPurgeBlockedResponse.json() as { status: string }).status, 'confirmation_required');

        const taskPurgeWhitespaceResponse = await fetch(`${server.url}api/cleanup-task-purge`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', task_id: 'T-100', confirmation: ' PURGE TASK RUNTIME ' })
        });
        assert.equal(taskPurgeWhitespaceResponse.status, 409);
        assert.equal((await taskPurgeWhitespaceResponse.json() as { status: string }).status, 'confirmation_required');

        const taskPurgeResponse = await fetch(`${server.url}api/cleanup-task-purge`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', task_id: 'T-100', confirmation: 'PURGE TASK RUNTIME' })
        });
        assert.equal(taskPurgeResponse.status, 200);
        const taskPurge = await taskPurgeResponse.json() as { status: string; command: string; stdout: string };
        assert.equal(taskPurge.status, 'executed');
        assert.match(taskPurge.command, /cleanup task-purge --target-root \. --task-id T-100 --confirm/u);
        assert.equal(taskPurge.stdout, 'cleanup ok');
        assert.equal(executedCommands.length, 3);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI task actions support preview confirmation execution and audit', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            return {
                exit_code: 0,
                signal: null,
                stdout: 'task ok',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };

        const previewResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-next-step', mode: 'preview' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            task_id: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.equal(preview.task_id, 'T-100');
        assert.match(preview.command, /next-step T-100 --repo-root/u);
        assert.equal(preview.requires_confirmation, true);
        assert.equal(preview.confirmation_phrase, 'RUN TASK NEXT STEP');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-next-step', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const disabledResetResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'preview' })
        });
        assert.equal(disabledResetResponse.status, 200);
        const disabledReset = await disabledResetResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(disabledReset.status, 'previewed');
        assert.match(disabledReset.command, /temporarily enable task_reset\.enabled/u);
        assert.match(disabledReset.command, /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);
        assert.match(disabledReset.command, /restore task_reset\.enabled=false/u);
        assert.equal(disabledReset.requires_confirmation, true);
        assert.equal(disabledReset.confirmation_phrase, 'RESET TASK');
        assert.deepEqual(executedCommands, []);

        const disabledDiscardResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-discard', mode: 'preview' })
        });
        assert.equal(disabledDiscardResponse.status, 200);
        const disabledDiscard = await disabledDiscardResponse.json() as {
            status: string;
            command: string;
            confirmation_phrase: string;
        };
        assert.equal(disabledDiscard.status, 'previewed');
        assert.match(disabledDiscard.command, /temporarily enable task_reset\.enabled/u);
        assert.match(disabledDiscard.command, /gate task-reset --task-id T-100 --to-status DONE --confirm --repo-root/u);
        assert.equal(disabledDiscard.confirmation_phrase, 'CLOSE WITHOUT EXECUTION');
        assert.deepEqual(executedCommands, []);

        const disabledResetExecuteResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'execute', confirmation: 'RESET TASK' })
        });
        assert.equal(disabledResetExecuteResponse.status, 200);
        const disabledResetExecute = await disabledResetExecuteResponse.json() as { status: string; stdout: string };
        assert.equal(disabledResetExecute.status, 'executed');
        assert.match(disabledResetExecute.stdout, /Task reset was enabled temporarily/u);
        assert.match(disabledResetExecute.stdout, /Task reset completed/u);
        assert.match(disabledResetExecute.stdout, /task_reset\.enabled was restored to false/u);
        assert.equal(executedCommands.length, 3);
        assert.match(executedCommands[0], /workflow set --task-reset-enabled true/u);
        assert.match(executedCommands[1], /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);
        assert.match(executedCommands[2], /workflow set --task-reset-enabled false/u);

        setTaskResetEnabled(repoRoot, true);
        const missingAuditResetResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'preview' })
        });
        assert.equal(missingAuditResetResponse.status, 200);
        const missingAuditReset = await missingAuditResetResponse.json() as {
            status: string;
            command: string;
        };
        assert.equal(missingAuditReset.status, 'previewed');
        assert.match(missingAuditReset.command, /repair audited task-reset evidence/u);
        assert.doesNotMatch(missingAuditReset.command, /restore task_reset\.enabled=false/u);

        const enablePreviewResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-enable-audited', mode: 'preview' })
        });
        assert.equal(enablePreviewResponse.status, 400);
        assert.equal((await enablePreviewResponse.json() as { code: string }).code, 'unknown_task_action');

        const missingAuditResetExecuteResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'execute', confirmation: 'RESET TASK' })
        });
        assert.equal(missingAuditResetExecuteResponse.status, 200);
        const missingAuditResetExecute = await missingAuditResetExecuteResponse.json() as { status: string; stdout: string };
        assert.equal(missingAuditResetExecute.status, 'executed');
        assert.match(missingAuditResetExecute.stdout, /Audited task-reset evidence repaired/u);
        assert.match(missingAuditResetExecute.stdout, /Task reset completed/u);
        assert.equal(executedCommands.length, 5);
        assert.match(executedCommands[3], /workflow set --task-reset-enabled true/u);
        assert.match(executedCommands[4], /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);

        writeLocalUiTaskResetAuditRecord(repoRoot);
        const resetPreviewResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'preview' })
        });
        assert.equal(resetPreviewResponse.status, 200);
        const resetPreview = await resetPreviewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(resetPreview.status, 'previewed');
        assert.match(resetPreview.command, /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);
        assert.equal(resetPreview.requires_confirmation, true);
        assert.equal(resetPreview.confirmation_phrase, 'RESET TASK');

        const resetBlockedResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(resetBlockedResponse.status, 409);
        assert.equal((await resetBlockedResponse.json() as { status: string }).status, 'confirmation_required');

        const resetExecuteResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'execute', confirmation: 'RESET TASK' })
        });
        assert.equal(resetExecuteResponse.status, 200);
        const resetExecute = await resetExecuteResponse.json() as { status: string; stdout: string };
        assert.equal(resetExecute.status, 'executed');
        assert.equal(resetExecute.stdout, 'Task reset completed.');
        assert.equal(executedCommands.length, 6);
        assert.match(executedCommands[5], /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);

        const discardPreviewResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-discard', mode: 'preview' })
        });
        assert.equal(discardPreviewResponse.status, 200);
        const discardPreview = await discardPreviewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(discardPreview.status, 'previewed');
        assert.match(discardPreview.command, /gate task-reset --task-id T-100 --to-status DONE --confirm --repo-root/u);
        assert.equal(discardPreview.requires_confirmation, true);
        assert.equal(discardPreview.confirmation_phrase, 'CLOSE WITHOUT EXECUTION');

        const discardExecuteResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-discard', mode: 'execute', confirmation: 'CLOSE WITHOUT EXECUTION' })
        });
        assert.equal(discardExecuteResponse.status, 200);
        const discardExecute = await discardExecuteResponse.json() as { status: string; stdout: string };
        assert.equal(discardExecute.status, 'executed');
        assert.equal(discardExecute.stdout, 'Close without execution completed.');
        assert.equal(executedCommands.length, 7);
        assert.match(executedCommands[6], /gate task-reset --task-id T-100 --to-status DONE --confirm --repo-root/u);

        const statsResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-stats', mode: 'execute' })
        });
        assert.equal(statsResponse.status, 200);
        const stats = await statsResponse.json() as { status: string; stdout: string; audit_path: string };
        assert.equal(stats.status, 'executed');
        assert.equal(stats.stdout, 'task ok');
        assert.equal(executedCommands.length, 8);
        assert.match(executedCommands[7], /task T-100 stats --target-root/u);
        const auditLines = fs.readFileSync(stats.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.match(auditLines[auditLines.length - 1], /"action_id":"T-100:task-stats"/u);
        assert.match(auditLines[auditLines.length - 1], /"status":"executed"/u);

        const unknownTaskResponse = await fetch(`${server.url}api/tasks/T-999/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-stats', mode: 'preview' })
        });
        assert.equal(unknownTaskResponse.status, 404);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI task reset one-shot restores disabled setting after reset failure', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            if (action.command.display.includes('gate task-reset')) {
                return {
                    exit_code: 7,
                    signal: null,
                    stdout: '',
                    stderr: 'reset failed details'
                };
            }
            return {
                exit_code: 0,
                signal: null,
                stdout: 'workflow ok',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const response = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'execute', confirmation: 'RESET TASK' })
        });
        assert.equal(response.status, 500);
        const result = await response.json() as { status: string; stdout: string; stderr: string };
        assert.equal(result.status, 'executed');
        assert.match(result.stdout, /Task reset was enabled temporarily/u);
        assert.match(result.stdout, /task_reset\.enabled was restored to false/u);
        assert.match(result.stderr, /Reset task failed with exit code 7/u);
        assert.match(result.stderr, /reset failed details/u);
        assert.equal(executedCommands.length, 3);
        assert.match(executedCommands[0], /workflow set --task-reset-enabled true/u);
        assert.match(executedCommands[1], /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);
        assert.match(executedCommands[2], /workflow set --task-reset-enabled false/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI task reset one-shot reports restore failure after close succeeds', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            if (action.command.display.includes('--task-reset-enabled false')) {
                return {
                    exit_code: 9,
                    signal: null,
                    stdout: '',
                    stderr: 'restore failed details'
                };
            }
            return {
                exit_code: 0,
                signal: null,
                stdout: 'task ok',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const response = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                action_id: 'task-reset-discard',
                mode: 'execute',
                confirmation: 'CLOSE WITHOUT EXECUTION'
            })
        });
        assert.equal(response.status, 500);
        const result = await response.json() as { status: string; stdout: string; stderr: string };
        assert.equal(result.status, 'executed');
        assert.match(result.stdout, /Task reset was enabled temporarily/u);
        assert.match(result.stdout, /Close without execution completed/u);
        assert.match(result.stderr, /task_reset\.enabled restore failed with exit code 9/u);
        assert.match(result.stderr, /restore failed details/u);
        assert.equal(executedCommands.length, 3);
        assert.match(executedCommands[0], /workflow set --task-reset-enabled true/u);
        assert.match(executedCommands[1], /gate task-reset --task-id T-100 --to-status DONE --confirm --repo-root/u);
        assert.match(executedCommands[2], /workflow set --task-reset-enabled false/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI actions reject cross-origin missing-token and non-json posts', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async () => ({
            exit_code: 0,
            signal: null,
            stdout: 'unexpected',
            stderr: ''
        })
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const body = JSON.stringify({ action_id: 'garda-off', mode: 'execute' });
        const missingToken = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1)
            },
            body
        });
        assert.equal(missingToken.status, 403);
        assert.equal((await missingToken.json() as { code: string }).code, 'action_boundary_rejected');

        const crossOrigin = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': 'http://example.test',
                'x-garda-action-token': actionToken
            },
            body
        });
        assert.equal(crossOrigin.status, 403);
        assert.equal((await crossOrigin.json() as { code: string }).code, 'action_boundary_rejected');

        const spoofedHost = await postJsonWithHostHeader({
            port: server.port,
            path: '/api/actions',
            hostHeader: `evil.test:${server.port}`,
            origin: `http://evil.test:${server.port}`,
            actionToken,
            body: { action_id: 'garda-off', mode: 'preview' }
        });
        assert.equal(spoofedHost.statusCode, 403);
        assert.equal(spoofedHost.payload.code, 'action_boundary_rejected');

        const nonJson = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: {
                'content-type': 'text/plain',
                'origin': server.url.slice(0, -1),
                'x-garda-action-token': actionToken
            },
            body
        });
        assert.equal(nonJson.status, 403);
        assert.equal((await nonJson.json() as { code: string }).code, 'action_boundary_rejected');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
