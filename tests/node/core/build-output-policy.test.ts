import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_UNTRACKED_BUILD_OUTPUT_REGEXES, filterBuildOutputScopePaths,
    filterUntrackedBuildOutputPaths, normalizeUntrackedBuildOutputRegexes } from '../../../src/core/build-output-paths';
import { runGit } from '../../../src/core/git-helpers';
import { validatePathsConfig } from '../../../src/schemas/config-artifacts-core';

test('T-404 managed build defaults and schema validation share the runtime contract', () => {
    const template = JSON.parse(fs.readFileSync(path.resolve('template/config/paths.json'), 'utf8'));
    assert.deepEqual(template.untracked_build_output_regexes, DEFAULT_UNTRACKED_BUILD_OUTPUT_REGEXES);
    assert.deepEqual(validatePathsConfig(template).untracked_build_output_regexes, DEFAULT_UNTRACKED_BUILD_OUTPUT_REGEXES);
    for (const value of [null, 'target/', ['['], [null], ['']]) {
        assert.throws(() => normalizeUntrackedBuildOutputRegexes(value), /untracked_build_output_regexes/);
        assert.throws(() => validatePathsConfig({ ...template, untracked_build_output_regexes: value }), /untracked_build_output_regexes/);
    }
});

test('T-404 preserves staged deletion and exact Git path components in build filtering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-policy-'));
    try {
        runGit(root, ['init']);
        runGit(root, ['config', 'user.name', 'Garda Tests']);
        runGit(root, ['config', 'user.email', 'tests@example.com']);
        fs.mkdirSync(path.join(root, 'bin'));
        fs.writeFileSync(path.join(root, 'bin/tracked.ts'), 'tracked\n');
        runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'seed']);
        runGit(root, ['rm', 'bin/tracked.ts']);
        assert.deepEqual(filterBuildOutputScopePaths(root, ['bin/tracked.ts', 'bin/new.dll', 'source.ts']),
            ['bin/tracked.ts', 'source.ts']);
        assert.deepEqual(filterUntrackedBuildOutputPaths(root, ['target\\literal.ts', 'mytarget/file', 'target/file',
            'build.config.ts', 'folder/coverage.txt', 'nested/out/file']),
            ['target\\literal.ts', 'mytarget/file', 'build.config.ts', 'folder/coverage.txt']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T-404 preserves both tracked endpoints of staged rename inside build directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-rename-'));
    try {
        runGit(root, ['init']);
        runGit(root, ['config', 'user.name', 'Garda Tests']);
        runGit(root, ['config', 'user.email', 'tests@example.com']);
        runGit(root, ['config', 'diff.renames', 'true']);
        fs.mkdirSync(path.join(root, 'bin'));
        fs.writeFileSync(path.join(root, 'bin/old.ts'), 'tracked\n');
        runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'seed']);
        runGit(root, ['mv', 'bin/old.ts', 'bin/new.ts']);
        const files = ['bin/old.ts', 'bin/new.ts', 'source.ts'];
        assert.deepEqual(filterBuildOutputScopePaths(root, files), files);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
