import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import { joinOrchestratorPath } from '../../../src/core/orchestrator-paths';
import { withImplementationOwnershipLock } from '../../../src/gates/workspace/active-implementation-ownership';
import { saveTaskPlan, withTaskPlanMutationLock } from '../../../src/core/task-plan-save';
import { readTaskPlan, resolveCanonicalTaskPlanPath, TASK_PLAN_READ_MAX_BYTES } from '../../../src/core/task-plan-read';
import { computeTaskPlanDigest, validateTaskPlan } from '../../../src/schemas/task-plan';
import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { runEnterTaskModeCommand } from '../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { initializeGitRepo, seedInitAnswers } from '../cli/commands/gate-test-seed-helpers';

const TASK_ID = 'T-701';

function workspace(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-plan-save-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'TASK.md'), [
        '# Tasks', '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P2 | planning | Save | unassigned | 2026-09-30 | | [plan] Prepare |`
    ].join('\n'));
    return root;
}

function input(root: string, overrides: Record<string, unknown> = {}): string {
    const file = path.join(root, 'input.json');
    fs.writeFileSync(file, JSON.stringify({
        schema_version: 1, task_id: TASK_ID, status: 'approved', goal: 'Prepare the change',
        scope_files: ['src/widget.ts'], risk_level: 'low', steps: [{ id: 'a', title: 'Implement' }],
        acceptance_criteria: ['Preserve behavior'], verification_expectations: ['Run focused tests'],
        out_of_scope: ['Other modules'], ...overrides
    }));
    return file;
}

function seedEntry(root: string): void {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'widget.ts'), 'export const widget = true;\n');
    const rulesRoot = path.join(root, DEFAULT_BUNDLE_NAME, 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    for (const name of ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md']) {
        fs.writeFileSync(path.join(rulesRoot, name), `# ${name}\n`);
    }
    fs.writeFileSync(path.join(root, '.gitignore'), `${DEFAULT_BUNDLE_NAME}/runtime/\n`);
    seedInitAnswers(root);
    initializeGitRepo(root);
}

function enter(root: string): void {
    const result = runEnterTaskModeCommand({
        repoRoot: root, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Prepare the change', provider: 'Codex',
        planPath: resolveCanonicalTaskPlanPath(root, TASK_ID)
    });
    assert.equal(result.exitCode, 0);
}

if (process.env.GARDA_TASK_PLAN_ENTRY_TEST_ROOT) {
    enter(process.env.GARDA_TASK_PLAN_ENTRY_TEST_ROOT);
    process.exit(0);
}
    test('task-plan save creates and freely replaces a ready plan without starting the task', t => {
        const root = workspace(t);
        const before = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
        const saved = saveTaskPlan(root, TASK_ID, input(root));
        const first = fs.readFileSync(saved, 'utf8');
        const plan = validateTaskPlan(JSON.parse(first));
        assert.equal(plan.plan_sha256, computeTaskPlanDigest(plan));
        assert.equal(readTaskPlan(root, TASK_ID).state, 'ready');
        saveTaskPlan(root, TASK_ID, input(root, { goal: 'Replace freely', plan_sha256: 'old input digest' }));
        assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).goal, 'Replace freely');
        assert.notEqual(fs.readFileSync(saved, 'utf8'), first);
        assert.equal(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), before);
        assert.deepEqual(fs.readdirSync(path.dirname(saved)), [`${TASK_ID}-task-plan.json`]);
        assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(saved)), 'task-events')), false);
    });

    test('task-plan save rejects malformed or foreign input and incomplete ready plans', t => {
        const root = workspace(t);
        const saved = saveTaskPlan(root, TASK_ID, input(root));
        const original = fs.readFileSync(saved, 'utf8');
        assert.throws(() => saveTaskPlan(root, TASK_ID, input(root, { task_id: 'T-FOREIGN' })), /does not match/);
        for (const field of ['acceptance_criteria', 'verification_expectations', 'out_of_scope']) {
            assert.throws(() => saveTaskPlan(root, TASK_ID, input(root, { [field]: [] })), /Ready plans require/);
        }
        const file = input(root);
        fs.writeFileSync(file, '{ invalid');
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), SyntaxError);
        assert.equal(fs.readFileSync(saved, 'utf8'), original);
        saveTaskPlan(root, TASK_ID, input(root, { status: 'draft', acceptance_criteria: [], verification_expectations: [], out_of_scope: [] }));
        assert.equal(readTaskPlan(root, TASK_ID).state, 'draft');
    });

    test('task-plan save refuses terminal tasks, reset histories and corrupt or unknown start evidence', t => {
        const root = workspace(t);
        const file = input(root);
        const queuePath = path.join(root, 'TASK.md');
        const queue = fs.readFileSync(queuePath, 'utf8');
        fs.writeFileSync(queuePath, queue.replace('| TODO |', '| DONE |'));
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /existing TODO/);
        fs.writeFileSync(queuePath, queue);
        const saved = saveTaskPlan(root, TASK_ID, file);
        const original = fs.readFileSync(saved, 'utf8');
        const mode = path.join(path.dirname(saved), `${TASK_ID}-task-mode.json`);
        fs.writeFileSync(mode, '{ corrupt');
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /start evidence/);
        fs.unlinkSync(mode);
        const bundle = path.dirname(path.dirname(path.dirname(saved)));
        appendTaskEvent(bundle, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Started', {}, { passThru: true });
        appendTaskEvent(bundle, TASK_ID, 'TASK_RESET', 'PASS', 'Reset to TODO', {}, { passThru: true });
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /lifecycle history/);
        const timeline = path.join(bundle, 'runtime', 'task-events', `${TASK_ID}.jsonl`);
        fs.writeFileSync(timeline, '{ malformed history');
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /unknown start evidence/);
        fs.writeFileSync(timeline, JSON.stringify({ task_id: TASK_ID, event_type: 'UNKNOWN' }) + '\n');
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /unknown start evidence/);
        fs.writeFileSync(timeline, '');
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /unknown start evidence/);
        assert.equal(fs.readFileSync(saved, 'utf8'), original);
    });

    test('task-plan save rejects escaping paths, foreign task ids, linked inputs and oversized files', t => {
        const root = workspace(t);
        const outside = workspace(t);
        const file = input(root);
        assert.throws(() => saveTaskPlan(root, '../T-701', file));
        assert.throws(() => saveTaskPlan(root, 'T-UNKNOWN', file), /does not match/);
        const unknownRoot = workspace(t);
        assert.throws(() => saveTaskPlan(unknownRoot, 'T-UNKNOWN', input(unknownRoot, { task_id: 'T-UNKNOWN' })), /existing TODO/);
        assert.throws(() => saveTaskPlan(root, TASK_ID, input(outside)), /inside repo root/);
        const linked = path.join(root, 'linked.json');
        fs.linkSync(file, linked);
        assert.throws(() => saveTaskPlan(root, TASK_ID, linked), /unshared regular file/);
        fs.unlinkSync(linked);
        fs.writeFileSync(file, ' '.repeat(TASK_PLAN_READ_MAX_BYTES + 1));
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /byte limit/);
        input(root);
        fs.symlinkSync(outside, path.join(root, DEFAULT_BUNDLE_NAME), process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /inside repo root/);
        assert.equal(fs.existsSync(path.join(outside, 'runtime')), false);
    });

    test('task-plan save preserves the previous complete artifact after a failed atomic replacement', t => {
        const root = workspace(t);
        const saved = saveTaskPlan(root, TASK_ID, input(root));
        const original = fs.readFileSync(saved, 'utf8');
        const filesystem = require('node:fs') as typeof fs;
        const rename = filesystem.renameSync;
        t.mock.method(filesystem, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
            if (String(to) === saved) throw new Error('Injected publication failure');
            rename(from, to);
        });
        assert.throws(() => saveTaskPlan(root, TASK_ID, input(root, { goal: 'Replacement' })), /publication failure/);
        assert.equal(fs.readFileSync(saved, 'utf8'), original);
        assert.deepEqual(fs.readdirSync(path.dirname(saved)), [`${TASK_ID}-task-plan.json`]);
    });

    test('task-plan save rejects source-root history and preserves runtime resolution inside ownership locking', t => {
        const root = workspace(t);
        const file = input(root);
        const runtime = path.join(root, 'runtime');
        const timeline = path.join(runtime, 'task-events', `${TASK_ID}.jsonl`);
        fs.mkdirSync(path.dirname(timeline), { recursive: true });
        fs.writeFileSync(timeline, '{ retained started history');
        assert.equal(joinOrchestratorPath(root, ''), root);
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /unknown start evidence/);
        assert.equal(fs.existsSync(path.join(root, DEFAULT_BUNDLE_NAME)), false);
        const fresh = workspace(t);
        withImplementationOwnershipLock(fresh, () => withTaskPlanMutationLock(fresh, TASK_ID, () => {
            assert.equal(joinOrchestratorPath(fresh, ''), fresh);
            assert.equal(fs.existsSync(path.join(fresh, DEFAULT_BUNDLE_NAME)), false);
        }));
        const saved = saveTaskPlan(fresh, TASK_ID, input(fresh));
        assert.equal(saved, path.join(fresh, 'runtime', 'reviews', `${TASK_ID}-task-plan.json`));
        assert.equal(readTaskPlan(fresh, TASK_ID).state, 'ready');
        fs.writeFileSync(path.join(root, 'MANIFEST.md'), '# Manifest');
        fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0');
        assert.throws(() => saveTaskPlan(root, TASK_ID, file), /unknown start evidence/);
        assert.equal(joinOrchestratorPath(root, ''), root);
    });

    test('task-plan save rejects competing real task entry and freezes the attached plan', t => {
        const root = workspace(t);
        const queuePath = path.join(root, 'TASK.md');
        const neverStartedQueue = fs.readFileSync(queuePath, 'utf8');
        const file = input(root);
        seedEntry(root);
        const saved = saveTaskPlan(root, TASK_ID, file);
        withTaskPlanMutationLock(root, TASK_ID, () => {
            const child = spawnSync(process.execPath, [__filename], {
                env: { ...process.env, GARDA_TASK_PLAN_ENTRY_TEST_ROOT: root },
                encoding: 'utf8', timeout: 15000
            });
            assert.equal(child.error, undefined);
            assert.notEqual(child.status, 0);
            assert.match(child.stderr, /task-plan\.lock/);
            assert.equal(fs.existsSync(path.join(path.dirname(saved), `${TASK_ID}-task-mode.json`)), false);
        });
        saveTaskPlan(root, TASK_ID, input(root, { goal: 'Final prepared plan' }));
        enter(root);
        const mode = JSON.parse(fs.readFileSync(path.join(path.dirname(saved), `${TASK_ID}-task-mode.json`), 'utf8'));
        const frozen = fs.readFileSync(saved, 'utf8');
        assert.equal(mode.plan.plan_sha256, JSON.parse(frozen).plan_sha256);
        fs.writeFileSync(queuePath, neverStartedQueue);
        assert.throws(() => saveTaskPlan(root, TASK_ID, input(root, { goal: 'Too late' })), /start evidence|lifecycle history/);
        assert.equal(fs.readFileSync(saved, 'utf8'), frozen);
    });
