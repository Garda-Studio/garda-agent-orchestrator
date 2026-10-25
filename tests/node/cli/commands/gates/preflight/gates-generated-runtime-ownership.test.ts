import * as compileGate from '../../../../../../src/gates/compile/compile-gate';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    createTempRepo, initializeGitRepo, loadPostPreflightRulePack,
    loadTaskEntryRulePack, runEnterTaskMode, runGit, seedInitAnswers,
    seedTaskQueue, writeBudgetOutputFilters
} from '../../gate-test-helpers';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { buildSharedStartTaskWorkflowContent } from '../../../../../../src/materialization/content-builders';
import {
    runClassifyChangeCommand, runCompileGateCommand, runFullSuiteValidationCommand,
    runHandshakeDiagnosticsCommand, runRecordStrictDecompositionDecisionCommand,
    runShellSmokePreflightCommand
} from '../../../../../../src/cli/commands/gates';
import { getWorkspaceSnapshot } from '../../../../../../src/gates/compile/compile-gate';
import { getWorkspaceSnapshotCached } from '../../../../../../src/gates/workspace/workspace-snapshot-cache';
import { resolveNextStep } from '../../../../../../src/gates/next-step/next-step';
import {
    isGeneratedRuntimeControlPlaneArtifactPath, splitGeneratedRuntimeControlPlaneArtifacts
} from '../../../../../../src/gates/shared/generated-runtime-artifacts';

const SOURCE_ROOT = process.cwd();
const CONTENT = Array.from({ length: 300 }, (_, line) => `const value${line} = ${line};`).join('\n') + '\n';
type GitState = 'tracked' | 'untracked' | 'staged' | 'rename';

function writeFile(repoRoot: string, relativePath: string, content: string | Buffer): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function createFixture(t: TestContext, prefix: string, state: GitState) {
    const repoRoot = createTempRepo(t);
    const taskId = 'T-runtime-ownership';
    const original = `${prefix}/runtime/reviews/helper.js`;
    const target = state === 'rename' ? `${prefix}/runtime/reviews/renamed-helper.js` : original;
    seedInitAnswers(repoRoot);
    seedTaskQueue(repoRoot, taskId, 'TODO', 'balanced');
    writeFile(repoRoot, 'garda-agent-orchestrator/live/config/profiles.json',
        fs.readFileSync(path.join(SOURCE_ROOT, 'template/config/profiles.json')));
    const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
    const config = buildDefaultWorkflowConfig();
    config.compile_gate.command = 'node --check src/app.js';
    config.full_suite_validation.enabled = true;
    config.full_suite_validation.command = 'node --test tests/smoke.test.cjs';
    config.full_suite_validation.placement = 'after_compile_before_reviews';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.optional_quality_checks.enabled = false;
    config.project_memory_maintenance.enabled = false;
    writeFile(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json', JSON.stringify(config));
    fs.cpSync(path.join(SOURCE_ROOT, 'template/skills/code-review'),
        path.join(repoRoot, 'garda-agent-orchestrator/live/skills/code-review'), { recursive: true });
    writeFile(repoRoot, '.gitignore', 'garda-agent-orchestrator/runtime/\nTASK.md\n');
    writeFile(repoRoot, 'AGENTS.md', '# Controlled native ownership fixture\n');
    writeFile(repoRoot, 'VERSION', fs.readFileSync(path.join(SOURCE_ROOT, 'VERSION')));
    writeFile(repoRoot, '.agents/workflows/start-task.md', buildSharedStartTaskWorkflowContent('AGENTS.md'));
    writeFile(repoRoot, 'garda-agent-orchestrator/bin/garda.js', [
        "if (process.argv.length !== 3 || process.argv[2] !== '--version') throw new Error('Read-only fixture launcher');",
        `require(${JSON.stringify(path.join(SOURCE_ROOT, '.node-build/src/cli/main.js'))})`
            + `.runCliMainWithHandling(process.argv.slice(2), ${JSON.stringify(SOURCE_ROOT)});`
    ].join('\n') + '\n');
    writeFile(repoRoot, 'src/app.js', 'const app = 1;\n');
    writeFile(repoRoot, 'tests/smoke.test.cjs', "require('node:test')('smoke', () => require('node:assert/strict').ok(true));\n");
    if (state !== 'untracked') writeFile(repoRoot, original, state === 'rename' ? CONTENT : 'const value0 = 0;\n');
    initializeGitRepo(repoRoot);
    assert.equal(runEnterTaskMode({ repoRoot, taskId, provider: 'Codex',
        entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Adjust nested helper logic' }).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    assert.equal(runHandshakeDiagnosticsCommand({ repoRoot, taskId }).exitCode, 0);
    assert.equal(runShellSmokePreflightCommand({ repoRoot, taskId }).exitCode, 0);
    if (state === 'rename') runGit(repoRoot, ['mv', '--', original, target]);
    else writeFile(repoRoot, target, CONTENT);
    if (state === 'staged') runGit(repoRoot, ['add', '--', target]);
    return { repoRoot, taskId, target, outputFiltersPath, explicitFiles: [target] };
}

describe('generated runtime ownership in native Git scope', () => {
    for (const prefix of ['tools', 'src']) {
        for (const state of ['tracked', 'untracked', 'staged', 'rename'] as const) {
            it(`retains ${prefix} ${state} source in automatic and explicit scopes`, async (t) => {
                const fixture = createFixture(t, prefix, state);
                const { repoRoot, taskId, target, explicitFiles, outputFiltersPath } = fixture;
                const source = state === 'staged' || state === 'rename' ? 'git_staged_only' : 'git_auto';
                const snapshot = getWorkspaceSnapshot(repoRoot, source, state === 'untracked', []);
                const explicit = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, explicitFiles);
                const cached = getWorkspaceSnapshotCached(repoRoot, source, state === 'untracked', []);
                assert.ok(snapshot.changed_files.includes(target), JSON.stringify(snapshot.changed_files));
                assert.ok(explicit.changed_files.includes(target), JSON.stringify(explicit.changed_files));
                assert.deepEqual(cached.changed_files, snapshot.changed_files);
                assert.ok(!snapshot.ignored_generated_runtime_files.includes(target));
                if (state === 'rename') {
                    assert.match(String(runGit(repoRoot, ['diff', '--cached', '--name-status', '--find-renames']).stdout), /^R100\s/mu);
                }
                const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews', `${taskId}-preflight.json`);
                for (const options of [
                    { useStaged: source === 'git_staged_only', includeUntracked: state === 'untracked' },
                    { changedFiles: explicitFiles, includeUntracked: true }
                ]) {
                    const result = runClassifyChangeCommand({ repoRoot, taskId,
                        taskIntent: 'Adjust nested helper logic', outputPath: preflightPath, emitMetrics: false, ...options });
                    const preflight = JSON.parse(result.outputText);
                    assert.deepEqual(preflight, JSON.parse(fs.readFileSync(preflightPath, 'utf8')));
                    assert.ok(preflight.changed_files.includes(target));
                    assert.equal(preflight.scope_category, 'code');
                    assert.equal(preflight.required_reviews.code, true);
                    assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false).exitCode, 0);
                    assert.ok(resolveNextStep({ repoRoot, taskId }).review.required_reviews.includes('code'));
                }
                if (prefix === 'tools' && state === 'tracked') {
                    assert.equal(runRecordStrictDecompositionDecisionCommand({
                        repoRoot, taskId, taskProfile: 'balanced', decision: 'atomic',
                        taskSummary: 'Adjust nested helper logic',
                        reason: 'One changed helper file; validate the same ownership invariant through native consumers.',
                        scopeRisk: 'Nested runtime-like user path must remain in review scope.',
                        expectedReviewTypes: ['code', 'test'],
                        atomicityConstraints: ['One source file, no expanded scope or review waiver.']
                    }).exitCode, 0);
                    const priorCwd = process.cwd();
                    try {
                        process.chdir(repoRoot);
                        assert.equal((await runCompileGateCommand({ repoRoot, taskId, preflightPath,
                            outputFiltersPath, emitMetrics: false })).exitCode, 0);
                        assert.equal((await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath })).exitCode, 0);
                        const navigation = resolveNextStep({ repoRoot, taskId });
                        assert.equal(navigation.next_gate, 'build-review-context', navigation.reason);
                        assert.equal(navigation.review.next_review_type, 'code');
                    } finally {
                        process.chdir(priorCwd);
                    }
                }
            });
        }
    }

    it('rejects generated ownership for nested namespace lookalikes', () => {
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('tools/runtime/reviews/helper.js'), false);
        for (const prefix of ['tools', 'scripts', 'vendor', 'operations']) {
            for (const suffix of ['reviews/helper.js', 'cache/helper.js', 'locks/owner.js', 'task-events/helper.js']) {
                assert.equal(isGeneratedRuntimeControlPlaneArtifactPath(`${prefix}/runtime/${suffix}`), false);
            }
        }
    });

    it('rejects foreign runtime namespace claims and normalizes Windows separators', () => {
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('Z:/missing/root/runtime/task-events/all-tasks.jsonl'), false);
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('mnt/wsl/projects/missing/runtime/reviews/helper.js'), false);
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('tools\\runtime\\reviews\\helper.js'), false);
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('garda-agent-orchestrator\\runtime\\reviews\\receipt.json'), true);
    });

    it('rejects generated ownership when dot segments escape the receipt namespace', () => {
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('runtime/reviews/../../tools/helper.js'), false);
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('garda-agent-orchestrator/runtime/reviews/../src/helper.js'), false);
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('garda-agent-orchestrator/runtime/reviews/../../../tools/helper.js'), false);
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('./runtime/reviews/receipt.json'), true);
        assert.equal(isGeneratedRuntimeControlPlaneArtifactPath('garda-agent-orchestrator/runtime/cache/../reviews/receipt.json'), true);
    });

    it('preserves owned receipt log lock cache exclusions and runtime source modules', () => {
        for (const prefix of ['', 'garda-agent-orchestrator/']) {
            for (const artifact of ['reviews/receipt.json', 'task-events/task.jsonl', 'reports/report.html',
                'plans/task.md', 'cache/state.json', 'locks/owner.json', '.reviews-index.lock/owner.json',
                '.runtime-mutation-generation/state.json', '.runtime-mutation-generation.anchor.json', 'metrics.jsonl']) {
                assert.equal(isGeneratedRuntimeControlPlaneArtifactPath(`${prefix}runtime/${artifact}`), true, artifact);
            }
            assert.equal(isGeneratedRuntimeControlPlaneArtifactPath(`${prefix}runtime/src/helper.js`), false);
            assert.equal(isGeneratedRuntimeControlPlaneArtifactPath(`${prefix}runtime/src/runtime/reviews/helper.js`), false);
        }
        assert.deepEqual(splitGeneratedRuntimeControlPlaneArtifacts([
            'dist/src/cli/main.js', 'dist/publish-runtime-manifest.json'
        ], { isSourceCheckout: true }).reviewableFiles, ['dist/src/cli/main.js']);
    });
});


describe('G5 explicit build-output request binding', () => {
    for (const state of ['untracked', 'tracked', 'staged'] as const) {
        it(`classify-change preserves binding for ${state} dist paths and reports exclusions`, t => {
            const { repoRoot, taskId, target } = createFixture(t, 'dist', state);
            writeFile(repoRoot, 'src/app.js', 'const app = 2;\n');
            const result = JSON.parse(runClassifyChangeCommand({ repoRoot, taskId,
                taskIntent: 'Adjust nested helper logic', changedFiles: ['src/app.js', target], includeUntracked: true }).outputText);
            const excluded = state === 'untracked' ? [target] : [];
            assert.deepEqual(result.triggers.ignored_build_output_files, excluded);
            assert.equal(result.metrics.ignored_build_output_files_count, excluded.length);
            assert.ok(!result.triggers.ignored_generated_runtime_files.includes(target));
            assert.equal(result.changed_files.includes(target), state !== 'untracked');
            if (state === 'untracked') assert.match(result.workspace_hygiene_warnings.join(' '), /Excluded build output/);
            const cached = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, ['src/app.js', target]);
            assert.deepEqual('ignored_build_output_files' in cached ? cached.ignored_build_output_files : undefined, excluded);
        });
    }
    for (const mutation of ['remove', 'add', 'replace'] as const) {
        it(`classify-change rejects a snapshot whose excluded request path was ${mutation}d`, t => {
            const { repoRoot, taskId, target } = createFixture(t, 'dist', 'untracked');
            writeFile(repoRoot, 'src/app.js', 'const app = 2;\n');
            const nativeSnapshot = compileGate.getWorkspaceSnapshot;
            t.mock.method(compileGate, 'getWorkspaceSnapshot', (...args: Parameters<typeof nativeSnapshot>) => {
                if (args[1] === 'explicit_changed_files') {
                    args[3] = mutation === 'remove' ? ['src/app.js']
                        : mutation === 'add' ? ['src/app.js', target, 'dist/extra.js']
                        : ['src/app.js', 'dist/replaced.js'];
                }
                return nativeSnapshot(...args);
            });
            assert.throws(() => runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Adjust nested helper logic',
                changedFiles: ['src/app.js', target], includeUntracked: true }), /request parameter binding is inconsistent/);
        });
    }
});
