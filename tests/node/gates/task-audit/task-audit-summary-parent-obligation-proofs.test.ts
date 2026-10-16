import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { deriveDecomposedParentAuditRequirements } from '../../../../src/gates/task-audit/task-audit-summary-decomposed-parent';

const parentApi = require('../../../../src/gates/task-audit/task-audit-summary-lifecycle');
const commandApi = require('../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs');
const memoryApi = require('../../../../src/gates/project-memory-impact/project-memory-impact');
const wipApi = require('../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts');
const wipFilesApi = require('../../../../src/gates/split-required/split-required-wip-restore-plan');
const gitApi = require('../../../../src/core/git-helpers');
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
});
