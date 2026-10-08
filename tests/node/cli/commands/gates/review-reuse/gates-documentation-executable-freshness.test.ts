import { describe, it, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import {
    assert, fs, path, createTempRepo, getReviewsRoot, initializeGitRepo,
    loadPostPreflightRulePack, loadTaskEntryRulePack, runEnterTaskMode,
    runGit, seedInitAnswers, seedTaskQueue,
    getWorkspaceSnapshot
} from './gates-review-reuse-fixtures';
import { writeBalancedProfilesConfig, writeBudgetOutputFilters } from '../../gate-test-helpers';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import {
    runBuildReviewContextCommand, runClassifyChangeCommand,
    runCompileGateCommand, runFullSuiteValidationCommand,
    runHandshakeDiagnosticsCommand, runShellSmokePreflightCommand,
    runRestartCoherentCycleCommand
} from '../../../../../../src/cli/commands/gates';
import { resolveNextStep } from '../../../../../../src/gates/next-step/next-step';
import {
    buildDomainScopeFingerprints, getReviewLaneScopeSha256, normalizeDomainScopeFingerprints
} from '../../../../../../src/gates/scope/domain-scope-fingerprints';
import {
    buildCompileEvidenceDocsOnlyExtensionReadinessFromEvidence
} from '../../../../../../src/gates/scope/docs-only-delta-readiness';

const SOURCE_ROOT = process.cwd();
type Operation = 'add' | 'modify' | 'remove' | 'rename';

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function readRecord(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function fileHash(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function exerciseFreshness(
    t: TestContext, changedPath: string, operation: Operation, staged: boolean
) {
    const repoRoot = createTempRepo(t);
    const taskId = 'T-documentation-freshness';
    const reviewsRoot = getReviewsRoot(repoRoot);
    seedTaskQueue(repoRoot, taskId, 'TODO', 'balanced');
    seedInitAnswers(repoRoot);
    writeBalancedProfilesConfig(repoRoot);
    const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
    fs.cpSync(path.join(SOURCE_ROOT, 'template', 'skills', 'code-review'),
        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'code-review'),
        { recursive: true });
    const config = buildDefaultWorkflowConfig();
    config.compile_gate.command = 'node --check src/app.js';
    config.full_suite_validation.enabled = true;
    config.full_suite_validation.command = 'node --test tests/freshness.test.cjs';
    config.full_suite_validation.placement = 'after_compile_before_reviews';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.project_memory_maintenance.enabled = false;
    config.optional_quality_checks.enabled = false;
    writeFile(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json', JSON.stringify(config));
    writeFile(repoRoot, '.gitignore', 'garda-agent-orchestrator/runtime/\nTASK.md\n');
    writeFile(repoRoot, 'VERSION', fs.readFileSync(path.join(SOURCE_ROOT, 'VERSION'), 'utf8'));
    writeFile(repoRoot, '.agents/workflows/start-task.md',
        fs.readFileSync(path.join(SOURCE_ROOT, '.agents', 'workflows', 'start-task.md'), 'utf8'));
    // Shell smoke invokes the actual built Garda CLI for its read-only version probe.
    writeFile(repoRoot, 'garda-agent-orchestrator/bin/garda.js', [
        "if (process.argv.length !== 3 || process.argv[2] !== '--version') throw new Error('Read-only fixture launcher');",
        `require(${JSON.stringify(path.join(SOURCE_ROOT, '.node-build', 'src', 'cli', 'main.js'))})`
            + `.runCliMainWithHandling(process.argv.slice(2), ${JSON.stringify(SOURCE_ROOT)});`
    ].join('\n') + '\n');
    writeFile(repoRoot, 'src/app.js', 'const value = 1;\n');
    writeFile(repoRoot, 'tests/freshness.test.cjs',
        "require('node:test')('fixture', () => require('node:assert/strict').ok(true));\n");
    const originalContent = changedPath.endsWith('.md') ? '# Usage\n'
        : changedPath.endsWith('.json') ? '{"version":1}\n' : 'const worker = 1;\n';
    if (operation !== 'add') writeFile(repoRoot, changedPath, originalContent);
    initializeGitRepo(repoRoot);
    assert.equal(runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Documentation executable freshness fixture' }).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    assert.equal(runHandshakeDiagnosticsCommand({ repoRoot, taskId }).exitCode, 0);
    assert.equal(runShellSmokePreflightCommand({ repoRoot, taskId }).exitCode, 0);
    writeFile(repoRoot, 'src/app.js', 'const value = 2;\n');
    if (staged) runGit(repoRoot, ['add', '--', 'src/app.js']);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const classify = () => runClassifyChangeCommand({
        repoRoot, taskId, taskIntent: 'Documentation executable freshness fixture',
        outputPath: preflightPath, useStaged: staged, includeUntracked: true, emitMetrics: false
    });
    classify();
    const beforePreflight = readRecord(preflightPath);
    const fingerprints = (preflight: Record<string, unknown>) => {
        const domains = normalizeDomainScopeFingerprints(
            (preflight.metrics as Record<string, unknown>).domain_scope_fingerprints);
        assert.ok(domains, 'Native preflight must produce the domain fingerprints being tested.');
        return domains;
    };
    const beforeDomains = fingerprints(beforePreflight);
    assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false).exitCode, 0);
    const compileOptions = { repoRoot, taskId, preflightPath, outputFiltersPath, emitMetrics: false };
    const contextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const contextOptions = { repoRoot, reviewType: 'code', depth: 2, preflightPath, outputPath: contextPath };
    const previousCwd = process.cwd();
    try {
        process.chdir(repoRoot);
        assert.equal((await runCompileGateCommand(compileOptions)).exitCode, 0);
        assert.equal((await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath })).exitCode, 0);
        const originalCompile = readRecord(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
        const originalSuite = readRecord(path.join(reviewsRoot, `${taskId}-full-suite-validation.json`));
        await runBuildReviewContextCommand(contextOptions);
        const originalContextHash = fileHash(contextPath);
        let effectivePath = changedPath;
        if (operation === 'add' || operation === 'modify') {
            writeFile(repoRoot, changedPath, changedPath.endsWith('.md') ? '# Usage changed\n'
                : changedPath.endsWith('.json') ? '{"version":2}\n' : 'const worker = 2;\n');
        } else if (operation === 'remove') {
            fs.unlinkSync(path.join(repoRoot, changedPath));
        } else {
            effectivePath = changedPath.replace(/([^/]+)$/, 'renamed-$1');
            fs.renameSync(path.join(repoRoot, changedPath), path.join(repoRoot, effectivePath));
        }
        if (staged) runGit(repoRoot, ['add', '-A']);
        if (changedPath.endsWith('.md')) {
            const current = getWorkspaceSnapshot(repoRoot, beforeDomains.detection_source,
                beforeDomains.include_untracked, []);
            const currentDomains = buildDomainScopeFingerprints({ repoRoot,
                detectionSource: current.detection_source, includeUntracked: current.include_untracked,
                changedFiles: current.changed_files });
            assert.deepEqual(currentDomains.domains.docs.changed_files, ['README.md']);
            assert.equal(currentDomains.domains.implementation.scope_sha256, beforeDomains.domains.implementation.scope_sha256);
            assert.equal(getReviewLaneScopeSha256('code', currentDomains), getReviewLaneScopeSha256('code', beforeDomains));
            assert.equal(buildCompileEvidenceDocsOnlyExtensionReadinessFromEvidence(repoRoot, originalCompile,
                { ...beforePreflight, ...current })?.ready, true);
            const compileHash = fileHash(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
            await runBuildReviewContextCommand(contextOptions);
            assert.equal(fileHash(path.join(reviewsRoot, `${taskId}-compile-gate.json`)), compileHash);
            assert.equal((await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath })).exitCode, 0);
            return { compileReuseAccepted: true, suiteReuseAccepted: true };
        }
        const beforeRefresh = resolveNextStep({ repoRoot, taskId });
        assert.equal(beforeRefresh.next_gate, 'classify-change', beforeRefresh.reason);
        assert.equal(fileHash(contextPath), originalContextHash, 'Navigation must require fresh evidence before replacing the earlier context.');
        const rejectedCompile = await runCompileGateCommand(compileOptions);
        assert.notEqual(rejectedCompile.exitCode, 0);
        assert.ok(rejectedCompile.outputLines.some((line) => line.includes('Preflight scope drift detected')));
        classify();
        const currentPreflight = readRecord(preflightPath);
        const currentDomains = fingerprints(currentPreflight);
        const domain = changedPath.endsWith('.test.ts') ? 'test'
            : changedPath.endsWith('.json') ? 'config' : 'implementation';
        assert.ok(currentDomains.domains[domain].changed_files.includes(operation === 'remove' ? changedPath : effectivePath));
        assert.notEqual(currentDomains.domains[domain].scope_sha256, beforeDomains.domains[domain].scope_sha256);
        const lane = domain === 'test' ? 'test' : 'code';
        assert.notEqual(getReviewLaneScopeSha256(lane, currentDomains), getReviewLaneScopeSha256(lane, beforeDomains));
        const extension = buildCompileEvidenceDocsOnlyExtensionReadinessFromEvidence(repoRoot, originalCompile, currentPreflight);
        assert.equal(extension, null, 'Executable/test/config deltas cannot extend old compile evidence as documentation.');
        const rejectedSuite = await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath });
        assert.notEqual(rejectedSuite.exitCode, 0);
        assert.match(rejectedSuite.outputText, /(?:current compile|compile-gate)/i);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false).exitCode, 0);
        assert.equal(resolveNextStep({ repoRoot, taskId }).next_gate, 'restart-coherent-cycle');
        assert.equal((await runRestartCoherentCycleCommand({
            repoRoot, taskId, preflightPath, taskIntent: 'Documentation executable freshness fixture',
            outputFiltersPath, operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
        })).exitCode, 0);
        const afterCompile = resolveNextStep({ repoRoot, taskId });
        assert.equal(afterCompile.next_gate, 'full-suite-validation', afterCompile.reason);
        assert.equal((await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath })).exitCode, 0);
        const currentSuite = readRecord(path.join(reviewsRoot, `${taskId}-full-suite-validation.json`));
        const currentBinding = currentSuite.cycle_binding as Record<string, unknown>;
        const originalBinding = originalSuite.cycle_binding as Record<string, unknown>;
        assert.notEqual(currentBinding.preflight_sha256, originalBinding.preflight_sha256);
        await runBuildReviewContextCommand(contextOptions);
        assert.notEqual(fileHash(contextPath), originalContextHash);
        return { compileReuseAccepted: rejectedCompile.exitCode === 0, suiteReuseAccepted: rejectedSuite.exitCode === 0 };
    } finally {
        process.chdir(previousCwd);
    }
}

describe('native documentation executable evidence freshness', () => {
    it('rejects stale compile and full-suite evidence for docs/worker.js', async (t) => {
        const result = await exerciseFreshness(t, 'docs/worker.js', 'add', false);
        assert.equal(result.compileReuseAccepted, false);
        assert.equal(result.suiteReuseAccepted, false);
    });

    for (const changedPath of ['docs/worker.js', 'README.js', 'docs/worker.sh', 'docs/worker.test.ts']) {
        for (const operation of ['add', 'modify', 'remove', 'rename'] as const) {
            for (const staged of [false, true]) {
                if (changedPath === 'docs/worker.js' && operation === 'add' && !staged) continue;
                it(`${staged ? 'staged' : 'unstaged'} ${operation} of ${changedPath} requires new native evidence`, async (t) => {
                    const result = await exerciseFreshness(t, changedPath, operation, staged);
                    assert.equal(result.compileReuseAccepted, false);
                    assert.equal(result.suiteReuseAccepted, false);
                });
            }
        }
    }

    for (const changedPath of ['src/other.js', 'package.json']) {
        it(`retains the source/config negative control for ${changedPath}`, async (t) => {
            const result = await exerciseFreshness(t, changedPath, 'add', false);
            assert.equal(result.compileReuseAccepted, false);
            assert.equal(result.suiteReuseAccepted, false);
        });
    }

    for (const staged of [false, true]) {
        it(`retains genuine README-only compile/review reuse in ${staged ? 'staged' : 'unstaged'} scope`, async (t) => {
            const result = await exerciseFreshness(t, 'README.md', 'add', staged);
            assert.equal(result.compileReuseAccepted, true);
            assert.equal(result.suiteReuseAccepted, true);
        });
    }
});
