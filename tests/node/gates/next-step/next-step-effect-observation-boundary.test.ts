import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInvocationReadObservationActive } from '../../../../src/core/invocation-read-observation';
import type { NextStepEffectDefinition } from '../../../../src/gates/next-step/next-step-effects';
import type { SplitRequiredWipCaptureResult, SplitRequiredWipManifest } from '../../../../src/gates/split-required/split-required-wip-contracts';
import { ALL_REVIEW_FLAGS, eventsRoot, makeTempRepo, reviewsRoot, seedStartedTask, TASK_ID, writeJson, writePreflight } from './next-step-review-cycle-fixtures';
import { buildStrictDecompositionDecisionArtifact, executeNextStepEffects, inspectNextStep } from './next-step-test-support';

function git(repoRoot: string, args: string[]): string {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function installOpaqueFilter(repoRoot: string): string {
    const scriptPath = path.join(repoRoot, '.git', 'opaque-filter.cjs');
    const logPath = path.join(repoRoot, '.git', 'opaque-filter.log');
    fs.writeFileSync(scriptPath, [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const { randomUUID } = require('node:crypto');",
        "const kind = process.argv[2];",
        "fs.appendFileSync(path.join(__dirname, 'opaque-filter.log'), kind + '\\n');",
        "const canonical = fs.readFileSync(0, 'utf8').split(/\\r?\\n/u)[0] + '\\n';",
        "process.stdout.write(kind === 'clean' ? canonical : canonical + '// opaque ' + randomUUID() + '\\n');"
    ].join('\n'));
    const quote = (value: string): string => '"' + value.replace(/\\/gu, '/').replace(/"/gu, '\\"') + '"';
    const command = quote(process.execPath) + ' ' + quote(scriptPath);
    git(repoRoot, ['config', 'filter.opaque.clean', command + ' clean']);
    git(repoRoot, ['config', 'filter.opaque.smudge', command + ' smudge']);
    git(repoRoot, ['config', 'filter.opaque.required', 'true']);
    fs.writeFileSync(path.join(repoRoot, '.gitattributes'), 'src/app.ts filter=opaque\n');
    git(repoRoot, ['add', '.gitattributes']);
    git(repoRoot, ['commit', '--quiet', '-m', 'configure native opaque filter']);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n// original opaque input\n');
    fs.writeFileSync(logPath, '');
    return logPath;
}

function filterCalls(logPath: string): string[] {
    return fs.readFileSync(logPath, 'utf8').split(/\r?\n/u).filter(Boolean);
}

function effectPlanSha(result: ReturnType<typeof inspectNextStep>): string {
    assert.equal(result.next_gate, 'next-step-effect', result.reason);
    const sha = (result.commands[0]?.command || '').match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1];
    assert.ok(sha, result.reason);
    return sha;
}

function prepareFixture(): { repoRoot: string; linkedQueue: string; logPath: string } {
    const repoRoot = makeTempRepo();
    const children = [TASK_ID + '-1', TASK_ID + '-2'];
    const linkedQueue = [
        '# TASK.md', '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| ' + TASK_ID + ' | TODO | P1 | workflow/strict-decomposition | Split parent work | gpt-5.4 | 2026-05-03 | strict | Child tasks: ' + children.join(' and ') + '. |',
        '| ' + children[0] + ' | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-03 | strict | Parse the bounded child contract. Child of ' + TASK_ID + '. |',
        '| ' + children[1] + ' | TODO | P1 | workflow/validation | Validate routing boundary | gpt-5.4 | 2026-05-03 | strict | Validate the independent routing contract. Child of ' + TASK_ID + '. |', ''
    ].join('\n');
    const childlessQueue = linkedQueue.split('\n').filter(line => !children.some(child => line.startsWith('| ' + child + ' |')))
        .map(line => line.startsWith('| ' + TASK_ID + ' |') ? line.replace(/Child tasks:[^|]*/u, 'Awaiting child work packages. ') : line).join('\n');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), childlessQueue);
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/runtime/\n');
    seedStartedTask(repoRoot, TASK_ID);
    writeJson(path.join(reviewsRoot(repoRoot), TASK_ID + '-strict-decomposition-decision.json'), buildStrictDecompositionDecisionArtifact({
        taskId: TASK_ID, decision: 'split-required', taskSummary: 'Seeded next-step task',
        reason: 'The parent work is split into two independently executable child packages.',
        scopeRisk: 'The parent has active implementation WIP that must be suspended before child routing.',
        expectedReviewTypes: ['code'], atomicityConstraints: ['Suspend the parent before entering either child.'],
        proposedChildTaskIds: children,
        workPackageContract: { schema_version: 1, finding_obligations: [], work_packages: children.map((child, index) => ({
            task_id: child, profile: 'strict', root_cause_area: 'root-cause-' + (index + 1),
            objective: 'Implement child package ' + (index + 1) + '.',
            scope_obligations: ['Preserve child scope ' + (index + 1) + '.'],
            validation_contract: ['Validate child package ' + (index + 1) + '.'],
            finding_obligation_ids: [], required_review_types: ['code']
        })) }
    }));
    git(repoRoot, ['init', '--quiet']);
    git(repoRoot, ['config', 'user.name', 'Garda Test']);
    git(repoRoot, ['config', 'user.email', 'garda-test@example.invalid']);
    git(repoRoot, ['config', 'core.autocrlf', 'false']);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'fixture baseline']);
    const logPath = installOpaqueFilter(repoRoot);
    writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { changedFiles: ['src/app.ts'] });
    fs.writeFileSync(logPath, '');
    return { repoRoot, linkedQueue, logPath };
}

test('real next-step effects keep live WIP checks and run nondeterministic smudge once outside the inspection observation', () => {
    const { repoRoot, linkedQueue, logPath } = prepareFixture();
    const taskPath = path.join(repoRoot, 'TASK.md'), sourcePath = path.join(repoRoot, 'src', 'app.ts');
    const eventPath = path.join(eventsRoot(repoRoot), TASK_ID + '.jsonl');
    const taskBefore = fs.readFileSync(taskPath), sourceBefore = fs.readFileSync(sourcePath), eventsBefore = fs.readFileSync(eventPath);
    const wipRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'wip', TASK_ID);
    const effectModule = require('../../../../src/gates/next-step/next-step-effects') as typeof import('../../../../src/gates/next-step/next-step-effects');
    const originalPlanner = effectModule.createNextStepEffectPlanner, originalExecutor = effectModule.createNextStepEffectExecutor;
    let previewCount = 0;
    const executed: Array<{ kind: string; result: unknown; filters: string[] }> = [];
    effectModule.createNextStepEffectPlanner = () => {
        const controller = originalPlanner();
        return { ...controller, run<T>(definition: NextStepEffectDefinition<T>): T {
            assert.equal(isInvocationReadObservationActive(), true, 'Read-only inspection must use its invocation observation.');
            previewCount += 1;
            return controller.run(definition);
        } };
    };
    effectModule.createNextStepEffectExecutor = expected => {
        const controller = originalExecutor(expected);
        return { ...controller, run<T>(definition: NextStepEffectDefinition<T>): T {
            return controller.run({ ...definition, execute: () => {
                assert.equal(isInvocationReadObservationActive(), false, 'Actual effect execution must retain its original live checks.');
                const before = filterCalls(logPath).length;
                const result = definition.execute();
                executed.push({ kind: definition.kind, result, filters: filterCalls(logPath).slice(before) });
                return result;
            } });
        } };
    };
    try {
        const inspection = inspectNextStep({ taskId: TASK_ID, repoRoot });
        const plan = effectPlanSha(inspection);
        assert.match(inspection.reason, /Capture and suspend/);
        assert.equal(previewCount, 1);
        assert.equal(executed.length, 0);
        assert.deepEqual(fs.readFileSync(taskPath), taskBefore);
        assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
        assert.deepEqual(fs.readFileSync(eventPath), eventsBefore);
        assert.equal(fs.existsSync(wipRoot), false);
        assert.equal(filterCalls(logPath).filter(kind => kind === 'smudge').length, 0);

        const captured = executeNextStepEffects({ taskId: TASK_ID, repoRoot }, plan);
        assert.equal(captured.status, 'BLOCKED', captured.reason);
        assert.equal(captured.next_gate, 'strict-decomposition-split-routing');
        assert.match(captured.reason, /missing linked proposed child tasks/);
        assert.equal(previewCount, 2, 'Execution must reinspect the authenticated effect plan.');
        assert.equal(executed.length, 1);
        assert.equal(executed[0].kind, 'suspend-strict-decomposition-wip');
        const capture = executed[0].result as SplitRequiredWipCaptureResult;
        assert.equal(capture.status, 'CAPTURED', capture.violations.join('\n'));
        assert.deepEqual(capture.violations, []);
        assert.ok(capture.manifest_path);
        const manifest = JSON.parse(fs.readFileSync(capture.manifest_path, 'utf8')) as SplitRequiredWipManifest;
        assert.equal(manifest.status, 'suspended');
        assert.deepEqual(manifest.tracked_files.map(entry => entry.path), ['src/app.ts']);
        assert.equal(manifest.tracked_files[0].worktree_sha256, createHash('sha256').update(sourceBefore).digest('hex'));
        assert.equal(executed[0].filters.filter(kind => kind === 'smudge').length, 1);
        assert.ok(executed[0].filters.includes('clean'));
        assert.equal(filterCalls(logPath).filter(kind => kind === 'smudge').length, 1);
        const suspendedBytes = fs.readFileSync(sourcePath);
        assert.match(suspendedBytes.toString(), /^export const value = 1;\n\/\/ opaque [0-9a-f-]{36}\n$/u);
        assert.deepEqual(fs.readFileSync(taskPath), taskBefore);
        assert.equal(git(repoRoot, ['status', '--short', '--', 'src/app.ts']).trim(), '');
        assert.equal(git(repoRoot, ['hash-object', '--path=src/app.ts', 'src/app.ts']).trim(), git(repoRoot, ['rev-parse', 'HEAD:src/app.ts']).trim());
        assert.match(fs.readFileSync(eventPath, 'utf8'), /"event_type":"SPLIT_REQUIRED_WIP_CAPTURED"/);

        fs.writeFileSync(taskPath, linkedQueue);
        const manifestBeforeTransition = fs.readFileSync(capture.manifest_path);
        const transition = inspectNextStep({ taskId: TASK_ID, repoRoot });
        const transitioned = executeNextStepEffects({ taskId: TASK_ID, repoRoot }, effectPlanSha(transition));
        assert.equal(transitioned.status, 'DECOMPOSED', transitioned.reason);
        assert.equal(transitioned.next_gate, 'child-task');
        assert.ok(fs.readFileSync(taskPath, 'utf8').includes('| ' + TASK_ID + ' | 🟪 DECOMPOSED |'));
        assert.deepEqual(fs.readFileSync(capture.manifest_path), manifestBeforeTransition);
        assert.deepEqual(fs.readFileSync(sourcePath), suspendedBytes);
        assert.equal(git(repoRoot, ['status', '--short', '--', 'src/app.ts']).trim(), '');
        assert.equal(filterCalls(logPath).filter(kind => kind === 'smudge').length, 1);
        assert.match(fs.readFileSync(eventPath, 'utf8'), /"event_type":"STRICT_DECOMPOSITION_SPLIT_ROUTED"/);
    } finally {
        effectModule.createNextStepEffectPlanner = originalPlanner;
        effectModule.createNextStepEffectExecutor = originalExecutor;
    }
});
