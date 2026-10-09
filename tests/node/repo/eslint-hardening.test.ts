import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ESLint } from 'eslint';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

const repoRoot = getRepoRoot();
const eslint = new ESLint({ cwd: repoRoot });
const legacy = JSON.parse(fs.readFileSync(path.join(repoRoot, '.eslint/legacy-explicit-any.json'), 'utf8')) as {
    schemaVersion: number;
    files: string[];
};
const anyRule = '@typescript-eslint/no-explicit-any';
const unusedRule = '@typescript-eslint/no-unused-vars';

async function lint(source: string, filePath: string): Promise<ESLint.LintResult> {
    const results = await eslint.lintText(source, { filePath });
    assert.equal(results.length, 1);
    assert.equal(results[0].fatalErrorCount, 0);
    return results[0];
}

test('ESLint rejects explicit any in new source and test files', async () => {
    for (const filePath of ['src/eslint-contract-fixture.ts', 'tests/node/repo/eslint-contract-fixture.ts']) {
        const result = await lint('export const value: any = 1;\n', filePath);
        assert.deepEqual(result.messages.map(({ ruleId, severity }) => ({ ruleId, severity })), [
            { ruleId: anyRule, severity: 2 }
        ]);
        assert.equal(result.errorCount, 1);
    }
});

test('ESLint legacy warnings preserve hardening errors and reject neighboring file exceptions', async () => {
    const filePath = legacy.files.find((file) => file.startsWith('src/'));
    assert.ok(filePath);
    const result = await lint('export const value: any = 1;\nvalue = 2;\n', filePath);
    assert.equal(result.messages.find(({ ruleId }) => ruleId === anyRule)?.severity, 1);
    assert.equal(result.messages.find(({ ruleId }) => ruleId === 'no-const-assign')?.severity, 2);
    const neighbor = await lint('export const value: any = 1;\n', filePath.replace(/\.ts$/u, '-new.ts'));
    assert.equal(neighbor.messages.find(({ ruleId }) => ruleId === anyRule)?.severity, 2);
});

test('ESLint reports unused bindings in source and tests while permitting intentional underscore bindings', async () => {
    const source = `export function sample(_ignored: string, unusedArgument: string, usedArgument: string) {
    const _ignoredLocal = 1;
    const unusedLocal = 2;
    try { throw new Error('probe'); } catch (_ignoredError) {}
    return usedArgument;
}\n`;
    for (const filePath of ['src/eslint-contract-fixture.ts', 'tests/node/repo/eslint-contract-fixture.ts']) {
        const result = await lint(source, filePath);
        assert.equal(result.errorCount, 0);
        assert.equal(result.messages.length, 2);
        assert.ok(result.messages.every(({ ruleId, severity }) => ruleId === unusedRule && severity === 1));
        assert.ok(result.messages.some(({ message }) => message.includes('unusedArgument')));
        assert.ok(result.messages.some(({ message }) => message.includes('unusedLocal')));
    }
});

test('ESLint reports unused caught errors and permits rest-sibling omissions', async () => {
    const result = await lint(`export function sample(input: { omitted: string; kept: string }) {
    const { omitted, ...rest } = input;
    try { throw new Error('probe'); } catch (unusedError) {}
    return rest;
}\n`, 'src/eslint-contract-fixture.ts');
    assert.equal(result.errorCount, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].ruleId, unusedRule);
    assert.equal(result.messages[0].severity, 1);
    assert.match(result.messages[0].message, /unusedError/u);
});

test('ESLint legacy inventory rejects broad globs, duplicates, traversal and obsolete exceptions', async () => {
    assert.equal(legacy.schemaVersion, 1);
    assert.ok(legacy.files.length > 0);
    assert.equal(new Set(legacy.files).size, legacy.files.length);
    assert.deepEqual(legacy.files, [...legacy.files].sort());
    for (const file of legacy.files) {
        assert.match(file, /^(?:src|tests\/node)\/[A-Za-z0-9_./-]+\.ts$/u);
        assert.ok(file.split('/').every((segment) => segment !== '.' && segment !== '..'));
        assert.equal(fs.statSync(path.join(repoRoot, file)).isFile(), true);
    }
    const results = await eslint.lintFiles(legacy.files);
    assert.equal(results.length, legacy.files.length);
    for (const result of results) {
        const messages = result.messages.filter(({ ruleId }) => ruleId === anyRule);
        assert.ok(messages.length > 0, `Remove the obsolete exception for ${result.filePath}`);
        assert.ok(messages.every(({ severity }) => severity === 1));
    }
});

test('ESLint preserves the existing build-script rule boundary', async () => {
    const result = await lint('export const value: any = 1;\nconst unused = 2;\n',
        'scripts/node-foundation/eslint-contract-fixture.ts');
    assert.equal(result.messages.length, 0);
});
