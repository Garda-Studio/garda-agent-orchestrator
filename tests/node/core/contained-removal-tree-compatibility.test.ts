import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
    assertBoundContainedRemovalTree, bindContainedDestination
} from '../../../src/core/contained-filesystem';

function fixture(t: TestContext): { root: string; directory: string } {
    const temporaryRoot = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'garda-contained-removal-compat-'));
    const directory = path.join(root, 'package');
    fs.mkdirSync(directory);
    t.after(() => {
        assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
        assert.ok(path.basename(root).startsWith('garda-contained-removal-compat-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, directory };
}

test('preserves the one-argument read-only contained-tree assertion', t => {
    const { root, directory } = fixture(t);
    const file = path.join(directory, 'payload.txt');
    fs.writeFileSync(file, 'required suspended bytes');
    const binding = bindContainedDestination(root, directory);
    assert.doesNotThrow(() => assertBoundContainedRemovalTree(binding));
    assert.deepEqual(fs.readdirSync(directory), ['payload.txt']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'required suspended bytes');
});

test('caps the default tree at 4096 entries and preserves an explicit larger cap', t => {
    const { root, directory } = fixture(t);
    for (let index = 0; index < 4095; index += 1) {
        fs.writeFileSync(path.join(directory, `entry-${index}.txt`), '');
    }
    const binding = bindContainedDestination(root, directory);
    const exactLimit = fs.readdirSync(directory).sort();
    assert.doesNotThrow(() => assertBoundContainedRemovalTree(binding));
    assert.deepEqual(fs.readdirSync(directory).sort(), exactLimit);
    fs.writeFileSync(path.join(directory, 'entry-4095.txt'), '');
    const before = fs.readdirSync(directory).sort();
    assert.throws(() => assertBoundContainedRemovalTree(binding), /entry limit exceeded/u);
    assert.deepEqual(fs.readdirSync(directory).sort(), before);
    assert.doesNotThrow(() => assertBoundContainedRemovalTree(binding, 4097));
    assert.deepEqual(fs.readdirSync(directory).sort(), before);
});

test('preserves explicit smaller caps and zero-entry rejection without mutation', t => {
    const { root, directory } = fixture(t);
    const binding = bindContainedDestination(root, directory);
    assert.throws(() => assertBoundContainedRemovalTree(binding, 0), /entry limit exceeded/u);
    assert.doesNotThrow(() => assertBoundContainedRemovalTree(binding, 1));
    fs.writeFileSync(path.join(directory, 'payload.txt'), 'retained');
    assert.throws(() => assertBoundContainedRemovalTree(binding, 1), /entry limit exceeded/u);
    assert.equal(fs.readFileSync(path.join(directory, 'payload.txt'), 'utf8'), 'retained');
    assert.doesNotThrow(() => assertBoundContainedRemovalTree(binding, 2));
});

test('keeps invalid explicit caps fail-closed', t => {
    const { root, directory } = fixture(t);
    const binding = bindContainedDestination(root, directory);
    for (const cap of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => assertBoundContainedRemovalTree(binding, cap), /nonnegative safe integer/u);
    }
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('the default call cannot authorize removal of the containment root', t => {
    const { root, directory } = fixture(t);
    assert.throws(() => assertBoundContainedRemovalTree(bindContainedDestination(root, root)),
        /Refusing to remove containment root/u);
    assert.ok(fs.existsSync(directory));
});

test('keeps retained membership checks when the default cap is selected', t => {
    const { root, directory } = fixture(t);
    const file = path.join(directory, 'payload.txt');
    fs.writeFileSync(file, 'required');
    const binding = bindContainedDestination(root, directory);
    const retained = [binding, bindContainedDestination(root, file)];
    assert.doesNotThrow(() => assertBoundContainedRemovalTree(binding, undefined, retained));
    fs.writeFileSync(path.join(directory, 'unexpected.txt'), 'foreign');
    assert.throws(() => assertBoundContainedRemovalTree(binding, undefined, retained),
        /tree membership changed/u);
    assert.equal(fs.readFileSync(file, 'utf8'), 'required');
    assert.equal(fs.readFileSync(path.join(directory, 'unexpected.txt'), 'utf8'), 'foreign');
});
