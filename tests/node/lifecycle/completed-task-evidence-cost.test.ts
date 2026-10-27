import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectCompletedTaskEvidence, inspectCompletedTaskEvidenceBatch } from '../../../src/lifecycle/cleanup/completed-task-evidence';
import {
    buildTaskAuditSummary, computeFileSha256, getWorkspaceSnapshot, makeTempDir,
    synchronizeFinalCloseoutArtifacts, writeArtifact, writeIntegrityEventSequence,
    writePreflight, writeWorkflowConfig
} from '../gates/task-audit/task-audit-summary-fixtures';
import { initGitRepo } from '../gates/git-fixtures';
import { writeTaskQueue, writeTimelineSummary } from './cleanup-fixtures';

const TASK_IDS = ['T-COST-1', 'T-COST-2', 'T-COST-3'];
const ACCEPTED_CONTENT = 'accepted completed content\n';

function completedReadSnapshot<T>(root: string, read: () => T): T {
    const runtime = require('../../../src/lifecycle/cleanup/completed-task-evidence') as {
        withCompletedTaskEvidenceReadSnapshot?: <V>(repoRoot: string, callback: () => V) => V;
    };
    // Before the repair, each nested consumer performs its ordinary independent read.
    return runtime.withCompletedTaskEvidenceReadSnapshot ? runtime.withCompletedTaskEvidenceReadSnapshot(root, read) : read();
}

function committedFixture(t: TestContext, taskIds: readonly string[]) {
    const root = makeTempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ignored = 'garda-agent-orchestrator/\nTASK.md\n';
    fs.writeFileSync(path.join(root, '.gitignore'), ignored);
    fs.writeFileSync(path.join(root, 'example.txt'), 'baseline\n');
    initGitRepo(root, { gitignoreContent: ignored });
    fs.writeFileSync(path.join(root, 'example.txt'), ACCEPTED_CONTENT);
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
    const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(reviewsDir, { recursive: true });
    writeWorkflowConfig(root, false);
    writeTaskQueue(root, taskIds.map(id => ({ id, status: 'DONE' })));
    for (const taskId of taskIds) {
        const changedFiles = ['example.txt'];
        writePreflight(reviewsDir, taskId, {
            task_id: taskId, mode: 'FULL_PATH', detection_source: 'explicit_changed_files',
            changed_files: changedFiles, required_reviews: {},
            metrics: getWorkspaceSnapshot(root, 'explicit_changed_files', true, changedFiles)
        });
        const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
        const preflightSha256 = computeFileSha256(preflightPath);
        for (const suffix of ['-task-mode.json', '-compile-gate.json', '-review-gate.json', '-doc-impact.json']) {
            writeArtifact(reviewsDir, taskId, suffix, {
                task_id: taskId, status: 'PASSED', preflight_sha256: preflightSha256,
                requested_depth: 2, effective_depth: 2, decision: 'NO_DOC_UPDATES'
            });
        }
        writeIntegrityEventSequence(eventsDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED' }, { event_type: 'RULE_PACK_LOADED' },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' }, { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
            { event_type: 'PREFLIGHT_CLASSIFIED', details: { artifact_path: preflightPath, artifact_hash: preflightSha256 } },
            { event_type: 'COMPILE_GATE_PASSED', details: { preflight_path: preflightPath, preflight_sha256: preflightSha256 } },
            { event_type: 'REVIEW_GATE_PASSED' }, { event_type: 'DOC_IMPACT_ASSESSED' },
            { event_type: 'STATUS_CHANGED', details: { new_status: 'DONE' } }, { event_type: 'COMPLETION_GATE_PASSED' }
        ]);
        writeTimelineSummary(eventsDir, taskId, { completenessStatus: 'COMPLETE' });
        const audit = buildTaskAuditSummary({ repoRoot: root, taskId });
        assert.equal(audit.status, 'PASS', JSON.stringify(audit.blockers));
        synchronizeFinalCloseoutArtifacts(audit);
    }
    execFileSync('git', ['add', '--', 'example.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'accepted completed task'], { cwd: root });
    for (const taskId of taskIds) {
        const audit = buildTaskAuditSummary({ repoRoot: root, taskId });
        assert.equal(audit.status, 'PASS', JSON.stringify(audit.blockers));
        synchronizeFinalCloseoutArtifacts(audit);
    }
    return { root, bundleRoot };
}

test('completed evidence shares workspace discovery within one batch of genuine accepted tasks', t => {
    const fixture = committedFixture(t, TASK_IDS);
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const originalExec = childProcess.execFileSync, originalSpawn = childProcess.spawnSync;
    let gitCalls = 0;
    let headQueries = 0, numstatQueries = 0;
    function recordGit(command: unknown, args: unknown): void {
        if (command !== 'git') return;
        gitCalls += 1;
        const argumentsList = Array.isArray(args) ? args.map(String) : [];
        if (argumentsList.includes('rev-parse')) headQueries += 1;
        if (argumentsList.includes('--numstat')) numstatQueries += 1;
    }
    t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
        recordGit(args[0], args[1]);
        return originalExec(...args);
    });
    t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof childProcess.spawnSync>) => {
        recordGit(args[0], args[1]);
        return originalSpawn(...args);
    });
    const single = inspectCompletedTaskEvidenceBatch({ repoRoot: fixture.root, taskIds: TASK_IDS.slice(0, 1) });
    assert.ok([...single.values()].every(result => result.eligible), JSON.stringify([...single.values()]));
    const singleCalls = gitCalls;
    assert.equal(headQueries, 2, 'fresh before/after fingerprints already bind HEAD for the whole batch');
    assert.equal(numstatQueries, 0, 'a fresh canonical generation without changes has no diff statistics to discover');
    gitCalls = 0;
    const batch = inspectCompletedTaskEvidenceBatch({ repoRoot: fixture.root, taskIds: TASK_IDS });
    assert.deepEqual([...batch.keys()], TASK_IDS);
    assert.ok([...batch.values()].every(result => result.eligible), JSON.stringify([...batch.values()]));
    t.diagnostic(`Real Git processes: one task=${singleCalls}, three-task batch=${gitCalls}`);
    assert.ok(gitCalls <= singleCalls + 8 * (TASK_IDS.length - 1),
        `workspace discovery repeated across tasks: one=${singleCalls}, batch=${gitCalls}`);
    fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'changed after the previous successful proof\n');
    const later = inspectCompletedTaskEvidenceBatch({ repoRoot: fixture.root, taskIds: TASK_IDS.slice(0, 1) });
    assert.equal(later.get(TASK_IDS[0])!.eligible, false, 'a later operation must reconstruct current evidence');
});

for (const drift of ['HEAD', 'index', 'worktree', 'Git configuration'] as const) {
    test(`completed batch rejects ${drift} drift after an earlier task was verified`, t => {
        const taskIds = TASK_IDS.slice(0, 2);
        const fixture = committedFixture(t, taskIds);
        const nativeFs = require('node:fs') as typeof fs;
        const originalRead = nativeFs.readFileSync;
        const secondLedger = path.join(fixture.bundleRoot, 'runtime', 'task-ledger', `${taskIds[1]}.json`);
        let changed = false;
        t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
            const value = originalRead(...args);
            if (!changed && String(args[0]) === secondLedger) {
                changed = true;
                if (drift === 'HEAD') {
                    execFileSync('git', ['commit', '--allow-empty', '-m', 'concurrent HEAD change'], { cwd: fixture.root });
                } else if (drift === 'index') {
                    fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'concurrent staged content\n');
                    execFileSync('git', ['add', '--', 'example.txt'], { cwd: fixture.root });
                    fs.writeFileSync(path.join(fixture.root, 'example.txt'), ACCEPTED_CONTENT);
                } else if (drift === 'worktree') {
                    fs.writeFileSync(path.join(fixture.root, 'concurrent.txt'), 'concurrent new content\n');
                } else {
                    execFileSync('git', ['config', 'core.eol', 'crlf'], { cwd: fixture.root });
                }
            }
            return value;
        });
        const results = inspectCompletedTaskEvidenceBatch({ repoRoot: fixture.root, taskIds });
        assert.equal(changed, true, 'real mutation must happen after the first task proof');
        assert.equal(results.size, taskIds.length);
        assert.ok([...results.values()].every(result => !result.eligible), JSON.stringify([...results.values()]));
    });
}

test('completed recovery read snapshot bounds real Git discovery across nested reads and expires after publication', t => {
    const fixture = committedFixture(t, TASK_IDS.slice(0, 1)), taskId = TASK_IDS[0];
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    let calls = 0;
    for (const method of ['spawnSync', 'execFileSync'] as const) {
        const original = childProcess[method];
        t.mock.method(childProcess, method, (...args: unknown[]) => {
            if (path.basename(String(args[0])).replace(/\.exe$/u, '') === 'git') calls += 1;
            return Reflect.apply(original, childProcess, args);
        });
    }
    assert.equal(inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId }).eligible, true);
    const ordinaryCalls = calls; calls = 0;
    const result = completedReadSnapshot(fixture.root, () => {
        for (let index = 0; index < 8; index += 1) {
            const current = inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId });
            assert.equal(current.eligible, true, current.reasons.join());
            current.eligible = false; current.reasons.push('caller mutation must not corrupt the private snapshot');
        }
        return 'read-only result';
    });
    assert.equal(result, 'read-only result');
    t.diagnostic(`Real Git calls: independent proof=${ordinaryCalls}, eight nested reads plus publication=${calls}`);
    assert.ok(calls <= Math.floor(ordinaryCalls * 1.5), `nested completed proof discovery repeated: ${calls} > ${Math.floor(ordinaryCalls * 1.5)}`);
    fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'changed after the completed read operation\n');
    assert.equal(inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId }).eligible, false);
});

for (const drift of ['queue', 'compact evidence', 'worktree'] as const) {
    test(`completed recovery read snapshot rejects ${drift} drift before result publication`, t => {
        const fixture = committedFixture(t, TASK_IDS.slice(0, 1)), taskId = TASK_IDS[0];
        let firstProofRead = false;
        assert.throws(() => completedReadSnapshot(fixture.root, () => {
            assert.equal(inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId }).eligible, true);
            firstProofRead = true;
            if (drift === 'queue') writeTaskQueue(fixture.root, [{ id: taskId, status: 'IN_PROGRESS' }]);
            else if (drift === 'compact evidence') {
                const closeout = path.join(fixture.bundleRoot, 'runtime', 'reviews', `${taskId}-final-closeout.json`);
                fs.appendFileSync(closeout, '\n');
            } else fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'concurrent accepted-content mutation\n');
            return 'must not escape';
        }), /Completed evidence changed before read snapshot publication/u);
        assert.equal(firstProofRead, true, 'the real mutation follows a genuinely eligible proof');
        assert.equal(inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId }).eligible, false);
    });
}

test('native completed audit verification matches full audit decisions and closeout header', t => {
    const fixture = committedFixture(t, TASK_IDS.slice(0, 1)), taskId = TASK_IDS[0];
    const audit = require('../../../src/gates/task-audit/task-audit-summary') as typeof import('../../../src/gates/task-audit/task-audit-summary');
    for (const changed of [false, true]) {
        if (changed) fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'changed after completion\n');
        const options = { repoRoot: fixture.root, taskId };
        const full = audit.buildTaskAuditSummary(options), verification = audit.buildTaskAuditVerification(options);
        assert.deepEqual(verification, {
            task_id: full.task_id, status: full.status, integrity_status: full.integrity_status,
            point_in_time_snapshot: full.point_in_time_snapshot, gates: full.gates, blockers: full.blockers,
            changed_files: full.changed_files, final_closeout: {
                status: full.final_closeout.status, cycle_binding: full.final_closeout.cycle_binding,
                artifact_paths: full.final_closeout.artifact_paths
            }
        });
    }
});

test('native completed audit verification preserves mapped missing optional policy rejection', t => {
    const fixture = committedFixture(t, TASK_IDS.slice(0, 1)), taskId = TASK_IDS[0];
    const audit = require('../../../src/gates/task-audit/task-audit-summary') as typeof import('../../../src/gates/task-audit/task-audit-summary');
    const config = path.join(fixture.bundleRoot, 'live', 'config', 'garda.config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }));
    for (const build of [audit.buildTaskAuditSummary, audit.buildTaskAuditVerification]) {
        assert.throws(() => build({ repoRoot: fixture.root, taskId }), /Managed optional skill selection policy config is missing/u);
    }
});

test('native completed audit verification keeps late classification rejection after earlier scope checks', t => {
    const fixture = committedFixture(t, TASK_IDS.slice(0, 1)), taskId = TASK_IDS[0];
    const audit = require('../../../src/gates/task-audit/task-audit-summary') as typeof import('../../../src/gates/task-audit/task-audit-summary');
    const optional = require('../../../src/gates/task-audit/task-audit-summary-collectors') as typeof import('../../../src/gates/task-audit/task-audit-summary-collectors');
    const original = optional.readOptionalSkillsSummary;
    const config = path.join(fixture.bundleRoot, 'live', 'config', 'paths.json');
    const before = fs.existsSync(config) ? fs.readFileSync(config) : null;
    for (const build of [audit.buildTaskAuditSummary, audit.buildTaskAuditVerification]) {
        if (before) fs.writeFileSync(config, before); else fs.rmSync(config, { force: true });
        const domains = require('../../../src/gates/scope/domain-scope-fingerprints') as typeof import('../../../src/gates/scope/domain-scope-fingerprints');
        const buildDomains = domains.buildDomainScopeFingerprints;
        let armed = false, changed = false;
        t.mock.method(optional, 'readOptionalSkillsSummary', (...args: Parameters<typeof original>) => {
            const value = original(...args); armed = true; return value;
        });
        t.mock.method(domains, 'buildDomainScopeFingerprints', (...args: Parameters<typeof buildDomains>) => {
            if (armed && !changed) {
                fs.mkdirSync(path.dirname(config), { recursive: true });
                fs.writeFileSync(config, '{ invalid late classification'); changed = true;
            }
            return buildDomains(...args);
        });
        assert.throws(() => build({ repoRoot: fixture.root, taskId }));
        assert.equal(changed, true, 'invalid classification is introduced at the late domain check');
        t.mock.restoreAll();
    }
});


test('completed recovery read snapshot rejects changed Git configuration before returning', t => {
    const fixture = committedFixture(t, TASK_IDS.slice(0, 1)), taskId = TASK_IDS[0];
    let entered = false;
    assert.throws(() => completedReadSnapshot(fixture.root, () => {
        assert.equal(inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId }).eligible, true);
        entered = true;
        execFileSync('git', ['config', 'core.eol', 'crlf'], { cwd: fixture.root });
        return 'must not escape';
    }), /Git classification evidence changed|Invocation Git observation changed|Completed evidence changed/u);
    assert.equal(entered, true, 'a real native proof must precede the config mutation');
});


test('completed recovery read snapshot rejects a newly missing required policy', t => {
    const fixture = committedFixture(t, TASK_IDS.slice(0, 1)), taskId = TASK_IDS[0];
    const config = path.join(fixture.bundleRoot, 'live', 'config', 'garda.config.json');
    let entered = false;
    assert.throws(() => completedReadSnapshot(fixture.root, () => {
        assert.equal(inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId }).eligible, true);
        entered = true;
        fs.mkdirSync(path.dirname(config), { recursive: true });
        fs.writeFileSync(config, JSON.stringify({ configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }));
        return 'must not escape';
    }), /Completed evidence changed|Invocation file observation changed|Invocation file bytes changed/u);
    assert.equal(entered, true, 'the real first proof must succeed before the policy input changes');
});


test('completed audit observes signed workflow migration authority before returning', t => {
    const fixture = committedFixture(t, TASK_IDS.slice(0, 1)), taskId = TASK_IDS[0];
    const relativeConfig = 'garda-agent-orchestrator/live/config/workflow-config.json';
    const configPath = path.join(fixture.root, ...relativeConfig.split('/'));
    const modePath = path.join(fixture.bundleRoot, 'runtime', 'reviews', `${taskId}-task-mode.json`);
    const mode = JSON.parse(fs.readFileSync(modePath, 'utf8')) as Record<string, unknown>;
    const beforeHash = '0'.repeat(64);
    mode.workflow_config_file_hashes = { [relativeConfig]: beforeHash };
    fs.writeFileSync(modePath, JSON.stringify(mode));
    const auth = require('../../../src/core/auth/local-commit-availability') as typeof import('../../../src/core/auth/local-commit-availability');
    const record = auth.authenticateWorkflowMigration(fixture.root, {
        event_source: 'workflow-config-set', command: 'lifecycle configuration migration',
        mutation_source: 'lifecycle', migration_version: 1, permissions_preserved: true,
        config_path: relativeConfig, before_sha256: beforeHash, after_sha256: computeFileSha256(configPath),
        changed_fields: ['full_suite_validation.enabled'], active_task_ids: [taskId], active_task_id: taskId
    });
    assert.equal(auth.isAuthenticatedWorkflowMigration(fixture.root, record), true);
    fs.writeFileSync(path.join(fixture.bundleRoot, 'runtime', 'workflow-config-audit.jsonl'), JSON.stringify(record) + '\n');
    const keyPath = path.join(fixture.root, '.git', 'garda-private', 'workflow-migration-key');
    const originalKey = fs.readFileSync(keyPath);
    const audit = require('../../../src/gates/task-audit/task-audit-summary') as typeof import('../../../src/gates/task-audit/task-audit-summary');
    const observations = require('../../../src/core/invocation-read-observation') as typeof import('../../../src/core/invocation-read-observation');
    const options = { repoRoot: fixture.root, taskId };
    for (const [name, build] of [['full', audit.buildTaskAuditSummary], ['verification', audit.buildTaskAuditVerification]] as const) {
        assert.throws(() => observations.withStrictInvocationReadObservation(() => {
            build(options);
            fs.appendFileSync(keyPath, '\n');
        }), /Invocation file (?:observation|bytes) changed/u, `${name} audit must retain its migration-key observation`);
        fs.writeFileSync(keyPath, originalKey);
    }
    // Exercise the actual completed-evidence path used by recovery as well.
    const full = audit.buildTaskAuditSummary(options);
    assert.equal(full.status, 'PASS', JSON.stringify(full.blockers));
    synchronizeFinalCloseoutArtifacts(full);
    const accepted = inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId });
    assert.equal(accepted.eligible, true, accepted.reasons.join());
    assert.throws(() => completedReadSnapshot(fixture.root, () => {
        const current = inspectCompletedTaskEvidence({ repoRoot: fixture.root, taskId });
        assert.equal(current.eligible, true, current.reasons.join());
        fs.appendFileSync(keyPath, '\n');
        return 'must not escape';
    }), /Invocation file (?:observation|bytes) changed/u);
});
