import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { deriveDecomposedParentAuditRequirements } from '../../../../src/gates/task-audit/task-audit-summary-decomposed-parent';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';

const parentApi = require('../../../../src/gates/task-audit/task-audit-summary-lifecycle');
const commandApi = require('../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs');
const memoryApi = require('../../../../src/gates/project-memory-impact/project-memory-impact');
const nativeMemoryReader = memoryApi.getProjectMemoryImpactLifecycleEvidence;
const wipApi = require('../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts');
const wipFilesApi = require('../../../../src/gates/split-required/split-required-wip-restore-plan');
const gitApi = require('../../../../src/core/git-helpers');
const taskModeApi = require('../../../../src/gates/task-mode/task-mode-evidence');
const task = 'T-PARENT-OBLIGATION-1', command = 'node --test original.test.js', hash = 'a'.repeat(64);
type CommandIdentity = { command: string; coverage: string | null };

function reader(): (root: string, id: string) => any {
    let api: any;
    try { api = require('../../../../src/gates/task-audit/task-audit-summary-parent-obligation-proofs'); }
    catch (error) { assert.fail('Native parent obligation proof reader must exist: ' + String(error)); }
    assert.equal(typeof api.readNativeParentObligationProofs, 'function');
    return api.readNativeParentObligationProofs;
}

describe('native original parent obligation qualification', () => {
    let root: string, bundle: string, reviews: string, timeline: string, memoryFile: string, manifestFile: string;
    let facts: any, memory: any, manifest: any, calls: string[];
    let signedCommands: CommandIdentity[], requests: CommandIdentity[];
    const add = (type: string, details: object = {}, outcome: 'INFO' | 'PASS' | 'PASSED' | 'FAIL' | 'BLOCKED' = 'INFO') =>
        appendMandatoryTaskEvent(bundle, task, type, outcome, 'Isolated original-parent proof fixture.', details, { actor: 'orchestrator' });
    const entries = () => fs.readFileSync(timeline, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
    const reference = (type: string) => {
        const event = entries().find(e => e.event_type === type);
        return { taskId: task, sequence: event.integrity.task_sequence, sha256: event.integrity.event_sha256 };
    };
    const originalCommands = (identities: CommandIdentity[]) => {
        const events = entries(); fs.unlinkSync(timeline);
        for (const identity of identities) add('FULL_SUITE_VALIDATION_FAILED', {
            command: identity.command, ...(identity.coverage === null ? {} : { coverage_contract_sha256: identity.coverage })
        }, 'FAIL');
        for (const event of events.filter(e => e.event_type !== 'FULL_SUITE_VALIDATION_FAILED')) add(event.event_type, event.details, event.outcome);
        for (const name of new Set(identities.map(identity => identity.command))) {
            if (name !== command) add('INTERMEDIATE_COMMAND_RUN', { command: name, artifact_path: path.join(reviews, 'second-command.json'), artifact_sha256: hash }, 'PASSED');
        }
        facts.facts.decomposition = reference('STRICT_DECOMPOSITION_DECISION_RECORDED');
        facts.facts.completion = reference('DECOMPOSED_PARENT_COMPLETED');
    };
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-parent-obligations-'));
        bundle = path.join(root, 'garda-agent-orchestrator'); reviews = path.join(bundle, 'runtime/reviews');
        fs.mkdirSync(reviews, { recursive: true });
        timeline = path.join(bundle, 'runtime/task-events', task + '.jsonl');
        fs.writeFileSync(path.join(root, 'TASK.md'), 'Original queue bytes\n');
        fs.writeFileSync(path.join(reviews, task + '-strict-decomposition-decision.json'), '{}');
        fs.writeFileSync(path.join(reviews, task + '-preflight.json'), '{}');
        memoryFile = path.join(bundle, 'runtime/project-memory', task + '-impact.json');
        fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
        memory = { task_id: task, outcome: 'PASS', preflight_hash_sha256: hash, impact_fingerprint_sha256: hash };
        fs.writeFileSync(memoryFile, JSON.stringify(memory));
        manifestFile = path.join(bundle, 'runtime/wip', task, 'split-required/capture/manifest.json');
        manifest = { schema_version: 1, kind: 'split_required_wip', status: 'suspended', task_id: task,
            tracked_files: [], untracked_files: [], patches: { staged: {}, unstaged: {} } };
        add('FULL_SUITE_VALIDATION_FAILED', { command, coverage_contract_sha256: hash }, 'FAIL');
        add('SPLIT_REQUIRED_WIP_CAPTURED', { manifest_path: manifestFile, manifest_sha256: hash }, 'BLOCKED');
        add('STRICT_DECOMPOSITION_DECISION_RECORDED');
        add('DECOMPOSED_PARENT_COMPLETED');
        add('INTERMEDIATE_COMMAND_RUN', { command, artifact_path: path.join(reviews, 'command.json'), artifact_sha256: hash }, 'PASSED');
        add('PROJECT_MEMORY_IMPACT_ASSESSED', memory, 'PASS');
        const input = { taskId: task, taskStatus: 'DONE', childTaskIds: [task + '-1'], completedChildTaskIds: [task + '-1'],
            childGraphComplete: true, decomposition: reference('STRICT_DECOMPOSITION_DECISION_RECORDED'),
            completion: reference('DECOMPOSED_PARENT_COMPLETED'), historicalFailures: ['full-suite-validation'],
            fullSuiteRequired: true, projectMemoryRequired: true };
        facts = { facts: input, requirements: deriveDecomposedParentAuditRequirements(input), childSources: [{ taskId: task + '-1' }] };
        calls = [];
        signedCommands = [{ command, coverage: hash }]; requests = [];
        // Existing suites own signed Git, graph, WIP and memory authenticity; these mocks isolate their new composition.
        mock.method(parentApi, 'readNativeDecomposedParentFacts', () => { calls.push('facts'); return facts; });
        mock.method(commandApi, 'readNativeSourceCompositionProof', (_root: string, request: any) => {
            calls.push('command'); assert.equal(request.taskId, task);
            const identity = { command: request.command, coverage: request.coverageContractSha256 }; requests.push(identity);
            if (!signedCommands.some(signed => signed.command === identity.command && signed.coverage === identity.coverage)) {
                throw Error('Original command coverage differs from the signed native proof.');
            }
            return { taskId: task, command: request.command, processStatus: 'PASSED' };
        });
        mock.method(memoryApi, 'getProjectMemoryImpactLifecycleEvidence', () => ({ required: true, evidence_status: 'CURRENT', artifact_path: memoryFile }));
        mock.method(wipApi, 'readAuthenticatedSplitRequiredWipManifestSnapshot', () => ({ manifest, sha256: hash }));
        mock.method(wipFilesApi, 'validateManifestFileReferences', () => []);
        mock.method(wipFilesApi, 'validateAdvancedManifestBlobs', () => []);
        mock.method(gitApi, 'runGit', () => ['b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)].join('\n'));
    });
    afterEach(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

    it('qualifies all original obligations without granting parent audit acceptance', () => {
        const before = fs.readFileSync(timeline), result = reader()(root, task);
        assert.equal(result.status, 'QUALIFIED'); assert.deepEqual(result.violations, []);
        assert.deepEqual(calls, ['facts', 'command']);
        assert.deepEqual([...result.qualifiedProofs].sort(), [...facts.requirements.requiredProofs].sort());
        assert.equal('parentPass' in result, false); assert.deepEqual(fs.readFileSync(timeline), before);
    });
    it('qualifies the normalized native memory artifact path without changing evidence', () => {
        const normalized = memoryFile.replace(/\\/gu, '/');
        mock.method(memoryApi, 'getProjectMemoryImpactLifecycleEvidence', () => ({
            required: true, evidence_status: 'CURRENT', artifact_path: normalized
        }));
        const before = fs.readFileSync(timeline), bytes = fs.readFileSync(memoryFile);
        const result = reader()(root, task);
        assert.equal(result.status, 'QUALIFIED'); assert.deepEqual(result.violations, []);
        assert.deepEqual(fs.readFileSync(timeline), before);
        assert.deepEqual(fs.readFileSync(memoryFile), bytes);
    });
    it('preserves missing and rejected original proof boundaries', () => {
        const read = reader();
        mock.method(memoryApi, 'getProjectMemoryImpactLifecycleEvidence', () => ({ evidence_status: 'MISSING' }));
        assert.match(read(root, task).violations.join(' '), /memory/iu);
        mock.method(memoryApi, 'getProjectMemoryImpactLifecycleEvidence', () => ({ evidence_status: 'CURRENT', artifact_path: memoryFile }));
        mock.method(commandApi, 'readNativeSourceCompositionProof', () => { throw Error('Foreign or stale native command proof.'); });
        assert.match(read(root, task).violations.join(' '), /Foreign or stale/u);
        mock.method(wipApi, 'readAuthenticatedSplitRequiredWipManifestSnapshot', () => { throw Error('Corrupt retained WIP.'); });
        assert.match(read(root, task).violations.join(' '), /Corrupt retained WIP/u);
    });
    it('does not qualify absent original inputs or clear unrelated historical failures', () => {
        const read = reader();
        facts.facts.historicalFailures.push('required-reviews-check');
        facts.requirements = deriveDecomposedParentAuditRequirements(facts.facts);
        assert.match(read(root, task).violations.join(' '), /required-reviews-check/u);
        fs.unlinkSync(path.join(reviews, task + '-preflight.json'));
        assert.match(read(root, task).violations.join(' '), /preflight/iu);
    });
    it('requires original command coverage and a successful post-completion command', () => {
        const read = reader();
        const second = { command: 'node --test second.test.js', coverage: 'b'.repeat(64) };
        signedCommands.push(second);
        originalCommands([{ command, coverage: hash }, second, { command, coverage: hash }]);
        assert.equal(read(root, task).status, 'QUALIFIED');
        assert.deepEqual(requests, [{ command, coverage: hash }, second]);
        signedCommands.pop(); requests = [];
        const uncovered = read(root, task);
        assert.equal(uncovered.status, 'BLOCKED'); assert.match(uncovered.violations.join(' '), /coverage/u);
        assert.deepEqual(requests, [{ command, coverage: hash }, second]);
        add('INTERMEDIATE_COMMAND_RUN', { command, artifact_path: 'missing.json', artifact_sha256: hash }, 'FAIL');
        const failed = read(root, task);
        assert.equal(failed.status, 'BLOCKED'); assert.match(failed.violations.join(' '), /command/iu);
        const events = entries(); fs.unlinkSync(timeline);
        for (const e of events.filter(e => e.event_type !== 'FULL_SUITE_VALIDATION_FAILED')) add(e.event_type, e.details, e.outcome);
        facts.facts.decomposition = reference('STRICT_DECOMPOSITION_DECISION_RECORDED');
        facts.facts.completion = reference('DECOMPOSED_PARENT_COMPLETED');
        assert.match(read(root, task).violations.join(' '), /original.*command/iu);
    });
    it('preserves nullable coverage and rejects missing or mismatched original proof identities', () => {
        const read = reader();
        for (const signedCoverage of [null, 'b'.repeat(64)]) {
            signedCommands = [{ command, coverage: signedCoverage }]; requests = [];
            const result = read(root, task);
            assert.equal(result.status, 'BLOCKED'); assert.match(result.violations.join(' '), /coverage/u);
            assert.deepEqual(requests, [{ command, coverage: hash }]);
        }
        originalCommands([{ command, coverage: null }]); requests = [];
        assert.equal(read(root, task).status, 'BLOCKED');
        assert.deepEqual(requests, [{ command, coverage: null }]);
        signedCommands = [{ command, coverage: null }];
        assert.equal(read(root, task).status, 'QUALIFIED');
        originalCommands([{ command, coverage: null }, { command, coverage: hash }]); requests = [];
        const distinctCoverage = read(root, task);
        assert.equal(distinctCoverage.status, 'BLOCKED'); assert.match(distinctCoverage.violations.join(' '), /coverage/u);
        assert.deepEqual(requests, [{ command, coverage: null }, { command, coverage: hash }]);
    });
    it('rejects changed memory, WIP identity, input bytes and corrupt timelines', () => {
        const read = reader();
        fs.writeFileSync(memoryFile, JSON.stringify({ ...memory, task_id: 'T-FOREIGN' }));
        assert.match(read(root, task).violations.join(' '), /memory/iu);
        manifest.task_id = 'T-FOREIGN'; assert.match(read(root, task).violations.join(' '), /WIP/u);
        mock.method(memoryApi, 'getProjectMemoryImpactLifecycleEvidence', () => {
            fs.writeFileSync(path.join(root, 'TASK.md'), 'Changed queue');
            return { evidence_status: 'CURRENT', artifact_path: memoryFile };
        });
        assert.match(read(root, task).violations.join(' '), /changed/iu);
        fs.writeFileSync(timeline, fs.readFileSync(timeline, 'utf8').replace(command, 'changed-command'));
        assert.match(read(root, task).violations.join(' '), /timeline/iu);
    });
    it('retains ordinary leaf applicability and rejects an incomplete native graph', () => {
        const read = reader(); facts = null; assert.equal(read(root, task), null);
        facts = { facts: {}, childSources: [], requirements: { status: 'BLOCKED', violations: ['Missing child source.'], requiredProofs: [] } };
        assert.deepEqual(read(root, task).violations, ['Missing child source.']);
        assert.equal(calls.includes('command'), false);
    });

    const cleanOriginal = () => {
        const prior = entries(); fs.unlinkSync(timeline);
        add('TASK_MODE_ENTERED', { dirty_workspace_baseline_count: 0, profile_policy_snapshot_hash: hash }, 'PASS');
        add('PREFLIGHT_CLASSIFIED', { changed_files_count: 0, changed_lines_total: 0,
            zero_diff_guard: { zero_diff_detected: true, status: 'BASELINE_ONLY' } });
        for (const event of prior.filter(event => !['FULL_SUITE_VALIDATION_FAILED', 'SPLIT_REQUIRED_WIP_CAPTURED'].includes(event.event_type))) {
            add(event.event_type, event.details, event.outcome);
        }
        facts.facts.historicalFailures = [];
        facts.facts.decomposition = reference('STRICT_DECOMPOSITION_DECISION_RECORDED');
        facts.facts.completion = reference('DECOMPOSED_PARENT_COMPLETED');
        facts.requirements = deriveDecomposedParentAuditRequirements(facts.facts);
        const configPath = path.join(bundle, 'live/config/workflow-config.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ full_suite_validation: { enabled: true, command } }));
        const frozenHash = createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
        // The existing task-mode reader owns snapshot validation; these tests exercise its qualified result consumer.
        const mode = { evidence_status: 'PASS', evidence_task_id: task,
            timeline_profile_policy_snapshot_hash: hash, profile_policy_snapshot_status: 'PASS',
            profile_policy_snapshot: { snapshot_hash: hash, config_hashes: { workflow_config: frozenHash } } };
        mock.method(taskModeApi, 'getTaskModeEvidence', () => mode);
        signedCommands = [{ command, coverage: null }];
        return { configPath, mode };
    };

    it('qualifies a native clean split before implementation without inventing capture or execution history', () => {
        cleanOriginal(); const before = fs.readFileSync(timeline);
        const result = reader()(root, task);
        assert.equal(result.status, 'QUALIFIED'); assert.deepEqual(result.violations, []);
        assert.deepEqual(requests, [{ command, coverage: null }]);
        assert.deepEqual(fs.readFileSync(timeline), before);
        assert.equal(entries().some(event => ['SPLIT_REQUIRED_WIP_CAPTURED', 'FULL_SUITE_VALIDATION_PASSED'].includes(event.event_type)), false);
        add('INTERMEDIATE_COMMAND_RUN', { command, artifact_path: 'failed.json', artifact_sha256: hash }, 'FAIL');
        assert.equal(reader()(root, task).status, 'BLOCKED');
    });

    it('keeps missing WIP blocked for an original dirty entry or started implementation', () => {
        cleanOriginal(); const nativeEvents = entries();
        for (const mutation of ['dirty-entry', 'implementation-started']) {
            fs.unlinkSync(timeline);
            for (const event of nativeEvents) {
                const details = mutation === 'dirty-entry' && event.event_type === 'TASK_MODE_ENTERED'
                    ? { ...event.details, dirty_workspace_baseline_count: 1 } : event.details;
                if (mutation === 'implementation-started' && event.event_type === 'STRICT_DECOMPOSITION_DECISION_RECORDED') {
                    add('IMPLEMENTATION_STARTED', {}, 'PASS');
                }
                add(event.event_type, details, event.outcome);
            }
            facts.facts.decomposition = reference('STRICT_DECOMPOSITION_DECISION_RECORDED');
            facts.facts.completion = reference('DECOMPOSED_PARENT_COMPLETED');
            const result = reader()(root, task);
            assert.equal(result.status, 'BLOCKED'); assert.match(result.violations.join(' '), /WIP|clean|original/iu);
        }
    });

    it('requires the original frozen declaration and separate current command coverage proof', () => {
        const { configPath, mode } = cleanOriginal(); const read = reader();
        const original = fs.readFileSync(configPath);
        fs.writeFileSync(configPath, JSON.stringify({ full_suite_validation: { enabled: true, command: 'changed-command' } }));
        assert.equal(read(root, task).status, 'BLOCKED'); assert.deepEqual(requests, []);
        fs.writeFileSync(configPath, original);
        mode.timeline_profile_policy_snapshot_hash = 'b'.repeat(64);
        assert.equal(read(root, task).status, 'BLOCKED'); assert.deepEqual(requests, []);
        mode.timeline_profile_policy_snapshot_hash = hash;
        signedCommands = [{ command, coverage: hash }];
        assert.equal(read(root, task).status, 'BLOCKED');
        assert.deepEqual(requests, [{ command, coverage: null }]);
        signedCommands = [{ command, coverage: null }];
        assert.equal(read(root, task).status, 'QUALIFIED');
    });

    const preflightlessOriginal = () => {
        const context = cleanOriginal(), original = entries(); fs.unlinkSync(timeline);
        fs.unlinkSync(path.join(reviews, task + '-preflight.json'));
        const smokeFile = path.join(reviews, task + '-shell-smoke.json');
        const smoke = { schema_version: 1, event_source: 'shell-smoke-preflight', task_id: task,
            status: 'PASSED', outcome: 'PASS', git_change_classification: {
                effective_dirty: false, effective_changed_files: [], staged_files: [], unstaged_files: [], untracked_files: []
            } };
        fs.writeFileSync(smokeFile, JSON.stringify(smoke));
        const smokeHash = createHash('sha256').update(fs.readFileSync(smokeFile)).digest('hex');
        memory = { ...memory, preflight_hash_sha256: null, changed_files_source: 'explicit', changed_files: [] };
        fs.writeFileSync(memoryFile, JSON.stringify(memory));
        for (const event of original.filter(event => event.event_type !== 'PREFLIGHT_CLASSIFIED')) {
            add(event.event_type, event.event_type === 'PROJECT_MEMORY_IMPACT_ASSESSED' ? memory : event.details, event.outcome);
            if (event.event_type === 'TASK_MODE_ENTERED') {
                add('HANDSHAKE_DIAGNOSTICS_RECORDED', {}, 'PASS');
                add('SHELL_SMOKE_PREFLIGHT_RECORDED', { artifact_hash: smokeHash, passed: true }, 'PASS');
            }
        }
        facts.facts.decomposition = reference('STRICT_DECOMPOSITION_DECISION_RECORDED');
        facts.facts.completion = reference('DECOMPOSED_PARENT_COMPLETED');
        return { ...context, smokeFile, smoke };
    };

    it('qualifies the native clean split before preflight with separate explicit memory and command proofs', () => {
        preflightlessOriginal();
        mock.method(memoryApi, 'getProjectMemoryImpactLifecycleEvidence', (input: any) => {
            assert.deepEqual(input.changedFiles, []);
            return { required: true, evidence_status: 'CURRENT', artifact_path: memoryFile };
        });
        const before = fs.readFileSync(timeline), result = reader()(root, task);
        assert.equal(result.status, 'QUALIFIED'); assert.deepEqual(result.violations, []);
        assert.deepEqual(requests, [{ command, coverage: null }]);
        assert.deepEqual(fs.readFileSync(timeline), before);
        assert.equal(fs.existsSync(path.join(reviews, task + '-preflight.json')), false);
    });

    it('keeps a preflightless original blocked for missing, changed, dirty or stale smoke evidence', () => {
        const { smokeFile, smoke } = preflightlessOriginal(), original = entries();
        const read = reader(), bytes = fs.readFileSync(smokeFile);
        fs.unlinkSync(smokeFile); assert.equal(read(root, task).status, 'BLOCKED');
        fs.writeFileSync(smokeFile, JSON.stringify({ ...smoke, git_change_classification: { effective_dirty: true } }));
        assert.equal(read(root, task).status, 'BLOCKED');
        const dirtyHash = createHash('sha256').update(fs.readFileSync(smokeFile)).digest('hex');
        fs.unlinkSync(timeline);
        for (const event of original) add(event.event_type, event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            ? { ...event.details, artifact_hash: dirtyHash } : event.details, event.outcome);
        facts.facts.decomposition = reference('STRICT_DECOMPOSITION_DECISION_RECORDED');
        facts.facts.completion = reference('DECOMPOSED_PARENT_COMPLETED');
        assert.equal(read(root, task).status, 'BLOCKED');
        fs.writeFileSync(smokeFile, bytes);
        fs.unlinkSync(timeline);
        for (const event of original) {
            if (event.event_type === 'STRICT_DECOMPOSITION_DECISION_RECORDED') add('HANDSHAKE_DIAGNOSTICS_RECORDED', {}, 'PASS');
            add(event.event_type, event.details, event.outcome);
        }
        facts.facts.decomposition = reference('STRICT_DECOMPOSITION_DECISION_RECORDED');
        facts.facts.completion = reference('DECOMPOSED_PARENT_COMPLETED');
        assert.equal(read(root, task).status, 'BLOCKED');
    });

    it('validates an explicit empty scope through the real memory owner without treating missing preflight as empty', () => {
        const memoryRoot = path.join(bundle, 'live/docs/project-memory'); fs.mkdirSync(memoryRoot, { recursive: true });
        for (const name of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
            fs.writeFileSync(path.join(memoryRoot, name), `# ${name}\n\nDurable project contract for ${name}.\n`);
        }
        const config = buildDefaultWorkflowConfig();
        config.project_memory_maintenance.enabled = true;
        config.project_memory_maintenance.mode = 'check';
        config.project_memory_maintenance.run_before_final_closeout = true;
        fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'live/config/workflow-config.json'), JSON.stringify(config));
        const preflightPath = path.join(reviews, 'absent-original-preflight.json');
        const assessed = memoryApi.assessProjectMemoryImpact({ repoRoot: root, taskId: task, preflightPath, changedFiles: [] });
        assert.equal(assessed.artifact.status, 'NO_UPDATE_NEEDED');
        fs.writeFileSync(assessed.artifactPath, JSON.stringify(assessed.artifact));
        assert.equal(nativeMemoryReader({ repoRoot: root, taskId: task, preflightPath, changedFiles: [] }).evidence_status, 'CURRENT');
        assert.notEqual(nativeMemoryReader({ repoRoot: root, taskId: task, preflightPath }).evidence_status, 'CURRENT');
    });
});
