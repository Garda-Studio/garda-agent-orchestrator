import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../../src/core/git-helpers';
import { classifyGitChanges } from '../../../src/core/git-change-classification';
import { loadPathsConfig } from '../../../src/policy/profile-resolver';
import { migrateLegacyManagedPathRegexes } from '../../../src/policy/default-path-regexes';
import { filterBuildOutputScopePaths } from '../../../src/core/build-output-paths';

const OUTPUTS = ['target', 'bin', 'obj', 'build', 'dist', 'out', '__pycache__', '.venv', 'venv',
    'node_modules', '.gradle', '.pytest_cache', '.mypy_cache', 'coverage', '_build', '.build', '.dart_tool',
    '.zig-cache', 'zig-out'];

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-paths-'));
    runGit(root, ['init']);
    runGit(root, ['config', 'core.autocrlf', 'false']);
    runGit(root, ['config', 'user.name', 'Garda Tests']);
    runGit(root, ['config', 'user.email', 'tests@example.com']);
    const write = (file: string, text = 'new\n') => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    write('target/tracked.ts', 'old\n');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'seed']);
    return { root, write, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('T-404 ignores only untracked build output while retaining tracked and ordinary untracked files', () => {
    const f = fixture();
    try {
        for (const directory of OUTPUTS) f.write(`nested/${directory}/результат.dat`);
        for (const file of ['module.pyc', 'nested/module.pyo', 'src/new.ts', 'Cargo.lock', 'build.config.ts', 'target.txt']) f.write(file);
        f.write('target/tracked.ts');
        const result = classifyGitChanges(f.root);
        assert.deepEqual(result.effectiveChangedFiles, ['Cargo.lock', 'build.config.ts', 'src/new.ts', 'target.txt', 'target/tracked.ts']);
        runGit(f.root, ['add', 'nested/bin/результат.dat']);
        assert.ok(classifyGitChanges(f.root).stagedFiles.includes('nested/bin/результат.dat'));
        assert.ok(!classifyGitChanges(f.root, { explicitUntrackedPaths: ['nested/target/результат.dat'] })
            .effectiveChangedFiles.includes('nested/target/результат.dat'));
    } finally { f.clean(); }
});

test('T-404 configured untracked build patterns replace defaults and preserve explicit empty configuration', () => {
    const f = fixture();
    try {
        const config = 'garda-agent-orchestrator/live/config/paths.json';
        f.write(config, JSON.stringify({ untracked_build_output_regexes: ['(^|/)generated/'] }));
        runGit(f.root, ['add', config]);
        runGit(f.root, ['commit', '-m', 'config']);
        f.write('generated/result.dat'); f.write('target/output.dat');
        assert.deepEqual(classifyGitChanges(f.root).untrackedFiles, ['target/output.dat']);
        const loaded = loadPathsConfig(path.join(f.root, config)) as unknown as Record<string, unknown>;
        assert.deepEqual(loaded.untracked_build_output_regexes, ['(^|/)generated/']);
        f.write(config, JSON.stringify({ untracked_build_output_regexes: [] }));
        assert.deepEqual(classifyGitChanges(f.root).untrackedFiles, ['generated/result.dat', 'target/output.dat']);
    } finally { f.clean(); }
});

test('T-419 keeps ignored explicit Garda executable runtime in scope while filtering ordinary build output', () => {
    const f = fixture();
    try {
        f.write('package.json', JSON.stringify({ name: 'garda-agent-orchestrator' }));
        runGit(f.root, ['add', 'package.json']);
        runGit(f.root, ['commit', '-m', 'source checkout']);
        f.write('.git/info/exclude', 'dist/\n');
        const runtime = 'dist/src/gates/next-step/next-step.js';
        const paths = [runtime, 'dist/assets/result.js', 'dist/src-copy/result.js',
            'nested/dist/src/result.js', 'target/tracked.ts'];
        for (const file of paths) f.write(file);

        assert.deepEqual(filterBuildOutputScopePaths(f.root, paths), [runtime, 'target/tracked.ts']);
        assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: paths }).untrackedFiles, [runtime]);
        assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: paths }).stagedFiles, []);
        assert.ok(classifyGitChanges(f.root, { explicitUntrackedPaths: paths })
            .effectiveChangedFiles.includes('target/tracked.ts'));

        f.write('package.json', JSON.stringify({ name: 'ordinary-project' }));
        assert.deepEqual(filterBuildOutputScopePaths(f.root, paths), ['target/tracked.ts']);
        assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: paths }).untrackedFiles, []);
    } finally { f.clean(); }
});

for (const [label, packageContents] of [
    ['missing', undefined], ['unrelated', '{"name":"ordinary-project"}'],
    ['lookalike', '{"name":"garda-agent-orchestrator-fork"}'], ['malformed', '{"name":']
] as const) {
    test(`T-419 retains build filtering for ${label} Garda package identity`, () => {
        const f = fixture();
        try {
            if (packageContents !== undefined) {
                f.write('package.json', packageContents);
                runGit(f.root, ['add', 'package.json']);
                runGit(f.root, ['commit', '-m', 'ordinary project']);
            }
            const runtime = 'dist/src/gates/next-step/next-step.js';
            f.write(runtime);
            assert.deepEqual(filterBuildOutputScopePaths(f.root, [runtime]), []);
            assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: [runtime] }).untrackedFiles, []);
        } finally { f.clean(); }
    });
}

test('T-404 legacy paths migration adds missing build defaults without rewriting project customization', () => {
    const defaults = { untracked_build_output_regexes: ['(^|/)target/', '\\.py[co]$'] };
    const legacy: Record<string, unknown> = { runtime_roots: ['custom/'] };
    assert.ok(migrateLegacyManagedPathRegexes(legacy, defaults).includes('untracked_build_output_regexes'));
    assert.deepEqual(legacy.untracked_build_output_regexes, defaults.untracked_build_output_regexes);
    for (const custom of [[], ['custom/']]) {
        const configured = { untracked_build_output_regexes: custom };
        assert.deepEqual(migrateLegacyManagedPathRegexes(configured, defaults), []);
        assert.deepEqual(configured.untracked_build_output_regexes, custom);
    }
});

for (const [label, patterns, expected] of [
    ['default', undefined, ['generated/output.ts', 'src/explicit.ts', 'target/tracked.ts']],
    ['custom', ['(^|/)generated/'], ['src/explicit.ts', 'target/generated.ts', 'target/tracked.ts']],
    ['empty', [], ['generated/output.ts', 'src/explicit.ts', 'target/generated.ts', 'target/tracked.ts']]
] as const) {
    test(`T-404 normalizes explicit path aliases before ${label} build policy`, () => {
        const f = fixture();
        try {
            if (patterns !== undefined) {
                const config = 'garda-agent-orchestrator/live/config/paths.json';
                f.write(config, JSON.stringify({ untracked_build_output_regexes: patterns }));
                runGit(f.root, ['add', config]);
                runGit(f.root, ['commit', '-m', 'configure build policy']);
            }
            f.write('.git/info/exclude', 'src/explicit.ts\n');
            f.write('src/explicit.ts');
            f.write('target/generated.ts');
            f.write('generated/output.ts');
            f.write('target/tracked.ts');
            const explicitUntrackedPaths = [
                '.\\target\\generated.ts', './src/../target//generated.ts',
                'generated\\output.ts', 'src\\explicit.ts', 'target\\tracked.ts'
            ];
            assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths }).effectiveChangedFiles, expected);
        } finally { f.clean(); }
    });
}
