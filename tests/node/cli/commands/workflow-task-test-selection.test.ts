import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { buildDefaultWorkflowConfig, normalizeOptionalQualityChecksConfig } from '../../../../src/core/workflow-config';
import { resolveWorkflowRoots } from '../../../../src/cli/commands/workflow/workflow-command-state';
import { assertTaskTestSelectionCurrent, resolveTaskTestSelectionAuthority } from '../../../../src/cli/commands/workflow/workflow-command-task-test-selection';
import { writeWorkflowConfigAuditRecord } from '../../../../src/cli/commands/workflow/workflow-command-mutation';
import { appendMandatoryTaskEvent, readTaskTimelineJsonlEntries } from '../../../../src/gate-runtime/task-events';
import { getTaskModeEvidence } from '../../../../src/gates/task-mode';
import { getCurrentWorkflowConfigChanges, getWorkflowConfigWorkViolations } from '../../../../src/gates/workflow-config/workflow-config-work';
import { writeProtectedControlPlaneManifest } from '../../../../src/gates/shared/helpers';
import { createTempRepo, initializeGitRepo, runEnterTaskMode, seedInitAnswers, writeBalancedProfilesConfig } from './gate-test-helpers';
import { buildOperatorConfirmationArgs } from './operator-confirmation-test-helpers';

const TASK_ID = 'T-TEST-SELECTION-1';
const TARGET = 'tests/widget.test.js';
const SECOND_TARGET = 'tests/widget-regression.test.js';
const SOURCE = 'src/widget.js';
const HELD_TASK_ID = 'T-TEST-SELECTION-HELD';
const HELD_SOURCE = 'src/held-widget.js';
const HELD_TARGET = 'tests/held-widget.test.js';
const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

function capture<T>(run: () => T): T {
    const log = console.log;
    console.log = () => undefined;
    try { return run(); } finally { console.log = log; }
}

function fixture(options: { prompt?: boolean; legacy?: boolean; enabled?: boolean; heldOwner?: boolean } = {}) {
    const root = createTempRepo();
    const bundle = path.join(root, 'garda-agent-orchestrator');
    const configPath = path.join(bundle, 'live/config/workflow-config.json');
    const originalCwd = process.cwd();
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, SOURCE), 'export const widget = 1;\n');
    fs.writeFileSync(path.join(root, HELD_SOURCE), 'export const heldWidget = 2;\n');
    fs.writeFileSync(path.join(root, HELD_TARGET), "require('node:test').test('held widget', () => {});\n");
    for (const target of [TARGET, SECOND_TARGET]) {
        fs.writeFileSync(path.join(root, target), "const test = require('node:test'); const assert = require('node:assert/strict'); test('widget', () => assert.equal(1, 1));\n");
    }
    fs.writeFileSync(path.join(root, 'TASK.md'), '# Tasks\n\n## Active Queue\n\n'
        + '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n'
        + '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
        + `| ${TASK_ID} | 🟦 TODO | P1 | app | Update widget behavior | fixture | 2026-10-07 | balanced | fixture |\n`);
    fs.writeFileSync(path.join(root, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/\n');
    seedInitAnswers(root);
    writeBalancedProfilesConfig(root);
    const config = buildDefaultWorkflowConfig();
    config.optional_quality_checks = normalizeOptionalQualityChecksConfig(config.optional_quality_checks);
    config.full_suite_validation.enabled = options.enabled !== false;
    config.task_test_selection.require_operator_confirmation = options.prompt === true;
    const input: Record<string, unknown> = { ...config };
    if (options.legacy) delete input.task_test_selection;
    fs.writeFileSync(configPath, JSON.stringify(input, null, 2) + '\n');
    initializeGitRepo(root);
    writeProtectedControlPlaneManifest(root);
    process.chdir(root);
    try {
        if (options.heldOwner) {
            fs.appendFileSync(path.join(root, 'TASK.md'), `| ${HELD_TASK_ID} | TODO | P1 | app | Preserve held widget | fixture | 2026-10-07 | balanced | HUMAN HOLD: preserve existing source. |\n`);
            const owner = capture(() => runEnterTaskMode({ repoRoot: root, taskId: HELD_TASK_ID,
                entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: '2', taskSummary: 'Preserve the held owner scope.',
                plannedChangedFiles: [HELD_SOURCE, HELD_TARGET] }));
            assert.equal(owner.exitCode, 0, owner.outputLines.join('\n'));
        }
        const entry = capture(() => runEnterTaskMode({ repoRoot: root, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: '2', taskSummary: 'Update widget behavior and its owning tests.',
            plannedChangedFiles: [SOURCE, TARGET],
            ...(options.heldOwner ? { allowedActiveTasks: [HELD_TASK_ID], operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString() } : {}) }));
        assert.equal(entry.exitCode, 0);
    } catch (error) {
        process.chdir(originalCwd);
        fs.rmSync(root, { recursive: true, force: true });
        throw error;
    }
    return { root, bundle, configPath, config,
        timeline: path.join(bundle, 'runtime/task-events', `${TASK_ID}.jsonl`),
        cleanup() { process.chdir(originalCwd); fs.rmSync(root, { recursive: true, force: true }); } };
}

function selector(root: string, options: { command?: string; targets?: string[]; reason?: string; extra?: string[] } = {}) {
    return ['set', '--target-root', root, '--task-id', TASK_ID,
        '--reason', options.reason ?? `${TASK_ID} ${TARGET} covers ${SOURCE} behavior`,
        '--full-suite-command', options.command ?? `node --test ${TARGET}`,
        ...(options.targets ?? [TARGET]).flatMap(target => ['--focused-required-test-path', target]),
        ...(options.extra ?? [])];
}

function select(root: string, options?: Parameters<typeof selector>[1]) {
    return capture(() => handleWorkflow(selector(root, options), PACKAGE_JSON));
}

test('task selection defaults to autonomous for current and legacy configs and publishes an honest cycle-bound audit', () => {
    for (const legacy of [false, true]) {
        const f = fixture({ legacy });
        try {
            const mode = getTaskModeEvidence(f.root, TASK_ID);
            const before = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
            const entry = readTaskTimelineJsonlEntries(f.timeline).at(-2)
                ?? readTaskTimelineJsonlEntries(f.timeline).at(-1);
            const result = select(f.root);
            assert.ok(result && result.action === 'set' && result.audit_path);
            assert.deepEqual(result.changed_fields, ['full_suite_validation.command']);
            const after = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
            for (const key of Object.keys(before)) {
                if (key !== 'full_suite_validation') assert.deepEqual(after[key], before[key], key);
            }
            assert.deepEqual({ ...after.full_suite_validation, command: before.full_suite_validation.command }, before.full_suite_validation);
            const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8').trim().split('\n').at(-1)!);
            assert.equal(audit.actor, 'task_selection_command');
            assert.equal(audit.command_only_change, true);
            assert.deepEqual(audit.active_task_ids, [TASK_ID]);
            const authority = audit.task_test_selection_authority;
            assert.equal(authority.origin, 'task_scoped_test_selection');
            assert.equal(authority.require_operator_confirmation, false);
            assert.equal(authority.workspace_root, fs.realpathSync.native(f.root));
            assert.equal(authority.task_mode_artifact_sha256, mode.evidence_hash);
            assert.ok(authority.task_mode_entry_sha256.match(/^[a-f0-9]{64}$/u));
            assert.ok(authority.workspace_fingerprint.match(/^[a-f0-9]{64}$/u));
            assert.equal(authority.targets[0].path, TARGET);
            assert.ok(Date.parse(authority.decision_utc) <= Date.now());
            assert.equal(authority.operator_confirmed_at_utc, undefined);
            assert.ok(entry);
            const events = readTaskTimelineJsonlEntries(f.timeline);
            assert.deepEqual(events.slice(-2).map(item => item.record?.event_type),
                ['WORKFLOW_CONFIG_MUTATION_PREPARED', 'WORKFLOW_CONFIG_MUTATION_AUDITED']);
            assert.equal((events.at(-1)?.record?.details as Record<string, unknown>).task_mode_entry_sha256,
                authority.task_mode_entry_sha256);
            const changes = getCurrentWorkflowConfigChanges(f.root, mode.workflow_config_file_hashes);
            assert.deepEqual(getWorkflowConfigWorkViolations({
                taskModeEvidence: mode, changedFiles: changes.changed_files, phaseLabel: 'selector compatibility',
                repoRoot: f.root, currentFileHashes: changes.current_file_hashes,
                baselineFileHashes: mode.workflow_config_file_hashes
            }), []);
        } finally { f.cleanup(); }
    }
});

test('current task selection preserves an approved disjoint held owner and binds both current cycles', () => {
    const f = fixture({ heldOwner: true });
    try {
        const heldSource = fs.readFileSync(path.join(f.root, HELD_SOURCE));
        const heldMode = getTaskModeEvidence(f.root, HELD_TASK_ID);
        const currentMode = getTaskModeEvidence(f.root, TASK_ID);
        const queue = fs.readFileSync(path.join(f.root, 'TASK.md'));
        const result = select(f.root);
        assert.ok(result && result.action === 'set' && result.changed);
        const audit = JSON.parse(fs.readFileSync(result.audit_path!, 'utf8').trim().split('\n').at(-1)!);
        assert.deepEqual(audit.active_task_ids, [TASK_ID, HELD_TASK_ID].sort());
        assert.equal(audit.active_task_id, null, 'The global audit must not pretend only one task is active.');
        assert.equal(audit.task_test_selection_authority.task_id, TASK_ID);
        for (const [id, mode] of [[TASK_ID, currentMode], [HELD_TASK_ID, heldMode]] as const) {
            const events = readTaskTimelineJsonlEntries(path.join(f.bundle, 'runtime/task-events', `${id}.jsonl`));
            assert.deepEqual(events.slice(-2).map(item => item.record?.event_type),
                ['WORKFLOW_CONFIG_MUTATION_PREPARED', 'WORKFLOW_CONFIG_MUTATION_AUDITED']);
            const changes = getCurrentWorkflowConfigChanges(f.root, mode.workflow_config_file_hashes);
            assert.deepEqual(getWorkflowConfigWorkViolations({ taskModeEvidence: mode, changedFiles: changes.changed_files,
                phaseLabel: 'approved held-owner selection compatibility', repoRoot: f.root,
                currentFileHashes: changes.current_file_hashes, baselineFileHashes: mode.workflow_config_file_hashes }), []);
        }
        assert.deepEqual(fs.readFileSync(path.join(f.root, HELD_SOURCE)), heldSource);
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'TASK.md')), queue);
        assert.equal(getTaskModeEvidence(f.root, HELD_TASK_ID).evidence_hash, heldMode.evidence_hash);
        assert.equal(getTaskModeEvidence(f.root, TASK_ID).evidence_hash, currentMode.evidence_hash);
    } finally { f.cleanup(); }
});

test('held-owner selection rejects orphan runtime owners and physical scope overlap before writes', () => {
    for (const mutation of ['orphan', 'overlap'] as const) {
        const f = fixture({ heldOwner: true });
        try {
            const before = fs.readFileSync(f.configPath);
            if (mutation === 'orphan') {
                const taskPath = path.join(f.root, 'TASK.md');
                fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').split('\n')
                    .filter(line => !line.startsWith(`| ${HELD_TASK_ID} |`)).join('\n'));
            } else {
                fs.unlinkSync(path.join(f.root, SOURCE));
                fs.linkSync(path.join(f.root, HELD_SOURCE), path.join(f.root, SOURCE));
            }
            assert.throws(() => select(f.root), /current active task|owner|scope/i, mutation);
            assert.deepEqual(fs.readFileSync(f.configPath), before);
        } finally { f.cleanup(); }
    }
});

test('restarting a held owner invalidates prepared selection and publication without rebinding frozen authority', () => {
    const f = fixture({ heldOwner: true });
    try {
        const roots = resolveWorkflowRoots({ targetRoot: f.root });
        const next = JSON.parse(JSON.stringify(f.config)); next.full_suite_validation.command = `node --test ${TARGET}`;
        const authority = resolveTaskTestSelectionAuthority({ taskId: TASK_ID,
            taskTestSelectionReason: `${TASK_ID} ${TARGET} covers ${SOURCE}`, focusedRequiredTestPath: [TARGET] },
            roots, f.config, next, ['full_suite_validation.command']);
        assert.ok(authority);
        const before = fs.readFileSync(f.configPath);
        const receiverMode = fs.readFileSync(path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`));
        const restarted = capture(() => runEnterTaskMode({ repoRoot: f.root, taskId: HELD_TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: '2', taskSummary: 'Restart the held owner in a new cycle.',
            plannedChangedFiles: [HELD_SOURCE, HELD_TARGET], allowedActiveTasks: [TASK_ID],
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() }));
        assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
        assert.throws(() => assertTaskTestSelectionCurrent(roots, authority), /owner|current active task/i);
        const auditPath = path.join(f.bundle, 'runtime/workflow-config-audit.jsonl');
        const auditBefore = fs.existsSync(auditPath) ? fs.readFileSync(auditPath) : null;
        assert.throws(() => writeWorkflowConfigAuditRecord(f.bundle, f.configPath,
            ['full_suite_validation.command'], before.toString(), JSON.stringify(next),
            { targetRoot: f.root, taskTestSelection: authority }), /owner|current active task|changed task cycle/i);
        assert.deepEqual(fs.existsSync(auditPath) ? fs.readFileSync(auditPath) : null, auditBefore);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        assert.deepEqual(fs.readFileSync(path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`)), receiverMode);
    } finally { f.cleanup(); }
});

test('rejects missing and stale prompt confirmation and preserves unrelated settings guard', () => {
    const f = fixture({ prompt: true });
    try {
        const before = fs.readFileSync(f.configPath);
        assert.throws(() => select(f.root), /operator/i);
        assert.throws(() => select(f.root, { extra: ['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', '2000-01-01T00:00:00Z'] }), /fresh|old|expired|age/i);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        const result = select(f.root, { extra: buildOperatorConfirmationArgs() });
        assert.ok(result && result.action === 'set' && result.changed);
        assert.throws(() => capture(() => handleWorkflow(['set', '--target-root', f.root,
            '--task-test-selection-require-operator-confirmation', 'false'], PACKAGE_JSON)), /operator/i);
        const off = capture(() => handleWorkflow(['set', '--target-root', f.root,
            '--task-test-selection-require-operator-confirmation', 'false', ...buildOperatorConfirmationArgs()], PACKAGE_JSON));
        assert.ok(off && off.action === 'set');
        assert.equal(off.task_test_selection.require_operator_confirmation, false);
        for (const [flag, value] of [['--full-suite-enabled', 'false'], ['--full-suite-timeout-ms', '1000'],
            ['--full-suite-timeout-retry-count', '0'], ['--review-execution-policy', 'parallel_all']]) {
            assert.throws(() => capture(() => handleWorkflow(['set', '--target-root', f.root, flag, value], PACKAGE_JSON)), /operator/i);
        }
    } finally { f.cleanup(); }
});

test('selector rejects gate-disable and no-op piggyback requests before all writes', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.configPath);
        const timeline = fs.readFileSync(f.timeline);
        for (const extra of [['--full-suite-enabled', 'false'], ['--full-suite-enabled', 'true'],
            ['--full-suite-timeout-ms', String(f.config.full_suite_validation.timeout_ms)],
            ['--task-test-selection-require-operator-confirmation', 'false'], ['--garda-self-guard', 'on'],
            ['--optional-check-rule-id', 'code_simplification', '--optional-check-rule-enabled', 'true'],
            ['--optional-check-rule-id', 'code_simplification'], ['--optional-check-rule-enabled', 'true']]) {
            assert.throws(() => select(f.root, { extra }), /only full_suite_validation.command/i);
        }
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        assert.deepEqual(fs.readFileSync(f.timeline), timeline);
        assert.equal(fs.existsSync(path.join(f.bundle, 'runtime/workflow-config-audit.jsonl')), false);
    } finally { f.cleanup(); }
});

test('selector rejects empty authority, unrelated and linked targets, no-op interpreters and foreign commands', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.configPath);
        for (const command of ['true', `echo ${TARGET}`, `node -e "console.log('${TARGET}')"`,
            `node --test ${TARGET} && true`, `bash -c "node --test ${TARGET}"`,
            `node --test /tmp/${TARGET}`, `node --test ../${TARGET}`, `node --test ${TARGET} --help`]) {
            assert.throws(() => select(f.root, { command }), /rejected/i, command);
        }
        assert.throws(() => select(f.root, { reason: 'because it is available' }), /--reason/i);
        assert.throws(() => select(f.root, { command: `node --test ${SECOND_TARGET}`, targets: [SECOND_TARGET] }), /explicit relationship/i);
        assert.throws(() => select(f.root, { targets: [TARGET, TARGET] }), /duplicate/i);
        assert.throws(() => select(f.root, { targets: [SOURCE], command: `node --test ${SOURCE}` }), /classified as a repository test/i);
        const link = path.join(f.root, 'tests/linked.test.js');
        fs.linkSync(path.join(f.root, TARGET), link);
        assert.throws(() => select(f.root), /without links/i);
        fs.unlinkSync(link);
        fs.symlinkSync(path.join(f.root, TARGET), link);
        assert.throws(() => select(f.root, { targets: ['tests/linked.test.js'], command: 'node --test tests/linked.test.js',
            reason: `${TASK_ID} tests/linked.test.js covers ${SOURCE}` }), /declared test target 'tests\/linked\.test\.js' through a supported native validation runner/i);
        fs.unlinkSync(link);
        const partial = selector(f.root).filter((_, i, args) => i !== args.indexOf('--reason') && i !== args.indexOf('--reason') + 1);
        assert.throws(() => capture(() => handleWorkflow(partial, PACKAGE_JSON)), /required together/i);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
    } finally { f.cleanup(); }
});

test('explicit multiple targets use native validation and reject unlisted tests', () => {
    const f = fixture();
    try {
        const result = select(f.root, { command: `node --test ${TARGET} ${SECOND_TARGET}`, targets: [TARGET, SECOND_TARGET],
            reason: `${TASK_ID} ${TARGET} covers ${SOURCE}; ${SECOND_TARGET} guards ${SOURCE} regression` });
        assert.ok(result && result.action === 'set' && result.audit_path);
        const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8').trim());
        assert.deepEqual(audit.task_test_selection_authority.targets.map((item: { path: string }) => item.path), [TARGET, SECOND_TARGET]);
        assert.throws(() => select(f.root, { command: `node --test ${TARGET} ${SECOND_TARGET}` }), /declared test target/i);
    } finally { f.cleanup(); }
});

test('missing, tampered, terminal and foreign task evidence never authorizes selector writes', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.configPath);
        const artifact = path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`);
        const mode = fs.readFileSync(artifact);
        fs.unlinkSync(artifact);
        assert.throws(() => select(f.root), /task-mode evidence/i);
        fs.writeFileSync(artifact, mode);
        const timeline = fs.readFileSync(f.timeline);
        fs.appendFileSync(f.timeline, '{invalid}\n');
        assert.throws(() => select(f.root), /native task timeline/i);
        fs.writeFileSync(f.timeline, timeline);
        const raw = JSON.parse(mode.toString()); raw.task_id = 'T-FOREIGN';
        fs.writeFileSync(artifact, JSON.stringify(raw));
        assert.throws(() => select(f.root), /task-mode evidence/i);
        fs.writeFileSync(artifact, mode);
        const foreign = { ...resolveWorkflowRoots({ targetRoot: f.root }), bundleRoot: path.dirname(f.bundle) };
        assert.throws(() => resolveTaskTestSelectionAuthority({ taskId: TASK_ID, taskTestSelectionReason: `${TASK_ID} covers ${SOURCE}`,
            focusedRequiredTestPath: [TARGET] }, foreign, f.config, f.config, ['full_suite_validation.command']), /canonical worktree/i);
        appendMandatoryTaskEvent(f.bundle, TASK_ID, 'STATUS_CHANGED', 'PASS', 'Terminal fixture.',
            { old_status: 'IN_PROGRESS', new_status: 'DONE' });
        assert.throws(() => select(f.root), /current active task/i);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
    } finally { f.cleanup(); }
});

test('rejects stale prepared authority after independent target, source and task changes', () => {
    const f = fixture();
    try {
        const roots = resolveWorkflowRoots({ targetRoot: f.root });
        const next = JSON.parse(JSON.stringify(f.config)); next.full_suite_validation.command = `node --test ${TARGET}`;
        const prepare = () => resolveTaskTestSelectionAuthority({ taskId: TASK_ID,
            taskTestSelectionReason: `${TASK_ID} covers ${SOURCE}`, focusedRequiredTestPath: [TARGET] },
            roots, f.config, next, ['full_suite_validation.command']);
        const targetAuthority = prepare();
        assert.ok(targetAuthority);
        fs.appendFileSync(path.join(f.root, TARGET), '// changed\n');
        assert.throws(() => assertTaskTestSelectionCurrent(roots, targetAuthority), /changed before publication/i);
        const sourceAuthority = prepare();
        assert.ok(sourceAuthority);
        fs.appendFileSync(path.join(f.root, SOURCE), '// independent source change\n');
        assert.throws(() => assertTaskTestSelectionCurrent(roots, sourceAuthority), /changed before publication/i);
        const taskAuthority = prepare();
        assert.ok(taskAuthority);
        capture(() => runEnterTaskMode({ repoRoot: f.root, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: '2', taskSummary: 'Update widget behavior in a fresh cycle.', plannedChangedFiles: [SOURCE, TARGET] }));
        assert.throws(() => assertTaskTestSelectionCurrent(roots, taskAuthority), /changed before publication/i);
    } finally { f.cleanup(); }
});

test('selector preserves config and leaves no committed audit when native manifest publication fails', () => {
    const f = fixture();
    const realFs = require('node:fs') as typeof fs;
    const rename = realFs.renameSync;
    const before = fs.readFileSync(f.configPath);
    try {
        realFs.renameSync = (from, to) => {
            if (String(to).endsWith('protected-control-plane-manifest.json')) throw new Error('injected selector publication failure');
            return rename(from, to);
        };
        assert.throws(() => select(f.root), /injected selector publication failure/);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        assert.equal(fs.existsSync(path.join(f.bundle, 'runtime/workflow-config-audit.jsonl')), false);
        assert.equal(readTaskTimelineJsonlEntries(f.timeline).some(item => item.record?.event_type === 'WORKFLOW_CONFIG_MUTATION_AUDITED'), false);
    } finally { realFs.renameSync = rename; f.cleanup(); }
});

test('disabled test gate never receives autonomous selection', () => {
    const f = fixture({ enabled: false });
    try { assert.throws(() => select(f.root), /enabled test gate/i); } finally { f.cleanup(); }
});
