import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../../../src/core/workflow-config';
import { handleWorkflow } from '../../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../../src/cli/commands/gates';
import { runRecipeCommand } from '../../../../../src/cli/commands/gate-flows/command-run/recipe-command-flow';
import { readValidationResult } from '../../../../../src/gates/project-validation/evidence';
import { buildQualityChecklistAnswersTemplate } from '../../../../../src/gates/quality-checklist';
import { runQualityChecklistCommand } from '../../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask,
    runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../../cli/commands/gates/preflight/gates-preflight-fixtures';
import { removeTempRepoWithRetry } from '../../../cli/commands/gate-test-repo-bootstrap';

export function activationFixture(layout: { prefix: string; packageCwd: boolean }, resultFormat: 'tap' | 'opaque' = 'tap') {
    const repoRoot = createTempRepo(), taskId = 'T-qualification';
    const bundle = path.join(repoRoot, 'garda-agent-orchestrator');
    const configPath = path.join(bundle, 'live/config/workflow-config.json');
    const relative = (name: string) => layout.prefix ? `${layout.prefix}/${name}` : name;
    const source = relative('Product.impl'), target = relative('Check.any'), driver = relative('validation-tool');
    const selector = '\u043f\u0440\u0438\u0431\u0430\u0432\u043b\u0435\u043d\u0438\u0435\u4e00';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig()));
    for (const name of ['profiles.json', 'review-capabilities.json'])
        fs.copyFileSync(path.resolve('template/config', name), path.join(path.dirname(configPath), name));
    fs.unlinkSync(path.join(repoRoot, 'src/app.ts'));
    fs.rmdirSync(path.join(repoRoot, 'src'));
    fs.mkdirSync(path.dirname(path.join(repoRoot, source)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, source), JSON.stringify({ value: 40 }));
    fs.writeFileSync(path.join(repoRoot, target), '42');
    fs.writeFileSync(path.join(repoRoot, driver), [
        "const fs = require('node:fs'), path = require('node:path');",
        "const actual = JSON.parse(fs.readFileSync(path.join(__dirname, 'Product.impl'), 'utf8')).value + 1;",
        "const expected = Number(fs.readFileSync(path.join(__dirname, 'Check.any'), 'utf8'));",
        "process.stdout.write('TAP version 13\\n1..1\\n' + (actual === expected ? 'ok' : 'not ok') + ' 1 - ' + process.argv[2] + '\\n');",
        'process.exitCode = actual === expected ? 0 : 1;'
    ].join('\n'));
    const declaration = { schema_version: 1, recipes: [{ id: 'declared', purpose: 'test', executable: process.execPath,
        argv: [layout.packageCwd ? 'validation-tool' : driver, { target: 'proof' }],
        cwd: layout.packageCwd ? layout.prefix : '.', environment: {},
        inputs: [{ path: source, role: 'source' }, { path: target, role: 'test' }, { path: driver, role: 'helper' }],
        targets: [{ id: 'proof', source: target, selector }], required_capabilities: [], result_format: resultFormat,
        timeout_ms: 5000, max_attempts: 1, max_output_bytes: 2048, max_input_bytes: 65536 }] };
    const declarationPath = path.join(repoRoot, 'recipes.json');
    fs.writeFileSync(declarationPath, JSON.stringify(declaration));
    seedInitAnswers(repoRoot);
    seedTaskQueue(repoRoot, taskId, 'TODO', 'balanced', 'Required reviews: code, test.', 'Declared recipe qualification');
    initializeGitRepo(repoRoot);
    // Operator inputs belong to this isolated fixture, never to the main workspace's authority.
    const admit = () => handleWorkflow(['set', '--target-root', repoRoot, '--project-validation-contract', 'recipes.json',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()],
    { name: 'garda-agent-orchestrator', version: '1.0.0' });
    admit();
    runEnterTaskMode({ repoRoot, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Declared recipe qualification', provider: 'Codex' });
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId); runShellSmokeForTask(repoRoot, taskId);
    fs.writeFileSync(path.join(repoRoot, source), JSON.stringify({ value: 41 }));
    const preflightPath = path.join(bundle, `runtime/reviews/${taskId}-preflight.json`);
    runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Declared recipe qualification',
        outputPath: preflightPath, changedFiles: [source], emitMetrics: false });
    return { repoRoot, taskId, bundle, configPath, declarationPath, declaration, source, target, selector, preflightPath, admit,
        cleanup: () => removeTempRepoWithRetry(repoRoot),
        execute: async () => {
            const response = await runRecipeCommand({ repoRoot, taskId, recipeId: 'declared' });
            const attemptId = response.outputLines.find(line => line.startsWith('AttemptId: '))!.slice('AttemptId: '.length);
            return { response, ...readValidationResult({ repoRoot, taskId, attemptId }) };
        },
        publishQuality: () => {
            const answers = buildQualityChecklistAnswersTemplate({ repoRoot, taskId, preflightPath }).answers
                .map(answer => ({ ...answer, status: 'PASS', answer: 'Checked the isolated declared input and execution fixture.' }));
            return runQualityChecklistCommand({ repoRoot, taskId, preflightPath, answersJson: JSON.stringify(answers), emitMetrics: false });
        }
    };
}
