import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    buildOrchestratorWorkRestartCommand,
    withNextStepCommandWorkspaceReadSnapshot
} from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';

describe('gates/next-step lifecycle command builders', () => {
    it('retains Git failure fallback within an invocation and retries in the next invocation', (context) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-command-read-failure-'));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const childProcess = require('node:child_process') as typeof import('node:child_process');
        const original = childProcess.execFileSync;
        let failed = true;
        let reads = 0;
        context.mock.method(childProcess, 'execFileSync', (file: string, args: string[], options: unknown) => {
            if (file !== 'git' || (!args.includes('--name-only') && !args.includes('--others'))) {
                return original(file, args, options as never);
            }
            reads++;
            if (failed) throw new Error('unavailable Git');
            return 'src/app.ts\n';
        });
        const build = () => buildOrchestratorWorkRestartCommand(root, 'node bin/garda.js', 'T-123', {
            planned_changed_files: ['src'], task_summary: 'Fallback test'
        }, [], false);
        const fallback = withNextStepCommandWorkspaceReadSnapshot(() => [build(), build()]);
        assert.equal(fallback[0], fallback[1]);
        assert.match(fallback[0], /--planned-changed-file "src"/u);
        assert.equal(reads, 2);
        failed = false;
        const recovered = withNextStepCommandWorkspaceReadSnapshot(build);
        assert.match(recovered, /--planned-changed-file "src\/app.ts"/u);
        assert.equal(reads, 4);
    });

    it('shares command workspace reads only within one invocation and repository', () => {
        const roots = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'garda-command-snapshot-')));
        const childProcess = require('node:child_process') as typeof import('node:child_process');
        const original = childProcess.execFileSync;
        const commands: string[][] = [];
        try {
            for (const root of roots) {
                execFileSync('git', ['init', root], { stdio: 'ignore' });
                fs.mkdirSync(path.join(root, 'src'));
                fs.writeFileSync(path.join(root, 'src', 'first.ts'), 'export {};\n');
                execFileSync('git', ['-C', root, 'add', '.']);
                execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed'], { stdio: 'ignore' });
                fs.appendFileSync(path.join(root, 'src', 'first.ts'), '// changed\n');
            }
            childProcess.execFileSync = ((file: string, args: string[], options: unknown) => {
                if (file === 'git') commands.push(args);
                return original(file, args, options as never);
            }) as typeof original;
            const build = (root: string) => buildOrchestratorWorkRestartCommand(root, 'node bin/garda.js', 'T-123', {
                task_summary: 'Snapshot test', planned_changed_files: ['src']
            }, [], false);
            withNextStepCommandWorkspaceReadSnapshot(() => {
                const first = build(roots[0]);
                assert.match(first, /--planned-changed-file "src\/first.ts"/u);
                assert.equal(build(roots[0]), first);
                build(roots[1]);
                build(roots[1]);
            });
            assert.equal(commands.filter((args) => args.includes('--name-only')).length, 2);
            assert.equal(commands.filter((args) => args.includes('--others')).length, 2);
            fs.writeFileSync(path.join(roots[0], 'src', 'second.ts'), 'export {};\n');
            withNextStepCommandWorkspaceReadSnapshot(() => {
                assert.match(build(roots[0]), /--planned-changed-file "src\/second.ts"/u);
            });
            assert.equal(commands.filter((args) => args.includes('--others')).length, 3);
            assert.throws(() => withNextStepCommandWorkspaceReadSnapshot(() => {
                build(roots[0]);
                throw new Error('abort');
            }), /abort/u);
            build(roots[0]);
            assert.equal(commands.filter((args) => args.includes('--others')).length, 5);
        } finally {
            childProcess.execFileSync = original;
            for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('omits workflow-config planned files from protected task-mode restart commands without workflow-config authorization', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-mode-restart-omit-config-'));
        try {
            const command = buildOrchestratorWorkRestartCommand(
                repoRoot,
                'node bin/garda.js',
                'T-123',
                {
                    task_id: 'T-123',
                    entry_mode: 'EXPLICIT_TASK_EXECUTION',
                    requested_depth: 2,
                    task_summary: 'Repair protected restart scope',
                    provider: 'Codex',
                    planned_changed_files: [
                        'src/app.ts',
                        'garda-agent-orchestrator/live/config/workflow-config.json'
                    ]
                },
                [],
                false
            );

            assert.ok(command.includes('--orchestrator-work'), command);
            assert.ok(command.includes('--upgrade-existing-task-mode'), command);
            assert.ok(!command.includes('--workflow-config-work'), command);
            assert.ok(command.includes('--planned-changed-file "src/app.ts"'), command);
            assert.ok(!command.includes('garda-agent-orchestrator/live/config/workflow-config.json'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves workflow-config planned files from protected task-mode restart commands with workflow-config authorization', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-mode-restart-keep-config-'));
        try {
            const command = buildOrchestratorWorkRestartCommand(
                repoRoot,
                'node bin/garda.js',
                'T-123',
                {
                    task_id: 'T-123',
                    entry_mode: 'EXPLICIT_TASK_EXECUTION',
                    requested_depth: 2,
                    task_summary: 'Repair protected restart scope',
                    provider: 'Codex',
                    planned_changed_files: [
                        'src/app.ts',
                        'garda-agent-orchestrator/live/config/workflow-config.json'
                    ]
                },
                [],
                true
            );

            assert.ok(command.includes('--orchestrator-work'), command);
            assert.ok(command.includes('--workflow-config-work'), command);
            assert.ok(command.includes('--upgrade-existing-task-mode'), command);
            assert.ok(command.includes('--planned-changed-file "src/app.ts"'), command);
            assert.ok(command.includes('--planned-changed-file "garda-agent-orchestrator/live/config/workflow-config.json"'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
