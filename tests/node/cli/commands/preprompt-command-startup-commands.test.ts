import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';

import { COMMAND_SUMMARY } from '../../../../src/cli/commands/cli-helpers';
import { buildTaskBrief, readJsonArtifactIfExists } from '../../../../src/cli/commands/preprompt/preprompt-task-context';
import { resolveNextStep } from '../../../../src/gates/next-step/next-step';
import { formatTaskBriefText } from '../../../../src/cli/commands/preprompt/preprompt-task-format';
import { projectTaskContinuation } from '../../../../src/cli/commands/preprompt/preprompt-task-commands';
import { resolveNextStep as settleFixtureEffects } from '../../gates/next-step/next-step-test-support';
import {
    TASK_ID as NAVIGATOR_TASK_ID,
    makeTempRepo as makeNavigatorRepo,
    seedStartedTask,
    seedCompletedTaskWithIndependentCodeReview,
    ALL_REVIEW_FLAGS,
    writePreflight as writeNavigatorPreflight,
    seedCompilePass,
    seedReviewGatePass,
    seedDocImpactPass,
    writeFreshReviewContextWithoutRouting,
    writeReviewEvidence
} from '../../gates/next-step/next-step-completion-fixtures';
import { runCliWithCapturedOutput } from './gate-test-helpers';
import {
    createTempRepo,
    seedInitAnswers,
    seedTaskQueue,
    writePreflight
} from './gate-test-helpers';

function snapshotBriefInputs(repoRoot: string): Record<string, string> {
    const files: Record<string, string> = {};
    function visit(directory: string): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === '.git') {
                continue;
            }
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(filePath);
            } else {
                const stat = fs.statSync(filePath);
                files[path.relative(repoRoot, filePath)] = `${stat.mtimeMs}:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
            }
        }
    }
    visit(repoRoot);
    return files;
}

function assertCurrentNavigatorProjection(repoRoot: string): Record<string, unknown> {
    const expected = resolveNextStep({ repoRoot, taskId: NAVIGATOR_TASK_ID });
    const brief = buildTaskBrief(repoRoot, NAVIGATOR_TASK_ID);
    assert.equal((brief.task as Record<string, unknown>).current_stage, expected.next_gate || expected.status.toLowerCase());
    assert.equal(brief.schema_version, 3);
    const continuation = brief.continuation as Record<string, unknown>;
    assert.equal(continuation.status, expected.status);
    assert.equal(continuation.next_gate, expected.next_gate);
    assert.equal(continuation.navigator_command, expected.navigator_command);
    assert.equal(continuation.advisory_only, true);
    assert.equal(continuation.revalidate_before_action, true);
    const action = continuation.action as Record<string, unknown> | null;
    assert.equal(action?.command || null, expected.commands.length === 1 ? expected.commands[0].command : null);
    assert.deepEqual((brief.commands as Record<string, unknown>).post_implementation_commands, []);
    return brief;
}

test('preprompt prevents lifecycle writes while projecting a pending navigator effect', () => {
    const repoRoot = makeNavigatorRepo();
    try {
        seedStartedTask(repoRoot, NAVIGATOR_TASK_ID);
        const before = snapshotBriefInputs(repoRoot);
        assertCurrentNavigatorProjection(repoRoot);
        assert.deepEqual(snapshotBriefInputs(repoRoot), before);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt rejects stale completion PASS after a new task entry', () => {
    const repoRoot = makeNavigatorRepo();
    try {
        seedCompletedTaskWithIndependentCodeReview(repoRoot, NAVIGATOR_TASK_ID);
        seedStartedTask(repoRoot, NAVIGATOR_TASK_ID);
        const before = snapshotBriefInputs(repoRoot);
        const brief = assertCurrentNavigatorProjection(repoRoot);
        assert.notEqual((brief.task as Record<string, unknown>).current_stage, 'completion_passed');
        assert.deepEqual((brief.commands as Record<string, unknown>).startup_commands, []);
        assert.deepEqual(snapshotBriefInputs(repoRoot), before);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt rejects stale compile PASS after source drift', () => {
    const repoRoot = makeNavigatorRepo();
    try {
        seedCompletedTaskWithIndependentCodeReview(repoRoot, NAVIGATOR_TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 999;\n', 'utf8');
        const before = snapshotBriefInputs(repoRoot);
        const brief = assertCurrentNavigatorProjection(repoRoot);
        assert.notEqual((brief.task as Record<string, unknown>).current_stage, 'completion_passed');
        assert.deepEqual(snapshotBriefInputs(repoRoot), before);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt revalidates missing and foreign-task evidence without writing lifecycle files', () => {
    const staleCompletionClaims: boolean[] = [];
    for (const mutation of ['missing', 'foreign-task']) {
        const repoRoot = makeNavigatorRepo();
        try {
            seedCompletedTaskWithIndependentCodeReview(repoRoot, NAVIGATOR_TASK_ID);
            const compilePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${NAVIGATOR_TASK_ID}-compile-gate.json`);
            if (mutation === 'missing') {
                fs.rmSync(compilePath);
            } else {
                const compile = JSON.parse(fs.readFileSync(compilePath, 'utf8'));
                compile.task_id = 'T-FOREIGN';
                fs.writeFileSync(compilePath, JSON.stringify(compile), 'utf8');
            }
            const before = snapshotBriefInputs(repoRoot);
            const brief = assertCurrentNavigatorProjection(repoRoot);
            staleCompletionClaims.push((brief.task as Record<string, unknown>).current_stage === 'completion_passed');
            assert.deepEqual(snapshotBriefInputs(repoRoot), before);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    }
    assert.deepEqual(staleCompletionClaims, [false, false]);
});

test('preprompt resumes at the remaining test review after independently accepted code review', () => {
    const repoRoot = makeNavigatorRepo();
    try {
        seedStartedTask(repoRoot, NAVIGATOR_TASK_ID);
        writeNavigatorPreflight(repoRoot, NAVIGATOR_TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, NAVIGATOR_TASK_ID);
        writeReviewEvidence(repoRoot, NAVIGATOR_TASK_ID, 'code');
        const route = settleFixtureEffects({ repoRoot, taskId: NAVIGATOR_TASK_ID });
        assert.equal(route.next_gate, 'build-review-context', route.reason);
        assert.equal(route.review.next_review_type, 'test');
        const before = snapshotBriefInputs(repoRoot);
        const brief = assertCurrentNavigatorProjection(repoRoot);
        const text = formatTaskBriefText(brief);
        assert.match(text, /NextCommand:.*build-review-context.*--review-type "test"/);
        assert.ok(!text.includes('StartupCommands:'));
        assert.ok(!text.includes('gate compile-gate'));
        assert.deepEqual(snapshotBriefInputs(repoRoot), before);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt completion-only continuation does not replay startup, compile or review actions', () => {
    const repoRoot = makeNavigatorRepo();
    try {
        seedStartedTask(repoRoot, NAVIGATOR_TASK_ID);
        writeNavigatorPreflight(repoRoot, NAVIGATOR_TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, NAVIGATOR_TASK_ID);
        seedReviewGatePass(repoRoot, NAVIGATOR_TASK_ID);
        seedDocImpactPass(repoRoot, NAVIGATOR_TASK_ID);
        const route = settleFixtureEffects({ repoRoot, taskId: NAVIGATOR_TASK_ID });
        assert.equal(route.next_gate, 'completion-gate', route.reason);
        const before = snapshotBriefInputs(repoRoot);
        const brief = assertCurrentNavigatorProjection(repoRoot);
        const text = formatTaskBriefText(brief);
        assert.match(text, /NextCommand:.*gate completion-gate/);
        assert.ok(!text.includes('StartupCommands:'));
        assert.ok(!text.includes('gate compile-gate'));
        assert.ok(!text.includes('build-review-context'));
        assert.deepEqual(snapshotBriefInputs(repoRoot), before);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt prevents startup replay and arbitrary reviewer routing selection', () => {
    const repoRoot = makeNavigatorRepo();
    try {
        seedStartedTask(repoRoot, NAVIGATOR_TASK_ID);
        writeNavigatorPreflight(repoRoot, NAVIGATOR_TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, NAVIGATOR_TASK_ID);
        writeFreshReviewContextWithoutRouting(repoRoot, NAVIGATOR_TASK_ID, 'code');
        const route = settleFixtureEffects({ repoRoot, taskId: NAVIGATOR_TASK_ID });
        assert.equal(route.next_gate, 'record-review-routing', route.reason);
        assert.equal(route.commands.length, 1);
        const before = snapshotBriefInputs(repoRoot);
        const brief = assertCurrentNavigatorProjection(repoRoot);
        const action = (brief.continuation as Record<string, unknown>).action as Record<string, unknown>;
        assert.equal(action.command, route.commands[0].command);
        assert.equal(action.command_selection_required, false);
        assert.deepEqual((brief.commands as Record<string, unknown>).startup_commands, []);
        const alternativeProjection = projectTaskContinuation({
            ...route,
            commands: [...route.commands, { label: 'Alternative', command: 'alternative from navigator' }]
        });
        assert.equal(alternativeProjection.action?.command, null);
        assert.equal(alternativeProjection.action?.command_selection_required, true);
        assert.deepEqual(snapshotBriefInputs(repoRoot), before);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt rejects traversal ids before reading task evidence', () => {
    const repoRoot = makeNavigatorRepo();
    try {
        const before = snapshotBriefInputs(repoRoot);
        assert.throws(() => buildTaskBrief(repoRoot, '../T-NEXT-1'), /task.*id/i);
        assert.deepEqual(snapshotBriefInputs(repoRoot), before);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt advisory JSON reads reject foreign tasks, malformed payloads and oversized artifacts', () => {
    const repoRoot = makeNavigatorRepo();
    try {
        const filePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${NAVIGATOR_TASK_ID}-preflight.json`);
        const matchingPayload = { task_id: NAVIGATOR_TASK_ID };
        const atLimit = JSON.stringify(matchingPayload).padEnd(1024 * 1024, ' ');
        assert.equal(Buffer.byteLength(atLimit, 'utf8'), 1024 * 1024);
        fs.writeFileSync(filePath, atLimit, 'utf8');
        assert.deepEqual(readJsonArtifactIfExists(filePath, { repoRoot, taskId: NAVIGATOR_TASK_ID })?.payload, matchingPayload);
        const oversized = `${atLimit} `;
        assert.equal(Buffer.byteLength(oversized, 'utf8'), 1024 * 1024 + 1);
        assert.deepEqual(JSON.parse(oversized), matchingPayload);
        const payloads = [];
        for (const content of [JSON.stringify({ task_id: 'T-FOREIGN' }), 'null', '[]', '{invalid', oversized]) {
            fs.writeFileSync(filePath, content, 'utf8');
            const before = snapshotBriefInputs(repoRoot);
            payloads.push(readJsonArtifactIfExists(filePath, { repoRoot, taskId: NAVIGATOR_TASK_ID }));
            assert.deepEqual(snapshotBriefInputs(repoRoot), before);
        }
        assert.deepEqual(payloads, [null, null, null, null, null]);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt rejects escaped lifecycle roots without following a directory junction', () => {
    const repoRoot = makeNavigatorRepo();
    const outsideRoot = makeNavigatorRepo();
    try {
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.rmSync(reviewsRoot, { recursive: true });
        fs.symlinkSync(outsideRoot, reviewsRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const outsideBefore = snapshotBriefInputs(outsideRoot);
        assert.throws(() => buildTaskBrief(repoRoot, NAVIGATOR_TASK_ID), /inside repo root|escape/i);
        assert.deepEqual(snapshotBriefInputs(outsideRoot), outsideBefore);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});




test('COMMAND_SUMMARY includes preprompt', () => {
    assert.equal(
        COMMAND_SUMMARY.find((entry) => entry[0] === 'preprompt')?.[1],
        'Read-only task bootstrap context and exact next commands'
    );
});

test('preprompt task --help renders command help', async () => {
    const result = await runCliWithCapturedOutput(['preprompt', 'task', '--help']);
    assert.equal(result.exitCode, 0);
    const output = result.logs.join('\n');
    assert.ok(output.includes('Command: preprompt task'));
    assert.ok(output.includes('--task-id "<task-id>"'));
    assert.ok(output.includes('--json'));
});

test('preprompt rejects incomplete preflight as authority for future command batches', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: [
                'src/cli/commands/preprompt-command.ts',
                'tests/node/cli/commands/preprompt-command.test.ts'
            ]
        });
        assert.ok(fs.existsSync(preflightPath));

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const commands = payload.commands as Record<string, unknown>;
        assert.deepEqual(diagnostics.required_review_types, ['code', 'test']);
        assert.equal(payload.schema_version, 3);
        assert.equal(diagnostics.artifact_presence_is_advisory, true);
        assert.equal(commands.post_implementation_sequence_available, false);
        const postImplementationCommands = commands.post_implementation_commands as string[];
        assert.deepEqual(postImplementationCommands, []);
        const continuation = payload.continuation as Record<string, unknown>;
        assert.equal(continuation.status, 'UNKNOWN');
        assert.equal(continuation.action, null);
        assert.ok((commands.startup_commands as string[]).length <= 1);

        const latestPreflight = diagnostics.latest_preflight as Record<string, unknown>;
        assert.equal(latestPreflight.mode, 'FULL_PATH');
        assert.deepEqual(latestPreflight.changed_files, [
            'src/cli/commands/preprompt-command.ts',
            'tests/node/cli/commands/preprompt-command.test.ts'
        ]);
        assert.equal(latestPreflight.changed_files_truncated, false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task text output prints the current action and revalidation instead of future commands', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: [
                'src/cli/commands/preprompt-command.ts',
                'tests/node/cli/commands/preprompt-command.test.ts'
            ]
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const output = result.logs.join('\n');
        assert.match(output, /NextCommand:/);
        assert.match(output, /RevalidateBeforeAction:.*next-step/);
        assert.ok(!output.includes('PostImplementationCommands:'));
        assert.ok(!output.includes('build-review-context --review-type "test"'));
        assert.ok(!output.includes('gate completion-gate'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt does not replay historical rule-pack paths as startup instructions', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: [
                'src/cli/commands/preprompt-command.ts'
            ]
        });
        const rulePackPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-rule-pack.json`);
        fs.writeFileSync(rulePackPath, JSON.stringify({
            latest_stage: 'POST_PREFLIGHT',
            stages: {
                task_entry: {
                    loaded_rule_files: [
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md'),
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '40-commands.md')
                    ]
                },
                post_preflight: {
                    loaded_rule_files: [
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md'),
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '35-strict-coding-rules.md'),
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '40-commands.md')
                    ]
                }
            }
        }, null, 2), 'utf8');

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const startupCommands = ((payload.commands as Record<string, unknown>).startup_commands as string[]);
        assert.ok(startupCommands.length <= 1);
        assert.ok(!startupCommands.some((line) => line.includes('load-rule-pack')));
        const continuation = payload.continuation as Record<string, unknown>;
        assert.equal(continuation.status, 'UNKNOWN');
        assert.equal(continuation.action, null);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json does not invent --use-staged for an unstaged-only dirty workspace', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Codex');
        childProcess.execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.name', 'Preprompt Tests'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const commands = payload.commands as Record<string, unknown>;
        const startupCommands = commands.startup_commands as string[];
        assert.ok(startupCommands.length <= 1);
        assert.ok(!startupCommands.some((line) => line.includes('gate classify-change') && line.includes('--use-staged')));
        assert.match(
            String(commands.startup_scope_blocker || ''),
            /explicit --changed-file entries|stage only the intended task diff/i
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task text output reports dirty-workspace startup blocker', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Codex');
        childProcess.execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.name', 'Preprompt Tests'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const output = result.logs.join('\n');
        assert.match(output, /GARDA_PREPROMPT_TASK/);
        assert.match(output, /StartupScopeBlocker:/);
        assert.match(output, /explicit --changed-file entries|stage only the intended task diff/i);
        assert.ok(!output.includes('gate classify-change --task-id "T-137" --use-staged'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json preserves staged scope diagnostics without queuing future classification', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Codex');
        childProcess.execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.name', 'Preprompt Tests'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 4;\nconsole.log(a + b);\n', 'utf8');
        childProcess.execFileSync('git', ['add', 'src/app.ts'], { cwd: repoRoot, stdio: 'ignore' });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const commands = payload.commands as Record<string, unknown>;
        const startupCommands = commands.startup_commands as string[];
        assert.ok(startupCommands.length <= 1);
        assert.ok(!startupCommands.some((line) => line.includes('gate classify-change')));
        assert.equal(commands.startup_scope_blocker, null);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json bounds artifact and changed-file lists', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        const changedFiles = Array.from({ length: 20 }, (_, index) => `src/generated/file-${index + 1}.ts`);
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: changedFiles
        });
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        for (let index = 0; index < 15; index += 1) {
            fs.writeFileSync(path.join(reviewsRoot, `${taskId}-artifact-${index + 1}.json`), `artifact-${index + 1}\n`, 'utf8');
        }

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const artifacts = payload.artifacts as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const latestPreflight = diagnostics.latest_preflight as Record<string, unknown>;
        assert.equal((artifacts.review_artifacts as string[]).length, 12);
        assert.equal(artifacts.review_artifacts_total_count, 16);
        assert.equal(artifacts.review_artifacts_truncated, true);
        assert.equal(latestPreflight.changed_files_total_count, 20);
        assert.equal((latestPreflight.changed_files as string[]).length, 12);
        assert.equal(latestPreflight.changed_files_truncated, true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

