import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { UI_DASHBOARD_CLIENT_INIT_SETTINGS } from '../../../src/reports/ui/dashboard/dashboard-client-init-settings';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}

function createPreviewClient() {
    const elements = new Map<string, { hidden: boolean; innerHTML: string; scrollIntoView: () => void }>();
    const requests: ReturnType<typeof deferred<{ text: () => Promise<string> }>>[] = [];
    const createTarget = (id: string) => {
        const target = { hidden: true, innerHTML: '', scrollIntoView() {} };
        elements.set(id, target);
        return target;
    };
    const context = vm.createContext({
        document: { getElementById: (id: string) => elements.get(id) },
        actionToken: 'synthetic-token',
        safe: String, t: String,
        fetch: () => {
            const request = deferred<{ text: () => Promise<string> }>();
            requests.push(request);
            return request.promise;
        }
    });
    vm.runInContext(UI_DASHBOARD_CLIENT_INIT_SETTINGS, context);
    const open = context.openReadOnlyFile as (value: string, target: string) => Promise<void>;
    const respond = (index: number, body: string) => requests[index].resolve({ text: async () => body });
    return { open, requests, createTarget, respond };
}

test('an older preview response cannot replace the latest selected file', async () => {
    const client = createPreviewClient(), target = client.createTarget('preview');
    const first = client.open('first.txt', 'preview'), second = client.open('second.txt', 'preview');
    client.respond(1, 'second body'); await second;
    client.respond(0, 'first body'); await first;
    assert.match(target.innerHTML, /second\.txt.*second body/);
    assert.doesNotMatch(target.innerHTML, /first/);
});

test('an older preview failure cannot replace a successful newer request', async () => {
    const client = createPreviewClient(), target = client.createTarget('preview');
    const first = client.open('first.txt', 'preview'), second = client.open('second.txt', 'preview');
    client.respond(1, 'second body'); await second;
    client.requests[0].reject(new Error('old failure')); await first;
    assert.match(target.innerHTML, /second body/);
    assert.doesNotMatch(target.innerHTML, /old failure/);
});

test('selection can change while an earlier response body is still loading', async () => {
    const client = createPreviewClient(), target = client.createTarget('preview'), body = deferred<string>();
    const first = client.open('first.txt', 'preview');
    client.requests[0].resolve({ text: () => body.promise });
    await Promise.resolve();
    const second = client.open('second.txt', 'preview');
    client.respond(1, 'latest body'); await second;
    body.resolve('old body'); await first;
    assert.match(target.innerHTML, /latest body/);
});

test('separate preview targets keep independent request ownership', async () => {
    const client = createPreviewClient(), left = client.createTarget('left'), right = client.createTarget('right');
    const first = client.open('left.txt', 'left'), second = client.open('right.txt', 'right');
    client.respond(1, 'right body'); await second;
    client.respond(0, 'left body'); await first;
    assert.match(left.innerHTML, /left body/);
    assert.match(right.innerHTML, /right body/);
});

test('a replaced preview element does not receive a stale response', async () => {
    const client = createPreviewClient(), old = client.createTarget('preview');
    const pending = client.open('old.txt', 'preview'), current = client.createTarget('preview');
    client.respond(0, 'old body'); await pending;
    assert.doesNotMatch(old.innerHTML, /old body/);
    assert.equal(current.innerHTML, '');
});

test('the current preview still displays errors and ignores missing targets', async () => {
    const client = createPreviewClient(), target = client.createTarget('preview');
    await client.open('missing.txt', 'missing');
    assert.equal(client.requests.length, 0);
    const pending = client.open('current.txt', 'preview');
    client.requests[0].reject(new Error('current failure')); await pending;
    assert.match(target.innerHTML, /current failure/);
});
