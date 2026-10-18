import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { startLocalUiServer, type LocalUiServer } from '../../../src/reports/ui/local-ui-server';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

function request(server: LocalUiServer, target: string, headers: http.OutgoingHttpHeaders = {}, method = 'GET'):
Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const outgoing = http.request({ hostname: server.host, port: server.port, path: target, headers, method }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode || 0, body, headers: response.headers }));
            response.on('error', reject);
        });
        outgoing.once('error', reject);
        outgoing.end(method === 'POST' ? '{}' : undefined);
    });
}

function rawRequest(server: LocalUiServer, hostHeaders: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(server.port, server.host);
        let response = '';
        socket.setTimeout(5000, () => socket.destroy(new Error('HTTP admission probe timed out.')));
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.end(['GET / HTTP/1.1', ...hostHeaders, 'Connection: close', '', ''].join('\r\n')));
        socket.on('data', chunk => { response += chunk; });
        socket.on('end', () => resolve(response));
        socket.once('error', reject);
    });
}

test('HTTP admission preserves canonical default-port authority for reads, previews and task actions', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'custom.preview'), 'default-port preview');
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true, idleShutdownEnabled: false });
    // Model the transport's default HTTP port without reserving a privileged system port.
    server.server.prependListener('request', incoming => {
        Object.defineProperty(incoming.socket, 'localPort', { value: 80, configurable: true });
    });
    try {
        const origin = 'http://127.0.0.1';
        for (const host of ['127.0.0.1', '127.0.0.1:80']) {
            const page = await request(server, '/', { host, origin, 'sec-fetch-site': 'same-origin' });
            assert.equal(page.status, 200, host);
            const token = page.body.match(/const actionToken = "([a-f0-9]{64})";/u)?.[1];
            assert.ok(token);
            assert.equal((await request(server, '/api/report', { host, origin })).status, 200);
            const preview = await request(server, `/files?path=custom.preview&action_token=${token}`, { host, referer: `${origin}/` });
            assert.equal(preview.status, 200);
            assert.equal(preview.body, 'default-port preview');
            const action = await request(server, '/api/tasks/T-999/actions', {
                host, origin, 'content-type': 'application/json', 'x-garda-action-token': token
            }, 'POST');
            assert.equal(action.status, 404, 'canonical browser Origin must pass authorization');
            assert.equal(JSON.parse(action.body).code, 'task_not_found');
        }
        for (const host of ['localhost', 'rebind.invalid', '127.0.0.1:81', '127.0.0.1:080', '127.000.000.001']) {
            assert.equal((await request(server, '/', { host })).status, 403, host);
        }
        assert.equal((await request(server, '/api/report', { host: '127.0.0.1', origin: 'http://hostile.invalid' })).status, 403);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('HTTP admission rejects foreign, ambiguous and wrong-port Host before exposing the page token', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, idleShutdownEnabled: false });
    try {
        const allowed = await request(server, '/');
        assert.equal(allowed.status, 200);
        assert.match(allowed.body, /const actionToken = "[a-f0-9]{64}";/u);
        assert.equal(allowed.headers['x-content-type-options'], 'nosniff');
        assert.equal(allowed.headers['x-frame-options'], 'DENY');
        assert.equal(allowed.headers['cross-origin-resource-policy'], 'same-origin');
        assert.equal(allowed.headers['referrer-policy'], 'same-origin');
        assert.equal(allowed.headers['access-control-allow-origin'], undefined);
        for (const host of [
            `rebind.invalid:${server.port}`, `127.0.0.1.attacker.invalid:${server.port}`,
            `localhost:${server.port}`, `127.0.0.1:${server.port === 65535 ? 65534 : server.port + 1}`,
            '127.0.0.1', `127.0.0.1:${server.port}, rebind.invalid`, `user@127.0.0.1:${server.port}`
        ]) {
            const denied = await request(server, '/', { host });
            assert.equal(denied.status, 403, host);
            assert.doesNotMatch(denied.body, /actionToken/u);
            assert.equal(denied.headers['cache-control'], 'no-store');
        }
        for (const headers of [[], [`Host: 127.0.0.1:${server.port}`, `Host: rebind.invalid:${server.port}`]]) {
            const denied = await rawRequest(server, headers);
            assert.match(denied, /^HTTP\/1\.1 (400|403) /u);
            assert.doesNotMatch(denied, /actionToken/u);
        }
        assert.equal((await request(server, '/', { host: `127.000.000.001:${server.port}` })).status, 403);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('HTTP admission rejects hostile read origins and cross-site metadata before workspace reads', async t => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, idleShutdownEnabled: false });
    const originalRead = fs.readFileSync;
    let taskReads = 0;
    try {
        t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
            if (String(args[0]) === path.join(repoRoot, 'TASK.md')) taskReads += 1;
            return originalRead(...args);
        });
        for (const headers of [
            { host: `rebind.invalid:${server.port}` }, { origin: 'http://hostile.invalid' },
            { origin: 'null' }, { origin: `${server.url}extra` }, { 'sec-fetch-site': 'cross-site' },
            { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'unknown' }
        ]) {
            for (const target of ['/api/report', '/api/tasks/T-100/detail', '/api/settings', '/api/actions']) {
                const denied = await request(server, target, headers);
                assert.equal(denied.status, 403, `${target} ${JSON.stringify(headers)}`);
                assert.equal(JSON.parse(denied.body).code, 'local_ui_boundary_rejected');
            }
        }
        assert.equal(taskReads, 0, 'rejected reads must not build a task report');
        const allowed = await request(server, '/api/report', { origin: server.url.slice(0, -1), 'sec-fetch-site': 'same-origin' });
        assert.equal(allowed.status, 200);
        assert.ok(taskReads > 0, 'the fixture must observe real report reads');
    } finally {
        t.mock.restoreAll();
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('task-action authorization precedes task lookup for missing, foreign and replayed tokens', async t => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true, idleShutdownEnabled: false });
    const other = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true, idleShutdownEnabled: false });
    try {
        const page = await request(server, '/');
        const token = page.body.match(/const actionToken = "([a-f0-9]{64})";/u)?.[1];
        const foreignToken = (await request(other, '/')).body.match(/const actionToken = "([a-f0-9]{64})";/u)?.[1];
        assert.ok(token && foreignToken);
        const originalRead = fs.readFileSync;
        let taskReads = 0;
        t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
            if (String(args[0]) === path.join(repoRoot, 'TASK.md')) taskReads += 1;
            return originalRead(...args);
        });
        const headers = { 'content-type': 'application/json', origin: server.url.slice(0, -1) };
        for (const deniedHeaders of [
            headers, { ...headers, 'x-garda-action-token': 'foreign' },
            { ...headers, 'x-garda-action-token': foreignToken },
            { ...headers, 'x-garda-action-token': token, origin: 'http://hostile.invalid' },
            { ...headers, 'x-garda-action-token': token, 'content-type': 'text/plain' },
            { ...headers, 'x-garda-action-token': token, host: `rebind.invalid:${server.port}` }
        ]) {
            for (const target of ['/api/tasks/T-100/actions', '/api/tasks/T-999/actions', '/api/tasks/%FF/actions']) {
                const denied = await request(server, target, deniedHeaders, 'POST');
                assert.equal(denied.status, 403);
                assert.equal(JSON.parse(denied.body).code, 'action_boundary_rejected');
            }
        }
        assert.equal(taskReads, 0, 'authorization must precede report projection and existence checks');
        const unknownTask = await request(server, '/api/tasks/T-999/actions', { ...headers, 'x-garda-action-token': token }, 'POST');
        assert.equal(unknownTask.status, 404);
        assert.equal(JSON.parse(unknownTask.body).code, 'task_not_found');
        assert.ok(taskReads > 0);
    } finally {
        t.mock.restoreAll();
        await cleanupLocalUiTestResources({ repoRoot, server });
        await other.close();
    }
});

test('protected POST error codes are unchanged by query parameters at both admission boundaries', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true, idleShutdownEnabled: false });
    try {
        for (const [endpoint, code] of [
            ['/api/update-availability/check', 'update_boundary_rejected'],
            ['/api/ordinary-docs', 'ordinary_docs_boundary_rejected']
        ]) {
            for (const suffix of ['', '?source=dashboard']) {
                for (const headers of [{}, { host: `rebind.invalid:${server.port}` }]) {
                    const denied = await request(server, endpoint + suffix, headers, 'POST');
                    assert.equal(denied.status, 403);
                    assert.equal(JSON.parse(denied.body).code, code);
                }
            }
        }
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('contained file previews reject foreign tokens and traversal without extension restrictions', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'custom.preview'), 'contained preview');
    const server = await startLocalUiServer({ repoRoot, port: 0, idleShutdownEnabled: false });
    try {
        const token = (await request(server, '/')).body.match(/const actionToken = "([a-f0-9]{64})";/u)?.[1];
        assert.ok(token);
        const target = `/files?path=custom.preview&action_token=${token}`;
        const allowed = await request(server, target, { referer: server.url });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.body, 'contained preview');
        assert.equal(allowed.headers['content-type'], 'text/plain; charset=utf-8');
        for (const headers of [{ referer: 'http://hostile.invalid/' }, {}, { origin: server.url.slice(0, -1), host: `rebind.invalid:${server.port}` }]) {
            assert.equal((await request(server, target, headers)).status, 403);
        }
        assert.equal((await request(server, '/files?path=custom.preview&action_token=foreign', { referer: server.url })).status, 403);
        assert.equal((await request(server, `/files?path=../outside&action_token=${token}`, { referer: server.url })).status, 404);
        assert.equal((await request(server, `http://hostile.invalid/files?path=custom.preview&action_token=${token}`, { referer: server.url })).status, 403);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
