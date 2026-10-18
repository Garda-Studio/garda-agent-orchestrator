import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredFileRole, isTestScopePath, mergeFileRoleBindings, normalizeFileRoleBindings } from '../../../src/core/file-role-bindings';

test('explicit source and test roles take precedence over name guesses using exact literal paths', () => {
    const roles = normalizeFileRoleBindings({ 'docs/view.mdx': 'source', 'tests/rules.yaml': 'source',
        'quality/purchase.case': 'test', 'quality/购买': 'test', 'quality/a+b.case': 'test' });
    assert.equal(isTestScopePath('tests/rules.yaml', ['(^|/)tests/'], roles), false);
    assert.equal(isTestScopePath('quality/purchase.case', [], roles), true);
    assert.equal(declaredFileRole('quality/购买', roles), 'test');
    assert.equal(declaredFileRole('quality/ab.case', roles), undefined);
    assert.equal(declaredFileRole('docs/view.mdx.backup', roles), undefined);
    assert.equal(declaredFileRole('QUALITY/PURCHASE.CASE', roles), process.platform === 'win32' ? 'test' : undefined);
    assert.equal(isTestScopePath('tests/conventional.ts', ['(^|/)tests/'], roles), true);
});

test('rejects malformed, escaping, conflicting and oversized role declarations without dropping entries', () => {
    for (const value of [null, [], { '../source.md': 'source' }, { './source.md': 'source' },
        { '/source.md': 'source' }, { 'C:/source.md': 'source' }, { 'source.md': 'docs' },
        { 'source.md': '' }, { 'source\n.md': 'source' }]) {
        assert.throws(() => normalizeFileRoleBindings(value));
    }
    assert.throws(() => normalizeFileRoleBindings(Object.fromEntries(
        Array.from({ length: 1025 }, (_, index) => [`source-${index}`, 'source']))));
    assert.throws(() => mergeFileRoleBindings({ 'same.path': 'source' }, { 'same.path': 'test' }), /Conflicting/u);
    assert.deepEqual(mergeFileRoleBindings({ 'same.path': 'source' }, { 'same.path': 'source' }), { 'same.path': 'source' });
    const special = normalizeFileRoleBindings(JSON.parse('{"__proto__":"source"}'));
    assert.equal(declaredFileRole('__proto__', special), 'source');
    assert.equal(declaredFileRole('constructor', special), undefined);
});
