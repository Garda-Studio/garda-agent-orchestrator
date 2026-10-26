import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneJson, cloneFrozenJson } from '../../../src/core/immutable-json';

test('iterative derivation cloning preserves deep own properties and mutable isolated copies', () => {
    const source: Record<string, unknown> = JSON.parse('{"__proto__":{"safe":true}}');
    let node = source;
    for (let index = 0; index < 20000; index++) { const next = {}; node.next = next; node = next; }
    node.value = 'leaf';
    const frozen = cloneFrozenJson(source), mutable = cloneJson(frozen);
    assert.equal(Object.getPrototypeOf(frozen), Object.prototype);
    assert.equal(Object.hasOwn(frozen, '__proto__'), true);
    let a = source, b = frozen, c = mutable;
    for (let index = 0; index < 20000; index++) {
        assert.ok(Object.isFrozen(b)); assert.ok(!Object.isFrozen(c));
        assert.notEqual(a, b); assert.notEqual(b, c);
        a = a.next as Record<string, unknown>; b = b.next as Record<string, unknown>; c = c.next as Record<string, unknown>;
    }
    assert.equal(c.value, 'leaf'); c.value = 'changed'; assert.equal(b.value, 'leaf');
});

test('derivation cloning preserves array holes and shared own values without invoking accessors', () => {
    const nested = { value: 1 }, sparse = new Array(4); sparse[0] = nested;
    const source = { nested, sparse, alias: nested };
    const frozen = cloneFrozenJson(source);
    assert.equal(frozen.sparse.length, 4); assert.equal(1 in frozen.sparse, false);
    assert.equal(frozen.alias, frozen.nested); assert.equal(frozen.sparse[0], frozen.nested);
    let called = 0;
    assert.throws(() => cloneJson({ get accessor() { called++; return 1; } }), /accessors/);
    assert.equal(called, 0);
});
