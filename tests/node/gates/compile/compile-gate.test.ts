import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildScopeContentFingerprint,
    getCompileCommandProfile,
    getCompileCommands,
    getCompileCommandContractViolations,
    getOutputStats,
    getWorkspaceSnapshot,
    extractNewPathFromNumstat
} from '../../../../src/gates/compile/compile-gate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../../src/core/constants';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';

describe('gates/compile-gate', () => {
    describe('getCompileCommandProfile', () => {
        it('detects maven compile', () => {
            const result = getCompileCommandProfile('mvn clean compile');
            assert.equal(result.kind, 'compile');
            assert.equal(result.strategy, 'maven');
            assert.equal(result.label, 'maven');
        });

        it('detects gradle compile', () => {
            const result = getCompileCommandProfile('./gradlew build');
            assert.equal(result.strategy, 'gradle');
            assert.equal(result.label, 'gradle');
        });

        it('detects npm build as node strategy', () => {
            const result = getCompileCommandProfile('npm run build');
            assert.equal(result.strategy, 'node');
            assert.equal(result.label, 'node-build');
        });

        it('detects test commands', () => {
            const result = getCompileCommandProfile('npm run test');
            assert.equal(result.kind, 'test');
            assert.equal(result.label, 'test');
            assert.equal(result.failure_profile, 'test_failure_console');
            assert.equal(result.success_profile, 'test_success_console');
        });

        it('detects pytest as test', () => {
            const result = getCompileCommandProfile('pytest -q tests/');
            assert.equal(result.kind, 'test');
        });

        it('detects eslint as lint', () => {
            const result = getCompileCommandProfile('eslint src/');
            assert.equal(result.kind, 'lint');
            assert.equal(result.failure_profile, 'lint_failure_console');
        });

        it('detects cargo build', () => {
            const result = getCompileCommandProfile('cargo build --release');
            assert.equal(result.strategy, 'cargo');
        });

        it('detects dotnet build', () => {
            const result = getCompileCommandProfile('dotnet build');
            assert.equal(result.strategy, 'dotnet');
        });

        it('detects go build', () => {
            const result = getCompileCommandProfile('go build ./...');
            assert.equal(result.strategy, 'go');
        });

        it('falls back to generic for unknown commands', () => {
            const result = getCompileCommandProfile('make all');
            assert.equal(result.kind, 'compile');
            assert.equal(result.strategy, 'generic');
        });

        it('detects mvn test as test', () => {
            const result = getCompileCommandProfile('mvn test');
            assert.equal(result.kind, 'test');
        });

        it('detects Windows wrapper test commands as test', () => {
            const result = getCompileCommandProfile('.\\gradlew.bat test');
            assert.equal(result.kind, 'test');
        });

        it('detects cargo test as test', () => {
            const result = getCompileCommandProfile('cargo test');
            assert.equal(result.kind, 'test');
        });

        it('detects ruff check as lint', () => {
            const result = getCompileCommandProfile('ruff check src/');
            assert.equal(result.kind, 'lint');
        });

        it('detects tsc --noEmit as lint', () => {
            const result = getCompileCommandProfile('tsc --noEmit');
            assert.equal(result.kind, 'lint');
        });
    });

    describe('getCompileCommands', () => {
        it('extracts commands from markdown section', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '',
                '```bash',
                'npm run build',
                'npm run lint',
                '```',
                '',
                '### Other Section',
                'not a command',
            ].join('\n'), 'utf8');

            const commands = getCompileCommands(filePath);
            assert.deepEqual(commands, ['npm run build', 'npm run lint']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('extracts commands from markdown section with CRLF line endings', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '',
                '```bash',
                'npm run build',
                '```',
                ''
            ].join('\r\n'), 'utf8');

            const commands = getCompileCommands(filePath);

            assert.deepEqual(commands, ['npm run build']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('throws when section is missing', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, '# Other content\nHello\n', 'utf8');

            assert.throws(() => getCompileCommands(filePath), /Section.*not found/);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects unresolved placeholders', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                '<your-command-here>',
                '```',
            ].join('\n'), 'utf8');

            assert.throws(() => getCompileCommands(filePath), /placeholder.*unresolved/i);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects unconfigured sentinel unless explicitly allowed for human-visible contract validation', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                UNCONFIGURED_COMPILE_GATE_COMMAND,
                '```',
            ].join('\n'), 'utf8');

            assert.throws(() => getCompileCommands(filePath), /Compile command is unconfigured/i);
            assert.deepEqual(
                getCompileCommands(filePath, { allowUnconfiguredSentinel: true }),
                [UNCONFIGURED_COMPILE_GATE_COMMAND]
            );
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects full-suite test commands in compile gate section', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                'npm test',
                '```',
            ].join('\n'), 'utf8');

            assert.throws(() => getCompileCommands(filePath), /must not run the full test suite/i);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects commands matching configured full-suite validation command', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                'npm run verify',
                '```',
            ].join('\n'), 'utf8');

            assert.throws(
                () => getCompileCommands(filePath, { fullSuiteCommand: 'npm run verify' }),
                /matches the configured full-suite validation command/i
            );
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('allows approved full-test compile command override with reason', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                'npm test',
                '```',
            ].join('\n'), 'utf8');

            const commands = getCompileCommands(filePath, {
                allowFullTestCompileCommand: true,
                allowFullTestCompileCommandReason: 'operator-approved legacy repository has no separate build command'
            });

            assert.deepEqual(commands, ['npm test']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
    });

    describe('getCompileCommandContractViolations', () => {
        it('flags Maven and Gradle test-bound lifecycle commands', () => {
            assert.ok(getCompileCommandContractViolations('mvn package').some((item) => item.includes('Maven phase')));
            assert.ok(getCompileCommandContractViolations('./gradlew build').some((item) => item.includes("Gradle task 'build'")));
            assert.deepEqual(getCompileCommandContractViolations('./mvnw compile'), []);
            assert.deepEqual(getCompileCommandContractViolations('./gradlew assemble'), []);
            assert.deepEqual(getCompileCommandContractViolations('./gradlew build -x test'), []);
            assert.deepEqual(getCompileCommandContractViolations('./gradlew :app:build --exclude-task :app:test'), []);
            assert.deepEqual(getCompileCommandContractViolations('./gradlew :app:build -x :app:test'), []);
            assert.ok(getCompileCommandContractViolations('./gradlew :app:build --exclude-task :other:test').some((item) => item.includes("Gradle task 'build'")));
            assert.ok(getCompileCommandContractViolations('./gradlew build --exclude-task :app:test').some((item) => item.includes("Gradle task 'build'")));
        });
    });

    describe('getOutputStats', () => {
        it('counts warnings and errors', () => {
            const lines = [
                'Compiling...',
                'WARNING: deprecated API',
                'ERROR: missing module',
                'warning: unused var',
                'Done'
            ];
            const { warningLines, errorLines } = getOutputStats(lines);
            assert.equal(warningLines, 2);
            assert.equal(errorLines, 1);
        });

        it('returns zero for clean output', () => {
            const { warningLines, errorLines } = getOutputStats(['OK', 'Done']);
            assert.equal(warningLines, 0);
            assert.equal(errorLines, 0);
        });
    });

    describe('getWorkspaceSnapshot', () => {
        it('recovers from adversarial absolute and traversal generated-runtime paths as ignored evidence', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-generated-runtime-'));
            const repoRoot = path.join(tempDir, 'repo');
            const appPath = path.join(repoRoot, 'src', 'app.ts');
            const ignoredPaths = [
                '../outside/runtime/reviews/T-983-2-code-review.json',
                '../runtime/reviews/T-983-2-traversal-prefixed.json',
                'Z:/missing/root/runtime/task-events/T-983-2.jsonl'
            ];
            const explicitPaths = [
                '../outside/runtime/reviews/T-983-2-code-review.json',
                'src/../../runtime/reviews/T-983-2-traversal-prefixed.json',
                'Z:/missing/root/runtime/task-events/T-983-2.jsonl'
            ];

            try {
                fs.mkdirSync(path.dirname(appPath), { recursive: true });
                fs.writeFileSync(appPath, 'export const value = 1;\n', 'utf8');
                initGitRepo(repoRoot);
                fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');

                const snapshot = getWorkspaceSnapshot(
                    repoRoot,
                    'explicit_changed_files',
                    false,
                    ['src/app.ts', ...explicitPaths]
                );

                assert.deepEqual(snapshot.authorized_files, ['src/app.ts']);
                assert.deepEqual(snapshot.changed_files, ['src/app.ts']);
                assert.deepEqual(snapshot.ignored_generated_runtime_files, ignoredPaths);
                assert.equal(snapshot.ignored_generated_runtime_files_count, ignoredPaths.length);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('fails explicit snapshots closed when canonical Git classification is unavailable', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-no-git-'));

            try {
                assert.throws(
                    () => getWorkspaceSnapshot(
                        repoRoot,
                        'explicit_changed_files',
                        false,
                        ['Z:/missing/root/runtime/task-events/T-983-2.jsonl']
                    ),
                    /not a git repository|git .* failed/iu
                );
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });

        it('collects changed files when repo root and file paths contain spaces', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const repoRoot = path.join(tempDir, 'repo with spaces');
            const srcDir = path.join(repoRoot, 'src');
            const changedFilePath = path.join(srcDir, 'app with spaces.ts');

            try {
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
                initGitRepo(repoRoot);

                fs.writeFileSync(changedFilePath, 'export const value = 2;\n', 'utf8');

                const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', false, []);
                assert.ok(snapshot.changed_files.includes('src/app with spaces.ts'));
                assert.equal(snapshot.changed_files_count, 1);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('retains untracked binary scope and content bindings without counting binary text lines', (context) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-binary-'));
            context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
            initGitRepo(repoRoot);
            const fixturePath = path.join(repoRoot, 'fixture.tgz');
            fs.writeFileSync(fixturePath, Buffer.from('binary\0payload\nline\n'));
            for (const source of ['git_auto', 'explicit_changed_files']) {
                const snapshot = getWorkspaceSnapshot(repoRoot, source, true, ['fixture.tgz']);
                assert.deepEqual(snapshot.changed_files, ['fixture.tgz']);
                assert.equal(snapshot.changed_lines_total, 0);
                assert.deepEqual(snapshot.changed_file_stats['fixture.tgz'], { additions: 0, deletions: 0, changed_lines: 0 });
                fs.writeFileSync(fixturePath, Buffer.from([0xff, 0x0a, 0x61]));
                const modified = getWorkspaceSnapshot(repoRoot, source, true, ['fixture.tgz']);
                assert.equal(modified.changed_lines_total, 0);
                assert.notEqual(modified.scope_content_sha256, snapshot.scope_content_sha256);
                fs.writeFileSync(fixturePath, Buffer.from('binary\0payload\nline\n'));
            }
        });

        it('ignores generated orchestrator lock directories in workspace scope', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-locks-'));
            const repoRoot = path.join(tempDir, 'repo');
            const srcDir = path.join(repoRoot, 'src');

            try {
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const value = 1;\n', 'utf8');
                initGitRepo(repoRoot);

                fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const value = 2;\n', 'utf8');
                fs.mkdirSync(path.join(repoRoot, '.scripts-build.lock'), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, '.scripts-build.lock', 'owner.json'), '{}\n', 'utf8');
                fs.mkdirSync(path.join(repoRoot, '.node-build.lock'), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, '.node-build.lock', 'owner.json'), '{}\n', 'utf8');

                const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);

                assert.deepEqual(snapshot.changed_files, ['src/app.ts']);
                assert.equal(snapshot.changed_files_count, 1);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('buildScopeContentFingerprint', () => {
        it('keeps staged content stable until the index changes', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-staged-fingerprint-'));
            const trackedPath = path.join(repoRoot, 'src', 'app.ts');
            try {
                fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
                fs.writeFileSync(trackedPath, 'export const value = "baseline";\n', 'utf8');
                initGitRepo(repoRoot);

                fs.writeFileSync(trackedPath, 'export const value = "alpha";\n', 'utf8');
                runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
                const stagedAlpha = buildScopeContentFingerprint(
                    repoRoot,
                    'git_staged_only',
                    ['src/app.ts']
                );

                fs.writeFileSync(trackedPath, 'export const value = "bravo";\n', 'utf8');
                assert.equal(
                    buildScopeContentFingerprint(repoRoot, 'git_staged_only', ['src/app.ts']),
                    stagedAlpha
                );

                runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
                assert.notEqual(
                    buildScopeContentFingerprint(repoRoot, 'git_staged_only', ['src/app.ts']),
                    stagedAlpha
                );
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    });

    describe('extractNewPathFromNumstat', () => {
        it('returns plain path unchanged', () => {
            assert.equal(extractNewPathFromNumstat('src/file.ts'), 'src/file.ts');
        });

        it('extracts new path from simple rename', () => {
            assert.equal(extractNewPathFromNumstat('old.ts => new.ts'), 'new.ts');
        });

        it('extracts new path from brace-style rename', () => {
            assert.equal(extractNewPathFromNumstat('{old => new}/file.ts'), 'new/file.ts');
        });

        it('extracts new path from prefixed brace rename', () => {
            assert.equal(extractNewPathFromNumstat('src/{old-name => new-name}.ts'), 'src/new-name.ts');
        });

        it('handles empty rename target in braces', () => {
            assert.equal(extractNewPathFromNumstat('{old => }/file.ts'), '/file.ts');
        });

        it('handles path with no rename arrow', () => {
            assert.equal(extractNewPathFromNumstat('path/to/file with spaces.ts'), 'path/to/file with spaces.ts');
        });
    });
});
