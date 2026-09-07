import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

function readPackageJson(): Record<string, unknown> {
    const packageJsonPath = path.join(getRepoRoot(), 'package.json');
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
}

function getScripts(): Record<string, string> {
    const pkg = readPackageJson();
    assert.equal(typeof pkg.scripts, 'object');
    assert.notEqual(pkg.scripts, null);
    return pkg.scripts as Record<string, string>;
}

function getDevDependencies(): Record<string, string> {
    const pkg = readPackageJson();
    assert.equal(typeof pkg.devDependencies, 'object');
    assert.notEqual(pkg.devDependencies, null);
    return pkg.devDependencies as Record<string, string>;
}

function getC8Config(): Record<string, unknown> {
    const pkg = readPackageJson();
    assert.equal(typeof pkg.c8, 'object');
    assert.notEqual(pkg.c8, null);
    return pkg.c8 as Record<string, unknown>;
}

function readTextRepoFile(relativePath: string): string {
    return fs.readFileSync(path.join(getRepoRoot(), relativePath), 'utf8');
}

function getWorkflowJobBlock(raw: string, jobId: string): string {
    const lines = raw.split(/\r?\n/);
    const jobStart = lines.findIndex((line) => line === `  ${jobId}:`);
    assert.notEqual(jobStart, -1, `Workflow must define job '${jobId}'`);
    const nextJob = lines.findIndex((line, index) => index > jobStart && /^  [A-Za-z0-9_-]+:\s*$/u.test(line));
    return lines.slice(jobStart, nextJob === -1 ? undefined : nextJob).join('\n');
}

function extractYamlListAfterKey(block: string, key: string): string[] {
    const lines = block.split(/\r?\n/);
    const keyPattern = new RegExp(`^(\\s*)${key}:\\s*$`, 'u');
    const keyIndex = lines.findIndex((line) => keyPattern.test(line));
    assert.notEqual(keyIndex, -1, `Expected YAML key '${key}'`);
    const keyIndent = keyPattern.exec(lines[keyIndex])![1].length;
    const values: string[] = [];
    for (const line of lines.slice(keyIndex + 1)) {
        const indent = line.match(/^\s*/u)![0].length;
        if (line.trim() && indent <= keyIndent) {
            break;
        }
        const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
        if (item) {
            values.push(item[1].replace(/^['"]|['"]$/gu, ''));
        }
    }
    return values;
}

function assertJobMatrixValues(raw: string, jobId: string, key: string, expectedValues: string[]): string {
    const jobBlock = getWorkflowJobBlock(raw, jobId);
    assert.deepEqual(extractYamlListAfterKey(jobBlock, key), expectedValues);
    return jobBlock;
}

test('package quality scripts expose lint, coverage, audit, and composed release validation', () => {
    const scripts = getScripts();

    assert.match(scripts.lint, /^eslint /);
    assert.match(scripts.lint, /"src\/\*\*\/\*\.ts"/);
    assert.match(scripts.lint, /"tests\/node\/\*\*\/\*\.ts"/);
    assert.match(scripts.lint, /"scripts\/node-foundation\/\*\*\/\*\.ts"/);

    assert.equal(scripts.coverage, 'c8 npm test');
    assert.equal(scripts['coverage:fast'], 'c8 npm run test:fast');

    assert.equal(scripts['audit:prod'], 'npm audit --omit=dev');
    assert.equal(scripts['audit:all'], 'npm audit');
    assert.equal(
        scripts['typecheck:unused'],
        'tsc -p tsconfig.node-foundation.json --noEmit --pretty false --noUnusedLocals --noUnusedParameters'
    );
    assert.equal(scripts.quality, 'npm run typecheck && npm run typecheck:unused && npm run lint && npm run coverage && npm run audit:prod');
    assert.equal(scripts['quality:fast'], 'npm run typecheck && npm run typecheck:unused && npm run lint && npm run coverage:fast && npm run audit:prod');
    assert.equal(scripts['validate:clean-worktree'], 'node scripts/node-foundation/build-scripts.cjs validate-release.js clean-worktree');
    assert.equal(scripts['validate:embedded-bundle-parity'], 'node scripts/node-foundation/build-scripts.cjs validate-release.js embedded-bundle-parity');
    assert.equal(scripts['validate:release-readiness'], 'node scripts/node-foundation/build-scripts.cjs validate-release.js release-readiness');
    assert.equal(
        scripts['validate:release'],
        'npm run validate:clean-worktree && npm run validate:version-parity && npm run build && npm run validate:embedded-bundle-parity && npm run quality && npm run test:packaging && npm run validate:clean-worktree'
    );
    assert.equal(
        scripts['validate:release:fast'],
        'npm run validate:clean-worktree && npm run validate:version-parity && npm run build && npm run validate:embedded-bundle-parity && npm run quality:fast && npm run test:packaging && npm run validate:clean-worktree'
    );
    assert.equal(
        scripts['test:release-smoke'],
        'node scripts/node-foundation/build-scripts.cjs test.js tests/node/core/task-ids.test.ts tests/node/gate-runtime/task-events-append.test.ts tests/node/gates/next-step/next-step-startup-routing.test.ts tests/node/validators/status.test.ts tests/node/validators/why-blocked.test.ts tests/node/validators/doctor-formatting.test.ts'
    );
    assert.equal(
        scripts['release:preflight'],
        'npm run validate:release-readiness && npm run test:release-smoke && npm run validate:release && npm run validate:package-surface'
    );
    assert.equal(scripts['archive:source'], 'node scripts/node-foundation/build-scripts.cjs archive-release.js source');
    assert.equal(scripts['archive:evidence'], 'node scripts/node-foundation/build-scripts.cjs archive-release.js evidence');
    assert.match(scripts.prepack, /^npm run validate:clean-worktree && npm run build:publish-runtime/);
    assert.match(scripts.prepack, /&& npm run validate:clean-worktree && node scripts\/package-legacy-entrypoint-compat\.cjs create$/);
});

test('coverage configuration measures maintained source boundaries without generated trees', () => {
    const c8 = getC8Config();

    assert.equal(c8.all, true);
    assert.equal(c8['check-coverage'], true);
    assert.equal(c8.statements, 35);
    assert.equal(c8.branches, 55);
    assert.equal(c8.functions, 35);
    assert.equal(c8.lines, 35);
    assert.deepEqual(c8.reporter, ['text', 'lcov']);
    assert.deepEqual(c8.include, [
        '.node-build/src/**/*.js',
        '.node-build/scripts/node-foundation/**/*.js',
        'src/**/*.ts',
        'scripts/**/*.ts',
        'scripts/**/*.cjs',
        'bin/**/*.js'
    ]);
    assert.deepEqual(c8.exclude, [
        'coverage/**',
        'dist/**',
        '.node-build/tests/**',
        '.scripts-build/**',
        'garda-agent-orchestrator/**',
        'node_modules/**',
        'tests/**'
    ]);
    assert.equal(c8.excludeAfterRemap, true);

    const tsconfigTests = JSON.parse(readTextRepoFile('tsconfig.tests.json')) as { compilerOptions?: Record<string, unknown> };
    assert.equal(tsconfigTests.compilerOptions?.sourceMap, true);
});

test('quality script dependencies and eslint config are present', () => {
    const devDependencies = getDevDependencies();

    for (const packageName of ['@eslint/js', 'eslint', 'typescript-eslint', 'c8']) {
        assert.equal(typeof devDependencies[packageName], 'string', `${packageName} must be a devDependency`);
    }

    const eslintConfigPath = path.join(getRepoRoot(), 'eslint.config.mjs');
    assert.equal(fs.existsSync(eslintConfigPath), true);
});

test('release validation CI covers Windows quality:fast script execution', () => {
    const ciWorkflow = readTextRepoFile('.github/workflows/ci.yml');
    const releaseJob = assertJobMatrixValues(ciWorkflow, 'validate-release', 'node-version', ['22.13.0', '24']);

    assert.match(releaseJob, /name:\s*Release Validation \/ \$\{\{ matrix\.os \}\} \/ Node \$\{\{ matrix\.node-version \}\}/);
    assert.match(releaseJob, /runs-on:\s*\$\{\{ matrix\.os \}\}/);
    assert.deepEqual(extractYamlListAfterKey(releaseJob, 'os'), ['ubuntu-latest', 'windows-latest']);
    assert.match(releaseJob, /run:\s*npm run validate:release:fast/);
    assert.match(releaseJob, /name:\s*Upload lcov coverage/);
    assert.match(releaseJob, /if:\s*always\(\)/);
    assert.match(releaseJob, /uses:\s*actions\/upload-artifact@v7\.0\.1/);
    assert.match(releaseJob, /name:\s*coverage-lcov-\$\{\{ matrix\.os \}\}-node-\$\{\{ matrix\.node-version \}\}/);
    assert.match(releaseJob, /path:\s*coverage\/lcov\.info/);
    assert.match(releaseJob, /if-no-files-found:\s*warn/);
});

test('CI defines focused test shard jobs covering unit, gates, CLI, lifecycle, and bin on supported Node lines', () => {
    const ciWorkflow = readTextRepoFile('.github/workflows/ci.yml');

    const testUnitJob = assertJobMatrixValues(ciWorkflow, 'test-unit', 'node-version', ['22.13.0', '24']);
    assert.match(testUnitJob, /name:\s*Unit Tests \/ Node \$\{\{ matrix\.node-version \}\}/);
    assert.match(testUnitJob, /runs-on:\s*ubuntu-latest/);
    assert.match(testUnitJob, /FORCE_COLOR:\s+'1'/);
    assert.match(testUnitJob, /run:\s*npm run test:unit/);

    const testGatesJob = assertJobMatrixValues(ciWorkflow, 'test-gates', 'node-version', ['22.13.0', '24']);
    assert.match(testGatesJob, /GARDA_NODE_FOUNDATION_TEST_SHARDS:\s*'2'/);
    assert.match(testGatesJob, /run:\s*npm run test:gates/);

    const testCliJob = assertJobMatrixValues(ciWorkflow, 'test-cli', 'node-version', ['22.13.0', '24']);
    assert.match(testCliJob, /GARDA_NODE_FOUNDATION_TEST_SHARDS:\s*'2'/);
    assert.match(testCliJob, /run:\s*npm run test:cli/);

    const testLifecycleJob = assertJobMatrixValues(ciWorkflow, 'test-lifecycle', 'node-version', ['22.13.0', '24']);
    assert.match(testLifecycleJob, /run:\s*npm run test:lifecycle/);

    const testBinJob = assertJobMatrixValues(ciWorkflow, 'test-bin', 'node-version', ['22.13.0', '24']);
    assert.match(testBinJob, /run:\s*npm run test:bin/);
});

test('package.json exposes focused test shard scripts for targeted validation', () => {
    const scripts = getScripts();

    const requiredShards = [
        'test:unit',
        'test:gates',
        'test:cli',
        'test:lifecycle',
        'test:bin',
        'test:packaging',
        'test:sharded',
        'test:full',
        'test:fast'
    ];
    for (const script of requiredShards) {
        assert.equal(typeof scripts[script], 'string', `package.json must define '${script}'`);
        assert.ok(scripts[script].length > 0, `'${script}' must not be empty`);
    }

    // test:packaging must exercise the compiled pack-smoke directly, not via npm test
    assert.match(scripts['test:packaging'], /pack-smoke\.test\.ts/);
    assert.doesNotMatch(scripts.test, /tests\/node\/packaging/);
    assert.doesNotMatch(scripts['test:node-foundation'], /tests\/node\/packaging/);
    assert.match(scripts['test:sharded'], /--garda-shards 2/);
    assert.match(scripts['test:sharded'], /--garda-shard-concurrency 2/);
    assert.doesNotMatch(scripts['test:sharded'], /tests\/node\/packaging/);
    // test:full must rebuild before running to keep it self-contained
    assert.match(scripts['test:full'], /build.js node-foundation/);
    assert.doesNotMatch(scripts['test:full'], /tests\/node\/packaging/);
    assert.doesNotMatch(scripts['test:release-smoke'], /tests\/node\/packaging/);
});

test('package.json exposes diagnostic rerun aliases for heavy logical test domains', () => {
    const scripts = getScripts();

    const requiredDiagnosticAliases = {
        'test:diag:next-step': [
            'tests/node/gates/next-step',
            'tests/node/cli/commands/gates/shared/gates-next-step.test.ts'
        ],
        'test:diag:review-context': [
            'tests/node/gates/review-context',
            'tests/node/gate-runtime/review-context.test.ts',
            'tests/node/cli/commands/gates/review-context'
        ],
        'test:diag:required-reviews': [
            'tests/node/gates/required-reviews',
            'tests/node/cli/commands/gates/required-reviews',
            'tests/node/cli/commands/gates/review-launch',
            'tests/node/cli/commands/gates/review-result',
            'tests/node/cli/commands/gates/review-reuse'
        ],
        'test:diag:preflight': [
            'tests/node/gates/preflight',
            'tests/node/gate-runtime/budget-preflight.test.ts',
            'tests/node/gates/diagnostics/shell-smoke-preflight.test.ts',
            'tests/node/cli/commands/gates/preflight'
        ],
        'test:diag:task-audit': [
            'tests/node/gates/task-audit',
            'tests/node/cli/commands/task-audit-human-format.test.ts'
        ],
        'test:diag:ui-i18n': ['tests/node/reports/ui-i18n.test.ts', 'tests/node/reports/ui-language-packs.test.ts']
    };

    for (const [scriptName, requiredTargets] of Object.entries(requiredDiagnosticAliases)) {
        const command = scripts[scriptName];
        assert.equal(typeof command, 'string', `package.json must define '${scriptName}'`);
        assert.match(command, /^node scripts\/node-foundation\/build-scripts\.cjs test\.js /);
        for (const target of requiredTargets) {
            assert.ok(command.includes(target), `'${scriptName}' must include '${target}'`);
        }
    }

    assert.doesNotMatch(scripts.test, /test:diag:/, 'diagnostic aliases must not change npm test semantics');
    assert.doesNotMatch(scripts['test:full'], /test:diag:/, 'diagnostic aliases must not change test:full semantics');
});
