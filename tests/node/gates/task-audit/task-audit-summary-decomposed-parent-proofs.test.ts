import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { createTempRepo, seedTaskQueue } from '../../cli/commands/gate-test-helpers';
import { runHumanCommitCommand, runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildScopeContentFingerprint } from '../../../../src/gates/compile/compile-gate';
import { appendMandatoryTaskEvent, buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events';

const fs: typeof import('node:fs') = require('node:fs');
const modulePath = '../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs';
const roots: string[] = [];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const childTaskId = 'T-PROOF-2';
const authApi = require('../../../../src/core/auth/local-commit-availability') as typeof import('../../../../src/core/auth/local-commit-availability');

type MutableCompositionRecord = Record<string, unknown> & {
    source_composition: {
        status: string;
        before: { clean_worktree: boolean; repo_root: string };
        after: { source_tree_sha: string };
    };
};

function compositionReader(): (root: string, options: Record<string, unknown>) => Record<string, unknown> {
    const read = require(modulePath).readNativeSourceCompositionProof;
    assert.equal(typeof read, 'function', 'native composition-proof reader must exist');
    return read;
}

async function compositionFixture(grant = true) {
    const root = createTempRepo(); roots.push(root);
    const taskId = 'T-COMPOSITION-1', bundle = path.join(root, 'garda-agent-orchestrator');
    seedTaskQueue(root, taskId);
    fs.writeFileSync(path.join(root, '.gitignore'), 'garda-agent-orchestrator/\nTASK.md\nattempt.txt\n');
    const script = 'scripts/node-foundation/build-scripts.cjs', target = 'tests/node/composition.test.ts';
    fs.mkdirSync(path.dirname(path.join(root, script)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
    fs.writeFileSync(path.join(root, target), 'export {};\n');
    fs.writeFileSync(path.join(root, script), [
        "const fs=require('node:fs'); const later=fs.existsSync('attempt.txt');",
        "fs.writeFileSync('attempt.txt','1'); console.log('actual composition output'); process.exitCode=later?7:0;"
    ].join('\n'));
    proofGit(root, ['init']);
    proofGit(root, ['config', 'user.name', 'Composition Tests']);
    proofGit(root, ['config', 'user.email', 'composition@example.invalid']);
    proofGit(root, ['add', '.']); proofGit(root, ['commit', '-m', 'composition source']);
    const config = path.join(bundle, 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig()) + '\n');
    if (grant) handleSet({ targetRoot: root, localCommitEnabled: 'true', json: true,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
    appendMandatoryTaskEvent(bundle, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Isolated composition fixture.', {});
    const command = `node ${script} test.js ${target}`;
    const run = () => runIntermediateCommandCommand({ repoRoot: root, taskId, command, commandSource: 'targeted-test',
        coverageContractSha256: 'a'.repeat(64), timeoutMs: 10000 });
    assert.equal((await run()).exitCode, 0);
    const eventFile = path.join(bundle, 'runtime/task-events', taskId + '.jsonl');
    const events = fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const event = [...events].reverse().find((item: Record<string, unknown>) => item.event_type === 'INTERMEDIATE_COMMAND_RUN');
    const file = event.details.artifact_path as string, bytes = fs.readFileSync(file);
    const options = { taskId, command, artifactPath: file, artifactSha256: digest(bytes),
        coverageContractSha256: 'a'.repeat(64), source: { commitSha: proofGit(root, ['rev-parse', 'HEAD']),
            treeSha: proofGit(root, ['rev-parse', 'HEAD^{tree}']), parentCommitSha: null } };
    return { root, bundle, taskId, script, run, eventFile, events, event, file, bytes, options,
        output: String(JSON.parse(bytes.toString()).output_artifact) };
}

function alterCompositionFixture(f: Awaited<ReturnType<typeof compositionFixture>>,
    change: (record: MutableCompositionRecord) => void, sign = true) {
    let record = JSON.parse(f.bytes.toString()); change(record);
    if (sign) record = authApi.authenticateLocalCommitWorkflowAudit(f.root, record, false);
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    fs.writeFileSync(f.file, bytes); f.options.artifactSha256 = digest(bytes);
    f.event.details.artifact_sha256 = digest(bytes);
    f.event.details.source_composition_sha256 = digest(Buffer.from(JSON.stringify(record.source_composition)));
    f.event.integrity.event_sha256 = buildEventIntegrityHash(f.event);
    fs.writeFileSync(f.eventFile, f.events.map((event: unknown) => JSON.stringify(event)).join('\n') + '\n');
}

describe('native final-source composition proof', () => {
    it('verifies actual current signed source and output without granting parent acceptance', async () => {
        const read = compositionReader(), f = await compositionFixture();
        const timeline = fs.readFileSync(f.eventFile), result = read(f.root, f.options);
        assert.equal(result.taskId, f.taskId); assert.equal(result.command, f.options.command);
        assert.equal(result.processStatus, 'PASSED'); assert.equal('parentPass' in result, false);
        assert.equal(result.outputSha256, digest(fs.readFileSync(f.output)));
        assert.deepEqual(fs.readFileSync(f.eventFile), timeline); assert.deepEqual(fs.readFileSync(f.file), f.bytes);
        assert.equal(proofGit(f.root, ['status', '--porcelain']), '');
    });

    const invalid: Array<[string, (record: MutableCompositionRecord) => void]> = [
        ['foreign task', p => { p.task_id = 'T-FOREIGN-1'; }],
        ['changed command', p => { p.command = 'node different.cjs'; }],
        ['changed coverage', p => { p.coverage_contract_sha256 = 'b'.repeat(64); }],
        ['failed', p => { p.status = 'FAILED'; p.exit_code = 7; }],
        ['cancelled', p => { p.cancelled = true; }],
        ['timed out', p => { p.timed_out = true; }],
        ['expected red', p => { p.expected_failure = true; }],
        ['unavailable source', p => { p.source_composition.status = 'UNAVAILABLE'; }],
        ['dirty source', p => { p.source_composition.before.clean_worktree = false; }],
        ['foreign source', p => { p.source_composition.before.repo_root = path.dirname(p.source_composition.before.repo_root); }],
        ['changed source', p => { p.source_composition.after.source_tree_sha = '0'.repeat(40); }],
        ['unsigned record', p => { delete p.local_commit_authentication; }]
    ];
    for (const [name, change] of invalid) it('rejects ' + name + ' without rewriting evidence', async () => {
        const read = compositionReader(), f = await compositionFixture();
        alterCompositionFixture(f, change, name !== 'unsigned record');
        const bytes = fs.readFileSync(f.file);
        assert.throws(() => read(f.root, f.options)); assert.deepEqual(fs.readFileSync(f.file), bytes);
    });

    it('rejects old unsigned attempts after later authority without retroactive signing', async () => {
        const read = compositionReader(), f = await compositionFixture(false);
        handleSet({ targetRoot: f.root, localCommitEnabled: 'true', json: true,
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
        assert.throws(() => read(f.root, f.options)); assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    });

    it('rejects missing or changed output, dirty current source and changed final commit', async () => {
        const read = compositionReader(), f = await compositionFixture(), output = fs.readFileSync(f.output);
        fs.appendFileSync(f.output, 'changed'); assert.throws(() => read(f.root, f.options));
        fs.unlinkSync(f.output); assert.throws(() => read(f.root, f.options)); fs.writeFileSync(f.output, output);
        fs.appendFileSync(path.join(f.root, f.script), '\n'); assert.throws(() => read(f.root, f.options));
        proofGit(f.root, ['checkout', '--', f.script]);
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'later final source']);
        assert.throws(() => read(f.root, f.options));
    });

    it('rejects a later actual failed invocation and a new task cycle', async () => {
        const read = compositionReader(), f = await compositionFixture();
        assert.equal((await f.run()).exitCode, 7); assert.throws(() => read(f.root, f.options));
        appendMandatoryTaskEvent(f.bundle, f.taskId, 'TASK_MODE_ENTERED', 'PASS', 'Later isolated cycle.', {});
        assert.throws(() => read(f.root, f.options));
    });

    describe('security review regressions', () => {
        for (const flag of ['--assume-unchanged', '--skip-worktree']) it('rejects source hidden by ' + flag, async () => {
            const read = compositionReader(), f = await compositionFixture();
            proofGit(f.root, ['update-index', flag, '--', f.script]);
            fs.appendFileSync(path.join(f.root, f.script), '\n// hidden source change\n');
            assert.equal(proofGit(f.root, ['status', '--porcelain']), '', 'Git must actually conceal this tracked edit');
            assert.throws(() => read(f.root, f.options));
            assert.deepEqual(fs.readFileSync(f.file), f.bytes);
        });

        it('rejects reserialized signed success after a later real failure', async () => {
            const read = compositionReader(), f = await compositionFixture();
            assert.equal(read(f.root, f.options).processStatus, 'PASSED');
            assert.equal((await f.run()).exitCode, 7);
            const bytes = Buffer.from(JSON.stringify(JSON.parse(f.bytes.toString())) + '\n');
            const file = path.join(path.dirname(f.file), 'reserialized-success.json');
            fs.writeFileSync(file, bytes, { flag: 'wx' });
            f.options.artifactPath = file; f.options.artifactSha256 = digest(bytes);
            assert.notEqual(f.options.artifactSha256, digest(f.bytes));
            appendMandatoryTaskEvent(f.bundle, f.taskId, 'INTERMEDIATE_COMMAND_RUN', 'PASSED',
                'Adversarial reserialization fixture; no new execution or signing.',
                { ...f.event.details, artifact_path: file, artifact_sha256: digest(bytes) });
            assert.throws(() => read(f.root, f.options));
            assert.deepEqual(fs.readFileSync(f.file), f.bytes); assert.deepEqual(fs.readFileSync(file), bytes);
        });

        for (const later of ['failed invocation', 'new cycle']) it('rejects replayed success after ' + later, async () => {
            const read = compositionReader(), f = await compositionFixture();
            if (later === 'failed invocation') assert.equal((await f.run()).exitCode, 7);
            else appendMandatoryTaskEvent(f.bundle, f.taskId, 'TASK_MODE_ENTERED', 'PASS', 'Later isolated cycle.', {});
            appendMandatoryTaskEvent(f.bundle, f.taskId, 'INTERMEDIATE_COMMAND_RUN', 'PASSED',
                'Adversarial replay fixture; no command execution.', f.event.details);
            assert.throws(() => read(f.root, f.options));
            assert.deepEqual(fs.readFileSync(f.file), f.bytes);
        });
    });

    it('rejects output and timeline mutation during native authentication', async () => {
        const read = compositionReader(), authenticate = authApi.authenticateLocalCommitWorkflowAudit;
        for (const mutation of ['output', 'timeline']) {
            const f = await compositionFixture(); let changed = false;
            const stub = mock.method(authApi, 'authenticateLocalCommitWorkflowAudit', (...args: Parameters<typeof authenticate>) => {
                const result = authenticate(...args);
                if (!changed) { changed = true; fs.appendFileSync(mutation === 'output' ? f.output : f.eventFile, ' '); }
                return result;
            });
            assert.throws(() => read(f.root, f.options)); stub.mock.restore();
        }
    });
});

function childReader(): (root: string, taskId: string) => Record<string, unknown> {
    const read = require(modulePath).readNativeChildSourceAcceptance;
    assert.equal(typeof read, 'function', 'native child source-proof reader must exist');
    return read;
}

async function acceptedChildFixture() {
    const root = createTempRepo();
    roots.push(root);
    proofGit(root, ['init']);
    proofGit(root, ['config', 'user.name', 'Garda Proof Tests']);
    proofGit(root, ['config', 'user.email', 'proof-tests@example.invalid']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'garda-agent-orchestrator/\n');
    proofGit(root, ['add', '.gitignore']);
    proofGit(root, ['commit', '-m', 'proof baseline']);
    const config = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig(), null, 2) + '\n');
    // Isolated publication fixture only: no approval or PASS for this real workspace.
    handleSet({ targetRoot: root, localCommitEnabled: 'true', json: true,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
    fs.writeFileSync(path.join(root, 'accepted.txt'), 'child source\n');
    proofGit(root, ['add', 'accepted.txt']);
    const scope = buildScopeContentFingerprint(root, 'explicit_changed_files', ['accepted.txt']);
    const auditApi = require('../../../../src/gates/task-audit/task-audit-summary');
    const closeoutApi = require('../../../../src/gates/task-audit/task-audit-summary-closeout-sync');
    // Only the audit service is mocked; native commit, signing and publication execute.
    mock.method(auditApi, 'buildTaskAuditSummary', () => ({ task_id: childTaskId,
        status: 'PASS', integrity_status: 'PASS', blockers: [], point_in_time_snapshot: { status: 'STABLE' },
        final_closeout: { implementation_summary: { changed_files: ['accepted.txt'],
            scope_content_sha256: scope, audited_scope_provenance: { use_staged: false, detection_source: 'explicit_changed_files' } } } }));
    mock.method(closeoutApi, 'synchronizeFinalCloseoutArtifacts', (value: unknown) => value);
    assert.equal(await runHumanCommitCommand(['--task-id', childTaskId, '-m', 'test: accepted child'], { cwd: root }), 0);
    mock.restoreAll();
    const eventFile = path.join(root, 'garda-agent-orchestrator/runtime/task-events', childTaskId + '.jsonl');
    const events = fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.event_type, 'TASK_SOURCE_COMMIT_ACCEPTED');
    const file = path.resolve(root, event.details.artifact_path);
    return { root, eventFile, event, file, bytes: fs.readFileSync(file), commit: event.details.commit_sha as string };
}

function rewriteAdversarialFixture(
    fixture: Awaited<ReturnType<typeof acceptedChildFixture>>,
    alter: (proof: Record<string, unknown>) => void, resign = true
) {
    let proof = JSON.parse(fixture.bytes.toString()) as Record<string, unknown>;
    alter(proof);
    if (resign) proof = authApi.authenticateLocalCommitWorkflowAudit(fixture.root, proof, false);
    const bytes = Buffer.from(JSON.stringify(proof, null, 2) + '\n');
    fs.writeFileSync(fixture.file, bytes);
    const event = fixture.event;
    for (const key of ['repo_root', 'tree_sha', 'parent_commit_sha']) event.details[key] = proof[key];
    event.details.artifact_sha256 = digest(bytes);
    event.integrity.event_sha256 = buildEventIntegrityHash(event);
    // Adversarial fixture reconstruction, never a real task timeline modification.
    fs.writeFileSync(fixture.eventFile, JSON.stringify(event) + '\n');
}

type GitSource = { commitSha: string; treeSha: string; parentCommitSha: string | null };
function gitValidator(): (root: string, source: GitSource) => void {
    const validate = require(modulePath).validateNativeChildGitSource;
    assert.equal(typeof validate, 'function', 'bounded native Git source validator must exist');
    return validate;
}
function proofGit(root: string, args: string[], input?: string): string {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, input });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function gitFixture() {
    const f = fixture();
    proofGit(f.root, ['init']);
    proofGit(f.root, ['config', 'user.name', 'Proof Test']);
    proofGit(f.root, ['config', 'user.email', 'proof@example.invalid']);
    proofGit(f.root, ['add', 'proofs/record.json']);
    proofGit(f.root, ['commit', '-m', 'baseline']);
    const parentCommitSha = proofGit(f.root, ['rev-parse', 'HEAD']);
    proofGit(f.root, ['commit', '--allow-empty', '-m', 'accepted source']);
    const source = { commitSha: proofGit(f.root, ['rev-parse', 'HEAD']),
        treeSha: proofGit(f.root, ['rev-parse', 'HEAD^{tree}']), parentCommitSha };
    return { ...f, source };
}

describe('forward-only native child source acceptance', () => {
    it('corroborates a real native publication and later ancestry without changing proof or history', async () => {
        const read = childReader(), f = await acceptedChildFixture();
        const status = proofGit(f.root, ['status', '--porcelain']), timeline = fs.readFileSync(f.eventFile);
        const result = read(f.root, childTaskId);
        assert.equal(result.taskId, childTaskId);
        assert.equal(result.commitSha, f.commit);
        assert.equal(result.treeSha, proofGit(f.root, ['rev-parse', 'HEAD^{tree}']));
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
        assert.deepEqual(fs.readFileSync(f.eventFile), timeline);
        assert.equal(proofGit(f.root, ['status', '--porcelain']), status);
        assert.equal('parentPass' in result, false);
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'later task']);
        assert.equal(read(f.root, childTaskId).commitSha, f.commit);
    });

    it('rejects missing or legacy evidence, wrong task and changed proof bytes', async () => {
        const read = childReader(), f = await acceptedChildFixture();
        assert.throws(() => read(f.root, 'T-MISSING-1'));
        assert.throws(() => read(f.root, '../T-PROOF-2'), /canonical/iu);
        fs.appendFileSync(f.file, ' ');
        assert.throws(() => read(f.root, childTaskId), /binding/iu);
        fs.writeFileSync(f.file, f.bytes);
        fs.renameSync(f.eventFile, f.eventFile + '.preserved');
        assert.throws(() => read(f.root, childTaskId));
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    });

    const invalidProofs: Array<[string, (proof: Record<string, unknown>) => void, RegExp]> = [
        ['wrong task', p => { p.task_id = 'T-FOREIGN-1'; }, /task|identity/iu],
        ['foreign workspace', p => { p.repo_root = path.dirname(String(p.repo_root)); }, /workspace|identity/iu],
        ['wrong Git tree', p => { p.tree_sha = '0'.repeat(40); }, /Git|tree/iu],
        ['wrong Git parent', p => { p.parent_commit_sha = '0'.repeat(40); }, /Git|parent/iu],
        ['corrupt audit digest', p => { p.post_commit_audit_sha256 = '0'.repeat(64); }, /audit/iu],
        ['blocked child audit', p => {
            p.post_commit_audit = { ...(p.post_commit_audit as Record<string, unknown>), status: 'BLOCKED' };
            p.post_commit_audit_sha256 = digest(Buffer.from(JSON.stringify(p.post_commit_audit)));
        }, /audit/iu],
        ['legacy unsigned producer', p => { p.event_source = 'legacy-claimed-acceptance'; }, /native|source/iu]
    ];
    for (const [name, alter, reason] of invalidProofs) it('rejects consistently rebound proof with ' + name, async () => {
        const read = childReader(), f = await acceptedChildFixture();
        rewriteAdversarialFixture(f, alter);
        assert.throws(() => read(f.root, childTaskId), reason);
    });

    it('rejects forged signature and genuinely revoked workspace authority', async () => {
        const read = childReader(), f = await acceptedChildFixture();
        rewriteAdversarialFixture(f, p => { p.accepted_at_utc = '2000-01-01T00:00:00.000Z'; }, false);
        assert.throws(() => read(f.root, childTaskId), /authentication/iu);
        fs.writeFileSync(f.file, f.bytes);
        handleSet({ targetRoot: f.root, localCommitEnabled: 'false', json: true,
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
        assert.throws(() => read(f.root, childTaskId), /authority|authentication/iu);
    });

    it('rejects uncorrelated paths and corrupt or duplicate SOURCE events', async () => {
        const read = childReader(), f = await acceptedChildFixture(), original = fs.readFileSync(f.eventFile);
        f.event.details.artifact_path = f.event.details.artifact_path.replace(childTaskId, 'T-FOREIGN-1');
        f.event.integrity.event_sha256 = buildEventIntegrityHash(f.event);
        fs.writeFileSync(f.eventFile, JSON.stringify(f.event) + '\n');
        assert.throws(() => read(f.root, childTaskId), /path/iu);
        fs.writeFileSync(f.eventFile, original);
        appendMandatoryTaskEvent(path.join(f.root, 'garda-agent-orchestrator'), childTaskId,
            'TASK_SOURCE_COMMIT_ACCEPTED', 'PASS', 'Duplicate isolated SOURCE fixture.', JSON.parse(original.toString()).details);
        assert.throws(() => read(f.root, childTaskId), /timeline|ambiguous/iu);
        fs.writeFileSync(f.eventFile, original.toString().replace('Native source commit', 'Changed source commit'));
        assert.throws(() => read(f.root, childTaskId), /timeline/iu);
    });

    it('rejects unrelated ancestry, grafts and inherited Git selection through the complete reader', async () => {
        const read = childReader(), f = await acceptedChildFixture();
        proofGit(f.root, ['checkout', '--orphan', 'unrelated']);
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'unrelated source']);
        assert.throws(() => read(f.root, childTaskId), /ancestry|Git/iu);
        fs.writeFileSync(path.join(f.root, '.git/info/grafts'), `${proofGit(f.root, ['rev-parse', 'HEAD'])} ${f.commit}\n`);
        assert.throws(() => read(f.root, childTaskId), /graft/iu);
        const script = `const a=require('node:assert/strict'),r=require(process.argv[1]).readNativeChildSourceAcceptance;
            a.throws(()=>r(process.argv[2],process.argv[3]),/environment/iu);`;
        const result = spawnSync(process.execPath, ['-e', script, require.resolve(modulePath), f.root, childTaskId],
            { timeout: 10000, encoding: 'utf8', env: { ...process.env, GIT_DIR: path.join(f.root, '.git') } });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    });

    for (const type of ['commit', 'tree'] as const) it(`rejects replaced raw ${type} through the complete reader`, async () => {
        const read = childReader(), f = await acceptedChildFixture();
        const sha = type === 'commit' ? f.commit : f.event.details.tree_sha;
        const file = path.join(f.root, '.git/objects', sha.slice(0, 2), sha.slice(2));
        const bytes = inflateSync(fs.readFileSync(file));
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        fs.chmodSync(file, 0o600);
        fs.writeFileSync(file, deflateSync(bytes));
        assert.throws(() => read(f.root, childTaskId), /Git|object|identity/iu);
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    });

    it('rejects stale acceptance after genuine native cycle entry', async () => {
        const read = childReader(), f = await acceptedChildFixture();
        appendMandatoryTaskEvent(path.join(f.root, 'garda-agent-orchestrator'), childTaskId,
            'TASK_MODE_ENTERED', 'INFO', 'Isolated subsequent cycle fixture.', {});
        assert.throws(() => read(f.root, childTaskId), /cycle|stale/iu);
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    });

    it('rejects timeline append replacement and truncation during source authentication', async () => {
        const read = childReader(), authenticate = authApi.authenticateLocalCommitWorkflowAudit;
        for (const mutation of ['append', 'replace', 'truncate']) {
            const f = await acceptedChildFixture(), original = fs.readFileSync(f.eventFile);
            let changed = false;
            const stub = mock.method(authApi, 'authenticateLocalCommitWorkflowAudit', (...args: Parameters<typeof authenticate>) => {
                const result = authenticate(...args);
                if (!changed) {
                    changed = true;
                    if (mutation === 'append') appendMandatoryTaskEvent(path.join(f.root, 'garda-agent-orchestrator'),
                        childTaskId, 'TASK_MODE_ENTERED', 'INFO', 'Concurrent isolated child cycle.', {});
                    else if (mutation === 'replace') {
                        fs.renameSync(f.eventFile, f.eventFile + '.original');
                        fs.writeFileSync(f.eventFile, original);
                    } else fs.truncateSync(f.eventFile, 0);
                }
                return result;
            });
            assert.throws(() => read(f.root, childTaskId), /timeline|snapshot|cycle/iu, mutation);
            assert.equal(changed, true);
            assert.deepEqual(fs.readFileSync(f.file), f.bytes);
            stub.mock.restore();
        }
    });

    it('rejects mutation during authentication and HEAD drift rather than returning stale proof', async () => {
        const read = childReader(), f = await acceptedChildFixture();
        const authenticate = authApi.authenticateLocalCommitWorkflowAudit;
        for (const mutate of [() => fs.appendFileSync(f.file, ' '),
            () => proofGit(f.root, ['commit', '--allow-empty', '-m', 'concurrent HEAD'])]) {
            let changed = false;
            const stub = mock.method(authApi, 'authenticateLocalCommitWorkflowAudit', (...args: Parameters<typeof authenticate>) => {
                const result = authenticate(...args);
                if (!changed) { changed = true; mutate(); }
                return result;
            });
            assert.throws(() => read(f.root, childTaskId), /proof|binding|HEAD|identity/iu);
            assert.equal(changed, true);
            stub.mock.restore();
            fs.writeFileSync(f.file, f.bytes);
        }
    });
});

describe('native child Git source provenance', () => {
    it('validates real root, accepted parent/tree and later ancestry with one raw object batch', () => {
        const validate = gitValidator(), f = gitFixture();
        validate(f.root, f.source);
        validate(f.root, { ...f.source, commitSha: f.source.parentCommitSha!, parentCommitSha: null });
        for (let i = 0; i < 4; i++) proofGit(f.root, ['commit', '--allow-empty', '-m', 'later']);
        const api = require('node:child_process'), original = api.execFileSync;
        let batches = 0, commands = 0;
        mock.method(api, 'execFileSync', (...args: unknown[]) => {
            if (args[0] === 'git') {
                commands++;
                if ((args[1] as string[]).includes('--batch')) batches++;
            }
            return Reflect.apply(original, api, args);
        });
        validate(f.root, f.source);
        assert.equal(batches, 1, 'commit and tree content use one batch');
        assert.ok(commands <= 7, `Git process count must stay bounded, observed ${commands}`);
    });

    it('rejects foreign root, wrong tree/parent and a commit outside the current lineage', () => {
        const validate = gitValidator(), f = gitFixture();
        assert.throws(() => validate(path.join(f.root, 'proofs'), f.source), /root/iu);
        assert.throws(() => validate(f.root, { ...f.source, treeSha: '0'.repeat(40) }));
        assert.throws(() => validate(f.root, { ...f.source, parentCommitSha: null }), /parent/iu);
        assert.throws(() => validate(f.root, { ...f.source, commitSha: '--help' }), /identity/iu);
        proofGit(f.root, ['checkout', '--orphan', 'unrelated']);
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'unrelated root']);
        assert.throws(() => validate(f.root, f.source));
    });

    it('rejects inherited Git repository overrides in isolated child environments', () => {
        gitValidator();
        const f = gitFixture();
        for (const [key, value] of [['GIT_DIR', path.join(f.root, '.git')], ['GIT_WORK_TREE', f.root],
            ['GIT_CONFIG_COUNT', '0'], ['GIT_OBJECT_DIRECTORY', path.join(f.root, '.git/objects')]]) {
            const script = `const a=require('node:assert/strict'); const m=require(process.argv[1]);
                a.throws(()=>m.validateNativeChildGitSource(process.argv[2],JSON.parse(process.argv[3])),/environment/iu);`;
            const result = spawnSync(process.execPath, ['-e', script, require.resolve(modulePath), f.root,
                JSON.stringify(f.source)], { encoding: 'utf8', timeout: 10000, env: { ...process.env, [key!]: value } });
            assert.equal(result.status, 0, `${key}: ${result.stderr}`);
        }
    });

    it('rejects a graft that makes an unrelated HEAD appear descended from accepted source', () => {
        const validate = gitValidator(), f = gitFixture();
        proofGit(f.root, ['checkout', '--orphan', 'unrelated']);
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'unrelated root']);
        fs.writeFileSync(path.join(f.root, '.git/info/grafts'),
            `${proofGit(f.root, ['rev-parse', 'HEAD'])} ${f.source.commitSha}\n`);
        assert.throws(() => validate(f.root, f.source), /graft|ancestry|parent/iu);
    });

    for (const type of ['commit', 'tree'] as const) it(`rejects replaced raw ${type} bytes and missing objects`, () => {
        const validate = gitValidator(), f = gitFixture();
        const sha = type === 'commit' ? f.source.commitSha : f.source.treeSha;
        const file = path.join(f.root, '.git/objects', sha.slice(0, 2), sha.slice(2));
        const original = fs.readFileSync(file), bytes = inflateSync(original);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        fs.chmodSync(file, 0o600);
        fs.writeFileSync(file, deflateSync(bytes));
        assert.throws(() => validate(f.root, f.source), /Git|object|identity/iu);
        fs.writeFileSync(file, original);
        fs.renameSync(file, file + '.held');
        assert.throws(() => validate(f.root, f.source));
        fs.renameSync(file + '.held', file);
        validate(f.root, f.source);
    });

    it('rejects incomplete or oversized raw batch frames', () => {
        const validate = gitValidator(), f = gitFixture();
        const api = require('node:child_process'), original = api.execFileSync;
        for (const output of [Buffer.from(`${f.source.commitSha} commit 8388609\n`),
            Buffer.from(`${f.source.commitSha} commit 5\nabc`)]) {
            const stub = mock.method(api, 'execFileSync', (...args: unknown[]) =>
                (args[1] as string[]).includes('--batch') ? output : Reflect.apply(original, api, args));
            assert.throws(() => validate(f.root, f.source), /bounded|object|frame/iu);
            stub.mock.restore();
        }
    });

    it('rejects an incomplete ancestry projection despite a successful ancestor probe', () => {
        const validate = gitValidator(), f = gitFixture();
        proofGit(f.root, ['commit', '--allow-empty', '-m', 'later']);
        const api = require('node:child_process'), original = api.execFileSync;
        mock.method(api, 'execFileSync', (...args: unknown[]) =>
            (args[1] as string[]).includes('rev-list') ? '' : Reflect.apply(original, api, args));
        assert.throws(() => validate(f.root, f.source), /ancestry/iu);
    });

    it('rejects a late parent header that native Git does not treat as ancestry', () => {
        const validate = gitValidator(), f = gitFixture();
        const bytes = `tree ${f.source.treeSha}\nauthor Proof <proof@example.invalid> 1 +0000\n`
            + `committer Proof <proof@example.invalid> 1 +0000\nparent ${f.source.commitSha}\n\nlate parent\n`;
        const commitSha = proofGit(f.root, ['hash-object', '--literally', '-w', '-t', 'commit', '--stdin'], bytes);
        proofGit(f.root, ['update-ref', 'HEAD', commitSha]);
        assert.equal(proofGit(f.root, ['rev-list', '--parents', '-1', 'HEAD']), commitSha,
            'native Git must actually see a root rather than the late parent claim');
        assert.throws(() => validate(f.root, { ...f.source, commitSha, parentCommitSha: f.source.commitSha }), /parent|header/iu);
    });
});

function reader(): (repoRoot: string, artifactPath: string, expectedSha256: string) => Record<string, unknown> {
    let loaded: Record<string, unknown> = {};
    try { loaded = require(modulePath); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
    assert.equal(typeof loaded.readParentAuditProofRecord, 'function',
        'contained parent proof reader must exist before proof can be reconstructed');
    return loaded.readParentAuditProofRecord as ReturnType<typeof reader>;
}

function fixture(content = JSON.stringify({ task_id: 'T-PROOF-1', answer: 'Пример' })) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-parent-proof-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'proofs'));
    const file = path.join(root, 'proofs', 'record.json');
    const bytes = Buffer.from(content);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { root, file, bytes, sha256: digest(bytes) };
}

afterEach(() => {
    mock.restoreAll();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('contained parent-audit proof inputs', () => {
    it('reads the exact ordinary UTF-8 record without granting acceptance or changing its bytes', () => {
        const f = fixture();
        const result = reader()(f.root, f.file, f.sha256);
        assert.deepEqual(result, { task_id: 'T-PROOF-1', answer: 'Пример' });
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
        assert.equal('status' in result, false);
        assert.equal('local_commit_authentication' in result, false);
    });

    it('blocks missing proof, bad hash syntax and stale or forged bytes', () => {
        const f = fixture();
        const read = reader();
        assert.throws(() => read(f.root, f.file + '.missing', f.sha256));
        for (const hash of ['', 'public assertion', 'a'.repeat(63)]) {
            assert.throws(() => read(f.root, f.file, hash));
        }
        fs.writeFileSync(f.file, JSON.stringify({ task_id: 'T-FOREIGN' }));
        assert.throws(() => read(f.root, f.file, f.sha256));
    });

    it('blocks invalid JSON and non-record proof values even with their exact digest', () => {
        const read = reader();
        const malformed = fixture('{');
        assert.throws(() => read(malformed.root, malformed.file, malformed.sha256));
        for (const value of ['', 'null', '[]', '"claimed PASS"']) {
            const f = fixture(value);
            assert.throws(() => read(f.root, f.file, f.sha256));
        }
    });

    it('rejects an input above the fixed eight-MiB budget', () => {
        const read = reader(), f = fixture();
        const bytes = Buffer.from(JSON.stringify({ payload: 'a'.repeat(8 * 1024 * 1024) }));
        assert.equal(JSON.parse(bytes.toString('utf8')).payload.length, 8 * 1024 * 1024);
        fs.writeFileSync(f.file, bytes);
        assert.throws(() => read(f.root, f.file, digest(bytes)), /bounded ordinary file/u);
    });

    it('rejects malformed UTF-8 even when its raw byte digest matches', () => {
        const read = reader(), f = fixture();
        const bytes = Buffer.concat([Buffer.from('{"answer":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
        fs.writeFileSync(f.file, bytes);
        assert.throws(() => read(f.root, f.file, digest(bytes)));
    });

    it('rejects foreign traversal, outside-root inputs, symlink parents and linked files', () => {
        const read = reader(), f = fixture(), other = fixture();
        assert.throws(() => read(f.root, other.file, other.sha256));
        assert.throws(() => read(f.root, path.relative(f.root, other.file), other.sha256));
        const linked = path.join(f.root, 'proofs', 'linked.json');
        fs.linkSync(other.file, linked);
        assert.throws(() => read(f.root, linked, other.sha256));
        if (process.platform !== 'win32') {
            const parent = path.join(f.root, 'foreign');
            fs.symlinkSync(path.dirname(other.file), parent, 'dir');
            assert.throws(() => read(f.root, path.join(parent, 'record.json'), other.sha256));
        }
    });

    it('rejects stale identity from a same-byte ordinary replacement between binding and descriptor acquisition', () => {
        const read = reader(), f = fixture(), open = fs.openSync;
        let replaced = false;
        mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
            if (!replaced && String(args[0]) === f.file) {
                replaced = true;
                const next = f.file + '.replacement';
                fs.writeFileSync(next, f.bytes, { flag: 'wx' });
                fs.renameSync(next, f.file);
            }
            return open(...args);
        });
        assert.throws(() => read(f.root, f.file, f.sha256));
        assert.equal(replaced, true);
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    });

    it('rejects growth during the descriptor read and closes the proof descriptor', () => {
        const read = reader(), f = fixture();
        const open = fs.openSync, originalRead = fs.readSync, close = fs.closeSync;
        let descriptor = -1, grew = false, closed = false;
        mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
            const fd = open(...args);
            if (String(args[0]) === f.file && descriptor === -1) descriptor = fd;
            return fd;
        });
        mock.method(fs, 'readSync', (...args: unknown[]) => {
            const count = Reflect.apply(originalRead, fs, args) as number;
            if (args[0] === descriptor && !grew) {
                grew = true;
                fs.appendFileSync(f.file, ' ');
            }
            return count;
        });
        mock.method(fs, 'closeSync', (fd: number) => {
            if (fd === descriptor) closed = true;
            return close(fd);
        });
        assert.throws(() => read(f.root, f.file, f.sha256));
        assert.equal(grew, true);
        assert.equal(closed, true);
    });

    it('rejects final-file FIFO replacement without waiting for a writer', { skip: process.platform === 'win32' }, () => {
        reader();
        const f = fixture();
        const script = String.raw`
            const fs = require('node:fs'), assert = require('node:assert/strict');
            const { spawnSync } = require('node:child_process');
            const reader = require(process.argv[1]).readParentAuditProofRecord;
            const [root, file, hash] = process.argv.slice(2);
            const open = fs.openSync; let replaced = false;
            fs.openSync = (...args) => {
                if (!replaced && String(args[0]) === file) {
                    replaced = true; fs.renameSync(file, file + '.original');
                    const result = spawnSync('mkfifo', [file], { timeout: 1000 });
                    assert.equal(result.status, 0, 'isolated FIFO fixture must be created');
                }
                return open(...args);
            };
            assert.throws(() => reader(root, file, hash));
            assert.equal(replaced, true, 'the final file must actually be replaced before open');
            assert.equal(fs.lstatSync(file).isFIFO(), true);
            console.log('FIFO_REPLACEMENT_REJECTED');
        `;
        const result = spawnSync(process.execPath,
            ['-e', script, require.resolve(modulePath), f.root, f.file, f.sha256],
            { timeout: 3000, encoding: 'utf8' });
        assert.equal(result.error, undefined, 'proof acquisition must not hang on a writerless FIFO');
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /FIFO_REPLACEMENT_REJECTED/u);
        assert.deepEqual(fs.readFileSync(f.file + '.original'), f.bytes);
    });
});
