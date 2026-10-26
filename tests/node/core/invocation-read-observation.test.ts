import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    assertInvocationDependenciesCurrent,
    isInvocationReadObservationActive,
    registerInvocationDependency,
    withInvocationReadObservation
} from '../../../src/core/invocation-read-observation';

function fixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-invocation-observation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return { promise, resolve };
}

function fileValidator(file: string, failure: unknown): () => void {
    const bytes = fs.readFileSync(file);
    return () => {
        let current: Buffer;
        try { current = fs.readFileSync(file); }
        catch { throw failure; }
        if (!current.equals(bytes)) throw failure;
    };
}

function assertThrowsSame(action: () => unknown, expected: unknown): void {
    let threw = false;
    try { action(); }
    catch (error: unknown) { threw = true; assert.equal(error, expected); }
    assert.equal(threw, true);
}

test('validates before synchronous return without reading returned object getters or proxy traps', () => {
    let calls = 0, getters = 0, traps = 0;
    const value = { get then() { getters += 1; throw new Error('Do not inspect ordinary results'); } };
    const proxy = new Proxy(value, { get() { traps += 1; throw new Error('Do not inspect proxy results'); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const result of [value, proxy, revoked.proxy]) {
        assert.equal(withInvocationReadObservation(() => {
            assert.equal(isInvocationReadObservationActive(), true);
            registerInvocationDependency({}, () => {
                assert.equal(isInvocationReadObservationActive(), true);
                calls += 1;
            });
            return result;
        }), result);
    }
    assert.equal(calls, 3);
    assert.equal(getters, 0);
    assert.equal(traps, 0);
    assert.equal(isInvocationReadObservationActive(), false);
    registerInvocationDependency({}, () => { throw new Error('No invocation'); });
    assert.doesNotThrow(assertInvocationDependenciesCurrent);
});

test('rejects a real file replacement after observation before returning or executing an effect', t => {
    const root = fixture(t), file = path.join(root, 'observed.txt');
    const failure = new Error('Observed file replaced');
    let effectRan = false;
    for (const explicitCheck of [false, true]) {
        fs.writeFileSync(file, 'original');
        assertThrowsSame(() => withInvocationReadObservation(() => {
            registerInvocationDependency({}, fileValidator(file, failure));
            const replacement = path.join(root, 'replacement.txt');
            fs.writeFileSync(replacement, 'replacement');
            fs.renameSync(replacement, file);
            if (explicitCheck) {
                assertInvocationDependenciesCurrent();
                effectRan = true;
            }
        }), failure);
    }
    assert.equal(effectRan, false);
});

test('rejects an absent path that becomes present during the invocation', t => {
    const file = path.join(fixture(t), 'absent.txt');
    const failure = new Error('Observed absence changed');
    assert.equal(fs.existsSync(file), false);
    assertThrowsSame(() => withInvocationReadObservation(() => {
        registerInvocationDependency({}, () => { if (fs.existsSync(file)) throw failure; });
        fs.writeFileSync(file, 'new artifact');
    }), failure);
});

test('retains dependencies after synchronous and asynchronous nested scopes return', async t => {
    const file = path.join(fixture(t), 'nested.txt');
    const failure = new Error('Nested observation changed');
    fs.writeFileSync(file, 'original');
    assertThrowsSame(() => withInvocationReadObservation(() => {
        withInvocationReadObservation(() => registerInvocationDependency({}, fileValidator(file, failure)));
        fs.writeFileSync(file, 'changed after nested return');
    }), failure);
    fs.writeFileSync(file, 'original');
    await assert.rejects(withInvocationReadObservation(async () => {
        await withInvocationReadObservation(async () => {
            await Promise.resolve();
            registerInvocationDependency({}, fileValidator(file, failure));
        });
        fs.writeFileSync(file, 'changed after nested settlement');
    }), error => error === failure);
});

test('preserves the first validator and sticky failure after mutation is caught and bytes restored', t => {
    const file = path.join(fixture(t), 'sticky.txt'), owner = {};
    for (const failure of [new Error('Original failure'), undefined, null]) {
        fs.writeFileSync(file, 'original');
        let replacementCalls = 0;
        assertThrowsSame(() => withInvocationReadObservation(() => {
            registerInvocationDependency(owner, fileValidator(file, failure));
            fs.writeFileSync(file, 'changed');
            registerInvocationDependency(owner, () => { replacementCalls += 1; });
            assertThrowsSame(assertInvocationDependenciesCurrent, failure);
            fs.writeFileSync(file, 'original');
            assertThrowsSame(assertInvocationDependenciesCurrent, failure);
        }), failure);
        assert.equal(replacementCalls, 0);
    }
});

test('checks dependencies added during validation instead of omitting the new owner', t => {
    const file = path.join(fixture(t), 'registered-during-check.txt');
    fs.writeFileSync(file, 'original');
    const failure = new Error('Newly registered dependency changed');
    const validateFile = fileValidator(file, failure), addedOwner = {};
    assertThrowsSame(() => withInvocationReadObservation(() => {
        registerInvocationDependency({}, () => registerInvocationDependency(addedOwner, validateFile));
        fs.writeFileSync(file, 'changed before final check');
    }), failure);
});

test('recursive validation fails closed even when the validator catches the error', () => {
    let observed: unknown;
    assert.throws(() => withInvocationReadObservation(() => {
        registerInvocationDependency({}, () => {
            try { assertInvocationDependenciesCurrent(); }
            catch (error: unknown) { observed = error; }
        });
    }), error => error === observed && error instanceof Error && /cannot be re-entered/.test(error.message));
});

test('isolates concurrent asynchronous observations and checks before successful settlement', async t => {
    const root = fixture(t), firstFile = path.join(root, 'first.txt'), secondFile = path.join(root, 'second.txt');
    fs.writeFileSync(firstFile, 'first');
    fs.writeFileSync(secondFile, 'second');
    const firstGate = deferred(), secondGate = deferred(), sharedOwner = {};
    const firstFailure = new Error('First invocation changed');
    const first = withInvocationReadObservation(async () => {
        registerInvocationDependency(sharedOwner, fileValidator(firstFile, firstFailure));
        await firstGate.promise;
        assert.equal(isInvocationReadObservationActive(), true);
        return 'first';
    });
    const second = withInvocationReadObservation(async () => {
        registerInvocationDependency(sharedOwner, fileValidator(secondFile, new Error('Second invocation changed')));
        await secondGate.promise;
        assert.equal(isInvocationReadObservationActive(), true);
        return 'second';
    });
    assert.equal(isInvocationReadObservationActive(), false);
    fs.writeFileSync(firstFile, 'changed while asynchronous work is pending');
    secondGate.resolve();
    assert.equal(await second, 'second');
    firstGate.resolve();
    await assert.rejects(first, error => error === firstFailure);
    assert.equal(isInvocationReadObservationActive(), false);
});

test('detached callbacks cannot reuse closed synchronous or asynchronous observations', async t => {
    const file = path.join(fixture(t), 'detached.txt');
    fs.writeFileSync(file, 'original');
    for (const asynchronous of [false, true]) {
        const gate = deferred(), owner = {};
        let detached!: Promise<void>, originalChecks = 0, freshChecks = 0;
        const action = () => {
            registerInvocationDependency(owner, () => { originalChecks += 1; });
            detached = gate.promise.then(() => {
                assert.equal(isInvocationReadObservationActive(), false);
                registerInvocationDependency(owner, () => { throw new Error('Closed registration'); });
                assertInvocationDependenciesCurrent();
                withInvocationReadObservation(() => {
                    const validateFile = fileValidator(file, new Error('Fresh invocation changed'));
                    registerInvocationDependency(owner, () => { validateFile(); freshChecks += 1; });
                });
                assert.equal(isInvocationReadObservationActive(), false);
            });
            return asynchronous ? Promise.resolve() : undefined;
        };
        await withInvocationReadObservation(action);
        assert.equal(originalChecks, 1);
        gate.resolve();
        await detached;
        assert.equal(originalChecks, 1);
        assert.equal(freshChecks, 1);
    }
});

test('preserves original callback exceptions and Promise rejections over dependency failures', async t => {
    const file = path.join(fixture(t), 'rejected.txt');
    const dependencyFailure = new Error('Dependency failure'), originalFailure = new Error('Original callback failure');
    fs.writeFileSync(file, 'original');
    assertThrowsSame(() => withInvocationReadObservation(() => {
        registerInvocationDependency({}, fileValidator(file, dependencyFailure));
        fs.writeFileSync(file, 'changed');
        assertThrowsSame(assertInvocationDependenciesCurrent, dependencyFailure);
        throw originalFailure;
    }), originalFailure);
    fs.writeFileSync(file, 'original');
    await assert.rejects(withInvocationReadObservation(async () => {
        registerInvocationDependency({}, fileValidator(file, dependencyFailure));
        fs.writeFileSync(file, 'changed');
        assertThrowsSame(assertInvocationDependenciesCurrent, dependencyFailure);
        await Promise.resolve();
        throw originalFailure;
    }), error => error === originalFailure);
    assert.equal(isInvocationReadObservationActive(), false);
});
