import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildCoherentCycleRestartCommand,
    buildCompletionGateSuccessAfterCommand,
    buildReviewCycleRestartCommand,
    formatCompletionGateResult
} from '../../../../src/gates/completion/completion-reporting';

function writeTaskMode(repoRoot: string, taskId: string, payload: Record<string, unknown> = {}): string {
    const taskModePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-mode.json`);
    fs.mkdirSync(path.dirname(taskModePath), { recursive: true });
    fs.writeFileSync(taskModePath, JSON.stringify({
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        orchestrator_work: true,
        workflow_config_work: true,
        ...payload
    }, null, 2) + '\n', 'utf8');
    return taskModePath;
}

describe('gates/completion-reporting', () => {
    for (const detectionSource of ['git_staged_only', 'git_staged_plus_untracked']) {
        it(`preserves ${detectionSource} isolation in both restart commands`, () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-staged-'));
            try {
                const preflightPath = path.join(repoRoot, 'preflight.json');
                fs.writeFileSync(preflightPath, JSON.stringify({ detection_source: detectionSource, changed_files: ['src/app.ts'] }));
                const commands = [
                    buildCoherentCycleRestartCommand(repoRoot, 'T-123', preflightPath, null, null, null),
                    buildReviewCycleRestartCommand(repoRoot, 'T-123', preflightPath, null, null, null)
                ];
                for (const command of commands) {
                    assert.match(command, /--use-staged(?:\s|$)/u);
                    assert.doesNotMatch(command, /--changed-file/u, 'explicit paths override and erase staged selection');
                }
                const explicit = buildCoherentCycleRestartCommand(repoRoot, 'T-123', preflightPath, null, null, null, { changedFiles: ['src/explicit.ts'] });
                assert.match(explicit, /--changed-file 'src\/explicit.ts'/u);
                assert.doesNotMatch(explicit, /--use-staged/u, 'an intentional explicit scope override retains its existing contract');
            } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
        });
    }

    it('carries and PowerShell-quotes the current task intent in coherent-cycle restart guidance', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-completion-restart-intent-'));
        try {
            const command = buildCoherentCycleRestartCommand(
                repoRoot,
                'T-123',
                'preflight.json',
                null,
                null,
                null,
                { taskIntent: "Preserve the task's current review triggers" }
            );

            assert.ok(command.includes("--task-intent 'Preserve the task''s current review triggers'"), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('carries attributed workflow-config scope in coherent-cycle restart guidance', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-completion-restart-scope-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-123-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/app.ts'],
                triggers: {
                    changed_workflow_config_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'garda-agent-orchestrator/live/config/workflow-config.json': 'a'.repeat(64)
                    }
                }
            }, null, 2) + '\n', 'utf8');
            const taskModePath = writeTaskMode(repoRoot, 'T-123');

            const command = buildCoherentCycleRestartCommand(
                repoRoot,
                'T-123',
                preflightPath,
                taskModePath,
                null,
                null
            );

            assert.match(command, /gate restart-coherent-cycle/);
            assert.ok(command.includes("--changed-file 'garda-agent-orchestrator/live/config/workflow-config.json'"), command);
            assert.ok(command.includes("--changed-file 'src/app.ts'"), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('omits attributed workflow-config scope in coherent-cycle restart guidance without workflow-config authorization', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-completion-restart-omit-config-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-123-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: [
                    'src/app.ts',
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ],
                triggers: {
                    changed_workflow_config_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'garda-agent-orchestrator/live/config/workflow-config.json': 'a'.repeat(64)
                    }
                }
            }, null, 2) + '\n', 'utf8');
            const taskModePath = writeTaskMode(repoRoot, 'T-123', { workflow_config_work: false });

            const command = buildCoherentCycleRestartCommand(
                repoRoot,
                'T-123',
                preflightPath,
                taskModePath,
                null,
                null
            );

            assert.match(command, /gate restart-coherent-cycle/);
            assert.ok(command.includes("--changed-file 'src/app.ts'"), command);
            assert.ok(!command.includes('garda-agent-orchestrator/live/config/workflow-config.json'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('carries ordinary changed-file scope in coherent-cycle restart guidance when no workflow-config paths exist', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-completion-restart-ordinary-scope-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-123-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/app.ts'],
                triggers: {}
            }, null, 2) + '\n', 'utf8');

            const command = buildCoherentCycleRestartCommand(
                repoRoot,
                'T-123',
                preflightPath,
                null,
                null,
                null
            );

            assert.match(command, /gate restart-coherent-cycle/);
            assert.ok(command.includes("--changed-file 'src/app.ts'"), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('omits attributed workflow-config scope in review-cycle restart guidance without workflow-config authorization', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-completion-review-restart-omit-config-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-123-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: [
                    'src/app.ts',
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ],
                triggers: {
                    changed_workflow_config_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'garda-agent-orchestrator/live/config/workflow-config.json': 'a'.repeat(64)
                    }
                }
            }, null, 2) + '\n', 'utf8');
            const taskModePath = writeTaskMode(repoRoot, 'T-123', { workflow_config_work: false });

            const command = buildReviewCycleRestartCommand(
                repoRoot,
                'T-123',
                preflightPath,
                taskModePath,
                null,
                null
            );

            assert.match(command, /gate restart-review-cycle/);
            assert.ok(command.includes("--changed-file 'src/app.ts'"), command);
            assert.ok(!command.includes('garda-agent-orchestrator/live/config/workflow-config.json'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('renders review-cycle restart guidance with a non-valid impact-analysis placeholder', () => {
        const command = buildReviewCycleRestartCommand(
            'D:/repo',
            'T-123',
            'garda-agent-orchestrator/runtime/reviews/T-123-preflight.json',
            null,
            null,
            null
        );

        assert.match(command, /gate restart-review-cycle/);
        assert.match(command, /--impact-analysis/);
        assert.match(command, /<replace with main-agent remediation impact analysis>/);
        assert.doesNotMatch(command, /reviewer finding; intended fix; affected files\/contracts/);
    });

    it('renders completion pass guidance back to next-step and final closeout', () => {
        const output = formatCompletionGateResult({
            status: 'PASSED',
            outcome: 'PASS',
            task_id: 'T-645',
            repo_root: process.cwd()
        });

        assert.match(output, /COMPLETION_GATE_PASSED/);
        assert.match(output, /AfterCommand: rerun node bin\/garda\.js next-step "T-645" --repo-root "\."/);
        assert.doesNotMatch(output, /task-audit-summary command/);
        assert.match(output, /mandatory final report/);
        assert.match(output, /asking for commit permission/);
    });

    it('does not render final-closeout success guidance for failed completion gate output', () => {
        const output = formatCompletionGateResult({
            status: 'FAILED',
            outcome: 'FAIL',
            task_id: 'T-645',
            repo_root: process.cwd(),
            violations: ['review gate missing']
        });

        assert.match(output, /COMPLETION_GATE_FAILED/);
        assert.doesNotMatch(output, /AfterCommand: rerun/);
        assert.doesNotMatch(output, /mandatory final report/);
    });

    it('builds the completion success after-command with the source checkout navigator', () => {
        const command = buildCompletionGateSuccessAfterCommand(process.cwd(), 'T-645');

        assert.match(command, /^AfterCommand: rerun node bin\/garda\.js next-step "T-645" --repo-root "\."/);
        assert.doesNotMatch(command, /task-audit-summary/);
        assert.match(command, /mandatory final report/);
    });
});
