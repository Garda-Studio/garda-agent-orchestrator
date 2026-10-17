import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    createTempRepo, initializeGitRepo, loadPostPreflightRulePack,
    loadTaskEntryRulePack, runEnterTaskMode, seedInitAnswers, seedTaskQueue,
    writeBudgetOutputFilters
} from '../../gate-test-helpers';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { buildSharedStartTaskWorkflowContent } from '../../../../../../src/materialization/content-builders';
import {
    runClassifyChangeCommand, runCompileGateCommand, runFullSuiteValidationCommand,
    runHandshakeDiagnosticsCommand, runShellSmokePreflightCommand
} from '../../../../../../src/cli/commands/gates';
import { resolveNextStep } from '../../../../../../src/gates/next-step/next-step';

const SOURCE_ROOT = process.cwd();
type Profile = 'fast' | 'balanced' | 'strict';
interface Preflight {
    mode: string;
    scope_category: string;
    required_reviews: Record<string, boolean>;
    effective_review_snapshot: {
        required_reviews: Record<string, boolean>;
        inputs: Record<string, unknown>;
        lanes: Array<{ id: string; selection: string; trigger_reasons: string[] }>;
    };
}

function writeFile(repoRoot: string, relativePath: string, content: string | Buffer): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function classifyFixture(t: TestContext, profile: Profile, changes: Record<string, string>) {
    const repoRoot = createTempRepo(t);
    const taskId = 'T-code-floor';
    seedInitAnswers(repoRoot);
    seedTaskQueue(repoRoot, taskId, 'TODO', profile);
    const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
    writeFile(repoRoot, 'garda-agent-orchestrator/live/config/profiles.json',
        fs.readFileSync(path.join(SOURCE_ROOT, 'template/config/profiles.json')));
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
    writeFile(repoRoot, 'AGENTS.md', '# Controlled native floor fixture\n');
    writeFile(repoRoot, 'VERSION', fs.readFileSync(path.join(SOURCE_ROOT, 'VERSION')));
    writeFile(repoRoot, '.agents/workflows/start-task.md',
        buildSharedStartTaskWorkflowContent('AGENTS.md'));
    writeFile(repoRoot, 'garda-agent-orchestrator/bin/garda.js', [
        "if (process.argv.length !== 3 || process.argv[2] !== '--version') throw new Error('Read-only fixture launcher');",
        `require(${JSON.stringify(path.join(SOURCE_ROOT, '.node-build/src/cli/main.js'))})`
            + `.runCliMainWithHandling(process.argv.slice(2), ${JSON.stringify(SOURCE_ROOT)});`
    ].join('\n') + '\n');
    writeFile(repoRoot, 'src/app.js', 'const value = 1;\n');
    writeFile(repoRoot, 'tests/smoke.test.cjs',
        "require('node:test')('smoke', () => require('node:assert/strict').ok(true));\n");
    initializeGitRepo(repoRoot);
    assert.equal(runEnterTaskMode({ repoRoot, taskId, provider: 'Codex',
        entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: profile === 'fast' ? 1 : profile === 'strict' ? 3 : 2,
        taskSummary: 'Adjust widget processing' }).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    assert.equal(runHandshakeDiagnosticsCommand({ repoRoot, taskId }).exitCode, 0);
    assert.equal(runShellSmokePreflightCommand({ repoRoot, taskId }).exitCode, 0);
    for (const [filePath, content] of Object.entries(changes)) writeFile(repoRoot, filePath, content);
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews', `${taskId}-preflight.json`);
    const result = runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Adjust widget processing',
        includeUntracked: true, outputPath: preflightPath, emitMetrics: false });
    const preflight = JSON.parse(result.outputText) as Preflight;
    assert.deepEqual(preflight, JSON.parse(fs.readFileSync(preflightPath, 'utf8')));
    assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false).exitCode, 0);
    assert.deepEqual(preflight.required_reviews, preflight.effective_review_snapshot.required_reviews);
    return { repoRoot, taskId, preflightPath, outputFiltersPath, preflight };
}

const sourceContent = Array.from({ length: 300 }, (_, line) => `widget line ${line}`).join('\n') + '\n';

function assertRequiredFloor(fixture: ReturnType<typeof classifyFixture>): void {
    const { preflight, repoRoot, taskId } = fixture;
    assert.equal(preflight.mode, 'FULL_PATH');
    assert.equal(preflight.required_reviews.code, true);
    assert.equal(preflight.effective_review_snapshot.inputs.code_review_safety_floor, true);
    const codeLane = preflight.effective_review_snapshot.lanes.find(lane => lane.id === 'code');
    assert.equal(codeLane?.selection, 'required');
    assert.ok(codeLane?.trigger_reasons.includes('code_review_safety_floor'));
    assert.ok(resolveNextStep({ repoRoot, taskId }).review.required_reviews.includes('code'));
}

async function assertNativeCodeRoute(fixture: ReturnType<typeof classifyFixture>): Promise<void> {
    const previousCwd = process.cwd();
    const { repoRoot, taskId, preflightPath, outputFiltersPath } = fixture;
    try {
        process.chdir(repoRoot);
        assert.equal((await runCompileGateCommand({ repoRoot, taskId, preflightPath,
            outputFiltersPath, emitMetrics: false })).exitCode, 0);
        assert.equal((await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath })).exitCode, 0);
        const navigation = resolveNextStep({ repoRoot, taskId });
        assert.equal(navigation.next_gate, 'build-review-context', navigation.reason);
        assert.equal(navigation.review.next_review_type, 'code');
    } finally {
        process.chdir(previousCwd);
    }
}

describe('native FULL_PATH code-review safety floor', () => {
    for (const changedPath of ['scripts/widget.py', 'src/widget.cpp', 'src/widget.vue']) {
        for (const profile of ['fast', 'balanced', 'strict'] as const) {
            it(`${profile} retains code review for 300 lines in ${changedPath}`, async (t) => {
                const fixture = classifyFixture(t, profile, { [changedPath]: sourceContent });
                assert.equal(fixture.preflight.scope_category, 'code');
                assertRequiredFloor(fixture);
                if (profile === 'fast') {
                    for (const lane of ['db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency']) {
                        assert.equal(fixture.preflight.required_reviews[lane], false, lane);
                    }
                    await assertNativeCodeRoute(fixture);
                }
            });
        }
    }

    it('adding genuine README does not remove the source floor', async (t) => {
        const fixture = classifyFixture(t, 'fast', { 'scripts/widget.py': sourceContent, 'README.md': '# Usage\n' });
        assert.equal(fixture.preflight.scope_category, 'mixed');
        assertRequiredFloor(fixture);
        await assertNativeCodeRoute(fixture);
    });

    it('preserves intentional FAST_PATH without adding the source floor', (t) => {
        const fixture = classifyFixture(t, 'fast', { 'frontend/widget.ts': 'const widget = 1;\n' });
        assert.equal(fixture.preflight.mode, 'FAST_PATH');
        assert.equal(fixture.preflight.required_reviews.code, false);
        assert.equal(fixture.preflight.effective_review_snapshot.inputs.code_review_safety_floor, undefined);
        assert.ok(!resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId }).review.required_reviews.includes('code'));
    });

    for (const [label, changes, category] of [
        ['documentation', { 'README.md': '# Usage\n' }, 'docs-only'],
        ['tests only', { 'tests/widget.test.js': 'const widget = 1;\n' }, 'test-only'],
        ['zero diff', {}, 'empty']
    ] as const) {
        it(`preserves ${label} without adding code review`, (t) => {
            const fixture = classifyFixture(t, 'fast', changes);
            assert.equal(fixture.preflight.scope_category, category);
            assert.equal(fixture.preflight.required_reviews.code, false);
            assert.equal(fixture.preflight.effective_review_snapshot.inputs.code_review_safety_floor, undefined);
        });
    }
});
